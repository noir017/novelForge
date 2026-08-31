import {
  CHAT_STYLE_LADDER,
  CHAT_THINKING_STYLE_LABEL,
  ChatThinkingStyle,
  THINKING_DEPTHS,
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
  ReasoningTrace,
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
 * 一次生成里最多协商几回（**不是重试次数**：每一回的请求体都比上一回少一样
 * 东西或换一种写法，见 stream 里的循环）。
 *
 * 按最长路径算出来，不拍脑袋：`THINKING_DEPTHS.length - 1` 是 effort 从 max
 * 降到 low 的档数，`CHAT_STYLE_LADDER.length - 1` 是四种写法轮完退到不带的步
 * 数，再加 `stream_options` 与 `temperature` 各一次。
 *
 * 之前这里写死 6，而最坏路径要 7 步——于是在「认识 reasoning_effort 这个字段
 * 名、但抱怨措辞是『值不支持』」的网关上，作者第一次调用会平白吃一次报错，第
 * 二次才成。数字与梯子长度绑起来，以后往梯子上加一档不会再复发。
 */
const MAX_NEGOTIATIONS =
  THINKING_DEPTHS.length -
  1 +
  (CHAT_STYLE_LADDER.length - 1) +
  // stream_options / temperature / tool_choice / assistant 的空 content 各一次，
  // 思考原文最多两次（不交 → 交 → 上游反过来拒收）。
  6;

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
 * ## 三件与另两条协议不同、不做就会出错的事
 *
 * - **思考原文交不交回去，按模型记**。同一个 kind 底下各家要求正好相反：老的
 *   `deepseek-reasoner` 交回去是**直接 400**，DeepSeek V4 的思考模式**不交回才
 *   是 400**（Kimi 的文档同样要求交回）。所以这不是一条写死的结论，而是
 *   `MODEL_COMPAT` 里的一格：表里认得的模型直接按对的来，认不出的缺省不交、
 *   被上游的 400 教一次就改。判据用 DeepSeek 文档给的那个——**这次请求带没带
 *   `tools`**：不带时交回去也会被忽略，带 `tools` 时历史上每一轮都必须交回，
 *   **包括那些没有工具调用的轮**。
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
      const quirk = quirksOf(this.baseUrl, this.model, this.style);
      // 交不交回思考原文的判据是「这次请求带没带 tools」，见 MODEL_COMPAT。
      const hasTools = (options.tools?.length ?? 0) > 0;
      let stream: ReadableStream<Uint8Array> | undefined;

      // 上游拒了某个字段就换一种写法再发（见 negotiate）——**不是重试同一个
      // 请求**：每一次的请求体都与上一次不同。上限见 MAX_NEGOTIATIONS，是按最
      // 长路径算出来的，不是拍一个数。
      for (let attempt = 0; ; attempt += 1) {
        // 消息在循环**里面**转：协商可能改掉「交不交思考原文」与「空 content
        // 发 null 还是空串」，这两样落在 messages 上而不是请求体的顶层字段上，
        // 在循环外面转一次，重发的还是协商前那一份。
        const msgs = toChatMessages(messages, {
          echoReasoning: hasTools && quirk.echoReasoning === 'on',
          nullAssistantContent: quirk.nullAssistantContent,
        });
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
        // 上游拒了某个字段就换一种写法再发（见 negotiate）——**不是重试同一个
        // 请求**：每一次的请求体都与上一次不同，而每一次协商都把某样东西**单调
        // 地往下拨一格**（档位降一档、风格换下一种、去掉一个字段），所以这个
        // 循环必然收敛。上限按最长路径算出来而不是拍一个数：最坏是先把 effort
        // 从 max 一路降到 low（4 档），再把四种写法轮一遍退到不带（4 步），外加
        // stream_options 与 temperature 各一次。写死一个数的话，梯子上加一档就
        // 会在最坏路径上提前抛错——那正是这里踩过的坑。
        if (attempt < MAX_NEGOTIATIONS && negotiate(response.status, detail, sent, quirk, this.label)) {
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
      // 思考原文整块攒一份：下一轮要原样交回去。界面上那份是逐片给的，两者
      // 不能互相替代（界面要的是「已经在想了」，回填要的是一整块原文）。
      let reasoningText = '';

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
            if (ev.event.type === 'reasoning') {
              reasoningText += ev.event.text;
            }
            yield ev.event;
          }
        }
      }

      // 排在工具调用之前发：上层把它挂到同一条 assistant 消息上（loop.ts 的
      // `traces`），下一轮再交回去。
      if (reasoningText) {
        yield { type: 'reasoningTrace', trace: { kind: 'openai-chat', payload: reasoningText } };
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

/**
 * 上游明确拒过的字段。同一个模型只吃一次亏，之后每次请求都不再带它。
 *
 * **这是两张表拼出来的一个视图**，不是一条记录——见下面 `STYLE` / `PER_MODEL`。
 * `style` / `pinned` 来自按网关记的那张，其余来自按模型记的那张。
 */
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
  /**
   * 带 `tools` 时要不要把上一轮的思考原文交回去。
   *
   * 三档而不是布尔，为的是让协商**单调收敛**：`off`（缺省，谁也没说要）→ `on`
   * （上游报了「必须交回」）→ `never`（交回去反而被拒，从此不再交）。少一档
   * 就会在两家要求相反的网关上来回翻，一个请求也发不出去。
   */
  echoReasoning: 'off' | 'on' | 'never';
  /**
   * assistant 只发工具调用、一个字都没说时，`content` 发 `null`（缺省）还是空串。
   * 两边都有实现在拒对面那一种，所以按模型记。
   */
  nullAssistantContent: boolean;
  /** 拒收 `tool_choice`（DeepSeek V4 的思考模式如此）。 */
  noToolChoice: boolean;
}

/**
 * 「这个网关认哪个字段名」——**按接口地址记，与模型无关**。
 *
 * 认字段名的是**网关**：一个 OpenRouter 底下挂着 Claude、GPT、DeepSeek、GLM，
 * 但收请求的始终是 openrouter.ai 那一层，它认 `reasoning` 对象这件事对底下每
 * 个模型都成立。按模型记的话，挂 20 个模型就要把同一个答案问 20 遍，每遍最多
 * 四次重发——问出来的还是同一个结论。
 *
 * 代价：网关真按模型分化字段时（少见），第一个模型的结论会先套到其余模型上。
 * 那不会卡死——套错了照样被 400，然后就地重新协商，最多多花一轮。
 */
const STYLE = new Map<string, { style: Exclude<ChatThinkingStyle, 'auto'>; pinned: boolean }>();

/**
 * 「这个模型能到多高档」「它收不收 temperature」——**按接口地址 + 模型记**。
 *
 * 这几样与字段名相反，是**模型**的属性：同一个网关下 gpt-4o 只到 high、Claude
 * 能到 max，混在一起记会把所有模型都限在最低那一档上，而作者在界面上选了「极限
 * 思考」，账单和效果上都看不出是谁把它降下来的。
 */
const PER_MODEL = new Map<string, Omit<Quirks, 'style' | 'pinned'>>();

/** 三件「协议上有两种做法、两边都有实现在拒对面那种」的事。 */
type ModelCompat = Pick<Quirks, 'echoReasoning' | 'nullAssistantContent' | 'noToolChoice'>;

/**
 * 已知模型的先验。
 *
 * **不是白名单**：表里没有的照旧靠 400 学（见 negotiate），这张表只是让踩过的
 * 坑不必每个模型再踩一遍——踩一遍的代价是作者的第一次生成先失败一次。
 *
 * 按模型名的**子串**认，因为中转网关会改名：作者手里那个叫
 * `deepseek-v4-flash-0731`，OpenRouter 上是 `deepseek/deepseek-v4-pro`。认不出
 * 就退回探测，不会比从前更糟。
 */
const MODEL_COMPAT: { match: RegExp; compat: Partial<ModelCompat>; why: string }[] = [
  {
    // V3.2 / V4 起的思考模式：不交回思考原文是 400、`content` 不能是 null、
    // 也不认 tool_choice。三条一起给——修好第一条马上会撞上后两条。
    match: /deepseek-(v[4-9]|v3\.[2-9])/,
    compat: { echoReasoning: 'on', nullAssistantContent: false, noToolChoice: true },
    why: '带 tools 时历史上每一轮的 reasoning_content 都必须交回，且 content 不能是 null',
  },
  {
    // 老的单独推理模型：要求正好相反，交回去是直接 400。
    match: /deepseek-reasoner/,
    compat: { echoReasoning: 'never' },
    why: 'deepseek-reasoner 拒收交回来的 reasoning_content',
  },
];

/** 缺省 = 从前的行为：不交思考原文、空 content 发 null、带 tool_choice。 */
export function compatOf(model: string): ModelCompat {
  const base: ModelCompat = {
    echoReasoning: 'off',
    nullAssistantContent: true,
    noToolChoice: false,
  };
  const hit = MODEL_COMPAT.find((e) => e.match.test(model.toLowerCase()));
  if (!hit) {
    return base;
  }
  log.debug(`${model} 命中已知兼容项`, hit.why);
  return { ...base, ...hit.compat };
}

/**
 * 两张表拼成这一次请求要用的 `Quirks`。
 *
 * 记在内存里而不是配置里：这是**上游的事实**（这个网关认哪个字段名），不是
 * 作者的偏好。进程重启后重新学一遍，代价是几次 400。作者真想固化它，设置页
 * 的「思考字段」下拉就是那个地方——那一档会带上 `pinned`。
 */
function quirksOf(baseUrl: string, model: string, style: ChatThinkingStyle): Quirks {
  // 钉死的风格按 baseUrl+style 记：作者改了那个下拉框就该重新试，而不是
  // 拿着上一档的结论不放。
  const styleKey = `${baseUrl}|${style}`;
  let s = STYLE.get(styleKey);
  if (!s) {
    s = { style: style === 'auto' ? CHAT_STYLE_LADDER[0] : style, pinned: style !== 'auto' };
    STYLE.set(styleKey, s);
  }

  const modelKey = `${baseUrl}|${model}`;
  let pm = PER_MODEL.get(modelKey);
  if (!pm) {
    pm = {
      noStreamOptions: false,
      noTemperature: false,
      maxDepth: 'max',
      warnedRoom: false,
      ...compatOf(model),
    };
    PER_MODEL.set(modelKey, pm);
  }

  // 用取值器把两张表缝成一个对象：negotiate 照常写 `quirk.style = x`，写回的是
  // 那两张表本身。让它认识「哪个字段属于哪张表」等于把缓存结构漏进协商逻辑。
  return {
    get style() {
      return s.style;
    },
    set style(v) {
      s.style = v;
    },
    get pinned() {
      return s.pinned;
    },
    set pinned(v) {
      s.pinned = v;
    },
    get noStreamOptions() {
      return pm.noStreamOptions;
    },
    set noStreamOptions(v) {
      pm.noStreamOptions = v;
    },
    get noTemperature() {
      return pm.noTemperature;
    },
    set noTemperature(v) {
      pm.noTemperature = v;
    },
    get maxDepth() {
      return pm.maxDepth;
    },
    set maxDepth(v) {
      pm.maxDepth = v;
    },
    get warnedRoom() {
      return pm.warnedRoom;
    },
    set warnedRoom(v) {
      pm.warnedRoom = v;
    },
    get echoReasoning() {
      return pm.echoReasoning;
    },
    set echoReasoning(v) {
      pm.echoReasoning = v;
    },
    get nullAssistantContent() {
      return pm.nullAssistantContent;
    },
    set nullAssistantContent(v) {
      pm.nullAssistantContent = v;
    },
    get noToolChoice() {
      return pm.noToolChoice;
    },
    set noToolChoice(v) {
      pm.noToolChoice = v;
    },
  };
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
          // DeepSeek V4 的思考模式不认 tool_choice（见 MODEL_COMPAT）。
          ...(options.toolChoice && !quirk.noToolChoice
            ? { tool_choice: options.toolChoice }
            : {}),
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
  if ('tool_choice' in sent && detail.includes('tool_choice') && !quirk.noToolChoice) {
    quirk.noToolChoice = true;
    log.warn(`${label} 不认 tool_choice，去掉它再发一次`, detail.slice(0, 200));
    return true;
  }

  // ---- 以下两条必须排在思考字段之前 ----
  //
  // `reasoning_content` 里含 "reasoning" 这个子串，落到下面的 `mentionsThinking`
  // 会被当成「上游不认这种思考写法」，于是把风格梯子整个走一遍——每一步都因为
  // 同一个真实原因失败，最后还把这个网关记成「不带思考字段」（`STYLE` 按
  // baseUrl 记），作者看到的是「从此这家所有模型都不思考了」。这句抱怨说的是
  // **消息历史**，不是请求体上那几个开关，两件事不能混。
  if (detail.includes('reasoning_content')) {
    return negotiateReasoningEcho(detail, quirk, label);
  }
  if (
    quirk.nullAssistantContent &&
    sentNullAssistantContent(sent) &&
    detail.includes('content') &&
    (detail.includes('null') || detail.includes('empty'))
  ) {
    quirk.nullAssistantContent = false;
    log.warn(
      `${label} 不收 content 为 null 的 assistant 消息，改发空串再发一次`,
      detail.slice(0, 200)
    );
    return true;
  }

  const sentThinking = THINKING_KEYS.some((k) => k in sent);
  if (!sentThinking || !mentionsThinking(detail)) {
    return false;
  }

  // 「这个 effort **值**不认」：先降档——梯子上老模型缺的往往只是顶上那一两
  // 档，不是整套写法。降到底了才换写法。
  //
  // 这里必须分清两种抱怨，否则会走错路：
  //   值不认   Unsupported value: 'reasoning_effort' does not support 'max'
  //   字段不认 Unrecognized request argument: 'reasoning_effort'
  // 两句话里都有 "reasoning_effort"（于是都含 "effort" 这个子串），但前者该降
  // 档、后者该换写法。只按子串判会把「它压根不认识这个字段」当成「这一档太
  // 高」，于是一路降到 low 都在发同一个它不认识的字段名——四种写法一种都试不
  // 到，作者看到的是「思考深度这个开关对这家没用」。
  if (rejectsValue(detail) && quirk.maxDepth !== 'low') {
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

/**
 * 「上一轮的思考原文」这件事怎么协商。**单调**：`off` → `on` → `never`，
 * 最多两步，所以不会来回翻。
 *
 * 两种抱怨要分清，措辞是唯一的线索：
 *   要交回   The `reasoning_content` in the thinking mode must be passed back to the API.
 *   不该带   Unrecognized request argument: 'reasoning_content'
 * 先认「不该带」那一类的词：`must be omitted` 这种说法两类词都占，按「要交回」
 * 读会把去掉字段的那一步变成加上字段，永远发不出去。
 *
 * 「不该带」那一串里**没有 `invalid`**，虽然措辞上很像：兼容实现的错误信封里
 * 普遍带一句 `"type": "invalid_request_error"`，把它算进去等于把每一句要求交回
 * 的抱怨都读成「不该带」，于是这条协商永远不会触发。
 */
function negotiateReasoningEcho(detail: string, quirk: Quirks, label: string): boolean {
  const rejects =
    detail.includes('unrecognized') ||
    detail.includes('unexpected') ||
    detail.includes('unsupported') ||
    detail.includes('not support') ||
    detail.includes('must not') ||
    detail.includes('should not') ||
    detail.includes('remove');
  const demands =
    !rejects &&
    (detail.includes('must') ||
      detail.includes('require') ||
      detail.includes('missing') ||
      detail.includes('pass back') ||
      detail.includes('passed back'));

  if (demands) {
    if (quirk.echoReasoning === 'off') {
      quirk.echoReasoning = 'on';
      log.warn(`${label} 要求交回上一轮的思考原文，带上它再发一次`, detail.slice(0, 200));
      return true;
    }
    if (quirk.echoReasoning === 'on') {
      // 已经在交了它还这么说：这段历史里有交不出原文的 assistant 消息——本次修复
      // 之前存下的会话，或者中途换过模型/服务商（别家的凭据认不出，一律丢掉）。
      // 那段原文再协商多少回也变不出来，只能报出来。
      log.warn(
        `${label} 仍然要求交回思考原文，但这段历史里有交不出原文的回合`,
        `多半是中途换过模型、或是这次修复之前存下的会话——新开一次会话即可｜${detail.slice(0, 200)}`
      );
      return false;
    }
    log.warn(
      `${label} 要求交回思考原文，但它此前拒收过同一个字段`,
      `上游前后两次的要求互相矛盾，只能报出来｜${detail.slice(0, 200)}`
    );
    return false;
  }

  // 不是「要交回」而是「不该带」：我们确实带了才退回去。没带就与我们无关，
  // 让真错误照原样报出来。
  if (quirk.echoReasoning === 'on') {
    quirk.echoReasoning = 'never';
    log.warn(`${label} 拒收交回来的思考原文，这一轮起不再交`, detail.slice(0, 200));
    return true;
  }
  return false;
}

/** 这一次的请求体里有没有 `content` 为 null 的 assistant 消息。 */
function sentNullAssistantContent(sent: Record<string, unknown>): boolean {
  const msgs = sent.messages;
  return (
    Array.isArray(msgs) &&
    msgs.some((m) => {
      const row = m as { role?: string; content?: unknown };
      return row.role === 'assistant' && row.content === null;
    })
  );
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

/**
 * 这句抱怨说的是「**值**不对」还是「**字段**不认识」。
 *
 * 前者降一档就能过，后者降到底也没用（字段名从头到尾没变）。各家措辞抄自实际
 * 见过的报错：OpenAI/Kimi 用 `Unsupported value`，智谱用 `invalid value`，
 * 通义用 `invalid_parameter`；而「不认识这个字段」那一类固定是
 * `unrecognized` / `unknown field` / `unexpected` / `not supported` 这几种说法。
 *
 * 判不准时**宁可当成字段不认**（返回 false → 换写法）：换写法最多多试三次就
 * 收敛，而在一个它不认识的字段上降档是死路。
 */
function rejectsValue(detail: string): boolean {
  const unknownField =
    detail.includes('unrecognized') ||
    detail.includes('unknown field') ||
    detail.includes('unknown parameter') ||
    detail.includes('unexpected') ||
    detail.includes('not supported') ||
    detail.includes('unsupported parameter');
  if (unknownField) {
    return false;
  }
  return (
    detail.includes('unsupported value') ||
    detail.includes('invalid value') ||
    detail.includes('invalid_parameter') ||
    detail.includes('does not support') ||
    detail.includes('must be one of')
  );
}

// ---------------------------------------------------------------- 消息转换

/**
 * 这一次的消息要按哪一种形状发。两项都是**上游的事实**，由 `Quirks` 给，
 * 缺省是从前的行为（谁也没要求过的网关上，请求体与从前一字不差）。
 */
export interface ChatShape {
  /** 把 assistant 的思考原文交回去。只在这次请求带了 `tools` 时才该开。 */
  echoReasoning?: boolean;
  /** assistant 只发工具调用时 `content` 发 `null`（缺省）还是空串。 */
  nullAssistantContent?: boolean;
}

/**
 * `AgentMessage[]` → OpenAI 的 `messages[]`。
 *
 * 这条协议是四家里最省事的：system 就是一条普通消息，`tool` 是独立 role，
 * 工具调用挂在 assistant 上。
 *
 * 只有一处不省事：assistant 上要不要带 `reasoning_content`。带的时候是**每一条
 * assistant 消息都带**，不只是有工具调用的那些——DeepSeek 的文档明说没有工具
 * 调用的轮也必须交回。理由与判据见类注释与 `MODEL_COMPAT`。
 */
export function toChatMessages(messages: AgentMessage[], shape: ChatShape = {}): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      const hasCalls = calls.length > 0;
      const reasoning = shape.echoReasoning ? chatReasoning(m.traces) : undefined;
      // 一个字都没说时：多数实现要求 content 是 null（空串会被拒），DeepSeek V4
      // 的思考模式反过来要求非 null。两种都得能发。
      const empty = shape.nullAssistantContent === false ? '' : null;
      return {
        role: 'assistant',
        content: hasCalls ? m.content || empty : m.content,
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        ...(hasCalls
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.raw },
              })),
            }
          : {}),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * 这条 assistant 消息里属于**本协议**的思考原文。
 *
 * 认不出的 kind 一律丢掉：作者可以在一轮对话中间换模型，Anthropic 的思考块
 * 或 Responses 的 reasoning item 塞进 `reasoning_content` 只会 400。
 */
function chatReasoning(traces: ReasoningTrace[] | undefined): string | undefined {
  const text = (traces ?? [])
    .filter((t) => t.kind === 'openai-chat' && typeof t.payload === 'string')
    .map((t) => t.payload as string)
    .join('');
  return text || undefined;
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
