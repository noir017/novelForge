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

  async *stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
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
          messages: toOpenAiMessages(messages),
          max_tokens: options.maxOutputTokens,
          temperature: options.temperature,
          stream: true,
          // 要真实用量必须显式开这个开关，否则流式响应里没有 usage 字段。
          // 事件流里 usage 是一等公民，没有「调用方想不想听」这回事。
          stream_options: { include_usage: true },
          // 没有 tools 时这两个字段一律不带——有些兼容实现见到未知字段
          // 会直接 400（stream_options 上就踩过这个坑）。
          ...(options.tools && options.tools.length > 0
            ? {
                tools: options.tools.map((s) => ({
                  type: 'function',
                  function: { name: s.name, description: s.description, parameters: s.parameters },
                })),
                ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
              }
            : {}),
        }),
        signal,
      });

      if (!response.ok || !response.body) {
        throw new LlmError(await describeHttpError(response, this.label));
      }

      // tool_calls 是分片来的，一整条流结束才拼得完，因此先攒着。
      const toolChunks: OpenAiToolCallDelta[][] = [];

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
        // usage 通常在最后一个（choices 为空的）chunk 里。
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            },
          };
        }
        const delta = chunk.choices?.[0]?.delta;
        // 思考内容不能混进正文——它不该被采纳写入章节。但推理模型
        // （gemma/gemini thinking、DeepSeek reasoner 等）可能先想几十秒
        // 才开始吐正文，这段时间界面不能是空的，所以走单独的事件。
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          yield { type: 'reasoning', text: reasoning };
        }
        if (delta?.content) {
          yield { type: 'text', text: delta.content };
        }
        if (delta?.tool_calls) {
          toolChunks.push(delta.tool_calls);
        }
      }

      // 流结束（含 finish_reason === 'tool_calls'）才把每个槽发出去。
      for (const call of accumulateToolCalls(toolChunks)) {
        yield { type: 'toolCall', call };
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

/** OpenAI 流式响应里 `delta.tool_calls` 的一片。 */
export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: OpenAiToolCallDelta[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** `AgentMessage[]` → OpenAI 的 `messages[]`。 */
export function toOpenAiMessages(messages: AgentMessage[]): unknown[] {
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

/**
 * 把一整条流里的 `delta.tool_calls` 分片拼成完整的工具调用。
 *
 * **按 `index` 累积，不是按 `id`**——`id` 只在第一片给，`name` 通常也只给
 * 一次，后续分片只有 `function.arguments` 的片段。按 id 累积会让后面每一片
 * 各开一个空 id 的槽，参数永远拼不起来。多个并行调用各占一个 index。
 *
 * `JSON.parse` 失败**绝不抛**：发一个 `args: {}` 的调用，`raw` 保留原文交给
 * 上层回显给模型看。抛异常会炸掉整轮对话。
 */
export function accumulateToolCalls(chunks: OpenAiToolCallDelta[][]): ToolCall[] {
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

/** 解析工具参数。失败或解析出非对象一律退成空对象，绝不抛。 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 坏 JSON 不抛：由上层报「参数解析失败」给模型看，让它重试 */
  }
  return {};
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
