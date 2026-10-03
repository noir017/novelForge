/**
 * 拆书的纯函数：一整本 txt → 一章一份。**零 I/O、绝不抛**（第 1 条：作者给什么都不崩）。
 *
 * 两条路共用：「导入原稿」把作者自己的稿子切成 `chapters/NNN-标题.md`；「从参考书学写法」
 * 把别人的书切开、抽几章样章（features/importManuscript.ts、features/reference.ts）。
 *
 * 借鉴 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的导入：上游切章只认三条正则
 * （`electron/controllers/import-controller.ts:56-66`：`第X章`、`Chapter N`、`# 第X章`），
 * 认不出就把整个文件当一章。这里多认了「回 / 节」、序章楔子番外、卷标题，丢掉目录里那一串空标题；
 * 认不出就不导入（作者的原稿被当成一章塞进来，比拒绝更难收拾）。
 *
 * ## 切章的判据只在这里
 *
 * 一行算章标题要同时满足：去掉 `#` 与空白之后不超过 {@link HEADING_MAX} 字、不以句末标点收尾、
 * 开头是 `第X章`（中文或阿拉伯数字，`回`/`节` 后面还得跟分隔符或行尾——「第三回合」是正文）、
 * `Chapter N`，或序章 / 楔子 / 引子 / 尾声 / 终章 / 番外。`第X卷/部/集` 那一行是卷标题：不算章、丢掉，
 * 说一声。
 */
import { countWords } from './fs';

// ---------------------------------------------------------------- 解码

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

/**
 * 字节 → 文本。BOM 说了算；没有 BOM 时先按 UTF-8 严格解，解不了就当 GB18030（中文 txt 小说
 * 最常见的另一种编码，GBK 是它的子集）。换行统一成 `\n`。
 */
export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  const decode = (encoding: TextEncodingName, from: number, fatal = false): string =>
    new TextDecoder(encoding, { fatal }).decode(bytes.subarray(from));
  let text: string;
  let encoding: TextEncodingName;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    text = decode('utf-8', 3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    text = decode('utf-16le', 2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    text = decode('utf-16be', 2);
  } else {
    try {
      text = decode('utf-8', 0, true);
      encoding = 'utf-8';
    } catch {
      text = decode('gb18030', 0);
      encoding = 'gb18030';
    }
  }
  return { text: text.replace(/\r\n?/g, '\n'), encoding };
}

/**
 * 读工程里的文件给 agent 看、数字数、检索用：UTF-8 原样返回（不动换行与 BOM，与写盘那条路读到的一字不差），
 * 不是 UTF-8 才走 `decodeTextBytes`——作者丢进工程的 txt 常是 GBK，按 UTF-8 读出来是一屏乱码。
 */
export function decodeFileText(bytes: Uint8Array): string {
  const decoded = decodeTextBytes(bytes);
  return decoded.encoding === 'utf-8' ? Buffer.from(bytes).toString('utf8') : decoded.text;
}

/** 确认框里怎么称呼这种编码。 */
export const ENCODING_LABEL: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16',
  'utf-16be': 'UTF-16',
  gb18030: 'GBK / GB18030',
};

// ---------------------------------------------------------------- 认标题

/** 章标题一行最长几个字。再长就是正文。 */
export const HEADING_MAX = 40;

const NUM = '[0-9０-９零〇○一二两三四五六七八九十百千万]+';
const SEP = '[\\s：:、.．·\\-—｜|]';
/** 「第X章」后面可以直接跟标题；「第X回 / 节」后面必须是分隔符或行尾（「第三回合」「第二节课」是正文）。 */
const CHAPTER_HEAD = new RegExp(`^第\\s*${NUM}\\s*(?:章(.*)|[回节](?:${SEP}+(.*))?)$`);
const VOLUME_HEAD = new RegExp(`^第\\s*${NUM}\\s*[卷部集](?:$|${SEP})`);
const EN_HEAD = /^chapter\s+\d+\b[\s:：.\-—]*(.*)$/i;
/** 序章、楔子这几样后面跟的标题不长（「番外篇 旧事」「楔子·雨夜」）；整行仍受 {@link HEADING_MAX} 与句末标点约束。 */
const SPECIAL_HEAD = /^(?:序章|楔子|引子|尾声|终章|番外)(?:$|.{0,20}$)/;
/** 正文的句子收尾。标题几乎不以它们结尾。 */
const SENTENCE_END = /[。！？!?…”」』，,；;]$/;
const SEPARATORS = new RegExp(`^${SEP}+|${SEP}+$`, 'g');

/** 行首行尾的空白（含全角空格、不换行空格、BOM）。 */
function trimAll(line: string): string {
  return line.replace(/^[\s　 ﻿]+|[\s　 ]+$/g, '');
}

function stripHashes(line: string): string {
  return trimAll(line.replace(/^\s*#{1,6}\s*/, ''));
}

export type HeadingKind = 'chapter' | 'volume';

/** 一行是不是标题；是章标题时交回标题（可能为空：「第一章」一行什么都没写）。 */
export function classifyHeading(raw: string): { kind: HeadingKind; title: string } | undefined {
  const line = stripHashes(raw);
  if (!line || line.length > HEADING_MAX || SENTENCE_END.test(line)) {
    return undefined;
  }
  if (VOLUME_HEAD.test(line)) {
    return { kind: 'volume', title: line };
  }
  const zh = CHAPTER_HEAD.exec(line);
  if (zh) {
    return { kind: 'chapter', title: (zh[1] ?? zh[2] ?? '').replace(SEPARATORS, '') };
  }
  const en = EN_HEAD.exec(line);
  if (en) {
    return { kind: 'chapter', title: en[1].replace(SEPARATORS, '') };
  }
  if (SPECIAL_HEAD.test(line)) {
    return { kind: 'chapter', title: line.replace(SEPARATORS, '') };
  }
  return undefined;
}

// ---------------------------------------------------------------- 切章

export interface SplitChapter {
  /** 章名（不带「第X章」）。原文那一行只写了「第一章」时为空。 */
  title: string;
  /** 原文里的那一行标题，确认框里给作者看。按字数切的段没有。 */
  heading: string;
  /** 规整过的正文：一段一行、段间空一行。 */
  body: string;
  words: number;
}

export interface SplitResult {
  chapters: SplitChapter[];
  /** 第一个标题之前的文字（书名、作者、简介）：不导入。 */
  preface: { words: number; head: string };
  /** 卷标题那几行：不算章，丢掉。 */
  volumes: string[];
  /** 标题下面一个字都没有的（目录里那一串）：跳过。 */
  empty: string[];
}

/**
 * 一整本 → 一章一份。认不出任何章标题时 `chapters` 为空——调用方据此拒绝导入，或者（学写法时）
 * 改用 {@link splitBySize}。
 */
export function splitChapters(text: string): SplitResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters: SplitChapter[] = [];
  const volumes: string[] = [];
  const empty: string[] = [];
  const prefaceLines: string[] = [];
  let seenHeading = false;
  let current: { title: string; heading: string; lines: string[] } | undefined;

  const flush = () => {
    if (!current) {
      return;
    }
    const body = normalizeParagraphs(current.lines);
    const words = countWords(body);
    if (words === 0) {
      empty.push(current.heading);
    } else {
      chapters.push({ title: current.title, heading: current.heading, body, words });
    }
    current = undefined;
  };

  for (const line of lines) {
    const head = classifyHeading(line);
    if (head) {
      seenHeading = true;
      flush();
      if (head.kind === 'volume') {
        volumes.push(head.title);
      } else {
        current = { title: head.title, heading: stripHashes(line), lines: [] };
      }
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (!seenHeading) {
      prefaceLines.push(line);
    }
  }
  flush();

  const preface = normalizeParagraphs(prefaceLines);
  return {
    chapters,
    preface: { words: countWords(preface), head: clipLine(preface, 40) },
    volumes,
    empty,
  };
}

/** 没有章标题的书（学写法时）：按段落攒到约 `size` 字切一段。标题是「第 N 段」。 */
export function splitBySize(text: string, size = 3000): SplitChapter[] {
  const paragraphs = normalizeParagraphs(text.split('\n')).split('\n\n').filter(Boolean);
  const out: SplitChapter[] = [];
  let buf: string[] = [];
  let words = 0;
  const flush = () => {
    if (buf.length > 0) {
      const body = buf.join('\n\n');
      out.push({ title: `第 ${out.length + 1} 段`, heading: '', body, words: countWords(body) });
      buf = [];
      words = 0;
    }
  };
  for (const p of paragraphs) {
    buf.push(p);
    words += countWords(p);
    if (words >= size) {
      flush();
    }
  }
  flush();
  return out;
}

/** 每个非空行一段、段间空一行，去掉行首行尾的空白（含全角空格）。 */
export function normalizeParagraphs(lines: readonly string[]): string {
  return lines.map(trimAll).filter(Boolean).join('\n\n');
}

function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// ---------------------------------------------------------------- 抽样与节选

/** 从 `total` 份里均匀抽 `count` 份的下标（0 起、升序、不重复）：首尾必在，中间均匀。 */
export function evenSample(total: number, count: number): number[] {
  const n = Math.max(0, Math.floor(total));
  const k = Math.max(0, Math.floor(count));
  if (n === 0 || k === 0) {
    return [];
  }
  if (n <= k) {
    return Array.from({ length: n }, (_, i) => i);
  }
  if (k === 1) {
    return [0];
  }
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) {
    picked.add(Math.round((i * (n - 1)) / (k - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * 学写法时看结构用的那几章（下标）：开头 `opening` 章（开篇自成一套写法），加全书 30% 处连续
 * `window` 章（过了开篇、还没进高潮的日常推进）。书太短时两段会重叠，去重。
 */
export function structureSample(total: number, opening = 3, window = 3): number[] {
  const n = Math.max(0, Math.floor(total));
  const picked = new Set<number>();
  for (let i = 0; i < Math.min(opening, n); i++) {
    picked.add(i);
  }
  const start = Math.max(opening, Math.floor(n * 0.3));
  for (let i = start; i < Math.min(start + window, n); i++) {
    picked.add(i);
  }
  return [...picked].sort((a, b) => a - b);
}

/** 开头 `head` 字（按字符），超出时在末尾写明省略了多少。 */
export function headOf(text: string, head: number): string {
  return text.length <= head ? text : `${text.slice(0, head)}\n\n（后略 ${text.length - head} 字）`;
}

/** 开头 `head` 字 + 结尾 `tail` 字，中间省略的那一段写明字数。不够长就整份。 */
export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) {
    return text;
  }
  return `${text.slice(0, head)}\n\n（中略 ${text.length - head - tail} 字）\n\n${text.slice(text.length - tail)}`;
}

// ---------------------------------------------------------------- 篇幅统计（零调用）

export interface ShapeStats {
  chapters: number;
  /** 每章字数的平均与中位数。 */
  avgWords: number;
  medianWords: number;
  /** 每章几段（平均）、每段几个字（平均）。 */
  avgParagraphs: number;
  avgParagraphWords: number;
  /** 含对白（引号）的段落占几成，0–100。 */
  dialoguePercent: number;
}

const QUOTE = /[“”「」『』"]/;

/** 一本书的篇幅形状：给学写法那一次调用当数据——模型自己数不准。 */
export function shapeStats(chapters: readonly Pick<SplitChapter, 'body' | 'words'>[]): ShapeStats {
  if (chapters.length === 0) {
    return { chapters: 0, avgWords: 0, medianWords: 0, avgParagraphs: 0, avgParagraphWords: 0, dialoguePercent: 0 };
  }
  const words = chapters.map((c) => c.words).sort((a, b) => a - b);
  const paragraphs = chapters.flatMap((c) => c.body.split('\n\n').filter(Boolean));
  const total = words.reduce((s, w) => s + w, 0);
  const mid = Math.floor(words.length / 2);
  return {
    chapters: chapters.length,
    avgWords: Math.round(total / chapters.length),
    medianWords: words.length % 2 === 1 ? words[mid] : Math.round((words[mid - 1] + words[mid]) / 2),
    avgParagraphs: Math.round(paragraphs.length / chapters.length),
    avgParagraphWords: paragraphs.length > 0 ? Math.round(total / paragraphs.length) : 0,
    dialoguePercent:
      paragraphs.length > 0 ? Math.round((paragraphs.filter((p) => QUOTE.test(p)).length / paragraphs.length) * 100) : 0,
  };
}

export function describeShape(s: ShapeStats): string {
  return [
    `- 全书 ${s.chapters} 章；每章平均 ${s.avgWords} 字，中位数 ${s.medianWords} 字`,
    `- 每章平均 ${s.avgParagraphs} 段，每段平均 ${s.avgParagraphWords} 字`,
    `- 含对白的段落约占 ${s.dialoguePercent}%`,
  ].join('\n');
}

// ---------------------------------------------------------------- 规模

/** 已写的章平均多长，取整到百（小说配置「每章字数」的缺省）。一章正文都没有时 undefined。 */
export function roundedAverageWords(words: readonly number[]): number | undefined {
  const written = words.filter((w) => w > 0);
  if (written.length === 0) {
    return undefined;
  }
  return Math.max(100, Math.round(written.reduce((s, w) => s + w, 0) / written.length / 100) * 100);
}

/** 没写总章数时问作者的缺省值：已写章数的两倍取整到 50，不少于 100。 */
export function defaultTotalChapters(written: number): number {
  return Math.max(100, Math.ceil((Math.max(0, written) * 2) / 50) * 50);
}

// ---------------------------------------------------------------- 参考书的写法技能

/** 名字留给 `-写法` 与去重后缀的余量：技能名最长 64（`model/writingSkill.ts` 的 `isSkillName`）。 */
const SKILL_NAME_BODY_MAX = 54;

/**
 * 参考书的写法技能叫什么：书名（文件名去扩展名）+ `-写法`，不合规的字符换成 `-`；`taken` 里已经有了
 * 就加 `-2`、`-3`。书名清洗完是空的就叫「参考书-写法」。规则与 `isSkillName` 一致：字母或数字开头，
 * 只含字母、数字、`._-`。
 */
export function referenceSkillName(bookTitle: string, taken: ReadonlySet<string>): string {
  const cleaned = bookTitle
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .slice(0, SKILL_NAME_BODY_MAX)
    .replace(/[-._]+$/, '');
  const base = `${cleaned || '参考书'}-写法`;
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}-${i}`;
  }
  return name;
}

/** 写法技能的 `SKILL.md`：frontmatter 是上游那份手写格式（一行一个键），`stage: planning`。 */
export function renderReferenceSkill(input: { name: string; bookTitle: string; body: string }): string {
  const title = input.bookTitle.replace(/[\r\n]+/g, ' ').trim() || '参考书';
  return [
    '---',
    `name: ${input.name}`,
    `display_name: 《${title}》的写法`,
    `description: 从参考书《${title}》拆出的结构与节奏写法，规划大纲与细纲时参考；只学怎么排，不照搬它的情节与人物。`,
    'stage: planning',
    'version: 1',
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
}
