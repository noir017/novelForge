import {
  ChatMessage,
  ChatOptions,
  LlmError,
  LlmProvider,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

/**
 * OpenAI 兼容的 /chat/completions 流式实现。
 * 同一套协议可对接 OpenAI、DeepSeek、Kimi、通义、硅基流动、Ollama 等。
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;

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

  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string> {
    const { signal, dispose } = makeAbortSignal(options);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiChunk;
        } catch {
          continue; // 心跳或非 JSON 行，跳过
        }
        if (chunk.error) {
          throw new LlmError(`${this.label} 返回错误：${chunk.error.message ?? '未知错误'}`);
        }
        const delta = chunk.choices?.[0]?.delta;
        // 思考内容不能混进正文——它不该被采纳写入章节。但推理模型
        // （gemma/gemini thinking、DeepSeek reasoner 等）可能先想几十秒
        // 才开始吐正文，这段时间界面不能是空的，所以单独回调出去。
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          options.onReasoning?.(reasoning);
        }
        if (delta?.content) {
          yield delta.content;
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

interface OpenAiChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
  error?: { message?: string };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function describeHttpError(response: Response, label: string): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* 读不出响应体就算了 */
  }
  detail = detail.slice(0, 400);

  const hint =
    response.status === 401 || response.status === 403
      ? '（API Key 可能无效，可在设置页重新录入该服务商的 Key）'
      : response.status === 404
        ? '（接口地址或模型名可能填错了，检查设置页里该服务商的 baseUrl 与模型清单）'
        : response.status === 429
          ? '（触发限流，稍后再试）'
          : '';

  return `${label} 返回 HTTP ${response.status}${hint}${detail ? `：${detail}` : ''}`;
}
