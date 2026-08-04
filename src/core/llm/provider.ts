import * as vscode from 'vscode';

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
  token?: vscode.CancellationToken;
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
 * 把 CancellationToken 与超时统一成一个 AbortSignal。
 * 返回的 dispose 必须在请求结束后调用，否则定时器会泄漏。
 */
export function makeAbortSignal(options: ChatOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const sub = options.token?.onCancellationRequested(() => controller.abort(new CancelledError()));
  if (options.token?.isCancellationRequested) {
    controller.abort(new CancelledError());
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      sub?.dispose();
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
