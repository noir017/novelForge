/**
 * 定稿一章（D17、D18、D15、七期）：
 *
 * ```
 * 1. 反向更新细纲（1 次）：当前细纲 + 正文 → 八节（含连续性事实）→ 证据用 bigram 在正文里找（0 次）
 *    → 旧版进回收站 → 落盘（记 sourceHash / cast，writtenFrom 刷新）
 * 2. 角色状态（0–1 次）：本章出场、已经建卡的人 → 按归属写、或挂黄 ❗
 * 3. 叙事线（1–3 次）：a 认事件（线是空的也认）→ c 有新线 / 新伏笔时归并 → 证据逐字校验后追加
 *    → b 本章动过的线更新当前进度（作者改过的不写）
 * ```
 *
 * 后两步读的都是第一步更新过的那份细纲（出场人物）与正文。
 *
 * 前两步移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts` 的
 * `buildFinalizePostProcessSteps`（FC:246-563）的后两步。知识库导入、定稿收据、来源 hash、
 * 项目租约不搬（总计划 §1 #14）。第三步上游不在定稿里（是叙事线编辑器里的一颗按钮），叙事线重做之后
 * 拆成认事件 / 当前进度 / 归并三段，见 features/threads.ts 的 `recordThreads`。
 *
 * ## 几步的失败各算各的
 *
 * 更新细纲是这一章能不能「记住」的那一步：它失败了整个定稿就算没成，红 ❗ 挂在章节上，细纲
 * 一个字不动。角色状态、叙事线失败时细纲照样算数——黄 ❗ 挂在章节上（第 16 条：
 * 部分完成），角色卡 / 叙事线停在上一次，下次重新定稿会再来一遍。
 *
 * ## 用哪个模型
 *
 * 单章入口（主按钮、章节工作台、右键、MCP 的 `summary finalize`）用对话页选定的那个。批量入口
 * 各走各的档（细纲与叙事线 `plotSummary`、角色状态 `characterCard`），失败换同档其余。
 *
 * 后两步在 finalizeSteps.ts：工程页黄条上的「立即同步」（summarize.ts 的 `syncSummaries`）更新完细纲之后
 * 也走它们，同步过的章与逐章定稿的章是同一个结果。
 */
import { getHost } from '../host';
import { readConfig } from '../config';
import { LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { SummaryOutcome, summarizeChapter } from './summarize';
import { ModelRunner, StateAndThreadsOutcome, updateStateAndThreads } from './finalizeSteps';
import { describeThreads } from './threads';

export type { ModelRunner } from './finalizeSteps';

const log = scoped('定稿');

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
  /** 更新细纲那一步用谁。缺省对话页选定的那个。 */
  summary?: ModelRunner;
  /** 角色状态那一步用谁。缺省同更新细纲。 */
  state?: ModelRunner;
  /** 叙事线那一步（认事件、当前进度、归并）用谁。缺省同更新细纲（读一章、按合同摘出东西，是同一种活）。 */
  threads?: ModelRunner;
  /** 走到第几步了（任务条上那一行）。 */
  onStep?(step: 'summary' | 'state' | 'threads'): void;
}

export interface FinalizeOutcome extends StateAndThreadsOutcome {
  /** 实际调了几次模型（三步合计，2–5）。 */
  calls: number;
  summary: SummaryOutcome;
}

/**
 * 定稿一章。没有可用的模型、正文是空的时返回 undefined（已经说过原因）；模型返回解析不出时抛错
 * （失败已经挂在章节上，细纲没动）。
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
  const summary = await summaryRunner.run(`第 ${chapter.order} 章 · 细纲`, (llm) =>
    summarizeChapter(project, chapter, llm, opts.signal, summaryRunner!.primaryBudget)
  );
  if (!summary) {
    return undefined;
  }
  const rest = await updateStateAndThreads(project, chapter, summary.cast, {
    state: opts.state ?? summaryRunner,
    threads: opts.threads ?? summaryRunner,
    signal: opts.signal,
    onStep: opts.onStep,
  });
  return { ...rest, calls: 1 + rest.calls, summary };
}

/**
 * 「第 3 章已定稿：细纲照正文更新，7 条连续性事实；林昭、沈氏的当前状态更新到这一章；叙事线：林昭与沈青推进；
 * 埋〈玉佩的来历〉」。叙事线一定说（设计稿：什么都没认出就说「叙事线没有新进展」）。丢了的事实、没覆盖的卡、没记的事件、
 * 没成的那一步都说出来（第 2 条）；旧版细纲进了回收站也说。
 */
export function describeFinalize(no: number, o: FinalizeOutcome): string {
  const parts = [
    `第 ${no} 章已定稿：细纲照正文${o.summary.trashed ? '更新（旧版已放进回收站）' : '整理了一份'}，${o.summary.facts.length} 条连续性事实`,
  ];
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
  if (o.threadsError) {
    parts.push(`叙事线没认成（${o.threadsError}）`);
  } else if (o.threads) {
    parts.push(describeThreads(o.threads));
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
      report({ message: `《${chapter.title}》 · 细纲`, current: 0, total: 3 });
      const outcome = await finalizeChapter(project, chapter, {
        signal,
        onStep: (step) => {
          if (step === 'state') {
            report({ message: `《${chapter.title}》 · 角色状态`, current: 1, total: 3 });
          } else if (step === 'threads') {
            report({ message: `《${chapter.title}》 · 叙事线`, current: 2, total: 3 });
          }
        },
      });
      report({ message: outcome ? '完成' : '未定稿', current: 3, total: 3 });
      if (outcome) {
        calls = outcome.calls;
        getHost().toast(
          describeFinalize(chapter.order, outcome),
          outcome.stateError || outcome.threadsError ? 'error' : 'info'
        );
      }
    },
    { scope: '定稿' }
  );
  return calls;
}
