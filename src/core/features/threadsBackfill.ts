/**
 * 从已写正文补记叙事线（叙事线重做四期，设计稿「九、补记已经写了的书」）：拆书导入的书、「从已写正文补齐」整理出来的书、
 * 定稿时叙事线没判成的章——定稿过了，线上却没有它们的事件。从 `project.json` 的水位（`threadsThrough`）之后、到最后一个定稿过的
 * 章，**按章号串行**逐章走定稿第三步（认事件 → 归并 → 当前进度，每章 1–3 次；finalizeSteps.ts 的 `judgeChapterThreads`）。
 *
 * ```
 * （一条线都没有、有情节大纲：先排线，1 次，没排成不挡补记）
 * 第 a 章 → 认事件 / 归并 / 当前进度 → 推水位 → 第 a+1 章 → …… → 定稿到的最后一章
 * ```
 *
 * - **串行**：后一章要看前一章刚记下的事件与新认出的线（同立即同步的后两步、单独补记设定）。
 * - **只判定稿过、正文没再改过的章**（第 4 条：没定稿、定稿后正文又改过的不偷偷补）：水位之后、定稿到之前这样的章跳过，确认框里
 *   列出来（先定稿，定稿时会一并判）；它们挡在水位前面，后面判过的记在 `threadsJudged`，定稿了它们水位就一口气推过去。
 * - ⚑ **一章没判成就停**（认事件没成）：后一章要看前一章，系统性的失败（模型挂了）也不会把几十章白调一遍。已判的留着，水位停在
 *   没判成的那一章前面，失败挂在那一章上（第 16 条），再点一次从那一章接着判。当前进度、归并没成不停（认出来的照样记下，黄 ❗）。
 * - ⚑ **还没有一条线、有情节大纲时先排线**（照批量拆细纲「一条线都没有先排一次」，设计稿 ⚑8）：排线算进同一个确认框（+1 次），
 *   没排成不挡补记（线照样能从正文里认出来，完成提示说一句）。没有情节大纲就不排：线全靠从正文里认。
 * - 走「定稿」档（`plotSummary`）的池，同立即同步、写完即定稿；排线走「剧情细纲」档（`plotOutline`）。不带思考深度（第 26 条）。
 *
 * 入口：工程页「叙事线」页签标题旁的「从正文补记」与右键（叙事线落后于定稿时才给）、agent 的 `extract threadsFromText`；
 * 「从已写正文补齐」（features/derive.ts）在补完架构与情节大纲之后接上它（{@link planThreadsBackfill} + {@link runThreadsBackfill}，
 * 次数并进它的确认框）。
 */
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { CallEstimate, THREADS_JUDGE_CALLS, describeCalls, threadsBackfillCalls } from '../model/pipeline';
import { isOutlineFilled } from '../model/outlineFile';
import { describeChapterRuns, isThreadsJudged } from '../model/threadFile';
import { withCallChoice } from '../runtime/callScope';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { askCall } from './askCall';
import { judgeChapterThreads } from './finalizeSteps';
import { PlanThreadsOutcome, ThreadsOutcome, describePlanned, planThreadsFromOutline } from './threads';

const log = scoped('叙事线');

/** 补记的任务名：前端看它在不在跑（media/src/view/project/threads.ts 一字不差）。 */
export const BACKFILL_TASK = '从已写正文补记叙事线';

/** 补记要判哪几章（零调用，{@link planThreadsBackfill}）。 */
export interface ThreadsBackfillPlan {
  /** 要判的章：水位之后、定稿到之前，定稿过、正文没再改过、还没判过的，按章号。 */
  chapters: Chapter[];
  /** 水位之后、定稿到之前，这一次判不了的章（没定稿、定稿之后正文又改过），按章号。 */
  skipped: { no: number; why: string }[];
  /** 一条线都没有、有（或这一次会有）情节大纲：先排线（+1 次）。 */
  planFirst: boolean;
  /** 开始之前的水位。 */
  through: number;
  /** 定稿到的最后一章。 */
  current: number;
  calls: CallEstimate;
}

/**
 * 补记要判哪几章。`outlineReady`：「从已写正文补齐」这一次会补出情节大纲时传 true（那时盘上还没有）；缺席看盘上的情节大纲。
 * 同号的正文有两份时认路径排序第一份（与流水线、总览同一个口径）。
 */
export async function planThreadsBackfill(project: NovelProject, opts: { outlineReady?: boolean } = {}): Promise<ThreadsBackfillPlan> {
  const [all, mark, book] = await Promise.all([project.listChapters(), project.readThreadsMark(), project.readThreads()]);
  const byNo = new Map<number, Chapter>();
  for (const c of all) {
    if (!byNo.has(c.order)) {
      byNo.set(c.order, c);
    }
  }
  const nos = [...byNo.keys()].sort((a, b) => a - b);
  const fresh: Chapter[] = [];
  const stale: number[] = [];
  const unfinalized: number[] = [];
  let current = 0;
  for (const no of nos) {
    const chapter = byNo.get(no)!;
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash) {
      if (chapter.wordCount > 0) {
        unfinalized.push(no);
      }
      continue;
    }
    current = no;
    if (isThreadsJudged(mark, no)) {
      continue;
    }
    if (plot.sourceHash === chapter.contentHash) {
      fresh.push(chapter);
    } else {
      stale.push(no);
    }
  }
  const skipped = [
    ...stale.map((no) => ({ no, why: '定稿之后正文又改过' })),
    // 没定稿的只说水位之后、定稿到之前的：定稿到之后的是还没走到定稿那一步，不归补记管。
    ...unfinalized.filter((no) => no > mark.through && no < current).map((no) => ({ no, why: '还没定稿' })),
  ].sort((a, b) => a.no - b.no);
  const outlineReady = opts.outlineReady ?? isOutlineFilled(await project.readOutline());
  const planFirst = fresh.length > 0 && book.threads.length === 0 && outlineReady;
  return { chapters: fresh, skipped, planFirst, through: mark.through, current, calls: threadsBackfillCalls(fresh.length, planFirst) };
}

/** {@link runThreadsBackfill} 的结果。 */
export interface ThreadsBackfillOutcome {
  /** 实际调了几次模型（含先排线那一次）。 */
  calls: number;
  /** 判过的章，按章号。 */
  judged: number[];
  /** 判过的那几章各自认出了什么（与 `judged` 一一对应）。 */
  results: ThreadsOutcome[];
  /** 先排线的结果（没排就缺席）。 */
  planned?: PlanThreadsOutcome;
  /** 停在这一章：认事件没成（失败挂在那一章上）。 */
  failed?: { no: number; reason: string };
  /** 停下时还没走到的章（没判成的那一章之后的、取消时剩下的）。 */
  left: number[];
  cancelled?: boolean;
  /** 认出来了、当前进度或归并没成的章（挂了黄 ❗）。 */
  partial: number[];
  /** 跑完之后的水位。 */
  through: number;
}

/**
 * 按 {@link planThreadsBackfill} 的结果补记。**不弹框、不开任务、不抛**（取消单列）：确认与进度条归调用方。`pool` 判事件
 * （「定稿」档），`planPool` 先排线（「剧情细纲」档，缺席用 `pool`）。
 */
export async function runThreadsBackfill(
  project: NovelProject,
  plan: ThreadsBackfillPlan,
  opts: {
    pool: Pick<ModelPool, 'run' | 'primaryBudget'>;
    planPool?: Pick<ModelPool, 'run' | 'primaryBudget'>;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<ThreadsBackfillOutcome> {
  const { signal, report } = opts;
  const out: ThreadsBackfillOutcome = { calls: 0, judged: [], results: [], left: [], partial: [], through: plan.through };
  const total = plan.chapters.length;
  if (plan.planFirst) {
    // 一条线都没有：先从情节大纲排一次（没排成不挡补记，失败挂在叙事线目录上，完成提示里说一句）。
    report({ message: '先从情节大纲排叙事线', current: 0, total });
    const planned = await planThreadsFromOutline(project, opts.planPool ?? opts.pool, signal);
    out.calls += planned.calls;
    out.planned = planned;
    if (planned.cancelled) {
      out.cancelled = true;
      out.left = plan.chapters.map((c) => c.order);
      return out;
    }
  }
  for (let i = 0; i < total; i++) {
    const chapter = plan.chapters[i];
    if (signal.aborted) {
      out.cancelled = true;
      out.left = plan.chapters.slice(i).map((c) => c.order);
      break;
    }
    report({ message: `第 ${chapter.order} 章《${chapter.title}》`, current: i, total });
    try {
      const step = await judgeChapterThreads(project, chapter, opts.pool, { signal, from: 'backfill' });
      out.calls += step.calls;
      if (step.threadsError || !step.threads) {
        // 一章没判成就停（⚑）：后一章要看前一章，系统性的失败也不白调后面几十章。失败已经挂在这一章上。
        out.failed = { no: chapter.order, reason: step.threadsError ?? '没有结果' };
        out.left = plan.chapters.slice(i + 1).map((c) => c.order);
        break;
      }
      out.judged.push(chapter.order);
      out.results.push(step.threads);
      const th = step.threads;
      if (th.progressError || th.mergeError || th.unwritten.length > 0) {
        out.partial.push(chapter.order);
      }
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        out.cancelled = true;
        out.left = plan.chapters.slice(i).map((c) => c.order);
        break;
      }
      throw err;
    }
  }
  report({ message: '收尾', current: total, total });
  out.through = (await project.readThreadsMark()).through;
  return out;
}

/**
 * 补记的完成提示（第 2 条：说清楚）：「叙事线补记：判了 5 章（第 1–5 章），记下 12 个事件，新认出 2 条线、3 条伏笔；叙事线判到第
 * 5 章」，先排线的、没判成停在哪一章、后面几章没判、跳过的、没收的记录、没写上的当前进度跟在后面。
 */
export function describeBackfill(o: ThreadsBackfillOutcome, plan: Pick<ThreadsBackfillPlan, 'skipped' | 'current'>, rel: string): string {
  const sum = (f: (r: ThreadsOutcome) => number): number => o.results.reduce((n, r) => n + f(r), 0);
  const events = sum((r) => r.recorded.length);
  const lines = sum((r) => r.newThreads.length);
  const fores = sum((r) => r.newForeshadowing.length);
  const dropped = sum((r) => r.dropped.length);
  const unwritten = sum((r) => r.unwritten.length);
  const found = [lines > 0 ? `${lines} 条线` : '', fores > 0 ? `${fores} 条伏笔` : ''].filter(Boolean).join('、');
  const head =
    o.judged.length > 0
      ? `判了 ${o.judged.length} 章（${describeChapterRuns(o.judged)}），${events > 0 ? `记下 ${events} 个事件` : '没有记下事件'}${found ? `，新认出 ${found}` : ''}`
      : '一章都没判';
  const planned = o.planned
    ? o.planned.error
      ? `先从情节大纲排线没排成（${o.planned.error}）`
      : o.planned.cancelled
        ? ''
        : `先从情节大纲${describePlanned(o.planned, rel).replace(/。$/, '')}`
    : '';
  const stop = o.failed
    ? `第 ${o.failed.no} 章没判成（${o.failed.reason}），停在那里${o.left.length > 0 ? `，后面 ${o.left.length} 章没判` : ''}；再点一次「从正文补记」从第 ${o.failed.no} 章接着判`
    : o.cancelled && o.left.length > 0
      ? `取消了，${describeChapterRuns(o.left)}没判`
      : '';
  const parts = [
    planned,
    `叙事线补记：${head}`,
    stop,
    plan.skipped.length > 0 ? `${describeChapterRuns(plan.skipped.map((s) => s.no))}没判（${[...new Set(plan.skipped.map((s) => s.why))].join('、')}；先定稿，定稿时会一并判）` : '',
    o.partial.length > 0 ? `${describeChapterRuns(o.partial)}的当前进度或归并没成（挂了黄 ❗）` : '',
    dropped > 0 ? `另有 ${dropped} 条叙事线的记录没有收（见日志）` : '',
    unwritten > 0 ? `${unwritten} 条线的当前进度没写上（见日志）` : '',
    o.through >= plan.current ? `叙事线判到第 ${o.through} 章，跟上了定稿` : `叙事线判到第 ${o.through} 章（定稿到第 ${plan.current} 章）`,
  ];
  return `${parts.filter(Boolean).join('；')}。`;
}

/**
 * 工程页「从正文补记」与 agent 的 `extract threadsFromText`：先问一句（章数与次数），再按章串行补记。返回实际调用次数（取消、没有
 * 要补的章时是 0）。
 */
export async function backfillThreads(project: NovelProject): Promise<number> {
  const host = getHost();
  project.invalidate();
  const plan = await planThreadsBackfill(project);
  if (plan.chapters.length === 0) {
    host.toast(
      plan.skipped.length > 0
        ? `没有可以补记的章：${describeChapterRuns(plan.skipped.map((s) => s.no))}${[...new Set(plan.skipped.map((s) => s.why))].join('或')}——先定稿，定稿时会一并判叙事线。`
        : plan.current === 0
          ? '还没有定稿过的章：叙事线是定稿时判的，先定稿。'
          : `叙事线已经判到第 ${plan.through} 章、跟上了定稿，没有要补记的。要重判哪一章，重新定稿那一章。`
    );
    return 0;
  }
  const n = plan.chapters.length;
  const where = describeChapterRuns(plan.chapters.map((c) => c.order));
  const rel = project.relPath(project.threadsDir);
  const answer = await askCall({
    message:
      `从已写正文补记叙事线：${where}定稿过、叙事线还没判，逐章认这一章在叙事线上发生了什么（每章 ${THREADS_JUDGE_CALLS.low}–${THREADS_JUDGE_CALLS.high} 次）` +
      `${plan.planFirst ? '；还没有一条叙事线，先从情节大纲排一次（1 次）' : ''}，${describeCalls(plan.calls)}。现在补记？`,
    actions: ['开始补记'],
    detail: [
      `共 ${n} 章，按章号一章一章往后判（后一章要看前一章记下的事件与新认出的线），可以随时停下，已经判过的留着；一章没判成就停在那里，再点一次从那一章接着判。`,
      `每章：${THREADS_JUDGE_CALLS.why}。只往 ${rel}/ 里追加带原文证据的事件、正文里认出的新线与新伏笔；当前进度由机器维护，你改过的不写；已有的一个字不动。`,
      plan.planFirst ? '还没有一条叙事线：先从情节大纲排一次（1 次，算在上面的数里；没排成不挡补记，线照样能从正文里认出来）。' : '',
      plan.skipped.length > 0
        ? `${plan.skipped.map((s) => `第 ${s.no} 章${s.why}`).slice(0, 8).join('、')}${plan.skipped.length > 8 ? ` 等 ${plan.skipped.length} 章` : ''}，这一次不判——先定稿，定稿时会一并判。`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: plan.planFirst ? ['plotOutline', 'plotSummary'] : ['plotSummary'],
    // 认事件带几条线、几条伏笔随详细度（`recordThreads`）。
    contextDetail: true,
  });
  if (answer?.action !== '开始补记') {
    log.info('作者没有开始从已写正文补记叙事线');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!pool) {
      log.error('没有可用的模型，从已写正文补记叙事线中止');
      return 0;
    }
    const planPool = plan.planFirst ? ((await createModelPool({ task: 'plotOutline', concurrent: false })) ?? pool) : undefined;
    log.info('开始从已写正文补记叙事线', `${where}｜${pool.label}`);
    let calls = 0;
    await runTask(
      BACKFILL_TASK,
      async ({ signal, report }) => {
        const startedAt = Date.now();
        const o = await runThreadsBackfill(project, plan, { pool, planPool, signal, report });
        calls = o.calls;
        const text = describeBackfill(o, plan, rel);
        log.info('从已写正文补记叙事线结束', `${text}｜调用 ${o.calls} 次，总耗时 ${elapsed(startedAt)}`);
        if (o.cancelled && o.judged.length === 0) {
          return;
        }
        host.toast(text, o.failed ? 'error' : 'info');
      },
      { scope: '叙事线' }
    );
    return calls;
  });
}
