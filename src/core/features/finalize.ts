/**
 * 定稿一章（D17、D18、D15）：
 *
 * ```
 * 1. 摘要（1 次）：六节 + 连续性事实 → 证据用 bigram 在正文里找（0 次）→ 落盘
 * 2. 角色状态（0–1 次）：本章出场、已经建卡的人 → 按归属写、或挂黄 ❗
 * ```
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts` 的
 * `buildFinalizePostProcessSteps`（FC:246-563）的后两步。知识库导入、定稿收据、来源 hash、
 * 项目租约不搬（总计划 §1 #14）。
 *
 * ## 两步的失败各算各的
 *
 * 摘要是这一章能不能「记住」的那一步：它失败了整个定稿就算没成，红 ❗ 挂在章节上（与从前
 * 「总结这一章」一样）。角色状态失败时摘要照样算数——黄 ❗ 挂在章节上（第 16 条：部分完成），
 * 角色卡停在上一次的状态，下次重新定稿会再来一遍。
 *
 * ## 用哪个模型
 *
 * 单章入口（主按钮、章节工作台、右键、agent 的 `run summarize`）用对话页选定的那个，与从前的
 * 「总结这一章」一致。批量入口两步各走各的档（`plotSummary` / `characterCard`），失败换同档其余。
 */
import { getHost } from '../host';
import { readConfig } from '../config';
import { CancelledError, LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { STATE_OP, StateUpdateOutcome, updateCharacterStates } from './characterState';
import { SummaryOutcome, summarizeChapter } from './summarize';

const log = scoped('定稿');

/** 调模型的那一下：单个模型直接调，分档池带 fallback。`ModelPool` 本身就长这样。 */
export interface ModelRunner {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
}

/** 只有一个模型（对话页选定的那个）时的 runner：不换人，窗口取全局配置。 */
export function singleModel(llm: LlmProvider): ModelRunner {
  const config = readConfig();
  return {
    run: (_what, fn) => fn(llm),
    primaryBudget: { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens },
  };
}

export interface FinalizeOptions {
  signal?: AbortSignal;
  /** 摘要那一步用谁。缺省对话页选定的那个。 */
  summary?: ModelRunner;
  /** 角色状态那一步用谁。缺省同摘要。 */
  state?: ModelRunner;
  /** 走到第几步了（任务条上那一行）。 */
  onStep?(step: 'summary' | 'state'): void;
}

export interface FinalizeOutcome {
  /** 实际调了几次模型。 */
  calls: number;
  summary: SummaryOutcome;
  states?: StateUpdateOutcome;
  /** 角色状态那一步没成（摘要照样算数）。 */
  stateError?: string;
}

/**
 * 定稿一章。没有可用的模型、正文是空的时返回 undefined（已经说过原因）；摘要解析失败时抛错
 * （失败已经挂在章节上）。
 */
export async function finalizeChapter(
  project: NovelProject,
  chapter: Chapter,
  opts: FinalizeOptions = {}
): Promise<FinalizeOutcome | undefined> {
  let summaryRunner = opts.summary;
  if (!summaryRunner) {
    const llm = await resolveProvider();
    if (!llm) {
      log.warn(`第 ${chapter.order} 章没有定稿：没有可用的模型（未配置或未录入 API Key）`);
      getHost().toast('没有可用的模型：先在设置页配一个。', 'error');
      return undefined;
    }
    summaryRunner = singleModel(llm);
  }
  opts.onStep?.('summary');
  const summary = await summaryRunner.run(`第 ${chapter.order} 章 · 摘要`, (llm) =>
    summarizeChapter(project, chapter, llm, opts.signal, summaryRunner!.primaryBudget)
  );
  if (!summary) {
    return undefined;
  }
  const outcome: FinalizeOutcome = { calls: 1, summary };

  opts.onStep?.('state');
  const stateRunner = opts.state ?? summaryRunner;
  try {
    outcome.states = await updateCharacterStates(project, chapter, summary.cast, {
      run: (what, fn) => stateRunner.run(what, fn),
      budget: stateRunner.primaryBudget,
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
      message: `摘要已写好，但角色状态没更新成：${outcome.stateError}`,
      detail: '角色卡的当前状态停在上一次。重新定稿这一章会再更新一遍。',
    });
  }
  return outcome;
}

/**
 * 「第 3 章已定稿：摘要与 7 条连续性事实；林昭、沈氏的当前状态更新到这一章。」
 * 丢了的事实、没覆盖的卡、没更新成的那一步都说出来（第 2 条）。
 */
export function describeFinalize(no: number, o: FinalizeOutcome): string {
  const parts = [`第 ${no} 章已定稿：摘要与 ${o.summary.facts.length} 条连续性事实`];
  if (o.summary.dropped.length > 0) {
    parts.push(`另有 ${o.summary.dropped.length} 条在正文里找不到依据，没有收`);
  }
  const s = o.states;
  if (o.stateError) {
    parts.push(`角色状态没更新成（${o.stateError}）`);
  } else if (s) {
    if (s.updated.length > 0) {
      parts.push(`${s.updated.join('、')}的当前状态更新到这一章`);
    }
    if (s.guarded.length > 0) {
      parts.push(`${s.guarded.join('、')}的当前状态你改过，没有覆盖（卡上挂了黄 ❗，可以对比后决定）`);
    }
    if (s.calls === 0) {
      parts.push('出场的人都还没有角色卡，没有状态可更新');
    }
  }
  return `${parts.join('；')}。`;
}

/**
 * 单章定稿的外壳：进度、日志、完成提示。主按钮、章节工作台、工程页右键与 VS Code 的
 * 「定稿这一章」命令共用这一份（第 11 条：不闷着干活）。返回实际调用次数。
 */
export async function finalizeChapterTask(project: NovelProject, chapter: Chapter): Promise<number> {
  let calls = 0;
  await runTask(
    `定稿第 ${chapter.order} 章`,
    async ({ signal, report }) => {
      report({ message: `《${chapter.title}》 · 摘要`, current: 0, total: 2 });
      const outcome = await finalizeChapter(project, chapter, {
        signal,
        onStep: (step) =>
          step === 'state' && report({ message: `《${chapter.title}》 · 角色状态`, current: 1, total: 2 }),
      });
      report({ message: outcome ? '完成' : '未定稿', current: 2, total: 2 });
      if (outcome) {
        calls = outcome.calls;
        getHost().toast(describeFinalize(chapter.order, outcome), outcome.stateError ? 'error' : 'info');
      }
    },
    { scope: '定稿' }
  );
  return calls;
}
