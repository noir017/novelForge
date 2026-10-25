/**
 * 定稿一章（D17、D18、D15、七期）：
 *
 * ```
 * 1. 反向更新细纲（1 次）：当前细纲 + 正文 → 七节（含连续性事实）→ 证据用 bigram 在正文里找（0 次）
 *    → 旧版进回收站 → 落盘（记 sourceHash / cast，writtenFrom 刷新）
 * 2. 角色状态（0–1 次）：本章出场、已经建卡的人 → 按归属写、或挂黄 ❗
 * 3. 叙事线（1–3 次）：a 认事件（线是空的也认）→ c 有新线 / 新伏笔时归并 → 证据逐字校验后追加
 *    → b 本章动过的线更新当前进度（作者改过的不写）
 * 4. 故事时间（1 次，2026-10-24 重做）：上一章的结尾 + 前面几章的时间 + 本章正文 → 晚几天、章内几跳、结尾时段、正文写明的日子
 *    → 证据逐字校验后写进 threads/时间线.md（机器写的行照新推的换，作者的不动；features/storyTime.ts）
 * ```
 *
 * 后几步读的都是第一步更新过的那份细纲（出场人物、时间地点）与正文。
 *
 * 2026-10-25 起每一步都改成转写：干活的模型按格式写自然语言，「转写」那一档的模型照抄成原来那份 JSON（features/transcribe.ts）。
 * 几步共用一个转写调用（{@link FinalizeOptions.transcribe}），转写那一档不跟确认框上为这一次挑的模型。
 *
 * 前两步移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts` 的
 * `buildFinalizePostProcessSteps`（FC:246-563）的后两步。知识库导入、定稿收据、来源 hash、
 * 项目租约不搬（总计划 §1 #14）。第三步上游不在定稿里（是叙事线编辑器里的一颗按钮），叙事线重做之后
 * 拆成认事件 / 当前进度 / 归并三段，见 features/threads.ts 的 `recordThreads`。
 *
 * ## 几步的失败各算各的
 *
 * 更新细纲是这一章能不能「记住」的那一步：它失败了整个定稿就算没成，红 ❗ 挂在章节上，细纲
 * 一个字不动。角色状态、叙事线、故事时间失败时细纲照样算数——黄 ❗ 挂在章节上（第 16 条：
 * 部分完成），角色卡 / 叙事线 / 时间线停在上一次，下次重新定稿会再来一遍。
 *
 * ## 用哪个模型
 *
 * 单章入口（主按钮、章节工作台、MCP 的 `summary finalize`）用对话页选定的那个。批量入口
 * 各走各的档（细纲与叙事线 `plotSummary`、角色状态 `characterCard`），失败换同档其余。工程页章节右键
 * 先弹确认框（`askFinalizeChapterTask`），缺省仍是对话页那个，可以为这一次换一个、或按分档。
 *
 * 后三步在 finalizeSteps.ts：工程页黄条上的「立即同步」（summarize.ts 的 `syncSummaries`）更新完细纲之后
 * 也走它们，同步过的章与逐章定稿的章是同一个结果。
 */
import { getHost } from '../host';
import { readConfig } from '../config';
import { createModelPool } from '../llm/pool';
import { LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { withCallChoice } from '../runtime/callScope';
import { scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { FINALIZE_CALLS, describeCalls } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { askCall } from './askCall';
import { poolTranscriber } from './poolIO';
import { TranscribeCall } from './transcribe';
import { SummaryOutcome, summarizeChapter } from './summarize';
import { ModelRunner, StateAndThreadsOutcome, updateStateAndThreads } from './finalizeSteps';
import { describeThreads } from './threads';
import { describeTimeOutcome } from './storyTime';

export type { ModelRunner } from './finalizeSteps';

const log = scoped('同步');

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
  /** 叙事线那一步（认事件、当前进度、归并）与故事时间那一步用谁。缺省同更新细纲（读一章、按合同摘出东西，是同一种活）。 */
  threads?: ModelRunner;
  /**
   * 转写那一次怎么调（2026-10-25 起改成转写，几步共用）。缺省走「转写」那一档（features/poolIO.ts 的 `poolTranscriber`），
   * 那一档一个可用的模型都没有时用更新细纲那一个。
   */
  transcribe?: TranscribeCall;
  /** 走到第几步了（任务条上那一行）。 */
  onStep?(step: 'summary' | 'state' | 'threads' | 'time'): void;
}

export interface FinalizeOutcome extends StateAndThreadsOutcome {
  /** 实际调了几次模型（四步合计，写 3–6 次，加上转写的）。 */
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
      log.warn(`第 ${chapter.order} 章没有同步：没有可用的模型（未配置或未录入 API Key）`);
      getHost().toast('没有可用的模型：先在设置页配一个。', 'error');
      return undefined;
    }
    summaryRunner = singleModel(llm);
  }
  const transcribe = opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, summaryRunner);
  opts.onStep?.('summary');
  const summary = await summaryRunner.run(`第 ${chapter.order} 章 · 细纲`, (llm) =>
    summarizeChapter(project, chapter, llm, opts.signal, summaryRunner!.primaryBudget, transcribe)
  );
  if (!summary) {
    return undefined;
  }
  const rest = await updateStateAndThreads(project, chapter, summary.cast, {
    state: opts.state ?? summaryRunner,
    threads: opts.threads ?? summaryRunner,
    signal: opts.signal,
    onStep: opts.onStep,
    transcribe,
  });
  return { ...rest, calls: summary.calls + rest.calls, summary };
}

/**
 * 「第 3 章已定稿：细纲照正文更新，7 条连续性事实；林昭、沈氏的当前状态更新到这一章；叙事线：林昭与沈青推进；
 * 埋〈玉佩的来历〉」。叙事线一定说（设计稿：什么都没认出就说「叙事线没有新进展」）。丢了的事实、没覆盖的卡、没记的事件、
 * 没成的那一步都说出来（第 2 条）；旧版细纲进了回收站也说。
 */
export function describeFinalize(no: number, o: FinalizeOutcome): string {
  const parts = [
    `第 ${no} 章已同步：细纲照正文${o.summary.trashed ? '更新（旧版已放进回收站）' : '整理了一份'}，${o.summary.facts.length} 条连续性事实`,
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
  const time = describeTimeOutcome(o);
  if (time) {
    parts.push(time);
  }
  return `${parts.join('；')}。`;
}

/**
 * 单章定稿的外壳：进度、日志、完成提示。主按钮、章节工作台、工程页右键与 VS Code 的
 * 「定稿这一章」命令共用这一份（第 11 条：不闷着干活）。`runners` 缺省用对话页选定的那个。返回实际调用次数。
 */
export async function finalizeChapterTask(
  project: NovelProject,
  chapter: Chapter,
  runners: Pick<FinalizeOptions, 'summary' | 'state' | 'threads'> = {}
): Promise<number> {
  let calls = 0;
  await runTask(
    `同步第 ${chapter.order} 章`,
    async ({ signal, report }) => {
      report({ message: `《${chapter.title}》 · 细纲`, current: 0, total: 4 });
      const outcome = await finalizeChapter(project, chapter, {
        ...runners,
        signal,
        onStep: (step) => {
          if (step === 'state') {
            report({ message: `《${chapter.title}》 · 角色状态`, current: 1, total: 4 });
          } else if (step === 'threads') {
            report({ message: `《${chapter.title}》 · 叙事线`, current: 2, total: 4 });
          } else if (step === 'time') {
            report({ message: `《${chapter.title}》 · 故事时间`, current: 3, total: 4 });
          }
        },
      });
      report({ message: outcome ? '完成' : '未同步', current: 4, total: 4 });
      if (outcome) {
        calls = outcome.calls;
        getHost().toast(
          describeFinalize(chapter.order, outcome),
          outcome.stateError || outcome.threadsError || outcome.timeError ? 'error' : 'info'
        );
      }
    },
    { scope: '同步' }
  );
  return calls;
}

/**
 * 工程页章节右键「定稿」「重新定稿」：先经确认框问这一次用哪个模型、带多少上下文（features/askCall.ts），再走
 * {@link finalizeChapterTask}。模型下拉框打开时选着对话页那个——直接点与不问时是同一个模型；
 * 选「按分档」就与「立即同步」一样各走各的档（细纲与叙事线 `plotSummary`、角色状态 `characterCard`），
 * 失败换同档其余。取消返回 0。
 */
export async function askFinalizeChapterTask(project: NovelProject, chapter: Chapter): Promise<number> {
  // 定稿过、正文没再改过的是「重新定稿」，与右键菜单上的字同一个判据。
  const plot = await project.plotOfChapter(chapter);
  const verb = plot?.sourceHash && plot.sourceHash === chapter.contentHash ? '重新同步' : '同步';
  const { why, ...calls } = FINALIZE_CALLS;
  const answer = await askCall({
    message: `${verb}第 ${chapter.order} 章《${chapter.title}》：照正文更新细纲、更新出场角色的当前状态、认这一章在叙事线上发生了什么、推这一章的故事时间。${describeCalls(calls)}。`,
    actions: [verb],
    detail: `${why}。\n旧版细纲先复制一份进 .novelforge/.trash/。`,
    tasks: ['plotSummary', 'characterCard', 'transcribe'],
    // 定稿认叙事线带几条线、几条伏笔随详细度（`recordThreads`）。
    contextDetail: true,
    preset: { model: readConfig().model || undefined },
  });
  if (answer?.action !== verb) {
    log.info(`作者取消了${verb}第 ${chapter.order} 章`);
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const summary = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!summary) {
      getHost().toast('没有可用的模型：先在设置页配一个。', 'error');
      return 0;
    }
    // 角色状态走「角色卡」档（与「立即同步」同一个分法），没配就沿用定稿那一档。
    const state = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? summary;
    log.info(`${verb}第 ${chapter.order} 章，使用模型 ${summary.label}`);
    return finalizeChapterTask(project, chapter, { summary, state, threads: summary });
  });
}
