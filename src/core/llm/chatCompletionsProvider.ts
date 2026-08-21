import {
  CHAT_STYLE_LADDER,
  CHAT_THINKING_STYLE_LABEL,
  ChatThinkingStyle,
  THINKING_LABEL,
  ThinkingDepth,
  chatEffort,
  downgradeDepth,
  outputRoomTooSmall,
  thinkingBudget,
} from '../model/thinking';
import { scoped } from '../runtime/logger';
import { describeHttpBody, hostOf, parseToolArgs, readBody } from './http';
import {
  AgentMessage,
  LlmError,
  LlmProvider,
  StopSignal,
  StreamEvent,
  StreamOptions,
  ToolCall,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

const log = scoped('模型');

/**
 * 通用 **OpenAI 兼容** `/chat/completions` 流式实现。
 *
 * 生态里说「OpenAI 兼容接口」指的就是这一条：DeepSeek、智谱、Kimi、通义、
 * 本地 Ollama、OpenRouter、各种自建网关几乎只认它。Responses（`/responses`）
 * 那条是另一个 kind（[responsesProvider.ts](responsesProvider.ts)）。
 *
 * ## 思考深度：没有标准，所以要么问、要么猜
 *
 * 另两条协议里「想多深」是一个固定字段。这条协议上它是**四个**：
 *
 * | 风格 | 字段 | 谁认 |
 * |---|---|---|
 * | `effort` | `reasoning_effort` | OpenAI / Kimi / Ollama / DeepSeek |
 * | `thinking` | `thinking:{type:'enabled'}` + `reasoning_effort` | 智谱 GLM / DeepSeek |
 * | `enable` | `enable_thinking` + `thinking_budget` | 通义 Qwen / vLLM 自建 |
 * | `reasoning` | `reasoning:{effort}` | OpenRouter |
 *
 * 作者的设置页里只有一个接口地址，指望他知道自己那个网关转发给谁、认哪一套
 * 是不合理的。所以缺省 `auto`：**问出来**——按上表顺序发，被 400 就换下一种，
 * 结论按「接口地址 + 模型」记在内存里（见 QUIRKS）。代价是每个模型一生最多
 * 吃四次 400，换来的是作者什么都不用答。
 *
 * 同时留一个手动档（服务商配置里的「思考字段」下拉）：自动协商靠 400 的错误
 * 文本认字段，而中转网关的报错措辞什么样都有可能。猜错时得有个地方能钉死。
 *
 * ## 三件与另两条协议不同、不做就会静默出错的事
 *
 * - **不发 `reasoningTrace`**。同一个 kind 底下各家要求正好相反：DeepSeek 把
 *   上一轮的 `reasoning_content` 交回去是**直接 400**，Kimi 的文档却要求在一次
 *   工具循环里交回去。400 比「白丢一次推理缓存」严重得多，所以一律不交。
 * - **`stop` 必须排在所有 `toolCall` 之后**（见 provider.ts 的 StopSignal）。但
 *   这条协议的工具调用是**分片攒到流结束**才拼得完的，而 `finish_reason` 往往
 *   在那之前就到了——所以收尾原因要先扣着，冲完工具调用再发。
 * - **「不思考」不等于真关掉**。这一档不带任何思考字段（见 thinking.ts 的
 *   理由），而智谱 / DeepSeek / Ollama 上的推理模型缺省就在思考。那一档的准确
 *   含义是「跟随服务商默认」，界面上的说明也是这么写的。
 */
export class ChatCompletionsProvider implements LlmProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    /** 作者钉死的思考字段风格。缺省 `auto` = 自动协商。 */
    private readonly style: ChatThinkingStyle = 'auto'
  ) {}

  get label(): string {
    return `${this.model} @ ${hostOf(this.baseUrl)}`;
  }

  async maxInputTokens(): Promise<number | undefined> {
    return undefined; // 以用户设置的 contextWindow 为准
  }

  async *stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const { signal, dispose, poke } = makeAbortSignal(options);
    try {
      const msgs = toChatMessages(messages);
      const quirk = quirksOf(this.baseUrl, this.model, this.style);
      let stream: ReadableStream<Uint8Array> | undefined;

      // 上游拒了某个字段就换一种写法再发（见 negotiate）——**不是重试同一个
      // 请求**：每一次的请求体都与上一次不同。梯子最长五档（四种写法 + 不带），
      // 外加 stream_options 与 temperature 各一次，所以上限给到七次。
      for (let attempt = 0; ; attempt += 1) {
        const sent = buildBody(this.model, msgs, options, quirk);
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(sent),
          signal,
        });
        if (response.ok && response.body) {
          stream = response.body;
          break;
        }
        // 响应体只读一次：字段协商要看它，报错也要看它。
        const detail = await readBody(response);
        if (attempt < 6 && negotiate(response.status, detail, sent, quirk, this.label)) {
          continue;
        }
        throw new LlmError(
          describeHttpBody(response.status, detail, this.label, '/chat/completions')
        );
      }
      poke();

      // tool_calls 是分片来的，一整条流结束才拼得完，因此先攒着。
      const toolChunks: ChatToolCallDelta[][] = [];
      // 收尾原因往往在工具调用拼完之前就到——扣着，等工具调用发完再发它。
      let stopReason: StopSignal | undefined;

      for await (const payload of iterateSse(stream, signal, poke)) {
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(payload) as ChatChunk;
        } catch {
          continue; // 心跳或非 JSON 行，跳过
        }
        for (const ev of readChatChunk(chunk, this.label)) {
          if (ev.type === 'toolChunk') {
            toolChunks.push(ev.chunk);
          } else if (ev.type === 'finish') {
            stopReason = ev.reason;
          } else {
            yield ev.event;
          }
        }
      }

      // 流结束才把每个槽发出去：参数是逐片拼出来的。
      for (const call of accumulateToolCalls(toolChunks)) {
        yield { type: 'toolCall', call };
      }
      // 排在所有 toolCall 之后：先到的话，上层对账时手里还是空的。
      // 上游没给就一个都不发——补一个默认值等于替它编一句话。
      if (stopReason) {
        yield { type: 'stop', reason: stopReason };
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

// ---------------------------------------------------------------- 请求体

/** 上游明确拒过的字段。同一个模型只吃一次亏，之后每次请求都不再带它。 */
export interface Quirks {
  /** 这一次要用哪种思考写法。作者钉死时不动它。 */
  style: Exclude<ChatThinkingStyle, 'auto'>;
  /** 作者钉死了风格：协商时只降档，不换写法。 */
  pinned: boolean;
  /** 拒收 `stream_options`（老式兼容实现见到未知字段就 400）。 */
  noStreamOptions: boolean;
  /** 拒收 `temperature`（推理模型一律如此）。 */
  noTemperature: boolean;
  /** 认得的最高档。作者选了更高的档就按这个发。 */
  maxDepth: ThinkingDepth;
  /** 「输出上限太小」那句话已经说过了。同一个模型只说一次。 */
  warnedRoom: boolean;
}

/**
 * 每个「接口地址 + 模型」一份。
 *
 * 记在内存里而不是配置里：这是**上游的事实**（这个网关认哪个字段名），不是
 * 作者的偏好。进程重启后重新学一遍，代价是几次 400。作者真想固化它，设置页
 * 的「思考字段」下拉就是那个地方——那一档会带上 `pinned`。
 */
const QUIRKS = new Map<string, Quirks>();

function quirksOf(baseUrl: string, model: string, style: ChatThinkingStyle): Quirks {
  const key = `${baseUrl}|${model}|${style}`;
  let q = QUIRKS.get(key);
  if (!q) {
    q = {
      style: style === 'auto' ? CHAT_STYLE_LADDER[0] : style,
      pinned: style !== 'auto',
      noStreamOptions: false,
      noTemperature: false,
      maxDepth: 'max',
      warnedRoom: false,
    };
    QUIRKS.set(key, q);
  }
  return q;
}

export function buildBody(
  model: string,
  msgs: unknown[],
  options: StreamOptions,
  quirk: Quirks
): Record<string, unknown> {
  const depth = capDepth(options.thinking, quirk.maxDepth);
  const effort = chatEffort(depth);
  warnRoom(depth, options.maxOutputTokens, quirk, model);
  return {
    model,
    messages: msgs,
    max_tokens: options.maxOutputTokens,
    stream: true,
    // 要真实用量必须显式开这个开关，否则流式响应里没有 usage 字段。
    // 事件流里 usage 是一等公民，没有「调用方想不想听」这回事。
    ...(quirk.noStreamOptions ? {} : { stream_options: { include_usage: true } }),
    ...thinkingFields(effort, depth, options.maxOutputTokens, quirk.style),
    // 推理模型拒收 temperature。思考开着时一律不带（它必然是推理模型），
    // 关着时带上——非推理模型上它仍然是有效的文风旋钮。
    ...(effort || quirk.noTemperature ? {} : { temperature: options.temperature }),
    // 没有 tools 时这两个字段一律不带——有些兼容实现见到未知字段会直接 400
    // （stream_options 上已经踩过这个坑）。
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((s) => ({
            type: 'function',
            function: { name: s.name, description: s.description, parameters: s.parameters },
          })),
          ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        }
      : {}),
  };
}

/**
 * 一种风格 → 该带的那几个字段。
 *
 * `off` 档（`effort` 为 undefined）与 `none` 风格都是**什么都不带**：显式关掉
 * 在各家上都是部分模型才认的，理由见 thinking.ts。
 */
export function thinkingFields(
  effort: string | undefined,
  depth: ThinkingDepth,
  maxOutputTokens: number,
  style: Exclude<ChatThinkingStyle, 'auto'>
): Record<string, unknown> {
  if (!effort || style === 'none') {
    return {};
  }
  switch (style) {
    case 'effort':
      return { reasoning_effort: effort };
    case 'thinking':
      // 智谱那边开关与档位是两个字段：thinking 负责开，effort 负责多深。
      return { thinking: { type: 'enabled' }, reasoning_effort: effort };
    case 'enable': {
      const budget = thinkingBudget(depth, maxOutputTokens);
      // 预算算不出来（输出上限装不下 1024 的硬下限）就只开开关，不带一个
      // 必然被拒的数字。
      return { enable_thinking: true, ...(budget ? { thinking_budget: budget } : {}) };
    }
    case 'reasoning':
      return { reasoning: { effort } };
  }
}

/**
 * 思考的 token 算在输出上限里：上限太小，模型想完就没额度说话了。
 * 说一次就够——每轮都刷会把日志页淹掉，而作者能改的地方只有一个。
 */
function warnRoom(
  depth: ThinkingDepth,
  maxOutputTokens: number,
  quirk: Quirks,
  model: string
): void {
  if (quirk.warnedRoom || !outputRoomTooSmall(depth, maxOutputTokens)) {
    return;
  }
  quirk.warnedRoom = true;
  log.warn(
    `${model} 开着「${THINKING_LABEL[depth]}」，但输出上限只有 ${maxOutputTokens} token`,
    '思考的 token 算在输出上限里，回答可能被挤短。可在设置页把这个模型的「输出上限」调大。'
  );
}

function capDepth(depth: ThinkingDepth | undefined, max: ThinkingDepth): ThinkingDepth {
  let d = depth ?? 'off';
  const order: ThinkingDepth[] = ['off', 'low', 'medium', 'high', 'max'];
  while (order.indexOf(d) > order.indexOf(max)) {
    d = downgradeDepth(d);
  }
  return d;
}

/**
 * 400 了：是我们带了它不认的字段，还是真出错了？
 *
 * 返回 true 表示「已经把那个字段记下来了，换一份请求体再发一次」。其余情况
 * 返回 false，由调用方按 HTTP 错误报出来。**只认 400**：401/404/429 与字段
 * 无关，改请求体再发只是白等一次。
 *
 * 每一条都先问「这一次真带了那个字段吗」——没带 `reasoning_effort` 却按「它
 * 不认这个字段」换写法，等于把一个真正的错误推迟几个来回才报出来。
 */
export function negotiate(
  status: number,
  body: string,
  sent: Record<string, unknown>,
  quirk: Quirks,
  label: string
): boolean {
  if (status !== 400) {
    return false;
  }
  const detail = body.toLowerCase();

  // 老式兼容实现见到这个字段就 400。它与思考无关，先排掉。
  if ('stream_options' in sent && detail.includes('stream_options') && !quirk.noStreamOptions) {
    quirk.noStreamOptions = true;
    log.warn(`${label} 不认 stream_options，去掉它再发一次`, '代价是这一轮拿不到真实 token 用量');
    return true;
  }
  if ('temperature' in sent && detail.includes('temperature') && !quirk.noTemperature) {
    quirk.noTemperature = true;
    return true;
  }

  const sentThinking = THINKING_KEYS.some((k) => k in sent);
  if (!sentThinking || !mentionsThinking(detail)) {
    return false;
  }

  // 「这个 effort 值不认」：先降档——梯子上老模型缺的往往只是顶上那一两档，
  // 不是整套写法。降到底了才换写法。
  if (detail.includes('effort') && quirk.maxDepth !== 'low') {
    quirk.maxDepth = downgradeDepth(quirk.maxDepth);
    log.warn(
      `${label} 不认这一档思考深度，降到「${THINKING_LABEL[quirk.maxDepth]}」再发一次`,
      detail.slice(0, 200)
    );
    return true;
  }

  // 作者钉死了风格：不替他换成别的写法。他选的那一套被拒了，就退到不带
  // 思考字段——继续试别的等于无视那个下拉框。
  if (quirk.pinned) {
    if (quirk.style === 'none') {
      return false;
    }
    const pinnedStyle = quirk.style;
    quirk.style = 'none';
    log.warn(
      `${label} 不认「${CHAT_THINKING_STYLE_LABEL[pinnedStyle]}」，这一轮起不带思考字段`,
      `作者在设置页钉死了思考字段风格，所以不替他换别的写法｜${detail.slice(0, 200)}`
    );
    return true;
  }

  const next = CHAT_STYLE_LADDER[CHAT_STYLE_LADDER.indexOf(quirk.style) + 1];
  if (!next) {
    return false;
  }
  quirk.style = next;
  log.warn(
    next === 'none'
      ? `${label} 四种思考写法都不认，这一轮起不带思考字段`
      : `${label} 不认这种思考写法，改用「${CHAT_THINKING_STYLE_LABEL[next]}」再发一次`,
    detail.slice(0, 200)
  );
  return true;
}

/** 四种风格用到的全部字段名——「这一次带了思考字段吗」按它判。 */
const THINKING_KEYS = [
  'reasoning_effort',
  'thinking',
  'enable_thinking',
  'thinking_budget',
  'reasoning',
];

/** 上游这句抱怨是在说思考字段吗。措辞各家不同，只能按关键词认。 */
function mentionsThinking(detail: string): boolean {
  return (
    detail.includes('reasoning') ||
    detail.includes('thinking') ||
    detail.includes('effort') ||
    detail.includes('budget')
  );
}

// ---------------------------------------------------------------- 消息转换

/**
 * `AgentMessage[]` → OpenAI 的 `messages[]`。
 *
 * 这条协议是四家里最省事的：system 就是一条普通消息，`tool` 是独立 role，
 * 工具调用挂在 assistant 上。**思考凭据一律不带**（`traces` 直接忽略）——
 * 理由见类注释。
 */
export function toChatMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        // 只发工具调用、一个字都没说时 content 必须是 null，空串会被部分实现拒掉。
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.raw },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ---------------------------------------------------------------- 事件解析

/** 流式响应里 `delta.tool_calls` 的一片。 */
export interface ChatToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * 一个 chunk 从流里读出来的东西。
 *
 * 工具分片与收尾原因**不能立刻发出去**（一个要攒、一个要排在攒完之后），所以
 * 这里不直接产 `StreamEvent`，而是把三种情况分开交给调用方。这样解析逻辑仍然
 * 是纯函数，可以单独测。
 */
export type ChatRead =
  | { type: 'event'; event: StreamEvent }
  | { type: 'toolChunk'; chunk: ChatToolCallDelta[] }
  | { type: 'finish'; reason: StopSignal };

/** 一个 chunk → 若干读数。认不出的一律忽略。 */
export function readChatChunk(chunk: ChatChunk, label: string): ChatRead[] {
  if (chunk.error) {
    throw new LlmError(`${label} 返回错误：${chunk.error.message ?? '未知错误'}`);
  }
  const out: ChatRead[] = [];
  // usage 通常在最后一个（choices 为空的）chunk 里。
  if (chunk.usage) {
    out.push({
      type: 'event',
      event: {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
      },
    });
  }
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  // 思考内容不能混进正文——它不该被采纳写入章节。但推理模型可能先想几十秒
  // 才开始吐正文，这段时间界面不能是空的，所以走单独的事件。
  // 两个字段名都读：DeepSeek / 智谱 用 reasoning_content，OpenRouter 用 reasoning。
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (reasoning) {
    out.push({ type: 'event', event: { type: 'reasoning', text: reasoning } });
  }
  if (delta?.content) {
    out.push({ type: 'event', event: { type: 'text', text: delta.content } });
  }
  if (delta?.tool_calls) {
    out.push({ type: 'toolChunk', chunk: delta.tool_calls });
  }
  if (choice?.finish_reason) {
    out.push({ type: 'finish', reason: stopSignalOf(choice.finish_reason) });
  }
  return out;
}

/**
 * `finish_reason` → 归一的四档。
 *
 * 认不出的一律 `other`：这个字段各家还在加值（`content_filter`、
 * `function_call`），报错会让循环因为一个不认识的字符串就断掉。
 */
export function stopSignalOf(reason: string): StopSignal {
  switch (reason) {
    case 'tool_calls':
      return 'toolUse';
    case 'stop':
    case 'stop_sequence':
      return 'end';
    case 'length':
      return 'maxTokens';
    default:
      return 'other';
  }
}

/**
 * 把一整条流里的 `delta.tool_calls` 分片拼成完整的工具调用。
 *
 * **按 `index` 累积，不是按 `id`**——`id` 只在第一片给，`name` 通常也只给
 * 一次，后续分片只有 `function.arguments` 的片段。按 id 累积会让后面每一片
 * 各开一个空 id 的槽，参数永远拼不起来。多个并行调用各占一个 index。
 *
 * `JSON.parse` 失败**绝不抛**：发一个 `args: {}` 的调用，`raw` 保留原文交给
 * 上层回显给模型看。抛异常会炸掉整轮对话——模型少写一个右花括号，用户丢的
 * 是整段生成。
 */
export function accumulateToolCalls(chunks: ChatToolCallDelta[][]): ToolCall[] {
  const slots = new Map<number, { id: string; name: string; args: string }>();
  for (const chunk of chunks) {
    for (const tc of chunk) {
      const slot = slots.get(tc.index) ?? { id: '', name: '', args: '' };
      if (tc.id) {
        slot.id = tc.id;
      }
      if (tc.function?.name) {
        slot.name = tc.function.name;
      }
      if (tc.function?.arguments) {
        slot.args += tc.function.arguments;
      }
      slots.set(tc.index, slot);
    }
  }
  return [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => ({
      id: slot.id,
      name: slot.name,
      args: parseToolArgs(slot.args),
      raw: slot.args,
    }));
}
