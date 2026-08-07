export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatOptions {
  maxOutputTokens: number;
  temperature: number;
  /** 请求超时（毫秒）。 */
  timeoutMs: number;
  /** 外部取消（用户点「停止」）。超时仍由本模块内部处理。 */
  signal?: AbortSignal;
  /**
   * 推理模型的思考内容（DeepSeek reasoner、Gemma/Gemini thinking 等）。
   *
   * 思考不是正文，不能混进 chatStream 的产出——它不该被写入章节。
   * 但它可能先跑几十秒才开始吐正文，界面在这期间必须有反馈，
   * 否则看起来就像「卡住了，最后一次性蹦出来」。
   */
  onReasoning?: (text: string) => void;
  /**
   * 服务商回报的真实 token 用量。
   *
   * 只有服务商确实给了才回调——没给就什么都不发，绝不用估算值冒充实测
   * （那会污染 tokenCounter 的校准比值）。同一次请求可能回调多次
   * （Anthropic 在 message_start 给输入、message_delta 给输出），
   * 调用方按字段合并即可。
   */
  onUsage?: (usage: TokenUsage) => void;
}

/** 一次请求的真实 token 用量。字段缺席表示该服务商没给这一项。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  /** 展示给用户的模型标识，例如 `deepseek-chat @ api.deepseek.com`。 */
  readonly label: string;
  /**
   * 该 provider 能接受的最大输入 token。undefined 表示以用户设置的
   * contextWindow 为准（自建 API 通常如此）。
   */
  maxInputTokens(): Promise<number | undefined>;
  /** 流式对话。逐段 yield 增量文本。 */
  chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>;
}

/** 用户主动取消时抛出，调用方据此静默处理而非报错。 */
export class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

/** 服务商返回的错误，message 已整理成人话。 */
export class LlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 把整个流收集成字符串，途中可通过 onDelta 观察增量。 */
export async function collectStream(
  stream: AsyncIterable<string>,
  onDelta?: (delta: string, full: string) => void
): Promise<string> {
  let full = '';
  for await (const delta of stream) {
    full += delta;
    onDelta?.(delta, full);
  }
  return full;
}

/**
 * 把外部取消信号与超时统一成一个 AbortSignal。
 * 返回的 dispose 必须在请求结束后调用，否则定时器会泄漏。
 */
export function makeAbortSignal(options: ChatOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason ?? new CancelledError());
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 解析 SSE 响应体，逐条 yield `data:` 后的原始字符串（已跳过 [DONE]）。 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new CancelledError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；一个事件里可能有多行 data:。
      let sep: number;
      while ((sep = indexOfEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) {
          continue;
        }
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') {
          return;
        }
        yield payload;
      }
    }
  } finally {
    // 提前退出时释放底层连接。
    void reader.cancel().catch(() => undefined);
  }
}

function indexOfEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) {
    return crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

/** 统一把 fetch/abort 抛出的异常翻译成 CancelledError 或 LlmError。 */
export function normalizeError(err: unknown, signal: AbortSignal, providerLabel: string): Error {
  if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
    return new CancelledError();
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof CancelledError) {
      return new CancelledError();
    }
    return new LlmError(`${providerLabel} 请求超时。可在设置 novel.requestTimeoutMs 中调大。`, err);
  }
  if (err instanceof LlmError) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError(`${providerLabel} 请求失败：${msg}`, err);
}
