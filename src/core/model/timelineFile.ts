/**
 * 叙事线里的故事时间（2026-10-24，设计见 docs/design/plans/2026-10-24-story-timeline.md，同日重做见
 * docs/design/plans/2026-10-24-story-timeline-rework.md）：`threads/时间线.md` 一章一行，记这一章开头比上一章结尾晚多久。
 *
 * ```markdown
 * ---
 * calendar: 简单历          # 简单历（每月 30 天、一年 12 个月）/ 公历；缺席是简单历
 * start: 大衍三年三月初七     # 第 1 天是哪天；不填只显示「第几天」
 * generatedBy: novel-forge
 * ---
 *
 * # 时间线
 *
 * - 第 1 章：+0 天，傍晚 → 深夜〔依据：「连日大雨的第三天傍晚」〕
 * - 第 4 章：+1 天，清晨 → 夜里，历时 3 天〔依据：「次日清晨，雨停了」〕〔文中：八月十五（中秋），开头后 2 天「今夜便是中秋」〕
 * - 第 7 章：回忆，约二十年前〔推测：整章是回忆〕
 * - 第 9 章：+?〔推不出：正文没交代过了多久〕〔季节：冬「北风卷着碎雪」〕
 * - 第 12 章：八月十五，傍晚           ← 作者定的锚点
 * ```
 *
 * ## 几条约定
 *
 * - **日期一律现算**（{@link computeTimeline}）：机器写的是相对量；作者把哪一行改成日期或「第 N 天」，哪一行就是锚点，后面机器推的
 *   章跟着顺延——文件里不写推算出来的日期，改一个锚点不会留下一串过期的日期。状态不落盘（第 18 条）。
 * - **正文写明的日子当校准点**（重做）：〔文中〕是正文明写的日期或节日，推算到那一章按它对齐，一路累加的误差在那里清零；优先级是
 *   作者的锚点 > 〔文中〕 > 累加。〔季节〕只拿来对账（{@link timelineIssues}）。
 * - **机器写的行机器能换，作者的行不动**（{@link upsertTimelineEntry}、{@link isMachineEntry}）：带〔依据〕〔推测〕〔推不出〕的是机器
 *   写的，同步与重推（`refresh`）照新推的换，补推（`fill`）只填空；作者写的一律不动（第 28 条）。
 * - **怎么手改都不崩**（第 1 条）：认不出的行原样留着，这一章当「没推」算；认不出的〔文中〕〔季节〕当没写。
 * - 纯函数、无 I/O：读在 `model/project.ts` 的 `readThreads`，写在网关（`Workspace.updateThread`）。
 */
import { asString, parseMarkdown } from './markdown';
import { QuoteIndex, indexText, normalizeQuote, quoteFound } from './review';
import { nearestSentence } from './continuity';
import { TIMELINE_NAME } from './threadFile';

export { TIMELINE_NAME };

/** 上下文里那一条的标签（context/layers/background.ts 登记、builder.ts 拿它单独成一节）。 */
export const STORY_TIME_LABEL = '故事时间';

// ---------------------------------------------------------------- 类型

/** 历法（作者定的）：简单历每月 30 天、一年 12 个月；公历是真实的月份长短与闰年。不做农历。 */
export type TimelineCalendar = '简单历' | '公历';
export const TIMELINE_CALENDARS: readonly TimelineCalendar[] = ['简单历', '公历'];

/** 一行的值。`delta` 的单位已经换成天。 */
export type TimelineValue =
  | { kind: 'delta'; days: number }
  | { kind: 'unknown' }
  | { kind: 'flashback'; ago: string }
  | { kind: 'day'; day: number }
  | { kind: 'date'; text: string };

/** 行尾的那一段：依据（原文）、推测（理由）、推不出（理由）。机器写的行都带它。 */
export type TimelineBasisKind = '依据' | '推测' | '推不出';
export const TIMELINE_BASIS_KINDS: readonly TimelineBasisKind[] = ['依据', '推测', '推不出'];

/** 四季（〔季节〕那一段，只拿来对账）。 */
export type TimelineSeason = '春' | '夏' | '秋' | '冬';

/**
 * 〔文中：八月十五（中秋），开头后 2 天「今夜便是中秋」〕（2026-10-24 重做）：正文明写本章某一天是几月几日或哪个节日。推算时拿它对齐
 * （{@link computeTimeline}）。`date` 与 `festival` 至少有一个；只有节日的，推算时按历法换成日子（{@link festivalDate}）。
 */
export interface TimelineDateMark {
  date?: string;
  festival?: string;
  /** 那一天在本章开头之后第几天（开头当天是 0）。 */
  offset: number;
  /** 原文。 */
  quote?: string;
}

/** 〔季节：冬「北风卷着碎雪」〕：正文明写或明摆着的季节。 */
export interface TimelineSeasonMark {
  season: TimelineSeason;
  quote?: string;
}

export interface TimelineEntry {
  chapter: number;
  value: TimelineValue;
  /** 本章开头的时段（只显示）。 */
  part?: string;
  /** 本章结尾的时段（只显示；交给下一章判「当晚」「次日」用）。 */
  endPart?: string;
  /** 本章跨了几天（1 = 同一天里写完）。 */
  span: number;
  basis?: { kind: TimelineBasisKind; text: string };
  dateMark?: TimelineDateMark;
  seasonMark?: TimelineSeasonMark;
}

/** 一份时间线（`threads/时间线.md`）。 */
export interface Timeline {
  relPath: string;
  /** 文件在不在（不在时 entries 是空的）。 */
  exists: boolean;
  calendar: TimelineCalendar;
  /** frontmatter 里 `start` 的原文（空串 = 没填）。 */
  startText: string;
  /** 认出来的起点；没填、认不出时缺席（只显示第几天）。 */
  start?: CalendarDate;
  /** 一章一行（同一章写了两行认第一行），按文件里的先后。 */
  entries: TimelineEntry[];
  /** 认不出的行：`第 N 章` 认得出、值认不出的那几章（当「没推」算）。 */
  bad: number[];
}

/** 文件里一行的样子：`- 第 N 章：值，开头时段 → 结尾时段，历时 M 天〔依据：「原文」〕〔文中：…〕〔季节：…〕`。 */
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s+/u;
const LINE_HEAD = /^第\s*(\d+)\s*章\s*[:：·・\s]\s*/u;
/**
 * 行尾一段的开头：`〔依据：`、`〔推测：`、`〔推不出：`、`〔文中：`、`〔季节：`；括号写成 `[]`、`【】`、`（）` 也认，「证据」当「依据」。
 * 几段从后往前一段一段剥（{@link splitTails}），先后不限。
 */
const TAIL_OPEN = /[〔\[【（(]\s*(依据|证据|推测|推不出|文中|季节)\s*[:：]?\s*/gu;
const TAIL_CLOSE = /[〕\]】）)]\s*$/u;
const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];
/** 段尾的原文：`…「原文」`。 */
const QUOTE_TAIL = /[「『“"]([^「『“"]*)[」』”"]\s*$/u;
/** 时段一格写成 `开头 → 结尾`（`->` 也认）；只知道结尾写 `→ 夜里`。 */
const PART_RANGE = /^(.*?)\s*(?:→|->|－>|—>|⟶)\s*(.+)$/u;

/** 一行最长的依据、理由（字）。 */
export const TIME_BASIS_MAX = 120;
/** 「多久以前」最长多少字。 */
const AGO_MAX = 20;
/** 差值与跨度的上限（天）：约十万年，修仙跨几百年也够。 */
export const TIME_DAYS_MAX = 36_500_000;

function unquote(s: string): string {
  const t = s.trim();
  for (const [a, b] of QUOTES) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join('').trim();
}

// ---------------------------------------------------------------- 数字

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_DIGIT_CHARS = '零一二三四五六七八九';

/** 全角数字换成半角。 */
function asciiDigits(s: string): string {
  return s.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30));
}

/** 阿拉伯数字或汉字数字（读法「一百零五」「廿一」「初七」，或逐位「二〇二六」）。认不出返回 undefined。 */
export function parseNumber(raw: string): number | undefined {
  const s = asciiDigits(raw.trim()).replace(/^初/u, '');
  if (!s) {
    return undefined;
  }
  if (/^\d+$/u.test(s)) {
    return Number(s);
  }
  if (s === '元') {
    return 1;
  }
  // 逐位写的（「二〇二六」）：没有十百千万。
  if ([...s].length > 1 && [...s].every((c) => c in CN_DIGIT)) {
    return Number([...s].map((c) => CN_DIGIT[c]).join(''));
  }
  let total = 0;
  let section = 0;
  let num = -1;
  for (const c of s) {
    if (c in CN_DIGIT) {
      num = CN_DIGIT[c];
    } else if (c === '十' || c === '百' || c === '千') {
      section += (num < 0 ? 1 : num) * (c === '十' ? 10 : c === '百' ? 100 : 1000);
      num = -1;
    } else if (c === '万') {
      total += (section + Math.max(num, 0)) * 10000;
      section = 0;
      num = -1;
    } else if (c === '廿' || c === '卅') {
      section += c === '廿' ? 20 : 30;
      num = -1;
    } else {
      return undefined;
    }
  }
  return total + section + Math.max(num, 0);
}

/** 汉字读法（1 → 一，14 → 十四，105 → 一百零五，-3 → 负三）。 */
export function cnNumber(n: number): string {
  if (n < 0) {
    return `负${cnNumber(-n)}`;
  }
  if (n === 0) {
    return '零';
  }
  const under10000 = (v: number): string => {
    let s = '';
    let zero = false;
    for (const [unit, name] of [
      [1000, '千'],
      [100, '百'],
      [10, '十'],
      [1, ''],
    ] as const) {
      const d = Math.floor(v / unit) % 10;
      if (d === 0) {
        zero = s !== '';
        continue;
      }
      if (zero) {
        s += '零';
        zero = false;
      }
      s += CN_DIGIT_CHARS[d] + name;
    }
    return s;
  };
  let s: string;
  if (n >= 10000) {
    const high = Math.floor(n / 10000);
    const low = n % 10000;
    s = `${cnNumber(high)}万${low === 0 ? '' : `${low < 1000 ? '零' : ''}${under10000(low)}`}`;
  } else {
    s = under10000(n);
  }
  return s.startsWith('一十') ? s.slice(1) : s;
}

/** 农历式的日子：初一…初十、十一…十九、二十、廿一…廿九、三十。31 起写读法。 */
function tradDay(d: number): string {
  if (d >= 1 && d <= 10) {
    return `初${d === 10 ? '十' : CN_DIGIT_CHARS[d]}`;
  }
  if (d > 10 && d < 20) {
    return `十${CN_DIGIT_CHARS[d - 10]}`;
  }
  if (d === 20) {
    return '二十';
  }
  if (d > 20 && d < 30) {
    return `廿${CN_DIGIT_CHARS[d - 20]}`;
  }
  return cnNumber(d);
}

// ---------------------------------------------------------------- 历法

/** 年、月、日的写法：输出照起点的样子写。 */
export interface DateStyle {
  /** 年号（「大衍」），没有是空串。 */
  era: string;
  /** 起点写没写年份。 */
  hasYear: boolean;
  year: 'num' | 'cn' | 'cnDigits';
  month: 'num' | 'cn' | 'trad';
  day: 'num' | 'cn' | 'trad' | 'iso' | 'slash';
}

/** 一个日子（年份没写时是 undefined）。 */
export interface CalendarDate {
  y?: number;
  m: number;
  d: number;
  style: DateStyle;
}

const DATE_CN = new RegExp(
  '^(?<era>.*?)' +
    '(?:(?<y>[0-9０-９〇零○一二两三四五六七八九十百千万]+|元)\\s*年)?\\s*' +
    '(?<m>[0-9０-９]{1,2}|十[一二]|[一二两三四五六七八九十]|正|冬|腊|臘)\\s*月\\s*' +
    '(?:(?<d>初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅]{1,3})\\s*(?<suffix>[日号號])?)?$',
  'u'
);
const DATE_ISO = /^(?<y>\d{1,6})(?<sep>[-/.])(?<m>\d{1,2})\k<sep>(?<d>\d{1,2})$/u;

/** 认一个日子：`大衍三年三月初七`、`三月十四`、`2026年3月7日`、`2026-03-07`、`2026/3/7`。认不出返回 undefined。 */
export function parseDate(raw: string): CalendarDate | undefined {
  const s = asciiDigits(raw.trim()).replace(/\s+/gu, '');
  if (!s) {
    return undefined;
  }
  const iso = DATE_ISO.exec(s);
  if (iso?.groups) {
    const g = iso.groups;
    return {
      y: Number(g.y),
      m: Number(g.m),
      d: Number(g.d),
      style: { era: '', hasYear: true, year: 'num', month: 'num', day: g.sep === '-' ? 'iso' : 'slash' },
    };
  }
  const m = DATE_CN.exec(s);
  if (!m?.groups) {
    return undefined;
  }
  const g = m.groups;
  const era = (g.era ?? '').trim();
  if (era && !g.y) {
    // 「大衍三月」：年号后面没有年，认不准，不认。
    return undefined;
  }
  const month = g.m === '正' ? 1 : g.m === '冬' ? 11 : g.m === '腊' || g.m === '臘' ? 12 : parseNumber(g.m);
  const day = g.d ? parseNumber(g.d) : 1;
  const year = g.y ? parseNumber(g.y) : undefined;
  if (month === undefined || day === undefined || (g.y && year === undefined)) {
    return undefined;
  }
  const monthStyle: DateStyle['month'] = /^[0-9]/u.test(g.m) ? 'num' : /^[正冬腊臘]$/u.test(g.m) ? 'trad' : 'cn';
  const dayStyle: DateStyle['day'] = !g.d
    ? monthStyle === 'num'
      ? 'num'
      : 'trad'
    : /^[0-9]/u.test(g.d)
      ? 'num'
      : g.suffix && !/^初|[廿卅]/u.test(g.d)
        ? 'cn'
        : 'trad';
  const yearStyle: DateStyle['year'] = !g.y || /^[0-9]/u.test(g.y) ? 'num' : /^[〇零○一二两三四五六七八九]{2,}$/u.test(g.y) ? 'cnDigits' : 'cn';
  return {
    ...(year !== undefined ? { y: year } : {}),
    m: month,
    d: day,
    style: { era, hasYear: year !== undefined, year: yearStyle, month: monthStyle, day: dayStyle },
  };
}

/** 公历没写年份时内部用的年（平年）：只拿来算月份长短。 */
const GREGORIAN_YEARLESS = 2001;
const DAY_MS = 86_400_000;

/** 这一天在这个历法下的序号（相邻两天差 1）。日期不存在（三月三十一、二月二十九）返回 undefined。 */
function ordinalOf(cal: TimelineCalendar, y: number, m: number, d: number): number | undefined {
  if (!(m >= 1 && m <= 12 && d >= 1)) {
    return undefined;
  }
  if (cal === '简单历') {
    return d > 30 ? undefined : (y * 12 + (m - 1)) * 30 + (d - 1);
  }
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return Math.round(t / DAY_MS);
}

function fromOrdinal(cal: TimelineCalendar, o: number): { y: number; m: number; d: number } {
  if (cal === '简单历') {
    const y = Math.floor(o / 360);
    const rest = o - y * 360;
    return { y, m: Math.floor(rest / 30) + 1, d: (rest % 30) + 1 };
  }
  const t = new Date(o * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 起点在这个历法下的序号。没写年份的：简单历当第 1 年，公历当一个平年。 */
function startOrdinal(cal: TimelineCalendar, start: CalendarDate): number | undefined {
  return ordinalOf(cal, start.y ?? (cal === '简单历' ? 1 : GREGORIAN_YEARLESS), start.m, start.d);
}

/** 一年几天（`+N 年` 换成天、半年）。 */
function yearDays(cal: TimelineCalendar): number {
  return cal === '简单历' ? 360 : 365;
}

function yearText(y: number, style: DateStyle): string {
  if (style.year === 'num') {
    return String(y);
  }
  if (style.year === 'cnDigits' && y >= 0) {
    return [...String(y)].map((c) => '〇一二三四五六七八九'[Number(c)]).join('');
  }
  return y === 1 && style.era ? '元' : cnNumber(y);
}

function monthText(m: number, style: DateStyle): string {
  if (style.month === 'num') {
    return `${m}月`;
  }
  if (style.month === 'trad' && (m === 1 || m === 11 || m === 12)) {
    return m === 1 ? '正月' : m === 11 ? '冬月' : '腊月';
  }
  return `${cnNumber(m)}月`;
}

function dayText(d: number, style: DateStyle): string {
  switch (style.day) {
    case 'trad':
      return tradDay(d);
    case 'cn':
      return `${cnNumber(d)}日`;
    default:
      return `${d}日`;
  }
}

/** 起点没写年份时，跨年写「次年」「第三年」「前一年」。 */
function yearOffsetText(k: number, style: DateStyle): string {
  if (k === 0) {
    return '';
  }
  const n = (v: number) => (style.month === 'num' ? String(v) : cnNumber(v));
  if (k === 1) {
    return '次年';
  }
  if (k > 1) {
    return `第${n(k + 1)}年`;
  }
  return k === -1 ? '前一年' : `${n(-k)}年前`;
}

/** 一天的几种写法。 */
export interface DayLabel {
  /** 全称：`大衍三年三月十四`、`次年三月十四`、`2026年3月14日`；没有起点是 `第 8 天`。 */
  full: string;
  /** 总览那一格：`十四`、`14`；没有起点是 `8`。 */
  short: string;
  /** 月份带上那一段：`大衍三年三月`、`2026年3月`。没有起点时缺席。 */
  month?: string;
  /** 只有月：`三月`、`3月`（月份带上年份没变时只写它）。没有起点时缺席。 */
  monthName?: string;
}

/** 故事第 `day` 天怎么写（第 1 天 = 起点）。 */
export function dayLabel(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): DayLabel {
  const plain: DayLabel = { full: `第 ${day} 天`, short: String(day) };
  if (!tl.start) {
    return plain;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return plain;
  }
  const ymd = fromOrdinal(tl.calendar, base + day - 1);
  const style = tl.start.style;
  return formatYmd(ymd, style, style.hasYear ? undefined : yearOffsetText(ymd.y - fromOrdinal(tl.calendar, base).y, style));
}

/**
 * 一个日子照 `style`（起点的写法）写出来。`yearPart` 是起点没写年份时的「次年」「第三年」（空串 = 起点那一年，只写月日）；
 * 起点写了年份时不传，照年号与年份写。
 */
function formatYmd(ymd: { y: number; m: number; d: number }, style: DateStyle, yearPart?: string): DayLabel & { month: string; monthName: string } {
  const { y, m, d } = ymd;
  if (style.day === 'iso' || style.day === 'slash') {
    const pad = (v: number) => (style.day === 'iso' ? String(v).padStart(2, '0') : String(v));
    const sep = style.day === 'iso' ? '-' : '/';
    return { full: `${y}${sep}${pad(m)}${sep}${pad(d)}`, short: String(d), month: `${y}${sep}${pad(m)}`, monthName: `${m}月` };
  }
  const year = yearPart ?? `${style.era}${yearText(y, style)}年`;
  const monthName = monthText(m, style);
  const month = `${year}${monthName}`;
  const short = style.day === 'trad' ? tradDay(d) : style.day === 'cn' ? cnNumber(d) : String(d);
  return { full: `${month}${dayText(d, style)}`, short, month, monthName };
}

/**
 * 锚点写的日子是故事第几天。没写年份的取 `after`（上一章结尾那一天）当天或之后最近的那一个。没有起点、日子不存在、认不出时
 * 返回 undefined。
 */
export function dayOfDate(tl: Pick<Timeline, 'calendar' | 'start'>, text: string, after: number): number | undefined {
  const date = parseDate(text);
  if (!date || !tl.start) {
    return undefined;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return undefined;
  }
  if (date.y !== undefined) {
    // 起点没写年份时，锚点写的年份当「第几年」（内部第 1 年就是起点那一年）。
    const o = ordinalOf(tl.calendar, date.y, date.m, date.d);
    return o === undefined ? undefined : o - base + 1;
  }
  const ref = fromOrdinal(tl.calendar, base + Math.max(after, 1) - 1);
  for (const y of [ref.y, ref.y + 1]) {
    const o = ordinalOf(tl.calendar, y, date.m, date.d);
    if (o !== undefined && o - base + 1 >= Math.max(after, 1)) {
      return o - base + 1;
    }
  }
  // 二月二十九：往后找到有它的那一年（公历最多八年一遇）。
  for (let y = ref.y + 2; y <= ref.y + 8; y++) {
    const o = ordinalOf(tl.calendar, y, date.m, date.d);
    if (o !== undefined) {
      return o - base + 1;
    }
  }
  return undefined;
}

/**
 * 正文写明的一天（〔文中〕）是故事第几天：没写年份的取**离 `estimate`（按前文推下来的那一天）最近**的那一个（⚑1：不取「之后最近」，
 * 前文推多了几天时那会跳到明年）；写了年份的就是那一天。没有起点、日子不存在时返回 undefined。
 */
export function dayNearest(tl: Pick<Timeline, 'calendar' | 'start'>, date: CalendarDate, estimate: number): number | undefined {
  if (!tl.start) {
    return undefined;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return undefined;
  }
  if (date.y !== undefined && date.m > 0) {
    const o = ordinalOf(tl.calendar, date.y, date.m, date.d);
    return o === undefined ? undefined : o - base + 1;
  }
  const ref = fromOrdinal(tl.calendar, base + estimate - 1);
  // 候选：前后一年里的这一天；只写了日的（m 是 0），前后一个月里的这一天。
  const candidates: { y: number; m: number }[] = [];
  if (date.m > 0) {
    for (let y = ref.y - 1; y <= ref.y + 1; y++) {
      candidates.push({ y, m: date.m });
    }
  } else {
    for (let k = -1; k <= 1; k++) {
      const i = ref.y * 12 + (ref.m - 1) + k;
      candidates.push({ y: Math.floor(i / 12), m: (((i % 12) + 12) % 12) + 1 });
    }
  }
  let best: number | undefined;
  for (const { y, m } of candidates) {
    const o = ordinalOf(tl.calendar, y, m, date.d);
    if (o === undefined) {
      continue;
    }
    const day = o - base + 1;
    // 一样近时取后面那一个（故事多半往前走）。
    if (best === undefined || Math.abs(day - estimate) < Math.abs(best - estimate) || (Math.abs(day - estimate) === Math.abs(best - estimate) && day > best)) {
      best = day;
    }
  }
  return best;
}

/** 故事第 `day` 天是几月（没有起点时 undefined）。 */
export function monthOfDay(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): number | undefined {
  const base = tl.start ? startOrdinal(tl.calendar, tl.start) : undefined;
  return base === undefined ? undefined : fromOrdinal(tl.calendar, base + day - 1).m;
}

// ---------------------------------------------------------------- 节日与季节（2026-10-24 重做）

/**
 * 节日换成哪一天（⚑4）：简单历按农历口径；公历只认几个公历节日（农历节日在公历里年年不同，换不出）。节气（清明、冬至）年年漂，不换。
 */
const FESTIVALS: Record<TimelineCalendar, Record<string, [number, number]>> = {
  简单历: {
    春节: [1, 1],
    元日: [1, 1],
    元旦: [1, 1],
    新年: [1, 1],
    大年初一: [1, 1],
    元宵: [1, 15],
    上元: [1, 15],
    上巳: [3, 3],
    端午: [5, 5],
    端阳: [5, 5],
    七夕: [7, 7],
    乞巧: [7, 7],
    中元: [7, 15],
    盂兰盆: [7, 15],
    中秋: [8, 15],
    重阳: [9, 9],
    重九: [9, 9],
    下元: [10, 15],
    腊八: [12, 8],
    小年: [12, 23],
    除夕: [12, 30],
    大年夜: [12, 30],
    年三十: [12, 30],
  },
  公历: {
    元旦: [1, 1],
    新年: [1, 1],
    情人节: [2, 14],
    劳动节: [5, 1],
    五一: [5, 1],
    国庆: [10, 1],
    平安夜: [12, 24],
    圣诞: [12, 25],
  },
};

/** 节日名去掉「节」「夜」这类尾巴：`中秋节` → `中秋`。 */
function festivalKey(name: string): string {
  const s = name.trim().replace(/[「」『』“”"']/gu, '');
  return s.replace(/(?:节|節)$/u, '').replace(/^(中秋|元宵|七夕|除夕)夜$/u, '$1');
}

/** 节日是这个历法里的哪一天（月、日）。认不出、这个历法里换不出时 undefined。 */
export function festivalDate(cal: TimelineCalendar, name: string): { m: number; d: number } | undefined {
  const hit = FESTIVALS[cal][festivalKey(name)];
  return hit ? { m: hit[0], d: hit[1] } : undefined;
}

const DAY_ONLY = /^(初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅]{1,3})\s*[日号號]?$/u;

/**
 * 〔文中〕的日期：认 {@link parseDate} 的几种写法，也认只写了日的（「二十一日」「十五」，古典小说里常见）——只写日的 `m` 是 0，推算时取
 * 离推算最近的那个月里的这一天（{@link dayNearest}）。
 */
export function parseMarkDate(raw: string): CalendarDate | undefined {
  const full = parseDate(raw);
  if (full) {
    return full;
  }
  const m = DAY_ONLY.exec(asciiDigits(raw.trim()).replace(/\s+/gu, ''));
  const d = m ? parseNumber(m[1]) : undefined;
  return d !== undefined && d >= 1 && d <= 31 ? { m: 0, d, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } } : undefined;
}

/** 〔文中〕那一天：写了日期的认日期，只写了节日的按历法换。认不出返回 undefined。 */
export function markDate(cal: TimelineCalendar, mark: TimelineDateMark): CalendarDate | undefined {
  if (mark.date) {
    const d = parseMarkDate(mark.date);
    if (d) {
      return d;
    }
  }
  const f = mark.festival ? festivalDate(cal, mark.festival) : undefined;
  return f ? { m: f.m, d: f.d, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } } : undefined;
}

/** 〔文中〕那一段怎么说：`八月十五（中秋）`、`中秋`。 */
export function describeDateMark(mark: TimelineDateMark): string {
  return mark.date ? `${mark.date}${mark.festival ? `（${mark.festival}）` : ''}` : (mark.festival ?? '');
}

const SEASONS: readonly TimelineSeason[] = ['春', '夏', '秋', '冬'];

/** 认季节：`春` / `春天` / `春季` / `冬日`……认不出返回 undefined。 */
export function parseSeason(raw: string): TimelineSeason | undefined {
  const m = /^\s*(春|夏|秋|冬)(?:天|季|日)?\s*$/u.exec(raw ?? '');
  return m ? (m[1] as TimelineSeason) : undefined;
}

/** 一个季节是哪几个月：简单历按农历口径（正月到三月是春），公历按 3–5 月是春。 */
function seasonMonths(cal: TimelineCalendar, season: TimelineSeason): number[] {
  const first = (cal === '简单历' ? 1 : 3) + SEASONS.indexOf(season) * 3;
  return [0, 1, 2].map((k) => ((first - 1 + k) % 12) + 1);
}

/** 这个月放不放得进这个季节：前后各宽一个月（季节交界处的「还冷」「已经热了」都算）。 */
export function monthFitsSeason(cal: TimelineCalendar, month: number, season: TimelineSeason): boolean {
  const months = seasonMonths(cal, season);
  const wide = new Set([((months[0] + 10) % 12) + 1, ...months, (months[2] % 12) + 1]);
  return wide.has(month);
}

// ---------------------------------------------------------------- 解析

/** 认得出的时段（只显示）：一个短词。 */
const PART_WORDS =
  /^(?:凌晨|拂晓|黎明|破晓|清晨|早晨|早上|上午|晌午|中午|正午|午后|下午|傍晚|黄昏|入夜|夜里|夜间|晚上|夜晚|深夜|半夜|午夜|白天|夜|[一二三四五]更(?:天)?)$/u;

const UNIT_DAYS: Record<string, (cal: TimelineCalendar) => number> = {
  天: () => 1,
  日: () => 1,
  周: () => 7,
  星期: () => 7,
  礼拜: () => 7,
  月: () => 30,
  年: (cal) => yearDays(cal),
};

const RELATIVE = /^([+＋\-－−])\s*(\?|？|[0-9０-９]+|[〇零一二两三四五六七八九十百千万]+|半)\s*(个)?\s*(天|日|周|星期|礼拜|月|年)?$/u;
const SAME_DAY = /^(?:同日|当日|当天|同一天|同天)$/u;
const NEXT_DAY = /^(?:次日|翌日|隔天|隔日|第二天|第二日)$/u;
const DAY_ANCHOR = /^(?:故事)?第\s*([0-9０-９]+)\s*天$/u;
const FLASHBACK = /^(?:回忆|倒叙|闪回|追忆)\s*(.*)$/u;
const SPAN = /^(?:历时|共|跨)\s*([0-9０-９]+|[〇零一二两三四五六七八九十百千万]+|半)\s*(个)?\s*(天|日|周|星期|月|年)$/u;

/**
 * 认一行的值（不含时段、历时）。`cal` 用来把 `+N 年` 换成天。认不出返回 undefined。
 * 日期锚点在这里只认形状（能不能换成第几天要看起点与上一章，推算时再算）。
 */
export function parseTimeValue(raw: string, cal: TimelineCalendar = '简单历'): TimelineValue | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  if (SAME_DAY.test(s)) {
    return { kind: 'delta', days: 0 };
  }
  if (NEXT_DAY.test(s)) {
    return { kind: 'delta', days: 1 };
  }
  const rel = RELATIVE.exec(s);
  if (rel) {
    if (rel[2] === '?' || rel[2] === '？') {
      return { kind: 'unknown' };
    }
    const unit = UNIT_DAYS[rel[4] ?? '天'](cal);
    const n = rel[2] === '半' ? 0.5 : parseNumber(rel[2]);
    if (n === undefined) {
      return undefined;
    }
    const days = Math.round(n * unit) * (rel[1] === '+' || rel[1] === '＋' ? 1 : -1);
    return Math.abs(days) <= TIME_DAYS_MAX ? { kind: 'delta', days: days === 0 ? 0 : days } : undefined;
  }
  const anchor = DAY_ANCHOR.exec(s);
  if (anchor) {
    const day = Number(asciiDigits(anchor[1]));
    return day >= 1 ? { kind: 'day', day } : undefined;
  }
  const back = FLASHBACK.exec(s);
  if (back) {
    return { kind: 'flashback', ago: cut(back[1].replace(/^[\s，,、]+/u, ''), AGO_MAX) };
  }
  return parseDate(s) ? { kind: 'date', text: s } : undefined;
}

function spanOf(raw: string, cal: TimelineCalendar): number | undefined {
  const m = SPAN.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const n = m[1] === '半' ? 0.5 : parseNumber(m[1]);
  if (n === undefined) {
    return undefined;
  }
  const days = Math.round(n * UNIT_DAYS[m[3]](cal));
  return days >= 1 && days <= TIME_DAYS_MAX ? days : undefined;
}

/**
 * 从行尾往前一段一段剥下 `〔标签：内容〕`（{@link TAIL_OPEN}）：每次找最后一个以已知标签开头、又一直到行尾才收口的那一段。
 * 认不出的括号（「（中秋）」这种）留在内容里。返回剥剩的前半截与剥下来的几段（从前往后）。
 */
function splitTails(text: string): { rest: string; tails: { label: string; body: string }[] } {
  let rest = text;
  const tails: { label: string; body: string }[] = [];
  for (;;) {
    const close = TAIL_CLOSE.exec(rest);
    if (!close) {
      break;
    }
    let last: RegExpExecArray | undefined;
    TAIL_OPEN.lastIndex = 0;
    for (let m = TAIL_OPEN.exec(rest); m; m = TAIL_OPEN.exec(rest)) {
      if (m.index + m[0].length <= close.index) {
        last = m;
      }
    }
    if (!last) {
      break;
    }
    tails.unshift({ label: last[1], body: rest.slice(last.index + last[0].length, close.index).trim() });
    rest = rest.slice(0, last.index).trimEnd();
  }
  return { rest, tails };
}

/** 一段的内容拆成「前面的字」与段尾的原文（`八月十五（中秋），开头后 2 天「今夜便是中秋」`）。 */
function splitQuote(body: string): { head: string; quote?: string } {
  const m = QUOTE_TAIL.exec(body);
  if (!m) {
    return { head: body.trim() };
  }
  const quote = m[1].trim();
  return { head: body.slice(0, m.index).trim(), ...(quote ? { quote } : {}) };
}

/** 〔文中：…〕：`八月十五（中秋），开头后 2 天「原文」`、`中秋「原文」`。日期与节日都认不出时 undefined。 */
function parseDateMark(body: string): TimelineDateMark | undefined {
  const { head, quote } = splitQuote(body);
  const parts = head
    .split(/[，,、；;]/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const m = /^(.*?)\s*[（(]\s*([^（）()]+?)\s*[）)]\s*$/u.exec(parts[0]);
  const first = (m ? m[1] : parts[0]).trim();
  let date: string | undefined;
  let festival = m ? m[2].trim() : undefined;
  if (parseMarkDate(first)) {
    date = first;
  } else if (!festival && first) {
    festival = first;
  }
  if (!date && !(festival && (festivalDate('简单历', festival) || festivalDate('公历', festival)))) {
    return undefined;
  }
  let offset = 0;
  for (const p of parts.slice(1)) {
    const k = /^(?:开头后|开头之后|本章第)\s*([0-9０-９]+|[〇零一二两三四五六七八九十百千万]+)\s*天$/u.exec(p);
    const n = k ? parseNumber(k[1]) : undefined;
    if (n !== undefined) {
      // 「本章第 3 天」是开头后 2 天。
      offset = /^本章第/u.test(p) ? Math.max(0, n - 1) : n;
    }
  }
  return { ...(date ? { date } : {}), ...(festival ? { festival } : {}), offset, ...(quote ? { quote } : {}) };
}

/** 〔季节：冬「原文」〕。 */
function parseSeasonMark(body: string): TimelineSeasonMark | undefined {
  const { head, quote } = splitQuote(body);
  const season = parseSeason(head);
  return season ? { season, ...(quote ? { quote } : {}) } : undefined;
}

/**
 * 认一行（项目符号已经去掉）。不是 `第 N 章` 开头的返回 undefined；`第 N 章` 认得出、值认不出的返回 `{ chapter, bad: true }`。
 * 行尾的〔文中〕〔季节〕认不出就当没写（只是辅助，第 1 条）。
 */
export function parseTimelineLine(
  line: string,
  cal: TimelineCalendar = '简单历'
): { entry: TimelineEntry } | { chapter: number; bad: true } | undefined {
  const head = LINE_HEAD.exec(line);
  if (!head) {
    return undefined;
  }
  const chapter = Number(head[1]);
  if (!(chapter > 0)) {
    return undefined;
  }
  const { rest, tails } = splitTails(line.slice(head[0].length));
  let basis: TimelineEntry['basis'];
  let dateMark: TimelineDateMark | undefined;
  let seasonMark: TimelineSeasonMark | undefined;
  for (const tail of tails) {
    if (tail.label === '文中') {
      dateMark ??= parseDateMark(tail.body);
    } else if (tail.label === '季节') {
      seasonMark ??= parseSeasonMark(tail.body);
    } else if (!basis) {
      const kind: TimelineBasisKind = tail.label === '证据' ? '依据' : (tail.label as TimelineBasisKind);
      basis = { kind, text: kind === '依据' ? unquote(tail.body) : tail.body.trim() };
    }
  }
  const parts = rest
    .split(/[，,、；;]/u)
    .map((p) => p.trim())
    .filter(Boolean);
  const value = parts.length > 0 ? parseTimeValue(parts[0], cal) : undefined;
  if (!value) {
    return { chapter, bad: true };
  }
  let part: string | undefined;
  let endPart: string | undefined;
  let span = 1;
  let ago = value.kind === 'flashback' ? value.ago : '';
  for (const p of parts.slice(1)) {
    const days = spanOf(p, cal);
    const range = PART_RANGE.exec(p);
    if (days !== undefined) {
      span = days;
    } else if (!part && !endPart && range && PART_WORDS.test(range[2].trim()) && (!range[1].trim() || PART_WORDS.test(range[1].trim()))) {
      part = range[1].trim() || undefined;
      endPart = range[2].trim();
    } else if (!part && PART_WORDS.test(p)) {
      part = p;
    } else if (value.kind === 'flashback' && !ago) {
      ago = cut(p, AGO_MAX);
    }
  }
  return {
    entry: {
      chapter,
      value: value.kind === 'flashback' ? { kind: 'flashback', ago } : value,
      ...(part ? { part } : {}),
      ...(endPart ? { endPart } : {}),
      span,
      ...(basis ? { basis } : {}),
      ...(dateMark ? { dateMark } : {}),
      ...(seasonMark ? { seasonMark } : {}),
    },
  };
}

function calendarOf(text: string): TimelineCalendar {
  return /公历|阳历|西历|gregorian/iu.test(text) ? '公历' : '简单历';
}

/** 读时间线。没有这份文件时传空串（`exists` 为 false）。怎么手改都不抛（第 1 条）。 */
export function parseTimelineFile(raw: string, relPath: string): Timeline {
  const text = raw ?? '';
  const { frontmatter, body } = parseMarkdown(text);
  const calendar = calendarOf(asString(frontmatter.calendar));
  const startText = asString(frontmatter.start).trim();
  const start = startText ? parseDate(startText) : undefined;
  const entries: TimelineEntry[] = [];
  const bad: number[] = [];
  const seen = new Set<number>();
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(BULLET, '').trim();
    const got = parseTimelineLine(line, calendar);
    if (!got) {
      continue;
    }
    const chapter = 'entry' in got ? got.entry.chapter : got.chapter;
    if (seen.has(chapter)) {
      continue;
    }
    seen.add(chapter);
    if ('entry' in got) {
      entries.push(got.entry);
    } else {
      bad.push(chapter);
    }
  }
  return {
    relPath,
    exists: text.trim() !== '',
    calendar,
    startText,
    ...(start && startOrdinal(calendar, start) !== undefined ? { start } : {}),
    entries,
    bad,
  };
}

/** 没有这份文件时的时间线（`readThreads` 给不出来时用）。 */
export function emptyTimeline(relPath: string): Timeline {
  return { relPath, exists: false, calendar: '简单历', startText: '', entries: [], bad: [] };
}

// ---------------------------------------------------------------- 推算（现算，不落盘）

/** 一章的样子。`dated`：开头照正文写明的日期（〔文中〕）对齐过（2026-10-24 重做）。 */
export type TimelineDayState = 'evidence' | 'guess' | 'unknown' | 'missing' | 'anchor' | 'dated' | 'flashback' | 'bad';

export interface TimelineDay {
  chapter: number;
  state: TimelineDayState;
  /** 开头是故事第几天（回忆的章缺席）。 */
  start?: number;
  /** 结尾是第几天（= 开头 + 跨度 − 1）。 */
  end?: number;
  /** 比上一章结尾晚几天（第一章、回忆缺席）。 */
  delta?: number;
  span: number;
  part?: string;
  endPart?: string;
  /** 回忆：大约多久以前。 */
  ago?: string;
  basis?: TimelineEntry['basis'];
  dateMark?: TimelineDateMark;
  seasonMark?: TimelineSeasonMark;
  /**
   * 照〔文中〕对齐过：按前文推下来是第几天（`estimate`）、对齐差了几天（`drift` = 开头 − estimate）；`unknown`：这一行本来是 `+?`
   * （差几天是预料之中的，对账不报，⚑2）。
   */
  aligned?: { estimate: number; drift: number; unknown?: true };
  /**
   * 〔文中〕没拿来对齐、又和这一章对不上：正文写的是第几天（`day`），为什么没对齐（`why`）——作者的锚点（`anchor`）、第 1 章就是
   * 起点（`start`），或者正文只写了日、没写月（`dayOnly`：月份可能差出去，只对账不对齐，试跑之后定的）。
   */
  conflict?: { day: number; why: 'anchor' | 'start' | 'dayOnly' };
}

export interface TimelineCalc {
  /** 第 1 章到文件里出现过的最大章号（`upTo` 截过的），一章一项。 */
  days: TimelineDay[];
  /** 文件里写到第几章（认得出、认不出的行都算）。没有一行是 0。 */
  last: number;
  /** 故事里过了几天（走到的最远那一天，一般就是最后一章的结尾）。一行都没有是 0。 */
  elapsed: number;
}

/**
 * 从第 1 章往后推（设计稿「推算」）：没有这一行的、`+?` 的、认不出的按紧接上一章（开头 = 上一章结尾）算；锚点就是那一天；回忆
 * 不推进时间；第一章（第一个不是回忆的章）的相对值不算，开头是第 1 天。`upTo` 只推到第几章（写第 N 章时传 N − 1）。
 *
 * 2026-10-24 重做多一步（docs/design/plans/2026-10-24-story-timeline-rework.md「二」）：有〔文中〕、填了起点时，按正文写明的那一天
 * 对齐（取离推算最近的那一个，⚑1），后面的章跟着顺延——一路累加的误差到这里清零。作者的锚点与第 1 章（就是起点）不对齐，对不上只记下来。
 */
export function computeTimeline(tl: Timeline, upTo?: number): TimelineCalc {
  const byNo = new Map(tl.entries.map((e) => [e.chapter, e]));
  const bad = new Set(tl.bad);
  const fileLast = Math.max(0, ...tl.entries.map((e) => e.chapter), ...tl.bad);
  const last = upTo === undefined ? fileLast : Math.min(fileLast, upTo);
  const days: TimelineDay[] = [];
  let prevEnd = 0;
  let furthest = 0;
  let started = false;
  for (let no = 1; no <= last; no++) {
    const e = byNo.get(no);
    const marks = { ...(e?.dateMark ? { dateMark: e.dateMark } : {}), ...(e?.seasonMark ? { seasonMark: e.seasonMark } : {}) };
    if (e?.value.kind === 'flashback') {
      days.push({ chapter: no, state: 'flashback', span: e.span, ...(e.value.ago ? { ago: e.value.ago } : {}), ...(e.basis ? { basis: e.basis } : {}), ...marks });
      continue;
    }
    let start: number | undefined;
    let state: TimelineDayState;
    if (!e) {
      state = bad.has(no) ? 'bad' : 'missing';
    } else if (e.value.kind === 'day') {
      start = e.value.day;
      state = 'anchor';
    } else if (e.value.kind === 'date') {
      start = dayOfDate(tl, e.value.text, prevEnd);
      state = start === undefined ? 'bad' : 'anchor';
    } else if (e.value.kind === 'unknown') {
      state = 'unknown';
    } else {
      start = started ? prevEnd + e.value.days : 1;
      // 机器写的带依据或推测；没有那一段的、或者值改了却还挂着〔推不出〕的，是作者写的。
      state = e.basis?.kind === '依据' ? 'evidence' : e.basis?.kind === '推测' ? 'guess' : 'anchor';
    }
    if (start === undefined) {
      start = started ? prevEnd : 1;
    }
    const span = e?.span ?? 1;
    let aligned: TimelineDay['aligned'];
    let conflict: TimelineDay['conflict'];
    const md = e?.dateMark ? markDate(tl.calendar, e.dateMark) : undefined;
    if (e?.dateMark && md && tl.start && state !== 'bad') {
      const offset = Math.max(0, Math.min(e.dateMark.offset, span - 1));
      const at = dayNearest(tl, md, start + offset);
      const why = state === 'anchor' ? 'anchor' : !started ? 'start' : md.m === 0 ? 'dayOnly' : undefined;
      if (at !== undefined && at - offset !== start) {
        if (why) {
          conflict = { day: at - offset, why };
        } else {
          aligned = { estimate: start, drift: at - offset - start, ...(state === 'unknown' ? { unknown: true as const } : {}) };
          start = at - offset;
        }
      }
      if (at !== undefined && !why) {
        state = 'dated';
      }
    }
    const end = start + span - 1;
    days.push({
      chapter: no,
      state,
      start,
      end,
      ...(started ? { delta: start - prevEnd } : {}),
      span,
      ...(e?.part ? { part: e.part } : {}),
      ...(e?.endPart ? { endPart: e.endPart } : {}),
      ...(e?.basis ? { basis: e.basis } : {}),
      ...marks,
      ...(aligned ? { aligned } : {}),
      ...(conflict !== undefined ? { conflict } : {}),
    });
    prevEnd = end;
    furthest = Math.max(furthest, end);
    started = true;
  }
  // 故事里过了几天：走到的最远那一天（往回跳、照正文往回对齐的章不把它拉回去）。
  return { days, last, elapsed: started ? furthest : 0 };
}

// ---------------------------------------------------------------- 对账（现算，0 次，2026-10-24 重做）

export type TimelineIssueKind = 'drift' | 'conflict' | 'season' | 'backward' | 'unknownRun';

/** 对账里的一条：只提醒、不拦，挂在工程页「时间线」组与总览上。 */
export interface TimelineIssue {
  kind: TimelineIssueKind;
  /** 哪一章（连着推不出的是第一章）。 */
  chapter: number;
  /** 连着推不出的最后一章。 */
  to?: number;
  text: string;
}

/** 文中日期偏差到几天才进对账（⚑3：差 1 天多半是「深夜算不算第二天」）。 */
export const TIME_DRIFT_WARN = 2;
/** 连着几章推不出才报。 */
export const TIME_UNKNOWN_RUN = 3;
/** 一章跨了多久以上不查季节（跨了季节，查不出对错）。 */
const SEASON_CHECK_MAX_SPAN = 90;

/**
 * 对账（设计稿「二 · 对账」）：文中日期对不上（对齐时差得多）、你定的和正文对不上、季节对不上、往回跳又没标回忆、连着推不出。
 * 按章号排。日期、季节两类要填了起点才查得了。
 */
export function timelineIssues(tl: Timeline, calc: TimelineCalc): TimelineIssue[] {
  const out: TimelineIssue[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= TIME_UNKNOWN_RUN) {
      out.push({ kind: 'unknownRun', chapter: run[0], to: run[run.length - 1], text: `第 ${run[0]}–${run[run.length - 1]} 章连着推不出（都按紧接上一章算）` });
    }
    run = [];
  };
  for (const d of calc.days) {
    if (d.state === 'unknown') {
      run.push(d.chapter);
    } else if (d.state !== 'flashback') {
      flush();
    }
    if (d.start === undefined) {
      continue;
    }
    const mark = d.dateMark ? describeDateMark(d.dateMark) : '';
    if (d.aligned && !d.aligned.unknown && Math.abs(d.aligned.drift) >= TIME_DRIFT_WARN) {
      out.push({
        kind: 'drift',
        chapter: d.chapter,
        text: `第 ${d.chapter} 章：前面推下来是${dayLabel(tl, d.aligned.estimate).full}，正文写${mark}（差 ${Math.abs(d.aligned.drift)} 天），已按正文对齐`,
      });
    }
    // 只写了日的差 1 天不报（同对齐的偏差，⚑3）；作者的锚点、起点对不上一天也报。
    if (d.conflict && (d.conflict.why !== 'dayOnly' || Math.abs(d.conflict.day - d.start) >= TIME_DRIFT_WARN)) {
      const here = dayLabel(tl, d.start).full;
      out.push({
        kind: 'conflict',
        chapter: d.chapter,
        text:
          d.conflict.why === 'start'
            ? `第 ${d.chapter} 章：起点是${tl.startText}，正文写${mark}`
            : d.conflict.why === 'anchor'
              ? `第 ${d.chapter} 章：你定的是${here}，正文写${mark}`
              : `第 ${d.chapter} 章：推出来是${here}，正文写${mark}（只写了日，没按它对齐）`,
      });
    }
    if (d.seasonMark && tl.start && d.end !== undefined && d.span <= SEASON_CHECK_MAX_SPAN) {
      let fits = false;
      for (let day = d.start; day <= d.end && !fits; day++) {
        const m = monthOfDay(tl, day);
        fits = m === undefined || monthFitsSeason(tl.calendar, m, d.seasonMark.season);
      }
      if (!fits) {
        const q = d.seasonMark.quote ?? '';
        const quote = q ? `（「${cut(q, 20)}${[...q].length > 20 ? '…' : ''}」）` : '';
        out.push({
          kind: 'season',
          chapter: d.chapter,
          text: `第 ${d.chapter} 章：推出来是${dayLabel(tl, d.start).monthName ?? dayLabel(tl, d.start).full}，正文说是${d.seasonMark.season}天${quote}`,
        });
      }
    }
    if ((d.state === 'evidence' || d.state === 'guess') && d.delta !== undefined && d.delta < 0) {
      out.push({ kind: 'backward', chapter: d.chapter, text: `第 ${d.chapter} 章：比上一章往回跳了 ${-d.delta} 天，又没标回忆` });
    }
  }
  flush();
  return out.sort((a, b) => a.chapter - b.chapter);
}

/**
 * 起点建议（设计稿「二」）：没有起点、正文里出现过〔文中〕日期时，按第一次出现的那一处倒推第 1 章是哪天（照那个日期的写法）。
 * 有起点、一处都没有时 undefined。
 */
export function suggestStart(tl: Timeline, calc: TimelineCalc): { text: string; chapter: number; mark: string } | undefined {
  if (tl.start) {
    return undefined;
  }
  for (const d of calc.days) {
    if (!d.dateMark || d.start === undefined) {
      continue;
    }
    const md = markDate(tl.calendar, d.dateMark);
    // 只写了日的推不出起点是几月。
    const o = md && md.m > 0 ? ordinalOf(tl.calendar, md.y ?? (tl.calendar === '简单历' ? 1 : GREGORIAN_YEARLESS), md.m, md.d) : undefined;
    if (!md || o === undefined) {
      continue;
    }
    const offset = Math.max(0, Math.min(d.dateMark.offset, d.span - 1));
    const first = fromOrdinal(tl.calendar, o - (d.start + offset - 1));
    return { text: formatYmd(first, md.style, md.y === undefined ? '' : undefined).full, chapter: d.chapter, mark: describeDateMark(d.dateMark) };
  }
  return undefined;
}

// ---------------------------------------------------------------- 怎么说

/** 一章开头那一天的说法：`大衍三年三月十四 清晨`、`第 8 天 傍晚`。回忆写 `回忆（约二十年前）`。 */
export function describeDay(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return `回忆${d.ago ? `（${d.ago}）` : ''}`;
  }
  return `${dayLabel(tl, d.start).full}${d.part ? ` ${d.part}` : ''}`;
}

/** 一章从头到尾：`三月十四 清晨 → 夜里`、`三月十四 清晨 → 三月十六 夜里`；同一天、没有结尾时段的同 {@link describeDay}。 */
export function describeDayRange(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  const head = describeDay(tl, d);
  if (d.state === 'flashback' || d.start === undefined) {
    return head;
  }
  if (d.span > 1 && d.end !== undefined) {
    return `${head} → ${dayLabel(tl, d.end).full}${d.endPart ? ` ${d.endPart}` : ''}`;
  }
  return d.endPart ? `${head} → ${d.endPart}` : head;
}

/** 「故事里过了 46 天」那个数怎么说：一年以上另注约几年（按历法的一年）。 */
export function describeElapsed(tl: Pick<Timeline, 'calendar'>, days: number): string {
  const years = days / yearDays(tl.calendar);
  return years >= 1 ? `${days} 天（约 ${years >= 10 ? Math.round(years) : Math.round(years * 10) / 10} 年）` : `${days} 天`;
}

/** 比上一章晚多久的说法：`+2 天`、`同一天`、`往回 3 天`。 */
export function describeDelta(delta: number): string {
  return delta === 0 ? '同一天' : delta > 0 ? `+${delta} 天` : `往回 ${-delta} 天`;
}

/**
 * 写第 `no` 章（或拆从第 `no` 章起的细纲）时，「上一章的时间」那一句：只看第 `no` 章之前的行（`asOf`）。往前找最近一个不是回忆的章；
 * 一行都没有返回 undefined。`gap` 是那一章与第 `no` 章之间还没记时间的章数。
 */
export function lastKnownBefore(tl: Timeline, no: number): { day: TimelineDay; gap: number } | undefined {
  const calc = computeTimeline(tl, no - 1);
  for (let i = calc.days.length - 1; i >= 0; i--) {
    const d = calc.days[i];
    if (d.state === 'flashback' || d.state === 'missing' || d.state === 'bad') {
      continue;
    }
    return { day: d, gap: no - 1 - d.chapter };
  }
  return undefined;
}

/** 认时间时「前面几章的时间」最多列几章。 */
export const RECENT_TIME_CHAPTERS = 5;

/**
 * 认时间（同步、补推、重推）交给模型的「前面几章的时间」（2026-10-24 重做，设计稿「三 · 输入」）：只看第 `no` 章之前的行，最近
 * {@link RECENT_TIME_CHAPTERS} 章一章一行，带结尾时段（本章开头接着哪个时刻）。第 1 章、前面一行都没有各说一句。
 */
export function recentTimeNote(tl: Timeline, no: number, count = RECENT_TIME_CHAPTERS): string {
  if (no <= 1) {
    return '这是第 1 章：days 写 0。';
  }
  const calc = computeTimeline(tl, no - 1);
  if (!calc.days.some((d) => d.state !== 'missing')) {
    return '前面的章还没记时间：只按上一章的结尾与本章正文判，判不出写 null。';
  }
  const from = Math.max(1, no - count);
  const lines: string[] = [];
  for (let c = from; c < no; c++) {
    const d = calc.days[c - 1];
    if (!d || d.state === 'missing') {
      lines.push(`第 ${c} 章：还没记（按紧接上一章算）`);
    } else if (d.state === 'flashback') {
      lines.push(`第 ${c} 章：整章是回忆${d.ago ? `（${d.ago}）` : ''}，不推进时间`);
    } else if (d.state === 'bad') {
      lines.push(`第 ${c} 章：那一行认不出（按紧接上一章算）`);
    } else {
      const delta = d.delta !== undefined ? `，比上一章 ${describeDelta(d.delta)}` : '';
      const note = d.state === 'unknown' ? '，推不出、按紧接上一章算' : d.state === 'anchor' ? '，作者定的' : d.state === 'dated' ? '，正文写明' : '';
      const days = d.span > 1 && d.end !== undefined ? `故事第 ${d.start}–${d.end} 天` : `故事第 ${d.start} 天`;
      lines.push(`第 ${c} 章：${describeDayRange(tl, d)}（${days}${delta}${note}）`);
    }
  }
  return lines.join('\n');
}

/** 这个月是哪个季节（不放宽，同 {@link monthFitsSeason} 的口径）。 */
export function seasonOfMonth(cal: TimelineCalendar, month: number): TimelineSeason {
  return SEASONS.find((s) => seasonMonths(cal, s).includes(month)) ?? '春';
}

/** 一天不带年份的短说法：`三月十二`、`3月12日`；没有起点 `第 8 天`。 */
function shortDay(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): string {
  const l = dayLabel(tl, day);
  if (!l.monthName || !tl.start) {
    return l.full;
  }
  return tl.start.style.day === 'num' || tl.start.style.day === 'iso' || tl.start.style.day === 'slash' ? `${l.monthName}${l.short}日` : `${l.monthName}${l.short}`;
}

/** 写正文、拆细纲时「最近几章」那一句最多带几章。 */
const CONTEXT_RECENT_CHAPTERS = 4;

/**
 * 写正文、拆细纲时上下文里「故事时间」那一段（2026-10-24，设计稿「三」；同日重做扩成几行：结尾时段、眼下的季节、最近几章的节奏）：
 * 只看第 `no` 章之前的行（拆细纲传这一批的第一章）。前面一行能推出来的都没有返回 undefined（什么都不出）。
 *
 * ```
 * 上一章（第 11 章）：大衍三年三月十四 傍晚 → 深夜（故事第 8 天）。眼下是春天。
 * 最近几章：第 8 章 三月十二（+1 天）；第 9 章 同一天；第 10 章 推不出；第 11 章 三月十四（+2 天）。
 * 本章的时间要接得上；本章细纲「时间地点」写了的照它。
 * ```
 */
export function timeContextText(tl: Timeline, no: number, stage: 'write' | 'plot'): string | undefined {
  const last = lastKnownBefore(tl, no);
  if (!last) {
    return undefined;
  }
  const d = last.day;
  const when = describeDaySpan(tl, d);
  const gap = last.gap > 0 ? `（第 ${d.chapter + 1}${last.gap > 1 ? `–${no - 1}` : ''} 章的时间还没记）` : '';
  const month = tl.start && d.end !== undefined ? monthOfDay(tl, d.end) : undefined;
  const season = month !== undefined ? `眼下是${seasonOfMonth(tl.calendar, month)}天。` : '';
  const calc = computeTimeline(tl, no - 1);
  const recent: string[] = [];
  for (let c = Math.max(1, no - CONTEXT_RECENT_CHAPTERS); c < no; c++) {
    const x = calc.days[c - 1];
    if (!x || x.state === 'missing' || x.state === 'bad') {
      recent.push(`第 ${c} 章 没记`);
    } else if (x.state === 'flashback') {
      recent.push(`第 ${c} 章 回忆`);
    } else if (x.state === 'unknown') {
      recent.push(`第 ${c} 章 推不出`);
    } else if (x.delta === 0) {
      recent.push(`第 ${c} 章 同一天`);
    } else {
      recent.push(`第 ${c} 章 ${shortDay(tl, x.start!)}${x.delta !== undefined ? `（${describeDelta(x.delta)}）` : ''}`);
    }
  }
  const rhythm = recent.length > 1 ? `\n最近几章：${recent.join('；')}。` : '';
  return stage === 'write'
    ? `${last.gap > 0 ? `已记到第 ${d.chapter} 章` : `上一章（第 ${d.chapter} 章）`}：${when}${gap}。${season}${rhythm}\n本章的时间要接得上；本章细纲「时间地点」写了的照它。`
    : `已写到第 ${d.chapter} 章：${when}${gap}。${season}${rhythm}\n细纲「时间地点」写清每章比上一章晚多久（当天、次日、三天后……），不要和前面打架。`;
}

/** `大衍三年三月十四 清晨 → 夜里（故事第 8 天）`，跨了几天的另说结尾。 */
export function describeDaySpan(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  if (d.span > 1 && d.end !== undefined) {
    return `${describeDay(tl, d)}（故事第 ${d.start} 天）起，历时 ${d.span} 天，到${dayLabel(tl, d.end).full}${d.endPart ? ` ${d.endPart}` : ''}（第 ${d.end} 天）`;
  }
  return `${describeDayRange(tl, d)}（故事第 ${d.start} 天）`;
}

// ---------------------------------------------------------------- 写入

/** 新建时间线时的整份文件。 */
export const TIMELINE_TEMPLATE = [
  '---',
  'calendar: 简单历',
  'start: ',
  'generatedBy: novel-forge',
  '---',
  '',
  `# ${TIMELINE_NAME}`,
  '',
  '> 一章一行，写的是这一章开头比上一章结尾晚多久；同步时由机器按正文推。日期在叙事线页签和总览里看。',
  '> 起点：在上面 start 后面写第 1 章那一天（如「大衍三年三月初七」「2026-03-07」），不写只显示第几天；calendar 写「简单历」（每月 30 天）或「公历」。',
  '> 行尾带〔依据〕〔推测〕〔推不出〕的是机器写的，同步、重推时照新推的换；要定死哪一章，把「+N 天」改成具体日期（「八月十五」）或「第 N 天」（阿拉伯数字），或者删掉行尾那一段，后面的章跟着顺延。',
  '> 〔文中〕是正文写明的日期或节日，推算时照它对齐；〔季节〕只拿来对账。',
  '',
].join('\n');

/** 值怎么写回文件。 */
export function renderTimeValue(v: TimelineValue): string {
  switch (v.kind) {
    case 'delta':
      return `${v.days < 0 ? '-' : '+'}${Math.abs(v.days)} 天`;
    case 'unknown':
      return '+?';
    case 'flashback':
      return `回忆${v.ago ? `，${v.ago}` : ''}`;
    case 'day':
      return `第 ${v.day} 天`;
    default:
      return v.text;
  }
}

/** 〔文中：八月十五（中秋），开头后 2 天「原文」〕。 */
function renderDateMark(m: TimelineDateMark): string {
  return `〔文中：${describeDateMark(m)}${m.offset > 0 ? `，开头后 ${m.offset} 天` : ''}${m.quote ? `「${m.quote}」` : ''}〕`;
}

/**
 * 一行（不带项目符号）：`第 4 章：+1 天，清晨 → 夜里，历时 2 天〔依据：「次日清晨，雨停了」〕〔文中：八月十五（中秋）「…」〕〔季节：秋「…」〕`。
 */
export function renderTimelineLine(e: TimelineEntry): string {
  const basis = e.basis ? `〔${e.basis.kind}：${e.basis.kind === '依据' ? `「${e.basis.text}」` : e.basis.text}〕` : '';
  const part = e.endPart ? `，${e.part ? `${e.part} ` : ''}→ ${e.endPart}` : e.part ? `，${e.part}` : '';
  const season = e.seasonMark ? `〔季节：${e.seasonMark.season}${e.seasonMark.quote ? `「${e.seasonMark.quote}」` : ''}〕` : '';
  return `第 ${e.chapter} 章：${renderTimeValue(e.value)}${part}${e.span > 1 ? `，历时 ${e.span} 天` : ''}${basis}${e.dateMark ? renderDateMark(e.dateMark) : ''}${season}`;
}

/** {@link upsertTimelineEntry} 做了什么。 */
export type TimelineWrite = 'added' | 'replaced' | 'kept';

/**
 * 这一行是不是机器写的（2026-10-24 重做，设计稿「三 · 写盘」）：相对量、回忆带〔依据〕〔推测〕，或者 `+?` 带〔推不出〕。作者写的日期、
 * 「第 N 天」、没有行尾那一段的、改了值却还挂着〔推不出〕的都是作者的。改了值又留着〔依据〕〔推测〕的分不出来，当机器写的（⚑7，
 * 文件开头的说明写着）。
 */
export function isMachineEntry(e: TimelineEntry): boolean {
  if (e.value.kind === 'unknown') {
    return e.basis?.kind === '推不出';
  }
  if (e.value.kind === 'delta' || e.value.kind === 'flashback') {
    return e.basis?.kind === '依据' || e.basis?.kind === '推测';
  }
  return false;
}

/**
 * 补推时机器该不该换掉已有的那一行（只填空，设计稿「谁能写什么」）：还是 `+?`〔推不出〕（作者没动过）；或者〔依据〕那句原文已经不在
 * 正文里了。其余（作者写的、改过的、〔推测〕的、依据还在的、认不出的）都不换。
 */
export function machineMayReplace(existing: TimelineEntry, chapterText: string): boolean {
  if (existing.value.kind === 'unknown' && existing.basis?.kind === '推不出') {
    return true;
  }
  if (existing.basis?.kind === '依据' && existing.basis.text) {
    return !quoteFound(indexText(chapterText), existing.basis.text);
  }
  return false;
}

/**
 * 写入的口径：`fill` 只填空（补推）；`refresh` 机器写的行一律照新推的换（同步、重推，⚑7）。两种都不碰作者的行与认不出的行。
 */
export type TimelineWriteMode = 'fill' | 'refresh';

/**
 * 把第 N 章的一行写进时间线原文：还没有这份文件按模板新建；没有这一章的行就按章号插到对的位置（项目符号沿用已有的写法）；已有的
 * 按 `mode` 决定换不换（`fill`：{@link machineMayReplace}；`refresh`：{@link isMachineEntry}），其余原样。别的行、frontmatter、BOM 与
 * 换行符一个字不动。
 */
export function upsertTimelineEntry(
  raw: string,
  entry: TimelineEntry,
  chapterText: string,
  mode: TimelineWriteMode = 'fill'
): { text: string; action: TimelineWrite } {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  let from = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    from = end > 0 ? end + 1 : 0;
  }
  const cal = calendarOf(asString(parseMarkdown(source).frontmatter.calendar));
  let bullet: string | undefined;
  let before = -1;
  let after = -1;
  for (let i = from; i < lines.length; i++) {
    const m = BULLET.exec(lines[i]);
    const got = parseTimelineLine(lines[i].replace(BULLET, '').trim(), cal);
    if (!got) {
      continue;
    }
    if (m && bullet === undefined) {
      bullet = m[0];
    }
    const chapter = 'entry' in got ? got.entry.chapter : got.chapter;
    if (chapter === entry.chapter) {
      const may = 'entry' in got && (mode === 'refresh' ? isMachineEntry(got.entry) : machineMayReplace(got.entry, chapterText));
      const row = `${m ? m[0] : ''}${renderTimelineLine(entry)}`;
      if (may && lines[i] !== row) {
        lines[i] = row;
        return { text: bom + lines.join(eol), action: 'replaced' };
      }
      return { text: raw, action: 'kept' };
    }
    if (chapter < entry.chapter) {
      before = i;
    } else if (after < 0) {
      after = i;
    }
  }
  const row = `${bullet ?? '- '}${renderTimelineLine(entry)}`;
  if (before >= 0) {
    lines.splice(before + 1, 0, row);
  } else if (after >= 0) {
    lines.splice(after, 0, row);
  } else {
    // 一行都还没有：接在正文最后一行有字的后面（隔一个空行），文件末尾留一个换行。
    let tail = lines.length - 1;
    while (tail >= from && !lines[tail].trim()) {
      tail--;
    }
    lines.splice(tail + 1, lines.length - tail - 1, '', row, '');
  }
  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }
  return { text: bom + lines.join(eol), action: 'added' };
}

// ---------------------------------------------------------------- 作者在界面上改（2026-10-24 重做，设计稿「五」）

/**
 * 「改时间…」那一问的字认不认得（写法同文件里一行冒号后面那一截：`八月十五`、`第 20 天`、`+3 天`、`同日`、`回忆`，可以带时段与历时）。
 * 认得返回 undefined，认不出返回说给作者听的一句。清空（删掉这一行）也认。
 */
export function checkTimeInput(text: string, tl: Pick<Timeline, 'calendar' | 'start'>): string | undefined {
  const t = text.trim();
  if (!t) {
    return undefined;
  }
  const got = parseTimelineLine(`第 1 章：${t}`, tl.calendar);
  if (!got || !('entry' in got)) {
    return `认不出「${t}」：写「八月十五」「第 20 天」「+3 天」「同日」「次日」「回忆」这几种，可以带时段（「八月十五，傍晚」）`;
  }
  if (got.entry.value.kind === 'date' && !tl.start) {
    return '还没填起点，写日期算不出是第几天：先点时间线组第一行填起点，或者写「第 N 天」「+N 天」';
  }
  return undefined;
}

/**
 * 把第 N 章那一行改成作者给的值（「改时间…」）：值换成作者写的、**去掉行尾的〔依据〕〔推测〕〔推不出〕**（改过就是作者定的，机器不再动，
 * ⚑11），时段、历时、〔文中〕〔季节〕没另写就照留；作者写了时段、历时的照作者的。清空 = 删掉这一行（留给机器重推）。没有这一行就按章号
 * 插进去；还没有这份文件按模板新建。别的行、frontmatter 一个字不动。字认不出返回 undefined（调用方先用 {@link checkTimeInput} 拦）。
 */
export function setTimelineValue(raw: string, chapter: number, text: string): { text: string; action: 'added' | 'replaced' | 'removed' | 'kept' } | undefined {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const cal = calendarOf(asString(parseMarkdown(source).frontmatter.calendar));
  const wanted = text.trim();
  const typed = wanted ? parseTimelineLine(`第 ${chapter} 章：${wanted}`, cal) : undefined;
  if (wanted && (!typed || !('entry' in typed))) {
    return undefined;
  }
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  let from = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    from = end > 0 ? end + 1 : 0;
  }
  for (let i = from; i < lines.length; i++) {
    const m = BULLET.exec(lines[i]);
    const got = parseTimelineLine(lines[i].replace(BULLET, '').trim(), cal);
    if (!got || ('entry' in got ? got.entry.chapter : got.chapter) !== chapter) {
      continue;
    }
    if (!wanted) {
      lines.splice(i, 1);
      return { text: bom + lines.join(eol), action: 'removed' };
    }
    const old = 'entry' in got ? got.entry : undefined;
    const row = `${m ? m[0] : ''}${renderTimelineLine(merged(chapter, (typed as { entry: TimelineEntry }).entry, wanted, old))}`;
    if (row === lines[i]) {
      return { text: raw, action: 'kept' };
    }
    lines[i] = row;
    return { text: bom + lines.join(eol), action: 'replaced' };
  }
  if (!wanted) {
    return { text: raw, action: 'kept' };
  }
  const entry = merged(chapter, (typed as { entry: TimelineEntry }).entry, wanted, undefined);
  const r = upsertTimelineEntry(source, entry, '', 'fill');
  return { text: r.text, action: 'added' };
}

/** 作者写的值并上原来那一行还用得着的几样（时段、历时、〔文中〕〔季节〕）。行尾的依据一律去掉。 */
function merged(chapter: number, typed: TimelineEntry, text: string, old: TimelineEntry | undefined): TimelineEntry {
  const saidSpan = /(?:历时|共|跨)\s*\S+\s*(?:天|日|周|星期|月|年)/u.test(text);
  return {
    chapter,
    value: typed.value,
    ...((typed.part ?? old?.part) ? { part: typed.part ?? old?.part } : {}),
    ...((typed.endPart ?? old?.endPart) ? { endPart: typed.endPart ?? old?.endPart } : {}),
    span: saidSpan ? typed.span : (old?.span ?? 1),
    ...((typed.dateMark ?? old?.dateMark) ? { dateMark: typed.dateMark ?? old?.dateMark } : {}),
    ...((typed.seasonMark ?? old?.seasonMark) ? { seasonMark: typed.seasonMark ?? old?.seasonMark } : {}),
  };
}

/**
 * 改 frontmatter 的 `calendar` 与 `start`（时间线组第一行「改历法与起点」「填为起点」）：只换这两个键那一行，没有就加在收口的 `---`
 * 前面；还没有这份文件按模板新建。别的一个字不动。
 */
export function setTimelineHead(raw: string, head: { calendar?: TimelineCalendar; start?: string }): string {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---' || lines.findIndex((l, i) => i > 0 && l.trim() === '---') < 0) {
    lines.unshift('---', '---');
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const set = (key: string, value: string) => {
    const at = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${key}\\s*:`, 'u').test(l));
    const row = `${key}: ${value}`;
    if (at > 0) {
      lines[at] = row;
    } else {
      lines.splice(lines.findIndex((l, i) => i > 0 && l.trim() === '---'), 0, row);
    }
  };
  if (head.calendar) {
    set('calendar', head.calendar);
  }
  if (head.start !== undefined) {
    set('start', head.start.trim());
  }
  return bom + lines.join(eol);
}

// ---------------------------------------------------------------- 模型的输出

/** 模型报的一章的时间 → 一行（设计稿「一、同步时推」的校验）。 */
export interface VerifiedTime {
  entry: TimelineEntry;
  /** 校验时动过的地方（证据换成了最接近的原句、证据找不到改记推测……），只进日志。 */
  notes: string[];
}

function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(asciiDigits(v.trim()).replace(/^＋/u, '+')) : NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/**
 * 一句里写没写着时间（设计稿「三 · 校验」，试跑之后加的）：时段与天色（夜、晨、黄昏、天亮）、过了多久（三日、半月、一年）、日子（次日、
 * 昨夜、明儿、三月初七、二十一日）、季节、节令。只写场面、动作的句子当不得时间的依据——模型常拿本章第一句充数。
 */
const TIME_HINT = new RegExp(
  [
    '[夜晨晓曉昼晝午昏晚宵暮]',
    '天[光色亮明黑边邊]|日[头頭光子]|月[光色亮]|太阳|太陽|朝阳|朝陽|夕阳|夕陽|旭日',
    '[一二两兩三四五六七八九十百千几幾数數半0-9０-９]+\\s*[个個]?\\s*(?:天|日|夜|晚|月|年|载|載|旬|周|週|星期|时辰|時辰|更)',
    '[春夏秋冬]|节|節',
    '次日|翌日|隔[天日]|[昨今明当當那这這同][天日晚夜早儿兒朝]',
    '[正腊冬]月|[一二三四五六七八九十]+月|初[一二三四五六七八九十]|[十廿卅二三]?[十]?[一二三四五六七八九十][日号]',
  ].join('|'),
  'u'
);

/** 这一句能不能当时间的依据。 */
export function mentionsTime(sentence: string): boolean {
  return TIME_HINT.test(sentence);
}

/** 正文里找一句：逐字找得到原样返回；找不到换最接近的一句（够长时）；都不行返回 undefined。`changed` 说有没有换。 */
function locateEvidence(index: QuoteIndex, text: string, quote: string): { quote: string; changed: boolean } | undefined {
  if (!quote) {
    return undefined;
  }
  if (quoteFound(index, quote)) {
    return { quote, changed: false };
  }
  const near = normalizeQuote(quote).length >= 4 ? nearestSentence(text, quote, TIME_BASIS_MAX) : undefined;
  return near ? { quote: near.sentence, changed: true } : undefined;
}

/** 一句里写日期的地方（不锚头尾）：`八月十五`、`腊月廿三日`、`3月7日`。 */
const DATE_IN_TEXT =
  /(?:[0-9０-９〇零○一二两三四五六七八九十百千万]+\s*年\s*)?(?:[0-9０-９]{1,2}|十[一二]|[一二两三四五六七八九十]|正|冬|腊|臘)\s*月\s*(?:初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅]{1,3})\s*[日号號]?/gu;

/** 原文里写没写着这一天（防编，设计稿「三 · 校验」）：写着这个节日，或者有一处日期与它同月同日。 */
function quoteMentionsDate(quote: string, date: CalendarDate | undefined, festival: string | undefined): boolean {
  if (festival && quote.includes(festivalKey(festival))) {
    return true;
  }
  if (!date) {
    return false;
  }
  for (const m of quote.matchAll(DATE_IN_TEXT)) {
    const d = parseDate(m[0]);
    if (d && d.m === date.m && d.d === date.d) {
      return true;
    }
  }
  if (date.m === 0) {
    for (const m of quote.matchAll(DAY_IN_TEXT)) {
      if (parseNumber(m[1]) === date.d) {
        return true;
      }
    }
  }
  return false;
}

/** 一句里只写了日的地方：`二十一日`、`初三`、`十五那天`。 */
const DAY_IN_TEXT = /(初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅]{1,3})\s*(?:[日号號]|那[天日])/gu;

/**
 * 校验模型给的一章的时间（认时间的 `times` 里的一项，2026-10-24 重做；老的认事件 `time` 也认）。`raw` 不是对象返回 undefined（模型
 * 没给：不写这一行）。
 *
 * - `days` 是整数、绝对值不超过 {@link TIME_DAYS_MAX}；`null`、缺席、认不出 → `+?`〔推不出〕。
 * - `jumps`：本章里往后跳的每一处，天数 0 起、证据逐字（找不到换最接近的原句，还找不到这一跳不算）；历时 = 1 + 各处天数。没给 `jumps`
 *   时认老的 `span`。`part`、`endPart` 只收认得出的短词。
 * - `flashback` 有字 → 整章回忆（不推进时间），机器写的回忆一定带行尾那一段（没依据就〔推测：整章是回忆〕），好认出是机器写的。
 * - `evidence` 照叙事线事件的口径逐字校验：找不到就换成正文里最接近的一句，还找不到丢掉证据、改记〔推测〕。没给证据给了理由 →
 *   〔推测：理由〕；都没给 → 〔推测：紧接上一章〕。
 * - `date`（〔文中〕）：证据要在正文里，而且证据里写着这个日期或这个节日；日期认不出、节日在这个历法里换不出日子的不收；`offset` 夹在
 *   0 到历时 − 1。`season`（〔季节〕）：春夏秋冬之一，证据要在正文里。
 */
export function verifyTime(
  raw: unknown,
  ctx: { chapter: number; text: string; calendar?: TimelineCalendar; hint?: string }
): VerifiedTime | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const cal = ctx.calendar ?? '简单历';
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  const index = indexText(ctx.text);
  const reason = cut(strOf(o.reason ?? o.why ?? o.note), TIME_BASIS_MAX);
  const partOf = (v: unknown): string | undefined => {
    const s = strOf(v);
    return PART_WORDS.test(s) ? s : undefined;
  };
  const part = partOf(o.part ?? o.timeOfDay);
  const endPart = partOf(o.endPart ?? o.end);
  const agoRaw = cut(strOf(o.flashback), AGO_MAX);
  const flashback = o.flashback === true || (agoRaw !== '' && !/^(?:否|无|没有|false|no)$/iu.test(agoRaw));
  const ago = /^(?:是|true|yes)$/iu.test(agoRaw) ? '' : agoRaw;

  // 历时：jumps 各处相加（模型不估 span）；没给 jumps 时认老的 span。
  let span = 1;
  if (Array.isArray(o.jumps)) {
    for (const j of o.jumps) {
      if (!j || typeof j !== 'object') {
        continue;
      }
      const jo = j as Record<string, unknown>;
      const days = intOf(jo.days);
      if (days === undefined || days < 0 || days > TIME_DAYS_MAX) {
        notes.push(`章内一跳的天数认不出：${strOf(jo.days) || '（空）'}`);
        continue;
      }
      const ev = cut(unquote(strOf(jo.evidence)), TIME_BASIS_MAX);
      const found = locateEvidence(index, ctx.text, ev);
      if (!found) {
        notes.push(`章内一跳（${days} 天）的依据在正文里找不到，不算：「${ev}」`);
        continue;
      }
      if (days > 0 && !mentionsTime(found.quote)) {
        notes.push(`章内一跳（${days} 天）的依据那一句没写时间，不算：「${found.quote}」`);
        continue;
      }
      span = Math.min(TIME_DAYS_MAX, span + days);
    }
  } else {
    const spanRaw = intOf(o.span);
    span = spanRaw !== undefined && spanRaw >= 1 && spanRaw <= TIME_DAYS_MAX ? spanRaw : 1;
  }

  let evidence = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  let hinted: string | undefined;
  if (evidence) {
    const found = locateEvidence(index, ctx.text, evidence);
    if (found?.changed) {
      notes.push(`时间的依据不是逐字原文，换成了最接近的原句：「${evidence}」→「${found.quote}」`);
    } else if (!found && ctx.hint && normalizeQuote(ctx.hint).includes(normalizeQuote(evidence))) {
      // 试跑：送去的「细纲记的时间地点」被当成依据抄了回来。照细纲判的，记推测、说清是照细纲。
      notes.push(`时间的依据抄的是细纲：「${evidence}」`);
      hinted = `照细纲：${cut(ctx.hint, 26)}`;
    } else if (!found) {
      notes.push(`时间的依据在正文里找不到：「${evidence}」`);
    }
    evidence = found?.quote ?? '';
    if (evidence && !mentionsTime(evidence)) {
      notes.push(`时间的依据那一句没写时间，改记推测：「${evidence}」`);
      evidence = '';
    }
  }
  const rawDays = o.days === null || o.days === undefined || strOf(o.days) === '?' ? undefined : intOf(o.days);
  const days = rawDays !== undefined && Math.abs(rawDays) <= TIME_DAYS_MAX ? rawDays : undefined;
  if (rawDays !== undefined && days === undefined) {
    notes.push(`时间差 ${rawDays} 天太离谱，当推不出`);
  }

  let value: TimelineValue;
  let basis: TimelineEntry['basis'];
  if (flashback) {
    value = { kind: 'flashback', ago };
    basis = evidence ? { kind: '依据', text: evidence } : { kind: '推测', text: reason || '整章是回忆' };
  } else if (days === undefined) {
    value = { kind: 'unknown' };
    basis = { kind: '推不出', text: reason || '正文没交代过了多久' };
  } else {
    value = { kind: 'delta', days };
    basis = evidence
      ? { kind: '依据', text: evidence }
      : {
          kind: '推测',
          text:
            reason ||
            hinted ||
            (notes.some((n) => n.startsWith('时间的依据那一句没写时间'))
              ? '依据那一句没写时间'
              : notes.some((n) => n.startsWith('时间的依据'))
                ? '依据在正文里找不到'
                : '紧接上一章'),
        };
  }
  if (flashback) {
    span = 1;
  }
  // 同一天里开头、结尾是同一个时段：只写一个（试跑里「夜里 → 夜里」）。
  const end = endPart && !(span === 1 && endPart === part) ? endPart : undefined;
  const dateMark = flashback ? undefined : verifyDateMark(o.date, { cal, text: ctx.text, index, span, notes });
  const seasonMark = verifySeasonMark(o.season, { text: ctx.text, index, notes });
  return {
    entry: {
      chapter: ctx.chapter,
      value,
      ...(part && !flashback ? { part } : {}),
      ...(end && !flashback ? { endPart: end } : {}),
      span,
      ...(basis ? { basis } : {}),
      ...(dateMark ? { dateMark } : {}),
      ...(seasonMark ? { seasonMark } : {}),
    },
    notes,
  };
}

/** 〔文中〕：模型给的 `date`（`{ date, festival, offset, evidence }`）。不合格的不收，原因进 `notes`。 */
function verifyDateMark(
  raw: unknown,
  ctx: { cal: TimelineCalendar; text: string; index: QuoteIndex; span: number; notes: string[] }
): TimelineDateMark | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const dateText = cut(strOf(o.date), AGO_MAX);
  const festival = cut(strOf(o.festival), AGO_MAX) || undefined;
  const date = dateText ? parseMarkDate(dateText) : undefined;
  if (!date && !(festival && festivalDate(ctx.cal, festival))) {
    if (dateText || festival) {
      ctx.notes.push(
        `正文写明的日子认不出，不收：${dateText || festival}${festival && !dateText && (festivalDate('简单历', festival) || festivalDate('公历', festival)) ? `（${ctx.cal}里换不出这个节日的日子）` : ''}`
      );
    }
    return undefined;
  }
  const ev = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  const found = locateEvidence(ctx.index, ctx.text, ev);
  if (!found) {
    ctx.notes.push(`正文写明的日子「${dateText || festival}」的依据在正文里找不到，不收：「${ev}」`);
    return undefined;
  }
  if (!quoteMentionsDate(found.quote, date, festival)) {
    ctx.notes.push(`正文写明的日子「${dateText || festival}」在依据那一句里没写着，不收：「${found.quote}」`);
    return undefined;
  }
  // 模型只写了日、原文里写着月和日的，按原文的写（试跑：「次日乃是四月二十六日」报成了「二十六日」）。
  let full = dateText;
  if (date && date.m === 0) {
    for (const m of found.quote.matchAll(DATE_IN_TEXT)) {
      const d = parseDate(m[0]);
      if (d && d.d === date.d) {
        full = m[0].replace(/\s+/gu, '').replace(/[号號]$/u, '日');
        ctx.notes.push(`正文写明的日子只报了「${dateText}」，照原文写成「${full}」`);
        break;
      }
    }
  }
  const offsetRaw = intOf(o.offset);
  const offset = Math.max(0, Math.min(offsetRaw ?? 0, ctx.span - 1));
  return { ...(date ? { date: full } : {}), ...(festival ? { festival } : {}), offset, quote: found.quote };
}

/** 〔季节〕：模型给的 `season`（`{ season, evidence }`）。 */
function verifySeasonMark(raw: unknown, ctx: { text: string; index: QuoteIndex; notes: string[] }): TimelineSeasonMark | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const season = parseSeason(strOf(o.season));
  if (!season) {
    return undefined;
  }
  const ev = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  const found = locateEvidence(ctx.index, ctx.text, ev);
  if (!found) {
    ctx.notes.push(`季节「${season}」的依据在正文里找不到，不收：「${ev}」`);
    return undefined;
  }
  return { season, quote: found.quote };
}

/**
 * 完成提示里时间那一句：`时间：+2 天（依据「两日后」）`、`时间推不出（按紧接上一章算）`；正文写明了日子的另说一句
 * （「正文写明八月十五（中秋），按它对齐」）。
 */
export function describeTimeEntry(e: TimelineEntry): string {
  const dated = e.dateMark ? `；正文写明${describeDateMark(e.dateMark)}，按它对齐` : '';
  switch (e.value.kind) {
    case 'unknown':
      return dated ? `时间：比上一章晚多久推不出${dated}` : '时间推不出（按紧接上一章算，可以在时间线里改）';
    case 'flashback':
      return `时间：整章是回忆${e.value.ago ? `（${e.value.ago}）` : ''}，不推进时间`;
    case 'delta': {
      const how = describeDelta(e.value.days).replace('同一天', '与上一章同一天');
      const why = e.basis?.kind === '依据' ? `（依据「${cut(e.basis.text, 20)}」）` : e.basis?.kind === '推测' ? `（推测：${e.basis.text}）` : '';
      return `时间：${how}${e.span > 1 ? `，历时 ${e.span} 天` : ''}${why}${dated}`;
    }
    default:
      return `时间：${renderTimeValue(e.value)}`;
  }
}
