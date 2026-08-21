import {
  THINKING_LABEL,
  ThinkingDepth,
  anthropicEffort,
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
 * Anthropic Messages API 流式实现。system 走顶层字段，不混在 messages 里。
 *
 * ## 思考深度：一个梯子，两种写法
 *
 * Anthropic 自己换过一次思考的开关方式，而**两代写法在对方的模型上都是 400**：
 *
 * - **自适应**（4.7 / Opus 5 及以后，也是 4.6 上推荐的）：
 *   `thinking: {type:'adaptive', display:'summarized'}` + `output_config: {effort}`；
 * - **手动预算**（4.5 及更早唯一可用的）：`thinking: {type:'enabled', budget_tokens}`，
 *   4.6 上已弃用、4.7 以后直接拒。
 *
 * 作者的设置页里只有一个模型名，指望他知道自家模型属于哪一代是不合理的，所以
 * 这里**问出来**：先按自适应发，被拒了就换手动，再被拒就不带思考字段，结论按
 * 「接口地址 + 模型」记在内存里（见 QUIRKS）。代价是每个模型一生一次 400，
 * 换来的是「换个模型名就不能思考了」这件事不会发生。
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  get label(): string {
    return `${this.model} @ ${hostOf(this.baseUrl)}`;
  }

  async maxInputTokens(): Promise<number | undefined> {
    return undefined;
  }

  async *stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const { signal, dispose, poke } = makeAbortSignal(options);
    try {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const msgs = toAnthropicMessages(messages);
      const quirk = quirksOf(this.baseUrl, this.model);
      let stream: ReadableStream<Uint8Array> | undefined;

      // 上游拒了某个思考字段就换一种写法再发（见 negotiate）——**不是重试同一个
      // 请求**：每一次的请求体都与上一次不同，最多三次就退到不带思考字段。
      for (let attempt = 0; ; attempt += 1) {
        const plan = thinkingPlan(options, quirk, this.model);
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            // 手动预算那条路上，工具之间要想事情必须开这个 beta；自适应自己
            // 就会交错思考，不需要它。上游对不支持的模型是**忽略**而非报错。
            ...(plan?.mode === 'manual' && options.tools?.length
              ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
              : {}),
          },
          body: JSON.stringify({
            model: this.model,
            system: system || undefined,
            messages: msgs,
            max_tokens: options.maxOutputTokens,
            // 思考开着时不带 temperature：两代写法都要求它是默认值。
            ...(plan ? {} : { temperature: options.temperature }),
            ...(plan?.mode === 'adaptive'
              ? {
                  // display: 'summarized' 才有 thinking_delta——新模型默认是
                  // 'omitted'（只给签名），那样界面上「正在思考」是一片空白。
                  thinking: { type: 'adaptive', display: 'summarized' },
                  output_config: { effort: plan.effort },
                }
              : {}),
            ...(plan?.mode === 'manual'
              ? { thinking: { type: 'enabled', budget_tokens: plan.budgetTokens } }
              : {}),
            stream: true,
            // toolChoice 为 none 时干脆不带 tools——Anthropic 没有「有工具但禁用」
            // 这个说法，带上再禁掉只是白烧几百 token 的工具描述。
            ...(options.tools && options.tools.length > 0 && options.toolChoice !== 'none'
              ? {
                  // 字段名是 input_schema，不是 parameters。
                  tools: options.tools.map((s) => ({
                    name: s.name,
                    description: s.description,
                    input_schema: s.parameters,
                  })),
                  tool_choice: options.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' },
                }
              : {}),
          }),
          signal,
        });

        if (response.ok && response.body) {
          stream = response.body;
          break;
        }
        // 响应体只读一次：字段协商要看它，报错也要看它。
        const detail = await readBody(response);
        // 这一次压根没带思考字段的话，上游那句抱怨与我们无关——换写法再发
        // 只是白等一次，而真正的错误会被推迟两个来回才报出来。
        if (plan && attempt < 2 && negotiate(response.status, detail, quirk, this.label)) {
          continue;
        }
        throw new LlmError(describeHttpBody(response.status, detail, this.label, '/v1/messages'));
      }
      poke();

      // 工具调用分三个事件到达，按 event.index 攒着，stop 之后才完整。
      const slots = new Map<number, ToolUseSlot>();
      // 思考块同理：thinking_delta 逐段来，签名在 stop 之前才给。
      const thinking = new Map<number, ThinkingSlot>();

      for await (const payload of iterateSse(stream, signal, poke)) {
        let event: AnthropicEvent;
        try {
          event = JSON.parse(payload) as AnthropicEvent;
        } catch {
          continue;
        }
        if (event.type === 'error') {
          throw new LlmError(`${this.label} 返回错误：${event.error?.message ?? '未知错误'}`);
        }
        // 用量分两处给：message_start 带输入，message_delta 带输出累计值。
        // 两条都发出去，调用方按字段合并。
        const usage = event.type === 'message_start' ? event.message?.usage : event.usage;
        if (usage) {
          yield {
            type: 'usage',
            usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
          };
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', text: event.delta.text };
        }
        // 扩展思考（thinking blocks）同样不是正文，走单独的事件给界面展示。
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          event.delta.thinking
        ) {
          yield { type: 'reasoning', text: event.delta.thinking };
        }
        // 思考块收完了：把它连签名一起交给上层，下一轮原样发回去。
        const trace = feedThinking(thinking, event);
        if (trace) {
          yield { type: 'reasoningTrace', trace };
        }
        const call = feedToolUse(slots, event);
        if (call) {
          yield { type: 'toolCall', call };
        }
        // 收尾原因在 `message_delta` 上，**排在所有内容块之后**。上层拿它跟手里
        // 攒到的工具调用对一下：说了 tool_use 却一个都没给，就是这一轮的响应
        // 缺了一半（见 provider.ts 的 StopSignal）。
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          yield { type: 'stop', reason: stopSignalOf(event.delta.stop_reason) };
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

/**
 * Anthropic 的 `stop_reason` → 归一的四档。
 *
 * 认不出的一律 `other`：这个字段上游还在加值（`pause_turn`、`refusal`），
 * 报错会让循环因为一个不认识的字符串就断掉。
 */
function stopSignalOf(reason: string): StopSignal {
  switch (reason) {
    case 'tool_use':
      return 'toolUse';
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'maxTokens';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------- 思考写法协商

/** 上游对这个模型接受哪一种思考写法。`none` = 它根本不支持思考控制。 */
type ThinkingMode = 'adaptive' | 'manual' | 'none';

interface Quirks {
  mode: ThinkingMode;
  /** 认得的最高档。作者选了更高的档就按这个发。 */
  maxDepth: ThinkingDepth;
  /** 「输出上限太小」那句话已经说过了。同一个模型只说一次。 */
  warnedRoom: boolean;
}

/**
 * 每个「接口地址 + 模型」一份，记在内存里。
 *
 * 这是**上游的事实**（这个模型属于哪一代思考写法），不是作者的偏好，写进
 * 设置页只会多一个他答不上来的问题。进程重启后重新问一遍，代价是一次 400。
 */
const QUIRKS = new Map<string, Quirks>();

function quirksOf(baseUrl: string, model: string): Quirks {
  const key = `${baseUrl}|${model}`;
  let q = QUIRKS.get(key);
  if (!q) {
    q = { mode: 'adaptive', maxDepth: 'max', warnedRoom: false };
    QUIRKS.set(key, q);
  }
  return q;
}

/** 这一次请求要带的思考字段。`undefined` = 不带（作者关了，或上游不支持）。 */
interface ThinkingPlan {
  mode: 'adaptive' | 'manual';
  effort?: string;
  budgetTokens?: number;
}

function thinkingPlan(
  options: StreamOptions,
  quirk: Quirks,
  model: string
): ThinkingPlan | undefined {
  const depth = capDepth(options.thinking, quirk.maxDepth);
  if (depth === 'off' || quirk.mode === 'none') {
    return undefined;
  }
  // 思考的 token 算在输出上限里：上限太小，模型想完就没额度说话了。
  // 说一次就够——每轮都刷会把日志页淹掉，而作者能改的地方只有一个。
  if (!quirk.warnedRoom && outputRoomTooSmall(depth, options.maxOutputTokens)) {
    quirk.warnedRoom = true;
    log.warn(
      `${model} 开着「${THINKING_LABEL[depth]}」，但输出上限只有 ${options.maxOutputTokens} token`,
      '思考的 token 算在输出上限里，回答可能被挤短。可在设置页把这个模型的「输出上限」调大。'
    );
  }
  if (quirk.mode === 'adaptive') {
    return { mode: 'adaptive', effort: anthropicEffort(depth) };
  }
  const budgetTokens = thinkingBudget(depth, options.maxOutputTokens);
  // 输出上限太小，预算连 1024 都留不出来（API 的硬下限）——这种情况下
  // 不带思考字段，而不是发一个必然 400 的请求。
  return budgetTokens ? { mode: 'manual', budgetTokens } : undefined;
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
 * 400 了：是这一代思考写法这个模型不认，还是真出错了？
 *
 * 认出「与思考有关」就把写法退一步（自适应 → 手动预算 → 不带），记下来再发
 * 一次。其余情况返回 false，由调用方报 HTTP 错误。**只认 400**：401/404/429
 * 与请求体无关，换写法再发只是白等一次。
 */
function negotiate(status: number, body: string, quirk: Quirks, label: string): boolean {
  if (status !== 400 || quirk.mode === 'none') {
    return false;
  }
  const detail = body.toLowerCase();
  // 「这个 effort 值不认」：先降档，一路降到底才换写法——effort 的梯子上
  // 老模型缺的是顶上那两档，不是整套。
  if (detail.includes('effort') && quirk.maxDepth !== 'low') {
    quirk.maxDepth = downgradeDepth(quirk.maxDepth);
    log.warn(
      `${label} 不认这一档思考深度，降到「${THINKING_LABEL[quirk.maxDepth]}」再发一次`,
      detail.slice(0, 200)
    );
    return true;
  }
  if (!detail.includes('thinking') && !detail.includes('effort') && !detail.includes('output_config')) {
    return false;
  }
  quirk.mode = quirk.mode === 'adaptive' ? 'manual' : 'none';
  log.warn(
    quirk.mode === 'manual'
      ? `${label} 不支持自适应思考，改用手动思考预算再发一次`
      : `${label} 不支持思考控制，这一轮不带思考字段`,
    detail.slice(0, 200)
  );
  return true;
}

// ---------------------------------------------------------------- 事件

export interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown; text?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    /** 只在 `message_delta` 上：`end_turn` / `tool_use` / `max_tokens` / … */
    stop_reason?: string;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ToolUseSlot {
  id: string;
  name: string;
  json: string;
}

/** 攒一块思考。签名（整段推理的加密副本）在 stop 之前的最后一个事件才给。 */
interface ThinkingSlot {
  thinking: string;
  signature: string;
}

/** Anthropic 的一条 content block。纯文本消息仍用字符串 content，不无谓地包成数组。 */
type ContentBlock =
  /**
   * 上一轮原样收下的思考块。**必须交回去**：工具结果在协议上是一条新的 user
   * 消息，模型靠这一块把它与上一步的推理接起来。不交的话上游会静默把这一轮
   * 的思考关掉（文档写明是 graceful degradation，不报错），表现出来就是
   * 「开了深思考，但 agent 从第二步起就不想了」。
   */
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
}

/**
 * `AgentMessage[]` → Anthropic 的 `messages[]`。
 *
 * 比 OpenAI 那边复杂的地方在于 **`tool_result` 不是独立 role**：它是一条
 * `user` 消息 content 数组里的一个 block。所以连续的 `tool` 消息要合并进
 * **一条** user 消息，而不是各自成条——各自成条会让 user/assistant 不再交替。
 *
 * system 由顶层字段带走，这里直接跳过。
 */
export function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: AnthropicMessage[] = [];

  const push = (role: string, content: string | ContentBlock[]): void => {
    const last = out[out.length - 1];
    // Anthropic 要求 user/assistant 严格交替，相邻同角色必须合并。
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') {
        last.content += `\n\n${content}`;
      } else {
        last.content = [...asBlocks(last.content), ...asBlocks(content)];
      }
      return;
    }
    out.push({ role, content });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
      continue;
    }
    if (m.role === 'assistant' && ((m.toolCalls && m.toolCalls.length > 0) || m.traces?.length)) {
      const blocks: ContentBlock[] = [];
      // 思考块排在最前：手动预算那条路要求助手这一轮**以思考块开头**。
      // 别家协议的凭据（换过模型的会话里会有）交给 Anthropic 只会 400。
      for (const trace of m.traces ?? []) {
        if (trace.kind === 'anthropic') {
          blocks.push(trace.payload as ContentBlock);
        }
      }
      // text 为空时不放空的 text block——空 block 会 400。
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      push('assistant', blocks);
      continue;
    }
    push(m.role, m.content);
  }

  // 首条必须是 user。
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '（继续）' });
  }
  return out;
}

function asBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/**
 * 喂一个事件进思考槽，这一块收完（`content_block_stop`）时返回它的凭据。
 *
 * 事件序列与工具调用同形：`content_block_start`（`content_block.type ===
 * 'thinking'`）→ 若干 `thinking_delta` → **一个 `signature_delta`** →
 * `content_block_stop`。`display: 'omitted'` 的模型上没有 thinking_delta，
 * 只有签名——那时 `thinking` 是空串，仍然要交回去（签名才是有效载荷）。
 */
function feedThinking(
  slots: Map<number, ThinkingSlot>,
  event: AnthropicEvent
): ReasoningTrace | undefined {
  const index = event.index;
  if (index === undefined) {
    return undefined;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
    slots.set(index, { thinking: '', signature: '' });
    return undefined;
  }
  const slot = slots.get(index);
  if (!slot) {
    return undefined;
  }
  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      slot.thinking += event.delta.thinking;
    }
    if (event.delta?.type === 'signature_delta' && event.delta.signature) {
      slot.signature += event.delta.signature;
    }
    return undefined;
  }
  if (event.type === 'content_block_stop') {
    slots.delete(index);
    // 没签名的思考块交回去会被拒（上游要用它验真），干脆不交。
    if (!slot.signature) {
      return undefined;
    }
    return {
      kind: 'anthropic',
      payload: { type: 'thinking', thinking: slot.thinking, signature: slot.signature },
    };
  }
  return undefined;
}

/**
 * 喂一个事件进累积槽，这一块收完时返回拼好的工具调用。
 *
 * 三个事件一组：`content_block_start`（带 `id` / `name`）→ 若干
 * `content_block_delta`（`input_json_delta` 的 `partial_json` 是**逐字符拼的
 * JSON 串**）→ `content_block_stop`（此时才完整）。按 `event.index` 分槽，
 * 多个并行调用各占一个 index。
 */
function feedToolUse(slots: Map<number, ToolUseSlot>, event: AnthropicEvent): ToolCall | undefined {
  const index = event.index;
  if (index === undefined) {
    return undefined;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    slots.set(index, {
      id: event.content_block.id ?? '',
      name: event.content_block.name ?? '',
      json: '',
    });
    return undefined;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    const slot = slots.get(index);
    if (slot && event.delta.partial_json) {
      slot.json += event.delta.partial_json;
    }
    return undefined;
  }
  if (event.type === 'content_block_stop') {
    const slot = slots.get(index);
    if (!slot) {
      return undefined;
    }
    slots.delete(index);
    // 坏 JSON 不抛：发一个 args 为空的调用，raw 保留原文交给上层回显。
    return { id: slot.id, name: slot.name, args: parseToolArgs(slot.json), raw: slot.json };
  }
  return undefined;
}

/** 把一整条事件序列里的 tool_use 块拼成工具调用，按 `content_block_stop` 的先后产出。 */
export function accumulateToolUse(events: AnthropicEvent[]): ToolCall[] {
  const slots = new Map<number, ToolUseSlot>();
  const calls: ToolCall[] = [];
  for (const event of events) {
    const call = feedToolUse(slots, event);
    if (call) {
      calls.push(call);
    }
  }
  return calls;
}
