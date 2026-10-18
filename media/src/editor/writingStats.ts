/**
 * 码字统计的纯逻辑（零 DOM、不碰 localStorage、时间由调用方给）：一处改动算多少字、哪些改动算作者码的字、
 * 撤销 / 重做退的是哪一步、停笔多久不算时长、速度、目标进度怎么说、「今日码字」那份记录怎么读怎么合。
 * 装配（监听编辑区、画状态栏、记 localStorage）在 `stats.ts`，口径在这里——`tests/unit/editor/writingStats.test.js`
 * 钉着。
 *
 * ## 码字口径
 *
 * 「码了多少字」是**作者在编辑区里亲手打进去的净字数**（字数口径同 `words.ts`：中文按字、英文按词，标点空白不算）：
 *
 * - **算**：键盘打字（`typing`），输入法上屏的那一下（`composition` 带 `change`）。退格、Delete、打字盖掉选区
 *   删掉的字**倒扣**——所以是「净」增加，打了又删等于没打。
 * - **不算**：粘贴、剪切、拖放（`input`），一切程序改写（`program`：回车与 Tab 补的空白、成对符号补的半边、
 *   段落快捷键、一键排版、半角转全角、替换 / 全部替换、对比合并、历史版本恢复、还原、用磁盘版本覆盖、
 *   磁盘同步换进来的新版、右键粘贴），输入法组字中途（拼音还没上屏）。
 * - **撤销 / 重做跟着那一步走**（⚑）：撤销的是自己打的字，那几个字减回去；重做再加上；撤销的是一次粘贴、
 *   排版这类本来就没算的改动，码字数不动。靠 `EditHistory.topId` 认出是哪一步（{@link StepLedger}）。
 *
 * ## 时长
 *
 * 只算真正在写的时间：每一下落笔（打字、输入法，组字中途也算）离上一下不超过 {@link IDLE_MS}（2 分钟，⚑）的
 * 那一段记进时长，停笔更久那一段整个不算——挂着页面去吃饭，回来速度不会被拉低。两次落笔之间的那段记到后一下
 * 落笔的那份文件上，所以各文件的时长加起来就是总时长。
 */
import type { EditSource } from './api';
import type { TextChange } from './history';
import { countWords, groupDigits, isWordCode } from './words';

/** 停笔超过这么久，那一段不算码字时长（⚑ 2 分钟）。 */
export const IDLE_MS = 2 * 60_000;
/** 写够这么久才报速度：头几十秒的速度没有意义（⚑ 1 分钟）。 */
export const MIN_SPEED_MS = 60_000;
/** 「今日码字」在 localStorage 里留最近几天（只显示今天；多留几天不占地方，跨午夜补记前一天也有处落）。 */
export const DAILY_KEEP = 30;

// ---------------------------------------------------------------- 一处改动算多少字

/**
 * 这一处改动让全文多了（或少了）几个字，与改动前后各数一遍全文再相减的结果一字不差，但只看改动那一段：
 * 中文一个字一个字数，跟前后文无关；英文按词，改动挨着的那个词可能被接长、劈开或并起来，所以两头各往外
 * 扩到词的边界再比。`after` 是改动之后的全文，`change` 的位置按改动之前的文字算（`history.ts` 的约定）。
 */
export function wordDelta(after: string, change: TextChange): number {
  const end = change.at + change.inserted.length;
  let left = change.at;
  while (left > 0 && isWordCode(after.charCodeAt(left - 1))) {
    left--;
  }
  let right = end;
  while (right < after.length && isWordCode(after.charCodeAt(right))) {
    right++;
  }
  const head = after.slice(left, change.at);
  const tail = after.slice(end, right);
  return countWords(head + change.inserted + tail) - countWords(head + change.removed + tail);
}

/** 这一下改动算不算作者码的字：键盘打字与输入法上屏（带 `change` 的那一下）。 */
export function countsAsWriting(source: EditSource, change: TextChange | undefined): boolean {
  return !!change && (source === 'typing' || source === 'composition');
}

/** 这一下算不算「在写」（时长的心跳）：打字与输入法，组字中途也算——拼音还没上屏，人确实在写。 */
export function isWritingActivity(source: EditSource): boolean {
  return source === 'typing' || source === 'composition';
}

// ---------------------------------------------------------------- Markdown 标题行

/** 与 core `stripH1`（`model/markdown.ts`）同一条规则：去掉首尾空白之后开头的那个 `# 标题`。 */
const H1_RE = /^#\s+.+?(\r?\n|$)/;

/**
 * Markdown 正文开头那一行 `# 标题` 里有几个字。后端数一章写了多少字（工程页、章节条、写够了没有）时**不算**
 * 这一行（`countWords(stripH1(body))`），编辑器里数章节字数同样减掉它，两边才对得上。
 */
export function headingWords(text: string): number {
  const m = H1_RE.exec(text.trimStart());
  return m ? countWords(m[0]) : 0;
}

// ---------------------------------------------------------------- 撤销 / 重做退的是哪一步

/**
 * 一份文件的撤销历史（`EditHistory`）里，每一步计入了多少码字。撤销那一步就减回去、重做再加上；
 * 那一步本来没计入（粘贴、排版……）就什么都不动。
 *
 * 用法：每一次 `edit` 事件之后调一次——打字 / 上屏 / 程序改写调 {@link afterEdit}（带这一下计入的字数，
 * 不计入的给 0），撤销调 {@link afterUndo}，重做调 {@link afterRedo}，参数都是事件发生之后的 `history.topId`。
 * 编辑区每改一次历史都紧跟一条 `edit` 事件（`pane.ts`），所以上一次见到的栈顶就是撤销之前的栈顶。
 */
export class StepLedger {
  private readonly counted = new Map<number, number>();
  private top: number | undefined;

  afterEdit(topId: number | undefined, words: number): void {
    if (topId !== undefined && words !== 0) {
      this.counted.set(topId, (this.counted.get(topId) ?? 0) + words);
    }
    this.top = topId;
  }

  /** 撤销之后：返回码字数要跟着变多少（撤销自己打的字是负数）。 */
  afterUndo(topId: number | undefined): number {
    const undone = this.top;
    this.top = topId;
    const words = undone === undefined || undone === topId ? 0 : this.counted.get(undone) ?? 0;
    return words === 0 ? 0 : -words;
  }

  /** 重做之后：重做回来的那一步就是新的栈顶。 */
  afterRedo(topId: number | undefined): number {
    const before = this.top;
    this.top = topId;
    return topId === undefined || topId === before ? 0 : this.counted.get(topId) ?? 0;
  }
}

// ---------------------------------------------------------------- 本次码字

/** 一份文件在这次里码了多少。 */
export interface FileTally {
  path: string;
  /** 记下来那一刻它叫什么（「第 3 章《夜访》」「细纲 · 第 3 章」……）。文件关掉了明细里照样写得出。 */
  title: string;
  words: number;
  ms: number;
}

/**
 * 「本次码字」：从打开页面（或「重新开始计时」）起。按文件分别记，汇总成总数。
 * 时长的规则见文件头：两下落笔之间不超过 {@link IDLE_MS} 的那段记进去，记在后一下落笔的那份文件上。
 */
export class WritingSession {
  words = 0;
  ms = 0;
  readonly files = new Map<string, FileTally>();
  private last: number | undefined;

  constructor(readonly startedAt: number) {}

  /** 一下落笔。返回这一下记进时长的毫秒数（「今日」也要加上同样的数）。 */
  touch(path: string, title: string, at: number): number {
    const gap = this.last === undefined ? 0 : at - this.last;
    const add = gap > 0 && gap <= IDLE_MS ? gap : 0;
    // 时钟往回拨（改了系统时间）时不倒退，免得下一下算出一段很长的「在写」。
    this.last = this.last === undefined ? at : Math.max(this.last, at);
    const tally = this.tally(path, title);
    tally.ms += add;
    this.ms += add;
    return add;
  }

  /** 这份文件码了（或退了）几个字。 */
  add(path: string, title: string, words: number): void {
    if (words === 0) {
      return;
    }
    this.tally(path, title).words += words;
    this.words += words;
  }

  /** 文件改了名：明细跟着换路径。新路径已经有一份时并进去。 */
  rename(from: string, to: string): void {
    const old = this.files.get(from);
    if (!old || from === to) {
      return;
    }
    this.files.delete(from);
    const into = this.files.get(to);
    if (into) {
      into.words += old.words;
      into.ms += old.ms;
    } else {
      this.files.set(to, { ...old, path: to });
    }
  }

  /** 按文件的明细，码字多的在前（一样多时写得久的在前）。 */
  breakdown(): FileTally[] {
    return [...this.files.values()].sort((a, b) => b.words - a.words || b.ms - a.ms);
  }

  private tally(path: string, title: string): FileTally {
    let tally = this.files.get(path);
    if (!tally) {
      tally = { path, title, words: 0, ms: 0 };
      this.files.set(path, tally);
    } else if (title) {
      tally.title = title;
    }
    return tally;
  }
}

/** 每小时多少字。写了不到 {@link MIN_SPEED_MS}、或者净字数不是正的，不报（undefined）。 */
export function speedPerHour(words: number, ms: number): number | undefined {
  if (ms < MIN_SPEED_MS || words <= 0) {
    return undefined;
  }
  return Math.round((words * 3_600_000) / ms);
}

/** 「42 分钟」「2 小时 5 分」「不到 1 分钟」。 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return '不到 1 分钟';
  }
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 带符号的字数：「+356」「-12」「0」。 */
export function signedWords(n: number): string {
  return n > 0 ? `+${groupDigits(n)}` : groupDigits(n);
}

// ---------------------------------------------------------------- 距目标

export interface GoalProgress {
  words: number;
  target: number;
  /** 写了目标的几成（可以超过 1）。 */
  ratio: number;
  /** 「3,120 / 4,000 字」 */
  count: string;
  /** 「还差 880」「超出 120」「正好写够」 */
  rest: string;
  /** 到了八成（后端判「写够了」的线，第 21 条）。 */
  enough: boolean;
  over: boolean;
}

/** 本章字数与目标的进度。没有目标（不是正数）时 undefined。 */
export function goalProgress(words: number, target: number | undefined): GoalProgress | undefined {
  if (!target || !(target > 0)) {
    return undefined;
  }
  const diff = target - words;
  return {
    words,
    target,
    ratio: words / target,
    count: `${groupDigits(words)} / ${groupDigits(target)} 字`,
    rest: diff > 0 ? `还差 ${groupDigits(diff)}` : diff < 0 ? `超出 ${groupDigits(-diff)}` : '正好写够',
    enough: words >= target * 0.8,
    over: diff < 0,
  };
}

// ---------------------------------------------------------------- 今日码字

/** 一天码了多少：净字数与时长（口径与「本次」相同）。 */
export interface DayTally {
  words: number;
  ms: number;
}

/** 本地日期 → 那一天的数。键是 `YYYY-MM-DD`（本地时区，过了午夜就是新的一天）。 */
export type DailyRecord = Record<string, DayTally>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 这一刻是本地的哪一天。 */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 读 localStorage 里那一份。**坏值一律回落**：不是 JSON、形状不对、某一天的数不是有限数，就当那一天（或整份）
 * 没有——这只是码字习惯数据，读不懂就从零记，不报错、不崩。
 */
export function parseDaily(raw: string | null | undefined): DailyRecord {
  let data: unknown;
  try {
    data = JSON.parse(raw || 'null');
  } catch {
    return {};
  }
  const days = data && typeof data === 'object' ? (data as { days?: unknown }).days : undefined;
  if (!days || typeof days !== 'object' || Array.isArray(days)) {
    return {};
  }
  const out: DailyRecord = {};
  for (const [key, value] of Object.entries(days as Record<string, unknown>)) {
    const v = value as { words?: unknown; ms?: unknown } | null;
    if (
      DAY_RE.test(key) &&
      v &&
      typeof v === 'object' &&
      typeof v.words === 'number' &&
      Number.isFinite(v.words) &&
      typeof v.ms === 'number' &&
      Number.isFinite(v.ms) &&
      v.ms >= 0
    ) {
      out[key] = { words: Math.round(v.words), ms: Math.round(v.ms) };
    }
  }
  return out;
}

export function serializeDaily(record: DailyRecord): string {
  return JSON.stringify({ v: 1, days: record });
}

/**
 * 把一个窗口攒下的增量加进存着的那一份（**加，不是覆盖**：几个窗口同开一个工程时各加各的增量，谁也不会
 * 把别人记的冲掉，也不会重复算）。只留最近 {@link DAILY_KEEP} 天。不改传进来的两份。
 */
export function addDaily(stored: DailyRecord, increment: DailyRecord, keep = DAILY_KEEP): DailyRecord {
  const out: DailyRecord = {};
  for (const [key, v] of Object.entries(stored)) {
    out[key] = { ...v };
  }
  for (const [key, v] of Object.entries(increment)) {
    const cur = out[key] ?? { words: 0, ms: 0 };
    out[key] = { words: cur.words + v.words, ms: cur.ms + v.ms };
  }
  const keys = Object.keys(out).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - keep))) {
    delete out[key];
  }
  return out;
}

/** 往一份增量里记一笔（就地改）。 */
export function bumpDaily(record: DailyRecord, at: number, words: number, ms: number): void {
  if (words === 0 && ms === 0) {
    return;
  }
  const key = dayKey(at);
  const cur = record[key] ?? { words: 0, ms: 0 };
  record[key] = { words: cur.words + words, ms: cur.ms + ms };
}
