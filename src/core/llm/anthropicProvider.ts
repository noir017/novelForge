import {
  THINKING_LABEL,
  ThinkingDepth,
  anthropicEffort,
  downgradeDepth,
  outputRoomTooSmall,
  thinkingBudget,
} from '../model/thinking';
import { scoped } from '../runtime/logger';
import { describeHttpBody, hostOf, readBody } from './openaiProvider';
import {
  ChatMessage,
  LlmError,
  LlmProvider,
  StopSignal,
  StreamEvent,
  StreamOptions,
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

  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
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
        // 收尾原因在 `message_delta` 上，**排在所有内容块之后**。
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
 * Anthropic 的 `stop_reason` → 归一的三档。
 *
 * 认不出的一律 `other`：这个字段上游还在加值（`pause_turn`、`refusal`），
 * 报错会让续写链因为一个不认识的字符串就断掉。
 */
function stopSignalOf(reason: string): StopSignal {
  switch (reason) {
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
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    /** 只在 `message_delta` 上：`end_turn` / `max_tokens` / … */
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

interface AnthropicMessage {
  role: string;
  content: string;
}

/**
 * `ChatMessage[]` → Anthropic 的 `messages[]`。
 *
 * Anthropic 要求 user/assistant 严格交替且首条是 user，相邻同角色并成一条；
 * system 由顶层字段带走，这里直接跳过。
 */
export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '（继续）' });
  }
  return out;
}
