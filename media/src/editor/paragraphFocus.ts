/**
 * 段落聚焦（「视图 → 专注 → 段落聚焦」，开关在 `focus.ts`）：光标所在那一段照常显示，其余的变淡。只对正文
 * （`isProse`：章节与草稿）——分段是按工程的分段格式认的（`focusCore.ts` 的 `paragraphRangeAt`），那是正文的设置。
 *
 * ## 做法（⚑）
 *
 * textarea 只有一种文字颜色，画不出「这一段深、别处淡」。于是：
 *
 * 1. textarea 的字整体调淡（`.ed-area.ed-para-dim`：前景色 × 30% 的**半透明**色，光标颜色不变）；
 * 2. 高亮镜像层开一个命名图层 `focus`（`setHighlights`，**不另起一层镜像**），把当前那一段包进
 *    `<mark class="ed-hl-focus">`，这一层的 `<mark>` 用**实色**画字（`highlight.css`）——镜像层在 textarea 底下，
 *    同一个位置、同一个字形，半透明的淡字叠在实色字上看起来就是实色，别处只有淡字。
 *
 * 光标、选区、输入法、点击、右键仍然全是 textarea 自己的，一样都不受影响。代价：
 *
 * - 当前那一段画了两遍（淡的叠在实的上面），笔画边缘略重一点；镜像层万一与 textarea 差了半个像素，这一段会有
 *   一点重影（其余段落不受影响）。镜像层与 textarea 读同一组排版变量、每次重画都抄计算样式，正是为了不差。
 * - 镜像层每次改动都要重画一遍全文（查找开着时本来也是这样）。超过 30 万字不画——那时**不调淡**，整篇照常显示，
 *   不会出现「全是淡字」。
 *
 * 另一条路是 textarea 文字全透明、由镜像层画全部文字：那样光标会画在一层看不见的字上、输入法组字时的拼音也是
 * 透明的，对不齐时光标与字错位——代价大得多，不取。
 *
 * ## 什么时候重算
 *
 * - 改了字（`edit`，含组字中途）：等这一下的同步订阅都跑完（`highlight.ts` 会先把各层平移、压在改动上的丢掉），
 *   在微任务里按新文字重算并 `setHighlights`——当场重画，浏览器两次绘制之间只画一次，不闪。
 * - 光标挪了（键盘、鼠标、`selectionchange`）：段落变了才重画。
 * - 换了文件、切了预览（`render`）：重算。
 */
import { isProse, onEditorChange } from './api';
import type { Pane } from './api';
import { paragraphRangeAt } from './focusCore';
import type { TextRange } from './focusCore';
import { clearHighlights, setHighlights, tooLargeToHighlight } from './highlight';
import { paragraphStyle } from './paragraphState';
import { panes } from './store';
import { caretOf } from './typewriter';

/** 高亮镜像层上的图层名与那一段 `<mark>` 的 class。 */
export const FOCUS_LAYER = 'focus';
const CLS_FOCUS = 'ed-hl-focus';
/** textarea 上的字调淡。 */
const CLS_DIM = 'ed-para-dim';

export function installParagraphFocus(enabled: () => boolean): { refresh(): void } {
  /** 每块编辑区上一次画的是哪个文件的哪一段。 */
  const drawn = new Map<Pane, { path: string; range: TextRange }>();
  const hooked = new WeakSet<Pane>();
  const pending = new Set<Pane>();

  function applies(pane: Pane): boolean {
    const file = pane.activeFile();
    return enabled() && !!file && isProse(file) && !pane.isPreviewing() && !tooLargeToHighlight(pane.area.value);
  }

  function off(pane: Pane): void {
    pane.area.classList.remove(CLS_DIM);
    if (drawn.delete(pane)) {
      clearHighlights(pane, FOCUS_LAYER);
    }
  }

  /** 按光标重算这一块的当前段。`force`：图层可能已经被平移 / 丢掉了（改过字），照画不误。 */
  function update(pane: Pane, force = false): void {
    if (!applies(pane)) {
      off(pane);
      return;
    }
    const area = pane.area;
    const path = pane.activePath!;
    const range = paragraphRangeAt(area.value, caretOf(area), paragraphStyle());
    const prev = drawn.get(pane);
    if (!force && prev && prev.path === path && prev.range.start === range.start && prev.range.end === range.end) {
      return;
    }
    drawn.set(pane, { path, range });
    setHighlights(pane, FOCUS_LAYER, [{ start: range.start, end: range.end, cls: CLS_FOCUS }]);
    area.classList.add(CLS_DIM);
  }

  /** 这一下的同步订阅都跑完之后再算（`highlight.ts` 先平移各层，之后才轮到这里落新的一段）。 */
  function updateSoon(pane: Pane): void {
    if (pending.size === 0) {
      queueMicrotask(() => {
        const list = [...pending];
        pending.clear();
        for (const p of list) {
          update(p, true);
        }
      });
    }
    pending.add(pane);
  }

  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    const onCaret = (): void => {
      if (enabled()) {
        update(pane);
      }
    };
    for (const evt of ['keyup', 'mouseup', 'select', 'focus'] as const) {
      pane.area.addEventListener(evt, onCaret);
    }
  }

  // 光标挪了（按住方向键时一路都有）：textarea 有焦点时 document 上的 selectionchange 就是它的。
  document.addEventListener('selectionchange', () => {
    if (!enabled()) {
      return;
    }
    const pane = Object.values(panes).find((p) => p.area === document.activeElement);
    if (pane) {
      update(pane);
    }
  });

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      const prev = drawn.get(ev.pane);
      // 换了文件：镜像层已经把上一个文件的图层全清了，照画；同一个文件只在段落变了时重画。
      update(ev.pane, !!prev && prev.path !== ev.pane.activePath);
      return;
    }
    if (enabled() && ev.file === ev.pane.activeFile()) {
      updateSoon(ev.pane);
    }
  });

  return {
    refresh(): void {
      for (const pane of Object.values(panes)) {
        if (enabled()) {
          update(pane, true);
        } else {
          off(pane);
        }
      }
    },
  };
}
