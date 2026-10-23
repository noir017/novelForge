/**
 * 从正文补推故事时间（2026-10-24，设计见 docs/design/plans/2026-10-24-story-timeline.md「二」）：故事时间是同步时并进认事件那一次
 * 推的；本稿之前就判过叙事线的章（水位以内的、另外判过的）不会再走认事件，时间线里没有它们。这里把它们补上。
 *
 * ```
 * 第 a–a+4 章（一批，最多 5 章，按字数切）→ 1 次：每章比上一章晚几天 → 只填空写进 threads/时间线.md → 下一批 → ……
 * ```
 *
 * - **范围**（⚑6）：定稿过、正文没再改过、**叙事线判过**、时间线里还没有这一章那一行的章。叙事线还没判的章不归这里管——
 *   「从正文补记」走认事件，会一起推时间，省得同一章花两次钱。
 * - **串行**：后一批要看前一批推出来的「上一章的时间」。
 * - **一批没成就停**（同补记 ⚑10）：已写的留着，失败挂在时间线文件上（第 16 条），再点一次从那一章接着补；都成了才清。
 * - 走「定稿」档（`plotSummary`）的池，同补记。不带思考深度（第 26 条）。不给外部 agent（⚑7：一次性的补课，补记已经顺带推时间）。
 *
 * 入口：工程页「叙事线」页签「时间线」那一行有「还没推」时，标题旁的「补推时间」与右键。
 */
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { CallEstimate, describeCalls } from '../model/pipeline';
import { describeChapterRuns, isThreadsJudged } from '../model/threadFile';
import { TimelineEntry, previousTimeNote, verifyTime } from '../model/timelineFile';
import { takeHead } from '../context/tokenizer';
import { withCallChoice } from '../runtime/callScope';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { askCall } from './askCall';
import { checkpointBefore } from './checkpoint';
import { TIME_BACKFILL_SYSTEM } from './threadsPrompt';
import { askJsonObject, writeTimeEntry } from './threads';

const log = scoped('叙事线');

/** 补推的任务名：前端看它在不在跑（media/src/view/project/threads.ts 一字不差）。 */
export const TIMELINE_BACKFILL_TASK = '从正文补推故事时间';
/** 失败记录的 op：补推一批没成（挂在时间线文件上）。 */
export const TIMELINE_BACKFILL_OP = 'timelineBackfill';
/** 一批最多几章（⚑7）。 */
export const TIME_BATCH_CHAPTERS = 5;
/** 一批最多多少字的正文（按章的字数切批；确认框报的次数就按它算）。 */
export const TIME_BATCH_CHARS = 24000;
/** 一章最多送多少字（时间线索多在开头，放不下截尾，证据仍对整章校验）。 */
export const TIME_CHAPTER_CHARS = 12000;

/** 补推要推哪几章（零调用，{@link planTimelineBackfill}）。 */
export interface TimelineBackfillPlan {
  /** 要推的章，按章号切好批。 */
  batches: Chapter[][];
  /** 叙事线判过、时间线里没有、这一次推不了的章（同步之后正文又改过）。 */
  stale: number[];
  /** 定稿过、叙事线还没判的章：交给「从正文补记」（会一起推时间）。 */
  unjudged: number[];
  calls: CallEstimate;
}

/** 补推 `batches` 批：一批 1 次。 */
export function timelineBackfillCalls(batches: number): CallEstimate {
  return { low: batches, high: batches, max: batches };
}

/** 按章号切批：最多 {@link TIME_BATCH_CHAPTERS} 章、合计不超过 {@link TIME_BATCH_CHARS} 字（一章本身太长的单独一批）。 */
export function batchTimeChapters(chapters: readonly Chapter[]): Chapter[][] {
  const batches: Chapter[][] = [];
  let cur: Chapter[] = [];
  let chars = 0;
  for (const c of chapters) {
    const size = Math.min(c.wordCount, TIME_CHAPTER_CHARS);
    if (cur.length > 0 && (cur.length >= TIME_BATCH_CHAPTERS || chars + size > TIME_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += size;
  }
  if (cur.length > 0) {
    batches.push(cur);
  }
  return batches;
}

/** 要补推哪几章。同号的正文有两份时认路径排序第一份（与补记、总览同一个口径）。 */
export async function planTimelineBackfill(project: NovelProject): Promise<TimelineBackfillPlan> {
  const [all, mark, book] = await Promise.all([project.listChapters(), project.readThreadsMark(), project.readThreads()]);
  const timeline = book.timeline;
  const written = new Set([...(timeline?.entries.map((e) => e.chapter) ?? []), ...(timeline?.bad ?? [])]);
  const byNo = new Map<number, Chapter>();
  for (const c of all) {
    if (!byNo.has(c.order)) {
      byNo.set(c.order, c);
    }
  }
  const fresh: Chapter[] = [];
  const stale: number[] = [];
  const unjudged: number[] = [];
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    const chapter = byNo.get(no)!;
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash || written.has(no)) {
      continue;
    }
    if (!isThreadsJudged(mark, no)) {
      unjudged.push(no);
    } else if (plot.sourceHash === chapter.contentHash) {
      fresh.push(chapter);
    } else {
      stale.push(no);
    }
  }
  const batches = batchTimeChapters(fresh);
  return { batches, stale, unjudged, calls: timelineBackfillCalls(batches.length) };
}

/** {@link runTimelineBackfill} 的结果。 */
export interface TimelineBackfillOutcome {
  calls: number;
  /** 写进时间线的章（推出来了的、推不出记了 `+?` 的都算）。 */
  written: number[];
  /** 其中推不出的章（记了 `+?`）。 */
  unknown: number[];
  /** 模型漏了的章（这一批里没给它的那一项），再点一次会补。 */
  missed: number[];
  /** 停在这一批：调用没成（失败挂在时间线文件上）。 */
  failed?: { from: number; reason: string };
  cancelled?: boolean;
  /** 停下时还没走到的章。 */
  left: number[];
}

/**
 * 按 {@link planTimelineBackfill} 的结果补推。**不弹框、不开任务、不抛**（取消单列）：确认与进度条归调用方。
 */
export async function runTimelineBackfill(
  project: NovelProject,
  plan: TimelineBackfillPlan,
  opts: {
    pool: Pick<ModelPool, 'run' | 'primaryBudget'>;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<TimelineBackfillOutcome> {
  const { signal, report, pool } = opts;
  const out: TimelineBackfillOutcome = { calls: 0, written: [], unknown: [], missed: [], left: [] };
  const rel = project.relPath(project.timelinePath);
  const total = plan.batches.length;
  for (let i = 0; i < total; i++) {
    const batch = plan.batches[i];
    const rest = () => plan.batches.slice(i).flat().map((c) => c.order);
    if (signal.aborted) {
      out.cancelled = true;
      out.left = rest();
      break;
    }
    const where = describeChapterRuns(batch.map((c) => c.order));
    report({ message: where, current: i, total });
    // 上一章的时间按此刻盘上的时间线算：前一批刚写进去的也算上。
    const timeline = (await project.readThreads()).timeline;
    const texts = await Promise.all(batch.map((c) => project.readChapterText(c)));
    const budget = Math.max(2000, pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 1500);
    const perChapter = Math.floor(budget / batch.length);
    const body = batch
      .map((c, k) => {
        const head = [...texts[k]].slice(0, TIME_CHAPTER_CHARS).join('');
        const cut = takeHead(head, perChapter);
        if (cut.length < texts[k].length) {
          log.info(`第 ${c.order} 章正文较长，补推时间时只送了开头一截`, `${texts[k].length} 字 → ${cut.length} 字`);
        }
        return `【第${c.order}章 ${c.title}】\n\n${cut}`;
      })
      .join('\n\n');
    const user = [
      `【这一批之前那一章的时间】\n${timeline ? previousTimeNote(timeline, batch[0].order) : '前面的章还没记时间。'}`,
      body,
      `请给第 ${batch.map((c) => c.order).join('、')} 章各判一次时间，按要求输出 JSON。`,
    ].join('\n\n');
    let answer: Record<string, unknown>;
    try {
      out.calls += 1;
      answer = await askJsonObject(
        { run: (what, fn) => pool.run(what, fn), budget: pool.primaryBudget, signal },
        `补推时间 · ${where}`,
        TIME_BACKFILL_SYSTEM,
        user,
        0.2,
        '故事时间'
      );
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        out.cancelled = true;
        out.left = rest();
        break;
      }
      // 一批没成就停：后一批要看这一批的结果，系统性的失败也不白调后面几十章。
      const reason = describeError(err);
      out.failed = { from: batch[0].order, reason };
      out.left = rest();
      log.warn(`补推故事时间停在${where}：${reason}`, err);
      await recordFailure(project, {
        scope: '叙事线',
        targetKind: 'threads',
        targetKey: rel,
        severity: 'error',
        op: TIMELINE_BACKFILL_OP,
        message: `从正文补推故事时间停在第 ${batch[0].order} 章：${reason}`,
        detail: '已经推出来的留在时间线里。在叙事线页签再点一次「补推时间」，会从这一章接着推。',
      });
      break;
    }
    const list = Array.isArray(answer.times) ? answer.times : [];
    const byNo = new Map<number, unknown>();
    for (const item of list) {
      const no = item && typeof item === 'object' ? Number((item as Record<string, unknown>).chapter) : NaN;
      if (Number.isInteger(no) && !byNo.has(no)) {
        byNo.set(no, item);
      }
    }
    // 一章一章按章号写（只填空）：写之前那一刻重读，作者这几十秒里写下的行不动。
    for (let k = 0; k < batch.length; k++) {
      const c = batch[k];
      const verified = verifyTime(byNo.get(c.order), { chapter: c.order, text: texts[k] });
      if (!verified) {
        out.missed.push(c.order);
        continue;
      }
      if (verified.notes.length > 0) {
        log.info(`第 ${c.order} 章的时间：校验时改过`, verified.notes.join('\n'));
      }
      const action = await writeTimeEntry(project, verified.entry, texts[k]);
      if (action !== 'kept') {
        out.written.push(c.order);
        if (isUnknown(verified.entry)) {
          out.unknown.push(c.order);
        }
      }
    }
  }
  report({ message: '收尾', current: total, total });
  if (!out.failed && !out.cancelled) {
    await clearFailures(project, 'threads', rel, TIMELINE_BACKFILL_OP);
  }
  return out;
}

function isUnknown(e: TimelineEntry): boolean {
  return e.value.kind === 'unknown';
}

/**
 * 补推的完成提示（第 2 条：说清楚）：「补推故事时间：推了 12 章（第 1–12 章），其中 3 章推不出（第 4、7、9 章，按紧接上一章算，
 * 可以在时间线里补）」，模型漏了的、停在哪、跳过的跟在后面。
 */
export function describeTimelineBackfill(o: TimelineBackfillOutcome, plan: Pick<TimelineBackfillPlan, 'stale' | 'unjudged'>): string {
  const parts = [
    `补推故事时间：${o.written.length > 0 ? `推了 ${o.written.length} 章（${describeChapterRuns(o.written)}）` : '一章都没写进去'}`,
    o.unknown.length > 0 ? `其中 ${describeChapterRuns(o.unknown)}推不出，按紧接上一章算，可以在时间线里补` : '',
    o.missed.length > 0 ? `模型漏了${describeChapterRuns(o.missed)}，再点一次「补推时间」补上` : '',
    o.failed
      ? `第 ${o.failed.from} 章那一批没成（${o.failed.reason}），停在那里${o.left.length > 0 ? `，${describeChapterRuns(o.left)}没推` : ''}；再点一次接着推`
      : o.cancelled && o.left.length > 0
        ? `取消了，${describeChapterRuns(o.left)}没推`
        : '',
    plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过，没推（先同步，同步时会一起推）` : '',
    plan.unjudged.length > 0 ? `${describeChapterRuns(plan.unjudged)}叙事线还没判，「从正文补记」时会一起推` : '',
  ];
  return `${parts.filter(Boolean).join('；')}。`;
}

/** 工程页「补推时间」：先问一句（章数与次数），再按批串行补推。返回实际调用次数。 */
export async function backfillTimeline(project: NovelProject): Promise<number> {
  const host = getHost();
  project.invalidate();
  const plan = await planTimelineBackfill(project);
  const chapters = plan.batches.flat();
  if (chapters.length === 0) {
    const why = [
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过（先同步，同步时会一起推）` : '',
      plan.unjudged.length > 0 ? `${describeChapterRuns(plan.unjudged)}叙事线还没判（点「从正文补记」，会一起推时间）` : '',
    ].filter(Boolean);
    host.toast(why.length > 0 ? `没有可以补推时间的章：${why.join('；')}。` : '同步过的章在时间线里都有了，没有要补推的。要重推哪一章，删掉时间线里那一行再同步。');
    return 0;
  }
  const where = describeChapterRuns(chapters.map((c) => c.order));
  const rel = project.relPath(project.timelinePath);
  const answer = await askCall({
    message: `从正文补推故事时间：${where}同步过、叙事线也判过，时间线里还没有它们。按章号几章一批，判每章比上一章晚几天，${describeCalls(plan.calls)}。现在补推？`,
    actions: ['开始补推'],
    detail: [
      `共 ${chapters.length} 章，分 ${plan.batches.length} 批（一批最多 ${TIME_BATCH_CHAPTERS} 章），按章号一批一批往后推（后一批要看前一批推出来的时间），可以随时停下，已经推出来的留着；一批没成就停在那里，再点一次从那里接着推。`,
      `只往 ${rel} 里填空：一章一行「+N 天」与原文依据，推不出的记「+?」；你写的行一个字不动。日期按 start 现算，在叙事线页签与总览里看。`,
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过，这一次不推——先同步，同步时会一起推。` : '',
      plan.unjudged.length > 0 ? `${describeChapterRuns(plan.unjudged)}叙事线还没判，这一次不推——「从正文补记」时会一起推。` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: ['plotSummary'],
    // 只送正文与上一章的时间，不看上下文详细度。
    contextDetail: false,
  });
  if (answer?.action !== '开始补推') {
    log.info('作者没有开始补推故事时间');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!pool) {
      log.error('没有可用的模型，补推故事时间中止');
      return 0;
    }
    log.info('开始从正文补推故事时间', `${where}｜${plan.batches.length} 批｜${pool.label}`);
    let calls = 0;
    await runTask(
      TIMELINE_BACKFILL_TASK,
      async ({ signal, report }) => {
        await checkpointBefore(project, `补推故事时间之前（${where}）`);
        const startedAt = Date.now();
        const o = await runTimelineBackfill(project, plan, { pool, signal, report });
        calls = o.calls;
        const text = describeTimelineBackfill(o, plan);
        log.info('补推故事时间结束', `${text}｜调用 ${o.calls} 次，总耗时 ${elapsed(startedAt)}`);
        if (o.cancelled && o.written.length === 0) {
          return;
        }
        host.toast(text, o.failed ? 'error' : 'info');
      },
      { scope: '叙事线' }
    );
    return calls;
  });
}
