import {
  THREAD_KINDS,
  ForeshadowState,
  Thread,
  ThreadBook,
  ThreadEvent,
  ThreadFileBase,
  ThreadsMark,
  describeChapterRuns,
  foreshadowingOf,
  isForeshadowClosed,
  isForeshadowEvent,
  isThreadsJudged,
  threadKey,
  threadStateAt,
  threadWatch,
  unjudgedChapters,
} from '../model/threadFile';
import {
  Timeline,
  TimelineCalc,
  TimelineDay,
  TimelineEntry,
  computeTimeline,
  dayLabel,
  describeDateMark,
  describeDay,
  describeDayRange,
  describeDelta,
  isMachineEntry,
  renderTimeValue,
  suggestStart,
  timelineIssues,
} from '../model/timelineFile';
import { ThreadReminder, isFallbackChapterTitle, threadRemindersFor } from '../model/pipeline';
import { NovelProject } from '../model/project';
import {
  ThreadLineView,
  ThreadUnfiledView,
  ThreadsOverview,
  ThreadsOverviewCell,
  ThreadsOverviewChapter,
  ThreadsOverviewChapterState,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewGroup,
  ThreadsOverviewLine,
  ThreadsOverviewSpan,
  ThreadsOverviewTime,
  ThreadsView,
  TimelineChapterView,
  TimelineGroupView,
  TimelineSegmentView,
} from '../protocol';
import { volumeOf } from './quickOpen';

/**
 * 叙事线一览（叙事线重做第 8 个提交，设计见 docs/design/plans/2026-10-20-narrative-threads.md「七、工程页」）：工程页
 * 「叙事线」页签那一列——一条线一行，作者一眼看出各条线走到哪、哪条断了、哪条伏笔该收了。
 *
 * - **纯函数、不调模型、不落盘**（第 18 条：状态一律从磁盘推导）。读盘由调用方做：工程页刷新时 `projectView.ts`
 *   把它那一趟 `readThreads()` 读到的整本交进来，同一次刷新里叙事线目录每份只读一次（`projectTreeReads` 钉着）。
 * - **「现在」是定稿到的最后一章**（定稿过的章里章号最大的那一章）：线上的实际事件都是定稿写进来的，拿「写到第几章」
 *   当现在的话，写了没定稿的那几章会让每条线都像断了。
 * - **一行怎么写由这里给**（与设定名录、出场人物同一个道理：文案只有一份），前端只渲染、只加 ⚠。
 *
 * 和 `views/lore.ts`、`views/cast.ts` 并排；三期的「叙事线总览」（章 × 线的时间轴，{@link buildThreadsOverview}）也从这里出数据：
 * 一行的说法、排序与「现在」都与工程页同一份。
 *
 * 写前检查的两类提醒（二期，{@link threadReminders}）也在这里取数：工作台、对话页写正文之前、批量写章的确认框用它；
 * 前端批量写章弹窗拿工程页数据里的 `watch` 自己算（同一个 `threadRemindersFor`）。
 *
 * ## 两个「到哪」（四期）
 *
 * - **定稿到**（`current`）：定稿过、正文还在的章里章号最大的那一章。总览上那条竖线、列头的颜色按它。
 * - **叙事线判到**（`through`）：`project.json` 的水位（从第 1 章起连续判过的，不超过定稿到）。⚑ 线的状态——断了几章、伏笔逾期、
 *   过了计划收束章——**按它算**：定稿了却还没判的章（拆书导入、补齐整理出来的、补记停在半路的），线上本来就没有事件，按定稿到算
 *   会让每条线都像断了、每条伏笔都像逾期。落后时工程页另说「⚠ 第 a–b 章还没判」，总览上的偏差只算判过的章。
 */

/** 排序：主线 → 支线 → 感情线 → 人物线。 */
const KIND_ORDER = new Map(THREAD_KINDS.map((k, i) => [k, i]));

/** 一行鼠标移上去看的（意图、当前进度）各截多少字。 */
const TIP_CHARS = 120;

/** 压成一行、截到 `max` 个字（装配器的 `clipLine` 同一个写法；views 不依赖 context/）。 */
function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s*\n+\s*/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 定稿到第几章、叙事线判到哪（四期）：工程页与总览从读盘那一半交进来。 */
export interface ThreadsProgress {
  /** 叙事线的水位与水位之后另外判过的章（`project.json`）。 */
  mark: ThreadsMark;
  /** 定稿过、正文还在的章号（与「定稿到」同一个口径）。 */
  finalized: readonly number[];
  /** 各章的章名、正文路径与卷（「时间线」组一章一行用）。缺席时那几样空着。 */
  chapters?: readonly TimelineChapterInput[];
}

/** 叙事线判到第几章：水位，不超过定稿到（定稿之后又删了细纲、正文的章不算）。 */
export function judgedThrough(mark: ThreadsMark, current: number): number {
  return Math.min(mark.through, current);
}

/**
 * 工程页「叙事线」页签的数据。`current` 是「定稿到」的最后一章；`progress` 是叙事线判到哪（四期），缺席当定稿过的章都判过了
 * （判到 = 定稿到，没有落后）。线的状态按「判到」算（见上面「两个『到哪』」）。
 *
 * 排序：种类（主线 → 支线 → 感情线 → 人物线）→ 最近一次推进（近的在前；一次都没推进过的排在同种类最后，按计划
 * 开始的章）→ 目录里的顺序（文件名）。
 */
export function buildThreadsView(book: ThreadBook, current: number, progress?: ThreadsProgress): ThreadsView {
  const through = progress ? judgedThrough(progress.mark, current) : current;
  const lines = book.threads.map((t) => lineOf(t, through));
  const order = new Map(book.threads.map((t) => [t.relPath, t]));
  lines.sort((a, b) => compareLines(order.get(a.relPath)!, a, order.get(b.relPath)!, b));
  const unfiled = unfiledOf(book.unfiled, through);
  const behind = progress ? unjudgedChapters(progress.mark, progress.finalized) : [];
  const timeline = timelineGroupOf(book.timeline, progress);
  // 写前提醒要的数（二期）：按现在的样子算，前端批量写章弹窗照它与要写的那几章算提醒（与后端确认框同一个函数）。
  return {
    lines,
    ...(unfiled ? { unfiled } : {}),
    current,
    through,
    ...(behind.length > 0 ? { lag: { count: behind.length, text: `${describeChapterRuns(behind)}还没判` } } : {}),
    watch: threadWatch(book),
    ...(timeline ? { timeline } : {}),
  };
}

// ---------------------------------------------------------------- 故事时间（2026-10-24；同日重做成单独一组）

/** 工程页交进来的章（时间线组一章一行要章名、正文路径与卷）。 */
export interface TimelineChapterInput {
  no: number;
  title: string;
  /** 正文路径（还没有正文是空串）。 */
  chapterPath: string;
  /** 卷名（直接放在章节根下是空串）。 */
  volume: string;
}

/** 时间线里有没有这一章的行（认得出、认不出的都算：认不出的是作者的，补推不碰）。 */
function hasTimeLine(tl: Timeline, no: number): boolean {
  return tl.entries.some((e) => e.chapter === no) || tl.bad.includes(no);
}

/** 「现在」：最后一章的结尾那一天与结尾时段（跨了几天的说结尾那一天）。 */
function nowOf(tl: Timeline, d: TimelineDay): string {
  const day = d.end ?? d.start;
  if (day === undefined) {
    return describeDay(tl, d);
  }
  const part = d.endPart ?? (d.span > 1 ? undefined : d.part);
  return `${dayLabel(tl, day).full}${part ? ` ${part}` : ''}`;
}

/** 没起点时每多少章一段（也没有卷的时候）。 */
const TIMELINE_SEGMENT_CHAPTERS = 20;

/**
 * 「时间线」那一组（设计稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：标题、历法与起点、对账一条一行、章按月分段
 * 一章一行。文件不在、也没有要补推的章时不画。`chapters` 给了才有章名、正文路径与卷（工程页给；单测可以不给）。
 */
function timelineGroupOf(tl: Timeline | undefined, progress?: ThreadsProgress): TimelineGroupView | undefined {
  if (!tl) {
    return undefined;
  }
  const missing = progress
    ? [...progress.finalized].filter((no) => {
        const e = tl.entries.find((x) => x.chapter === no);
        return !hasTimeLine(tl, no) || (e?.value.kind === 'unknown' && isMachineEntry(e));
      })
    : [];
  missing.sort((a, b) => a - b);
  const blank = missing.filter((no) => !hasTimeLine(tl, no));
  if (!tl.exists && blank.length === 0) {
    return undefined;
  }
  const calc = computeTimeline(tl);
  const issues = timelineIssues(tl, calc);
  const flagged = new Set(issues.map((i) => i.chapter));
  const known = [...calc.days].reverse().find((d) => d.start !== undefined && d.state !== 'missing');
  const of = (state: TimelineDay['state']) => calc.days.filter((d) => d.state === state).map((d) => d.chapter);
  const unknown = of('unknown');
  const bad = of('bad');
  const blankText = blank.length > 0 ? `${describeChapterRuns(blank)}还没推` : '';
  const suggestion = suggestStart(tl, calc);
  const byNo = new Map((progress?.chapters ?? []).map((c) => [c.no, c]));
  const entries = new Map(tl.entries.map((e) => [e.chapter, e]));

  const label = [
    calc.last > 0 ? `推到第 ${calc.last} 章` : '还没有一章',
    known ? `故事第 ${known.end ?? known.start} 天${tl.start ? `（${nowOf(tl, known)}）` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const calendar: TimelineGroupView['calendar'] = {
    text: tl.start
      ? `${tl.calendar} · 起点 ${tl.startText}（第 1 章那一天）`
      : tl.startText
        ? `${tl.calendar} · 起点「${tl.startText}」认不出，先只显示第几天`
        : suggestion
          ? `${tl.calendar} · 没填起点：第 ${suggestion.chapter} 章写了「${suggestion.mark}」，第 1 章是${suggestion.text}`
          : `${tl.calendar} · 没填起点，只显示第几天`,
    tip: [
      tl.calendar === '简单历' ? '简单历：每月 30 天、一年 12 个月，节日按农历口径（中秋是八月十五）。' : '公历：真实的月份长短与闰年。',
      tl.start ? '' : '填了起点，日期才看得出来，正文写明的日子才拿来对齐、季节才拿来对账。',
      suggestion ? `右键「填为起点」就填「${suggestion.text}」。` : '',
      '点这一行改历法与起点。',
    ]
      .filter(Boolean)
      .join('\n'),
    calendarName: tl.calendar,
    start: tl.startText,
    ...(suggestion ? { suggestion: { start: suggestion.text, note: `第 ${suggestion.chapter} 章写了「${suggestion.mark}」` } } : {}),
  };

  const issueViews: TimelineGroupView['issues'] = [
    ...issues.map((i) => ({ text: i.text, chapter: i.chapter })),
    ...(unknown.length > 0 && !issues.some((i) => i.kind === 'unknownRun') ? [{ text: `${describeChapterRuns(unknown)}推不出（按紧接上一章算，右键那一章「改时间」）` }] : []),
    ...(bad.length > 0 ? [{ text: `${describeChapterRuns(bad)}那一行认不出（按紧接上一章算）`, chapter: bad[0] }] : []),
    ...(blankText ? [{ text: `${blankText}：同步过，点标题旁的「补推时间」补上` }] : []),
  ];

  const rows: TimelineChapterView[] = calc.days.map((d) => chapterRowOf(tl, d, entries.get(d.chapter), byNo.get(d.chapter), flagged.has(d.chapter)));
  // 同步过、时间线里还没有、又写在最后一行之后的章也列出来（「还没推」）。
  for (const no of blank.filter((n) => n > calc.last)) {
    const c = byNo.get(no);
    rows.push({ no, title: c?.title ?? '', ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}), state: 'missing', when: '还没推', note: '', tip: `第 ${no} 章还没推`, value: '', machine: false });
  }
  rows.sort((a, b) => a.no - b.no);

  return {
    relPath: tl.relPath,
    exists: tl.exists,
    label,
    calendar,
    issues: issueViews,
    segments: segmentsOf(tl, calc, rows, byNo),
    ...(missing.length > 0 ? { missing: { count: missing.length, text: `${describeChapterRuns(missing)}还没推出来` } } : {}),
    machine: tl.entries.filter(isMachineEntry).length,
    last: Math.max(calc.last, ...rows.map((r) => r.no), 0),
  };
}

/** 一章一行。 */
function chapterRowOf(tl: Timeline, d: TimelineDay, e: TimelineEntry | undefined, c: TimelineChapterInput | undefined, issue: boolean): TimelineChapterView {
  const when = d.state === 'missing' ? '还没推' : d.state === 'bad' ? '那一行认不出' : rowWhen(tl, d);
  const note =
    d.state === 'dated' && d.dateMark
      ? `正文写明${describeDateMark(d.dateMark)}`
      : d.state === 'anchor'
        ? '你定的'
        : d.basis
          ? d.basis.kind === '依据'
            ? `依据「${clipLine(d.basis.text, 30)}」`
            : `${d.basis.kind}：${clipLine(d.basis.text, 30)}`
          : '';
  return {
    no: d.chapter,
    title: c?.title ?? '',
    ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}),
    state: d.state,
    when,
    ...(d.delta !== undefined && d.state !== 'missing' && d.state !== 'bad' ? { delta: describeDelta(d.delta) } : {}),
    note,
    tip: dayTip(tl, d).join('\n'),
    value: e ? renderTimeValue(e.value) : '',
    machine: !!e && isMachineEntry(e),
    ...(issue ? { issue: true as const } : {}),
  };
}

/** 一天不带年份：`三月十四`、`3月14日`（年份在段头上）。没起点是 `第 8 天`。 */
function dayNoYear(tl: Timeline, day: number): string {
  const l = dayLabel(tl, day);
  if (!l.month || !l.monthName) {
    return l.full;
  }
  return tl.start && (tl.start.style.day === 'iso' || tl.start.style.day === 'slash')
    ? `${l.monthName}${l.short}日`
    : l.full.slice(l.month.length - l.monthName.length);
}

/** 一行里那一天：`三月十四 清晨 → 夜里`、`三月十四 清晨 → 三月十六 夜里`；没起点 `第 8 天 清晨`；回忆 `回忆（约二十年前）`。 */
function rowWhen(tl: Timeline, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return describeDay(tl, d);
  }
  const head = `${dayNoYear(tl, d.start)}${d.part ? ` ${d.part}` : ''}`;
  if (d.span > 1 && d.end !== undefined) {
    return `${head} → ${dayNoYear(tl, d.end)}${d.endPart ? ` ${d.endPart}` : ''}`;
  }
  return d.endPart ? `${head} → ${d.endPart}` : head;
}

/**
 * 分段：填了起点按月（回忆、没推的章跟着前一章的月），没起点按卷，卷也没有每 {@link TIMELINE_SEGMENT_CHAPTERS} 章一段。
 */
function segmentsOf(tl: Timeline, calc: TimelineCalc, rows: TimelineChapterView[], byNo: Map<number, TimelineChapterInput>): TimelineSegmentView[] {
  const days = new Map(calc.days.map((d) => [d.chapter, d]));
  const keyOf = (no: number, prev: string): string => {
    const d = days.get(no);
    if (tl.start) {
      return d?.start !== undefined && d.state !== 'flashback' && d.state !== 'missing' ? (dayLabel(tl, d.start).month ?? prev) : prev;
    }
    if ([...byNo.values()].some((c) => c.volume)) {
      return byNo.get(no)?.volume ?? prev;
    }
    const k = Math.floor((no - 1) / TIMELINE_SEGMENT_CHAPTERS);
    return `第 ${k * TIMELINE_SEGMENT_CHAPTERS + 1}–${(k + 1) * TIMELINE_SEGMENT_CHAPTERS} 章`;
  };
  const out: TimelineSegmentView[] = [];
  let prev = '';
  for (const row of rows) {
    const key = keyOf(row.no, prev) || prev;
    prev = key;
    const last = out[out.length - 1];
    if (last && last.key === `timeline:${key}`) {
      last.chapters.push(row);
    } else {
      out.push({ key: `timeline:${key}`, label: key || '未分卷', detail: '', chapters: [row] });
    }
  }
  for (const seg of out) {
    const nos = seg.chapters.map((c) => c.no);
    const ds = nos.map((n) => days.get(n)).filter((d): d is TimelineDay => d?.start !== undefined && d.state !== 'flashback' && d.state !== 'missing');
    const from = Math.min(...ds.map((d) => d.start!));
    const to = Math.max(...ds.map((d) => d.end ?? d.start!));
    const range = nos.length === 1 ? `第 ${nos[0]} 章` : `第 ${nos[0]}–${nos[nos.length - 1]} 章`;
    seg.detail = ds.length > 0 ? `${range} · ${tl.start ? `${to - from + 1} 天` : `故事第 ${from === to ? from : `${from}–${to}`} 天`}` : range;
  }
  return out;
}

/** 一章的悬停（工程页那一行与总览那一格共用）：全称、故事第几天、比上一章晚多久、历时、依据 / 推测、正文写明的、对账。 */
function dayTip(tl: Timeline, d: TimelineDay): string[] {
  const lines = [`第 ${d.chapter} 章 · ${describeDayRange(tl, d)}`];
  if (d.start !== undefined && d.state !== 'flashback') {
    const span = d.span > 1 && d.end !== undefined ? `，历时 ${d.span} 天，到${dayLabel(tl, d.end).full}` : '';
    const delta = d.delta !== undefined ? `；比上一章：${describeDelta(d.delta)}` : '';
    lines.push(`故事第 ${d.start} 天${span}${delta}`);
  }
  if (d.basis) {
    lines.push(d.basis.kind === '依据' ? `依据：「${d.basis.text}」` : `${d.basis.kind}：${d.basis.text}`);
  }
  if (d.dateMark) {
    lines.push(`正文写明：${describeDateMark(d.dateMark)}${d.dateMark.offset > 0 ? `（开头后 ${d.dateMark.offset} 天）` : ''}${d.dateMark.quote ? `「${d.dateMark.quote}」` : ''}`);
  }
  if (d.aligned && !d.aligned.unknown && d.aligned.drift !== 0) {
    lines.push(`前面推下来是${dayLabel(tl, d.aligned.estimate).full}，按正文对齐了（差 ${Math.abs(d.aligned.drift)} 天）`);
  }
  if (d.seasonMark) {
    lines.push(`季节：${d.seasonMark.season}${d.seasonMark.quote ? `「${d.seasonMark.quote}」` : ''}`);
  }
  if (TIME_STATE_NOTE[d.state]) {
    lines.push(TIME_STATE_NOTE[d.state]);
  }
  return lines;
}

const TIME_STATE_NOTE: Record<TimelineDay['state'], string> = {
  evidence: '',
  guess: '',
  unknown: '推不出，按紧接上一章算',
  missing: '时间线里还没有这一章，按紧接上一章算',
  anchor: '你定的',
  dated: '正文写明了日子，按它对齐',
  flashback: '整章是回忆，不推进时间',
  bad: '这一行认不出，按紧接上一章算',
};

/**
 * 总览「故事时间」那一行：一章一格（时间线里写到的最后一章为止）。和上一章同一天的格子不写字（画一个点）。对账报了的章标 `issue`
 * （2026-10-24 重做），悬停里带上那一条。
 */
function timeCellsOf(tl: Timeline, calc: TimelineCalc): Map<number, ThreadsOverviewTime> {
  const out = new Map<number, ThreadsOverviewTime>();
  const issues = new Map<number, string[]>();
  for (const i of timelineIssues(tl, calc)) {
    issues.set(i.chapter, [...(issues.get(i.chapter) ?? []), i.text]);
  }
  let prevStart: number | undefined;
  // 月份带：回忆的章跟着前一章的月（主线还在那个月里，不把一段断成两截）；年份没变的那一段只写月。
  let prevMonth: { month: string; label: string } | undefined;
  let prevYear: string | undefined;
  for (const d of calc.days) {
    const label = describeDay(tl, d);
    const flagged = issues.get(d.chapter) ?? [];
    const lines = [...dayTip(tl, d), ...flagged.map((t) => `⚠ ${t}`), '点击打开时间线（在那里改）'];
    const day = d.start !== undefined ? dayLabel(tl, d.start) : undefined;
    let month = prevMonth;
    if (day?.month && day.monthName) {
      const year = day.month.slice(0, day.month.length - day.monthName.length);
      month = day.month === prevMonth?.month ? prevMonth : { month: day.month, label: year === prevYear ? day.monthName : day.month };
      prevYear = year;
    }
    prevMonth = month;
    const short =
      d.state === 'flashback'
        ? '忆'
        : d.state === 'unknown' || d.state === 'bad'
          ? '?'
          : d.state === 'missing' || d.start === prevStart
            ? ''
            : (day?.short ?? '');
    out.set(d.chapter, {
      state: d.state,
      short,
      label,
      tip: lines.join('\n'),
      ...(month ? { month: month.month, monthLabel: month.label } : {}),
      ...(flagged.length > 0 ? { issue: true as const } : {}),
    });
    if (d.start !== undefined) {
      prevStart = d.start;
    }
  }
  return out;
}

/**
 * 写这几章之前的叙事线提醒（二期，设计稿「四、写前检查」）：伏笔逾期、线断了，零调用、不拦人。读一遍叙事线目录与章节，
 * 按第一章 `asOf`（写第 N 章时按第 N − 1 章算，`threadRemindersFor`）。`through` 是叙事线判到第几章（四期的水位，不超过定稿到；
 * 同工程页的「叙事线判到」），说法里拿它注一句还没记上的那几章（`unrecordedBefore`：没定稿的，或定稿了还没判的）。
 */
export async function threadReminders(project: NovelProject, nos: readonly number[]): Promise<{ reminders: ThreadReminder[]; through: number }> {
  if (nos.length === 0) {
    return { reminders: [], through: 0 };
  }
  const first = Math.min(...nos);
  const [book, plots, chapters, mark] = await Promise.all([
    project.readThreads(),
    project.listPlots(),
    project.listChapters(),
    project.readThreadsMark(),
  ]);
  const current = chapters.reduce((max, c) => (c.order > max && project.plotFor(c.order, plots, chapters)?.sourceHash ? c.order : max), 0);
  return { reminders: threadRemindersFor(threadWatch(book, first), nos), through: judgedThrough(mark, current) };
}

function compareLines(ta: Thread, a: ThreadLineView, tb: Thread, b: ThreadLineView): number {
  return (
    KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    (b.lastActive ?? -1) - (a.lastActive ?? -1) ||
    (ta.from ?? Infinity) - (tb.from ?? Infinity) ||
    ta.index - tb.index
  );
}

/** 一条线一行。 */
function lineOf(t: Thread, current: number): ThreadLineView {
  const state = threadStateAt(t, current);
  const fores = foreshadowingOf(t, current);
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdueFores = fores.filter((f) => f.overdue).length;
  const detail = [
    t.kind,
    state.status,
    state.lastActive !== undefined ? `最近第 ${state.lastActive} 章` : planOf(t),
    open > 0 ? `${open} 条伏笔没收` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const warnings = [
    state.stalled ? `断了 ${state.gap} 章` : '',
    overdueFores > 0 ? `${overdueFores} 条伏笔逾期` : '',
    state.overdue ? `过了计划收束的第 ${t.to} 章` : '',
  ].filter(Boolean);
  const tip = [
    t.intent ? `意图：${clipLine(t.intent, TIP_CHARS)}` : '',
    t.progress ? `当前进度${t.progressThrough !== undefined ? `（写到第 ${t.progressThrough} 章）` : ''}：${clipLine(t.progress, TIP_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: t.name,
    relPath: t.relPath,
    kind: t.kind,
    status: state.status,
    ...(state.lastActive !== undefined ? { lastActive: state.lastActive } : {}),
    detail,
    warnings,
    tip,
  };
}

/** 还没推进过的线写计划区间：`计划第 3–40 章`、`计划第 3 章起`、`计划第 40 章收`。都没写是空串。 */
function planOf(t: Thread): string {
  if (t.from !== undefined && t.to !== undefined) {
    return `计划第 ${t.from}–${t.to} 章`;
  }
  if (t.from !== undefined) {
    return `计划第 ${t.from} 章起`;
  }
  return t.to !== undefined ? `计划第 ${t.to} 章收` : '';
}

/**
 * 「未归属的伏笔 · N 条」。一条伏笔都没有（没有这份文件、或作者把它们都挪走了）时不画这一行：点进去也是空的。
 * 只在事件里出现过名字的也算一条（与 `foreshadowingOf` 同一个口径）。
 */
function unfiledOf(file: ThreadFileBase, current: number): ThreadUnfiledView | undefined {
  const fores = foreshadowingOf(file, current);
  if (fores.length === 0) {
    return undefined;
  }
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdue = fores.filter((f) => f.overdue).length;
  return {
    relPath: file.relPath,
    total: fores.length,
    detail: `${fores.length} 条${open < fores.length ? ` · ${open} 条没收` : ''}`,
    warnings: overdue > 0 ? [`${overdue} 条伏笔逾期`] : [],
  };
}

// ---------------------------------------------------------------- 叙事线总览（三期）

/**
 * 总览的列数上限：几千章的书照样画得下（格子是稀疏的，一行只画有事件的那几章），再多就是计划里写错了章号
 * （`plan: 3-30000`）。有正文或细纲的章永远画全，只截计划里提得太远的那一截。
 */
export const OVERVIEW_MAX_CHAPTERS = 5000;

/** 总览里一列的原料：有细纲或正文的那几章（读盘那一半给，{@link buildThreadsOverview}）。 */
export interface OverviewChapterInput {
  no: number;
  title: string;
  volume: string;
  state: Exclude<ThreadsOverviewChapterState, 'none'>;
  chapterPath?: string;
  plotPath?: string;
}

/**
 * 编辑区「叙事线总览」标签的数据（设计稿「八、叙事线总览」）：读一遍叙事线目录与章节、细纲两份列表（借缓存）、`project.json` 里
 * 叙事线判到哪，交给 {@link buildThreadsMatrix}。**纯读盘、不调模型、不落盘**（第 18、28 条：状态一律从事件现算）。「定稿到」与
 * 「叙事线判到」都与工程页「叙事线」页签同一个口径：定稿过（细纲有 `sourceHash`）、正文还在的章里章号最大的那一章；水位不超过它。
 *
 * 按需要（`requestThreadsOverview`），不进工程树：工程树每次文件变动都全量重推，这份只在总览开着时有用。
 */
export async function buildThreadsOverview(project: NovelProject): Promise<ThreadsOverview> {
  if (!(await project.isInitialized())) {
    return { initialized: false, chapters: [], current: 0, through: 0, volumes: false, groups: [] };
  }
  const [book, plots, chapters, mark] = await Promise.all([
    project.readThreads(),
    project.listPlots(),
    project.listChapters(),
    project.readThreadsMark(),
  ]);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const plotsRoot = project.relPath(project.plotsDir);
  // 同号的正文有两份时认路径排序第一份（与流水线、「转到…」同一个口径）。
  const chapterOf = new Map<number, (typeof chapters)[number]>();
  for (const c of chapters) {
    if (!chapterOf.has(c.order)) {
      chapterOf.set(c.order, c);
    }
  }
  const nos = [...new Set([...chapterOf.keys(), ...plots.map((p) => p.no)])].sort((a, b) => a - b);
  const inputs: OverviewChapterInput[] = nos.map((no) => {
    const chapter = chapterOf.get(no);
    // 细纲按路径配对（`NovelProject.plotFor`）：有正文只认它镜像的那一份，没有正文按号认计划。
    const plot = project.plotFor(no, plots, chapters);
    const title = plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : '');
    const state: OverviewChapterInput['state'] =
      chapter && plot?.sourceHash ? 'finalized' : chapter && chapter.wordCount > 0 ? 'written' : 'planned';
    return {
      no,
      title,
      volume: chapter ? volumeOf(chapter.relPath, chaptersRoot) : plot ? volumeOf(plot.relPath, plotsRoot) : '',
      state,
      ...(chapter ? { chapterPath: chapter.relPath } : {}),
      ...(plot ? { plotPath: plot.relPath } : {}),
    };
  });
  const current = inputs.reduce((max, c) => (c.state === 'finalized' && c.no > max ? c.no : max), 0);
  return { initialized: true, ...buildThreadsMatrix(book, inputs, current, { mark }) };
}

/**
 * 总览的矩阵（纯函数）。`chapters` 是有细纲或正文的章，`current` 是「定稿到」的最后一章；`opts.mark` 是叙事线判到哪（四期，缺席
 * 当定稿过的章都判过了），`opts.limit` 是列数上限。
 *
 * - **列**：第 1 章到「计划或已写的最后一章」——有细纲或正文的章、任何事件（计划的、实际的）、伏笔计划埋与收的章、线的
 *   计划区间里最晚的那一章；中间没有文件的章补一列 `none`（卷名沿用前一章）。提得太远的截在 {@link OVERVIEW_MAX_CHAPTERS}。
 * - **行**：线按种类分组（主线 → 支线 → 感情线 → 人物线），组里的先后与工程页一样；每条线下面是它的伏笔（`foreshadowingOf`
 *   的顺序：「伏笔」一节写了的在前，只在事件里出现过的跟在后面）；最后是「未归属的伏笔」（一条都没有不给）。
 * - **线的格子**：线自己的事件（推进 / 关系 / 收束 / 放弃）；没写伏笔名的伏笔事件也放在这里（没有别的行可放）。
 * - **伏笔的格子**：这条伏笔的埋 / 收 / 弃；连线见 {@link spanOf}。
 * - **判过没有**（四期）：定稿过、叙事线还没判的列标 `unjudged`（列头另一种样子）；**偏差只算判过的章**——还没判的章上线里本来
 *   就没有实际事件，算进去就是一片红圈（拆书导入、补齐整理出来的书）。线与伏笔的状态（断了、逾期、连线延到哪）按「叙事线判到」
 *   （水位，不超过定稿到）算，同工程页。
 */
export function buildThreadsMatrix(
  book: ThreadBook,
  chapters: readonly OverviewChapterInput[],
  current: number,
  opts: { limit?: number; mark?: ThreadsMark } = {}
): Omit<ThreadsOverview, 'initialized'> {
  const limit = opts.limit ?? OVERVIEW_MAX_CHAPTERS;
  const mark = opts.mark ?? { through: current, judged: [] };
  const through = judgedThrough(mark, current);
  const files: ThreadFileBase[] = [...book.threads, book.unfiled];
  const fileMax = chapters.reduce((m, c) => Math.max(m, c.no), Math.max(0, current));
  const tl = book.timeline?.exists ? book.timeline : undefined;
  const calc = tl ? computeTimeline(tl) : undefined;
  const mentioned = [
    ...files.flatMap((f) => f.events.map((e) => e.chapter)),
    ...files.flatMap((f) => f.foreshadowing.flatMap((x) => [x.plant ?? 0, x.resolve ?? 0])),
    ...book.threads.flatMap((t) => [t.from ?? 0, t.to ?? 0]),
    calc?.last ?? 0,
  ];
  const wanted = mentioned.reduce((m, n) => Math.max(m, n), fileMax);
  const last = Math.min(wanted, Math.max(limit, fileMax));

  const byNo = new Map(chapters.map((c) => [c.no, c]));
  const times = tl && calc ? timeCellsOf(tl, calc) : new Map<number, ThreadsOverviewTime>();
  const columns: ThreadsOverviewChapter[] = [];
  let volume = '';
  for (let no = 1; no <= last; no++) {
    const c = byNo.get(no);
    volume = c ? c.volume : volume;
    const unjudged = c?.state === 'finalized' && !isThreadsJudged(mark, no);
    const time = times.get(no);
    columns.push({
      ...(c ? { ...c, ...(unjudged ? { unjudged: true as const } : {}) } : { no, title: '', volume, state: 'none' as const }),
      ...(time ? { time } : {}),
    });
  }
  // 伏笔埋下至今多少天（悬停伏笔名看）：埋的那一章开头到叙事线判到的那一章结尾。
  const dayOf = (no: number): TimelineDay | undefined => calc?.days[no - 1];
  // 拿来判偏差的章：定稿过、叙事线也判过（四期）。
  const finalized = new Set(columns.filter((c) => c.state === 'finalized' && !c.unjudged).map((c) => c.no));

  // 组里的先后与工程页同一个排法（`buildThreadsView`）：最近推进的在前，没推进过的按计划开始的章。
  const order = book.threads
    .map((t) => ({ t, view: lineOf(t, through) }))
    .sort((a, b) => compareLines(a.t, a.view, b.t, b.view));
  const groups: ThreadsOverviewGroup[] = [];
  for (const { t, view } of order) {
    const line: ThreadsOverviewLine = {
      name: t.name,
      relPath: t.relPath,
      kind: t.kind,
      status: view.status,
      ...(t.from !== undefined ? { from: t.from } : {}),
      ...(t.to !== undefined ? { to: t.to } : {}),
      detail: view.detail,
      warnings: view.warnings,
      tip: view.tip,
      cells: lineCells(t, finalized, last),
      foreshadowing: foreshadowRows(t, through, finalized, last, dayOf),
    };
    const group = groups.find((g) => g.kind === t.kind);
    if (group) {
      group.lines.push(line);
    } else {
      groups.push({ kind: t.kind, lines: [line] });
    }
  }
  const unfiled = foreshadowRows(book.unfiled, through, finalized, last, dayOf);
  return {
    chapters: columns,
    current,
    through,
    volumes: columns.some((c) => c.volume !== ''),
    groups,
    ...(unfiled.length > 0 ? { unfiled: { relPath: book.unfiled.relPath, foreshadowing: unfiled } } : {}),
    ...(tl && calc
      ? { timeline: { relPath: tl.relPath, months: columns.some((c) => !!c.time?.month), label: calc.elapsed > 0 ? `故事第 ${calc.elapsed} 天` : '还没有一章' } }
      : {}),
    ...(wanted > last ? { clippedFrom: wanted } : {}),
  };
}

function overviewEvent(e: ThreadEvent): ThreadsOverviewEvent {
  return {
    type: e.type,
    ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}),
    what: e.what,
    ...(e.evidence ? { evidence: e.evidence } : {}),
  };
}

/** 按章把事件归成格子（只给有事件的章，按章号升序；同一章里照文件里写的先后）。截掉 `last` 之后的。 */
function cellsOf(events: readonly ThreadEvent[], last: number): ThreadsOverviewCell[] {
  const by = new Map<number, ThreadsOverviewCell>();
  for (const e of events) {
    if (e.chapter > last) {
      continue;
    }
    let cell = by.get(e.chapter);
    if (!cell) {
      cell = { chapter: e.chapter, planned: [], actual: [], deviation: false };
      by.set(e.chapter, cell);
    }
    (e.planned ? cell.planned : cell.actual).push(overviewEvent(e));
  }
  return [...by.values()].sort((a, b) => a.chapter - b.chapter);
}

/**
 * 线那一行的格子：线自己的事件。偏差（⚑）= 这一章有计划、那一章定稿了（四期：叙事线也判过了），却**一条**实际的事件都没有——
 * 计划了推进与关系、只发生了推进的算发生了（画 ◉，悬停看得到两边各是什么）。伏笔的事件不算这条线动过：它们在伏笔那几行。
 */
function lineCells(t: Thread, finalized: ReadonlySet<number>, last: number): ThreadsOverviewCell[] {
  const cells = cellsOf(
    t.events.filter((e) => !(isForeshadowEvent(e.type) && e.foreshadowing)),
    last
  );
  for (const cell of cells) {
    cell.deviation = cell.planned.length > 0 && cell.actual.length === 0 && finalized.has(cell.chapter);
  }
  return cells;
}

/**
 * 一份文件（一条线，或「未归属的伏笔」）里的伏笔，一条一行。偏差（⚑）：计划在第 N 章埋的，第 N 章定稿了（四期：叙事线也判过了）、
 * 到第 N 章为止还没埋（也没收、没弃）；计划在第 N 章收的，第 N 章定稿了、到第 N 章为止还没收（或弃）。提前埋了、提前收了的不算偏差。
 * `current` 是「叙事线判到」（逾期、连线延到哪按它）。
 */
function foreshadowRows(
  file: ThreadFileBase,
  current: number,
  finalized: ReadonlySet<number>,
  last: number,
  dayOf: (no: number) => TimelineDay | undefined = () => undefined
): ThreadsOverviewForeshadow[] {
  return foreshadowingOf(file, current).map((f) => {
    const key = threadKey(f.name);
    const mine = file.events.filter((e) => isForeshadowEvent(e.type) && e.foreshadowing && threadKey(e.foreshadowing) === key);
    const actual = mine.filter((e) => !e.planned);
    const plantedBy = (no: number) => actual.some((e) => e.type === '埋' && e.chapter <= no);
    const closedBy = (no: number) => actual.some((e) => e.type !== '埋' && e.chapter <= no);
    const cells = cellsOf(mine, last);
    for (const cell of cells) {
      if (!finalized.has(cell.chapter)) {
        continue;
      }
      const types = new Set(cell.planned.map((e) => e.type));
      const missedPlant = types.has('埋') && !plantedBy(cell.chapter) && !closedBy(cell.chapter);
      const missedClose = (types.has('收') || types.has('弃')) && !closedBy(cell.chapter);
      cell.deviation = missedPlant || missedClose;
    }
    const plannedChapters = (type: '埋' | '收') => mine.filter((e) => e.planned && e.type === type).map((e) => e.chapter);
    const span = spanOf(f, plannedChapters('埋'), plannedChapters('收'), current, last);
    return {
      name: f.name,
      what: f.what,
      status: f.status,
      ...(f.plant !== undefined ? { plant: f.plant } : {}),
      ...(f.resolve !== undefined ? { resolve: f.resolve } : {}),
      ...(f.plantedAt !== undefined ? { plantedAt: f.plantedAt } : {}),
      ...(f.closedAt !== undefined ? { closedAt: f.closedAt } : {}),
      overdue: f.overdue,
      ...(span ? { span } : {}),
      tip: foreshadowTip(f, plantedDays(f, current, dayOf)),
      cells,
    };
  });
}

/**
 * 伏笔一行上的连线（设计稿：埋 ● 到收 ◆ 之间连一条线，没收的虚线延到计划回收章）：
 *
 * - 收了、弃了：从埋的那一章实线连到收（弃）的那一章；
 * - 埋了没收：虚线从埋的那一章延到计划回收章——伏笔那一行写的回收章与计划里收它的那一章（推迟了的会更晚）**取晚的**（⚑，
 *   二期留的那个问题：两样都画，回收章那一格另有一道竖线，计划的收画空心 ◆）；逾期的延到「现在」；一样都没写也延到「现在」
 *   （它还挂着）；
 * - 还没埋：按计划从埋的那一章（伏笔那一行写的，没写取计划里埋它的那一章）到回收章画一条淡虚线；缺一头不画。
 *
 * 超过最后一列的截到最后一列。
 */
function spanOf(
  f: ForeshadowState,
  plannedPlants: readonly number[],
  plannedResolves: readonly number[],
  current: number,
  last: number
): ThreadsOverviewSpan | undefined {
  const clip = (span: ThreadsOverviewSpan): ThreadsOverviewSpan | undefined =>
    span.from < Math.min(span.to, last) ? { ...span, to: Math.min(span.to, last) } : undefined;
  if (isForeshadowClosed(f.status) && f.closedAt !== undefined) {
    return clip({ from: f.plantedAt ?? f.closedAt, to: f.closedAt, kind: 'done' });
  }
  const ends = [
    ...(f.resolve !== undefined ? [f.resolve] : []),
    ...plannedResolves,
    ...(f.overdue ? [current] : []),
  ];
  if (f.plantedAt !== undefined) {
    return clip({ from: f.plantedAt, to: Math.max(f.plantedAt, ...(ends.length > 0 ? ends : [current])), kind: 'open' });
  }
  const from = f.plant ?? (plannedPlants.length > 0 ? Math.min(...plannedPlants) : undefined);
  if (from === undefined || ends.length === 0) {
    return undefined;
  }
  return clip({ from, to: Math.max(...ends), kind: 'planned' });
}

/** 埋下、还没收的伏笔埋了多少天：埋的那一章开头到 `current` 那一章结尾（时间线推得出两头才有）。 */
function plantedDays(f: ForeshadowState, current: number, dayOf: (no: number) => TimelineDay | undefined): number | undefined {
  if (f.status !== '已埋' || f.plantedAt === undefined) {
    return undefined;
  }
  const from = dayOf(f.plantedAt)?.start;
  const to = dayOf(current)?.end;
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

/** 悬停伏笔名看的几行：是什么、计划第几章埋 / 第几章前收、现在怎样（埋了多少天，时间线推得出时）。 */
function foreshadowTip(f: ForeshadowState, days?: number): string {
  const plan = [f.plant !== undefined ? `计划第 ${f.plant} 章埋` : '', f.resolve !== undefined ? `第 ${f.resolve} 章前收` : '']
    .filter(Boolean)
    .join('、');
  const state =
    f.status === '已收'
      ? `第 ${f.closedAt} 章收了`
      : f.status === '已弃'
        ? `第 ${f.closedAt} 章弃了`
        : f.status === '已埋'
          ? `第 ${f.plantedAt} 章埋下，还没收${days !== undefined ? `（故事里已经过了 ${days} 天）` : ''}`
          : '还没埋';
  return [f.what, plan, `${state}${f.overdue ? `，过了第 ${f.resolve} 章（逾期）` : ''}`].filter(Boolean).join('\n');
}
