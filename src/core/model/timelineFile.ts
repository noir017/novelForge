/**
 * 叙事线里的故事时间（2026-10-24，设计见 docs/design/plans/2026-10-24-story-timeline.md）：`threads/时间线.md` 一章一行，
 * 记这一章开头比上一章结尾晚多久。
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
 * - 第 1 章：+0 天，傍晚〔依据：「连日大雨的第三天傍晚」〕
 * - 第 4 章：+1 天，清晨，历时 2 天〔依据：「次日清晨，雨停了」〕
 * - 第 7 章：回忆，约二十年前
 * - 第 9 章：+?〔推不出：正文没交代过了多久〕
 * - 第 12 章：八月十五，傍晚           ← 作者定的锚点
 * ```
 *
 * ## 四条约定
 *
 * - **机器只写相对量，日期一律现算**（{@link computeTimeline}）：作者把哪一行改成日期或「第 N 天」，哪一行就是锚点，后面机器推的
 *   章跟着顺延——文件里不写日期，改一个锚点不会留下一串过期的日期。状态不落盘（第 18 条）。
 * - **机器只填空**（{@link upsertTimelineEntry}）：没有这一章的行才写；已有的只在两种情况下换——还是机器写的 `+?`〔推不出〕，或者
 *   〔依据〕那句原文已经不在正文里了。作者写的、改过的、还站得住的一律不动（第 28 条）。
 * - **怎么手改都不崩**（第 1 条）：认不出的行原样留着，这一章当「没推」算。
 * - 纯函数、无 I/O：读在 `model/project.ts` 的 `readThreads`，写在网关（`Workspace.updateThread`）。
 */
import { asString, parseMarkdown } from './markdown';
import { indexText, normalizeQuote, quoteFound } from './review';
import { nearestSentence } from './continuity';
import { TIMELINE_NAME } from './threadFile';

export { TIMELINE_NAME };

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

export interface TimelineEntry {
  chapter: number;
  value: TimelineValue;
  /** 本章开头的时段（只显示）。 */
  part?: string;
  /** 本章跨了几天（1 = 同一天里写完）。 */
  span: number;
  basis?: { kind: TimelineBasisKind; text: string };
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

/** 文件里一行的样子：`- 第 N 章：值，时段，历时 M 天〔依据：「原文」〕`。 */
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s+/u;
const LINE_HEAD = /^第\s*(\d+)\s*章\s*[:：·・\s]\s*/u;
/** 行尾那一段：`〔依据：「原文」〕`、`〔推测：理由〕`、`〔推不出：理由〕`；括号写成 `[]`、`【】`、`（）` 也认，「证据」当「依据」。 */
const BASIS_TAIL = /\s*[〔\[【（(]\s*(依据|证据|推测|推不出)\s*[:：]?\s*([\s\S]*?)\s*[〕\]】）)]\s*$/u;
const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];

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
      : g.suffix
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
  const { y, m, d } = fromOrdinal(tl.calendar, base + day - 1);
  const style = tl.start.style;
  if (style.day === 'iso' || style.day === 'slash') {
    const pad = (v: number) => (style.day === 'iso' ? String(v).padStart(2, '0') : String(v));
    const sep = style.day === 'iso' ? '-' : '/';
    return { full: `${y}${sep}${pad(m)}${sep}${pad(d)}`, short: String(d), month: `${y}${sep}${pad(m)}` };
  }
  let yearPart: string;
  if (style.hasYear) {
    yearPart = `${style.era}${yearText(y, style)}年`;
  } else {
    const y0 = fromOrdinal(tl.calendar, base).y;
    yearPart = yearOffsetText(y - y0, style);
  }
  const month = `${yearPart}${monthText(m, style)}`;
  const short = style.day === 'trad' ? tradDay(d) : style.day === 'cn' ? cnNumber(d) : String(d);
  return { full: `${month}${dayText(d, style)}`, short, month };
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
 * 认一行（项目符号已经去掉）。不是 `第 N 章` 开头的返回 undefined；`第 N 章` 认得出、值认不出的返回 `{ chapter, bad: true }`。
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
  let rest = line.slice(head[0].length);
  let basis: TimelineEntry['basis'];
  const tail = BASIS_TAIL.exec(rest);
  if (tail) {
    const kind: TimelineBasisKind = tail[1] === '证据' ? '依据' : (tail[1] as TimelineBasisKind);
    const text = kind === '依据' ? unquote(tail[2]) : tail[2].trim();
    basis = { kind, text };
    rest = rest.slice(0, tail.index);
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
  let span = 1;
  let ago = value.kind === 'flashback' ? value.ago : '';
  for (const p of parts.slice(1)) {
    const days = spanOf(p, cal);
    if (days !== undefined) {
      span = days;
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
      span,
      ...(basis ? { basis } : {}),
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

/** 一章的样子。 */
export type TimelineDayState = 'evidence' | 'guess' | 'unknown' | 'missing' | 'anchor' | 'flashback' | 'bad';

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
  /** 回忆：大约多久以前。 */
  ago?: string;
  basis?: TimelineEntry['basis'];
}

export interface TimelineCalc {
  /** 第 1 章到文件里出现过的最大章号（`upTo` 截过的），一章一项。 */
  days: TimelineDay[];
  /** 文件里写到第几章（认得出、认不出的行都算）。没有一行是 0。 */
  last: number;
  /** 故事里过了几天（最后一章的结尾）。一行都没有是 0。 */
  elapsed: number;
}

/**
 * 从第 1 章往后推（设计稿「推算」）：没有这一行的、`+?` 的、认不出的按紧接上一章（开头 = 上一章结尾）算；锚点就是那一天；回忆
 * 不推进时间；第一章（第一个不是回忆的章）的相对值不算，开头是第 1 天。`upTo` 只推到第几章（写第 N 章时传 N − 1）。
 */
export function computeTimeline(tl: Timeline, upTo?: number): TimelineCalc {
  const byNo = new Map(tl.entries.map((e) => [e.chapter, e]));
  const bad = new Set(tl.bad);
  const fileLast = Math.max(0, ...tl.entries.map((e) => e.chapter), ...tl.bad);
  const last = upTo === undefined ? fileLast : Math.min(fileLast, upTo);
  const days: TimelineDay[] = [];
  let prevEnd = 0;
  let started = false;
  for (let no = 1; no <= last; no++) {
    const e = byNo.get(no);
    if (e?.value.kind === 'flashback') {
      days.push({ chapter: no, state: 'flashback', span: e.span, ...(e.value.ago ? { ago: e.value.ago } : {}), ...(e.basis ? { basis: e.basis } : {}) });
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
    const end = start + span - 1;
    days.push({
      chapter: no,
      state,
      start,
      end,
      ...(started ? { delta: start - prevEnd } : {}),
      span,
      ...(e?.part ? { part: e.part } : {}),
      ...(e?.basis ? { basis: e.basis } : {}),
    });
    prevEnd = end;
    started = true;
  }
  return { days, last, elapsed: started ? prevEnd : 0 };
}

/** 一章开头那一天的说法：`大衍三年三月十四 清晨`、`第 8 天 傍晚`。回忆写 `回忆（约二十年前）`。 */
export function describeDay(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return `回忆${d.ago ? `（${d.ago}）` : ''}`;
  }
  return `${dayLabel(tl, d.start).full}${d.part ? ` ${d.part}` : ''}`;
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

/**
 * 认事件、补推时交给模型的「上一章的时间」（只看第 `no` 章之前的行）：`第 11 章：三月十四 傍晚（故事第 8 天）〔依据：「…」〕`。
 * 第 1 章、前面一行都没有、中间隔着没记的章，各说一句。
 */
export function previousTimeNote(tl: Timeline, no: number): string {
  if (no <= 1) {
    return '这是第 1 章：days 写 0。';
  }
  const last = lastKnownBefore(tl, no);
  if (!last) {
    return '前面的章还没记时间：只按正文判这一章比上一章晚几天，判不出写 null。';
  }
  const d = last.day;
  const basis = d.basis ? `〔${d.basis.kind}：${d.basis.kind === '依据' ? `「${cut(d.basis.text, 40)}」` : cut(d.basis.text, 40)}〕` : '';
  const head = `第 ${d.chapter} 章：${describeDaySpan(tl, d)}${basis}`;
  if (last.gap === 0) {
    return head;
  }
  const skipped = last.gap > 1 ? `第 ${d.chapter + 1}–${no - 1} 章` : `第 ${no - 1} 章`;
  return `${head}\n（${skipped}的时间还没记；这一章仍只判比上一章晚多久，判不出写 null）`;
}

/** `大衍三年三月十四 清晨（故事第 8 天）`，跨了几天的另说结尾。 */
export function describeDaySpan(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  const head = `${describeDay(tl, d)}（故事第 ${d.start} 天）`;
  if (d.span > 1 && d.end !== undefined) {
    return `${head}起，历时 ${d.span} 天，到${dayLabel(tl, d.end).full}（第 ${d.end} 天）`;
  }
  return head;
}

// ---------------------------------------------------------------- 写入（只填空）

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
  '> 一章一行，写的是这一章开头比上一章结尾晚多久；同步时由机器按正文推（只填空，你改过的不动）。日期在叙事线页签和总览里看。',
  '> 起点：在上面 start 后面写第 1 章那一天（如「大衍三年三月初七」「2026-03-07」），不写只显示第几天；calendar 写「简单历」（每月 30 天）或「公历」。',
  '> 要定死哪一章，把「+N 天」改成具体日期（「八月十五」）或「第 N 天」（阿拉伯数字），后面的章跟着顺延；要机器重推哪一章，删掉那一行再同步。',
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

/** 一行（不带项目符号）：`第 4 章：+1 天，清晨，历时 2 天〔依据：「次日清晨，雨停了」〕`。 */
export function renderTimelineLine(e: TimelineEntry): string {
  const basis = e.basis ? `〔${e.basis.kind}：${e.basis.kind === '依据' ? `「${e.basis.text}」` : e.basis.text}〕` : '';
  return `第 ${e.chapter} 章：${renderTimeValue(e.value)}${e.part ? `，${e.part}` : ''}${e.span > 1 ? `，历时 ${e.span} 天` : ''}${basis}`;
}

/** {@link upsertTimelineEntry} 做了什么。 */
export type TimelineWrite = 'added' | 'replaced' | 'kept';

/**
 * 机器该不该换掉已有的那一行（设计稿「谁能写什么」）：还是 `+?`〔推不出〕（作者没动过）；或者〔依据〕那句原文已经不在正文里了。
 * 其余（作者写的、改过的、〔推测〕的、依据还在的、认不出的）都不换。
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
 * 把第 N 章的一行写进时间线原文（**只填空**）：还没有这份文件按模板新建；没有这一章的行就按章号插到对的位置（项目符号沿用已有的
 * 写法）；已有的只在 {@link machineMayReplace} 时换掉那一行，其余原样。别的行、frontmatter、BOM 与换行符一个字不动。
 */
export function upsertTimelineEntry(raw: string, entry: TimelineEntry, chapterText: string): { text: string; action: TimelineWrite } {
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
      if ('entry' in got && machineMayReplace(got.entry, chapterText)) {
        lines[i] = `${m ? m[0] : ''}${renderTimelineLine(entry)}`;
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
 * 校验模型给的一章的时间（认事件的 `time`、补推的 `times` 里的一项）。`raw` 不是对象返回 undefined（模型没给：不写这一行）。
 *
 * - `days` 是整数、绝对值不超过 {@link TIME_DAYS_MAX}；`null`、缺席、认不出 → `+?`〔推不出〕。
 * - `span` 是 1 起的整数，缺了、不合格当 1。`part` 只收认得出的短词。
 * - `flashback` 有字 → 整章回忆（不推进时间）。
 * - `evidence` 照叙事线事件的口径逐字校验：找不到就换成正文里最接近的一句，还找不到丢掉证据、改记〔推测〕。没给证据给了理由 →
 *   〔推测：理由〕；都没给 → 〔推测：紧接上一章〕。
 */
export function verifyTime(raw: unknown, ctx: { chapter: number; text: string }): VerifiedTime | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  const reason = cut(strOf(o.reason ?? o.why ?? o.note), TIME_BASIS_MAX);
  const partRaw = strOf(o.part ?? o.timeOfDay);
  const part = PART_WORDS.test(partRaw) ? partRaw : undefined;
  const spanRaw = intOf(o.span);
  const span = spanRaw !== undefined && spanRaw >= 1 && spanRaw <= TIME_DAYS_MAX ? spanRaw : 1;
  const agoRaw = cut(strOf(o.flashback), AGO_MAX);
  const flashback = o.flashback === true || (agoRaw !== '' && !/^(?:否|无|没有|false|no)$/iu.test(agoRaw));
  const ago = /^(?:是|true|yes)$/iu.test(agoRaw) ? '' : agoRaw;

  let evidence = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  if (evidence) {
    const index = indexText(ctx.text);
    if (!quoteFound(index, evidence)) {
      const near = normalizeQuote(evidence).length >= 4 ? nearestSentence(ctx.text, evidence, TIME_BASIS_MAX) : undefined;
      if (near) {
        notes.push(`时间的依据不是逐字原文，换成了最接近的原句：「${evidence}」→「${near.sentence}」`);
        evidence = near.sentence;
      } else {
        notes.push(`时间的依据在正文里找不到：「${evidence}」`);
        evidence = '';
      }
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
    basis = evidence ? { kind: '依据', text: evidence } : reason ? { kind: '推测', text: reason } : undefined;
  } else if (days === undefined) {
    value = { kind: 'unknown' };
    basis = { kind: '推不出', text: reason || '正文没交代过了多久' };
  } else {
    value = { kind: 'delta', days };
    basis = evidence
      ? { kind: '依据', text: evidence }
      : { kind: '推测', text: reason || (notes.length > 0 ? '依据在正文里找不到' : '紧接上一章') };
  }
  return {
    entry: {
      chapter: ctx.chapter,
      value,
      ...(part && !flashback ? { part } : {}),
      span: flashback ? 1 : span,
      ...(basis ? { basis } : {}),
    },
    notes,
  };
}

/** 完成提示里时间那一句：`时间：+2 天（依据「两日后」）`、`时间推不出（按紧接上一章算）`。 */
export function describeTimeEntry(e: TimelineEntry): string {
  switch (e.value.kind) {
    case 'unknown':
      return '时间推不出（按紧接上一章算，可以在时间线里补）';
    case 'flashback':
      return `时间：整章是回忆${e.value.ago ? `（${e.value.ago}）` : ''}，不推进时间`;
    case 'delta': {
      const how = describeDelta(e.value.days).replace('同一天', '与上一章同一天');
      const why = e.basis?.kind === '依据' ? `（依据「${cut(e.basis.text, 20)}」）` : e.basis?.kind === '推测' ? `（推测：${e.basis.text}）` : '';
      return `时间：${how}${e.span > 1 ? `，历时 ${e.span} 天` : ''}${why}`;
    }
    default:
      return `时间：${renderTimeValue(e.value)}`;
  }
}
