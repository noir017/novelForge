/**
 * 专注那几样的纯函数（零 DOM）：段落聚焦认「光标在哪一段」、打字机滚动算「该滚到哪」。
 * 按键、图层、滚动本身在 `paragraphFocus.ts` / `typewriter.ts`；口径在这里，`tests/unit/editor/focusCore.test.js` 钉着。
 */
import type { ParagraphStyle } from '../protocol';
import { isHeadingLine, isSceneBreakLine } from '../protocol';

export interface TextRange {
  start: number;
  end: number;
}

/** 行首的缩进：半角空格、制表符、全角空格、不换行空格。 */
const LEADING_INDENT = /^[ \t　 ]/;

const isBlank = (line: string): boolean => line.trim() === '';
/** 标题行与场景分隔行自成一段（与一键排版同一个认法）。 */
const isSolo = (line: string): boolean => isHeadingLine(line) || isSceneBreakLine(line);

/**
 * 光标所在的那一段：从这一段第一行的行首到最后一行的行尾（不含换行），位置按 `text` 的下标。
 *
 * 分段按工程的分段格式（`paragraphStyle`）认，与回车插什么同一套：
 *
 * - **空行分段**（`blank`）：空行隔开的一整块是一段；块里不空行的换行（Shift+Enter 打的）还在这一段里。
 * - **段首缩进**（`indent`）：行首有缩进的那一行另起一段；行首没缩进、紧跟在一行字后面的是上一段的续行
 *   （Shift+Enter 打的）。空行也隔开段落。
 * - **缩进加空行**（`both`）：两样都算——空行隔开，块里行首有缩进的那一行也另起一段。
 *
 * 三种格式下标题行（`#`）与场景分隔行（`* * *`、`※`……）都自成一段。光标落在空行上时，那一段就是这一行本身
 * （新起的一段还没有字，其余的都淡下去）。
 */
export function paragraphRangeAt(text: string, caret: number, style: ParagraphStyle): TextRange {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const pos = Math.max(0, Math.min(text.length, Math.floor(caret)));
  let idx = 0;
  while (idx + 1 < lines.length && starts[idx + 1] <= pos) {
    idx++;
  }
  const lineRange = (first: number, last: number): TextRange => ({
    start: starts[first],
    end: starts[last] + lines[last].length,
  });
  if (isBlank(lines[idx])) {
    return lineRange(idx, idx);
  }
  const indentStarts = style !== 'blank';
  /** 第 i 行（不空）是不是一段的第一行。 */
  const opens = (i: number): boolean =>
    i === 0 ||
    isBlank(lines[i - 1]) ||
    isSolo(lines[i - 1]) ||
    isSolo(lines[i]) ||
    (indentStarts && LEADING_INDENT.test(lines[i]));

  let first = idx;
  while (!opens(first)) {
    first--;
  }
  let last = idx;
  while (last + 1 < lines.length && !isBlank(lines[last + 1]) && !opens(last + 1)) {
    last++;
  }
  return lineRange(first, last);
}

/**
 * 打字机滚动：让光标那一行的中线落在视口中间，返回该把 `scrollTop` 设成多少；已经在中间（差不到 1px）时
 * 返回 undefined，不动。`caretTop` 从内容顶上（含上内边距）量，`caretHeight` 是那一行的行高。
 * 滚不到负数；滚不到底由浏览器自己夹（打字机滚动开着时编辑区底下多垫了半屏，最后一行也能滚到中间）。
 */
export function typewriterScrollTop(
  caretTop: number,
  caretHeight: number,
  viewport: number,
  scrollTop: number
): number | undefined {
  const target = Math.max(0, Math.round(caretTop + caretHeight / 2 - viewport / 2));
  return Math.abs(target - scrollTop) >= 1 ? target : undefined;
}
