import { describeHttpError, hostOf, parseToolArgs } from './openaiProvider';
import {
  AgentMessage,
  ChatMessage,
  ChatOptions,
  LlmError,
  LlmProvider,
  StreamEvent,
  StreamOptions,
  ToolCall,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

/** Anthropic Messages API 流式实现。system 走顶层字段，不混在 messages 里。 */
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

  /**
   * 迁移期的过渡桥：老调用点还在要「一串字符串」。Task 5 连同 `ChatMessage` /
   * `ChatOptions` 一起删掉，届时 `stream` 是唯一原语。
   */
  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string> {
    for await (const ev of this.stream(messages, options)) {
      if (ev.type === 'text') {
        yield ev.text;
      } else if (ev.type === 'reasoning') {
        options.onReasoning?.(ev.text);
      } else if (ev.type === 'usage') {
        options.onUsage?.(ev.usage);
      }
    }
  }

  async *stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const { signal, dispose } = makeAbortSignal(options);
    try {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');

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
          messages: toAnthropicMessages(messages),
          max_tokens: options.maxOutputTokens,
          temperature: options.temperature,
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

      if (!response.ok || !response.body) {
        throw new LlmError(await describeHttpError(response, this.label));
      }

      // 工具调用分三个事件到达，按 event.index 攒着，stop 之后才完整。
      const slots = new Map<number, ToolUseSlot>();

      for await (const payload of iterateSse(response.body, signal)) {
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
        const call = feedToolUse(slots, event);
        if (call) {
          yield { type: 'toolCall', call };
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

export interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown; text?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
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

/** Anthropic 的一条 content block。纯文本消息仍用字符串 content，不无谓地包成数组。 */
type ContentBlock =
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
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: ContentBlock[] = [];
      // text 为空时不放空的 text block——空 block 会 400。
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const c of m.toolCalls) {
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
