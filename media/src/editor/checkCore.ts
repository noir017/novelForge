/**
 * 写作体检的口径（独立版内置编辑器，`check.ts` 装配）。**纯函数、零 DOM**，`tests/unit/editor/checkCore.test.js` 钉着。
 *
 * 四类，都只在正文（章节与草稿）上查：
 *
 * | 类别 | 词从哪来 | 怎么找 | 算几个问题 |
 * |---|---|---|---|
 * | 禁用词 | 后端推来的 `banned`（`style.md` 禁用词表 + 全局要求里禁止的词 + 古代题材的现代说法） | `locateTerms`，**区分大小写**——与写完一章之后的 `countBanned` 同一个函数 | 每一处算一个 |
 * | 敏感词 | 后端推来的 `sensitive`（`.novelforge/sensitive.txt`） | `locateTerms` 的 `foldCase`：英文不分大小写、全角当半角 | 每一处算一个 |
 * | 比喻词 | `SIMILE_WORDS`（与生成链同一张表） | `locateTerms`（`countSimiles` 也建在它上面） | **全章超过 `SIMILE_LIMIT` 才算**，算超出的那几个；没超不高亮 |
 * | 英文缩写 | 正文本身 | `latinAcronymRanges`（`latinAcronyms` 建在它上面） | 每一处算一个 |
 *
 * 同一段字可以同时落在几类里（禁用词「能量」也写进了敏感词表），各算各的、各画各的样子；同一个词出现几次就有几处。
 * 找位置的函数都在 core 的 `model/manuscriptCheck.ts`，这里只按类别收拢、排顺序、算替换。
 */
import { SIMILE_LIMIT, SIMILE_WORDS, latinAcronymRanges, locateTerms } from '../protocol';
import type { CheckSensitiveTerm } from '../protocol';
import type { TextChange } from './history';

export type CheckCategory = 'sensitive' | 'banned' | 'simile' | 'acronym';

/** 面板里从上到下的顺序：敏感词（发不出去）→ 禁用词 → 比喻词 → 英文缩写（只是提示）。 */
export const CHECK_CATEGORIES: readonly CheckCategory[] = ['sensitive', 'banned', 'simile', 'acronym'];

export const CHECK_LABEL: Record<CheckCategory, string> = {
  sensitive: '敏感词',
  banned: '禁用词',
  simile: '比喻词',
  acronym: '英文缩写',
};

/** 高亮镜像层上各类的 class（颜色在 `css/standalone/check.css`）。 */
export const CHECK_CLASS: Record<CheckCategory, string> = {
  sensitive: 'ed-hl-chk-sensitive',
  banned: 'ed-hl-chk-banned',
  simile: 'ed-hl-chk-simile',
  acronym: 'ed-hl-chk-acronym',
};

/** 后端推来的那两份词（`checkTerms`）。 */
export interface CheckVocab {
  banned: readonly string[];
  sensitive: readonly CheckSensitiveTerm[];
}

export const EMPTY_VOCAB: CheckVocab = Object.freeze({ banned: [], sensitive: [] });

/** 一个词在这一份正文里的全部位置。 */
export interface CheckEntry {
  category: CheckCategory;
  /** 词表里的写法（缩写是折成半角的写法）。 */
  term: string;
  /** 每一处的起点（`area.value` 的下标），升序。 */
  offsets: number[];
  /** 每一处多长（UTF-16 下标）。折大小写一个字换一个字，所以各处一样长。 */
  length: number;
  /** 敏感词表里写了的替换词。 */
  replacement?: string;
}

export interface CheckResult {
  /** 有命中的词，按 {@link CHECK_CATEGORIES} 的类别顺序，同一类里次数多的在前、一样多的按先出现的。 */
  entries: CheckEntry[];
  /** 比喻词全章合计几次、上限、超出几次（没超是 0）。 */
  similes: { total: number; limit: number; over: number };
  /** 每一类算几个问题（比喻词算超出的那几个）。 */
  counts: Record<CheckCategory, number>;
  /** 一共几个问题（状态栏「体检 N」的 N）。 */
  total: number;
}

/** 按类别收拢、排顺序。 */
function sortEntries(list: CheckEntry[]): CheckEntry[] {
  return list.sort(
    (a, b) =>
      CHECK_CATEGORIES.indexOf(a.category) - CHECK_CATEGORIES.indexOf(b.category) ||
      b.offsets.length - a.offsets.length ||
      a.offsets[0] - b.offsets[0]
  );
}

/** 体检一份正文。 */
export function runCheck(text: string, vocab: CheckVocab = EMPTY_VOCAB): CheckResult {
  const entries: CheckEntry[] = [];
  const counts: Record<CheckCategory, number> = { sensitive: 0, banned: 0, simile: 0, acronym: 0 };

  const sensitive = vocab.sensitive ?? [];
  locateTerms(
    text,
    sensitive.map((s) => s.term),
    { foldCase: true }
  ).forEach((hit, i) => {
    if (hit.offsets.length > 0) {
      const replacement = sensitive[i].replacement;
      entries.push({
        category: 'sensitive',
        term: hit.term,
        offsets: hit.offsets,
        length: hit.term.length,
        ...(replacement ? { replacement } : {}),
      });
      counts.sensitive += hit.offsets.length;
    }
  });

  for (const hit of locateTerms(text, vocab.banned ?? [])) {
    if (hit.offsets.length > 0) {
      entries.push({ category: 'banned', term: hit.term, offsets: hit.offsets, length: hit.term.length });
      counts.banned += hit.offsets.length;
    }
  }

  const simileHits = locateTerms(text, SIMILE_WORDS).filter((h) => h.offsets.length > 0);
  const total = simileHits.reduce((n, h) => n + h.offsets.length, 0);
  const over = Math.max(0, total - SIMILE_LIMIT);
  if (over > 0) {
    for (const hit of simileHits) {
      entries.push({ category: 'simile', term: hit.term, offsets: hit.offsets, length: hit.term.length });
    }
    counts.simile = over;
  }

  const acronyms = new Map<string, CheckEntry>();
  for (const r of latinAcronymRanges(text)) {
    const known = acronyms.get(r.term);
    if (known) {
      known.offsets.push(r.start);
    } else {
      const entry: CheckEntry = { category: 'acronym', term: r.term, offsets: [r.start], length: r.end - r.start };
      acronyms.set(r.term, entry);
      entries.push(entry);
    }
    counts.acronym++;
  }

  return {
    entries: sortEntries(entries),
    similes: { total, limit: SIMILE_LIMIT, over },
    counts,
    total: counts.sensitive + counts.banned + counts.simile + counts.acronym,
  };
}

/** 一段要涂色的字（与 `highlight.ts` 的 `HighlightRange` 同一个形状）。 */
export interface CheckRange {
  start: number;
  end: number;
  cls: string;
}

/** 画到高亮镜像层 `check` 图层上的那几段，按起点排。比喻词没超上限时 `runCheck` 根本不给它们。 */
export function checkRanges(result: CheckResult): CheckRange[] {
  const out: CheckRange[] = [];
  for (const e of result.entries) {
    for (const at of e.offsets) {
      out.push({ start: at, end: at + e.length, cls: CHECK_CLASS[e.category] });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
}

/** 两份范围是不是一模一样（一样就不必再画一遍）。 */
export function sameRanges(a: readonly CheckRange[], b: readonly CheckRange[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].cls !== b[i].cls) {
      return false;
    }
  }
  return true;
}

/**
 * 一处改动之后各段跟着平移；压在改动上的那几段丢掉。**与 `highlight.ts` 平移图层是同一条规则**——
 * 编辑器记着「镜像层上此刻画的是哪几段」，与它对得上才知道要不要再画一遍。
 */
export function shiftRanges(ranges: readonly CheckRange[], change: TextChange): CheckRange[] {
  const removedEnd = change.at + change.removed.length;
  const delta = change.inserted.length - change.removed.length;
  const out: CheckRange[] = [];
  for (const r of ranges) {
    if (r.end <= change.at) {
      out.push(r);
    } else if (r.start >= removedEnd) {
      out.push({ start: r.start + delta, end: r.end + delta, cls: r.cls });
    }
  }
  return out;
}

/**
 * 两份文字差在哪一段（公共前缀与后缀之外的那一段）。撤销 / 重做、输入法组字中途这些不带改动的变化，靠它把已经
 * 画着的那几段挪到新位置——不重找，也不乱跳。一样时 undefined。
 */
export function diffChange(before: string, after: string): TextChange | undefined {
  if (before === after) {
    return undefined;
  }
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) {
    head++;
  }
  let tail = 0;
  while (
    tail < max - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  return { at: head, removed: before.slice(head, before.length - tail), inserted: after.slice(head, after.length - tail) };
}

/** 选区正好是这个词的第几处；不是任何一处时 -1。 */
export function occurrenceAt(entry: Pick<CheckEntry, 'offsets' | 'length'>, start: number, end: number): number {
  return end - start === entry.length ? entry.offsets.indexOf(start) : -1;
}

/**
 * 点一下这个词要跳到第几处：选区正好是第 k 处就跳到第 k+1 处；否则跳到光标之后（含光标处）的第一处；到底了绕回第一处。
 * 一处都没有时 -1。
 */
export function nextOccurrence(entry: Pick<CheckEntry, 'offsets' | 'length'>, start: number, end: number): number {
  const n = entry.offsets.length;
  if (n === 0) {
    return -1;
  }
  const at = occurrenceAt(entry, start, end);
  if (at >= 0) {
    return (at + 1) % n;
  }
  const i = entry.offsets.findIndex((o) => o >= start);
  return i >= 0 ? i : 0;
}

/** 本文件全部替换要改的那一段：从第一处到最后一处（编辑器拿它调一次 `applyEdit`，只记一步撤销）。 */
export interface CheckReplaceEdit {
  start: number;
  end: number;
  text: string;
  count: number;
}

/**
 * 把这个词的每一处都换成 `replacement`，算出「第一处到最后一处那一段」的新文字——与查找替换的「全部替换」
 * （`findCore.replaceAllIn`）同一个形状、同一条路（一次 `applyEdit`）。位置用体检找出来的那几处，高亮在哪就换哪。
 */
export function replaceAllEdit(
  text: string,
  entry: Pick<CheckEntry, 'offsets' | 'length'>,
  replacement: string
): CheckReplaceEdit | undefined {
  const offsets = [...entry.offsets].sort((a, b) => a - b);
  if (offsets.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  let last = offsets[0];
  for (const at of offsets) {
    if (at < last) {
      continue; // 叠在上一处里面的（同一个词不会，防一手坏数据）。
    }
    parts.push(text.slice(last, at), replacement);
    last = at + entry.length;
  }
  return { start: offsets[0], end: last, text: parts.join(''), count: parts.length / 2 };
}

/** 「体检 3」那一格的悬停提示里那一句：各类几个。 */
export function describeCounts(result: CheckResult): string {
  const parts: string[] = [];
  for (const c of CHECK_CATEGORIES) {
    const n = result.counts[c];
    if (n > 0) {
      parts.push(c === 'simile' ? `比喻词超出 ${n} 个` : `${CHECK_LABEL[c]} ${n} 处`);
    }
  }
  return parts.join(' · ');
}
