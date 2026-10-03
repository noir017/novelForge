import { ThinkingDepth } from '../model/thinking';

/** 一次请求的真实 token 用量。字段缺席表示该服务商没给这一项。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * provider 吐出的唯一原语。
 *
 * 思考（reasoning）与正文（text）分成两种事件而不是两个回调：思考不该被
 * 写入章节，但它可能先跑几十秒才开始吐正文，界面在这期间必须有反馈。
 * usage 同理是一等公民——它是校准 tokenCounter 的唯一实测来源，没有
 * 「调用方想不想听」这回事。
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  /**
   * 上游自己报的收尾原因。**不是给界面看的**，是用来分清收尾与截断（见 `StopSignal`）。
   */
  | { type: 'stop'; reason: StopSignal };

/**
 * 上游报的收尾原因，归一成三档。
 *
 * 用它的是需要分清「模型自己收了尾」与「被输出上限截断」的调用方：正文续写链
 * （`generation/continuation.ts`）据 `maxTokens` 接着写、据 `end` 判断结尾已经
 * 落在章末钩子上；工程页批量（`features/pipelineBatch.ts`）据 `maxTokens` 判断
 * 结构化输出是否被截断。`undefined`（上游没说）与 `other` 都不敢当成任何一种。
 */
export type StopSignal = 'end' | 'maxTokens' | 'other';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

export interface StreamOptions {
  maxOutputTokens: number;
  temperature: number;
  /**
   * 空闲超时（毫秒）：多久没收到数据才中止。
   * 流式还在吐字时不计时——整段请求可以远长于这个值。
   */
  timeoutMs: number;
  /** 外部取消（用户点「停止」）。超时仍由本模块内部处理。 */
  signal?: AbortSignal;
  /**
   * 这一轮让模型想多深。缺席或 `off` = 不带任何思考参数（服务商默认）。
   *
   * 只有作者选定的那个模型的调用带它（对话页单次生成）——工程页
   * 的后台批量任务不带，理由与第 12 条同源：那一档模型是作者按成本挑的，
   * 替他把每一章的摘要都升级成深思考，等于绕过他的成本决定。
   */
  thinking?: ThinkingDepth;
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
  /** 流式对话。逐个 yield 事件，文本用 `collect.ts` 的 collectText 收。 */
  stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
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

export interface AbortHandle {
  signal: AbortSignal;
  /** 收到数据时调用，把空闲计时器拨回满。dispose 之后是空操作。 */
  poke: () => void;
  /** 请求结束后必须调用，否则定时器会泄漏。 */
  dispose: () => void;
}

/**
 * 把外部取消信号与空闲超时统一成一个 AbortSignal。
 *
 * `timeoutMs` 是「多久没收到数据」而不是整段请求的上限——流式还在吐字
 * 时调用 poke() 重置计时器。返回的 dispose 必须在请求结束后调用。
 */
export function makeAbortSignal(options: {
  timeoutMs: number;
  signal?: AbortSignal;
}): AbortHandle {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = () => {
    if (disposed || controller.signal.aborted) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  };
  arm();

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
    poke: arm,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 解析 SSE 响应体，逐条 yield `data:` 后的原始字符串（已跳过 [DONE]）。 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  poke: () => void
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
      // 收到任意字节都算「还在输出」：心跳注释、半截事件都算。
      poke();
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
