/**
 * Markdown 预览的纯函数（零 DOM）：把正文切成块、记下每一块是源文件的第几行到第几行（`previewBlocks`），以及
 * 「编辑区里第几行」与「预览里多高」之间的换算（切预览 / 切回编辑时两边滚到同一处，`preview.ts` 与
 * `previewSync.ts` 用）。`tests/unit/editor/previewCore.test.js` 钉着。
 *
 * 行号从 0 数、按 `\n` 切（textarea 里的 `area.value` 也是这样，`\r\n` 先归一），`end` 不含。位置可以带小数：
 * `12.5` 是第 12 行（从 0 数）往下半行——中文一段就是一行、一行能折成好几屏，只认整行会差出一大截。
 */

/** 预览里的一块（`<p>` / `<h1>` / `<pre>` / 一个 `<li>`……）对应源文件的哪几行。 */
interface Span {
  /** 第一行（从 0 数）。 */
  start: number;
  /** 最后一行的下一行。 */
  end: number;
}

export type PreviewBlock =
  | (Span & { kind: 'frontmatter'; text: string })
  | (Span & { kind: 'heading'; level: 1 | 2 | 3; text: string })
  | (Span & { kind: 'paragraph'; text: string })
  | (Span & { kind: 'code'; text: string })
  | (Span & { kind: 'hr' })
  | (Span & { kind: 'quote'; text: string })
  | (Span & { kind: 'list'; ordered: boolean; items: (Span & { text: string })[] });

/**
 * 正文切成块（够用的那一套：frontmatter、标题、段落、代码块、分隔线、引用、列表）。缺的语法当段落原样显示。
 *
 * - frontmatter：第一行是 `---`、后面某一行正好是 `---`，这一段（连同两条线）是一块。
 * - 连着的几行普通文字是一段（空行、标题、代码块、分隔线、引用、列表项都会断开它）；段首缩进的正文没有空行，
 *   整章就是一段——那时滚动对应只能在这一大块里按行数比例摆。
 * - 代码块从开头那条 ``` 到收尾那条（没收尾就到文末）。
 * - 引用一行一块；列表是连着的同一种列表项，每一项一行。
 */
export function previewBlocks(source: string): PreviewBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: PreviewBlock[] = [];
  let i = 0;

  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      blocks.push({ kind: 'frontmatter', start: 0, end: close + 1, text: lines.slice(1, close).join('\n') });
      i = close + 1;
    }
  }

  let para: { start: number; lines: string[] } | undefined;
  const flush = (): void => {
    if (para) {
      blocks.push({ kind: 'paragraph', start: para.start, end: para.start + para.lines.length, text: para.lines.join('\n') });
      para = undefined;
    }
  };
  let list: Extract<PreviewBlock, { kind: 'list' }> | undefined;
  const endList = (): void => {
    list = undefined;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      endList();
      continue;
    }

    if (trimmed.startsWith('```')) {
      flush();
      endList();
      const start = i;
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) {
        buf.push(lines[i]);
      }
      blocks.push({ kind: 'code', start, end: Math.min(i + 1, lines.length), text: buf.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      endList();
      // h4 以下都当 h3 画：预览是给人快速扫一眼的，再细分层级没有意义。
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, start: i, end: i + 1, text: heading[2] });
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      flush();
      endList();
      blocks.push({ kind: 'hr', start: i, end: i + 1 });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      endList();
      blocks.push({ kind: 'quote', start: i, end: i + 1, text: trimmed.replace(/^>\s?/, '') });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      if (!list || list.ordered !== isOrdered) {
        list = { kind: 'list', ordered: isOrdered, start: i, end: i + 1, items: [] };
        blocks.push(list);
      }
      list.items.push({ start: i, end: i + 1, text: bullet ? bullet[1] : ordered![2] });
      list.end = i + 1;
      continue;
    }

    endList();
    if (!para) {
      para = { start: i, lines: [] };
    }
    para.lines.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- 滚动对应

/** 预览里一块（带 `data-line` 的那几样）量出来的位置：`top` 从预览内容的最顶上算，`height` 是它自己的高。 */
export interface BlockBox extends Span {
  top: number;
  height: number;
}

/** 夹进 `[lo, hi]`。 */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** `a` 到 `b` 之间按比例取一点（`span` 为 0 时取 `a`）。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 源文件里的位置（行，带小数）→ 预览里的纵向位置。落在某一块里按它占这一块几行的比例摆；落在两块之间的空行上，
 * 在上一块的底与下一块的顶之间按比例摆；在第一块之前从 0 摆到它的顶，最后一块之后就是它的底。`boxes` 按 `start` 排好、
 * 互不重叠（列表按项、不按整张列表）。
 */
export function sourceToPreviewY(boxes: readonly BlockBox[], pos: number): number {
  if (boxes.length === 0) {
    return 0;
  }
  const first = boxes[0];
  if (pos < first.start) {
    return lerp(0, first.top, first.start > 0 ? pos / first.start : 0);
  }
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    if (pos < b.end) {
      return pos >= b.start ? lerp(b.top, b.top + b.height, (pos - b.start) / Math.max(1, b.end - b.start)) : b.top;
    }
    const next = boxes[k + 1];
    if (next && pos < next.start) {
      return lerp(b.top + b.height, next.top, (pos - b.end) / Math.max(1, next.start - b.end));
    }
  }
  const last = boxes[boxes.length - 1];
  return last.top + last.height;
}

/** 预览里的纵向位置 → 源文件里的位置（行，带小数）。`sourceToPreviewY` 反过来。 */
export function previewYToSource(boxes: readonly BlockBox[], y: number): number {
  if (boxes.length === 0) {
    return 0;
  }
  const first = boxes[0];
  if (y < first.top) {
    return lerp(0, first.start, first.top > 0 ? y / first.top : 0);
  }
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const bottom = b.top + b.height;
    if (y < bottom) {
      return y >= b.top ? lerp(b.start, b.end, b.height > 0 ? (y - b.top) / b.height : 0) : b.start;
    }
    const next = boxes[k + 1];
    if (next && y < next.top) {
      return lerp(b.end, next.start, next.top > bottom ? (y - bottom) / (next.top - bottom) : 0);
    }
  }
  return boxes[boxes.length - 1].end;
}

/**
 * 编辑区：纵向位置 `y`（从第 0 行的顶算）落在第几行（带小数）。`topOf(i)` 是第 i 行的顶（`topOf(0)` 为 0，
 * `topOf(lineCount)` 是最后一行的底），按行单调不减。二分，只量 log₂(行数) 次——每量一次都要排一遍前面的文字。
 */
export function lineAtY(lineCount: number, topOf: (i: number) => number, y: number): number {
  if (lineCount <= 0) {
    return 0;
  }
  let lo = 0;
  let hi = lineCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (topOf(mid) <= y) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const top = topOf(lo);
  const next = topOf(lo + 1);
  return lo + (next > top ? clamp((y - top) / (next - top), 0, 1) : 0);
}

/** 编辑区：第几行（带小数）的纵向位置。`lineAtY` 反过来。 */
export function yOfLine(lineCount: number, topOf: (i: number) => number, pos: number): number {
  if (lineCount <= 0) {
    return 0;
  }
  const p = clamp(pos, 0, lineCount);
  const i = Math.min(Math.floor(p), lineCount - 1);
  return lerp(topOf(i), topOf(i + 1), p - i);
}

/** 每一行开头在文字里的下标（`\n` 切）。 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/** 下标落在第几行（从 0 数）。 */
export function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
