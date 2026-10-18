/**
 * 查找替换的**匹配口径**：找全部匹配、逐处算替换文字、全部替换 / 只换挑出来的那几处算出的新文字。
 *
 * **纯函数、零 import**：内置编辑器的查找替换条（`media/src/editor/findCore.ts` 原样转出这里的函数，经
 * `media/src/protocol.ts` 打进浏览器产物）与全书查找替换（后端 `views/bookFind.ts`、`features/bookReplace.ts`）
 * 共用这一份——同一个查找串、同两颗开关，在一份文件里找到的与在全书里找到的必须是同一批，`$1` 也得展开成
 * 同一个样子。从前它只在前端（`findCore.ts`），全书查找要在后端读盘，搬过来而不是另写一套正则语义。
 *
 * 几条口径（单测钉在 `tests/unit/editor/findCore.test.js`）：
 *
 * - 位置一律是字符串下标（与 `textarea.selectionStart` 同一套）。
 * - 缺省**不区分大小写**、**不按正则**。不按正则时查找串原样当字面量，替换串里的 `$1` 也是字面量。
 * - 按正则时带 `m`（`^` / `$` 认每一行的头尾，按「段首两个全角空格」这类找法才找得到），先试 `u`
 *   （生僻字那种代理对按一个字算），`u` 下语法不合法（比如多写了一个 `\。`）再退回不带 `u` 的；
 *   两样都编不过才算「正则写错了」——**绝不抛**。
 * - **零长度匹配跳过**（`^`、`\b`、`a*` 匹配到空串的那些位置不算一处）。
 * - 替换串的 `$1` / `$&` / `` $` `` / `$'` / `$$` / `$<名字>` 与 `String.prototype.replace` 同语义，
 *   而且是**逐处在全文里算**的：前后文（后行断言、`` $` ``）看的是整份文字，不是被切出来的那一小段。
 * - 跨行：正则里写了 `\n`（或 `[\s\S]`）就能跨行匹配，字面量里有换行也照样认；一处匹配的范围就是它覆盖的那几行。
 */

export interface FindOptions {
  /** 区分大小写。缺省关。 */
  caseSensitive?: boolean;
  /** 按正则。缺省关。 */
  regex?: boolean;
}

/** 一处匹配：`[start, end)`，`end > start`（零长度的不算）。 */
export interface FindMatch {
  start: number;
  end: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** 匹配数到了上限、后面的没数（界面写「20000+」）。 */
  truncated: boolean;
  /** 正则写错了：浏览器给的原因（界面只说「正则写错了」，原因放在提示里）。 */
  error?: string;
}

/** 全部替换要做的那一笔改动：把 `[start, end)` 换成 `text`，一共替换了 `count` 处。 */
export interface ReplaceAllEdit {
  start: number;
  end: number;
  text: string;
  count: number;
}

/** 只换挑出来的那几处之后的结果（{@link replaceSelectedIn}）。 */
export interface SelectedReplace {
  /** 换完之后的整份文字。 */
  text: string;
  /** 换掉了的那几处（原文里的位置，按先后排）。 */
  replaced: FindMatch[];
  /** 对不上的那几处：那个位置上已经不是一处匹配（文字变过、或与前一处重叠了），没换。 */
  missed: FindMatch[];
}

/**
 * 最多数多少处。再多就不往下数了（界面写「n+」）——一个 `.` 在三十万字里能匹配三十万处，
 * 全记下来既费内存，高亮层也画不动。全部替换不受这个限制（它不记位置，边找边拼）。
 */
export const MATCH_LIMIT = 20000;

export type CompiledSearch = { ok: true; re: RegExp } | { ok: false; error: string };

/** 把字面量里的正则元字符转义掉。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把查找串编成一个**新的**全局正则（每次调用一个新对象，`lastIndex` 不串）。
 * 空串返回 undefined；正则写错返回 `{ ok: false }`，绝不抛。
 */
export function compileSearch(query: string, opts: FindOptions = {}): CompiledSearch | undefined {
  if (!query) {
    return undefined;
  }
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (!opts.regex) {
    return { ok: true, re: new RegExp(escapeRegExp(query), `${flags}u`) };
  }
  try {
    return { ok: true, re: new RegExp(query, `${flags}mu`) };
  } catch {
    // `u` 下更严（多余的转义、孤立的 `{` 都算错），退一步再试。
  }
  try {
    return { ok: true, re: new RegExp(query, `${flags}m`) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 零长度匹配之后往前挪一格；`u` 模式下不把代理对劈开。 */
function advance(text: string, index: number, unicode: boolean): number {
  if (unicode && index + 1 < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        return index + 2;
      }
    }
  }
  return index + 1;
}

/** 按顺序给出全文里每一处**非空**匹配（`re` 必须是全局的，会被改 `lastIndex`）。 */
function* eachMatch(text: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = advance(text, re.lastIndex, re.unicode);
      continue;
    }
    yield m;
  }
}

/** 找全部匹配。空查找串给空结果；正则写错给 `error`，不抛。 */
export function findMatches(
  text: string,
  query: string,
  opts: FindOptions = {},
  limit = MATCH_LIMIT
): FindResult {
  const compiled = compileSearch(query, opts);
  if (!compiled) {
    return { matches: [], truncated: false };
  }
  if (!compiled.ok) {
    return { matches: [], truncated: false, error: compiled.error };
  }
  const matches: FindMatch[] = [];
  for (const m of eachMatch(text, compiled.re)) {
    if (matches.length >= limit) {
      return { matches, truncated: true };
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches, truncated: false };
}

/**
 * 替换串展开（ECMAScript 的 GetSubstitution，与 `String.prototype.replace` 一字不差）：
 * `$$` → `$`，`$&` → 匹配到的字，`` $` `` / `$'` → 全文里这一处之前 / 之后的字，
 * `$n` / `$nn` → 第 n 组（两位数超过组数时按一位数加一个字面数字读，`$0` 原样），
 * `$<名字>` → 命名组（正则里没有命名组时原样）。认不出的 `$` 原样留着。
 */
export function expandReplacement(template: string, m: RegExpExecArray, text: string): string {
  if (!template.includes('$')) {
    return template;
  }
  const matched = m[0];
  const position = m.index;
  const captures = m.slice(1);
  const groups = m.groups;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '$' || i + 1 >= template.length) {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
    } else if (next === '&') {
      out += matched;
      i += 2;
    } else if (next === '`') {
      out += text.slice(0, position);
      i += 2;
    } else if (next === "'") {
      out += text.slice(Math.min(text.length, position + matched.length));
      i += 2;
    } else if (next >= '0' && next <= '9') {
      const d2 = template[i + 2];
      let digits = d2 !== undefined && d2 >= '0' && d2 <= '9' ? 2 : 1;
      let index = Number(template.slice(i + 1, i + 1 + digits));
      if (digits === 2 && index > captures.length) {
        digits = 1;
        index = Number(next);
      }
      out += index >= 1 && index <= captures.length
        ? captures[index - 1] ?? ''
        : template.slice(i, i + 1 + digits);
      i += 1 + digits;
    } else if (next === '<') {
      const close = groups ? template.indexOf('>', i + 2) : -1;
      if (!groups || close === -1) {
        out += '$<';
        i += 2;
      } else {
        out += groups[template.slice(i + 2, close)] ?? '';
        i = close + 1;
      }
    } else {
      out += '$';
      i++;
    }
  }
  return out;
}

/** 编好的全局正则 → 只在给定位置试的粘性版本（前后文仍是整份文字）。 */
function stickyOf(re: RegExp): RegExp {
  return new RegExp(re.source, `${re.flags.replace('g', '')}y`);
}

/**
 * 这一处要换成什么。不按正则时就是替换串本身（`$` 是字面量）；按正则时在**全文**里从这一处重新匹配一次，
 * 照 `String.prototype.replace` 的规矩展开 `$1` 这些。这一处已经对不上（文字刚变过）、或正则写错时返回 undefined。
 */
export function replacementFor(
  text: string,
  at: FindMatch,
  query: string,
  replacement: string,
  opts: FindOptions = {}
): string | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  // 粘性（y）且不全局：只在 at.start 这一个位置试，前后文仍是整份文字。
  const re = stickyOf(compiled.re);
  re.lastIndex = at.start;
  const m = re.exec(text);
  if (!m || m[0].length !== at.end - at.start) {
    return undefined;
  }
  return opts.regex ? expandReplacement(replacement, m, text) : replacement;
}

/**
 * 全部替换：算出**从第一处到最后一处的那一段**换成什么（编辑器拿它调一次 `applyEdit`，只记一步撤销）。
 * 一处都没有、查找串为空或正则写错时返回 undefined。
 */
export function replaceAllIn(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions = {}
): ReplaceAllEdit | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  let start = -1;
  let last = 0;
  let count = 0;
  const parts: string[] = [];
  for (const m of eachMatch(text, compiled.re)) {
    if (start < 0) {
      start = m.index;
      last = m.index;
    }
    parts.push(text.slice(last, m.index), opts.regex ? expandReplacement(replacement, m, text) : replacement);
    last = m.index + m[0].length;
    count++;
  }
  return count > 0 ? { start, end: last, text: parts.join(''), count } : undefined;
}

/**
 * **只换挑出来的那几处**（全书替换：作者在预览里勾掉了几处）。每一处都在**原文**里、在它自己的位置上重新匹配一次
 * （与 {@link replacementFor} 同一个办法：`$1`、`` $` ``、后行断言看的都是整份原文），对得上才换；对不上的
 * （那个位置上已经不是一处匹配、或与前一处重叠）记进 `missed`、原样留着。挑出来的顺序无所谓，按位置排。
 * 查找串为空或正则写错时返回 undefined。
 */
export function replaceSelectedIn(
  text: string,
  picks: readonly FindMatch[],
  query: string,
  replacement: string,
  opts: FindOptions = {}
): SelectedReplace | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  const re = stickyOf(compiled.re);
  const sorted = [...picks].sort((a, b) => a.start - b.start || a.end - b.end);
  const replaced: FindMatch[] = [];
  const missed: FindMatch[] = [];
  const parts: string[] = [];
  let last = 0;
  for (const pick of sorted) {
    if (pick.start < last || pick.end <= pick.start) {
      missed.push(pick);
      continue;
    }
    re.lastIndex = pick.start;
    const m = re.exec(text);
    if (!m || m.index !== pick.start || m[0].length !== pick.end - pick.start) {
      missed.push(pick);
      continue;
    }
    parts.push(text.slice(last, pick.start), opts.regex ? expandReplacement(replacement, m, text) : replacement);
    last = pick.end;
    replaced.push(pick);
  }
  parts.push(text.slice(last));
  return { text: parts.join(''), replaced, missed };
}
