import { CancelledError } from '../llm/provider';

/**
 * 有界并发。
 *
 * 工程页上最费时的几个动作——同步几十章摘要、批量更新角色卡——里的条目
 * 彼此**没有先后依赖**：第 12 章的摘要不看第 11 章的摘要，A 的角色卡也不
 * 看 B 的。串行跑纯粹是在排队等网络往返，于是这里给它们一条有界并发的路。
 *
 * 三条设计取舍：
 *
 * 1. **不 reject**。逐项 settle 后整批返回，调用方自己汇总——沿用
 *    features 层「失败项打 error 并继续跑完剩下的」的既有约定：一章摘要
 *    失败不该让另外 75 章白跑。
 * 2. **结果按 index 对齐**。完成顺序是乱的，但返回数组与入参一一对应，
 *    调用方要拼接有序产物（如全书摘要的阶段小节）时不必自己归位。
 * 3. **`limit <= 1` 走严格串行**，与改造前逐字一致——并发默认开着，
 *    出问题时用户把并发调回 1 就能拿回旧行为，这条路必须没有惊喜。
 */

/** 一项的结果。与 `Promise.allSettled` 同形，但 reason 保证是 Error。 */
export type Settled<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: Error };

export interface RunPoolOptions<T, R> {
  /** 取消信号。已 aborted 后不再启动新任务（在飞的由各自的请求 signal 打断）。 */
  signal?: AbortSignal;
  /**
   * 每项结束时回调（成功或失败都回）。进度与日志唯一的钩子——
   * `done` 是**已结束**的项数，进度条的 `current` 只该跟着它走。
   */
  onSettled?: (result: Settled<R>, item: T, index: number, done: number) => void;
  /** 每项开始时回调。并发下用来报「现在在跑哪几项」。 */
  onStart?: (item: T, index: number) => void;
}

/**
 * 并发跑一批无序任务。
 *
 * @param limit 同时在飞的上限。<= 1 时严格串行。
 * @returns 与 `items` 一一对应的结果数组（顺序不乱）。取消后未启动的项
 *          以 `CancelledError` 计入 rejected——**留个位置**，调用方要报
 *          「取消时还剩几项没跑」才有依据。
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: RunPoolOptions<T, R> = {}
): Promise<Settled<R>[]> {
  const results = new Array<Settled<R>>(items.length);
  let next = 0;
  let done = 0;

  const runOne = async (index: number): Promise<void> => {
    opts.onStart?.(items[index], index);
    let settled: Settled<R>;
    try {
      settled = { status: 'fulfilled', value: await worker(items[index], index) };
    } catch (err) {
      settled = { status: 'rejected', reason: err instanceof Error ? err : new Error(String(err)) };
    }
    results[index] = settled;
    done++;
    opts.onSettled?.(settled, items[index], index, done);
  };

  const consume = async (): Promise<void> => {
    while (next < items.length) {
      if (opts.signal?.aborted) {
        return;
      }
      await runOne(next++);
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, () => consume()));

  // 取消时留下的空位补成 rejected，调用方不必区分「没跑」与「跑挂了」两种 undefined。
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = { status: 'rejected', reason: new CancelledError() };
    }
  }
  return results;
}

/**
 * 把若干次调用串成一条队列，同一时刻只有一个在跑。
 *
 * 批量更新角色卡时分析是并发的，但 diff 审阅不能并发——同时弹三个 diff
 * 编辑器，用户根本不知道自己在看谁。于是分析照跑，审阅在这里排队，
 * 按**完成顺序**一张一张弹。
 *
 * 队列是进程级的单条链：前一个 `fn` 无论成功失败都不会卡住后面的。
 */
let chain: Promise<unknown> = Promise.resolve();

export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // 链上只保留「跑完了」这个事实，不传播异常——否则一次审阅出错会让
  // 后面所有排队的调用都收到同一个 rejection。
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
