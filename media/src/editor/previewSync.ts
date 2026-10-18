/**
 * 切预览 / 切回编辑时两边滚到同一处（`pane.ts` 的 `setPreviewing` 用）。换算是纯函数（`previewCore.ts`），这里只量：
 *
 * - **编辑区**：第 i 行的顶借高亮镜像层量（`highlight.ts` 的 `measureOffset`，与打字机滚动、名词补全同一个办法，
 *   不另起测量 DOM），二分找视口顶上那一行，只量 log₂(行数) 次。中文一段就是一行、能折成好几行，所以位置带小数：
 *   滚到一段中间时，预览里也滚到那一段的中间。
 * - **预览**：`renderPreview` 给每一块记了 `data-line` / `data-line-end`，量这几块相对预览内容顶上的位置。
 *
 * 量不了（文字超过 `HIGHLIGHT_LIMIT`、没有排版——比如 jsdom）时退回按比例：位置 = 滚过的比例 × 行数。
 */
import { measureOffset } from './highlight';
import type { Pane } from './store';
import { lineAtY, lineStarts, previewYToSource, sourceToPreviewY, yOfLine } from './previewCore';
import type { BlockBox } from './previewCore';

/** 编辑区里一行一行的顶（从第 0 行的顶算）。量过的记下来，一次切换里不重量。量不了返回 undefined。 */
function areaTops(pane: Pane): { count: number; topOf: (i: number) => number } | undefined {
  const text = pane.area.value;
  const starts = lineStarts(text);
  const count = starts.length;
  const first = measureOffset(pane, 0);
  if (!first) {
    return undefined;
  }
  const cache = new Map<number, number>([[0, 0]]);
  let broken = false;
  const topOf = (i: number): number => {
    const hit = cache.get(i);
    if (hit !== undefined) {
      return hit;
    }
    let top: number;
    if (i >= count) {
      // 最后一行的底：最后一行的顶 + 它的行高（空的最后一行量的是零宽空格，行高照样有）。
      const last = measureOffset(pane, starts[count - 1]);
      top = last ? last.top + last.height - first.top : 0;
    } else {
      const m = measureOffset(pane, starts[i]);
      top = m ? m.top - first.top : 0;
    }
    if (!Number.isFinite(top)) {
      broken = true;
      top = 0;
    }
    cache.set(i, top);
    return top;
  };
  // 没有排版（每一行都量出 0）时只会把人带到最后一行——当量不了。
  if (count > 1 && topOf(count) <= 0) {
    return undefined;
  }
  return broken ? undefined : { count, topOf };
}

/** 按比例：滚过的比例 × 行数。 */
function proportional(scrollTop: number, scrollHeight: number, clientHeight: number, count: number): number {
  const range = scrollHeight - clientHeight;
  return range > 0 ? (Math.max(0, scrollTop) / range) * count : 0;
}

/** 编辑区视口顶上是第几行（带小数）。 */
export function areaTopLine(pane: Pane): number {
  const area = pane.area;
  const tops = areaTops(pane);
  if (!tops) {
    return proportional(area.scrollTop, area.scrollHeight, area.clientHeight, lineStarts(area.value).length);
  }
  return lineAtY(tops.count, tops.topOf, area.scrollTop);
}

/**
 * 要让第 `pos` 行（带小数）停在编辑区视口顶上，`scrollTop` 该是多少，那时视口里是从第几行到第几行（带小数；量不了时
 * 按比例估）。只量不滚：调用方先落光标（看它还在不在视口里），再滚——落选区时浏览器可能自己把光标滚进视野。
 */
export function areaScrollForLine(pane: Pane, pos: number): { scrollTop: number; top: number; bottom: number } {
  const area = pane.area;
  const tops = areaTops(pane);
  if (!tops) {
    const count = lineStarts(area.value).length;
    const range = area.scrollHeight - area.clientHeight;
    const scrollTop = range > 0 ? Math.round((pos / Math.max(1, count)) * range) : 0;
    const top = proportional(scrollTop, area.scrollHeight, area.clientHeight, count);
    const visible = area.scrollHeight > 0 ? (area.clientHeight / area.scrollHeight) * count : count;
    return { scrollTop, top, bottom: top + visible };
  }
  const scrollTop = Math.max(0, Math.round(yOfLine(tops.count, tops.topOf, pos)));
  return {
    scrollTop,
    top: lineAtY(tops.count, tops.topOf, scrollTop),
    bottom: lineAtY(tops.count, tops.topOf, scrollTop + area.clientHeight),
  };
}

/** 预览里每一块的位置（相对预览内容的最顶上）。全是 0（没有排版）时返回空。 */
function previewBoxes(preview: HTMLElement): BlockBox[] {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;
  const boxes: BlockBox[] = [];
  let any = false;
  for (const node of preview.querySelectorAll<HTMLElement>('[data-line]')) {
    const start = Number(node.dataset.line);
    const end = Number(node.dataset.lineEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    any ||= rect.height > 0;
    boxes.push({ start, end, top: rect.top - base, height: rect.height });
  }
  return any ? boxes : [];
}

/** 预览视口顶上对着源文件第几行（带小数）。 */
export function previewTopLine(preview: HTMLElement, lineCount: number): number {
  const boxes = previewBoxes(preview);
  if (boxes.length === 0) {
    return proportional(preview.scrollTop, preview.scrollHeight, preview.clientHeight, lineCount);
  }
  return previewYToSource(boxes, preview.scrollTop);
}

/** 把预览滚到让源文件第 `pos` 行（带小数）对应的那一处停在视口顶上。 */
export function scrollPreviewToLine(preview: HTMLElement, pos: number, lineCount: number): void {
  const boxes = previewBoxes(preview);
  if (boxes.length === 0) {
    const range = preview.scrollHeight - preview.clientHeight;
    preview.scrollTop = range > 0 ? Math.round((pos / Math.max(1, lineCount)) * range) : 0;
    return;
  }
  preview.scrollTop = Math.max(0, Math.round(sourceToPreviewY(boxes, pos)));
}
