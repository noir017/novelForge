/**
 * 查找替换条的纯函数：在匹配表里定位（下一处、上一处、离光标最近的、正好是选区的那一处）、选区预填进查找框。
 *
 * **零 DOM 依赖**（单测直接跑：`tests/unit/editor/findCore.test.js`）；查找条的界面与按键在 `find.ts`。
 *
 * **匹配口径不在这里**：找全部匹配、`$1` 展开、全部替换在 core 的 `model/textFind.ts`（纯函数、零 import，经
 * `../protocol` 打进浏览器产物），这里原样转出——全书查找替换在后端读盘，用的是同一份，同一个查找串、同两颗
 * 开关在一份文件里与在全书里找到的是同一批（大小写、正则的 `m` / `u`、零长度跳过、`$1` 的语义见那个文件头）。
 */
import type { FindMatch } from '../protocol';

export {
  MATCH_LIMIT,
  compileSearch,
  escapeRegExp,
  expandReplacement,
  findMatches,
  replaceAllIn,
  replaceSelectedIn,
  replacementFor,
} from '../protocol';
export type { CompiledSearch, FindMatch, FindOptions, FindResult, ReplaceAllEdit, SelectedReplace } from '../protocol';

/** 选区预填进查找框的上限：比这长、或跨了行，就不预填。 */
export const SEED_MAX = 80;

// ---------------------------------------------------------------- 在匹配表里定位

/** 第一处 `start >= pos` 的下标（二分）；都在 pos 之前时返回 `matches.length`。 */
function lowerBound(matches: FindMatch[], pos: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 从 pos 往后最近的一处（`start >= pos`），后面没有就绕回第一处。没有匹配返回 -1。 */
export function matchAfter(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  const i = lowerBound(matches, pos);
  return i < matches.length ? i : 0;
}

/** pos 之前最近的一处（`start < pos`），前面没有就绕回最后一处。没有匹配返回 -1。 */
export function matchBefore(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  const i = lowerBound(matches, pos) - 1;
  return i >= 0 ? i : matches.length - 1;
}

/** 离 pos 最近、不在它前面的那一处；都在前面就取最后一处（文字变了之后让「当前第几处」留在原处附近）。 */
export function nearestMatch(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  return Math.min(lowerBound(matches, pos), matches.length - 1);
}

/** 正好是 `[start, end)` 的那一处的下标，没有返回 -1（「替换」只在选区正好是一处匹配时才换）。 */
export function matchAt(matches: FindMatch[], start: number, end: number): number {
  const i = lowerBound(matches, start);
  return i < matches.length && matches[i].start === start && matches[i].end === end ? i : -1;
}

/** 选区能不能预填进查找框：非空、不跨行、不超过 `SEED_MAX` 个字。能就返回那几个字。 */
export function seedFromSelection(text: string, start: number, end: number): string | undefined {
  if (end <= start || end - start > SEED_MAX) {
    return undefined;
  }
  const picked = text.slice(start, end);
  return picked.includes('\n') ? undefined : picked;
}
