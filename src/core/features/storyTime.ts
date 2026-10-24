/**
 * 认时间（2026-10-24 重做，设计见 docs/design/plans/2026-10-24-story-timeline-rework.md「三」）：同步一章时单独一次（{@link recordChapterTime}），
 * 补推、重推几章一批（features/timelineBackfill.ts），都走 {@link judgeTimes}——同一份提示词（`TIME_SYSTEM`）、同一份输入。
 *
 * ```
 * 历法与起点 + 前面几章的时间（带结尾时段）+ 上一章的结尾约 1000 字 + 这一章（几章）的正文（太长截中间）+ 细纲记的时间地点
 *   ──▶ 1 次 ──▶ times[]：开头晚几天、章内几跳、结尾时段、正文写明的日子与季节
 *   ──▶ verifyTime（证据逐字）──▶ 写进 threads/时间线.md（同步、重推 refresh：机器写的行照新推的换；补推 fill：只填空；作者的行都不动）
 * ```
 *
 * - **和叙事线各算各的**：上一稿并在认事件那一次里，作者用下来推得不准（模型看不到上一章停在哪个时刻、正文写明的日子不收）。
 *   现在认事件没成不挡它，它没成也不挡叙事线：失败挂黄 ❗ 在章节上（op {@link TIME_OP}，第 16 条），细纲、叙事线照样算数。
 * - 走「定稿」档，同叙事线那一步。不带思考深度（第 26 条）。
 */
import { CancelledError } from '../llm/provider';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import {
  Timeline,
  TimelineEntry,
  TimelineWrite,
  TimelineWriteMode,
  describeTimeEntry,
  emptyTimeline,
  isMachineEntry,
  recentTimeNote,
  upsertTimelineEntry,
  verifyTime,
} from '../model/timelineFile';
import { estimateTokens, tokensToChars } from '../context/tokenizer';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { Workspace } from '../workspace';
import type { ModelRunner } from './finalizeSteps';
import { StepOpts, askJsonObject } from './threads';
import { TIME_SYSTEM } from './timePrompt';

const log = scoped('故事时间');

/** 失败记录的 op：同步时这一章的时间没推成（挂在章节上，黄 ❗）。 */
export const TIME_OP = 'timeline';
/** 上一章的结尾送多少字（本章开头接着哪个时刻，看这里）。 */
export const TIME_PREV_TAIL_CHARS = 1000;
/** 一章最多送多少字：太长的截中间、留头尾（⚑6：时间的线索在开头和结尾）。 */
export const TIME_CHAPTER_CHARS = 12000;
/** 截中间时开头留几成。 */
const HEAD_SHARE = 2 / 3;

/** 截中间、留头尾：`max` 个字以内原样，超了留前 2/3、后 1/3，中间说一句略去了多少字。 */
export function clipMiddle(text: string, max: number = TIME_CHAPTER_CHARS): string {
  const chars = [...text];
  if (chars.length <= max) {
    return text;
  }
  const head = Math.max(1, Math.round(max * HEAD_SHARE));
  const tail = Math.max(1, max - head);
  return `${chars.slice(0, head).join('').trimEnd()}\n\n……（中间略去 ${chars.length - head - tail} 字）……\n\n${chars.slice(-tail).join('').trimStart()}`;
}

/** 一段文字最后 `max` 个字，尽量从段落开头起。 */
function tailOf(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) {
    return chars.join('');
  }
  const slice = chars.slice(-max).join('');
  const br = slice.indexOf('\n');
  return (br >= 0 && br < slice.length * 0.3 ? slice.slice(br + 1) : slice).trimStart();
}

/** 历法与起点那一句。 */
function calendarNote(tl: Timeline): string {
  const cal = tl.calendar === '简单历' ? '简单历（每月 30 天、一年 12 个月）' : '公历（真实的月份长短与闰年）';
  return `${cal}；${tl.start ? `第 1 章开头是${tl.startText}。` : '没填起点，只按天数算。'}`;
}

/**
 * 认时间的输入（设计稿「三 · 输入」）：历法与起点、前面几章的时间（只看第一章之前的行）、上一章的结尾、这几章的正文与细纲记的
 * 时间地点。`budgetTokens` 是正文能用多少（几章平分，放不下的截中间）。
 */
export async function buildTimeInput(
  project: NovelProject,
  chapters: readonly Chapter[],
  texts: readonly string[],
  timeline: Timeline,
  budgetTokens: number
): Promise<string> {
  const first = chapters[0];
  const parts = [`【历法与起点】\n${calendarNote(timeline)}`, `【前面几章的时间】（程序按时间线推算的，帮你接上）\n${recentTimeNote(timeline, first.order)}`];
  if (first.order > 1) {
    const prev = await project.getChapter(first.order - 1);
    const prevText = prev ? (await project.readChapterText(prev)).trim() : '';
    if (prevText) {
      parts.push(`【第 ${first.order - 1} 章的结尾】（上一章最后一段：本章开头接着哪个时刻，看这里）\n${tailOf(prevText, TIME_PREV_TAIL_CHARS)}`);
    }
  }
  const fixed = estimateTokens(parts.join('\n\n'));
  const per = Math.max(500, Math.floor((budgetTokens - fixed) / chapters.length));
  const perChars = Math.min(TIME_CHAPTER_CHARS, tokensToChars(per));
  for (let k = 0; k < chapters.length; k++) {
    const c = chapters[k];
    const plot = await project.plotOfChapter(c);
    const timePlace = plot?.sections.时间地点?.replace(/\s+/gu, ' ').trim();
    const body = clipMiddle(texts[k], perChars);
    if (body.length < texts[k].length) {
      log.info(`第 ${c.order} 章正文较长，认时间时截了中间`, `${[...texts[k]].length} 字 → 约 ${perChars} 字（留头尾）`);
    }
    parts.push(`【第${c.order}章 ${c.title}】\n${timePlace ? `（细纲记的时间地点：${timePlace}）\n` : ''}\n${body}`);
  }
  parts.push(`请给第 ${chapters.map((c) => c.order).join('、')} 章各判一次时间，按要求输出 JSON。`);
  return parts.join('\n\n');
}

/** 一章的结果。 */
export interface TimeResult {
  chapter: number;
  /** 写进去的那一行（推不出记 `+?` 的也算）。模型没给这一章时缺席。 */
  entry?: TimelineEntry;
  action?: TimelineWrite;
  /** 没写：时间线里这一章是作者写的（`kept` 的一种）。 */
  authored?: true;
  /** 模型没给这一章。 */
  missing?: true;
}

/** 一行时间写进时间线。写之前那一刻重读（`updateThread`），覆盖前存历史版本（网关）。返回写成了什么样。 */
export async function writeTimeEntry(
  project: NovelProject,
  entry: TimelineEntry,
  chapterText: string,
  mode: TimelineWriteMode = 'fill'
): Promise<TimelineWrite> {
  let action: TimelineWrite = 'kept';
  await new Workspace(project).updateThread(project.relPath(project.timelinePath), (raw) => {
    const r = upsertTimelineEntry(raw, entry, chapterText, mode);
    action = r.action;
    return r.action === 'kept' ? undefined : r.text;
  });
  return action;
}

/**
 * 判这几章（按章号连续，一次调用）：读此刻盘上的时间线当「前面几章的时间」，调一次模型，逐章校验、按 `mode` 写盘。调用没成、
 * 解析不出来抛错（取消照样抛）；模型漏了的章记 `missing`。
 */
export async function judgeTimes(
  project: NovelProject,
  chapters: readonly Chapter[],
  opts: StepOpts & { mode: TimelineWriteMode; label: string }
): Promise<TimeResult[]> {
  const timeline = (await project.readThreads()).timeline ?? emptyTimeline(project.relPath(project.timelinePath));
  const texts = await Promise.all(chapters.map((c) => project.readChapterText(c)));
  const budget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - estimateTokens(TIME_SYSTEM) - 500);
  const user = await buildTimeInput(project, chapters, texts, timeline, budget);
  const answer = await askJsonObject(opts, opts.label, TIME_SYSTEM, user, 0.2, '故事时间');
  // 老的单章形状（`{"time":{…}}`）、模型把一项直接摊在最外层的，也认。
  const list = Array.isArray(answer.times) ? answer.times : answer.time ? [{ chapter: chapters[0].order, ...(answer.time as object) }] : [];
  const byNo = new Map<number, unknown>();
  for (const item of list) {
    const no = item && typeof item === 'object' ? Number((item as Record<string, unknown>).chapter) : NaN;
    if (Number.isInteger(no) && !byNo.has(no)) {
      byNo.set(no, item);
    }
  }
  if (chapters.length === 1 && byNo.size === 0 && list.length === 1) {
    byNo.set(chapters[0].order, list[0]);
  }
  const existing = new Map(timeline.entries.map((e) => [e.chapter, e]));
  const out: TimeResult[] = [];
  for (let k = 0; k < chapters.length; k++) {
    const c = chapters[k];
    const verified = verifyTime(byNo.get(c.order), { chapter: c.order, text: texts[k], calendar: timeline.calendar });
    if (!verified) {
      log.warn(`第 ${c.order} 章：模型没给这一章的时间，时间线里这一章没动`);
      out.push({ chapter: c.order, missing: true });
      continue;
    }
    if (verified.notes.length > 0) {
      log.info(`第 ${c.order} 章的时间：校验时改过`, verified.notes.join('\n'));
    }
    const action = await writeTimeEntry(project, verified.entry, texts[k], opts.mode);
    const before = existing.get(c.order);
    const authored = action === 'kept' && (timeline.bad.includes(c.order) || (before !== undefined && !isMachineEntry(before)));
    out.push({ chapter: c.order, entry: verified.entry, action, ...(authored ? { authored: true as const } : {}) });
  }
  return out;
}

/** {@link recordChapterTime} 的结果。 */
export interface TimeStep {
  /** 实际调了几次模型（没成也算那 1 次：请求发出去了）。 */
  calls: number;
  time?: TimeResult;
  /** 没推成（时间线没动）。 */
  timeError?: string;
}

/**
 * 同步一章时的「故事时间」那一步（单章定稿、立即同步、写完即定稿都经 finalizeSteps.ts）：1 次，机器写的行照新推的换（⚑7），作者的
 * 行不动。**不抛**（取消照样抛出去）：没成挂黄 ❗ 在章节上，成了清掉。
 */
export async function recordChapterTime(
  project: NovelProject,
  chapter: Chapter,
  runner: ModelRunner,
  opts: { signal?: AbortSignal } = {}
): Promise<TimeStep> {
  try {
    const [time] = await judgeTimes(project, [chapter], {
      run: (what, fn) => runner.run(what, fn),
      budget: runner.primaryBudget,
      signal: opts.signal,
      mode: 'refresh',
      label: `第 ${chapter.order} 章 · 故事时间`,
    });
    await clearFailures(project, 'chapter', chapter.relPath, TIME_OP);
    return { calls: 1, time };
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    const timeError = describeError(err);
    log.warn(`第 ${chapter.order} 章的故事时间没推成：${timeError}`, err);
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: TIME_OP,
      message: `细纲已照正文更新，但故事时间没推成：${timeError}`,
      detail: '时间线里这一章没动。重新同步这一章会再推一次；也可以在叙事线页签「时间线」组里右键这一章「重推这一章」。',
    });
    return { calls: 1, timeError };
  }
}

/** 完成提示里时间那一句（单章同步、立即同步的汇总）。没有就是空串。 */
export function describeTimeOutcome(o: Pick<TimeStep, 'time' | 'timeError'>): string {
  if (o.timeError) {
    return `故事时间没推成（${o.timeError}）`;
  }
  const t = o.time;
  if (!t) {
    return '';
  }
  if (t.missing || !t.entry) {
    return '模型没给这一章的时间（可以在叙事线页签的「时间线」组里重推这一章）';
  }
  return t.authored ? '时间线里这一章是你定的，没改' : describeTimeEntry(t.entry);
}
