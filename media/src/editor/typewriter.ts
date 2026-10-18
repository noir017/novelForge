/**
 * 打字机滚动（「视图 → 专注 → 打字机滚动」，开关在 `focus.ts`）：开着时，光标所在那一行始终停在编辑区垂直
 * 中间附近——打字、回车、撤销、方向键 / 翻页 / Home / End 移动之后，下一帧滚过去。
 *
 * - **光标的像素位置借高亮镜像层量**（`highlight.ts` 的 `measureOffset`：在那份看不见的镜像里排出光标之前的文字，
 *   量标记的 `offsetTop`）。不另起测量 DOM——另起一份就得再抄一遍排版，对不齐的地方会翻倍。量不了（文字超过
 *   30 万字、textarea 藏着）就不滚。该滚到哪是 `focusCore.ts` 的 `typewriterScrollTop`（纯函数）。
 * - **输入法组字中途不滚**：组字中的 `edit` 不带 `change`，不认；上屏那一下（带 `change`）才滚。方向键在组字中
 *   是挑候选词，`isImeComposing` 的也不认。
 * - **用滚轮翻看前文时不拉回来**：只对输入与键盘移动光标做反应，不听 `scroll`，也不听鼠标点击——翻上去看、
 *   点一下选个字都不动；下一次打字才回到光标那里。
 * - **只在焦点在这块正文里时滚**：磁盘上的新版就地换进来（程序改写）、别处触发的改写，光标并不在人眼前，不替他滚。
 * - 打开时 `<body>` 挂 `nf-typewriter`：编辑区底下多垫半屏（`--nf-ed-pad-bottom`，镜像层用同一个变量），
 *   最后一行也滚得到中间。
 */
import { isImeComposing, onEditorChange } from './api';
import type { Pane } from './api';
import { typewriterScrollTop } from './focusCore';
import { cancelFrame, measureOffset, nextFrame } from './highlight';
import { activePane } from './store';

/** 移动光标、之后要滚过去的键。 */
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/** 光标那一头（有选区时是正在拖的那一头）。 */
export function caretOf(area: HTMLTextAreaElement): number {
  return area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd;
}

export function installTypewriter(enabled: () => boolean): { refresh(): void } {
  const frames = new Map<Pane, number>();
  const hooked = new WeakSet<Pane>();

  function schedule(pane: Pane): void {
    if (frames.has(pane)) {
      return;
    }
    frames.set(
      pane,
      nextFrame(() => {
        frames.delete(pane);
        center(pane);
      })
    );
  }

  function center(pane: Pane): void {
    const area = pane.area;
    if (!enabled() || !pane.activeFile() || pane.isPreviewing() || document.activeElement !== area) {
      return;
    }
    const pos = measureOffset(pane, caretOf(area));
    if (!pos) {
      return;
    }
    const top = typewriterScrollTop(pos.top, pos.height, area.clientHeight, area.scrollTop);
    if (top !== undefined) {
      area.scrollTop = top;
    }
  }

  /** 每块编辑区第一次重画时挂上方向键那一下（两块共用这一份）。 */
  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    pane.area.addEventListener('keydown', (e) => {
      if (enabled() && !isImeComposing(e) && NAV_KEYS.has(e.key)) {
        // keydown 时光标还没动，下一帧（浏览器挪完光标之后）再量。
        schedule(pane);
      }
    });
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      return;
    }
    if (!enabled() || ev.file !== ev.pane.activeFile()) {
      return;
    }
    // 组字中途（拼音还没上屏）不带 change：不滚，上屏那一下再滚。
    if (ev.source === 'composition' && !ev.change) {
      return;
    }
    schedule(ev.pane);
  });

  return {
    refresh(): void {
      const on = enabled();
      document.body.classList.toggle('nf-typewriter', on);
      if (on && activePane) {
        schedule(activePane);
      } else if (!on) {
        for (const handle of frames.values()) {
          cancelFrame(handle);
        }
        frames.clear();
      }
    },
  };
}
