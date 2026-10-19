/**
 * 全书查找替换在**一份文件**上的那几件事：哪些字不搜不换（机器记的账、解析器认的结构）、找出这份文件里的每一处、
 * 每一处那一行的上下文、预览时每一处换成什么。纯函数、零 I/O——读盘与按范围列文件在 `views/bookFind.ts`，
 * 写盘在 `features/bookReplace.ts`。匹配口径本身是 `textFind.ts`（与内置编辑器的查找条同一份）。
 *
 * ## 哪些字不搜不换（⚑）
 *
 * 全书替换一次能改几百份文件，作者在预览里不可能逐行看清每一处落在哪。下面这几样**被换掉就会安静地坏掉工程**，
 * 所以压在它们上面的匹配一律不列、不换（单份文件的查找条照旧找得到，那是作者自己一处一处看着改）：
 *
 * 1. **frontmatter 里除了「人写的值」以外的一切**：`---` 两条围栏、每一行的键名，以及机器记的账——指纹
 *    （`upstreamHash` / `writtenFrom` / `sourceHash` / `stateHash` / `bodyHash`，第 18 条的指纹链就记在这里）、
 *    章号与字数（`no` / `targetWords` / `totalChapters` / `wordsPerChapter`）、水位与出场（`through` /
 *    `updatedThrough` / `stateThrough` / `firstAppear` / `lastSeen` / `appearsIn`）、状态位（`status` /
 *    `factCheckOk` / `paragraphStyle` / `generatedBy`）。搜一个「3」换成「三」，不该顺手把 `sourceHash` 里的 3
 *    也换掉、让几百章悄悄退回待定稿。**名字、别名、标题、出场（`cast`）、关键词、一句话这些人写的值照常搜、照常换**——
 *    「把林晚全书改成林婉」要连角色卡的 `name`、细纲的 `cast` 一起改才改得干净。
 * 2. **解析器认的小节标题**：细纲的八节与第九节「设定」、角色卡的七节、设定条目的三节与「暗设」（以它开头的标题都算）、
 *    架构三件的各节、文风指南的「禁用词表」——`## 关键事件` 被换成 `## 关键事情`，这一节就读不出来了，
 *    那一章从「排过细纲」退回「待写细纲」。
 *    标题行整行不搜。情节大纲的区间标题（`## 第1–20章：标题`）只护住「第1–20章」那一截（第几章到第几章决定
 *    每一章细纲的上游是哪一节），后面的标题照常。
 *
 * 正文、草稿是作者的文件，一个字都不护。
 */
import { CONFIG_SECTION_KEYS, PREMISE_SECTION_KEYS, WORLD_SECTION_KEYS } from './settingFile';
import { CHARACTER_SECTION_KEYS } from './types';
import { LORE_BODY_KEYS, LORE_HIDDEN_KEY, PLOT_LORE_KEY } from './loreFile';
import { PLOT_SECTION_KEYS } from './plotFile';
import { RANGE_HEADING } from './outlineFile';
import { BOOK_FIND_CONTEXT } from './bookFindScope';
import { FindMatch, FindOptions, compileSearch, expandReplacement, findMatches } from './textFind';

/**
 * frontmatter 里机器记的账：这些键的值不搜不换（见文件头第 1 条）。别的键（`name` / `aliases` / `title` /
 * `cast` / `keywords` / `brief` / `tags` / `gender` / `genre` / `preflightOk`……，以及作者自己加的键）是人写的值。
 */
export const MACHINE_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  // 指纹（第 18 条）
  'upstreamHash',
  'writtenFrom',
  'sourceHash',
  'stateHash',
  'bodyHash',
  // 章号、字数、水位、出场
  'no',
  'targetWords',
  'totalChapters',
  'wordsPerChapter',
  'through',
  'updatedThrough',
  'stateThrough',
  'firstAppear',
  'lastSeen',
  'appearsIn',
  // 状态位
  'status',
  'factCheckOk',
  'paragraphStyle',
  'generatedBy',
]);

/** 各种文件里解析器认的小节标题（见文件头第 2 条）。键是 `workspace/kind.ts` 的种类名。 */
const STRUCTURAL_HEADINGS: Record<string, readonly string[]> = {
  plot: [...PLOT_SECTION_KEYS, PLOT_LORE_KEY],
  character: CHARACTER_SECTION_KEYS,
  lore: LORE_BODY_KEYS,
  setting: [...CONFIG_SECTION_KEYS, ...PREMISE_SECTION_KEYS, ...WORLD_SECTION_KEYS],
  style: ['禁用词表'],
};

/**
 * 以它开头就算的小节标题：设定条目的「暗设」（完善设定，2026-10-19）。`## 暗设（未揭示）` 也认
 * （与 loreFile.ts 的 `splitLoreHidden` 同一个认法）——「暗设」两个字被换掉，这一节就成了明面，写正文时也带进去。
 */
const STRUCTURAL_PREFIXES: Record<string, readonly string[]> = {
  lore: [LORE_HIDDEN_KEY],
};

/** 正文与草稿：作者的文件，一个字都不护。 */
const PROSE_KINDS: ReadonlySet<string> = new Set(['chapter', 'draft']);

/** 与 `model/markdown.ts` 的 `FM_FENCE` 同一个认法（那边认得出的 frontmatter，这里才护）。 */
const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 与 `markdown.ts` 的 `pickSections` 同一个归一（忽略空白与常见标点），小节标题才认得一样。 */
function normalizeKey(s: string): string {
  return s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase();
}

interface Span {
  start: number;
  end: number;
}

/**
 * 这份文件里哪些字不搜不换：`fence` 是整段 frontmatter（含两条围栏），`open` 是其中人写的值（可以搜）；
 * `blocked` 是 frontmatter 之外护住的几段（小节标题行、大纲区间标题的那一截）。
 */
export interface Protection {
  fence?: Span;
  open: Span[];
  blocked: Span[];
}

/** 这一份文件（`kind` 是 `workspace/kind.ts` 的种类名）里哪些字不搜不换。绝不抛。 */
export function protectionOf(text: string, kind: string): Protection {
  const out: Protection = { open: [], blocked: [] };
  if (PROSE_KINDS.has(kind)) {
    return out;
  }
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fm = FM_FENCE.exec(text.slice(bom));
  let bodyStart = 0;
  if (fm) {
    out.fence = { start: bom, end: bom + fm[0].length };
    bodyStart = out.fence.end;
    const innerStart = bom + (fm[0].startsWith('---\r\n') ? 5 : 4);
    out.open = openValues(fm[1], innerStart);
  }
  const headings = STRUCTURAL_HEADINGS[kind];
  const keys = headings ? new Set(headings.map(normalizeKey)) : undefined;
  const prefixes = (STRUCTURAL_PREFIXES[kind] ?? []).map(normalizeKey);
  if (!keys && kind !== 'outline') {
    return out;
  }
  for (const line of linesFrom(text, bodyStart)) {
    if (keys) {
      const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line.text);
      const key = heading ? normalizeKey(heading[1].replace(/[:：]\s*$/, '')) : '';
      if (heading && (keys.has(key) || prefixes.some((p) => key.startsWith(p)))) {
        out.blocked.push({ start: line.start, end: line.start + line.text.length });
      }
    } else {
      // 情节大纲：区间标题只护「第 a–b 章」那一截，后面的标题照常。
      const m = RANGE_HEADING.exec(line.text);
      if (m && (m[3] || m[5])) {
        const trimmed = line.text.replace(/\s+$/, '');
        const titleStart = trimmed.length - (m[6] ?? '').length;
        out.blocked.push({ start: line.start, end: line.start + titleStart });
      }
    }
  }
  return out;
}

/** frontmatter 里人写的那几段值（键名、机器记的账、围栏不在里面）。 */
function openValues(inner: string, offset: number): Span[] {
  const open: Span[] = [];
  let listKeyIsHuman = false;
  for (const line of linesFrom(inner, 0)) {
    const start = offset + line.start;
    const text = line.text;
    const item = /^(\s*-\s+)(.*)$/.exec(text);
    if (item) {
      if (listKeyIsHuman && item[2].trim()) {
        open.push({ start: start + item[1].length, end: start + item[1].length + item[2].length });
      }
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)(\s*:\s*)(.*)$/.exec(text);
    if (!kv) {
      listKeyIsHuman = false;
      continue;
    }
    const human = !MACHINE_FRONTMATTER_KEYS.has(kv[1]);
    const value = kv[3];
    if (value.trim() === '') {
      listKeyIsHuman = human;
      continue;
    }
    listKeyIsHuman = false;
    if (human) {
      const valueStart = start + kv[1].length + kv[2].length;
      open.push({ start: valueStart, end: valueStart + value.length });
    }
  }
  return open;
}

/** 从 `from` 起一行一行（不含换行符，行尾的 `\r` 也去掉），带每一行在全文里的起点。 */
function linesFrom(text: string, from: number): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let pos = from;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end);
    out.push({ start: pos, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    if (nl === -1) {
      break;
    }
    pos = nl + 1;
  }
  return out;
}

/** 这一处能不能搜、能不能换：没压在护住的字上。 */
export function isOpen(p: Protection, m: FindMatch): boolean {
  if (p.fence && m.start < p.fence.end && m.end > p.fence.start) {
    // 压在 frontmatter 上：必须整个落在某一个人写的值里。
    if (!p.open.some((s) => m.start >= s.start && m.end <= s.end)) {
      return false;
    }
  }
  return !p.blocked.some((s) => m.start < s.end && m.end > s.start);
}

export interface FileHits {
  /** 这份文件里可以搜、可以换的每一处，按先后。 */
  matches: FindMatch[];
  /** 匹配数到了 `textFind` 的上限（两万处），后面的没数。 */
  truncated: boolean;
  /** 正则写错了（这时 `matches` 是空的）。 */
  error?: string;
}

/** 一份文件里的每一处：`textFind.findMatches` 的口径，去掉压在护住的字上的那些。 */
export function fileHits(text: string, kind: string, query: string, opts: FindOptions = {}): FileHits {
  const found = findMatches(text, query, opts);
  if (found.error) {
    return { matches: [], truncated: false, error: found.error };
  }
  if (found.matches.length === 0) {
    return { matches: [], truncated: false };
  }
  const p = protectionOf(text, kind);
  return { matches: found.matches.filter((m) => isOpen(p, m)), truncated: found.truncated };
}

/** 结果列表上的一处：位置、第几行、那一行里命中前后的一截。 */
export interface HitLine {
  start: number;
  end: number;
  /** 第几行（从 1 起）。 */
  line: number;
  /** 这一处在那一行里的第几个字（从 0 起）。编辑器按「行 + 列」定位，不按下标——磁盘上的 `\r\n` 到了编辑区里是 `\n`。 */
  col: number;
  /** 同一行里命中之前的一截（截过的话开头是「…」）。 */
  before: string;
  /** 命中的字（跨行的话换行画成「↵」；太长中间截掉）。 */
  text: string;
  /** 同一行里命中之后的一截（截过的话结尾是「…」）。 */
  after: string;
}

/** 命中的字最多显示几个（跨行的正则一下能吞几百字）。 */
const HIT_TEXT_MAX = 80;

/** 给按先后排好的几处配上行号与那一行的上下文。 */
export function describeHits(text: string, matches: readonly FindMatch[]): HitLine[] {
  const out: HitLine[] = [];
  let line = 1;
  let scanned = 0;
  let lineStart = 0;
  for (const m of matches) {
    for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.start; i = text.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = Math.max(scanned, m.start);
    const nl = text.indexOf('\n', m.end);
    let lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd > m.end && text[lineEnd - 1] === '\r') {
      lineEnd--;
    }
    const from = Math.max(lineStart, m.start - BOOK_FIND_CONTEXT.before);
    const to = Math.min(lineEnd, m.end + BOOK_FIND_CONTEXT.after);
    out.push({
      start: m.start,
      end: m.end,
      line,
      col: m.start - lineStart,
      before: `${from > lineStart ? '…' : ''}${text.slice(from, m.start)}`,
      text: showHit(text.slice(m.start, m.end)),
      after: `${text.slice(m.end, to).replace(/\r$/, '')}${to < lineEnd ? '…' : ''}`,
    });
  }
  return out;
}

/** 命中的字给人看的样子：换行画成「↵」，太长的中间截掉。 */
export function showHit(raw: string): string {
  const flat = raw.replace(/\r?\n/g, '↵');
  if (flat.length <= HIT_TEXT_MAX) {
    return flat;
  }
  const half = Math.floor((HIT_TEXT_MAX - 1) / 2);
  return `${flat.slice(0, half)}…${flat.slice(flat.length - half)}`;
}

/**
 * 预览：每一处换成什么（与 `textFind.replaceSelectedIn` 同一个算法——在原文里、在这一处自己的位置上重新匹配一次，
 * 正则时照 `String.prototype.replace` 的规矩展开 `$1`）。对不上的那一处给 undefined。
 */
export function replacementsAt(
  text: string,
  matches: readonly FindMatch[],
  query: string,
  replacement: string,
  opts: FindOptions = {}
): (string | undefined)[] {
  if (!opts.regex) {
    return matches.map(() => replacement);
  }
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return matches.map(() => undefined);
  }
  const re = new RegExp(compiled.re.source, `${compiled.re.flags.replace('g', '')}y`);
  return matches.map((at) => {
    re.lastIndex = at.start;
    const m = re.exec(text);
    return m && m[0].length === at.end - at.start ? expandReplacement(replacement, m, text) : undefined;
  });
}
