/**
 * 定稿的后两步：角色状态、叙事线（见 finalize.ts 顶上那张图的第 2、3 步）。单章定稿（`finalizeChapter`）与
 * 工程页黄条上的「立即同步」（summarize.ts 的 `syncSummaries`）共用这一份。
 *
 * 单放一个文件是为了 summarize.ts 与 finalize.ts 不互相 import：定稿的第一步就是 summarize.ts 的
 * `summarizeChapter`，而同步更新完细纲之后要接着走这两步。
 *
 * 两步的失败各算各的：细纲已经照正文更新好了，这两步没成只挂黄 ❗ 在章节上（第 16 条：部分完成），
 * 角色卡 / 叙事线停在上一次，下次重新定稿会再来一遍。取消照样抛出去。
 */
import { CancelledError, LlmProvider } from '../llm/provider';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Chapter, SummaryCast } from '../model/types';
import { STATE_OP, StateUpdateOutcome, updateCharacterStates } from './characterState';
import { THREADS_OP, ThreadEventOutcome, recordThreadEvents } from './threads';

const log = scoped('定稿');

/** 调模型的那一下：单个模型直接调，分档池带 fallback。`ModelPool` 本身就长这样。 */
export interface ModelRunner {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
}

export interface StateAndThreadsOutcome {
  /** 这两步实际调了几次模型（0–2）。 */
  calls: number;
  states?: StateUpdateOutcome;
  /** 角色状态那一步没成（细纲照样算数）。 */
  stateError?: string;
  threads?: ThreadEventOutcome;
  /** 叙事线那一步没成（细纲照样算数）。 */
  threadsError?: string;
}

/**
 * 细纲照正文更新好之后：更新本章出场角色的当前状态，再判本章推进了哪几条叙事线。`cast` 是第一步交回来的
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
      scope: '定稿',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: STATE_OP,
      message: `细纲已照正文更新，但角色状态没更新成：${outcome.stateError}`,
      detail: '角色卡的当前状态停在上一次。重新定稿这一章会再更新一遍。',
    });
  }

  opts.onStep?.('threads');
  try {
    outcome.threads = await recordThreadEvents(project, chapter, {
      run: (what, fn) => opts.threads.run(what, fn),
      budget: opts.threads.primaryBudget,
      signal: opts.signal,
    });
    outcome.calls += outcome.threads.calls;
    await clearFailures(project, 'chapter', chapter.relPath, THREADS_OP);
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    outcome.calls += 1;
    outcome.threadsError = describeError(err);
    log.warn(`第 ${chapter.order} 章的叙事线没判成：${outcome.threadsError}`, err);
    await recordFailure(project, {
      scope: '定稿',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: THREADS_OP,
      message: `细纲已照正文更新，但叙事线没判成：${outcome.threadsError}`,
      detail: '叙事线没有改动。重新定稿这一章会再判一遍。',
    });
  }
  return outcome;
}
