/**
 * 删修饰：写完正文之后的一轮「只许删」修稿，这里是它的纯函数——编号、读回、验收、保底。
 *
 * 为什么只许删：flash-lite 这一档的模型写正文时管不住修饰（名词前堆形容词、动词前挂程度副词），
 * 提示词与写作技能怎么说都压不下来；但「从一段话里删掉多余的字」它做得好，而且删没删、加没加
 * 是代码能确定地验收的。实测与取舍见 docs/design/plans/2026-10-03-plain-prose.md。
 *
 * 验收逐段做，不合格的段退回原文，其余照用：一段被改坏不该连累整章。
 */

/** 一段里允许新增的汉字数：删掉半句之后偶尔要补一个「的」「地」「了」才通顺。 */
export const TRIM_MAX_ADDED_HAN = 2;

/** 一段删完至少留原来的这么多（按汉字算）。删得更狠的多半是把情节删了。 */
export const TRIM_MIN_KEEP_RATIO = 0.4;

/** 新写的正文不到这么多字就不跑这一轮：几句话没什么可删的，白花一次调用。 */
export const TRIM_MIN_CHARS = 200;

const HAN = /[一-鿿]/g;

function hanCount(text: string): number {
  return text.match(HAN)?.length ?? 0;
}

/** 段里的对白（中文双引号、直角引号）。删修饰不碰对白：人物怎么说话归角色设定管。 */
export function quotesOf(text: string): string[] {
  return text.match(/“[^”]*”|「[^」]*」/g) ?? [];
}

/** 按空行切段。段内的单个换行留着。 */
export function trimParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t　]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 给模型的那份：每段前面一个 `[n]`。 */
export function numberParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join('\n\n');
}

/**
 * 读回模型的输出：`[n] 正文`，一行一段。编号越界、重复的丢掉（取第一个）；没出现的编号就是
 * 这一段没交回来，验收时当退回处理。
 */
export function parseNumbered(output: string, count: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of output.matchAll(/^\s*\[(\d+)\]\s*(.*)$/gm)) {
    const no = Number(m[1]);
    if (no >= 1 && no <= count && !out.has(no)) {
      out.set(no, m[2].trim());
    }
  }
  return out;
}

/**
 * 新版里多出来的字：按字做最长公共子序列，新版里不在公共子序列上的就是加的。段落只有几百字，
 * n × m 的表放得下。
 */
export function addedChars(before: string, after: string): string {
  const a = [...before];
  const b = [...after];
  const n = a.length;
  const m = b.length;
  // 行 i 存 a[i..] 与 b[j..] 的 LCS 长度，倒着填，正着走一遍取出 b 里没配上的字。
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let added = '';
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      added += b[j];
      j++;
    }
  }
  return added;
}

/** 一段删得合不合格。合格返回 undefined，否则返回退回的原因（进说明）。 */
export function trimProblem(before: string, after: string): string | undefined {
  if (!after.trim()) {
    return '整段删光了';
  }
  const q1 = quotesOf(before);
  const q2 = quotesOf(after);
  if (q1.length !== q2.length || q1.some((q, i) => q !== q2[i])) {
    return '动了对白';
  }
  const added = addedChars(before, after);
  if (hanCount(added) > TRIM_MAX_ADDED_HAN) {
    return '加了原文没有的字';
  }
  if (hanCount(after) < hanCount(before) * TRIM_MIN_KEEP_RATIO) {
    return '删得太多';
  }
  // 结尾的句末标点换了，往往是把最后一句删成了半句。
  if (before.slice(-1) !== after.slice(-1)) {
    return '改了段尾';
  }
  return undefined;
}

export interface TrimOutcome {
  /** 删完的正文，段间空一行。 */
  text: string;
  /** 真的删了字的段数。 */
  changed: number;
  /** 退回原文的段：原因 → 段数。 */
  rejected: Map<string, number>;
  /** 为了保住篇幅又退回的段数（见 {@link applyTrim} 的 `floor`）。 */
  restored: number;
}

/**
 * 逐段验收、拼回正文。
 *
 * `floor`：删完之后这一段正文至少要有多少字（按 `countWords` 那把尺子，由调用方给）。写正文的
 * 「写够了」看的是目标字数的八成，删修饰把一章删到八成以下，主按钮就会转去推「接着写」，等于
 * 白删；所以删多了就从删得最多的段开始退回原文，直到够数为止。
 */
export function applyTrim(
  paragraphs: readonly string[],
  edits: ReadonlyMap<number, string>,
  opts: { floor?: number; countWords?: (text: string) => number } = {}
): TrimOutcome {
  const rejected = new Map<string, number>();
  const result = paragraphs.map((before, i) => {
    const after = edits.get(i + 1);
    if (after === undefined) {
      rejected.set('没交回来', (rejected.get('没交回来') ?? 0) + 1);
      return before;
    }
    const why = trimProblem(before, after);
    if (why) {
      rejected.set(why, (rejected.get(why) ?? 0) + 1);
      return before;
    }
    return after;
  });

  let restored = 0;
  const count = opts.countWords;
  if (opts.floor !== undefined && count) {
    const order = result
      .map((after, i) => ({ i, cut: count(paragraphs[i]) - count(after) }))
      .filter((x) => x.cut > 0)
      .sort((x, y) => y.cut - x.cut);
    let total = count(result.join('\n\n'));
    for (const { i, cut } of order) {
      if (total >= opts.floor) {
        break;
      }
      result[i] = paragraphs[i];
      total += cut;
      restored++;
    }
  }

  return {
    text: result.join('\n\n'),
    changed: result.filter((after, i) => after !== paragraphs[i]).length,
    rejected,
    restored,
  };
}
