/**
 * 正文的分段格式与一键排版：工程级设置 `paragraphStyle`（`config.md` 的 frontmatter）的取值与说法、
 * 各格式的段分隔，以及两个排版用的纯函数——`formatProse`（按格式重排段落）与 `toFullWidthPunct`
 * （中文语境里的半角标点转全角）。
 *
 * **纯函数、零 import**：内置编辑器（`media/src/editor/`）直接打包它——回车插什么、一键排版排成
 * 什么样，与后端认的是同一份；日后生成链要按格式整理模型的输出也用这一份。
 *
 * ## 三种格式
 *
 * | 值 | 中文 | 段与段之间 | 段首 |
 * |---|---|---|---|
 * | `blank`（缺省） | 空行分段 | 空一行 | 不缩进 |
 * | `indent` | 段首缩进 | 不空行 | 两个全角空格 |
 * | `both` | 缩进加空行 | 空一行 | 两个全角空格 |
 *
 * 标题行（`#` 开头）与只有符号的场景分隔行（`* * *`、`※`、`◇◇◇`……）不缩进，但段与段之间照样按格式隔开。
 */

/** 三种分段格式。顺序即菜单里的顺序。 */
export const PARAGRAPH_STYLES = ['blank', 'indent', 'both'] as const;

export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

/** `config.md` 里没写（或写坏了）时用的格式：空行分段、段首不缩进。 */
export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = 'blank';

/** 界面上的说法。作者在 frontmatter 里写这几个中文也认（`parseParagraphStyle`）。 */
export const PARAGRAPH_STYLE_LABEL: Record<ParagraphStyle, string> = {
  blank: '空行分段',
  indent: '段首缩进',
  both: '缩进加空行',
};

/** 一句话说明，菜单项的提示用。 */
export const PARAGRAPH_STYLE_HINT: Record<ParagraphStyle, string> = {
  blank: '段与段之间空一行，段首不缩进（网文常见）',
  indent: '段首两个全角空格，段与段之间不空行（出版常见）',
  both: '段首两个全角空格，段与段之间再空一行',
};

/** 正文段首的缩进：两个全角空格。 */
export const PROSE_INDENT = '　　';

export function isParagraphStyle(value: unknown): value is ParagraphStyle {
  return typeof value === 'string' && (PARAGRAPH_STYLES as readonly string[]).includes(value);
}

/** 英文值（不分大小写）、中文说法都认，认不出就是 undefined（不猜）。 */
export function parseParagraphStyle(raw: string): ParagraphStyle | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  const lower = s.toLowerCase();
  return PARAGRAPH_STYLES.find((v) => v === lower || PARAGRAPH_STYLE_LABEL[v] === s);
}

/** 段与段之间的换行：空一行的两种是 `\n\n`，段首缩进是 `\n`。 */
export function paragraphGap(style: ParagraphStyle): string {
  return style === 'indent' ? '\n' : '\n\n';
}

/** 段首缩进：缩进的两种是两个全角空格，空行分段没有。 */
export function paragraphIndent(style: ParagraphStyle): string {
  return style === 'blank' ? '' : PROSE_INDENT;
}

/** 另起一段要插的字：段间换行 + 新一段的段首缩进（回车、Ctrl+Enter 用）。 */
export function paragraphBreak(style: ParagraphStyle): string {
  return paragraphGap(style) + paragraphIndent(style);
}

// ---------------------------------------------------------------- 一键排版

/** 标题行：去掉首尾空白后以 `#` 开头。不缩进。 */
export function isHeadingLine(line: string): boolean {
  return line.trim().startsWith('#');
}

/**
 * 只有符号的场景分隔行（`---`、`***`、`* * *`、`※`、`◇◇◇`、`＊＊＊`……）。不缩进。
 * 省略号与破折号**不在其列**：一行「……」或「——」多半是一句话（沉默、被打断），要当段落缩进。
 */
const SCENE_BREAK = /^[\s\-*_=~#·•∙・＊※⁂◇◆○●◎□■△▲▽▼☆★♢♦◈❖✦✧✱❋＝－～]+$/u;

export function isSceneBreakLine(line: string): boolean {
  const s = line.trim();
  return s !== '' && SCENE_BREAK.test(s);
}

/**
 * 顶部的 frontmatter：`---` 开头、`---` 收尾，中间每一行都像 YAML（`键: 值`、`  - 项`、`# 注释`、空行）。
 * 要求中间像 YAML，是为了不把开头就是场景分隔线 `---` 的正文误当成 frontmatter。
 */
const FRONTMATTER = /^---\n(?:(?:[A-Za-z_][\w-]*\s*:.*|\s+-.*|\s*#.*|\s*)\n)*?---(?:\n|$)/;

export interface LayoutOptions {
  /**
   * 排的是一段节选（编辑器里选中的那几行）：不认 frontmatter、文末不补换行、
   * 首尾的空行直接去掉（调用方已经把范围收到非空行上）。
   */
  fragment?: boolean;
}

export interface LayoutResult {
  text: string;
  /** 改了几处：重排过的行数 + 改过的段间隔 + 文首文末的空白各算一处。没变就是 0。 */
  changes: number;
}

/**
 * 按分段格式重排正文，并数出改了几处。
 *
 * - 顶部 frontmatter 原样保留；`\r\n` 当 `\n`。
 * - 每个非空行是一段：去掉首尾空白（半角 / 全角空格、不换行空格、制表符），段首按格式缩进。
 * - 标题行（`#` 开头）与场景分隔行只去首尾空白、不缩进。
 * - 段与段之间按格式隔开（空一行或不空行），原来空了几行都收成这一种。
 * - 文末恰好一个换行（`fragment` 时不补）。
 */
export function layoutProse(input: string, style: ParagraphStyle, opts: LayoutOptions = {}): LayoutResult {
  let changes = input.includes('\r') ? 1 : 0;
  const bom = !opts.fragment && input.startsWith('﻿') ? '﻿' : '';
  let text = (bom ? input.slice(1) : input).replace(/\r\n?/g, '\n');

  let head = '';
  const fm = opts.fragment ? null : FRONTMATTER.exec(text);
  if (fm) {
    head = fm[0].endsWith('\n') ? fm[0] : `${fm[0]}\n`;
    text = text.slice(fm[0].length);
  }

  const gap = paragraphGap(style);
  const indent = paragraphIndent(style);
  const blocks: string[] = [];
  /** 这一行在 `text` 里从哪起。 */
  let pos = 0;
  /** 上一段末尾的位置（还没有段时是文首）：它与这一段之间隔着的就是原来的段间隔。 */
  let prevEnd = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    const content = line.trim();
    if (content === '') {
      continue;
    }
    const formatted = isHeadingLine(content) || isSceneBreakLine(content) ? content : indent + content;
    if (formatted !== line) {
      changes++;
    }
    const between = text.slice(prevEnd, start);
    if (blocks.length === 0) {
      // 文首的空行要去掉（节选的首尾空行不算：调用方已经把范围收到非空行上）。
      if (between !== '' && !opts.fragment) {
        changes++;
      }
    } else if (between !== gap) {
      changes++;
    }
    blocks.push(formatted);
    prevEnd = start + line.length;
  }

  if (blocks.length === 0) {
    // 只有空白（或什么都没有）：排成空的。
    if (text !== '' && !opts.fragment) {
      changes++;
    }
    return { text: bom + head, changes };
  }
  if (!opts.fragment && text.slice(prevEnd) !== '\n') {
    changes++;
  }
  return { text: bom + head + blocks.join(gap) + (opts.fragment ? '' : '\n'), changes };
}

/** {@link layoutProse} 只要文字的那一半。 */
export function formatProse(text: string, style: ParagraphStyle, opts?: LayoutOptions): string {
  return layoutProse(text, style, opts).text;
}

// ---------------------------------------------------------------- 半角标点转全角

/** 一处替换：在原文 `at` 处把 `from` 换成 `to`。 */
export interface PunctEdit {
  at: number;
  from: string;
  to: string;
}

export interface PunctResult {
  text: string;
  /** 换了几处（一对引号算两处，`...` → `……` 算一处）。 */
  changes: number;
  /** 每一处替换，按位置升序。调用方据此挪光标。 */
  edits: PunctEdit[];
}

const HAN = /\p{Script=Han}/u;
/** 中文标点与引号：CJK 符号区、全角区、弯引号、省略号、破折号、间隔号。 */
const CN_PUNCT = /[　-〿＀-￯‘’“”…—·]/u;

/** 算不算中文语境里的字：汉字、中文标点、弯引号。 */
function isChineseContext(ch: string | undefined): boolean {
  return !!ch && (HAN.test(ch) || CN_PUNCT.test(ch));
}

const FULL_WIDTH: Record<string, string> = {
  ',': '，',
  '.': '。',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};

/**
 * 不该动的地方：顶部 frontmatter、Markdown 代码（围栏与行内）、网址、邮箱。标成 true 的下标原样照抄。
 */
function protectedMask(text: string, fragment: boolean): Uint8Array {
  const mask = new Uint8Array(text.length);
  const mark = (from: number, to: number) => mask.fill(1, from, to);
  if (!fragment) {
    const fm = FRONTMATTER.exec(text);
    if (fm) {
      mark(0, fm[0].length);
    }
  }
  // 围栏代码块：``` 或 ~~~ 开头的行到下一个同样的行（没收尾就到文末）。
  const fence = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
  for (const m of text.matchAll(fence)) {
    mark(m.index!, m.index! + m[0].length);
  }
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    mark(m.index!, m.index! + m[0].length);
  }
  // 网址与邮箱只认 ASCII（碰到汉字就断开），末尾跟着的标点算句子的、不算网址的（`见 https://a.com/x.` 那个句点要转）。
  for (const re of [/\b(?:https?|ftp):\/\/[!-~]+/gi, /\bwww\.[!-~]+/gi, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g]) {
    for (const m of text.matchAll(re)) {
      const url = m[0].replace(/[.,;:!?)\]'"]+$/, '');
      mark(m.index!, m.index! + url.length);
    }
  }
  return mask;
}

/**
 * 中文语境里的半角标点转全角，并列出每一处。
 *
 * - **前一个字是汉字（或中文标点、弯引号）时**，半角 `, . ? ! : ;` 转成全角。数字之间（`3.14`、
 *   `1,000`）、英文句子、`文件名.md` 这类（`.` 后面紧跟字母数字）不动。
 * - `...`（三个及以上）挨着中文时、`。。。` 一律转成 `……`。
 * - 汉字（或中文标点）之间的 `--` / `---` 转成 `——`。
 * - 一对半角括号：括号里有汉字，或里面没有英文字母且外面挨着汉字（`(1)第一条`），两边一起转成全角；
 *   `f(x)的` 这种不动。落单的括号不动。
 * - 直双引号：同一行里成对出现、每一对中间都有汉字时，按出现顺序转成 “”；落单、或某一对里没有
 *   汉字就不动。直单引号一律不动——英文的撇号（`don't`）会把配对搅乱。
 * - 顶部 frontmatter、Markdown 代码（围栏与行内）、网址、邮箱原样不动。
 *
 * `range` 给了就只改这一段里的字（判语境照样看前后文）；`fragment` 表示 `text` 本身是一段节选，
 * 不认 frontmatter。
 */
export function fullWidthPunct(
  text: string,
  opts: { range?: { start: number; end: number }; fragment?: boolean } = {}
): PunctResult {
  const mask = protectedMask(text, !!opts.fragment);
  const lo = opts.range ? Math.max(0, opts.range.start) : 0;
  const hi = opts.range ? Math.min(text.length, opts.range.end) : text.length;
  const inRange = (i: number) => i >= lo && i < hi && !mask[i];

  /** 预先定好的单字替换：下标 → 新字（引号与括号要成对判，先算好）。 */
  const preset = new Map<number, string>();
  presetQuotes(text, inRange, preset);
  presetBrackets(text, inRange, preset);

  const edits: PunctEdit[] = [];
  let out = '';
  /** 输出里的上一个字：判语境要看替换之后的样子（`"你好",` 里的逗号跟在 ” 后面）。 */
  const prevOut = () => out[out.length - 1];
  const put = (at: number, from: string, to: string) => {
    edits.push({ at, from, to });
    out += to;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!inRange(i)) {
      out += ch;
      i++;
      continue;
    }
    const preset1 = preset.get(i);
    if (preset1 !== undefined) {
      put(i, ch, preset1);
      i++;
      continue;
    }
    // 省略号：三个及以上的 . 或 。
    if (ch === '.' || ch === '。') {
      let j = i;
      while (j < hi && text[j] === ch && !mask[j]) {
        j++;
      }
      if (j - i >= 3 && (ch === '。' || isChineseContext(prevOut()) || isChineseContext(text[j]))) {
        put(i, text.slice(i, j), '……');
        i = j;
        continue;
      }
      if (j - i >= 2) {
        // 两个点、或英文里的省略号：原样照抄，不拆开逐个判。
        out += text.slice(i, j);
        i = j;
        continue;
      }
    }
    // 破折号：汉字之间的 -- / ---
    if (ch === '-') {
      let j = i;
      while (j < hi && text[j] === '-' && !mask[j]) {
        j++;
      }
      if (j - i >= 2 && j - i <= 3 && isChineseContext(prevOut()) && isChineseContext(text[j])) {
        put(i, text.slice(i, j), '——');
        i = j;
        continue;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const full = FULL_WIDTH[ch];
    if (full && isChineseContext(prevOut()) && !(ch === '.' && /[A-Za-z0-9]/.test(text[i + 1] ?? ''))) {
      put(i, ch, full);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, changes: edits.length, edits };
}

/** {@link fullWidthPunct} 只要文字的那一半。 */
export function toFullWidthPunct(text: string, opts?: { range?: { start: number; end: number }; fragment?: boolean }): string {
  return fullWidthPunct(text, opts).text;
}

/** 直双引号：一行里成对、每一对中间有汉字的，按顺序转成 “”。 */
function presetQuotes(text: string, ok: (i: number) => boolean, preset: Map<number, string>): void {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const quotes: number[] = [];
    for (let i = lineStart; i < lineEnd; i++) {
      if (text[i] === '"' && ok(i)) {
        quotes.push(i);
      }
    }
    if (quotes.length > 0 && quotes.length % 2 === 0) {
      for (let k = 0; k < quotes.length; k += 2) {
        const open = quotes[k];
        const close = quotes[k + 1];
        if (HAN.test(text.slice(open + 1, close))) {
          preset.set(open, '“');
          preset.set(close, '”');
        }
      }
    }
    if (nl === -1) {
      break;
    }
    lineStart = nl + 1;
  }
}

/** 半角括号：成对的才转，判据见 {@link fullWidthPunct}。 */
function presetBrackets(text: string, ok: (i: number) => boolean, preset: Map<number, string>): void {
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      // 括号不跨行配对。
      stack.length = 0;
    } else if (ch === '(' && ok(i)) {
      stack.push(i);
    } else if (ch === ')' && ok(i) && stack.length > 0) {
      const open = stack.pop()!;
      const inner = text.slice(open + 1, i);
      const hasHan = HAN.test(inner);
      const outside = isChineseContext(text[open - 1]) || isChineseContext(text[i + 1]);
      if (hasHan || (outside && !/[A-Za-z]/.test(inner))) {
        preset.set(open, '（');
        preset.set(i, '）');
      }
    }
  }
}
