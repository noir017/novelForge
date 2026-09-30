/**
 * 段级 diff（五期 W11）：覆盖审阅与修稿的合并视图按段对齐两个版本，逐处「采用新版 / 保留原文」。
 *
 * **纯函数，零 import**：前端的合并视图直接打包它，单测直接跑它（总计划 §8：「diff 视图自己写
 * 有 bug」的缓解就是这里每一步都能单测）。
 *
 * ## 为什么是 LCS
 *
 * AI-Novel-Writer 的 `ThreeWayMerge.tsx` 用按字频相似度的全局对齐（能认出「一段拆成两段」）。
 * 这里用段序列上的最长公共子序列：修稿与重写的改动多是整段的增、删、改，LCS 已经够用，
 * 而且结果是确定的、好解释的——「这几段两边一字不差，中间这几段是改动」。
 *
 * 段的比较键是去掉全部空白之后的文字：只差一个换行、一个空格的两段当成同一段，
 * 不值得让作者为它点一次「采用」。
 */

/** 合并视图里的一截：两边一样的一段（或连着的几段），或者一处改动。 */
export type MergeSegment =
  | { kind: 'same'; paragraphs: string[] }
  | { kind: 'change'; old: string[]; new: string[] };

/**
 * 两边段数的乘积超过这个数的平方时不做 LCS，整份当一处改动（表是 n × m 的）。
 * 章节远到不了这个数，这是防御。
 */
export const DIFF_MAX_PARAGRAPHS = 1500;

/**
 * 按空行切段。段内的单个换行保留（诗、信件、对白里的分行是作者的排版）；首尾空白去掉；
 * 空段丢掉。frontmatter（`---` 夹着的那一块）中间没有空行，自然是一段。
 */
export function splitParagraphs(text: string): string[] {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t　]*\n)+/)
    // 只去掉开头的整行空白：首行的缩进（「　　」）是作者的排版，留着。
    .map((p) => p.replace(/^(?:[ \t　]*\n)+/, '').replace(/\s+$/, ''))
    .filter((p) => p.trim().length > 0);
}

function keyOf(p: string): string {
  return p.replace(/\s+/g, '');
}

/**
 * 两个版本的段级差异。相同的段连成一截 `same`，相邻的增删改并成一处 `change`
 * （一段改写 = 删一段 + 加一段，挨在一起就是一处）。
 */
export function diffParagraphs(before: string, after: string): MergeSegment[] {
  const a = splitParagraphs(before);
  const b = splitParagraphs(after);
  if (a.length * b.length > DIFF_MAX_PARAGRAPHS * DIFF_MAX_PARAGRAPHS) {
    return [{ kind: 'change', old: a, new: b }];
  }
  const ka = a.map(keyOf);
  const kb = b.map(keyOf);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 与 b[j..] 的 LCS 长度；一维数组按行存。
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: MergeSegment[] = [];
  const same = (p: string) => {
    const last = out[out.length - 1];
    if (last?.kind === 'same') {
      last.paragraphs.push(p);
    } else {
      out.push({ kind: 'same', paragraphs: [p] });
    }
  };
  const change = (side: 'old' | 'new', p: string) => {
    const last = out[out.length - 1];
    if (last?.kind === 'change') {
      last[side].push(p);
    } else {
      out.push(side === 'old' ? { kind: 'change', old: [p], new: [] } : { kind: 'change', old: [], new: [p] });
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      // 相同的段取新版那一份：两边只差空白时，新版的排版是要写下去的那一份。
      same(b[j]);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      change('old', a[i++]);
    } else {
      change('new', b[j++]);
    }
  }
  while (i < n) {
    change('old', a[i++]);
  }
  while (j < m) {
    change('new', b[j++]);
  }
  return out;
}

/** 一共几处改动。合并视图顶上「已处理 k / n 处」的 n。 */
export function changeCount(segments: readonly MergeSegment[]): number {
  return segments.filter((s) => s.kind === 'change').length;
}

/** 一处改动「采用新版」「保留原文」时结果格里的那一份文字。 */
export function sideText(segment: Extract<MergeSegment, { kind: 'change' }>, side: 'old' | 'new'): string {
  return segment[side].join('\n\n');
}

/**
 * 拼出合并结果。`results[k]` 是第 k 截（下标与 `segments` 对齐）结果格里的文字：没给就用新版。
 * 结果格可以是空的（这一处整段删掉）。段与段之间一个空行，文件末尾一个换行。
 */
export function joinMerge(segments: readonly MergeSegment[], results: Readonly<Record<number, string>> = {}): string {
  const pieces: string[] = [];
  segments.forEach((s, k) => {
    const text = s.kind === 'same' ? s.paragraphs.join('\n\n') : results[k] ?? sideText(s, 'new');
    if (text.trim()) {
      pieces.push(text.replace(/^\n+|\s+$/g, ''));
    }
  });
  return pieces.length > 0 ? `${pieces.join('\n\n')}\n` : '';
}
