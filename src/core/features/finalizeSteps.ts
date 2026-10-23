/**
 * 定稿的后两步：角色状态、叙事线（见 finalize.ts 顶上那张图的第 2、3 步）。单章定稿（`finalizeChapter`）与
 * 工程页黄条上的「立即同步」（summarize.ts 的 `syncSummaries`）共用这一份。
 *
 * 单放一个文件是为了 summarize.ts 与 finalize.ts 不互相 import：定稿的第一步就是 summarize.ts 的
 * `summarizeChapter`，而同步更新完细纲之后要接着走这两步。
 *
 * 两步的失败各算各的：细纲已经照正文更新好了，这两步没成只挂黄 ❗ 在章节上（第 16 条：部分完成），
 * 角色卡 / 叙事线停在上一次，下次重新定稿会再来一遍。叙事线那一步里认事件没成算整步没成；认出来之后当前进度或归并
 * 没成，认出来的照样记下，黄 ❗ 照样挂在章节上（说清是哪一段）。取消照样抛出去。
 *
 * 认事件成了，这一章的叙事线就算判过：推 `project.json` 里的水位（叙事线重做四期，`recordThreads` 里的 `noteThreadsJudged`）。
 * 单章定稿、立即同步、写完即定稿都走这里，水位在连续时跟着往后推；没判成的那一章挡在水位前面，「从已写正文补记」从那里接着判。
 */
import { CancelledError, LlmProvider } from '../llm/provider';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Chapter, SummaryCast } from '../model/types';
import { STATE_OP, StateUpdateOutcome, updateCharacterStates } from './characterState';
import { THREADS_OP, ThreadsOutcome, recordThreads } from './threads';

const log = scoped('同步');

/** 调模型的那一下：单个模型直接调，分档池带 fallback。`ModelPool` 本身就长这样。 */
export interface ModelRunner {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
}

export interface StateAndThreadsOutcome {
  /** 这两步实际调了几次模型（1–4）。 */
  calls: number;
  states?: StateUpdateOutcome;
  /** 角色状态那一步没成（细纲照样算数）。 */
  stateError?: string;
  threads?: ThreadsOutcome;
  /** 叙事线那一步（认事件）没成（细纲照样算数）。 */
  threadsError?: string;
}

/**
 * 细纲照正文更新好之后：更新本章出场角色的当前状态，再认这一章在叙事线上发生了什么（认事件 / 当前进度 / 归并）。`cast` 是第一步交回来的
 * 出场人物（定稿后的细纲为准，第 14 条）。
 */
export async function updateStateAndThreads(
  project: NovelProject,
  chapter: Chapter,
  cast: readonly SummaryCast[],
  opts: {
    state: ModelRunner;
    threads: ModelRunner;
    signal?: AbortSignal;
    onStep?(step: 'state' | 'threads'): void;
  }
): Promise<StateAndThreadsOutcome> {
  const outcome: StateAndThreadsOutcome = { calls: 0 };

  opts.onStep?.('state');
  try {
    outcome.states = await updateCharacterStates(project, chapter, cast, {
      run: (what, fn) => opts.state.run(what, fn),
      budget: opts.state.primaryBudget,
      signal: opts.signal,
    });
    outcome.calls += outcome.states.calls;
    await clearFailures(project, 'chapter', chapter.relPath, STATE_OP);
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    // 请求发出去了钱就花了：失败也记一次（解析失败、网络错误都是发出去之后的事）。
    outcome.calls += 1;
    outcome.stateError = describeError(err);
    log.warn(`第 ${chapter.order} 章的角色状态没更新成：${outcome.stateError}`, err);
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: STATE_OP,
      message: `细纲已照正文更新，但角色状态没更新成：${outcome.stateError}`,
      detail: '角色卡的当前状态停在上一次。重新同步这一章会再更新一遍。',
    });
  }

  opts.onStep?.('threads');
  const th = await judgeChapterThreads(project, chapter, opts.threads, { signal: opts.signal, from: 'finalize' });
  outcome.calls += th.calls;
  if (th.threads) {
    outcome.threads = th.threads;
  }
  if (th.threadsError) {
    outcome.threadsError = th.threadsError;
  }
  return outcome;
}

/** {@link judgeChapterThreads} 的结果。 */
export interface ThreadsStep {
  /** 实际调了几次模型（认事件没成也算那 1 次：请求发出去了）。 */
  calls: number;
  threads?: ThreadsOutcome;
  /** 认事件没成（叙事线没动，这一章没判过）。 */
  threadsError?: string;
}

/**
 * 叙事线走一章（定稿第三步，1–3 次）：认事件 → 归并 → 当前进度（features/threads.ts 的 `recordThreads`）。认出来的落了盘，这一章
 * 就算判过、推水位（四期，在 `recordThreads` 里）；当前进度、归并没成或有几条线没写上，认出来的照样记下，黄 ❗ 挂在章节上（部分完成）；认事件没成，叙事线
 * 不动，黄 ❗ 挂在章节上（第 16 条）。整步都成了才清。取消照样抛出去。
 *
 * 定稿（单章、立即同步、写完即定稿，`from: 'finalize'`）与从已写正文补记（`from: 'backfill'`，features/threadsBackfill.ts）共用这一份，
 * `from` 只换失败的说法：定稿时细纲已经更新好了，补记时细纲本来就在、只差叙事线。
 */
export async function judgeChapterThreads(
  project: NovelProject,
  chapter: Chapter,
  runner: ModelRunner,
  opts: { signal?: AbortSignal; from: 'finalize' | 'backfill' }
): Promise<ThreadsStep> {
  try {
    const th = await recordThreads(project, chapter, {
      run: (what, fn) => runner.run(what, fn),
      budget: runner.primaryBudget,
      signal: opts.signal,
    });
    // 认出来了，但当前进度或归并那一次没成、或有几条线的当前进度没写上：认出来的照样记下了，黄 ❗ 照样挂在章节上（部分完成）。
    const partial = [
      th.progressError ? `当前进度没更新成（${th.progressError}）` : '',
      th.unwritten.length > 0 ? `${th.unwritten.length} 条线的当前进度没写上（${th.unwritten.join('、')}）` : '',
      th.mergeError ? `归并没判成（${th.mergeError}），新认出的照新的建了` : '',
    ].filter(Boolean);
    if (partial.length > 0) {
      await recordFailure(project, {
        scope: opts.from === 'finalize' ? '同步' : '叙事线',
        targetKind: 'chapter',
        targetKey: chapter.relPath,
        severity: 'warn',
        op: THREADS_OP,
        message: `叙事线记下了，但${partial.join('；')}`,
        detail: '重新同步这一章会再来一遍。',
      });
    } else {
      await clearFailures(project, 'chapter', chapter.relPath, THREADS_OP);
    }
    return { calls: th.calls, threads: th };
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    const threadsError = describeError(err);
    log.warn(`第 ${chapter.order} 章的叙事线没认成：${threadsError}`, err);
    await recordFailure(
      project,
      opts.from === 'finalize'
        ? {
            scope: '同步',
            targetKind: 'chapter',
            targetKey: chapter.relPath,
            severity: 'warn',
            op: THREADS_OP,
            message: `细纲已照正文更新，但叙事线没认成：${threadsError}`,
            detail: '叙事线没有改动。重新同步这一章会再判一遍。',
          }
        : {
            scope: '叙事线',
            targetKind: 'chapter',
            targetKey: chapter.relPath,
            severity: 'warn',
            op: THREADS_OP,
            message: `从已写正文补记叙事线没成：${threadsError}`,
            detail: '叙事线没有改动，水位停在这一章前面。在叙事线页签再点一次「从正文补记」，会从这一章接着判；重新同步这一章也会判。',
          }
    );
    // 请求发出去了钱就花了：认事件没成也记一次。
    return { calls: 1, threadsError };
  }
}
