import { describeHttpError, hostOf } from './openaiProvider';
import {
  ChatMessage,
  ChatOptions,
  LlmError,
  LlmProvider,
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

  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string> {
    const { signal, dispose } = makeAbortSignal(options);
    try {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const rest = messages.filter((m) => m.role !== 'system');

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
          messages: mergeConsecutive(rest),
          max_tokens: options.maxOutputTokens,
          temperature: options.temperature,
          stream: true,
        }),
        signal,
      });

      if (!response.ok || !response.body) {
        throw new LlmError(await describeHttpError(response, this.label));
      }

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
        // 两条都转发出去，调用方按字段合并。
        const usage = event.type === 'message_start' ? event.message?.usage : event.usage;
        if (usage) {
          options.onUsage?.({
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield event.delta.text;
        }
        // 扩展思考（thinking blocks）同样不是正文，单独回调给界面展示。
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          event.delta.thinking
        ) {
          options.onReasoning?.(event.delta.thinking);
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** Anthropic 要求 user/assistant 严格交替，把相邻同角色消息合并。 */
function mergeConsecutive(messages: ChatMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  // 首条必须是 user
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '（继续）' });
  }
  return out;
}
