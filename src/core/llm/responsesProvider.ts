import {
  THINKING_LABEL,
  ThinkingDepth,
  downgradeDepth,
  outputRoomTooSmall,
  responsesEffort,
} from '../model/thinking';
import { scoped } from '../runtime/logger';
import { describeHttpBody, hostOf, parseToolArgs, readBody } from './http';
import {
  AgentMessage,
  LlmError,
  LlmProvider,
  StreamEvent,
  StreamOptions,
  ToolCall,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

const log = scoped('模型');

/**
 * OpenAI 的 **Responses API**（`/responses`）流式实现——Codex 走的那一套。
 *
 * ## 它与「OpenAI 通用」是两条路，不是一条路的两种写法
 *
 * 这条协议独有的三样东西，`/chat/completions` 那边表达不出来：**system 走
 * `instructions`**、**推理块能原样交回**（`store: false` + `include`，于是多轮
 * 工具调用之间的推理不白丢）、**工具调用在 item 收完时一次给全**（不必按
 * index 拼分片）。所以它值得单独一条 kind，而不是在一个 provider 里判「现在
 * 是哪一条」——那种分支每加一个字段就要判一次。
 *
 * **只认 `/chat/completions` 的服务商（DeepSeek、智谱、Kimi、通义、本地
 * Ollama、OpenRouter）在这条路上会 404**，它们的落点是 `kind: 'openai'`
 * （见 [chatCompletionsProvider.ts](chatCompletionsProvider.ts)）。404 的提示里
 * 点了这件事。
 */
export class ResponsesProvider implements LlmProvider {
  readonly id = 'openai-responses' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string
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
      const { instructions, input } = toResponsesInput(messages);
      const quirk = quirksOf(this.baseUrl, this.model);
      let stream: ReadableStream<Uint8Array> | undefined;
      // 上游拒了某个字段就拿掉它再发（见 negotiate）——**不是重试同一个请求**，
      // 所以次数上限只有三次，且每次的请求体都比上一次少一个字段。
      for (let attempt = 0; ; attempt += 1) {
        const sent = buildBody(this.model, instructions, input, options, quirk);
        const response = await fetch(`${this.baseUrl}/responses`, {
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
        // 只为**这一次真带了**的字段做协商：没带 reasoning 却按「它不认 effort」
        // 降一档，等于把一个真正的错误推迟两个来回才报出来。
        if (attempt < 2 && negotiate(response.status, detail, sent, quirk, this.label)) {
          continue;
        }
        throw new LlmError(describeHttpBody(response.status, detail, this.label));
      }
      poke();

      for await (const payload of iterateSse(stream, signal, poke)) {
        let event: ResponsesEvent;
        try {
          event = JSON.parse(payload) as ResponsesEvent;
        } catch {
          continue; // 心跳或非 JSON 行，跳过
        }
        for (const ev of readResponsesEvent(event, this.label)) {
          yield ev;
        }
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
interface Quirks {
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
 * 记在内存里而不是配置里：这是**上游的事实**（这个模型认不认 xhigh），不是
 * 作者的偏好，写进设置页只会多一个他答不上来的问题。进程重启后重新学一遍，
 * 代价是一次 400。
 */
const QUIRKS = new Map<string, Quirks>();

function quirksOf(baseUrl: string, model: string): Quirks {
  const key = `${baseUrl}|${model}`;
  let q = QUIRKS.get(key);
  if (!q) {
    q = { noTemperature: false, maxDepth: 'max', warnedRoom: false };
    QUIRKS.set(key, q);
  }
  return q;
}

function buildBody(
  model: string,
  instructions: string,
  input: unknown[],
  options: StreamOptions,
  quirk: Quirks
): Record<string, unknown> {
  const depth = capDepth(options.thinking, quirk.maxDepth);
  const effort = responsesEffort(depth);
  warnRoom(depth, options.maxOutputTokens, quirk, model);
  return {
    model,
    input,
    ...(instructions ? { instructions } : {}),
    max_output_tokens: options.maxOutputTokens,
    stream: true,
    // 不让上游存这次对话：历史由本地会话文件负责，服务端再存一份只是
    // 多一个副本。代价是推理块要自己回填（见 include 与 ReasoningTrace）。
    store: false,
    ...(effort
      ? {
          // summary: 'auto' 才会有 reasoning_summary 的增量——界面上那段
          // 「正在思考」靠它，没有它作者只能对着空气等几十秒。
          reasoning: { effort, summary: 'auto' },
          // store: false 时不显式要，推理块回来是不带 encrypted_content 的空壳，
          // 交回去也就没有意义了。
          include: ['reasoning.encrypted_content'],
        }
      : {}),
    // 推理模型拒收 temperature。思考开着时一律不带（它必然是推理模型），
    // 关着时带上——非推理模型上它仍然是有效的文风旋钮。
    ...(effort || quirk.noTemperature ? {} : { temperature: options.temperature }),
    // 没有 tools 时这两个字段一律不带——有些兼容实现见到未知字段会直接 400。
    ...(options.tools && options.tools.length > 0
      ? {
          // Responses 的工具声明是**平的**：name/parameters 直接挂在这一层，
          // 不像 chat/completions 那样包一个 function 对象。
          tools: options.tools.map((s) => ({
            type: 'function',
            name: s.name,
            description: s.description,
            parameters: s.parameters,
          })),
          ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        }
      : {}),
  };
}

/**
 * 思考的 token 算在输出上限里：上限太小，模型想完就没额度说话了。
 * 说一次就够——每轮都刷会把日志页淹掉，而作者能改的地方只有一个。
 */
function warnRoom(depth: ThinkingDepth, maxOutputTokens: number, quirk: Quirks, model: string): void {
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
 */
function negotiate(
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
  if ('temperature' in sent && detail.includes('temperature') && !quirk.noTemperature) {
    quirk.noTemperature = true;
    return true;
  }
  // 「不认这个 effort 值」：新梯子上的 xhigh 老模型没有。降一档再试，
  // 一路降到不带 reasoning 为止——降级过的档位会记住，不会每轮都撞一次。
  if (
    'reasoning' in sent &&
    (detail.includes('effort') || detail.includes('reasoning')) &&
    quirk.maxDepth !== 'off'
  ) {
    quirk.maxDepth = downgradeDepth(quirk.maxDepth);
    log.warn(
      `${label} 不认这一档思考深度，降到「${THINKING_LABEL[quirk.maxDepth]}」再发一次`,
      detail.slice(0, 200)
    );
    return true;
  }
  return false;
}


// ---------------------------------------------------------------- 消息转换

/**
 * `AgentMessage[]` → Responses 的 `instructions` + `input[]`。
 *
 * 三处与 chat/completions 不同：
 * - **system 走 `instructions` 顶层字段**，不再是 input 里的一条消息；
 * - **工具调用与工具结果是 input 里独立的一项**（`function_call` /
 *   `function_call_output`），不再挂在 assistant 消息上；两者靠 `call_id` 配对；
 * - **思考块要原样交回**（`traces`），否则多轮工具调用之间的推理白丢。
 *   放在这一轮的 `function_call` **之前**——上游按顺序把推理与它引出的调用
 *   配对，顺序颠倒等于没交。
 */
export function toResponsesInput(messages: AgentMessage[]): {
  instructions: string;
  input: unknown[];
} {
  const systems: string[] = [];
  const input: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      for (const trace of m.traces ?? []) {
        // 别家协议的凭据交给 OpenAI 只会 400——换过模型的会话里会出现这种事。
        if (trace.kind === 'openai-responses') {
          input.push(trace.payload);
        }
      }
      if (m.content) {
        input.push({ role: 'assistant', content: m.content });
      }
      for (const c of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.raw });
      }
      continue;
    }
    input.push({ role: 'user', content: m.content });
  }

  return { instructions: systems.join('\n\n'), input };
}

// ---------------------------------------------------------------- 事件解析

/** Responses 流里的一条事件。字段按 `type` 各取所需，认不出的类型一律忽略。 */
export interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    [k: string]: unknown;
  };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
    /** 只在 `response.incomplete` 上：`max_output_tokens` / `content_filter`。 */
    incomplete_details?: { reason?: string };
  };
  message?: string;
  error?: { message?: string };
}

/**
 * 一条事件 → 若干 `StreamEvent`。
 *
 * **认不出的类型一律忽略**：这条协议的事件种类有二十来个（item 的增删、
 * 各种 `.done`、注解、内容部分的开合），我们只关心其中五类。为未知类型报错
 * 会让上游加一个新事件就炸掉整轮生成。
 */
export function readResponsesEvent(event: ResponsesEvent, label: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  switch (event.type) {
    case 'response.output_text.delta':
      if (event.delta) {
        out.push({ type: 'text', text: event.delta });
      }
      return out;
    // 思考的两种流法：给人看的摘要（summary: 'auto' 才有），以及少数模型
    // 直接吐的推理正文。两者都不是正文，走 reasoning 事件给界面。
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (event.delta) {
        out.push({ type: 'reasoning', text: event.delta });
      }
      return out;
    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type === 'function_call') {
        out.push({ type: 'toolCall', call: toolCallOf(item) });
      } else if (item?.type === 'reasoning') {
        // 原样收着，下一轮交回去（store: false，上游那边不留）。
        out.push({ type: 'reasoningTrace', trace: { kind: 'openai-responses', payload: item } });
      }
      return out;
    }
    case 'response.completed':
    case 'response.incomplete': {
      const usage = event.response?.usage;
      if (usage) {
        out.push({
          type: 'usage',
          usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        });
      }
      // 这条协议里**没有** `tool_use` 这一档收尾原因：工具调用是输出项
      // （`function_call`），不是一个需要另行声明的状态，所以「说要调却没给」
      // 那种自相矛盾在这条路上表达不出来（见 provider.ts 的 StopSignal）。
      // 能报的只有截断。
      if (event.type === 'response.incomplete') {
        const reason = event.response?.incomplete_details?.reason;
        out.push({ type: 'stop', reason: reason === 'max_output_tokens' ? 'maxTokens' : 'other' });
      }
      return out;
    }
    case 'response.failed':
      throw new LlmError(`${label} 返回错误：${event.response?.error?.message ?? '未知错误'}`);
    case 'error':
      throw new LlmError(`${label} 返回错误：${event.error?.message ?? event.message ?? '未知错误'}`);
    default:
      return out;
  }
}

/**
 * `function_call` 项 → 一次工具调用。
 *
 * 与 chat/completions 最大的差别：**参数不用自己拼**。这条协议在
 * `response.output_item.done` 上给的是完整的 `arguments` 串，所以按 index
 * 累积那一套坑在这里不存在（分片增量事件我们干脆不听）。
 */
function toolCallOf(item: { call_id?: string; name?: string; arguments?: string }): ToolCall {
  const raw = item.arguments ?? '';
  return { id: item.call_id ?? '', name: item.name ?? '', args: parseToolArgs(raw), raw };
}

