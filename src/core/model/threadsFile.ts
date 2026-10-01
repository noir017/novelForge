/**
 * 叙事线（`.novelforge/threads.md`）：跨章的伏笔与线索，计划在第几章埋下、第几章前回收，
 * 以及正文里推进到了哪一步（七期）。
 *
 * ```markdown
 * ## 玉佩的来历
 * - 类型：伏笔
 * - 计划：第 2–8 章
 * - 意图：林昭身上的玉佩是沈家旧物，第 8 章前揭开他的身世。
 * - 事件：
 *   - 第 3 章 · 埋下：「他摸了摸怀里那块温润的玉佩」——玉佩第一次露面
 * ```
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的 `src/shared/narrative-thread.ts`
 * 与 `narrative-thread-repository.ts`：上游存在 SQLite 里，这里是作者的 Markdown（第 17 条：
 * 内容只落 Markdown）。字段一一对应——`type` → 类型、`targetStartChapter` / `targetEndChapter`
 * → 计划、`authorIntent` → 意图、确认过的事件 → 事件行。
 *
 * ## 三条约定
 *
 * - **状态不落盘**（与流水线状态同一个口径）：取章号最大的那条事件的类型，同章取写在后面的；
 *   没有事件就是「计划中」。上游也是每次读的时候折出来的（repository `list()`）。
 * - **机器只追加、不改写**（第 3 条）：{@link appendThreads} 在文件末尾加新线，
 *   {@link appendEvents} 在一条线的事件列表末尾加一行。作者写的字一个都不动，不整份重渲染。
 * - **怎么手改都不崩**（第 1 条）：认不出的行原样留着，不当成线、也不当成事件。
 *
 * 纯函数，无 I/O。
 */
import { indexText, normalizeQuote, quoteFound } from './review';

// ---------------------------------------------------------------- 类型

/** 事件的四种（上游 `planted / progressing / resolved / abandoned`）。 */
export type ThreadEventType = '埋下' | '推进' | '回收' | '放弃';
export const THREAD_EVENT_TYPES: readonly ThreadEventType[] = ['埋下', '推进', '回收', '放弃'];

/** 一条线此刻的状态（由事件推出来，不落盘）。 */
export type ThreadStatus = '计划中' | '已埋下' | '推进中' | '已回收' | '已放弃';

const STATUS_OF: Record<ThreadEventType, ThreadStatus> = {
  埋下: '已埋下',
  推进: '推进中',
  回收: '已回收',
  放弃: '已放弃',
};

/** 正文里的一次推进。`evidence` 是那一章正文里的一句原文；手写的事件可能没有。 */
export interface ThreadEvent {
  chapter: number;
  type: ThreadEventType;
  evidence: string;
  reason: string;
}

export interface Thread {
  title: string;
  /** 类型：伏笔、悬念、人物承诺……自由文字（上游也不设枚举）。 */
  kind: string;
  /** 计划从第几章埋下。没写区间时缺席。 */
  from?: number;
  /** 计划在第几章前回收。 */
  to?: number;
  intent: string;
  events: ThreadEvent[];
  /** 在文件里是第几条（0 起）。同档排序时按它。 */
  index: number;
}

/** 新排出来的一条线（还没有事件）。 */
export interface ThreadPlan {
  title: string;
  kind: string;
  from: number;
  to: number;
  intent: string;
}

/** 写正文时最多带几条（上游 `ACTIVE_THREAD_LIMIT`）。 */
export const ACTIVE_THREAD_LIMIT = 6;
/** 写正文时一共最多带多少字（上游 `ACTIVE_THREAD_CHAR_LIMIT`）。 */
export const ACTIVE_THREAD_CHARS = 1200;
/** 一次最多排出几条（上游 `PLAN_CANDIDATE_LIMIT`；提示词要的是 3–8 条）。 */
export const THREAD_PLAN_LIMIT = 8;
/** 定稿时一章最多记几条事件（上游 `EVENT_CANDIDATE_LIMIT`）。 */
export const THREAD_EVENT_LIMIT = 5;
/** 定稿时最多送几条线去判（比写正文时宽：判漏了比多带几行贵）。 */
export const THREAD_JUDGE_LIMIT = 12;

const TITLE_MAX = 30;
const KIND_MAX = 12;
const INTENT_MAX = 200;
/** 证据最长多少字（上游 240）。 */
const EVIDENCE_MAX = 240;
const REASON_MAX = 100;
/** 写正文时一行里意图、证据各截到多长：一条线不该一个人吃掉 1200 字（上游 #4）。 */
const LINE_INTENT_MAX = 60;
const LINE_EVIDENCE_MAX = 40;

/** 新建 `threads.md` 时的文件头。解析时 `## ` 之前的东西一律忽略。 */
export const THREADS_TEMPLATE = [
  '# 叙事线',
  '',
  '> 跨章的伏笔与线索。每条线一个「## 名字」：类型、计划（从第 a 章埋下、到第 b 章前回收）、意图，以及正文里推进到了哪一步（事件，一章一行，带一句正文原文）。',
  '> 状态看章号最大的那条事件：埋下 / 推进 / 回收 / 放弃；还没有事件就是计划中。写正文时会挑最多 6 条和本章有关、还没收的线带进上下文。',
  '> 可以手改。工程页「从细纲排出」只在末尾追加新线，定稿只在事件列表末尾追加一行，你写的字不会被改。',
].join('\n');

// ---------------------------------------------------------------- 解析

const HEADING = /^##(?!#)\s*(.*?)\s*#*\s*$/u;
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s*/u;
const FIELD = /^(类型|种类|计划|区间|计划区间|回收区间|意图|作者意图|说明|事件)\s*[:：]\s*(.*)$/u;
const EVENT_HEAD = /^第\s*(\d+)\s*章\s*/u;

/**
 * 事件类型的几种写法，按前缀认（「埋下伏笔」按「埋下」认）。不收单字的「埋」「收」：
 * 「第 3 章 收到密信」会被认成回收。
 */
const TYPE_ALIASES: [string, ThreadEventType][] = [
  ['planted', '埋下'],
  ['progressing', '推进'],
  ['resolved', '回收'],
  ['abandoned', '放弃'],
  ['埋下', '埋下'],
  ['埋设', '埋下'],
  ['推进', '推进'],
  ['进展', '推进'],
  ['回收', '回收'],
  ['兑现', '回收'],
  ['揭开', '回收'],
  ['放弃', '放弃'],
  ['作废', '放弃'],
];

/** 认事件类型（模型给的、作者写的都走这一个）。认不出返回 undefined。 */
export function eventTypeOf(text: string): ThreadEventType | undefined {
  const t = (text ?? '').trim().toLowerCase();
  return TYPE_ALIASES.find(([alias]) => t.startsWith(alias))?.[1];
}

/** 「第 2–8 章」「第2-8章」「2~8」「第 5 章」。认不出返回空对象。 */
export function parseRange(text: string): { from?: number; to?: number } {
  const s = (text ?? '').trim();
  const pair = /(\d+)\s*(?:章\s*)?[-–—~～至到]+\s*(?:第\s*)?(\d+)/u.exec(s);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    return a > 0 && b > 0 ? { from: Math.min(a, b), to: Math.max(a, b) } : {};
  }
  const one = /(\d+)/u.exec(s);
  const n = one ? Number(one[1]) : 0;
  return n > 0 ? { from: n, to: n } : {};
}

const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];

/** 事件行去掉 `第 N 章` 之后的那一截：`· 埋下：「原文」——理由`。 */
function parseEventRest(chapter: number, rest: string): ThreadEvent {
  let s = rest.replace(/^[\s·・\-—:：|｜]+/u, '');
  const type = eventTypeOf(s);
  if (type) {
    const alias = TYPE_ALIASES.find(([a]) => s.toLowerCase().startsWith(a))![0];
    s = s.slice(alias.length);
  }
  s = s.replace(/^[\s·・:：]+/u, '');
  let evidence = '';
  for (const [a, b] of QUOTES) {
    if (s.startsWith(a)) {
      const end = s.indexOf(b, a.length);
      if (end > 0) {
        evidence = s.slice(a.length, end).trim();
        s = s.slice(end + b.length);
      }
      break;
    }
  }
  const reason = s.replace(/^[\s—\-:：]+/u, '').trim();
  // 没写类型的事件行按「推进」算：作者记了一笔，说明这条线动过。
  return { chapter, type: type ?? '推进', evidence, reason };
}

/**
 * 读 `threads.md`。`## ` 之前的东西（标题、说明）忽略；一个 `## ` 是一条线；线下面认
 * 「类型 / 计划 / 意图 / 事件」几个字段与 `第 N 章 …` 的事件行（缩进在「事件：」下面、
 * 或顶格写都认）。认不出的行跳过。标题空的线跳过。
 */
export function parseThreads(text: string): Thread[] {
  const out: Thread[] = [];
  let cur: Thread | undefined;
  for (const raw of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const heading = HEADING.exec(raw);
    if (heading) {
      const title = heading[1].trim();
      cur = title ? { title, kind: '', intent: '', events: [], index: out.length } : undefined;
      if (cur) {
        out.push(cur);
      }
      continue;
    }
    if (!cur || /^#\s/.test(raw)) {
      continue;
    }
    const line = raw.replace(BULLET, '').trim();
    if (!line) {
      continue;
    }
    const event = EVENT_HEAD.exec(line);
    if (event) {
      const chapter = Number(event[1]);
      if (chapter > 0) {
        cur.events.push(parseEventRest(chapter, line.slice(event[0].length)));
      }
      continue;
    }
    const field = FIELD.exec(line);
    if (!field) {
      continue;
    }
    const [, key, value] = field;
    if (key === '类型' || key === '种类') {
      cur.kind = value.trim();
    } else if (key === '意图' || key === '作者意图' || key === '说明') {
      cur.intent = value.trim();
    } else if (key !== '事件') {
      const r = parseRange(value);
      cur.from = r.from;
      cur.to = r.to;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 状态

/** 章号最大的那条事件（同章取写在后面的）。没有事件返回 undefined。 */
export function lastEvent(thread: Thread): ThreadEvent | undefined {
  let best: ThreadEvent | undefined;
  for (const e of thread.events) {
    if (!best || e.chapter >= best.chapter) {
      best = e;
    }
  }
  return best;
}

export function threadStatus(thread: Thread): ThreadStatus {
  const last = lastEvent(thread);
  return last ? STATUS_OF[last.type] : '计划中';
}

/**
 * 写到第 `no` 章时这条线的样子：只留第 `no` 章**之前**的事件。重写、重新定稿早前的章时，
 * 后面几章记下的事在那一章看来还没有发生——带进去就是把后面的剧情透给前面（与
 * `evidence` 层只取 `previous` 同一个道理）。
 */
export function asOf(thread: Thread, no: number): Thread {
  const events = thread.events.filter((e) => e.chapter < no);
  return events.length === thread.events.length ? thread : { ...thread, events };
}

/** 已回收、已放弃：收了的线不再带进上下文、不再判事件。 */
export function isClosed(status: ThreadStatus): boolean {
  return status === '已回收' || status === '已放弃';
}

/** 同名判据：审稿引文那一套归一化（NFKC、去空白与标点）。 */
export function threadKey(title: string): string {
  return normalizeQuote(title);
}

/** 工程页那一行的计数。`current` 是写到第几章（下一可写章 − 1）。 */
export function countThreads(
  threads: readonly Thread[],
  current: number
): { total: number; open: number; closed: number; overdue: number } {
  let open = 0;
  let closed = 0;
  let overdue = 0;
  for (const t of threads) {
    if (isClosed(threadStatus(t))) {
      closed++;
    } else {
      open++;
      if (t.to !== undefined && current > t.to) {
        overdue++;
      }
    }
  }
  return { total: threads.length, open, closed, overdue };
}

// ---------------------------------------------------------------- 写入（外科式）

function rangeText(from: number | undefined, to: number | undefined): string {
  if (from === undefined || to === undefined) {
    return '';
  }
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/** 一条新线的整块文字。 */
export function renderThreadBlock(plan: ThreadPlan): string {
  return [
    `## ${plan.title.trim()}`,
    `- 类型：${plan.kind.trim()}`,
    `- 计划：${rangeText(plan.from, plan.to)}`,
    `- 意图：${plan.intent.trim()}`,
    '- 事件：',
  ].join('\n');
}

/** `第 3 章 · 埋下：「原文」——理由`（不带缩进与项目符号）。 */
export function renderEventLine(e: ThreadEvent): string {
  const evidence = e.evidence.trim() ? `「${e.evidence.trim()}」` : '';
  const reason = e.reason.trim() ? `——${e.reason.trim()}` : '';
  return `第 ${e.chapter} 章 · ${e.type}：${evidence}${reason}`;
}

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

/**
 * 在文件末尾追加几条新线。文件是空的（或不存在，传空串）时先写文件头。原文件的 BOM、换行符
 * 与其余每一行原样保留。
 */
export function appendThreads(raw: string, plans: readonly ThreadPlan[]): string {
  const blocks = plans.map(renderThreadBlock);
  if (!(raw ?? '').replace(/^﻿/, '').trim()) {
    return `${THREADS_TEMPLATE}\n\n${blocks.join('\n\n')}\n`;
  }
  const l = splitLines(raw);
  while (l.lines.length > 0 && !l.lines[l.lines.length - 1].trim()) {
    l.lines.pop();
  }
  l.lines.push('', ...blocks.join('\n\n').split('\n'), '');
  return joinLines(l);
}

/**
 * 给名叫 `title` 的那条线追加几条事件：插在它最后一条事件行后面（缩进照那一行）；没有事件行
 * 就插在「- 事件：」后面；连「- 事件：」也没有就在这条线的末尾补一行再插。找不到这条线
 * 返回 undefined（调用方记日志）。其余每一行原样保留。
 */
export function appendEvents(raw: string, title: string, events: readonly ThreadEvent[]): string | undefined {
  if (events.length === 0) {
    return raw;
  }
  const l = splitLines(raw ?? '');
  const key = threadKey(title);
  const start = l.lines.findIndex((line) => {
    const m = HEADING.exec(line);
    return !!m && threadKey(m[1]) === key;
  });
  if (start < 0) {
    return undefined;
  }
  let end = l.lines.length;
  for (let i = start + 1; i < l.lines.length; i++) {
    if (HEADING.exec(l.lines[i]) || /^#\s/.test(l.lines[i])) {
      end = i;
      break;
    }
  }
  let lastEventLine = -1;
  let fieldLine = -1;
  for (let i = start + 1; i < end; i++) {
    const content = l.lines[i].replace(BULLET, '').trim();
    if (EVENT_HEAD.test(content)) {
      lastEventLine = i;
    } else if (/^事件\s*[:：]/u.test(content)) {
      fieldLine = i;
    }
  }
  const indentOf = (line: string): string => /^\s*/.exec(line)![0];
  let at: number;
  let prefix: string;
  const insert: string[] = [];
  if (lastEventLine >= 0) {
    at = lastEventLine + 1;
    const line = l.lines[lastEventLine];
    prefix = `${indentOf(line)}${BULLET.test(line) ? '- ' : ''}`;
  } else if (fieldLine >= 0) {
    at = fieldLine + 1;
    prefix = `${indentOf(l.lines[fieldLine])}  - `;
  } else {
    // 这条线的末尾（跳过它后面的空行），补一行「- 事件：」。
    at = end;
    while (at > start + 1 && !l.lines[at - 1].trim()) {
      at--;
    }
    insert.push('- 事件：');
    prefix = '  - ';
  }
  insert.push(...events.map((e) => `${prefix}${renderEventLine(e)}`));
  l.lines.splice(at, 0, ...insert);
  return joinLines(l);
}

// ---------------------------------------------------------------- 写正文时带哪几条

/** 写这一章的人手上有什么：章号、细纲原文（标题、目的、关键事件、钩子）、计划出场的人。 */
export interface ThreadFocus {
  no: number;
  plotText: string;
  names: readonly string[];
}

/** 一条候选：为什么带它（写进明细）。`rank` 越小越靠前。 */
export interface ThreadCandidate {
  thread: Thread;
  status: ThreadStatus;
  rank: number;
  why: string;
}

/**
 * 写这一章时哪几条线算「有关」，按要紧程度排好（不截）。
 *
 * 上游按创建顺序取前 6 条（`listRelevantActive` + `slice(0, 6)`，上游 #2），这里排序：
 *
 * 1. 本章细纲提到了它的名字；
 * 2. 本章在它的计划区间里（回收章近的在前）；
 * 3. 本章已经过了它的回收章；
 * 4. 它已经埋下了、还没收（最近一次推进近的在前）；
 * 5. 只是本章出场的人出现在它的名字或意图里。
 *
 * 收了的线不带。**计划中、还没到埋下那一章、细纲也没提到的线不带**——带进去等于提示模型
 * 提前埋。同档按文件里的顺序。状态、最近一次推进都按「写到这一章时」算（{@link asOf}），
 * 候选里的 `thread` 就是那个样子。
 */
export function threadCandidates(threads: readonly Thread[], focus: ThreadFocus): ThreadCandidate[] {
  const plot = normalizeQuote(focus.plotText);
  const names = focus.names.map((n) => n.trim()).filter((n) => n.length >= 2);
  const out: ThreadCandidate[] = [];
  for (const full of threads) {
    const thread = asOf(full, focus.no);
    const status = threadStatus(thread);
    if (isClosed(status)) {
      continue;
    }
    const key = threadKey(thread.title);
    const mentioned = key.length >= 2 && plot.includes(key);
    const { from, to } = thread;
    const inRange = from !== undefined && to !== undefined && from <= focus.no && focus.no <= to;
    const overdue = to !== undefined && focus.no > to;
    const planted = thread.events.length > 0;
    const byName = names.some((n) => thread.title.includes(n) || thread.intent.includes(n));
    if (!mentioned && status === '计划中' && from !== undefined && from > focus.no) {
      continue;
    }
    let rank: number;
    let why: string;
    if (mentioned) {
      rank = 0;
      why = '本章细纲提到了它';
    } else if (inRange) {
      rank = 1;
      why = focus.no === to ? '计划在本章前后回收' : '本章在它的计划区间里';
    } else if (overdue) {
      rank = 2;
      why = `已过计划回收的第 ${to} 章，还没收`;
    } else if (planted) {
      rank = 3;
      why = '已经埋下，还没收';
    } else if (byName) {
      rank = 4;
      why = '本章出场的人与它有关';
    } else {
      continue;
    }
    out.push({ thread, status, rank, why });
  }
  const tie = (c: ThreadCandidate): number => {
    if (c.rank === 1 || c.rank === 2) {
      return c.thread.to ?? Number.MAX_SAFE_INTEGER;
    }
    if (c.rank === 3) {
      return -(lastEvent(c.thread)?.chapter ?? 0);
    }
    return 0;
  };
  return out.sort((a, b) => a.rank - b.rank || tie(a) - tie(b) || a.thread.index - b.thread.index);
}

function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}

/**
 * 写正文时的一行：
 * `- 玉佩的来历（伏笔 · 已埋下 · 第 2 章埋、第 8 章前收；第 8 章之前不要揭开）意图：……；最近：第 3 章「……」`
 *
 * 状态用中文（上游把英文枚举塞进中文提示词，上游 #7）。「不要揭开」是这一层存在的另一半理由：
 * 模型知道了第 8 章要揭开什么，写第 3 章时最顺手的就是提前揭开。
 */
export function renderThreadLine(thread: Thread, status: ThreadStatus, no: number): string {
  const { from, to } = thread;
  const plan =
    from !== undefined && to !== undefined
      ? from === to
        ? `计划第 ${from} 章`
        : `第 ${from} 章埋、第 ${to} 章前收`
      : '';
  let hint = '';
  if (to !== undefined) {
    if (no < to) {
      hint = `第 ${to} 章之前不要揭开`;
    } else if (no === to) {
      hint = '计划在本章前后回收，以本章细纲为准';
    } else {
      hint = `已过计划回收的第 ${to} 章`;
    }
  }
  const head = [thread.kind.trim(), status, [plan, hint].filter(Boolean).join('；')].filter(Boolean).join(' · ');
  const last = lastEvent(thread);
  const recent = last
    ? `；最近：第 ${last.chapter} 章${
        last.evidence.trim() ? `「${clip(last.evidence, LINE_EVIDENCE_MAX)}」` : ` ${last.type}${last.reason ? `（${clip(last.reason, LINE_EVIDENCE_MAX)}）` : ''}`
      }`
    : '';
  const intent = thread.intent.trim() ? `意图：${clip(thread.intent, LINE_INTENT_MAX)}` : '';
  return `- ${thread.title}（${head}）${intent}${recent}`;
}

export interface PickedThread extends ThreadCandidate {
  line: string;
}

/**
 * 按 {@link threadCandidates} 的顺序取，最多 {@link ACTIVE_THREAD_LIMIT} 条、一共
 * {@link ACTIVE_THREAD_CHARS} 字（只算各行，不算小节标题）。放不下的那条**跳过、接着试下一条**
 * （上游是 `break`：一条长的挡住后面所有短的）。丢了的带原因交给调用方写进明细（第 2 条）。
 */
export function pickActiveThreads(
  threads: readonly Thread[],
  focus: ThreadFocus,
  limits: { count?: number; chars?: number } = {}
): { picked: PickedThread[]; dropped: (ThreadCandidate & { note: string })[] } {
  const count = limits.count ?? ACTIVE_THREAD_LIMIT;
  const chars = limits.chars ?? ACTIVE_THREAD_CHARS;
  const picked: PickedThread[] = [];
  const dropped: (ThreadCandidate & { note: string })[] = [];
  let used = 0;
  for (const c of threadCandidates(threads, focus)) {
    const line = renderThreadLine(c.thread, c.status, focus.no);
    const cost = line.length + (picked.length > 0 ? 1 : 0);
    if (picked.length >= count) {
      dropped.push({ ...c, note: `叙事线一次只带 ${count} 条，排在后面的没带` });
    } else if (used + cost > chars) {
      dropped.push({ ...c, note: `叙事线一共只带 ${chars} 字，放不下这一条` });
    } else {
      used += cost;
      picked.push({ ...c, line });
    }
  }
  return { picked, dropped };
}

// ---------------------------------------------------------------- 校验模型的输出

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

/** {@link verifyThreadPlans} 给重名那一条的原因。完成提示里把它和「不合格」分开说。 */
export const SAME_THREAD = '同名的线已经有了';

/**
 * 排线时模型交回来的候选 → 能追加的线。
 *
 * **先逐条校验、再取前 {@link THREAD_PLAN_LIMIT} 条**（上游先截到 8 条再校验，前面几条坏了，
 * 后面好的也跟着丢，上游 #8）。名字 1–30 字（太长的不收：名字就是这条线的身份）；类型截到
 * 12 字、意图截到 200 字；`1 ≤ from ≤ to`，知道总章数时 `to ≤ 总章数`；与已有的线、与同一批里
 * 前面的重名就跳过。
 */
export function verifyThreadPlans(
  raw: readonly unknown[],
  existing: readonly Thread[],
  totalChapters?: number
): { plans: ThreadPlan[]; dropped: { title: string; why: string }[] } {
  const seen = new Set(existing.map((t) => threadKey(t.title)));
  const plans: ThreadPlan[] = [];
  const dropped: { title: string; why: string }[] = [];
  for (const item of raw) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const title = strOf(o.title).replace(/^#+\s*/, '');
    const kind = cut(strOf(o.type ?? o.kind), KIND_MAX);
    const intent = cut(strOf(o.intent ?? o.authorIntent), INTENT_MAX);
    const from = intOf(o.from ?? o.targetStartChapter);
    const to = intOf(o.to ?? o.targetEndChapter);
    const name = title || '（没有名字）';
    let why = '';
    if (!title) {
      why = '没有名字';
    } else if ([...title].length > TITLE_MAX) {
      why = `名字超过 ${TITLE_MAX} 字`;
    } else if (!kind || !intent) {
      why = '类型或意图是空的';
    } else if (from === undefined || to === undefined || from < 1 || to < from) {
      why = '计划区间不对';
    } else if (totalChapters && to > totalChapters) {
      why = `计划回收的第 ${to} 章超出了全书 ${totalChapters} 章`;
    } else if (seen.has(threadKey(title))) {
      why = SAME_THREAD;
    }
    if (why) {
      dropped.push({ title: name, why });
      continue;
    }
    seen.add(threadKey(title));
    if (plans.length >= THREAD_PLAN_LIMIT) {
      dropped.push({ title, why: `一次最多排 ${THREAD_PLAN_LIMIT} 条` });
      continue;
    }
    plans.push({ title, kind, from: from!, to: to!, intent });
  }
  return { plans, dropped };
}

function unquote(s: string): string {
  const t = s.trim();
  for (const [a, b] of QUOTES) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

/**
 * 定稿时模型交回来的事件 → 能追加的事件（按线分好）。
 *
 * - `thread` 要认得出（同名归一），而且是这一次送去判的线之一；
 * - `type` 是四种之一；
 * - **证据按审稿那套归一化后在本章正文里找得到**，且归一后至少 4 个字（上游只去空白，
 *   一个「。」也算逐字出现，上游 #11）；证据截到 240 字、理由截到 100 字；
 * - 同一条线、同一章、证据归一后相同的事件已经有了（重新定稿同一章）就不重复记；
 * - 最多 {@link THREAD_EVENT_LIMIT} 条（先校验后截，同 {@link verifyThreadPlans}）。
 *
 * 找不到证据、认不出线的丢弃并带原因：没有原文撑着的事件多半是编的（与连续性事实同一个理由）。
 */
export function verifyThreadEvents(
  raw: readonly unknown[],
  judged: readonly Thread[],
  chapter: number,
  text: string
): { events: { thread: Thread; event: ThreadEvent }[]; dropped: { thread: string; why: string }[] } {
  const byKey = new Map(judged.map((t) => [threadKey(t.title), t]));
  const index = indexText(text);
  const events: { thread: Thread; event: ThreadEvent }[] = [];
  const dropped: { thread: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const t of judged) {
    for (const e of t.events) {
      if (e.chapter === chapter && e.evidence) {
        seen.add(`${threadKey(t.title)}|${normalizeQuote(e.evidence)}`);
      }
    }
  }
  for (const item of raw) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = strOf(o.thread ?? o.title) || '（没有写是哪一条）';
    const thread = byKey.get(threadKey(name));
    const type = eventTypeOf(strOf(o.type));
    const evidence = cut(unquote(strOf(o.evidence)), EVIDENCE_MAX);
    const reason = cut(strOf(o.reason), REASON_MAX);
    let why = '';
    if (!thread) {
      why = '认不出是哪一条线';
    } else if (!type) {
      why = '事件类型认不出';
    } else if (!quoteFound(index, evidence)) {
      why = normalizeQuote(evidence).length < 4 ? '证据太短，认不出是哪一句' : '证据在正文里找不到';
    }
    if (why) {
      dropped.push({ thread: name, why });
      continue;
    }
    const key = `${threadKey(thread!.title)}|${normalizeQuote(evidence)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (events.length >= THREAD_EVENT_LIMIT) {
      dropped.push({ thread: thread!.title, why: `一章最多记 ${THREAD_EVENT_LIMIT} 条` });
      continue;
    }
    events.push({ thread: thread!, event: { chapter, type: type!, evidence, reason } });
  }
  return { events, dropped };
}

/**
 * 定稿时送哪几条线去判：写到这一章时还没收的（{@link asOf}），按写正文时同一个顺序排在前面
 * （与本章有关的先判），其余按文件顺序跟在后面，最多 {@link THREAD_JUDGE_LIMIT} 条。返回送去的
 * 与没送的——都是文件里的**原样**（带着全部事件，{@link verifyThreadEvents} 去重要看同一章已经
 * 记过的）。
 */
export function threadsToJudge(
  threads: readonly Thread[],
  focus: ThreadFocus
): { judged: Thread[]; skipped: Thread[] } {
  const ordered = threadCandidates(threads, focus).map((c) => threads[c.thread.index]);
  for (const t of threads) {
    if (!ordered.includes(t) && !isClosed(threadStatus(asOf(t, focus.no)))) {
      ordered.push(t);
    }
  }
  return { judged: ordered.slice(0, THREAD_JUDGE_LIMIT), skipped: ordered.slice(THREAD_JUDGE_LIMIT) };
}
