/**
 * 叙事线（2026-10-20 重做，设计见 docs/design/plans/2026-10-20-narrative-threads.md）：**一条线一个文件**
 * `.novelforge/threads/<线名>.md`，挂不上线的伏笔单放 `threads/未归属的伏笔.md`。
 *
 * ```markdown
 * ---
 * kind: 感情线            # 主线 / 支线 / 感情线 / 人物线；认不出当支线
 * origin: 计划            # 计划 / 正文
 * plan: 3-40              # 计划第几章开、第几章收；可以只写开头（3-）或不写
 * progressThrough: 12     # 「当前进度」写到第几章
 * progressHash: …         # 机器最后一次写「当前进度」时的指纹
 * generatedBy: novel-forge
 * ---
 *
 * # 林昭与沈青
 *
 * ## 意图
 * ## 当前进度
 * ## 伏笔
 * - 玉佩的来历：林昭的玉佩是沈家旧物（计划第 3 章埋、第 18 章前收）
 * ## 进展
 * - 第 3 章 · 计划 · 埋〈玉佩的来历〉：打斗中玉佩露出来
 * - 第 3 章 · 推进：两人在镇口初遇 〔证据：「她的剑停在他喉前三寸」〕
 * ```
 *
 * 七期那一份单文件 `threads.md`（`threadsFile.ts`，已删）把伏笔、悬念、线索混在一起，状态只有一种算法，
 * 也看不出一条线现在走到哪。这一版只收**剧情线**（四种种类，主线全书一条），伏笔挂在线下，
 * 关系变动是线上的一个事件；「当前进度」一两句话说这条线现在走到哪，由机器维护、指纹守着。
 *
 * ## 四条约定
 *
 * - **文件名就是线名**（同名按 {@link threadKey} 归一判）。{@link UNFILED_NAME} 是保留名。
 * - **状态不落盘**（第 18 条同一个口径）：进行中 / 已收束、断了几章、伏笔逾期，都从事件现算
 *   （{@link threadStateAt}、{@link foreshadowingOf}）。写第 N 章时只看第 N 章之前的事件（{@link asOf}）。
 * - **外科式写入**（第 3 条）：追加伏笔、追加事件、按章换计划事件、按证据清掉一章的机器事件、换写
 *   「当前进度」，都只动插入或删掉的那几行，作者写的字、自加的小节、BOM 与换行符原样。
 * - **怎么手改都不崩**（第 1 条）：认不出的行原样留着，不当伏笔、也不当事件。
 *
 * 纯函数，无 I/O。读目录在 `model/project.ts` 的 `readThreads`，写盘在网关（`workspace/index.ts`）。
 */
import { hash, sanitizeFileName } from './fs';
import {
  SECTION_PLACEHOLDER,
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  replaceSection,
  rewriteFrontmatter,
  stringifyFrontmatter,
} from './markdown';
import { indexText, normalizeQuote, quoteFound } from './review';
import type { ThreadWatch } from './pipeline';

// ---------------------------------------------------------------- 类型

/** 种类（作者定的，2026-10-20 第 5 条）：定死四种，不分子线。 */
export type ThreadKind = '主线' | '支线' | '感情线' | '人物线';
export const THREAD_KINDS: readonly ThreadKind[] = ['主线', '支线', '感情线', '人物线'];

/** 这条线从哪来：排线排出来的，还是定稿时从正文里认出来的。 */
export type ThreadOrigin = '计划' | '正文';

/** 线的事件：推进、关系（人物关系的变动）、收束（这条线走完了）、放弃。 */
export type LineEventType = '推进' | '关系' | '收束' | '放弃';
/** 伏笔的事件：埋、收、弃。 */
export type ForeshadowEventType = '埋' | '收' | '弃';
export type ThreadEventType = LineEventType | ForeshadowEventType;
export const LINE_EVENT_TYPES: readonly LineEventType[] = ['推进', '关系', '收束', '放弃'];
export const FORESHADOW_EVENT_TYPES: readonly ForeshadowEventType[] = ['埋', '收', '弃'];

/**
 * 「进展」里的一行。`planned` 的是计划事件（拆细纲写进来的），其余是实际事件（定稿写进来的，
 * 必须带证据；作者手写的可以没有）。
 */
export interface ThreadEvent {
  chapter: number;
  planned: boolean;
  type: ThreadEventType;
  /** 伏笔的事件挂的是哪一条伏笔（`〈名〉`）。 */
  foreshadowing?: string;
  what: string;
  /** 正文里的一句原文。 */
  evidence?: string;
}

/** 「伏笔」里的一行：`名：是什么（计划第 a 章埋、第 b 章前收）`，括号可缺。 */
export interface Foreshadowing {
  name: string;
  what: string;
  plant?: number;
  resolve?: number;
}

/** 一份叙事线文件（一条线，或「未归属的伏笔」）都有的部分。 */
export interface ThreadFileBase {
  name: string;
  relPath: string;
  foreshadowing: Foreshadowing[];
  events: ThreadEvent[];
}

/** 一条线。 */
export interface Thread extends ThreadFileBase {
  kind: ThreadKind;
  origin: ThreadOrigin;
  /** 计划第几章开。 */
  from?: number;
  /** 计划第几章收。 */
  to?: number;
  intent: string;
  /** 当前进度：一两句话说这条线现在走到哪了。 */
  progress: string;
  /** 「当前进度」写到第几章（机器写时记）。 */
  progressThrough?: number;
  /** 机器最后一次写「当前进度」时的指纹。 */
  progressHash?: string;
  /** 在目录里排第几（0 起，按文件名）。同档排序时按它。 */
  index: number;
}

/** 挂不上线的伏笔：与一条线同样的「伏笔」「进展」两节，没有意图、当前进度、种类。 */
export type UnfiledForeshadowing = ThreadFileBase;

/** `threads/` 目录读出来的全部。 */
export interface ThreadBook {
  threads: Thread[];
  unfiled: UnfiledForeshadowing;
}

/** 状态（现算，不落盘）。 */
export type ThreadStatus = '计划中' | '进行中' | '已收束' | '已放弃';
export type ForeshadowStatus = '计划' | '已埋' | '已收' | '已弃';

// ---------------------------------------------------------------- 常量

/** 「未归属的伏笔」的文件名（不含扩展名）。排线、定稿都不许用它当线名。 */
export const UNFILED_NAME = '未归属的伏笔';

/** 意图最长多少字（排线写，之后机器不改）。 */
export const INTENT_MAX = 200;
/** 当前进度最长多少字。 */
export const PROGRESS_MAX = 150;
/** 线名、伏笔名最长多少字：名字就是身份，太长的不收。 */
export const NAME_MAX = 30;

/**
 * 线「断了」：进行中的线已经 K 章没有实际事件。⚑ 主线 5 章，其余 15 章，先写死（设计稿 ⚑9；
 * 工程页的 ⚠ 与写前检查的提醒共用）。
 */
export const STALL_CHAPTERS: Readonly<Record<ThreadKind, number>> = Object.freeze({
  主线: 5,
  支线: 15,
  感情线: 15,
  人物线: 15,
});

// ---------------------------------------------------------------- 认名字、种类与事件类型

/** 同名判据：审稿引文那一套归一化（NFKC、去空白与标点）。线名、伏笔名都用它。 */
export function threadKey(name: string): string {
  return normalizeQuote(name);
}

export function isUnfiledName(name: string): boolean {
  return threadKey(name) === threadKey(UNFILED_NAME);
}

/** 一条线落在哪个文件名上（不含目录）。 */
export function threadFileName(name: string): string {
  return `${sanitizeFileName(name.trim())}.md`;
}

const KIND_ALIASES: [string, ThreadKind][] = [
  ['主线', '主线'],
  ['main', '主线'],
  ['支线', '支线'],
  ['副线', '支线'],
  ['side', '支线'],
  ['感情线', '感情线'],
  ['情感线', '感情线'],
  ['爱情线', '感情线'],
  ['感情', '感情线'],
  ['romance', '感情线'],
  ['人物线', '人物线'],
  ['成长线', '人物线'],
  ['人物', '人物线'],
  ['character', '人物线'],
];

/** 认种类（模型给的、作者写的都走这一个）。认不出返回 undefined——读文件时当支线，排线时不收。 */
export function threadKindOf(text: string): ThreadKind | undefined {
  const t = (text ?? '').replace(/\s+/g, '').toLowerCase();
  return KIND_ALIASES.find(([alias]) => t === alias)?.[1];
}

/**
 * 事件类型的几种写法。**整个词对得上才算**（不按前缀认）：「收」与「收束」是两种，
 * 「第 3 章 收到密信」里的「收到密信」不是一个类型。
 */
const TYPE_ALIASES: [string, ThreadEventType][] = [
  ['推进', '推进'],
  ['进展', '推进'],
  ['advance', '推进'],
  ['关系', '关系'],
  ['关系变动', '关系'],
  ['relation', '关系'],
  ['收束', '收束'],
  ['完结', '收束'],
  ['结束', '收束'],
  ['close', '收束'],
  ['放弃', '放弃'],
  ['作废', '放弃'],
  ['abandon', '放弃'],
  ['埋', '埋'],
  ['埋下', '埋'],
  ['埋设', '埋'],
  ['plant', '埋'],
  ['收', '收'],
  ['回收', '收'],
  ['揭开', '收'],
  ['兑现', '收'],
  ['payoff', '收'],
  ['弃', '弃'],
  ['弃用', '弃'],
  ['drop', '弃'],
];

/** 认事件类型。认不出返回 undefined。 */
export function eventTypeOf(text: string): ThreadEventType | undefined {
  const t = (text ?? '').replace(/\s+/g, '').toLowerCase();
  return TYPE_ALIASES.find(([alias]) => t === alias)?.[1];
}

export function isForeshadowEvent(type: ThreadEventType): type is ForeshadowEventType {
  return (FORESHADOW_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * frontmatter 的 `plan`：`3-40`、`3–40`、`第3-40章`、`3-`（只写开头）、`-40`（只写收束章）、`3`。
 * 认不出返回空对象。
 */
export function parsePlan(text: string): { from?: number; to?: number } {
  const s = (text ?? '').trim();
  // 只写了收束章（`-40`）。
  const onlyTo = /^[-–—~～至到]+\s*(?:第\s*)?(\d+)/u.exec(s);
  if (onlyTo) {
    const b = Number(onlyTo[1]);
    return b > 0 ? { to: b } : {};
  }
  const m =/(\d+)\s*(?:章)?\s*(?:[-–—~～至到]+\s*(?:第\s*)?(\d+)?)?/u.exec(s);
  if (!m) {
    return {};
  }
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!(a > 0)) {
    return {};
  }
  if (b === undefined || !(b > 0)) {
    return { from: a };
  }
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** 写回 frontmatter 的 `plan`。两头都没有时是 undefined（不写这个键）。 */
export function planText(from?: number, to?: number): string | undefined {
  if (from === undefined && to === undefined) {
    return undefined;
  }
  return `${from ?? ''}-${to ?? ''}`;
}

// ---------------------------------------------------------------- 解析

const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s+/u;
const EVENT_HEAD = /^第\s*(\d+)\s*章/u;
const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];

function unquote(s: string): string {
  const t = s.trim();
  for (const [a, b] of QUOTES) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

/** 行尾的证据：`〔证据：「原文」〕`，括号写成 `[]`、`【】`、`（）` 也认。 */
const EVIDENCE_TAIL = /\s*[〔\[【（(]\s*证据\s*[:：]\s*([\s\S]*?)\s*[〕\]】）)]\s*$/u;

/**
 * `第 N 章 · [计划 · ]类型[〈伏笔名〉]：一句话[ 〔证据：「原文」〕]`（项目符号已经去掉）。
 * 不是 `第 N 章` 开头的返回 undefined。类型认不出时整截当「推进」的说明——作者记了一笔，说明这条线动过
 * （七期同一个口径）。
 */
export function parseEventLine(line: string): ThreadEvent | undefined {
  const head = EVENT_HEAD.exec(line);
  if (!head) {
    return undefined;
  }
  const chapter = Number(head[1]);
  if (!(chapter > 0)) {
    return undefined;
  }
  const rest = line.slice(head[0].length).replace(/^[\s·・\-—|｜:：]+/u, '');
  let planned = false;
  let s = rest;
  if (s.startsWith('计划')) {
    planned = true;
    s = s.slice(2).replace(/^[\s·・\-—|｜]+/u, '');
  }
  const token = /^([^\s〈<《:：·・（(〔\[【]+)/u.exec(s);
  const type = token ? eventTypeOf(token[1]) : undefined;
  if (!type) {
    // 「计划」后面接的不是类型：「第 3 章 计划有变……」不是一条计划事件。
    return { chapter, planned: false, type: '推进', what: stripEvidence(rest).what, ...evidenceOf(rest) };
  }
  s = s.slice(token![0].length).replace(/^\s+/u, '');
  let foreshadowing: string | undefined;
  const fore = /^[〈<《]([^〉>》]*)[〉>》]/u.exec(s);
  if (fore) {
    foreshadowing = fore[1].trim() || undefined;
    s = s.slice(fore[0].length);
  }
  s = s.replace(/^[\s·・]*[:：]?\s*/u, '');
  const { what } = stripEvidence(s);
  return {
    chapter,
    planned,
    type,
    ...(foreshadowing ? { foreshadowing } : {}),
    what,
    ...evidenceOf(s),
  };
}

function stripEvidence(s: string): { what: string } {
  const m = EVIDENCE_TAIL.exec(s);
  return { what: (m ? s.slice(0, m.index) : s).trim() };
}

function evidenceOf(s: string): { evidence?: string } {
  const m = EVIDENCE_TAIL.exec(s);
  const evidence = m ? unquote(m[1]) : '';
  return evidence ? { evidence } : {};
}

/** `名：是什么（计划第 a 章埋、第 b 章前收）`（项目符号已经去掉）。没有名字返回 undefined。 */
export function parseForeshadowLine(line: string): Foreshadowing | undefined {
  let s = line.trim();
  let plant: number | undefined;
  let resolve: number | undefined;
  const paren = /[（(]([^（()）]*)[)）]\s*$/u.exec(s);
  if (paren) {
    const p = /第?\s*(\d+)\s*章\s*(?:埋下|埋设|埋)/u.exec(paren[1]);
    const r = /第?\s*(\d+)\s*章\s*(?:之?前)?\s*(?:回收|揭开|收)/u.exec(paren[1]);
    if (p || r) {
      plant = p ? Number(p[1]) : undefined;
      resolve = r ? Number(r[1]) : undefined;
      s = s.slice(0, paren.index).trim();
    }
  }
  const colon = s.search(/[:：]/u);
  const name = (colon >= 0 ? s.slice(0, colon) : s).trim().replace(/^[〈<《「]\s*|\s*[〉>》」]$/gu, '');
  const what = colon >= 0 ? s.slice(colon + 1).trim() : '';
  if (!name || !hasContent(name)) {
    return undefined;
  }
  return {
    name,
    what,
    ...(plant !== undefined && plant > 0 ? { plant } : {}),
    ...(resolve !== undefined && resolve > 0 ? { resolve } : {}),
  };
}

/** 认得出的几节。小节名按 `normalizeSectionKey` 宽松认。 */
type SectionId = 'intent' | 'progress' | 'foreshadowing' | 'events';
const SECTION_ALIASES: Record<string, SectionId> = {
  意图: 'intent',
  作者意图: 'intent',
  当前进度: 'progress',
  进度: 'progress',
  伏笔: 'foreshadowing',
  进展: 'events',
  事件: 'events',
};
const SECTION_TITLE: Record<SectionId, string> = {
  intent: '意图',
  progress: '当前进度',
  foreshadowing: '伏笔',
  events: '进展',
};

function normalizeSectionKey(s: string): string {
  return s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase();
}

/** 一行是不是二级标题；是的话认它是哪一节（认不出是 null）。不是标题返回 undefined。 */
function sectionOfHeading(line: string): SectionId | null | undefined {
  const m = /^##(?!#)\s*(.*?)\s*#*\s*$/u.exec(line);
  if (!m) {
    return undefined;
  }
  return SECTION_ALIASES[normalizeSectionKey(m[1])] ?? null;
}

/** 文件名词干（不含目录与 `.md`）。 */
function stemOf(relPath: string): string {
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.(md|markdown)$/i, '');
}

interface ParsedBody {
  h1?: string;
  intent: string;
  progress: string;
  foreshadowing: Foreshadowing[];
  events: ThreadEvent[];
}

function parseBody(body: string): ParsedBody {
  const out: ParsedBody = { intent: '', progress: '', foreshadowing: [], events: [] };
  const text: Partial<Record<SectionId, string[]>> = {};
  let cur: SectionId | null = null;
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const h1 = /^#(?!#)\s+(.+?)\s*$/u.exec(raw);
    if (h1) {
      out.h1 ??= h1[1].trim();
      cur = null;
      continue;
    }
    const heading = sectionOfHeading(raw);
    if (heading !== undefined) {
      cur = heading;
      continue;
    }
    if (/^#{3,}\s/u.test(raw) || cur === null) {
      continue;
    }
    if (cur === 'intent' || cur === 'progress') {
      (text[cur] ??= []).push(raw);
      continue;
    }
    const line = raw.replace(BULLET, '').trim();
    if (!line || line.startsWith('>') || !hasContent(line)) {
      continue;
    }
    if (cur === 'foreshadowing') {
      const f = parseForeshadowLine(line);
      if (f && !seen.has(threadKey(f.name))) {
        seen.add(threadKey(f.name));
        out.foreshadowing.push(f);
      }
    } else {
      const e = parseEventLine(line);
      if (e) {
        out.events.push(e);
      }
    }
  }
  const block = (id: 'intent' | 'progress'): string => {
    const t = (text[id] ?? []).join('\n').trim();
    return hasContent(t) ? t : '';
  };
  out.intent = block('intent');
  out.progress = block('progress');
  return out;
}

/**
 * 文件名是线名。H1 只在和文件名对得上时才当名字用：机器建文件时名字里的 `/`、`:` 被文件名清洗掉了，
 * H1 留着原样；作者在外面改了文件名，H1 就过时了，信文件名。
 */
function nameOf(stem: string, h1: string | undefined): string {
  if (h1 && sanitizeFileName(h1) === stem) {
    return h1;
  }
  return stem;
}

/** 读一条线（`threads/<线名>.md`）。怎么手改都不抛（第 1 条）：认不出的种类当支线，认不出的行跳过。 */
export function parseThreadFile(raw: string, relPath: string, index = 0): Thread {
  const { frontmatter, body } = parseMarkdown(raw ?? '');
  const parsed = parseBody(body);
  const { from, to } = parsePlan(asString(frontmatter.plan));
  const progressThrough = asNumber(frontmatter.progressThrough);
  const progressHash = asString(frontmatter.progressHash);
  return {
    name: nameOf(stemOf(relPath), parsed.h1),
    relPath,
    kind: threadKindOf(asString(frontmatter.kind)) ?? '支线',
    origin: asString(frontmatter.origin).includes('正文') ? '正文' : '计划',
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    intent: parsed.intent,
    progress: parsed.progress,
    ...(progressThrough !== undefined && progressThrough >= 0 ? { progressThrough } : {}),
    ...(progressHash ? { progressHash } : {}),
    foreshadowing: parsed.foreshadowing,
    events: parsed.events,
    index,
  };
}

/** 读「未归属的伏笔」。没有这份文件时传空串。 */
export function parseUnfiledFile(raw: string, relPath: string): UnfiledForeshadowing {
  const parsed = parseBody(parseMarkdown(raw ?? '').body);
  return { name: UNFILED_NAME, relPath, foreshadowing: parsed.foreshadowing, events: parsed.events };
}

// ---------------------------------------------------------------- 状态（现算）

/** 实际事件（定稿写进来的、作者手写的）。 */
export function actualEvents(file: ThreadFileBase): ThreadEvent[] {
  return file.events.filter((e) => !e.planned);
}

/** 计划事件（拆细纲写进来的）。 */
export function plannedEvents(file: ThreadFileBase): ThreadEvent[] {
  return file.events.filter((e) => e.planned);
}

/** 章号最大的那一条（同章取写在后面的）。 */
function latest(events: readonly ThreadEvent[]): ThreadEvent | undefined {
  let best: ThreadEvent | undefined;
  for (const e of events) {
    if (!best || e.chapter >= best.chapter) {
      best = e;
    }
  }
  return best;
}

/**
 * 一条线的状态：一条实际事件都没有是「计划中」；章号最大的那条**线的**实际事件（推进 / 关系 / 收束 / 放弃，
 * 同章取写在后面的）是收束就「已收束」、放弃就「已放弃」，其余「进行中」。伏笔的事件只说明这条线动过，
 * 不会把收了的线重新打开。
 */
export function threadStatus(thread: ThreadFileBase): ThreadStatus {
  const actual = actualEvents(thread);
  if (actual.length === 0) {
    return '计划中';
  }
  const last = latest(actual.filter((e) => !isForeshadowEvent(e.type)));
  if (last?.type === '收束') {
    return '已收束';
  }
  if (last?.type === '放弃') {
    return '已放弃';
  }
  return '进行中';
}

/** 收束、放弃了的线不再带进上下文、不再送去认事件。 */
export function isClosed(status: ThreadStatus): boolean {
  return status === '已收束' || status === '已放弃';
}

/** 最近一次实际事件在第几章（线的、伏笔的都算：这条线动过）。没有实际事件是 undefined。 */
export function lastActiveChapter(file: ThreadFileBase): number | undefined {
  return latest(actualEvents(file))?.chapter;
}

/**
 * 写到第 `no` 章时这份文件的样子：只留第 `no` 章**之前**的事件；「当前进度」写到第 `no` 章或更晚时
 * 也不用（那里面已经有第 `no` 章自己的事）。重写、重新定稿早前的章时，后面几章记下的事在那一章看来还没有
 * 发生——带进去就是把后面的剧情透给前面（七期 `asOf` 同一个道理）。
 */
export function asOf<T extends ThreadFileBase>(file: T, no: number): T {
  const events = file.events.filter((e) => e.chapter < no);
  const t = file as T & Partial<Pick<Thread, 'progress' | 'progressThrough'>>;
  const stale = t.progressThrough !== undefined && t.progressThrough >= no && !!t.progress;
  if (events.length === file.events.length && !stale) {
    return file;
  }
  return { ...file, events, ...(stale ? { progress: '' } : {}) };
}

/** 一条线此刻的样子（工程页一行、写前检查、挑线共用）。 */
export interface ThreadState {
  status: ThreadStatus;
  /** 最近一次实际事件在第几章。 */
  lastActive?: number;
  /** 进行中的线已经几章没有实际事件（`current − lastActive`）。不是进行中时缺席。 */
  gap?: number;
  /** 断了：{@link gap} 到了 {@link STALL_CHAPTERS}。 */
  stalled: boolean;
  /** 过了计划收束章还没收束（计划中、进行中的线才算）。 */
  overdue: boolean;
}

/** `current` 是「现在」：定稿到的最后一章（写第 N 章时传 N − 1，并先 {@link asOf}）。 */
export function threadStateAt(thread: Thread, current: number): ThreadState {
  const status = threadStatus(thread);
  const lastActive = lastActiveChapter(thread);
  const open = !isClosed(status);
  const gap = status === '进行中' && lastActive !== undefined ? Math.max(0, current - lastActive) : undefined;
  return {
    status,
    ...(lastActive !== undefined ? { lastActive } : {}),
    ...(gap !== undefined ? { gap } : {}),
    stalled: gap !== undefined && gap >= STALL_CHAPTERS[thread.kind],
    overdue: open && thread.to !== undefined && current > thread.to,
  };
}

/** 一条伏笔此刻的样子。 */
export interface ForeshadowState extends Foreshadowing {
  status: ForeshadowStatus;
  /** 实际埋在第几章。 */
  plantedAt?: number;
  /** 实际收（或弃）在第几章。 */
  closedAt?: number;
  /** 过了计划回收章（`resolve`）还没收、也没弃。 */
  overdue: boolean;
}

const FORESHADOW_STATUS: Record<ForeshadowEventType, ForeshadowStatus> = { 埋: '已埋', 收: '已收', 弃: '已弃' };

/**
 * 这份文件里的伏笔，各自现在的状态。「伏笔」一节写了的在前（按写的顺序），只在事件里出现过名字的
 * 跟在后面（作者只记了一笔事件、没在「伏笔」里登记，也算一条）。状态取章号最大的那条实际的埋 / 收 / 弃。
 */
export function foreshadowingOf(file: ThreadFileBase, current: number): ForeshadowState[] {
  const list: Foreshadowing[] = [...file.foreshadowing];
  const known = new Set(list.map((f) => threadKey(f.name)));
  for (const e of file.events) {
    if (e.foreshadowing && !known.has(threadKey(e.foreshadowing))) {
      known.add(threadKey(e.foreshadowing));
      list.push({ name: e.foreshadowing, what: '' });
    }
  }
  const actual = actualEvents(file).filter((e) => isForeshadowEvent(e.type) && e.foreshadowing);
  return list.map((f) => {
    const key = threadKey(f.name);
    const mine = actual.filter((e) => threadKey(e.foreshadowing!) === key);
    const last = latest(mine);
    const status = last ? FORESHADOW_STATUS[last.type as ForeshadowEventType] : '计划';
    const planted = mine.filter((e) => e.type === '埋');
    const plantedAt = planted.length > 0 ? Math.min(...planted.map((e) => e.chapter)) : undefined;
    const closedAt = status === '已收' || status === '已弃' ? last!.chapter : undefined;
    return {
      ...f,
      status,
      ...(plantedAt !== undefined ? { plantedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      overdue: (status === '计划' || status === '已埋') && f.resolve !== undefined && current > f.resolve,
    };
  });
}

/** 收了、弃了的伏笔。 */
export function isForeshadowClosed(status: ForeshadowStatus): boolean {
  return status === '已收' || status === '已弃';
}

// ---------------------------------------------------------------- 渲染

/** `第 N 章 · [计划 · ]类型[〈伏笔名〉]：一句话[ 〔证据：「原文」〕]`（不带项目符号）。 */
export function renderEventLine(e: ThreadEvent): string {
  const fore = e.foreshadowing?.trim() ? `〈${e.foreshadowing.trim()}〉` : '';
  const what = e.what.replace(/\s+/g, ' ').trim();
  const evidence = e.evidence?.trim() ? ` 〔证据：「${e.evidence.replace(/\s+/g, ' ').trim()}」〕` : '';
  return `第 ${e.chapter} 章 · ${e.planned ? '计划 · ' : ''}${e.type}${fore}：${what}${evidence}`;
}

/** `名：是什么（计划第 a 章埋、第 b 章前收）`（不带项目符号）。 */
export function renderForeshadowLine(f: Foreshadowing): string {
  const plan = [f.plant !== undefined ? `计划第 ${f.plant} 章埋` : '', f.resolve !== undefined ? `第 ${f.resolve} 章前收` : '']
    .filter(Boolean)
    .join('、');
  const what = f.what.replace(/\s+/g, ' ').trim();
  return `${f.name.trim()}${what ? `：${what}` : ''}${plan ? `（${plan}）` : ''}`;
}

/** 新建一条线要的东西（排线、定稿认出新线）。 */
export interface NewThread {
  name: string;
  kind: ThreadKind;
  origin: ThreadOrigin;
  from?: number;
  to?: number;
  intent: string;
  foreshadowing: Foreshadowing[];
  /** 建线时一起记下的事件（定稿从正文认出的新线：认出它的那一条实际事件）。 */
  events?: ThreadEvent[];
}

/** 一条新线的整份文件。 */
export function renderThreadFile(t: NewThread): string {
  const fm = stringifyFrontmatter({
    kind: t.kind,
    origin: t.origin,
    plan: planText(t.from, t.to),
    generatedBy: 'novel-forge',
  });
  return [
    fm,
    '',
    `# ${t.name.trim()}`,
    '',
    '## 意图',
    '',
    t.intent.trim() || SECTION_PLACEHOLDER,
    '',
    '## 当前进度',
    '',
    SECTION_PLACEHOLDER,
    '',
    '## 伏笔',
    '',
    ...t.foreshadowing.map((f) => `- ${renderForeshadowLine(f)}`),
    ...(t.foreshadowing.length > 0 ? [''] : []),
    '## 进展',
    '',
    ...(t.events ?? []).map((e) => `- ${renderEventLine(e)}`),
  ]
    .join('\n')
    .replace(/\n*$/, '\n');
}

/** 「未归属的伏笔」还不存在时的文件头。解析时 `## ` 之前的东西一律忽略。 */
export const UNFILED_TEMPLATE = [
  `# ${UNFILED_NAME}`,
  '',
  '> 挂不上哪一条线的伏笔。把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。',
  '',
  '## 伏笔',
  '',
  '## 进展',
  '',
].join('\n');

// ---------------------------------------------------------------- 外科式写入

interface Lines {
  bom: string;
  eol: string;
  lines: string[];
}

function splitLines(raw: string): Lines {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const body = bom ? raw.slice(1) : raw;
  return { bom, eol: body.includes('\r\n') ? '\r\n' : '\n', lines: body.split(/\r?\n/) };
}

function joinLines(l: Lines): string {
  return l.bom + l.lines.join(l.eol);
}

/** frontmatter 之后第一行的下标（没有 frontmatter 是 0）。 */
function bodyStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') {
    return 0;
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end > 0 ? end + 1 : 0;
}

/** 某一节的范围：标题那一行、到下一个一级或二级标题之前（不含）。没有这一节返回 undefined。 */
function findSection(lines: readonly string[], id: SectionId): { head: number; end: number } | undefined {
  const from = bodyStart(lines);
  for (let i = from; i < lines.length; i++) {
    if (sectionOfHeading(lines[i]) !== id) {
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,2}(?!#)\s/u.test(lines[j]) || /^##$/u.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { head: i, end };
  }
  return undefined;
}

/** 这一节里最后一行有字的下标；一行字都没有返回标题那一行。 */
function lastFilled(lines: readonly string[], sec: { head: number; end: number }): number {
  for (let i = sec.end - 1; i > sec.head; i--) {
    if (lines[i].trim()) {
      return i;
    }
  }
  return sec.head;
}

/**
 * 确保有这一节，返回它的范围。没有就新建：`before` 那一节在就插在它前面，否则接在文件末尾。
 */
function ensureSection(l: Lines, id: SectionId, before?: SectionId): { head: number; end: number } {
  const found = findSection(l.lines, id);
  if (found) {
    return found;
  }
  const next = before ? findSection(l.lines, before) : undefined;
  if (next) {
    l.lines.splice(next.head, 0, `## ${SECTION_TITLE[id]}`, '');
    return { head: next.head, end: next.head + 2 };
  }
  while (l.lines.length > 0 && !l.lines[l.lines.length - 1].trim()) {
    l.lines.pop();
  }
  if (l.lines.length > 0) {
    l.lines.push('');
  }
  const head = l.lines.length;
  l.lines.push(`## ${SECTION_TITLE[id]}`, '');
  return { head, end: l.lines.length };
}

/**
 * 在 `at` 这一行之后插入几行。插在标题后面时与标题隔一个空行；插完如果紧接着就是下一节的标题，
 * 补一个空行隔开。
 */
function insertAfter(l: Lines, at: number, sec: { head: number }, rows: readonly string[]): void {
  const block = [...rows];
  let pos = at + 1;
  if (at === sec.head) {
    if (l.lines[pos] !== undefined && !l.lines[pos].trim()) {
      pos++;
    } else {
      block.unshift('');
    }
  }
  const next = l.lines[pos];
  if (next !== undefined && next.trim() && /^#/u.test(next)) {
    block.push('');
  }
  l.lines.splice(pos, 0, ...block);
}

/** 文件末尾保证有一个换行（原来就有的不加）。 */
function finish(l: Lines): string {
  if (l.lines.length === 0 || l.lines[l.lines.length - 1] !== '') {
    l.lines.push('');
  }
  return joinLines(l);
}

/** 「进展」里一行事件的样子（项目符号沿用这一节里已有的写法，缺省 `- `）。 */
function eventRow(l: Lines, sec: { head: number; end: number } | undefined, e: ThreadEvent): string {
  return `${bulletOf(l, sec)}${renderEventLine(e)}`;
}

function bulletOf(l: Lines, sec: { head: number; end: number } | undefined): string {
  if (sec) {
    for (let i = sec.head + 1; i < sec.end; i++) {
      const m = /^(\s*[-*•]\s+)/u.exec(l.lines[i]);
      if (m) {
        return m[1];
      }
    }
  }
  return '- ';
}

/** 「进展」里各行认出的事件（认不出的是 undefined），带行号。 */
function eventRows(l: Lines, sec: { head: number; end: number }): { i: number; e: ThreadEvent }[] {
  const out: { i: number; e: ThreadEvent }[] = [];
  for (let i = sec.head + 1; i < sec.end; i++) {
    const e = parseEventLine(l.lines[i].replace(BULLET, '').trim());
    if (e) {
      out.push({ i, e });
    }
  }
  return out;
}

/**
 * 把几行事件插进「进展」：大体按章号排——插在第一条章号更大的事件前面（同一章里计划事件排在实际事件前面），
 * 没有就接在这一节最后一行有字的后面。只插、不挪作者已有的行。`e` 是定位用的那一条。
 */
function insertEvents(l: Lines, sec: { head: number; end: number }, e: ThreadEvent, rows: readonly string[]): void {
  const before = eventRows(l, sec).find(
    (r) => r.e.chapter > e.chapter || (r.e.chapter === e.chapter && e.planned && !r.e.planned)
  );
  if (before) {
    l.lines.splice(before.i, 0, ...rows);
  } else {
    insertAfter(l, lastFilled(l.lines, sec), sec, rows);
  }
}

/**
 * 在「伏笔」一节末尾加几条伏笔（这份文件里已经有同名的跳过）。没有这一节就在「进展」前面建一节。
 * 返回新原文与实际加了哪几条；一条都没加时原文原样返回。
 */
export function appendForeshadowing(raw: string, items: readonly Foreshadowing[]): { text: string; added: Foreshadowing[] } {
  const base = raw ?? '';
  const parsed = parseBody(parseMarkdown(base).body);
  const known = new Set(parsed.foreshadowing.map((f) => threadKey(f.name)));
  for (const e of parsed.events) {
    if (e.foreshadowing) {
      known.add(threadKey(e.foreshadowing));
    }
  }
  const added: Foreshadowing[] = [];
  for (const f of items) {
    const key = threadKey(f.name);
    if (!key || known.has(key)) {
      continue;
    }
    known.add(key);
    added.push(f);
  }
  if (added.length === 0) {
    return { text: base, added };
  }
  const l = splitLines(base);
  const sec = ensureSection(l, 'foreshadowing', 'events');
  const bullet = bulletOf(l, sec);
  insertAfter(l, lastFilled(l.lines, sec), sec, added.map((f) => `${bullet}${renderForeshadowLine(f)}`));
  return { text: finish(l), added };
}

/** 同一条事件（重新定稿同一章时不重复记）：同章、同类型、同一条伏笔、证据归一后相同（没有证据比说明）。 */
function sameEvent(a: ThreadEvent, b: ThreadEvent): boolean {
  return (
    a.chapter === b.chapter &&
    a.planned === b.planned &&
    a.type === b.type &&
    threadKey(a.foreshadowing ?? '') === threadKey(b.foreshadowing ?? '') &&
    (a.evidence || b.evidence
      ? normalizeQuote(a.evidence ?? '') === normalizeQuote(b.evidence ?? '')
      : normalizeQuote(a.what) === normalizeQuote(b.what))
  );
}

/**
 * 在「进展」里加几条事件（定稿记实际事件用）：按章号插（见 `insertEvents`），已经有的同一条跳过。
 * 没有「进展」就在文件末尾建一节。返回新原文与实际加了哪几条。
 */
export function appendEvents(raw: string, events: readonly ThreadEvent[]): { text: string; added: ThreadEvent[] } {
  const base = raw ?? '';
  const existing = parseBody(parseMarkdown(base).body).events;
  const added: ThreadEvent[] = [];
  for (const e of events) {
    if (existing.some((x) => sameEvent(x, e)) || added.some((x) => sameEvent(x, e))) {
      continue;
    }
    added.push(e);
  }
  if (added.length === 0) {
    return { text: base, added };
  }
  const l = splitLines(base);
  for (const e of added) {
    const sec = ensureSection(l, 'events');
    insertEvents(l, sec, e, [eventRow(l, sec, e)]);
  }
  return { text: finish(l), added };
}

/**
 * 按章换计划事件（细纲随写随换，设计稿「随细纲走」）：删掉「进展」里第 `chapter` 章的全部计划事件，
 * 换成 `events`（都当计划事件写）。原来有的插回第一条原来的位置，没有的按章号插。别的章、实际事件、
 * 认不出的行一行不动。`events` 为空就是只删。返回新原文与删掉了几行。
 */
export function replacePlannedEvents(
  raw: string,
  chapter: number,
  events: readonly Omit<ThreadEvent, 'planned' | 'chapter' | 'evidence'>[]
): { text: string; removed: number } {
  const base = raw ?? '';
  const l = splitLines(base);
  const found = findSection(l.lines, 'events');
  const rows = found ? eventRows(l, found).filter((r) => r.e.planned && r.e.chapter === chapter) : [];
  const fresh: ThreadEvent[] = events.map((e) => ({ ...e, chapter, planned: true }));
  if (rows.length === 0 && fresh.length === 0) {
    return { text: base, removed: 0 };
  }
  const bullet = bulletOf(l, found);
  const firstAt = rows[0]?.i;
  for (const r of [...rows].reverse()) {
    l.lines.splice(r.i, 1);
  }
  if (fresh.length > 0) {
    const rendered = fresh.map((e) => `${bullet}${renderEventLine(e)}`);
    if (firstAt !== undefined) {
      // 插回第一条原来的那一行：原来怎么排版的（标题后面有没有空行）就还是怎么排。
      l.lines.splice(firstAt, 0, ...rendered);
    } else {
      insertEvents(l, ensureSection(l, 'events'), fresh[0], rendered);
    }
  }
  return { text: finish(l), removed: rows.length };
}

/**
 * 重新定稿第 `chapter` 章时清掉那一章机器记的、**证据已经不在正文里**的实际事件（设计稿 ⚑7）。带证据的
 * 实际事件当机器记的（作者手写的可以没有证据，那些不动）；计划事件不动。返回新原文与删掉的事件。
 * 旧版由网关先存一版历史（`Workspace.overwrite`）。
 */
export function pruneChapterEvents(raw: string, chapter: number, text: string): { text: string; removed: ThreadEvent[] } {
  const base = raw ?? '';
  const l = splitLines(base);
  const sec = findSection(l.lines, 'events');
  if (!sec) {
    return { text: base, removed: [] };
  }
  const index = indexText(text);
  const gone = eventRows(l, sec).filter(
    (r) => !r.e.planned && r.e.chapter === chapter && r.e.evidence && !quoteFound(index, r.e.evidence)
  );
  if (gone.length === 0) {
    return { text: base, removed: [] };
  }
  for (const r of [...gone].reverse()) {
    l.lines.splice(r.i, 1);
  }
  return { text: joinLines(l), removed: gone.map((r) => r.e) };
}

// ---------------------------------------------------------------- 排线：校验模型的输出

/** 一次最多排几条线（上游 `PLAN_CANDIDATE_LIMIT`；提示词要的是 3–8 条）。 */
export const THREAD_PLAN_LIMIT = 8;
/** 排线时一条线最多带几条伏笔。 */
export const PLAN_FORESHADOW_LIMIT = 5;
/** 伏笔「是什么」最长多少字。 */
export const FORESHADOW_WHAT_MAX = 100;

/** {@link verifyThreadPlans} 给重名那一条的原因。完成提示里把它和「不合格」分开说。 */
export const SAME_THREAD = '同名的线已经有了';

/** 字段可能是数字，也可能是「3」这样的字符串。 */
function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join('').trim();
}

/** 名字合不合格：1–{@link NAME_MAX} 字、不是保留名。合格返回空串。 */
function nameProblem(name: string): string {
  if (!name) {
    return '没有名字';
  }
  if ([...name].length > NAME_MAX) {
    return `名字超过 ${NAME_MAX} 字`;
  }
  if (isUnfiledName(name)) {
    return `「${UNFILED_NAME}」是保留名`;
  }
  return '';
}

/** 全书已经有的伏笔名（各条线与「未归属的伏笔」里登记的、只在事件里出现过的都算）。排线、定稿认新伏笔时拿它去重。 */
export function foreshadowNames(book: ThreadBook): string[] {
  return [...book.threads, book.unfiled].flatMap((f) => foreshadowingOf(f, 0).map((x) => x.name));
}

/** 排线时没收的一条（线或伏笔）与原因。 */
export interface PlanDrop {
  name: string;
  why: string;
}

/**
 * 排线时模型交回来的候选 → 能新建的线（设计稿「一、排线」）。
 *
 * **先逐条校验、再取前 {@link THREAD_PLAN_LIMIT} 条**（七期修过的上游 #8：先截再校验，前面几条坏了，后面好的也跟着丢）：
 *
 * - 名字 1–30 字、不是「未归属的伏笔」，与已有的线、与同一批里前面的重名就跳过（{@link SAME_THREAD}）；
 * - 种类必须是四种之一（认不出的不收：读文件时认不出当支线，那是容错；排线时是模型没照合同写）；
 * - **全书只能有一条主线**：已经有了，或同一批里前面已经排了一条，就不收；
 * - 意图截到 {@link INTENT_MAX} 字，空的不收；计划区间可以缺，给了就要 `1 ≤ from ≤ to`，知道总章数时不越界；
 * - 伏笔每条线最多 {@link PLAN_FORESHADOW_LIMIT} 条：名字同上，与全书已有的伏笔、同一批里前面的重名跳过；
 *   「是什么」截到 {@link FORESHADOW_WHAT_MAX} 字；埋 / 收的章号不合理的只去掉章号、伏笔照收。
 */
export function verifyThreadPlans(
  raw: readonly unknown[],
  existing: { threads: readonly Pick<Thread, 'name' | 'kind'>[]; foreshadowing: readonly string[] },
  totalChapters?: number
): { plans: NewThread[]; dropped: PlanDrop[]; foreshadowDropped: PlanDrop[] } {
  const seen = new Set(existing.threads.map((t) => threadKey(t.name)));
  let hasMain = existing.threads.some((t) => t.kind === '主线');
  const knownFore = new Set(existing.foreshadowing.map(threadKey));
  const plans: NewThread[] = [];
  const dropped: PlanDrop[] = [];
  const foreshadowDropped: PlanDrop[] = [];
  const inBook = (n: number | undefined): boolean => n !== undefined && n >= 1 && (!totalChapters || n <= totalChapters);
  for (const item of raw) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = strOf(o.title ?? o.name).replace(/^#+\s*/, '');
    const kind = threadKindOf(strOf(o.kind ?? o.type));
    const intent = cut(strOf(o.intent), INTENT_MAX);
    const from = intOf(o.from);
    const to = intOf(o.to);
    let why = nameProblem(name);
    if (!why && !kind) {
      why = '种类不是主线 / 支线 / 感情线 / 人物线之一';
    } else if (!why && !intent) {
      why = '意图是空的';
    } else if (!why && ((o.from !== undefined && !inBook(from)) || (o.to !== undefined && !inBook(to)) || (from !== undefined && to !== undefined && to < from))) {
      why = totalChapters ? `计划区间不对（全书 ${totalChapters} 章）` : '计划区间不对';
    } else if (!why && seen.has(threadKey(name))) {
      why = SAME_THREAD;
    } else if (!why && kind === '主线' && hasMain) {
      why = '主线全书只能有一条，已经有了';
    }
    if (why) {
      dropped.push({ name: name || '（没有名字）', why });
      continue;
    }
    seen.add(threadKey(name));
    if (plans.length >= THREAD_PLAN_LIMIT) {
      dropped.push({ name, why: `一次最多排 ${THREAD_PLAN_LIMIT} 条` });
      continue;
    }
    if (kind === '主线') {
      hasMain = true;
    }
    const foreshadowing: Foreshadowing[] = [];
    for (const f of Array.isArray(o.foreshadowing) ? o.foreshadowing : []) {
      const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const fname = strOf(x.title ?? x.name);
      const fwhy = nameProblem(fname) || (knownFore.has(threadKey(fname)) ? '同名的伏笔已经有了' : '');
      if (fwhy) {
        foreshadowDropped.push({ name: fname || '（没有名字）', why: fwhy });
        continue;
      }
      if (foreshadowing.length >= PLAN_FORESHADOW_LIMIT) {
        foreshadowDropped.push({ name: fname, why: `一条线最多排 ${PLAN_FORESHADOW_LIMIT} 条伏笔` });
        continue;
      }
      knownFore.add(threadKey(fname));
      let plant = intOf(x.plant);
      let resolve = intOf(x.resolve);
      plant = inBook(plant) ? plant : undefined;
      resolve = inBook(resolve) && (plant === undefined || resolve! >= plant) ? resolve : undefined;
      foreshadowing.push({
        name: fname,
        what: cut(strOf(x.what), FORESHADOW_WHAT_MAX),
        ...(plant !== undefined ? { plant } : {}),
        ...(resolve !== undefined ? { resolve } : {}),
      });
    }
    plans.push({
      name,
      kind: kind!,
      origin: '计划',
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      intent,
      foreshadowing,
    });
  }
  return { plans, dropped, foreshadowDropped };
}

// ---------------------------------------------------------------- 定稿：送哪些去认、校验认出来的东西

/** 定稿时一章最多记几个事件（先校验后截）。 */
export const FINALIZE_EVENT_LIMIT = 8;
/** 定稿时一章最多认出几条新线。 */
export const FINALIZE_NEW_THREAD_LIMIT = 2;
/**
 * 定稿时一章最多认出几条新伏笔。⚑ 试跑之后从 5 收到 3（2026-10-21）：模型报的新伏笔多半是章末危机、本章已经揭开的事、
 * 普通情节，一章就报了 4 条，没收的伏笔第 7 章就超过了一次能认的条数，把排线排的伏笔挤了出去。
 */
export const FINALIZE_NEW_FORESHADOW_LIMIT = 3;
/** 证据最长多少字（上游 240）。 */
export const EVIDENCE_MAX = 240;
/** 事件那一句话最长多少字。 */
export const EVENT_WHAT_MAX = 100;

/** 送去认的一条伏笔：它是什么、挂在哪条线上（缺席是「未归属的伏笔」）、写到这一章时的状态。 */
export interface JudgedForeshadow extends ForeshadowState {
  line?: string;
}

/** 这一章的计划事件（各条线与「未归属的伏笔」里第 `no` 章、带「计划 ·」的），带它在哪条线上（缺席是未归属）。 */
export function plannedFor(book: ThreadBook, no: number): { line?: string; event: ThreadEvent }[] {
  return [
    ...book.threads.flatMap((t) => plannedEvents(t).filter((e) => e.chapter === no).map((event) => ({ line: t.name, event }))),
    ...plannedEvents(book.unfiled).filter((e) => e.chapter === no).map((event) => ({ event })),
  ];
}

/**
 * 定稿第 `no` 章时送哪几条线去认（设计稿「三、a」）：写到这一章时还没收束的（{@link asOf}），按要紧排——本章有计划事件的
 * → 本章细纲提到了名字的 → 主线 → 最近动过的（近的在前）→ 其余按文件名；最多 `limit` 条（上下文详细度 `threadJudge`）。
 * 返回的是 asOf 之后的样子（不带这一章及以后的事件、写到这一章或更晚的当前进度）。
 */
export function threadsToJudge(
  book: ThreadBook,
  no: number,
  plotText: string,
  limit: number
): { judged: Thread[]; skipped: Thread[] } {
  const plan = new Set(plannedFor(book, no).map((p) => p.line && threadKey(p.line)));
  const plot = normalizeQuote(plotText);
  const open = book.threads.map((t) => asOf(t, no)).filter((t) => !isClosed(threadStatus(t)));
  const rank = (t: Thread): number => {
    const key = threadKey(t.name);
    if (plan.has(key)) {
      return 0;
    }
    if (key.length >= 2 && plot.includes(key)) {
      return 1;
    }
    return t.kind === '主线' ? 2 : 3;
  };
  const ordered = [...open].sort(
    (a, b) => rank(a) - rank(b) || (lastActiveChapter(b) ?? 0) - (lastActiveChapter(a) ?? 0) || a.index - b.index
  );
  const n = Math.max(0, limit);
  return { judged: ordered.slice(0, n), skipped: ordered.slice(n) };
}

/**
 * 写到第 `no` 章时还没收、也没弃的伏笔（各条线与「未归属的伏笔」里的都算，线收束了伏笔照样可能还开着），带挂在哪条线上、
 * 写到这一章时的状态。定稿送去认（{@link foreshadowToJudge}）与归并的候选（c，{@link verifyMerges}）共用。
 */
export function openForeshadowing(book: ThreadBook, no: number): JudgedForeshadow[] {
  return [
    ...book.threads.flatMap((t) => foreshadowingOf(asOf(t, no), no - 1).map((f) => ({ ...f, line: t.name }))),
    ...foreshadowingOf(asOf(book.unfiled, no), no - 1).map((f) => ({ ...f })),
  ].filter((f) => !isForeshadowClosed(f.status));
}

/**
 * 定稿第 `no` 章时送哪几条伏笔去认：写到这一章时还没收、也没弃的（{@link openForeshadowing}），按要紧排，最多 `limit` 条
 * （上下文详细度 `foreshadowJudge`）：
 *
 * 1. **本章计划埋或收的**（拆细纲写进线里的这一章的计划事件）；
 * 2. **计划已经到期、却还没埋的**：计划埋的章 ≤ 本章（没写埋的章、只写了回收章的，回收章 ≤ 本章也算），到期早的在前；
 * 3. **已埋没收的**：计划回收章近的在前（逾期的回收章更早，排得更前），没写回收章的排在后面、埋得近的在前；
 * 4. 其余（计划还没到期的）。
 *
 * 试跑之后改的（2026-10-21）：从前只看计划事件与回收章，不看伏笔自己的计划埋的章——排线排的伏笔没埋时落在最末一档，
 * 被模型自己登记的一堆「已埋」挤出去，「伙计的执念来源」计划第 8 章埋，第 8 章恰好没送去认。
 */
export function foreshadowToJudge(
  book: ThreadBook,
  no: number,
  limit: number
): { judged: JudgedForeshadow[]; skipped: JudgedForeshadow[] } {
  const planned = new Set(
    plannedFor(book, no)
      .filter((p) => p.event.foreshadowing)
      .map((p) => threadKey(p.event.foreshadowing!))
  );
  /** 计划到期的那一章：计划埋的章，没写就是回收章（埋总在收之前）。 */
  const dueAt = (f: JudgedForeshadow): number | undefined => f.plant ?? f.resolve;
  const rank = (f: JudgedForeshadow): number => {
    if (planned.has(threadKey(f.name))) {
      return 0;
    }
    if (f.status === '计划') {
      const due = dueAt(f);
      return due !== undefined && due <= no ? 1 : 3;
    }
    return 2;
  };
  /** 同一档里的先后：越小越前。 */
  const order = (f: JudgedForeshadow, r: number): number[] =>
    r === 1 ? [dueAt(f)!] : r === 2 ? [f.resolve ?? Number.POSITIVE_INFINITY, -(f.plantedAt ?? 0)] : [];
  const ordered = openForeshadowing(book, no)
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => {
      if (a.r !== b.r) {
        return a.r - b.r;
      }
      const x = order(a.f, a.r);
      const y = order(b.f, b.r);
      for (let k = 0; k < x.length; k++) {
        if (x[k] !== y[k]) {
          return x[k] < y[k] ? -1 : 1;
        }
      }
      return a.i - b.i;
    })
    .map((x) => x.f);
  const n = Math.max(0, limit);
  return { judged: ordered.slice(0, n), skipped: ordered.slice(n) };
}

/** 定稿认出的一条事件：落在哪条线上（缺席是「未归属的伏笔」）。 */
export interface FoundEvent {
  line?: string;
  event: ThreadEvent;
}

/** 定稿从正文里认出的一条新线。 */
export interface FoundThread {
  name: string;
  kind: ThreadKind;
  intent: string;
  evidence: string;
}

/** 定稿从正文里认出的一条新伏笔：挂在哪条线上（已有的或这一次新认出的；缺席是「未归属的伏笔」）。 */
export interface FoundForeshadow {
  name: string;
  what: string;
  line?: string;
  evidence: string;
}

/** 定稿第三步 a 认出来、校验过的全部。 */
export interface ThreadFinds {
  events: FoundEvent[];
  newThreads: FoundThread[];
  newForeshadowing: FoundForeshadow[];
  /** 没收的：哪一条、为什么（第 2 条：说出来）。 */
  dropped: { what: string; why: string }[];
}

function unquoteEvidence(v: unknown): string {
  return cut(unquote(strOf(v)), EVIDENCE_MAX);
}

/**
 * 定稿第三步 a 的输出 → 能记的东西（设计稿「三、a」）。沿用七期 `verifyThreadEvents` 的口径并扩到新线与新伏笔：
 *
 * - **证据**按审稿那套归一化后至少 4 个字、在**整章**正文里找得到（七期修过的上游 #11）；截到 {@link EVIDENCE_MAX} 字。
 *   没有原文撑着的多半是编的，丢掉并说原因。
 * - **新线**：名字合格、种类是四种之一、与已有的线不重名；**主线已有就不收新主线**；一章最多 {@link FINALIZE_NEW_THREAD_LIMIT} 条。
 * - **新伏笔**：名字合格、与全书已有的伏笔不重名；`line` 认得出（已有的线、或这一次新认出的线）就挂上去，认不出的进
 *   「未归属的伏笔」；一章最多 {@link FINALIZE_NEW_FORESHADOW_LIMIT} 条。
 * - **事件**：类型认得出。线的事件（推进 / 关系 / 收束 / 放弃）的 `line` 要是送去认的线之一、或这一次新认出的线，挂不上的
 *   丢掉（关系变动挂不上就丢，设计稿）；伏笔的事件（埋 / 收 / 弃）跟着那条伏笔走——落在它所在的那条线或「未归属的伏笔」
 *   上；没见过的伏笔被「埋」了，当它是一条新伏笔（照上一条挂）；没见过的被「收」「弃」丢掉；**写到这一章之前已经埋下的
 *   再「埋」一次丢掉**（试跑：同一条伏笔记了两次「埋」）；**还没埋下的被「收」「弃」丢掉**（复跑：「计划」状态的伏笔第 1 章
 *   就被「收」掉了）——之前埋过、或者这一章有它的「埋」才算埋下。同一条（同一处、同类型、同一条伏笔、证据归一后相同）只记一次；
 *   一章最多 {@link FINALIZE_EVENT_LIMIT} 个（先校验后截）。
 *
 * `judged` 是送去认的线（只有它们收线的事件）；`book` 用来认全书已有的线名与伏笔名。
 */
export function verifyFinds(
  raw: unknown,
  ctx: { chapter: number; text: string; judged: readonly Pick<Thread, 'name'>[]; book: ThreadBook }
): ThreadFinds {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? x : {}) as Record<string, unknown>);
  const index = indexText(ctx.text);
  const evidenceWhy = (evidence: string): string =>
    quoteFound(index, evidence) ? '' : normalizeQuote(evidence).length < 4 ? '证据太短，认不出是哪一句' : '证据在正文里找不到';
  const out: ThreadFinds = { events: [], newThreads: [], newForeshadowing: [], dropped: [] };

  const allThreads = new Map(ctx.book.threads.map((t) => [threadKey(t.name), t.name]));
  const judged = new Map(ctx.judged.map((t) => [threadKey(t.name), t.name]));
  /** 全书已有的伏笔：名字 → 挂在哪条线上（缺席是未归属）。 */
  const knownFore = new Map<string, { name: string; line?: string }>();
  for (const t of ctx.book.threads) {
    for (const f of foreshadowingOf(t, 0)) {
      knownFore.set(threadKey(f.name), { name: f.name, line: t.name });
    }
  }
  for (const f of foreshadowingOf(ctx.book.unfiled, 0)) {
    if (!knownFore.has(threadKey(f.name))) {
      knownFore.set(threadKey(f.name), { name: f.name });
    }
  }
  /** 写到这一章之前已经埋下的伏笔埋在第几章：再报一次「埋」不记（试跑报告第 11 条：同一条伏笔记了两次「埋」）。 */
  const plantedBefore = new Map<string, number>();
  for (const f of [...ctx.book.threads, ctx.book.unfiled]) {
    for (const s of foreshadowingOf(asOf(f, ctx.chapter), 0)) {
      if (s.plantedAt !== undefined && !plantedBefore.has(threadKey(s.name))) {
        plantedBefore.set(threadKey(s.name), s.plantedAt);
      }
    }
  }

  // 新线先校验：事件与新伏笔可能挂在它上面。
  let mainTaken = ctx.book.threads.some((t) => t.kind === '主线');
  const newLines = new Map<string, string>();
  for (const x of list(o.newThreads)) {
    const name = strOf(x.title ?? x.name);
    const kind = threadKindOf(strOf(x.kind ?? x.type));
    const evidence = unquoteEvidence(x.evidence);
    let why = nameProblem(name);
    if (!why && allThreads.has(threadKey(name))) {
      why = '这条线已经有了';
    } else if (!why && newLines.has(threadKey(name))) {
      why = '同一章里报了两次';
    } else if (!why && !kind) {
      why = '种类不是主线 / 支线 / 感情线 / 人物线之一';
    } else if (!why && kind === '主线' && mainTaken) {
      why = '主线全书只能有一条，已经有了';
    } else if (!why) {
      why = evidenceWhy(evidence);
    }
    if (!why && out.newThreads.length >= FINALIZE_NEW_THREAD_LIMIT) {
      why = `一章最多认出 ${FINALIZE_NEW_THREAD_LIMIT} 条新线`;
    }
    if (why) {
      out.dropped.push({ what: `新线 ${name || '（没有名字）'}`, why });
      continue;
    }
    mainTaken ||= kind === '主线';
    newLines.set(threadKey(name), name);
    out.newThreads.push({ name, kind: kind!, intent: cut(strOf(x.intent), INTENT_MAX), evidence });
  }
  /** `line` 认到哪条线上：已有的线、这一次新认出的线；认不出是 undefined。 */
  const lineOf = (v: unknown): string | undefined => {
    const key = threadKey(strOf(v));
    return key ? (allThreads.get(key) ?? newLines.get(key)) : undefined;
  };

  const newFore = new Map<string, FoundForeshadow>();
  const addForeshadow = (name: string, what: string, line: string | undefined, evidence: string): string => {
    let why = nameProblem(name);
    if (!why && (knownFore.has(threadKey(name)) || newFore.has(threadKey(name)))) {
      why = '这条伏笔已经有了';
    } else if (!why) {
      why = evidenceWhy(evidence);
    }
    if (!why && out.newForeshadowing.length >= FINALIZE_NEW_FORESHADOW_LIMIT) {
      why = `一章最多认出 ${FINALIZE_NEW_FORESHADOW_LIMIT} 条新伏笔`;
    }
    if (why) {
      return why;
    }
    const f: FoundForeshadow = { name, what: cut(what, FORESHADOW_WHAT_MAX), ...(line ? { line } : {}), evidence };
    newFore.set(threadKey(name), f);
    out.newForeshadowing.push(f);
    return '';
  };
  for (const x of list(o.newForeshadowing)) {
    const name = strOf(x.title ?? x.name);
    const why = addForeshadow(name, strOf(x.what), lineOf(x.line ?? x.thread), unquoteEvidence(x.evidence));
    if (why) {
      out.dropped.push({ what: `新伏笔 ${name || '（没有名字）'}`, why });
    }
  }

  /**
   * 这一章埋下的伏笔（复跑之后，2026-10-21）：「收」「弃」要排在「埋」之后——之前埋过（{@link plantedBefore}），或者这一章
   * 有它的「埋」（模型这一次报的、证据找得到的「埋」；重新定稿时这一章已经记下的「埋」；这一章新认出的伏笔，补的那一条「埋」）。
   * 复跑：两条排线排的伏笔第 1 章还是「计划」就被报了「收」，照收了，从此再也不提醒「第 b 章前不要揭开」。
   */
  const plantedHere = new Set<string>(newFore.keys());
  for (const x of list(o.events)) {
    if (eventTypeOf(strOf(x.type)) === '埋' && strOf(x.foreshadowing) && !evidenceWhy(unquoteEvidence(x.evidence))) {
      plantedHere.add(threadKey(strOf(x.foreshadowing)));
    }
  }
  for (const f of [...ctx.book.threads, ctx.book.unfiled]) {
    for (const e of actualEvents(f)) {
      if (e.chapter === ctx.chapter && e.type === '埋' && e.foreshadowing) {
        plantedHere.add(threadKey(e.foreshadowing));
      }
    }
  }

  const accepted: FoundEvent[] = [];
  for (const x of list(o.events)) {
    const lineName = strOf(x.line ?? x.thread);
    const type = eventTypeOf(strOf(x.type));
    const foreName = strOf(x.foreshadowing);
    const what = cut(strOf(x.what ?? x.reason), EVENT_WHAT_MAX);
    const evidence = unquoteEvidence(x.evidence);
    const label = foreName ? `${lineName || '？'}〈${foreName}〉` : lineName || '（没有写是哪一条线）';
    let why = !type ? '事件类型认不出' : evidenceWhy(evidence);
    let found: FoundEvent | undefined;
    if (!why && isForeshadowEvent(type!)) {
      const key = threadKey(foreName);
      const known = knownFore.get(key) ?? newFore.get(key);
      if (!foreName) {
        why = '没写是哪一条伏笔';
      } else if (known && type === '埋' && plantedBefore.has(key)) {
        why = `这条伏笔第 ${plantedBefore.get(key)} 章已经埋下`;
      } else if (known && type !== '埋' && !plantedBefore.has(key) && !plantedHere.has(key)) {
        why = `这条伏笔还没埋下，不能${type}`;
      } else if (known) {
        found = { ...(known.line ? { line: known.line } : {}), event: { chapter: ctx.chapter, planned: false, type: type!, foreshadowing: known.name, what, evidence } };
      } else if (type === '埋') {
        // 没见过的伏笔被埋下了：它就是一条新伏笔，照 `line` 挂。
        const line = lineOf(lineName);
        why = addForeshadow(foreName, what, line, evidence);
        if (!why) {
          found = { ...(line ? { line } : {}), event: { chapter: ctx.chapter, planned: false, type: '埋', foreshadowing: foreName, what, evidence } };
        }
      } else {
        why = '认不出是哪一条伏笔';
      }
    } else if (!why) {
      const key = threadKey(lineName);
      const line = judged.get(key) ?? newLines.get(key);
      if (line) {
        found = { line, event: { chapter: ctx.chapter, planned: false, type: type!, what, evidence } };
      } else {
        why = allThreads.has(key) ? '这条线已经收束，或这一次没送去认' : '认不出是哪一条线';
      }
    }
    if (why || !found) {
      out.dropped.push({ what: label, why: why || '认不出' });
      continue;
    }
    const dup = accepted.some(
      (a) => threadKey(a.line ?? '') === threadKey(found!.line ?? '') && sameEvent(a.event, found!.event)
    );
    if (dup) {
      continue;
    }
    if (accepted.length >= FINALIZE_EVENT_LIMIT) {
      out.dropped.push({ what: label, why: `一章最多记 ${FINALIZE_EVENT_LIMIT} 个事件` });
      continue;
    }
    accepted.push(found);
  }
  out.events = accepted;
  return out;
}

/** 归并：一条新线 / 新伏笔其实是已有的哪一条（c 的输出校验过之后）。 */
export interface ThreadMerge {
  kind: 'thread' | 'foreshadowing';
  from: string;
  into: string;
  /** 并进去了、这一章却没有另记什么时，说清为什么（完成提示照它说，不说「并进了」却什么都没写）。 */
  note?: string;
  /** 模型给的理由（只进日志）。 */
  reason?: string;
}

/** 归并理由最长多少字（只进日志）。 */
const MERGE_REASON_MAX = 60;

/**
 * 归并（c）的输出 → 认得出的几条：`new` 是这一次新认出的线或伏笔的名字，`into` 是同一类里已有的那一条（线并进线、伏笔并进
 * 伏笔）；一个新名字只并一次。认不出的丢掉——不并就是照新的建，什么都不会丢。
 *
 * 伏笔只能并进写到第 `chapter` 章时**还没收、也没弃**的那几条（{@link openForeshadowing}，送给 c 的也只有这几条）：并进收了的，
 * 这一章新露出来的东西就没了着落（「埋」不会再记）。线不限：收束了的线又被正文接上，并进去就是它重新动了。
 */
export function verifyMerges(raw: readonly unknown[], finds: ThreadFinds, book: ThreadBook, chapter: number): ThreadMerge[] {
  const newThreads = new Map(finds.newThreads.map((t) => [threadKey(t.name), t.name]));
  const newFore = new Map(finds.newForeshadowing.map((f) => [threadKey(f.name), f.name]));
  const threads = new Map(book.threads.map((t) => [threadKey(t.name), t.name]));
  const fore = new Map(openForeshadowing(book, chapter).map((f) => [threadKey(f.name), f.name]));
  const out: ThreadMerge[] = [];
  const done = new Set<string>();
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const from = threadKey(strOf(x.new ?? x.from));
    const into = threadKey(strOf(x.into ?? x.existing));
    const reason = cut(strOf(x.reason), MERGE_REASON_MAX);
    if (!from || done.has(from)) {
      continue;
    }
    if (newThreads.has(from) && threads.has(into)) {
      out.push({ kind: 'thread', from: newThreads.get(from)!, into: threads.get(into)!, ...(reason ? { reason } : {}) });
      done.add(from);
    } else if (newFore.has(from) && fore.has(into)) {
      out.push({ kind: 'foreshadowing', from: newFore.get(from)!, into: fore.get(into)!, ...(reason ? { reason } : {}) });
      done.add(from);
    }
  }
  return out;
}

/**
 * 补出来的「埋」插在同一条伏笔这一章的别的事件前面：同一章里状态取写在后面的那条，「收」后面跟一条「埋」会把收了的
 * 算回「已埋」。这一章没有它的别的事件就放在最后。
 */
function plantFirst(events: FoundEvent[], plant: FoundEvent): void {
  const key = threadKey(plant.event.foreshadowing ?? '');
  const at = events.findIndex((e) => threadKey(e.event.foreshadowing ?? '') === key);
  events.splice(at >= 0 ? at : events.length, 0, plant);
}

/**
 * 把归并用上（第 `chapter` 章定稿）：并掉的新线不建，挂在它上面的事件、新伏笔改挂到已有的那条线；并掉的新伏笔不登记，它的
 * 事件改叫已有的那条伏笔、落到那条伏笔所在的线（或「未归属的伏笔」）上。返回新的一份（原来的不动）与带上说明的归并。
 *
 * **新伏笔的那一条「埋」挂到已有的那条伏笔上**（试跑：模型多半只把新伏笔写在 `newForeshadowing` 里、不单列「埋」，隐含的
 * 那一条要等 {@link completeFinds} 补——并掉的已经不在新伏笔里了，这一章的记录整条没了，完成提示却照样说「并进了」）：
 * - 已有的那条写到这一章时还没埋：这一章就是它埋下的一章，记一条「埋〈已有的〉」（证据、一句话用新伏笔的；模型单列了
 *   「埋」的，那一条改叫已有的名字），同一章只记一条；
 * - 已经埋过了（或已经收了、弃了）：**不再记第二条「埋」**，`note` 里说清「第 N 章已经埋下，这一章不再记「埋」」——如实不记，
 *   不编一条别的事件出来（⚑）；模型给这条新伏笔报的别的事件（收、弃）照样改名记下。
 * 并掉的新线这一章一个事件都没带过来（也没有新伏笔挂在它上面）的，`note` 说「这一章没有另记事件」：不替它编一条推进。
 */
export function applyMerges(
  finds: ThreadFinds,
  merges: readonly ThreadMerge[],
  book: ThreadBook,
  chapter: number
): { finds: ThreadFinds; merges: ThreadMerge[] } {
  if (merges.length === 0) {
    return { finds, merges: [] };
  }
  const lineInto = new Map(merges.filter((m) => m.kind === 'thread').map((m) => [threadKey(m.from), m.into]));
  const foreInto = new Map(merges.filter((m) => m.kind === 'foreshadowing').map((m) => [threadKey(m.from), m.into]));
  const ownerOf = new Map<string, string | undefined>();
  /** 写到这一章之前已经不是「计划」的伏笔：埋了（埋在第几章）、收了、弃了。 */
  const before = new Map<string, ForeshadowState>();
  for (const file of [...book.threads, book.unfiled]) {
    const line = file === book.unfiled ? undefined : file.name;
    for (const f of foreshadowingOf(file, 0)) {
      if (!ownerOf.has(threadKey(f.name))) {
        ownerOf.set(threadKey(f.name), line);
      }
    }
    for (const f of foreshadowingOf(asOf(file, chapter), 0)) {
      if (f.status !== '计划' && !before.has(threadKey(f.name))) {
        before.set(threadKey(f.name), f);
      }
    }
  }
  const relink = (line: string | undefined): string | undefined => (line ? (lineInto.get(threadKey(line)) ?? line) : line);
  const plantedHere = (list: readonly FoundEvent[], name: string): boolean =>
    list.some((e) => e.event.type === '埋' && threadKey(e.event.foreshadowing ?? '') === threadKey(name));
  const events: FoundEvent[] = [];
  for (const e of finds.events) {
    const fore = e.event.foreshadowing;
    const into = fore ? foreInto.get(threadKey(fore)) : undefined;
    if (into) {
      // 已有的那条已经埋过、或这一章已经记了它的一条「埋」：不再记一条。
      if (e.event.type === '埋' && (before.has(threadKey(into)) || plantedHere(events, into))) {
        continue;
      }
      const line = ownerOf.get(threadKey(into));
      events.push({ ...(line ? { line } : {}), event: { ...e.event, foreshadowing: into } });
      continue;
    }
    const line = relink(e.line);
    events.push({ ...(line ? { line } : {}), event: e.event });
  }
  const out: ThreadMerge[] = [];
  for (const m of merges) {
    if (m.kind === 'foreshadowing') {
      const done = before.get(threadKey(m.into));
      if (done) {
        const when = done.plantedAt ?? done.closedAt;
        const what = done.status === '已埋' ? '埋下' : done.status === '已收' ? '收了' : '弃了';
        out.push({ ...m, note: `〈${m.into}〉${when !== undefined ? `第 ${when} 章` : ''}已经${what}，这一章不再记「埋」` });
        continue;
      }
      const f = finds.newForeshadowing.find((x) => threadKey(x.name) === threadKey(m.from));
      if (f && !plantedHere(events, m.into)) {
        const line = ownerOf.get(threadKey(m.into));
        plantFirst(events, {
          ...(line ? { line } : {}),
          event: { chapter, planned: false, type: '埋', foreshadowing: m.into, what: f.what || f.name, evidence: f.evidence },
        });
      }
      out.push({ ...m });
    } else {
      const carried =
        finds.events.some((e) => threadKey(e.line ?? '') === threadKey(m.from)) ||
        finds.newForeshadowing.some((f) => threadKey(f.line ?? '') === threadKey(m.from));
      out.push(carried ? { ...m } : { ...m, note: '这一章没有另记事件' });
    }
  }
  const dedup: FoundEvent[] = [];
  for (const e of events) {
    if (!dedup.some((d) => threadKey(d.line ?? '') === threadKey(e.line ?? '') && sameEvent(d.event, e.event))) {
      dedup.push(e);
    }
  }
  return {
    finds: {
      events: dedup,
      newThreads: finds.newThreads.filter((t) => !lineInto.has(threadKey(t.name))),
      newForeshadowing: finds.newForeshadowing
        .filter((f) => !foreInto.has(threadKey(f.name)))
        .map((f) => {
          const line = relink(f.line);
          return { name: f.name, what: f.what, ...(line ? { line } : {}), evidence: f.evidence };
        }),
      dropped: finds.dropped,
    },
    merges: out,
  };
}

/**
 * 补上隐含的那一条事件：新认出的线这一章一个事件都没有，记一条「推进」（认出它的那一句就是证据）；新认出的伏笔这一章
 * 没有「埋」，记一条「埋」（插在它这一章别的事件前面）。这样状态现算得出来（新线进行中、新伏笔已埋），不另记一份「从哪一章起」。
 * 要在 {@link applyMerges} 之后调：并掉的新伏笔那一条「埋」由 applyMerges 挂到已有的那条上。
 */
export function completeFinds(finds: ThreadFinds, chapter: number): ThreadFinds {
  const events = [...finds.events];
  for (const t of finds.newThreads) {
    if (!events.some((e) => threadKey(e.line ?? '') === threadKey(t.name))) {
      events.push({ line: t.name, event: { chapter, planned: false, type: '推进', what: '正文里第一次出现', evidence: t.evidence } });
    }
  }
  for (const f of finds.newForeshadowing) {
    const planted = events.some((e) => e.event.type === '埋' && threadKey(e.event.foreshadowing ?? '') === threadKey(f.name));
    if (!planted) {
      plantFirst(events, {
        ...(f.line ? { line: f.line } : {}),
        event: { chapter, planned: false, type: '埋', foreshadowing: f.name, what: f.what, evidence: f.evidence },
      });
    }
  }
  return { ...finds, events };
}

/** 行首的标签（`【线】`、`线名：`）与末尾的一段括号（`（主线）`、`(支线)`、`〈…〉`、`【…】`、`[…]`、`<…>`）。 */
const NAME_LABEL = /^\s*(?:【\s*线名?\s*】|线名?\s*[:：])\s*/u;
const NAME_TAIL = /\s*(?:（[^（）]*）|\([^()]*\)|〈[^〈〉]*〉|<[^<>]*>|【[^【】]*】|\[[^\[\]]*\])\s*$/u;

/**
 * 模型回线名时常带的装饰去掉之后的样子（试跑：提示里写成「名字（种类）」，模型照抄「沈默的灭门复仇（主线）」）：
 * 行首的「【线】」「线名：」、前后的引号与书名号、末尾一段段的括号，剥到不再变为止。只拿来认名字，不写进文件。
 */
export function bareThreadName(raw: string): string {
  let s = (raw ?? '').trim().replace(NAME_LABEL, '');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = unquote(s).replace(/^《(.*)》$/u, '$1').replace(NAME_TAIL, '').trim();
  }
  return s;
}

/**
 * 当前进度（b）的输出：哪条线、新的当前进度（截到 {@link PROGRESS_MAX} 字）。名字认不出、空的丢掉。
 *
 * 名字认得宽（试跑 22 条只落盘 1 条，第 2 条：不静默丢）：先按原样比，对不上再去掉装饰（{@link bareThreadName}）
 * 比，还对不上、末尾又正好是一个种类名（「名字 · 主线」归一之后是「名字主线」）就去掉种类再比。送去的线之间
 * 原样对得上的优先，所以一条线就叫「某某主线」也不会认错。认不出的由调用方对着送去的那几条说出来。
 */
export function verifyProgress(raw: readonly unknown[], lines: readonly string[]): { line: string; text: string }[] {
  const byKey = new Map(lines.map((n) => [threadKey(n), n]));
  const lineOf = (name: string): string | undefined => {
    const bare = threadKey(bareThreadName(name));
    const kind = THREAD_KINDS.find((k) => bare.length > k.length && bare.endsWith(k));
    return byKey.get(threadKey(name)) ?? byKey.get(bare) ?? (kind ? byKey.get(bare.slice(0, -kind.length)) : undefined);
  };
  const out: { line: string; text: string }[] = [];
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = lineOf(strOf(x.line ?? x.thread ?? x.name));
    const text = cut(strOf(x.text ?? x.progress ?? x['当前进度']), PROGRESS_MAX);
    if (line && text && !out.some((o) => o.line === line)) {
      out.push({ line, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 写正文、审稿：带哪几条

/** 计划收束章离这一章不超过几章算「就在附近」（写正文挑线）。 */
export const NEAR_CLOSE = 5;
/**
 * 写正文时一条线最多列几条没收的伏笔。**本章细纲或本章计划提到的不算在里面**（复跑之后：主线这 4 个位置一直是同样 4 条，
 * 当章细纲里提到的「旧铜牌与铜钱的共鸣」没列出来，正文当章就把它揭开了）——那几条一律列出，只受这一层的总字数管。
 */
export const LINE_FORESHADOW_MAX = 4;
/**
 * 细纲提到一条伏笔的门槛（⚑ 复跑之后）：伏笔名去掉虚字之后的两字词，至少这么多成出现在本章细纲（或本章计划）里，至少
 * 两个、其中两个在名字里挨着（{@link mentionTest}）。「旧铜牌与铜钱的共鸣」对细纲里的「铜牌与铜钱的共鸣契机」算提到，
 * 「阿婆的真实身份」对一句「阿婆」不算。
 */
export const MENTION_RATIO = 0.6;
/** 没有回收章的伏笔写正文时怎么说（复跑之后：从前一律写「不要提前揭开」，没有回收章就没有「提前」可言）。 */
const NO_RESOLVE_HINT = '还没定哪一章收，细纲没安排就别揭开';
/** 一行里「现在」截到多长、最近事件与本章计划每条截到多长：一条线不该一个人吃掉整层的字数（七期上游 #4）。 */
const LINE_NOW_MAX = 80;
const LINE_ITEM_MAX = 40;
const LINE_INTENT_MAX = 60;

/** 压成一行、去掉句末的标点（一行里几段用「；」接，「。；」不好看），超长截断。 */
function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim().replace(/[。；;，,、\s]+$/u, '');
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}

/** 一条要带进上下文的东西（一条线、一条伏笔，或「未归属的伏笔」那一行）。 */
export interface ContextThread {
  /** 那份文件的路径：条目身份与来源都用它。 */
  relPath: string;
  name: string;
  /** 状态：线的状态、伏笔的状态，「未归属的伏笔」那一行是「未归属」。 */
  status: string;
  /** 为什么带它（写进明细）。 */
  why: string;
  /** 越小越靠前。 */
  rank: number;
  line: string;
  /** 这一行里本章细纲或本章计划提到的伏笔（写正文）：这一行放不下时，明细里点名说它们没带上（第 2 条）。 */
  mentioned?: string[];
}

/** 去掉「的之与和及」这几个虚字、按标点与空白切开的几段（同 continuity.ts 的 `textBigrams` 切法）。 */
function wordGroups(text: string): string[][] {
  const groups = (text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[的之与和及]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return groups.map((g) => [...g]);
}

/** 一段里挨着的两字词，按先后。 */
function gramsOf(chars: readonly string[]): string[] {
  return chars.length < 2 ? [] : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
}

/**
 * 认「本章细纲提到了这条伏笔」用的那一份：细纲全文与本章计划（计划事件的伏笔名与一句话，推迟的写法也在里面）。
 * 返回一个判断函数：伏笔名去掉虚字之后的两字词，至少 {@link MENTION_RATIO} 出现在这一份里，至少两个，**而且有两个在名字里
 * 是挨着的**（名字里有连着三个字出现在细纲里）——不然「井底的秘密」会被一句「井底有人」加上别处的「秘密」凑出来。名字只有
 * 一个两字词的（「玉佩」）要整个出现。
 */
export function mentionTest(text: string): (name: string) => boolean {
  const grams = new Set(wordGroups(text).flatMap(gramsOf));
  const norm = normalizeQuote(text);
  return (name) => {
    const groups = wordGroups(name).map(gramsOf);
    const total = groups.reduce((n, g) => n + g.length, 0);
    if (total < 2) {
      const key = threadKey(name);
      return key.length >= 2 && norm.includes(key);
    }
    const hits = groups.map((g) => g.map((x) => grams.has(x)));
    const count = hits.reduce((n, h) => n + h.filter(Boolean).length, 0);
    const run = hits.some((h) => h.some((x, i) => x && h[i + 1]));
    return run && count >= 2 && count / total >= MENTION_RATIO;
  };
}

/** `本章计划：推进——……；埋〈玉佩〉——……`。 */
function plannedText(events: readonly ThreadEvent[]): string {
  return events
    .map((e) => `${e.type}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `——${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
    .join('；');
}

/**
 * 一条没收的伏笔写正文时怎么提醒（设计稿「四」：没到回收章的一律写「第 b 章前不要揭开」，这是这一层存在的另一半理由）。
 * 返回 `[排序, 说法]`；还没到埋的时候（计划中、本章也不埋）返回 undefined——提了等于叫模型提前埋。
 */
function foreshadowHint(f: ForeshadowState, no: number, planned: readonly ThreadEvent[]): [number, string] | undefined {
  const mine = planned.filter((e) => e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name));
  if (mine.some((e) => e.type === '收') || f.resolve === no) {
    return [0, '本章计划收'];
  }
  if (f.resolve !== undefined && f.resolve < no) {
    return [0, `已过第 ${f.resolve} 章，还没收`];
  }
  if (mine.some((e) => e.type === '埋')) {
    return [1, f.resolve !== undefined ? `本章计划埋，第 ${f.resolve} 章前不要揭开` : '本章计划埋，不要当场揭开'];
  }
  if (f.status === '计划' && !(f.plant !== undefined && f.plant <= no)) {
    return undefined;
  }
  return [2, f.resolve !== undefined ? `第 ${f.resolve} 章前不要揭开` : NO_RESOLVE_HINT];
}

/**
 * 一份文件里写第 `no` 章时要提的伏笔：`玉佩的来历（第 18 章前不要揭开）`，该收的、逾期的在前。
 *
 * **本章细纲或本章计划提到的一律列出**（`mentioned`，复跑之后），不占 `max` 那几个位置，排在同一档的最前面；还没到埋的、
 * 本来不提的，被提到了也列出来，写「第 b 章前不要揭开」（细纲要碰它，正文最容易顺手把它揭开）。其余的最多 `max` 条。
 */
function foreshadowList(
  file: ThreadFileBase,
  no: number,
  planned: readonly ThreadEvent[],
  max: number,
  mentioned: (name: string) => boolean
): { text: string; due: boolean; mentioned: string[] } {
  const items = foreshadowingOf(file, no - 1)
    .filter((f) => !isForeshadowClosed(f.status))
    .map((f) => {
      const forced = mentioned(f.name) || planned.some((e) => e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name));
      const hint: [number, string] | undefined =
        foreshadowHint(f, no, planned) ?? (forced ? [2, f.resolve !== undefined ? `第 ${f.resolve} 章前不要揭开` : NO_RESOLVE_HINT] : undefined);
      return { f, hint, forced };
    })
    .filter((x): x is { f: ForeshadowState; hint: [number, string]; forced: boolean } => !!x.hint)
    .sort(
      (a, b) =>
        a.hint[0] - b.hint[0] || Number(b.forced) - Number(a.forced) || (a.f.resolve ?? Infinity) - (b.f.resolve ?? Infinity)
    );
  let rest = 0;
  const shown = items.filter((x) => x.forced || rest++ < max);
  return {
    text: shown.map((x) => `${x.f.name}（${x.hint[1]}）`).join('、'),
    due: items.some((x) => x.hint[0] === 0),
    mentioned: shown.filter((x) => x.forced).map((x) => x.f.name),
  };
}

/** 线最近两条实际事件（写正文的「最近」一栏）：**不取「埋」**（复跑之后：「埋」那一句写的多半是伏笔的谜面，不是这条线走到哪）。 */
function recentText(t: ThreadFileBase): string {
  return actualEvents(t)
    .filter((e) => e.type !== '埋')
    .slice(-2)
    .map((e) => `第 ${e.chapter} 章${e.type}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `：${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
    .join('；');
}

/**
 * 写第 `no` 章时哪几条线算「有关」，按要紧程度排好（不截；设计稿「四、写正文」）：
 *
 * 0. 本章有计划事件的、本章细纲提到了名字的、本章细纲或计划提到了它上面某条伏笔的；
 * 1. 主线；
 * 2. 计划收束章就在附近（{@link NEAR_CLOSE} 章之内）或已经过了的、有伏笔该在本章收或已经逾期的（收束章近的在前）；
 * 3. 最近动过的（近的在前）；计划中、本章已经在它的计划区间里的。
 *
 * 收束了、放弃了的不带——**它上面有本章提到的伏笔除外**，那一行只列那几条伏笔。**计划中、还没到开始那一章、本章也没
 * 计划、细纲也没提的不带**——带进去等于提示模型提前开。「未归属的伏笔」有要提的就单独一行（有该收的、本章有计划或提到
 * 的排在第 2 档，否则最后）。状态、现在走到哪都按「写到这一章时」算（{@link asOf}：当前进度写到这一章或更晚的不用，改用
 * 这一章之前最近两条实际事件，「埋」不算）。
 *
 * 伏笔每行最多 {@link LINE_FORESHADOW_MAX} 条（未归属的一行加倍），**本章细纲或本章计划提到的不算在里面、一律列出**（复跑之后）：
 * 一行变长了也只受这一层的总字数管，放不下时明细里点名说那几条没带上（`mentioned`）。
 */
export function manuscriptThreads(book: ThreadBook, no: number, plotText: string): ContextThread[] {
  const plot = normalizeQuote(plotText);
  // 「提到」认的是细纲全文与本章的计划（各条线里这一章的计划事件：伏笔名、一句话，推迟的写法也在一句话里）。
  const mentioned = mentionTest(
    [plotText, ...plannedFor(book, no).map((p) => `${p.event.foreshadowing ?? ''}\n${p.event.what}`)].join('\n')
  );
  const out: (ContextThread & { tie: number; index: number })[] = [];
  for (const full of book.threads) {
    const t = asOf(full, no);
    const status = threadStatus(t);
    // 本章的计划事件在 asOf 里已经去掉了（只留之前的）：从原样那一份取。
    const planned = plannedEvents(full).filter((e) => e.chapter === no);
    // 收束了的线不带；它上面还开着、本章又提到的伏笔照列（复跑之后：本章细纲提到的伏笔一律列出），别的伏笔不列。
    const fores = foreshadowList(t, no, planned, isClosed(status) ? 0 : LINE_FORESHADOW_MAX, mentioned);
    if (isClosed(status)) {
      if (fores.mentioned.length > 0) {
        out.push({
          relPath: t.relPath,
          name: t.name,
          status,
          why: '本章细纲提到了它上面的伏笔',
          rank: 0,
          line: `- ${t.name}（${t.kind} · ${status}）没收的伏笔：${fores.text}`,
          mentioned: fores.mentioned,
          tie: 0,
          index: t.index,
        });
      }
      continue;
    }
    const key = threadKey(t.name);
    const named = key.length >= 2 && plot.includes(key);
    const state = threadStateAt(t, no - 1);
    const near = t.to !== undefined && (t.to < no || t.to - no <= NEAR_CLOSE);
    let rank: number;
    let why: string;
    let tie = 0;
    if (planned.length > 0 || named || fores.mentioned.length > 0) {
      rank = 0;
      why = planned.length > 0 ? '本章有计划' : named ? '本章细纲提到了它' : '本章细纲提到了它上面的伏笔';
    } else if (t.kind === '主线') {
      rank = 1;
      why = '主线';
    } else if (near || fores.due) {
      rank = 2;
      why = near ? (t.to! < no ? `已过计划收束的第 ${t.to} 章` : `计划第 ${t.to} 章收束，就在附近`) : '有伏笔该收了';
      tie = t.to ?? Number.MAX_SAFE_INTEGER;
    } else if (state.lastActive !== undefined) {
      rank = 3;
      why = `最近第 ${state.lastActive} 章动过`;
      tie = -state.lastActive;
    } else if (status === '计划中' && t.from !== undefined && t.from <= no) {
      rank = 3;
      why = '本章在它的计划区间里';
    } else {
      continue;
    }
    const recent = recentText(t);
    const now = t.progress
      ? `现在：${clip(t.progress, LINE_NOW_MAX)}`
      : recent
        ? `最近：${recent}`
        : t.intent
          ? `意图：${clip(t.intent, LINE_INTENT_MAX)}`
          : '';
    const head = [t.kind, status, t.to !== undefined && t.to < no ? `已过计划收束的第 ${t.to} 章` : t.to === no ? '计划在本章收束' : '']
      .filter(Boolean)
      .join(' · ');
    const parts = [now, planned.length > 0 ? `本章计划：${plannedText(planned)}` : '', fores.text ? `没收的伏笔：${fores.text}` : ''].filter(Boolean);
    out.push({
      relPath: t.relPath,
      name: t.name,
      status,
      why,
      rank,
      line: `- ${t.name}（${head}）${parts.join('；')}`,
      ...(fores.mentioned.length > 0 ? { mentioned: fores.mentioned } : {}),
      tie,
      index: t.index,
    });
  }
  const unfiledPlanned = plannedEvents(book.unfiled).filter((e) => e.chapter === no);
  const loose = foreshadowList(asOf(book.unfiled, no), no, unfiledPlanned, LINE_FORESHADOW_MAX * 2, mentioned);
  if (loose.text || unfiledPlanned.length > 0) {
    const parts = [loose.text, unfiledPlanned.length > 0 ? `本章计划：${plannedText(unfiledPlanned)}` : ''].filter(Boolean);
    const urgent = loose.due || unfiledPlanned.length > 0 || loose.mentioned.length > 0;
    out.push({
      relPath: book.unfiled.relPath,
      name: UNFILED_NAME,
      status: '未归属',
      why: urgent ? '有伏笔该收了、本章有计划或细纲提到了' : '挂不上线的伏笔',
      rank: urgent ? 2 : 4,
      line: `- ${UNFILED_NAME}：${parts.join('；')}`,
      ...(loose.mentioned.length > 0 ? { mentioned: loose.mentioned } : {}),
      tie: Number.MAX_SAFE_INTEGER,
      index: Number.MAX_SAFE_INTEGER,
    });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.index - b.index)
    .map(({ tie: _tie, index: _index, ...c }) => c);
}

/**
 * 审稿第 `no` 章时带哪几条伏笔（设计稿「四、审稿」⚑5：审稿提示词里两条伏笔检查从前的材料——角色卡「未收伏笔」、细纲
 * 「新增伏笔」——都并进了叙事线，这一期先带伏笔部分）：写到这一章时还没收的，只提跟这一章有关的——计划在本章或更早收的、
 * 本章计划埋或收的、已经埋下的（没到回收章就不该揭开）。还没到埋的时候的不提。一条一行，该收的在前。
 */
export function reviewForeshadowing(book: ThreadBook, no: number): ContextThread[] {
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  const out: (ContextThread & { tie: number })[] = [];
  for (const { file, line } of files) {
    const planned = plannedEvents(file).filter((e) => e.chapter === no);
    for (const f of foreshadowingOf(asOf(file, no), no - 1)) {
      if (isForeshadowClosed(f.status)) {
        continue;
      }
      const hint = foreshadowHint(f, no, planned);
      if (!hint) {
        continue;
      }
      const why = hint[1].replace('不要揭开', '不该揭开').replace('不要当场揭开', '不该当场揭开').replace('就别揭开', '就不该揭开');
      out.push({
        relPath: file.relPath,
        name: f.name,
        status: f.status,
        why,
        rank: hint[0],
        line: `- ${f.name}（挂在「${line ?? UNFILED_NAME}」· ${f.status} · ${why}）${f.what ? `是什么：${clip(f.what, LINE_INTENT_MAX)}` : ''}`,
        tie: f.resolve ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.tie - b.tie).map(({ tie: _tie, ...c }) => c);
}

// ---------------------------------------------------------------- 拆细纲：带哪几条

/** 拆细纲时一条线、一条伏笔最多列几条这几章原来的计划（重拆时让模型知道原来怎么排的）。 */
const RANGE_PLAN_MAX = 4;

/**
 * 拆细纲的范围怎么称呼：一章是「本章」，几章一批是「本批」。`threads` 层的标记（「本批要收」）与细纲合同里那条规矩
 * （context/prompts.ts）用同一个说法——合同叫模型认的就是这几个字。
 */
export function planScope(range: { from: number; to: number }): '本章' | '本批' {
  return range.from === range.to ? '本章' : '本批';
}

/**
 * `第 13 章推进——……；第 14 章埋〈玉佩〉`，最多 {@link RANGE_PLAN_MAX} 条。`bare`：一条伏笔自己那一行，不再写伏笔名与说明
 * （`第 7 章收`）。
 */
function rangePlanText(events: readonly ThreadEvent[], bare = false): string {
  const shown = events
    .slice(0, RANGE_PLAN_MAX)
    .map((e) =>
      bare
        ? `第 ${e.chapter} 章${e.type}`
        : `第 ${e.chapter} 章${e.type}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `——${clip(e.what, LINE_ITEM_MAX)}` : ''}`
    )
    .join('；');
  return events.length > RANGE_PLAN_MAX ? `${shown}……（共 ${events.length} 条）` : shown;
}

/** 一条线头上的计划区间：`计划第 3–40 章` / `计划第 3 章起` / `计划第 40 章收束`；过了、落在这几章里的另说。都没写是空串。 */
function linePlanHead(t: Thread, range: { from: number; to: number }): string {
  if (t.to !== undefined && t.to < range.from) {
    return `已过计划收束的第 ${t.to} 章`;
  }
  if (t.to !== undefined && t.to <= range.to) {
    return `计划在第 ${t.to} 章收束`;
  }
  if (t.from !== undefined && t.to !== undefined) {
    return `计划第 ${t.from}–${t.to} 章`;
  }
  if (t.from !== undefined) {
    return `计划第 ${t.from} 章起`;
  }
  return t.to !== undefined ? `计划第 ${t.to} 章收束` : '';
}

/**
 * 拆第 `range` 这几章细纲时带哪几条（设计稿「二」：`plot` 配方的 `threads` 层，讨论、落定也用这一张）。排好序、不截；
 * 线与伏笔分两组，各自封顶（上下文详细度 `plotThreadCount` / `plotForeshadowCount` / `plotThreadChars`）。都按「写到区间
 * 第一章时」算（{@link asOf}）：重拆前面的章不带后面几章记下的事。
 *
 * **线**：全部没收束的，一条一行——种类、状态、计划区间、意图、现在走到哪（当前进度；写到区间第一章或更晚的不用）、
 * 最近两条实际事件、这几章原来的计划（重拆时让模型知道原来怎么排的）。排法：这几章原来有计划的 → 主线 → 进行中的
 * （最近动过的在前）→ 计划中、这几章已经在它的计划区间里的 → 还没到开始那一章的（⚑ 也带，写明「还不到」：拆细纲要
 * 知道后面有这条线，才不会另起一条、也不会提前开）。
 *
 * **伏笔**：写到区间第一章时还没收、也没弃的（线收束了，伏笔照样可能开着），一条一行。排法：计划在这几章或更早收的
 * （「本批要收」/「已过第 b 章，还没收」，回收章早的在前；还没埋的另说「还没埋，先埋再收」）→ 这几章原来有计划的 → 已经
 * 埋下的（埋得早的在前）、计划在这几章或更早埋的（「本批要埋」/「计划第 a 章埋，还没埋」）→ 还没定哪一章埋的。**计划在
 * 这几章之后才埋的不带**（提了等于叫模型提前埋）；还没开始的线上没定哪一章埋的也不带。
 */
export function plotThreads(
  book: ThreadBook,
  range: { from: number; to: number }
): { lines: ContextThread[]; foreshadowing: ContextThread[] } {
  const { from, to } = range;
  const scope = planScope(range);
  const inRange = (e: ThreadEvent): boolean => e.planned && e.chapter >= from && e.chapter <= to;
  const lines: (ContextThread & { tie: number; index: number })[] = [];
  /** 还没到开始那一章的线：它上面没定哪一章埋的伏笔不带。 */
  const later = new Set<string>();
  for (const full of book.threads) {
    const t = asOf(full, from);
    const status = threadStatus(t);
    if (isClosed(status)) {
      continue;
    }
    // 这几章的计划事件在 asOf 里已经去掉了（只留之前的）：从原样那一份取。
    const planned = full.events.filter(inRange);
    const linePlan = planned.filter((e) => !isForeshadowEvent(e.type));
    const lastActive = lastActiveChapter(t);
    const notYet = status === '计划中' && t.from !== undefined && t.from > to;
    if (notYet) {
      later.add(threadKey(t.name));
    }
    let rank: number;
    let why: string;
    let tie = 0;
    if (planned.length > 0) {
      rank = 0;
      why = `${scope}原来有计划`;
    } else if (t.kind === '主线') {
      rank = 1;
      why = '主线';
    } else if (status === '进行中') {
      rank = 2;
      why = `最近第 ${lastActive} 章动过`;
      tie = -(lastActive ?? 0);
    } else if (!notYet) {
      rank = 3;
      why = `${scope}在它的计划区间里`;
      tie = t.from ?? 0;
    } else {
      rank = 4;
      why = `计划第 ${t.from} 章起，${scope}还不到`;
      tie = t.from!;
    }
    const recent = actualEvents(t)
      .slice(-2)
      .map((e) => `第 ${e.chapter} 章${e.type}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `：${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
      .join('；');
    const head = [t.kind, status, linePlanHead(t, range)].filter(Boolean).join(' · ');
    const parts = [
      t.intent ? `意图：${clip(t.intent, LINE_INTENT_MAX)}` : '',
      t.progress ? `现在：${clip(t.progress, LINE_NOW_MAX)}` : '',
      recent ? `最近：${recent}` : '',
      linePlan.length > 0 ? `${scope}原来的计划：${rangePlanText(linePlan)}` : '',
      notYet ? `${scope}还不到它开始的那一章，不要提前开` : '',
    ].filter(Boolean);
    lines.push({ relPath: t.relPath, name: t.name, status, why, rank, line: `- ${t.name}（${head}）${parts.join('；')}`, tie, index: t.index });
  }

  const fores: (ContextThread & { tie: number; order: number })[] = [];
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  for (const { file, line } of files) {
    const planned = file.events.filter((e) => inRange(e) && e.foreshadowing);
    const notYet = !!line && later.has(threadKey(line));
    for (const f of foreshadowingOf(asOf(file, from), from - 1)) {
      if (isForeshadowClosed(f.status)) {
        continue;
      }
      const mine = planned.filter((e) => threadKey(e.foreshadowing!) === threadKey(f.name));
      let rank: number;
      let hint: string;
      let tie = 0;
      if (f.resolve !== undefined && f.resolve <= to) {
        rank = 0;
        hint = f.resolve < from ? `已过第 ${f.resolve} 章，还没收` : scope === '本章' ? '本章要收' : `本批要收，最晚第 ${f.resolve} 章`;
        // 复跑之后：「收」要排在「埋」之后（resolvePlanEvents），还没埋、前面也没排过「埋」的说清楚，免得只排一条收、被丢掉。
        const plantedPlan = file.events.some(
          (e) => e.planned && e.type === '埋' && e.chapter < from && !!e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name)
        );
        hint += f.status === '计划' && !plantedPlan ? '，还没埋，先埋再收' : '';
        tie = f.resolve;
      } else if (mine.length > 0) {
        rank = 1;
        hint = f.resolve !== undefined ? `第 ${f.resolve} 章前收` : '还没定哪一章收';
        tie = mine[0].chapter;
      } else if (f.status === '已埋') {
        rank = 2;
        hint = f.resolve !== undefined ? `第 ${f.resolve} 章前收，之前不要揭开` : '还没定哪一章收，不要随手揭开';
        tie = f.plantedAt ?? 0;
      } else if (f.plant !== undefined && f.plant <= to) {
        rank = 2;
        // 复跑之后：在这几章里该埋的标「本批要埋」，过了还没埋的标「还没埋」——合同里那条规矩认的就是这两种说法。
        hint = `${f.plant < from ? `计划第 ${f.plant} 章埋，还没埋` : `${scope}要埋，计划第 ${f.plant} 章`}${f.resolve !== undefined ? `、第 ${f.resolve} 章前收` : ''}`;
        tie = f.plant;
      } else if (f.plant === undefined && !notYet) {
        rank = 3;
        hint = '还没定哪一章埋';
      } else {
        // 计划在这几章之后才埋、或挂在还没开始的线上：提了等于叫模型提前埋。
        continue;
      }
      const parts = [f.what ? `是什么：${clip(f.what, LINE_INTENT_MAX)}` : '', mine.length > 0 ? `${scope}原来的计划：${rangePlanText(mine, true)}` : ''].filter(Boolean);
      fores.push({
        relPath: file.relPath,
        name: f.name,
        status: f.status,
        why: hint,
        rank,
        line: `- ${f.name}（挂在「${line ?? UNFILED_NAME}」· ${f.status} · ${hint}）${parts.join('；')}`,
        tie,
        order: fores.length,
      });
    }
  }
  return {
    lines: lines.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.index - b.index).map(({ tie: _tie, index: _index, ...c }) => c),
    foreshadowing: fores.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.order - b.order).map(({ tie: _tie, order: _order, ...c }) => c),
  };
}

/**
 * 按排好的顺序取，最多 `count` 条、一共 `chars` 字（只算各行）。放不下的那条**跳过、接着试下一条**（七期修过的上游 `break`：
 * 一条长的挡住后面所有短的）。丢了的带原因交给调用方写进明细（第 2 条）。`what` 是明细里怎么称呼（「叙事线」「伏笔」）。
 */
export function fitThreads<T extends { line: string }>(
  list: readonly T[],
  limits: { count: number; chars: number },
  what = '叙事线'
): { picked: T[]; dropped: (T & { note: string })[] } {
  const picked: T[] = [];
  const dropped: (T & { note: string })[] = [];
  let used = 0;
  for (const c of list) {
    const cost = c.line.length + (picked.length > 0 ? 1 : 0);
    if (picked.length >= limits.count) {
      dropped.push({ ...c, note: `${what}一次只带 ${limits.count} 条，排在后面的没带` });
    } else if (used + cost > limits.chars) {
      dropped.push({ ...c, note: `${what}一共只带 ${limits.chars} 字，放不下这一条` });
    } else {
      used += cost;
      picked.push(c);
    }
  }
  return { picked, dropped };
}

// ---------------------------------------------------------------- 拆细纲：计划事件（二期）

/**
 * 细纲合同里一章的 `threads` 一项（设计稿「二」）：这一章在哪条线上计划发生什么。`line` 是模型写的线名，落盘时才认
 * （{@link resolvePlanEvents}）——解码时手上没有叙事线目录。
 */
export interface PlanEntry {
  line: string;
  type: ThreadEventType;
  /** 埋 / 收的是哪一条伏笔。 */
  foreshadowing?: string;
  what: string;
  /** 埋一条新伏笔时：计划第几章前收。 */
  resolve?: number;
}

/** 一章最多写几条计划（设计稿：一章最多 6 条）。 */
export const PLAN_EVENT_LIMIT = 6;

/**
 * 计划里能写的类型：线的推进 / 关系 / 收束，伏笔的埋 / 收。⚑ 设计稿的合同只列了「推进|关系|埋|收」四种，这里多认一个
 * 「收束」——一条线计划在哪一章走完是排细纲时就定得下来的事，写正文那一层会提醒「本章计划：收束」。放弃、弃不是计划
 * 出来的，不认。
 */
export const PLAN_EVENT_TYPES: readonly ThreadEventType[] = ['推进', '关系', '收束', '埋', '收'];

/**
 * 解码一章的 `threads`（批次的 features/blueprint.ts 与单章的 features/artifact.ts 共用，第 22 条）。**宽松收、绝不抛**：
 * 一个可选字段写坏了不该作废整章细纲。没写（undefined / null）返回 undefined——落盘时不动这一章原来的计划（老会话里存着
 * 的草稿没有这个字段，第 1 条）；写成别的形状当空的并说一句。
 *
 * 每项：类型要是 {@link PLAN_EVENT_TYPES} 之一；线的事件要写 `line`，伏笔的事件要写 `foreshadowing`（名字合格）；
 * 「是什么」截到 {@link EVENT_WHAT_MAX} 字；`resolve` 只对埋有用、要比本章晚。同一条（同线、同类型、同一条伏笔）只留
 * 第一条；最多 {@link PLAN_EVENT_LIMIT} 条（先校验后截）。没收的写进 `notes`（第 2 条：卡片与日志里说出来）。
 */
export function decodePlanEntries(raw: unknown, no: number): { entries?: PlanEntry[]; notes: string[] } {
  if (raw === undefined || raw === null) {
    return { notes: [] };
  }
  const where = no > 0 ? `第 ${no} 章的叙事线计划` : '叙事线计划';
  if (!Array.isArray(raw)) {
    return { entries: [], notes: [`${where}（threads）不是列表，当没有计划`] };
  }
  const entries: PlanEntry[] = [];
  const notes: string[] = [];
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = strOf(x.line ?? x.thread);
    const typeText = strOf(x.type);
    const type = eventTypeOf(typeText);
    const fore = strOf(x.foreshadowing);
    const label = `${line || '？'}${fore ? `〈${fore}〉` : ''} ${typeText || '（没写类型）'}`;
    let why = '';
    if (!type || !PLAN_EVENT_TYPES.includes(type)) {
      why = '类型不是推进 / 关系 / 收束 / 埋 / 收之一';
    } else if (isForeshadowEvent(type) && !fore) {
      why = '没写是哪一条伏笔';
    } else if (isForeshadowEvent(type) && nameProblem(fore)) {
      why = `伏笔${nameProblem(fore)}`;
    } else if (!isForeshadowEvent(type) && !line) {
      why = '没写是哪一条线';
    }
    if (why) {
      notes.push(`${where} ${label}：${why}，没收`);
      continue;
    }
    const entry: PlanEntry = {
      line,
      type: type!,
      ...(isForeshadowEvent(type!) ? { foreshadowing: fore } : {}),
      what: cut(strOf(x.what ?? x.reason), EVENT_WHAT_MAX),
    };
    const resolve = intOf(x.resolve);
    if (type === '埋' && resolve !== undefined && resolve > no) {
      entry.resolve = resolve;
    }
    const same = entries.some(
      (e) =>
        e.type === entry.type &&
        threadKey(e.foreshadowing ?? '') === threadKey(entry.foreshadowing ?? '') &&
        (isForeshadowEvent(e.type) || threadKey(e.line) === threadKey(entry.line))
    );
    if (same) {
      continue;
    }
    if (entries.length >= PLAN_EVENT_LIMIT) {
      notes.push(`${where} ${label}：一章最多写 ${PLAN_EVENT_LIMIT} 条，没收`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, notes };
}

/** 计划事件在细纲合同里的样子（`renderBlueprints` 写回规范化输出、作者在气泡里改了再写入时原样认得）。 */
export function planEntryJson(e: PlanEntry): Record<string, unknown> {
  return {
    line: e.line,
    type: e.type,
    ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}),
    what: e.what,
    ...(e.resolve !== undefined ? { resolve: e.resolve } : {}),
  };
}

/** 一章的计划落到各条线上的样子（{@link resolvePlanEvents}）。 */
export interface PlannedChapter {
  no: number;
  /** 要写进去的计划事件：落在哪条线上（缺席是「未归属的伏笔」）。 */
  events: FoundEvent[];
  /** 这一章新登记的伏笔（埋了一条没见过的）：挂在哪条线上（缺席是「未归属的伏笔」）。 */
  newForeshadowing: { line?: string; foreshadowing: Foreshadowing }[];
  /** 没写进去的：哪一条、为什么。 */
  dropped: { what: string; why: string }[];
  /** 这一章原来有几条计划事件（写入时整组换掉）。 */
  replaced: number;
}

/**
 * 几章的计划 → 落到哪份文件上（设计稿「谁能写什么」：计划事件随细纲走）。纯函数，按章号先后走一遍：前面几章新埋的伏笔，
 * 后面几章收它认得出。都按「写到这一章时」认线与伏笔的状态（{@link asOf}）。
 *
 * - **线的事件**（推进 / 关系 / 收束）：`line` 认得出、写到这一章时还没收束的线才记；认不出的丢掉（设计稿：其余丢掉并写进
 *   卡片与日志）。
 * - **伏笔的事件**（埋 / 收）跟着那条伏笔走，落在它所在的线或「未归属的伏笔」上，不看 `line`（同定稿 a，一期前半 ⚑7）。
 *   写到这一章时已经收了、弃了的不记；已经埋下的再「埋」不记；**「收」要排在「埋」之后**（复跑之后）：写到这一章时已经
 *   实际埋下，或者计划里更早的一章「埋」它（这一次不换掉的那几章里已有的计划，或这一批前面几章刚排的），不然丢掉。
 * - **没见过的伏笔**：「埋」就是一条新伏笔——`line` 认得出、还没收束就挂在那条线上，认不出进「未归属的伏笔」（设计稿），
 *   登记成 `名：是什么（计划第 N 章埋、第 b 章前收）`；「收」丢掉。名字与全书已有的、前面几章刚埋的不重复。
 * - 同一份文件里同一条只记一次。
 */
export function resolvePlanEvents(
  book: ThreadBook,
  chapters: readonly { no: number; entries: readonly PlanEntry[] }[]
): PlannedChapter[] {
  const lines = new Map(book.threads.map((t) => [threadKey(t.name), t]));
  /** 全书已有的伏笔：名字 → 在哪份文件（线名；缺席是未归属）。 */
  const owner = new Map<string, { name: string; line?: string }>();
  for (const t of book.threads) {
    for (const f of foreshadowingOf(t, 0)) {
      owner.set(threadKey(f.name), { name: f.name, line: t.name });
    }
  }
  for (const f of foreshadowingOf(book.unfiled, 0)) {
    if (!owner.has(threadKey(f.name))) {
      owner.set(threadKey(f.name), { name: f.name });
    }
  }
  const fileOf = (line: string | undefined): ThreadFileBase => (line ? lines.get(threadKey(line))! : book.unfiled);
  /**
   * 计划里最早哪一章「埋」它（复跑之后：计划「收」要排在计划「埋」或实际「埋」之后）。先认这一次不换掉的那几章里已有的
   * 计划，这一批按章号走到哪、埋了哪条再加上。
   */
  const rewriting = new Set(chapters.map((c) => c.no));
  const plantPlanned = new Map<string, number>();
  const notePlant = (name: string, no: number): void => {
    const key = threadKey(name);
    plantPlanned.set(key, Math.min(plantPlanned.get(key) ?? Number.POSITIVE_INFINITY, no));
  };
  for (const f of [...book.threads, book.unfiled]) {
    for (const e of plannedEvents(f)) {
      if (e.type === '埋' && e.foreshadowing && !rewriting.has(e.chapter)) {
        notePlant(e.foreshadowing, e.chapter);
      }
    }
  }
  const out: PlannedChapter[] = [];
  for (const { no, entries } of [...chapters].sort((a, b) => a.no - b.no)) {
    const ch: PlannedChapter = { no, events: [], newForeshadowing: [], dropped: [], replaced: plannedFor(book, no).length };
    const openLine = (name: string): Thread | undefined => {
      const t = lines.get(threadKey(name));
      return t && !isClosed(threadStatus(asOf(t, no))) ? t : undefined;
    };
    const push = (line: string | undefined, event: ThreadEvent): void => {
      if (!ch.events.some((e) => threadKey(e.line ?? '') === threadKey(line ?? '') && sameEvent(e.event, event))) {
        ch.events.push({ ...(line ? { line } : {}), event });
      }
    };
    for (const p of entries) {
      const label = p.foreshadowing ? `${p.type}〈${p.foreshadowing}〉` : `${p.line} ${p.type}`;
      if (!isForeshadowEvent(p.type)) {
        const t = openLine(p.line);
        if (t) {
          push(t.name, { chapter: no, planned: true, type: p.type, what: p.what });
        } else {
          ch.dropped.push({ what: label, why: lines.has(threadKey(p.line)) ? '这条线已经收束了' : '认不出是哪一条线' });
        }
        continue;
      }
      const known = owner.get(threadKey(p.foreshadowing!));
      if (known) {
        const state = foreshadowingOf(asOf(fileOf(known.line), no), no - 1).find((f) => threadKey(f.name) === threadKey(known.name));
        const plantAt = plantPlanned.get(threadKey(known.name));
        if (state && isForeshadowClosed(state.status)) {
          ch.dropped.push({ what: label, why: `这条伏笔已经${state.status === '已收' ? '收' : '弃'}了` });
        } else if (p.type === '埋' && state?.status === '已埋') {
          ch.dropped.push({ what: label, why: `这条伏笔第 ${state.plantedAt} 章已经埋下了` });
        } else if (p.type === '收' && state?.status !== '已埋' && !(plantAt !== undefined && plantAt < no)) {
          ch.dropped.push({ what: label, why: '这条伏笔还没埋，「收」要排在「埋」之后（先在更早的一章安排「埋」）' });
        } else {
          if (p.type === '埋') {
            notePlant(known.name, no);
          }
          push(known.line, { chapter: no, planned: true, type: p.type, foreshadowing: known.name, what: p.what });
        }
        continue;
      }
      if (p.type !== '埋') {
        ch.dropped.push({ what: label, why: '认不出是哪一条伏笔' });
        continue;
      }
      const line = p.line ? openLine(p.line)?.name : undefined;
      const foreshadowing: Foreshadowing = {
        name: p.foreshadowing!,
        what: cut(p.what, FORESHADOW_WHAT_MAX),
        plant: no,
        ...(p.resolve !== undefined ? { resolve: p.resolve } : {}),
      };
      owner.set(threadKey(foreshadowing.name), { name: foreshadowing.name, ...(line ? { line } : {}) });
      notePlant(foreshadowing.name, no);
      ch.newForeshadowing.push({ ...(line ? { line } : {}), foreshadowing });
      push(line, { chapter: no, planned: true, type: '埋', foreshadowing: foreshadowing.name, what: p.what });
    }
    out.push(ch);
  }
  return out;
}

/** 拆细纲之后，到期却没安排的一条伏笔（{@link unplannedDue}）。 */
export interface UnplannedDue {
  name: string;
  /** 挂在哪条线上（缺席是「未归属的伏笔」）。 */
  line?: string;
  /** 该埋（计划埋的章到了、还没埋）、该收（计划回收章到了、还没收），这一批都没安排。 */
  need: ('埋' | '收')[];
  plant?: number;
  resolve?: number;
}

/**
 * 拆细纲的程序检查（复跑之后，2026-10-21；模型只排「推进」，到期该埋的三条一条也没排）：写进去的这几章（第 a–b 章）里到期、
 * 却没安排的伏笔。**不调模型、不拦人**，列在写入卡片的说明与日志里（features/threadPlan.ts）。都按写到第 a 章时算（{@link asOf}）：
 *
 * - **该埋**：还是「计划」、伏笔那一行写的计划埋的章 ≤ b（这几章里的，或者早就过了的）；
 * - **该收**：还没收、也没弃，计划回收章 ≤ b。
 *
 * 算安排过的：这一批的计划落到线上之后（{@link resolvePlanEvents}：没埋就收的已经丢掉了）有它的「埋」/「收」；这一次不换掉的、
 * 第 a 章及以后的章里原来就有它的计划「埋」/「收」（一批里跳过的已有细纲、单章重拆时后面几章的计划）；或者这一批哪一条
 * 计划的 what 里提到了它、写明「推迟」（合同里的推迟写法：给它所在的线写一条推进，「〈伏笔名〉推迟到第 N 章收」）。
 */
export function unplannedDue(book: ThreadBook, chapters: readonly { no: number; entries: readonly PlanEntry[] }[]): UnplannedDue[] {
  if (chapters.length === 0) {
    return [];
  }
  const nos = chapters.map((c) => c.no);
  const from = Math.min(...nos);
  const to = Math.max(...nos);
  const rewriting = new Set(nos);
  const arranged = { 埋: new Set<string>(), 收: new Set<string>() };
  for (const c of resolvePlanEvents(book, chapters)) {
    for (const { event } of c.events) {
      if ((event.type === '埋' || event.type === '收') && event.foreshadowing) {
        arranged[event.type].add(threadKey(event.foreshadowing));
      }
    }
  }
  for (const f of [...book.threads, book.unfiled]) {
    for (const e of plannedEvents(f)) {
      if ((e.type === '埋' || e.type === '收') && e.foreshadowing && e.chapter >= from && !rewriting.has(e.chapter)) {
        arranged[e.type].add(threadKey(e.foreshadowing));
      }
    }
  }
  const delays = chapters.flatMap((c) => c.entries.map((e) => e.what)).filter((w) => w.includes('推迟')).map(normalizeQuote);
  const delayed = (name: string): boolean => {
    const key = threadKey(name);
    return key.length > 0 && delays.some((w) => w.includes(key));
  };
  const out: UnplannedDue[] = [];
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  for (const { file, line } of files) {
    for (const f of foreshadowingOf(asOf(file, from), from - 1)) {
      if (isForeshadowClosed(f.status) || delayed(f.name)) {
        continue;
      }
      const key = threadKey(f.name);
      const need: ('埋' | '收')[] = [];
      if (f.status === '计划' && f.plant !== undefined && f.plant <= to && !arranged.埋.has(key)) {
        need.push('埋');
      }
      if (f.resolve !== undefined && f.resolve <= to && !arranged.收.has(key)) {
        need.push('收');
      }
      if (need.length > 0) {
        out.push({
          name: f.name,
          ...(line ? { line } : {}),
          need,
          ...(f.plant !== undefined ? { plant: f.plant } : {}),
          ...(f.resolve !== undefined ? { resolve: f.resolve } : {}),
        });
      }
    }
  }
  return out;
}

/** `〈阿婆的真实身份〉（计划第 5 章埋，还没埋）`、`〈井底的秘密〉（第 13 章前收）`。 */
export function describeUnplannedDue(u: UnplannedDue): string {
  const parts = [
    u.need.includes('埋') ? `计划第 ${u.plant} 章埋，还没埋` : '',
    u.need.includes('收') ? `第 ${u.resolve} 章前收` : '',
  ].filter(Boolean);
  return `〈${u.name}〉（${parts.join('；')}）`;
}

// ---------------------------------------------------------------- 写前检查：两类提醒要的数（二期）

/**
 * 写前检查的叙事线提醒要的数（设计稿「四、写前检查」；判断在 model/pipeline.ts 的 `threadRemindersFor`，前端也打包那一份）。
 * `no` 给了就按「写到第 `no` 章时」算（{@link asOf}：只看之前的实际事件、状态）；不给就是现在的样子（工程页数据，前端批量
 * 写章弹窗用）。计划事件从原样那一份取——要看的正是这一章及以后有没有安排。
 *
 * - 线：进行中的才算（计划中的还没开始、收束了的不会断），带最近一次实际事件、`STALL_CHAPTERS` 的阈值、哪几章有计划事件
 *   （这条线的文件里任何一条计划事件都算安排了：推进、关系、伏笔的埋与收都说明这一章要动它）。
 * - 伏笔：还没收、也没弃、写了计划回收章的（各条线与「未归属的伏笔」里的都算，线收束了伏笔照样可能开着），带哪几章计划收它。
 */
export function threadWatch(book: ThreadBook, no?: number): ThreadWatch {
  const at = <T extends ThreadFileBase>(f: T): T => (no === undefined ? f : asOf(f, no));
  const chapters = (events: readonly ThreadEvent[]): number[] => [...new Set(events.map((e) => e.chapter))].sort((a, b) => a - b);
  const lines: ThreadWatch['lines'] = [];
  for (const full of book.threads) {
    const t = at(full);
    const lastActive = lastActiveChapter(t);
    if (threadStatus(t) !== '进行中' || lastActive === undefined) {
      continue;
    }
    lines.push({ name: t.name, kind: t.kind, lastActive, stall: STALL_CHAPTERS[t.kind], planned: chapters(plannedEvents(full)) });
  }
  const foreshadowing: ThreadWatch['foreshadowing'] = [];
  for (const file of [...book.threads, book.unfiled] as ThreadFileBase[]) {
    for (const f of foreshadowingOf(at(file), 0)) {
      if (isForeshadowClosed(f.status) || f.resolve === undefined) {
        continue;
      }
      const resolving = plannedEvents(file).filter((e) => e.type === '收' && e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name));
      foreshadowing.push({ name: f.name, resolve: f.resolve, planned: chapters(resolving) });
    }
  }
  return { lines, foreshadowing };
}

// ---------------------------------------------------------------- 当前进度（机器维护、指纹守着）

/** 「当前进度」的指纹。只看内容：首尾空白不算，占位文字当空（同角色卡 `stateHashOf`）。 */
export function progressHashOf(text: string): string {
  return hash(hasContent(text) ? text.trim() : '');
}

/**
 * 「当前进度」现在归机器（可以直接写）还是归作者（不写，挂黄 ❗）。照角色卡「当前状态」的做法
 * （model/characterState.ts）：空的归机器；记过指纹、而且对得上的归机器；其余（改过、或者从没记过指纹却有
 * 内容）归作者。
 */
export function progressOwnedByMachine(thread: Pick<Thread, 'progress' | 'progressHash'>): boolean {
  if (!hasContent(thread.progress)) {
    return true;
  }
  return !!thread.progressHash && thread.progressHash === progressHashOf(thread.progress);
}

/**
 * 在一条线的原文上换掉「当前进度」并盖章（`progressThrough` / `progressHash`），**其余一个字不动**。
 * 手写的线可能没有 frontmatter：那就在最前面补一段只有这两个字段的。
 */
export function patchProgress(raw: string, progress: string, through: number): string {
  const body = replaceSection(raw ?? '', '当前进度', progress);
  const fm = { progressThrough: through, progressHash: progressHashOf(progress) };
  return rewriteFrontmatter(body, fm) ?? `${stringifyFrontmatter(fm)}\n\n${body.replace(/^﻿/, '')}`;
}
