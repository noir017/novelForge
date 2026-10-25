/**
 * 从正文补推、重推故事时间（2026-10-24，设计见 docs/design/plans/2026-10-24-story-timeline.md「二」，同日重做见
 * docs/design/plans/2026-10-24-story-timeline-rework.md「四」）：同步时单独一次推的是那一章；这里一批一批补上、重来。
 *
 * ```
 * 第 a–a+4 章（一批，最多 5 章，按字数切）→ 写 1 次、转写 1–2 次（features/storyTime.ts 的 judgeTimes）→ 写进 threads/时间线.md → 下一批 → ……
 * ```
 *
 * - **补推**（`fill`）：同步过、正文没再改过、时间线里还没有这一行（或还是机器写的 `+?`〔推不出〕）的章。重做之后**不再要求叙事线
 *   判过**（作者定的第 4 条）：时间和叙事线各算各的，「从正文补记叙事线」也不再顺带推时间。
 * - **重推**（`refresh`）：同步过、正文没再改过、这一行不是作者写的章（没有的、机器写的），可以只要一段（`range`）。机器写的行照新推的换，
 *   作者写的、认不出的一行不动（第 28 条）。v0.2.6 推坏的那些用它重来。
 * - **串行**：后一批要看前一批推出来的「前面几章的时间」。
 * - **一批没成就停**（同补记 ⚑10）：已写的留着，失败挂在时间线文件上（第 16 条），再点一次从那一章接着；都成了才清。
 * - 走「定稿」档（`plotSummary`）的池，同同步；转写（2026-10-25 起）走「转写」那一档。不带思考深度（第 26 条）。开跑前存存档点。不给外部 agent（⚑8：MCP 的同步本来就推，这两样是
 *   工程页上的维护动作）。
 *
 * 入口：工程页「叙事线」页签「时间线」组——标题旁「补推时间」「重推」、右键一章「重推这一章」「从这一章起重推」。
 */
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { CallEstimate, describeCalls } from '../model/pipeline';
import { describeChapterRuns } from '../model/threadFile';
import { TimelineEntry, TimelineWriteMode, isMachineEntry } from '../model/timelineFile';
import { withCallChoice } from '../runtime/callScope';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { askCall } from './askCall';
import { checkpointBefore } from './checkpoint';
import { TIME_CHAPTER_CHARS, judgeTimes, timeCallsOf } from './storyTime';
import { poolTranscriber } from './poolIO';
import { TranscribeCall } from './transcribe';

const log = scoped('故事时间');

/** 补推的任务名：前端看它在不在跑（media/src/view/project/threads.ts 一字不差）。 */
export const TIMELINE_BACKFILL_TASK = '从正文补推故事时间';
/** 重推的任务名（同上）。 */
export const TIMELINE_REFRESH_TASK = '重推故事时间';
/** 失败记录的 op：补推、重推一批没成（挂在时间线文件上）。 */
export const TIMELINE_BACKFILL_OP = 'timelineBackfill';
/** 一批最多几章（⚑7）。 */
export const TIME_BATCH_CHAPTERS = 5;
/** 一批最多多少字的正文（按章的字数切批；确认框报的次数就按它算）。 */
export const TIME_BATCH_CHARS = 24000;

/** 推哪几章（零调用，{@link planTimeline}）。 */
export interface TimelinePlan {
  mode: TimelineWriteMode;
  /** 要推的章，按章号切好批。 */
  batches: Chapter[][];
  /** 其中时间线里已经有、会照新推的换掉的机器行（重推）。 */
  replacing: number[];
  /** 时间线里是作者写的、这一次不碰的章（重推；认不出的行也算作者的）。 */
  authored: number[];
  /** 时间线里没有（或要换）、这一次推不了的章：同步之后正文又改过。 */
  stale: number[];
  calls: CallEstimate;
}

/** 推 `batches` 批：一批写 1 次、转写模型照抄成 JSON 1 次（2026-10-25 起），转写不合格重转 1 次。 */
export function timelineBatchCalls(batches: number): CallEstimate {
  return { low: 2 * batches, high: 2 * batches, max: 3 * batches, why: '每批写 1 次、转写模型照抄成 JSON 1 次；转写不合格重转 1 次' };
}

/** 按章号切批：最多 {@link TIME_BATCH_CHAPTERS} 章、合计不超过 {@link TIME_BATCH_CHARS} 字（一章本身太长的单独一批）；不连号的地方断开。 */
export function batchTimeChapters(chapters: readonly Chapter[]): Chapter[][] {
  const batches: Chapter[][] = [];
  let cur: Chapter[] = [];
  let chars = 0;
  for (const c of chapters) {
    const size = Math.min(c.wordCount, TIME_CHAPTER_CHARS);
    const gap = cur.length > 0 && c.order !== cur[cur.length - 1].order + 1;
    if (cur.length > 0 && (gap || cur.length >= TIME_BATCH_CHAPTERS || chars + size > TIME_BATCH_CHARS)) {
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

/**
 * 要推哪几章。`fill`：没有这一行、或还是机器写的 `+?`〔推不出〕；`refresh`：没有这一行、或是机器写的（`range` 之内）。都只要同步过、
 * 正文没再改过的章。同号的正文有两份时认路径排序第一份（与补记、总览同一个口径）。
 */
export async function planTimeline(
  project: NovelProject,
  mode: TimelineWriteMode,
  range: { from?: number; to?: number } = {}
): Promise<TimelinePlan> {
  const [all, book] = await Promise.all([project.listChapters(), project.readThreads()]);
  const timeline = book.timeline;
  const lines = new Map<number, TimelineEntry>((timeline?.entries ?? []).map((e) => [e.chapter, e]));
  const bad = new Set(timeline?.bad ?? []);
  const byNo = new Map<number, Chapter>();
  for (const c of all) {
    if (!byNo.has(c.order)) {
      byNo.set(c.order, c);
    }
  }
  const fresh: Chapter[] = [];
  const replacing: number[] = [];
  const authored: number[] = [];
  const stale: number[] = [];
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    if ((range.from !== undefined && no < range.from) || (range.to !== undefined && no > range.to)) {
      continue;
    }
    const chapter = byNo.get(no)!;
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash) {
      continue;
    }
    const line = lines.get(no);
    let wanted: boolean;
    if (bad.has(no) || (line && !isMachineEntry(line))) {
      wanted = false;
      if (mode === 'refresh') {
        authored.push(no);
      }
    } else if (!line) {
      wanted = true;
    } else {
      wanted = mode === 'refresh' || line.value.kind === 'unknown';
    }
    if (!wanted) {
      continue;
    }
    if (plot.sourceHash !== chapter.contentHash) {
      stale.push(no);
      continue;
    }
    fresh.push(chapter);
    if (line) {
      replacing.push(no);
    }
  }
  const batches = batchTimeChapters(fresh);
  return { mode, batches, replacing: mode === 'refresh' ? replacing : [], authored, stale, calls: timelineBatchCalls(batches.length) };
}

/** {@link runTimeline} 的结果。 */
export interface TimelineRunOutcome {
  calls: number;
  /** 写进时间线的章（推出来了的、推不出记了 `+?` 的都算）。 */
  written: number[];
  /** 其中推不出的章（记了 `+?`）。 */
  unknown: number[];
  /** 其中正文写明了日子的章。 */
  dated: number[];
  /** 模型漏了的章（这一批里没给它的那一项），再点一次会补。 */
  missed: number[];
  /** 停在这一批：调用没成（失败挂在时间线文件上）。 */
  failed?: { from: number; reason: string };
  cancelled?: boolean;
  /** 停下时还没走到的章。 */
  left: number[];
}

/** 按 {@link planTimeline} 的结果一批一批推。**不弹框、不开任务、不抛**（取消单列）：确认与进度条归调用方。 */
export async function runTimeline(
  project: NovelProject,
  plan: TimelinePlan,
  opts: {
    pool: Pick<ModelPool, 'run' | 'primaryBudget'>;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
    /** 转写那一次怎么调（2026-10-25 起）。缺省走「转写」那一档，那一档没有可用的模型时用 `pool`。 */
    transcribe?: TranscribeCall;
  }
): Promise<TimelineRunOutcome> {
  const { signal, report, pool } = opts;
  const transcribe = opts.transcribe ?? poolTranscriber(signal, pool);
  const out: TimelineRunOutcome = { calls: 0, written: [], unknown: [], dated: [], missed: [], left: [] };
  const rel = project.relPath(project.timelinePath);
  const verb = plan.mode === 'refresh' ? '重推' : '补推';
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
    try {
      // 「前面几章的时间」按此刻盘上的时间线算：前一批刚写进去的也算上（judgeTimes 里读）。
      const { results, calls } = await judgeTimes(project, batch, {
        run: (what, fn) => pool.run(what, fn),
        budget: pool.primaryBudget,
        signal,
        transcribe,
        mode: plan.mode,
        label: `${verb}时间 · ${where}`,
      });
      out.calls += calls;
      for (const r of results) {
        if (r.missing || !r.entry) {
          out.missed.push(r.chapter);
        } else if (r.action !== 'kept') {
          out.written.push(r.chapter);
          if (r.entry.value.kind === 'unknown' && !r.entry.dateMark) {
            out.unknown.push(r.chapter);
          }
          if (r.entry.dateMark) {
            out.dated.push(r.chapter);
          }
        }
      }
    } catch (err) {
      // 请求发出去了钱就花了：读不出来的带着写与转写的实数，别的错（取消、网络）算写的那 1 次。
      out.calls += timeCallsOf(err);
      if (err instanceof CancelledError || signal.aborted) {
        out.cancelled = true;
        out.left = rest();
        break;
      }
      // 一批没成就停：后一批要看这一批的结果，系统性的失败也不白调后面几十章。
      const reason = describeError(err);
      out.failed = { from: batch[0].order, reason };
      out.left = rest();
      log.warn(`${verb}故事时间停在${where}：${reason}`, err);
      await recordFailure(project, {
        scope: '叙事线',
        targetKind: 'threads',
        targetKey: rel,
        severity: 'error',
        op: TIMELINE_BACKFILL_OP,
        message: `${verb}故事时间停在第 ${batch[0].order} 章：${reason}`,
        detail: `已经推出来的留在时间线里。在叙事线页签「时间线」组再点一次「${plan.mode === 'refresh' ? '重推' : '补推时间'}」，会从这一章接着推。`,
      });
      break;
    }
  }
  report({ message: '收尾', current: total, total });
  if (!out.failed && !out.cancelled) {
    await clearFailures(project, 'threads', rel, TIMELINE_BACKFILL_OP);
  }
  return out;
}

/**
 * 完成提示（第 2 条：说清楚）：「补推故事时间：推了 12 章（第 1–12 章），其中第 4 章正文写明了日子，第 7、9 章推不出（按紧接上一章算，
 * 可以在时间线组里改）」，模型漏了的、停在哪、跳过的跟在后面。
 */
export function describeTimelineRun(o: TimelineRunOutcome, plan: Pick<TimelinePlan, 'mode' | 'stale' | 'authored'>): string {
  const verb = plan.mode === 'refresh' ? '重推' : '补推';
  const parts = [
    `${verb}故事时间：${o.written.length > 0 ? `推了 ${o.written.length} 章（${describeChapterRuns(o.written)}）` : '一章都没写进去'}`,
    o.dated.length > 0 ? `其中${describeChapterRuns(o.dated)}正文写明了日子，按它对齐` : '',
    o.unknown.length > 0 ? `${describeChapterRuns(o.unknown)}推不出，按紧接上一章算，可以在时间线组里改` : '',
    o.missed.length > 0 ? `模型漏了${describeChapterRuns(o.missed)}，再点一次补上` : '',
    o.failed
      ? `第 ${o.failed.from} 章那一批没成（${o.failed.reason}），停在那里${o.left.length > 0 ? `，${describeChapterRuns(o.left)}没推` : ''}；再点一次接着推`
      : o.cancelled && o.left.length > 0
        ? `取消了，${describeChapterRuns(o.left)}没推`
        : '',
    plan.authored.length > 0 ? `${describeChapterRuns(plan.authored)}是你定的，没动` : '',
    plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过，没推（同步时会一起推）` : '',
  ];
  return `${parts.filter(Boolean).join('；')}。`;
}

/** 工程页「补推时间」：先问一句（章数与次数），再按批串行补推。返回实际调用次数。 */
export async function backfillTimeline(project: NovelProject): Promise<number> {
  return timelineAction(project, 'fill');
}

/**
 * 工程页「重推」（2026-10-24 重做）：`range` 缺席是全部，右键一章「重推这一章」是 `{ from: n, to: n }`、「从这一章起重推」是第 n 章到
 * 时间线组里的最后一章。
 * 先问一句（章数、会换掉几行、你写的几行不动、次数），再按批串行重推。返回实际调用次数。
 */
export async function refreshTimeline(project: NovelProject, range: { from?: number; to?: number } = {}): Promise<number> {
  return timelineAction(project, 'refresh', range);
}

async function timelineAction(project: NovelProject, mode: TimelineWriteMode, range: { from?: number; to?: number } = {}): Promise<number> {
  const host = getHost();
  project.invalidate();
  const plan = await planTimeline(project, mode, range);
  const chapters = plan.batches.flat();
  const verb = mode === 'refresh' ? '重推' : '补推';
  const scope =
    range.from === undefined ? '' : range.to === range.from ? `第 ${range.from} 章` : range.to !== undefined ? `第 ${range.from}–${range.to} 章` : `第 ${range.from} 章起`;
  if (chapters.length === 0) {
    const why = [
      plan.authored.length > 0 ? `${describeChapterRuns(plan.authored)}是你定的（机器不动）` : '',
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过（先同步，同步时会一起推）` : '',
    ].filter(Boolean);
    host.toast(
      why.length > 0
        ? `${scope}没有可以${verb}时间的章：${why.join('；')}。`
        : mode === 'refresh'
          ? `${scope}没有同步过的章可以重推。`
          : '同步过的章在时间线里都有了，没有要补推的。要重来，点「重推」。'
    );
    return 0;
  }
  const where = describeChapterRuns(chapters.map((c) => c.order));
  const rel = project.relPath(project.timelinePath);
  const action = mode === 'refresh' ? '开始重推' : '开始补推';
  const answer = await askCall({
    message:
      mode === 'refresh'
        ? `重推故事时间：${where}，按章号几章一批重新判每章比上一章晚几天、章里跳了几天、正文写明的日子，${describeCalls(plan.calls)}。现在重推？`
        : `从正文补推故事时间：${where}同步过，时间线里还没有它们（或还推不出）。按章号几章一批判每章比上一章晚几天，${describeCalls(plan.calls)}。现在补推？`,
    actions: [action],
    detail: [
      `共 ${chapters.length} 章，分 ${plan.batches.length} 批（一批最多 ${TIME_BATCH_CHAPTERS} 章），按章号一批一批往后推（后一批要看前一批推出来的时间），可以随时停下，已经推出来的留着；一批没成就停在那里，再点一次从那里接着推。`,
      mode === 'refresh'
        ? `会换掉 ${plan.replacing.length} 行机器写的（行尾带〔依据〕〔推测〕〔推不出〕的）${plan.authored.length > 0 ? `；${describeChapterRuns(plan.authored)}是你定的，一个字不动` : ''}。你改过值、却还留着行尾那一段的行分不出是你改的，也会被换——想保住就删掉行尾那一段，或者在时间线组里右键「改时间」。开跑前先存一个存档点。`
        : `只往 ${rel} 里填空：没有的写上，推不出的「+?」重推；你写的行一个字不动。`,
      '日期按 start 现算，在叙事线页签与总览里看。',
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之后正文又改过，这一次不推——先同步，同步时会一起推。` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: ['plotSummary', 'transcribe'],
    // 只送正文、前面几章的时间与上一章的结尾，不看上下文详细度。
    contextDetail: false,
  });
  if (answer?.action !== action) {
    log.info(`作者没有开始${verb}故事时间`);
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!pool) {
      log.error(`没有可用的模型，${verb}故事时间中止`);
      return 0;
    }
    log.info(`开始${verb}故事时间`, `${where}｜${plan.batches.length} 批｜${pool.label}`);
    let calls = 0;
    await runTask(
      mode === 'refresh' ? TIMELINE_REFRESH_TASK : TIMELINE_BACKFILL_TASK,
      async ({ signal, report }) => {
        await checkpointBefore(project, `${verb}故事时间之前（${where}）`);
        const startedAt = Date.now();
        const o = await runTimeline(project, plan, { pool, signal, report });
        calls = o.calls;
        const text = describeTimelineRun(o, plan);
        log.info(`${verb}故事时间结束`, `${text}｜调用 ${o.calls} 次，总耗时 ${elapsed(startedAt)}`);
        if (o.cancelled && o.written.length === 0) {
          return;
        }
        host.toast(text, o.failed ? 'error' : 'info');
      },
      { scope: '故事时间' }
    );
    return calls;
  });
}
