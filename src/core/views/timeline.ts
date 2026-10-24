import { THREAD_KINDS, ThreadBook, describeChapterRuns } from '../model/threadFile';
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
  monthOfDay,
  renderTimeValue,
  seasonOfMonth,
  suggestStart,
  timelineIssues,
} from '../model/timelineFile';
import {
  TimelineChapterView,
  TimelineGroupView,
  TimelineOverview,
  TimelineOverviewCard,
  TimelineOverviewDay,
  TimelineOverviewEvent,
  TimelineOverviewThread,
  TimelineSegmentView,
} from '../protocol';

/**
 * 故事时间的两处界面（2026-10-24；同日从 `views/threads.ts` 挪出来）：
 *
 * - 工程页叙事线页签里的「时间线」组（{@link timelineGroupOf}，设计稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：
 *   对账一条一行，章按月分段一章一行；
 * - 编辑区的「时间线总览」（{@link buildTimelineMatrix}，设计稿 docs/design/plans/2026-10-24-timeline-page.md）：竖着按故事日子排，
 *   一个日子一项、一章一张卡片，卡片上带这一章在各条线上实际发生的事。
 *
 * **纯函数、不调模型、不落盘**（第 18、28 条：日期、对账一律现算）。读盘由调用方做：工程页是 `projectView.ts`，总览是
 * `views/threads.ts` 的 `buildTimelineOverview`（和叙事线总览共用读章节那一半）。文案都在这里（前端只渲染、只加 ⚠）。
 */

/** 压成一行、截到 `max` 个字（同 `views/threads.ts` 的 `clipLine`）。 */
function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s*\n+\s*/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 工程页交进来的章（时间线组一章一行要章名、正文路径与卷）。 */
export interface TimelineChapterInput {
  no: number;
  title: string;
  /** 正文路径（还没有正文是空串）。 */
  chapterPath: string;
  /** 卷名（直接放在章节根下是空串）。 */
  volume: string;
}

/** 时间线组要的进度：同步过的章（「还没推」从这里面挑）、各章的章名与正文（`views/threads.ts` 的 `ThreadsProgress` 也是它）。 */
export interface TimelineProgress {
  /** 定稿过、正文还在的章号。 */
  finalized: readonly number[];
  /** 各章的章名、正文路径与卷（一章一行用）。缺席时那几样空着。 */
  chapters?: readonly TimelineChapterInput[];
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
 * 「时间线」那一组：标题、对账一条一行、章按月分段一章一行。文件不在、也没有要补推的章时不画。`chapters` 给了才有章名、正文路径与卷
 * （工程页给；单测可以不给）。
 *
 * 历法与起点原来是组里第一行、点了就改（2026-10-24 时间线总览：作者嫌反人类）：挪到 `calendar`（组标题的悬停），没填起点有建议、
 * 起点认不出的各成一条 ⚠（`start: true`，右键改）。
 */
export function timelineGroupOf(tl: Timeline | undefined, progress?: TimelineProgress): TimelineGroupView | undefined {
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
        : `${tl.calendar} · 没填起点，只显示第几天`,
    tip: [
      tl.calendar === '简单历' ? '简单历：每月 30 天、一年 12 个月，节日按农历口径（中秋是八月十五）。' : '公历：真实的月份长短与闰年。',
      tl.start ? '' : '填了起点，日期才看得出来，正文写明的日子才拿来对齐、季节才拿来对账。',
      '右键改历法与起点。',
    ]
      .filter(Boolean)
      .join('\n'),
    calendarName: tl.calendar,
    start: tl.startText,
    ...(suggestion ? { suggestion: { start: suggestion.text, note: `第 ${suggestion.chapter} 章写了「${suggestion.mark}」` } } : {}),
  };

  const issueViews: TimelineGroupView['issues'] = [
    ...(suggestion ? [{ text: `没填起点：第 ${suggestion.chapter} 章写了「${suggestion.mark}」，第 1 章是${suggestion.text}（右键填为起点）`, start: true as const }] : []),
    ...(tl.startText && !tl.start ? [{ text: `起点「${tl.startText}」认不出，先只显示第几天（右键改历法与起点）`, start: true as const }] : []),
    ...issues.map((i) => ({ text: i.text, chapter: i.chapter })),
    ...(unknown.length > 0 && !issues.some((i) => i.kind === 'unknownRun') ? [{ text: `${describeChapterRuns(unknown)}推不出（按紧接上一章算，右键那一章「改时间」）`, chapter: unknown[0] }] : []),
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

/** 行尾那一段怎么说：`正文写明八月十五`、`你定的`、`依据「…」`、`推测：…`（截到 `max` 字）。 */
function noteOf(d: TimelineDay, max: number): string {
  return d.state === 'dated' && d.dateMark
    ? `正文写明${describeDateMark(d.dateMark)}`
    : d.state === 'anchor'
      ? '你定的'
      : d.basis
        ? d.basis.kind === '依据'
          ? `依据「${clipLine(d.basis.text, max)}」`
          : `${d.basis.kind}：${clipLine(d.basis.text, max)}`
        : '';
}

/** 一章一行。 */
function chapterRowOf(tl: Timeline, d: TimelineDay, e: TimelineEntry | undefined, c: TimelineChapterInput | undefined, issue: boolean): TimelineChapterView {
  const when = d.state === 'missing' ? '还没推' : d.state === 'bad' ? '那一行认不出' : rowWhen(tl, d);
  return {
    no: d.chapter,
    title: c?.title ?? '',
    ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}),
    state: d.state,
    when,
    ...(d.delta !== undefined && d.state !== 'missing' && d.state !== 'bad' ? { delta: describeDelta(d.delta) } : {}),
    note: noteOf(d, 30),
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

/** 一章的悬停与详情（工程页那一行、总览那一张卡片共用）：全称、故事第几天、比上一章晚多久、历时、依据 / 推测、正文写明的、对账。 */
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
 * 叙事线总览列头与格子悬停里的「这一章是哪天」（2026-10-24 时间线总览：总览里的「时间线」一组与月份带去掉了，只留这一句）。
 * 时间线里写到的最后一章之后、没推的章缺席。
 */
export function chapterDayLabels(tl: Timeline, calc: TimelineCalc): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of calc.days) {
    if (d.state !== 'missing') {
      out.set(d.chapter, d.state === 'bad' ? '那一行认不出' : describeDay(tl, d));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 时间线总览（2026-10-24）

/** 总览里一章的原料（读盘那一半给）：章名、正文与细纲、细纲的梗概与时间地点、同步过没有。 */
export interface TimelinePageChapterInput {
  no: number;
  title: string;
  chapterPath?: string;
  plotPath?: string;
  /** 细纲的「梗概」「时间地点」（没有细纲是空串）。 */
  synopsis: string;
  timePlace: string;
  /** 同步过（细纲有 `sourceHash`、正文还在）。 */
  finalized: boolean;
}

/**
 * 线的颜色几种（前端 `--tlp-c0` 到 `--tlp-c7`，一套校验过色盲区分度的分类色）：按线的先后各一色、**不循环**——第 9 条线起与「未归属的
 * 伏笔」一样灰（循环的话两条线撞色；名字总写在标签上，颜色只是帮着认）。
 */
const THREAD_COLORS = 8;
/** 卡片上的依据、推测截多少字（全文在详情里）。 */
const CARD_NOTE_CHARS = 60;
/** 梗概截多少字。 */
const CARD_SYNOPSIS_CHARS = 120;
const UNFILED_NAME = '未归属的伏笔';

/**
 * 卡片右上角：时段（同一天 `清晨 → 夜里`；跨天 `清晨 → 三月十五 夜里 · 3 天`），回忆 `回忆（约二十年前）`。日子在轴上，这里不写开头那一天。
 */
function cardWhen(tl: Timeline, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return describeDay(tl, d);
  }
  if (d.span > 1 && d.end !== undefined) {
    return `${d.part ? `${d.part} ` : ''}→ ${dayNoYear(tl, d.end)}${d.endPart ? ` ${d.endPart}` : ''} · ${d.span} 天`;
  }
  return d.part && d.endPart ? `${d.part} → ${d.endPart}` : d.part ? d.part : d.endPart ? `→ ${d.endPart}` : '';
}

/** 对账那一条去掉开头的 `第 N 章：`（卡片上已经写着是哪一章）。 */
function issueOnCard(text: string, no: number): string {
  return text.replace(new RegExp(`^第 ${no} 章[:：]\\s*`, 'u'), '');
}

/**
 * 时间线总览（纯函数）：`chapters` 是有细纲或正文的章（读盘那一半给，{@link TimelinePageChapterInput}）。
 *
 * - **轴**：按故事日子从早到晚，一个日子一项（⚑1：不按章号——往回跳的章排到它那一天，对账照旧报它）；同一天的几章按章号。没有章的
 *   日子不给，前端照相邻两项的日子画「N 天后」（⚑2）。
 * - **回忆的章**（⚑5）：挂在阅读顺序上前一章那一天里（卡片按章号排，它就跟在那一章后面）；前面一章都没有的挂在第一天；一天都推不出
 *   （整本只有回忆）时给一个第 0 天。
 * - **卡片**：时段、比上一章、依据（截短）、这一章在各条线上**实际**发生的事（计划的不给；线按种类与目录里的先后，颜色按这个先后
 *   前 8 条各一色、不循环，⚑4，第 9 条起与「未归属的伏笔」一样灰），一条都没有时给细纲的梗概；对账报了的另列。
 * - 时间线写到的最后一章之后、同步过还没推的章不上轴（⚑6，`issues` 里有一条「还没推」）。
 */
export function buildTimelineMatrix(book: ThreadBook, chapters: readonly TimelinePageChapterInput[]): Omit<TimelineOverview, 'initialized'> {
  const tl = book.timeline;
  const finalized = chapters.filter((c) => c.finalized).map((c) => c.no);
  const group = tl ? timelineGroupOf(tl, { finalized, chapters: chapters.map((c) => ({ no: c.no, title: c.title, chapterPath: c.chapterPath ?? '', volume: '' })) }) : undefined;
  if (!tl || !group) {
    return { relPath: tl?.relPath ?? '', exists: false, meta: '', tip: '', calendar: { name: tl?.calendar ?? '简单历', start: tl?.startText ?? '' }, issues: [], threads: [], days: [], machine: 0, last: 0 };
  }
  const calc = computeTimeline(tl);
  const byNo = new Map(chapters.map((c) => [c.no, c]));
  const entries = new Map(tl.entries.map((e) => [e.chapter, e]));
  const issuesOf = new Map<number, string[]>();
  for (const i of timelineIssues(tl, calc)) {
    issuesOf.set(i.chapter, [...(issuesOf.get(i.chapter) ?? []), issueOnCard(i.text, i.chapter)]);
  }

  // 线的先后与颜色：种类（主线 → 支线 → 感情线 → 人物线），同种类按目录里的先后。
  const kindOrder = new Map(THREAD_KINDS.map((k, i) => [k, i]));
  const ordered = [...book.threads].sort((a, b) => (kindOrder.get(a.kind) ?? 0) - (kindOrder.get(b.kind) ?? 0) || a.index - b.index);
  const files = [...ordered.map((t, i) => ({ file: t, name: t.name, color: i < THREAD_COLORS ? i : -1 })), { file: book.unfiled, name: UNFILED_NAME, color: -1 }];
  const eventsOf = new Map<number, TimelineOverviewEvent[]>();
  const used = new Set<string>();
  for (const { file, name, color } of files) {
    for (const e of file.events) {
      if (e.planned) {
        continue;
      }
      used.add(name);
      eventsOf.set(e.chapter, [
        ...(eventsOf.get(e.chapter) ?? []),
        { thread: name, color, type: e.type, ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}), what: e.what, ...(e.evidence ? { evidence: e.evidence } : {}) },
      ]);
    }
  }
  const threads: TimelineOverviewThread[] = files.filter((f) => used.has(f.name)).map((f) => ({ name: f.name, color: f.color }));

  const cardOf = (d: TimelineDay): TimelineOverviewCard => {
    const c = byNo.get(d.chapter);
    const e = entries.get(d.chapter);
    const events = eventsOf.get(d.chapter) ?? [];
    const issues = issuesOf.get(d.chapter) ?? [];
    const synopsis = events.length === 0 && c?.synopsis ? clipLine(c.synopsis, CARD_SYNOPSIS_CHARS) : '';
    return {
      no: d.chapter,
      title: c?.title ?? '',
      state: d.state,
      when: d.state === 'missing' ? '还没推' : d.state === 'bad' ? '那一行认不出' : cardWhen(tl, d),
      ...(d.delta !== undefined && d.state !== 'missing' && d.state !== 'bad' ? { delta: describeDelta(d.delta) } : {}),
      ...(d.end !== undefined ? { end: d.end } : {}),
      note: noteOf(d, CARD_NOTE_CHARS),
      events,
      ...(synopsis ? { synopsis } : {}),
      issues,
      detail: [...dayTip(tl, d), ...(c?.timePlace ? [`细纲写的时间地点：${clipLine(c.timePlace, 200)}`] : [])],
      ...(d.state === 'flashback' ? { flashback: true as const } : {}),
      problem: issues.length > 0 || d.state === 'unknown' || d.state === 'bad' || d.state === 'missing',
      ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}),
      ...(c?.plotPath ? { plotPath: c.plotPath } : {}),
      machine: !!e && isMachineEntry(e),
    };
  };

  const byDay = new Map<number, TimelineOverviewCard[]>();
  const put = (day: number, card: TimelineOverviewCard) => byDay.set(day, [...(byDay.get(day) ?? []), card]);
  let lastDay: number | undefined;
  const early: TimelineOverviewCard[] = [];
  for (const d of calc.days) {
    if (d.state === 'flashback' || d.start === undefined) {
      if (lastDay === undefined) {
        early.push(cardOf(d));
      } else {
        put(lastDay, cardOf(d));
      }
      continue;
    }
    put(d.start, cardOf(d));
    lastDay = d.start;
  }
  if (early.length > 0) {
    const first = [...byDay.keys()].sort((a, b) => a - b)[0] ?? 0;
    for (const card of early) {
      put(first, card);
    }
  }

  const days: TimelineOverviewDay[] = [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((day) => {
      const cards = byDay.get(day)!.sort((a, b) => a.no - b.no);
      if (day < 1) {
        return { day, label: '回忆', full: '推不出是哪天', cards };
      }
      const l = dayLabel(tl, day);
      const month = monthOfDay(tl, day);
      return {
        day,
        label: tl.start ? dayNoYear(tl, day) : l.full,
        ...(tl.start ? { sub: `第 ${day} 天` } : {}),
        full: l.full,
        ...(l.month ? { month: l.month } : {}),
        ...(month !== undefined ? { season: seasonOfMonth(tl.calendar, month) } : {}),
        cards,
      };
    });

  const calendarShort = tl.start ? `${tl.calendar} · 起点 ${tl.startText}` : `${tl.calendar} · 没填起点`;
  return {
    relPath: group.relPath,
    exists: group.exists,
    meta: [calendarShort, group.label].filter(Boolean).join(' · '),
    tip: [group.calendar.text, group.calendar.tip].join('\n'),
    calendar: { name: tl.calendar, start: tl.startText, ...(group.calendar.suggestion ? { suggestion: group.calendar.suggestion } : {}) },
    issues: group.issues,
    threads,
    days,
    ...(group.missing ? { missing: group.missing } : {}),
    machine: group.machine,
    last: group.last,
  };
}
