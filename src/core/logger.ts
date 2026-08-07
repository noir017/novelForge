/**
 * 运行日志。
 *
 * 一个进程内的环形缓冲 + 若干 sink：
 *
 * - **缓冲**永远收全量（含 debug），上限 {@link MAX_ENTRIES} 条，供网页的
 *   「日志」页在任何时刻回看——用户看到界面卡住时才想起来看日志，那时
 *   事情已经发生过了，没有缓冲就什么也查不到。
 * - **sink** 是壳注册的转发口（VS Code 的输出面板、独立版的终端、
 *   webview 推送），各自按 {@link setSinkLevel} 过滤。
 *
 * 三条约束：
 *
 * 1. **绝不记录密钥**：所有文本过一遍 {@link redact}。日志会被用户复制
 *    进 issue，API Key 不能跟着走。
 * 2. **绝不因日志抛错**：sink 抛异常只是被吞掉，日志坏了不能带崩正事。
 * 3. **绝不记录 prompt 全文**：只记条数与字数。一次续写的 prompt 有十万字，
 *    进了缓冲会把此前所有日志挤没。
 *
 * core 层零依赖（连 host.ts 都不引），任何模块都可以直接 `scoped()` 取一个记录器。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  /** 单调递增序号。前端据此去重（推送与全量重放会重叠）。 */
  seq: number;
  /** ISO 时间戳。 */
  at: string;
  level: LogLevel;
  /** 来源，如「摘要」「模型」。直接展示给用户，用中文。 */
  scope: string;
  message: string;
  /** 补充细节（多行、已脱敏、已截断）。 */
  detail?: string;
}

/** 缓冲上限。一次 76 章的摘要同步约产生 250 条，留足回看余量。 */
export const MAX_ENTRIES = 800;
/** 单条 detail 的字数上限——日志是线索，不是数据转储。 */
const MAX_DETAIL_CHARS = 2000;

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface LogSink {
  (entry: LogEntry): void;
}

export interface Unsubscribe {
  dispose(): void;
}

const buffer: LogEntry[] = [];
const sinks = new Set<LogSink>();
let seq = 0;
let sinkLevel: LogLevel = 'debug';
/** sink 内部再打日志时的重入保护：照常入缓冲，但不再往下转发。 */
let dispatching = false;

/** 取一个带来源的记录器。`scope` 会原样显示在日志页上，请用中文。 */
export function scoped(scope: string): Logger {
  return {
    debug: (message, detail) => emit('debug', scope, message, detail),
    info: (message, detail) => emit('info', scope, message, detail),
    warn: (message, detail) => emit('warn', scope, message, detail),
    error: (message, detail) => emit('error', scope, message, detail),
  };
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    seq: ++seq,
    at: new Date().toISOString(),
    level,
    scope,
    message: redact(String(message)),
    detail: describeDetail(detail),
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  if (dispatching || LEVEL_ORDER[level] < LEVEL_ORDER[sinkLevel]) {
    return;
  }
  dispatching = true;
  try {
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch {
        /* sink 坏掉不能影响正事 */
      }
    }
  } finally {
    dispatching = false;
  }
}

/**
 * 注册一个转发口。返回的 dispose 必须在壳销毁时调用，
 * 否则 webview 重建后会有两份 sink 往两个已死的通道推。
 */
export function addLogSink(sink: LogSink): Unsubscribe {
  sinks.add(sink);
  return { dispose: () => void sinks.delete(sink) };
}

/** sink 侧的级别阈值（缓冲不受影响，始终收全量）。 */
export function setSinkLevel(level: LogLevel): void {
  sinkLevel = level;
}

/** 缓冲里最近的若干条，按时间正序。 */
export function recentLogs(limit = MAX_ENTRIES): LogEntry[] {
  return limit >= buffer.length ? [...buffer] : buffer.slice(buffer.length - limit);
}

/** 清空缓冲。留一条痕迹——「日志是空的」和「日志被清过」是两回事。 */
export function clearLogs(): void {
  buffer.length = 0;
  emit('info', '日志', '日志已清空');
}

// ---------------------------------------------------------------- 格式化

/** `12:03:41` —— 日志页与输出面板都按本地时间显示。 */
export function logTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 单行文本形式，供终端、输出面板与「复制日志」共用。 */
export function formatLogEntry(entry: LogEntry): string {
  const head = `[${logTime(entry.at)}] ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}｜${entry.message}`;
  return entry.detail ? `${head}\n${indent(entry.detail)}` : head;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** 耗时的人话形式：`860ms` / `3.2s` / `1 分 12 秒`。 */
export function elapsed(startedAtMs: number, endedAtMs = Date.now()): string {
  return formatDuration(Math.max(0, endedAtMs - startedAtMs));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 异常 → 一句人话。CancelledError 之类只有名字的异常也能读。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------- 脱敏

/**
 * 抹掉文本里像密钥的片段。
 *
 * 宁可多抹：日志的用途是排查「哪一章失败了」，不是核对 Key。
 * 保留前几位是为了还能分辨「换了一把 Key」。
 *
 * 键名与分隔符之间允许一个引号——JSON 序列化出来的是
 * `"x-api-key": "…"`，少了这一段就漏掉最常见的那种形状。
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9]{0,4})[A-Za-z0-9_-]{6,}/g, '$1…〔已隐去〕')
    .replace(/\b(Bearer\s+)\S+/gi, '$1…〔已隐去〕')
    .replace(
      /((?:api[-_]?key|apikey|authorization|x-api-key|secret|token)["']?\s*[=:]\s*)(["']?)[^\s"',}\]]+/gi,
      '$1$2…〔已隐去〕'
    );
}

function describeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) {
    return undefined;
  }
  const text = detail instanceof Error ? describeErrorDetail(detail) : stringify(detail);
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const clipped =
    trimmed.length > MAX_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…（余 ${trimmed.length - MAX_DETAIL_CHARS} 字省略）`
      : trimmed;
  return redact(clipped);
}

function describeErrorDetail(err: Error): string {
  const stack = (err.stack ?? '').split('\n').slice(0, 6).join('\n');
  return stack || `${err.name}: ${err.message}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
