import { getHost } from './host';
import { CancelledError } from './llm/provider';
import { describeError, elapsed, formatDuration, scoped } from './logger';

/**
 * 长任务登记处。
 *
 * `Host.progress` 只把进度交给宿主自己的 UI（VS Code 的通知条 / 独立版的
 * toast），网页里看不见——「同步 76 章摘要」跑起来之后界面上什么都没有，
 * 只能干等。这里在它外面补一层：把每次进度同时记进一张进程内的表，
 * 由 `ChatController` 订阅后广播给所有前端，工程页据此画进度条。
 *
 * 三件事一次做完，调用方只写一遍：
 * 1. 宿主原生进度（通知条、可取消）照旧；
 * 2. 结构化进度（第几项/共几项）推给网页；
 * 3. 开始 / 每步 / 结束都进日志，附耗时。
 */

export interface TaskSnapshot {
  id: string;
  /** 展示名，如「同步章节摘要」。不带「Novel Forge：」前缀。 */
  title: string;
  /** 当前在做什么，如「第 12 章《夜访》」。 */
  message: string;
  /** 已完成项数 / 总项数。两者都有才画进度条。 */
  current?: number;
  total?: number;
  /** 已运行毫秒数（快照时刻）。前端自己续着走秒。 */
  elapsedMs: number;
}

export interface TaskContext {
  /** 取消信号：用户点了宿主的取消，或前端点了进度条上的「停止」。 */
  readonly signal: AbortSignal;
  /**
   * 汇报进度。传字符串只改文案；传对象可同时给出 `current` / `total`，
   * 前端据此画进度条。字段留空表示沿用上一次的值。
   */
  report(update: string | { message?: string; current?: number; total?: number }): void;
}

interface TaskState extends TaskSnapshot {
  startedAt: number;
  abort: AbortController;
}

const log = scoped('任务');
const tasks = new Map<string, TaskState>();
const listeners = new Set<() => void>();
let counter = 0;

/** 当前在跑的任务快照，按开始时间正序。 */
export function activeTasks(): TaskSnapshot[] {
  return [...tasks.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({
      id: t.id,
      title: t.title,
      message: t.message,
      current: t.current,
      total: t.total,
      elapsedMs: Date.now() - t.startedAt,
    }));
}

/** 任务表有变化时回调（新增/进度/结束）。返回的 dispose 必须在宿主销毁时调用。 */
export function onTasksChanged(fn: () => void): { dispose(): void } {
  listeners.add(fn);
  return { dispose: () => void listeners.delete(fn) };
}

/** 前端点「停止」。未知 id（任务刚好结束）当作无事发生。 */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) {
    return false;
  }
  log.info(`用户取消「${task.title}」`, `已运行 ${formatDuration(Date.now() - task.startedAt)}`);
  task.abort.abort(new CancelledError());
  return true;
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 订阅者出错不影响任务本身 */
    }
  }
}

/**
 * 跑一个长任务。
 *
 * @param title 展示名，如「同步章节摘要」。
 * @param fn 任务体。拿到 `signal` 与 `report`。
 * @param opts.scope 日志来源名，缺省用 title。
 */
export async function runTask<T>(
  title: string,
  fn: (ctx: TaskContext) => Promise<T>,
  opts: { scope?: string } = {}
): Promise<T> {
  const id = `task-${++counter}`;
  const scope = opts.scope ?? title;
  const taskLog = scoped(scope);
  const startedAt = Date.now();

  return getHost().progress(`Novel Forge：${title}`, async (hostSignal, hostReport) => {
    // 自己持一个 controller：宿主的取消（通知条上的 ×）与前端进度条上的
    // 「停止」都要能中断，两条来源在这里并成一个 signal。
    const abort = new AbortController();
    const relay = () => abort.abort(hostSignal.reason ?? new CancelledError());
    if (hostSignal.aborted) {
      relay();
    } else {
      hostSignal.addEventListener('abort', relay, { once: true });
    }

    const state: TaskState = { id, title, message: '准备中…', elapsedMs: 0, startedAt, abort };
    tasks.set(id, state);
    taskLog.info(`开始：${title}`);
    notify();

    const report: TaskContext['report'] = (update) => {
      if (typeof update === 'string') {
        state.message = update;
      } else {
        if (update.message !== undefined) {
          state.message = update.message;
        }
        if (update.current !== undefined) {
          state.current = update.current;
        }
        if (update.total !== undefined) {
          state.total = update.total;
        }
      }
      // 宿主原生进度只吃字符串，把 n/N 拼进去。
      const suffix =
        state.current !== undefined && state.total !== undefined ? `（${state.current}/${state.total}）` : '';
      hostReport(`${state.message}${suffix}`);
      taskLog.debug(`${state.message}${suffix}`);
      notify();
    };

    try {
      const result = await fn({ signal: abort.signal, report });
      if (abort.signal.aborted) {
        taskLog.warn(`已取消：${title}`, `已运行 ${elapsed(startedAt)}`);
      } else {
        taskLog.info(`完成：${title}`, `耗时 ${elapsed(startedAt)}`);
      }
      return result;
    } catch (err) {
      if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
        taskLog.warn(`已取消：${title}`, `已运行 ${elapsed(startedAt)}`);
      } else {
        taskLog.error(`失败：${title}——${describeError(err)}`, err);
      }
      throw err;
    } finally {
      hostSignal.removeEventListener('abort', relay);
      tasks.delete(id);
      notify();
    }
  });
}
