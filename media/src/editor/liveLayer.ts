/**
 * 跟着文字实时重算的高亮图层共用的那一套：写作体检的 `check`（`check.ts`）与名词高亮的 `names`（`nameMarks.ts`）。
 * 各层只说两件事——这份文件归不归它管（看后端给的 `kind`）、这份文字现在该画哪几段；什么时候重算、改了字之后
 * 画着的那几段怎么跟上、输入法组字中途怎么办、长文字怎么节流，都在这里，两层一个口径。
 *
 * ## 几万字的章节每敲一下也不卡
 *
 * 1. 找词由各层自己做（`locateTerms` 是一趟扫描，不是「词数 × 全文」），各层按「查过的是哪一份文字」缓存。
 * 2. 两万字以内（{@link LIVE_SYNC_LIMIT}）：改了字之后在**微任务**里重算（`highlight.ts` 的同步订阅先把各层平移完、
 *    压在改动上的丢掉，之后才轮到这里落新的一份；浏览器两次绘制之间只画一次）。更长的：至多每 300ms
 *    （{@link LIVE_RECHECK_MS}）重算一次（尾随），其间已经画着的那几段跟着改动平移（`highlight.ts` 自己做），
 *    只是新冒出来的词晚一点标出来。
 * 3. 重算的结果与镜像层上此刻画着的一模一样（多数按键都是这样）就不再画一遍。
 * 4. **输入法组字中途不重算**：拼音字母不该被当成英文词，计数也不该跟着拼音跳；已经画着的那几段按组字前后的文字差
 *    挪到新位置（`diffChange`），不乱跳。上屏（`compositionend`）之后再算。撤销 / 重做同样先挪、再算。
 *
 * 镜像层本身是各图层共用的（`highlight.ts`，按行分块、改一行只重排一行）；超过 30 万字不画，各层自己决定说不说。
 */
import { onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { diffChange, sameRanges, shiftRanges } from './checkCore';
import { clearHighlights, setHighlights } from './highlight';
import type { HighlightRange } from './highlight';
import type { TextChange } from './history';
import { panes } from './store';

/** 这么长以内的文字改了字就当场（微任务里）重算；更长的节流。与码字统计的 `SYNC_COUNT_LIMIT` 同一条线。 */
export const LIVE_SYNC_LIMIT = 20_000;
/** 长文字至多这么久重算一次。 */
export const LIVE_RECHECK_MS = 300;

/** 编辑区里显示的那一份（textarea 把 `\r\n` 归一成 `\n`，位置都按它算）。 */
export function shownText(file: OpenFile): string {
  return file.draft.includes('\r') ? file.draft.replace(/\r\n?/g, '\n') : file.draft;
}

export interface LiveLayerSpec {
  /** 高亮镜像层上的图层名。 */
  layer: string;
  /** 这份文件归不归这一层管。不归的不算、画着的清掉。看后端给的 `kind`，前端不拿路径猜。 */
  applies(file: OpenFile): boolean;
  /** 这份文字现在该画的那几段（只对归它管的文件调；不画就给空数组）。 */
  ranges(file: OpenFile, text: string): HighlightRange[];
  /** 每算完一次（含当前文件不归它管、什么都不画的时候）。 */
  checked?(pane: Pane): void;
  /** `render` 时文件、种类、文字都没变（保存回执、切标签条之类）。 */
  rendered?(pane: Pane): void;
}

export interface LiveLayer {
  /** 现在就按当前文字重算、重画（不节流）。 */
  checkNow(pane: Pane): void;
  /** 两块编辑区都当场重算（词表、偏好变了）。`force`：与画着的一样也重画一遍。 */
  recheckAll(force?: boolean): void;
  /** 这块编辑区正在输入法组字。 */
  composing(pane: Pane): boolean;
}

interface PaneState {
  /** 下面几样是给哪个文件记的。当前路径变了就作废（`highlight.ts` 换文件时清掉所有图层）。 */
  path: string | null;
  /** 镜像层这一层上此刻画着的那几段（照 `highlight.ts` 的规则跟着改动平移）。 */
  painted: HighlightRange[];
  /** `painted` 对应的是哪一份文字。 */
  text: string;
  /** 镜像层上那一份与 `painted` 对不上了（撤销、组字中途、上屏：`highlight.ts` 没平移或平移的不是这一份），下次必须重画。 */
  dirty: boolean;
  /** 输入法组字中。 */
  composing: boolean;
  /** 上一次算的时候当前文件归不归这一层（保存回执换了 `kind` 时据此重算）。 */
  applies: boolean;
  /** 长文字的节流。 */
  timer?: ReturnType<typeof setTimeout>;
  checkedAt: number;
}

export function createLiveLayer(spec: LiveLayerSpec): LiveLayer {
  const states = new Map<Pane, PaneState>();

  function stateOf(pane: Pane): PaneState {
    let st = states.get(pane);
    if (!st) {
      st = { path: pane.activePath, painted: [], text: '', dirty: false, composing: false, applies: false, checkedAt: 0 };
      states.set(pane, st);
    }
    return st;
  }

  function clearTimer(st: PaneState): void {
    if (st.timer !== undefined) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
  }

  /** 把 `want` 画到这一层上（与此刻画着的一样、又没弄脏就不画）。 */
  function paint(pane: Pane, st: PaneState, want: HighlightRange[], text: string): void {
    st.text = text;
    if (!st.dirty && sameRanges(st.painted, want)) {
      return;
    }
    if (want.length > 0) {
      setHighlights(pane, spec.layer, want);
    } else {
      clearHighlights(pane, spec.layer);
    }
    st.painted = want;
    st.dirty = false;
  }

  function checkNow(pane: Pane): void {
    const st = stateOf(pane);
    clearTimer(st);
    st.checkedAt = Date.now();
    if (st.path !== pane.activePath) {
      resetFor(pane, st);
    }
    const file = pane.activeFile();
    st.applies = !!file && spec.applies(file);
    const text = file ? shownText(file) : '';
    paint(pane, st, file && st.applies ? spec.ranges(file, text) : [], text);
    spec.checked?.(pane);
  }

  /** 只把已经挪过位置的那几段画上去（组字中途、长文字节流的空档里），不重算。 */
  function displayNow(pane: Pane): void {
    const st = stateOf(pane);
    if (st.dirty && st.path === pane.activePath) {
      paint(pane, st, st.painted, st.text);
    }
  }

  /** 换了文件：镜像层那边已经（或马上就会）清掉所有图层。 */
  function resetFor(pane: Pane, st: PaneState): void {
    clearTimer(st);
    st.path = pane.activePath;
    st.painted = [];
    const file = pane.activeFile();
    st.text = file ? shownText(file) : '';
    st.dirty = false;
  }

  /** 同一轮里攒着要做的：`check` 重算（盖过 `display`）、`display` 只画挪过位置的那几段。 */
  const pending = new Map<Pane, 'check' | 'display'>();

  function soon(pane: Pane, kind: 'check' | 'display'): void {
    if (pending.size === 0) {
      queueMicrotask(() => {
        const list = [...pending];
        pending.clear();
        for (const [p, k] of list) {
          if (k === 'check') {
            checkNow(p);
          } else {
            displayNow(p);
          }
        }
      });
    }
    if (pending.get(pane) !== 'check') {
      pending.set(pane, kind);
    }
  }

  /** 改了字之后什么时候重算（见文件头「几万字的章节每敲一下也不卡」）。 */
  function schedule(pane: Pane, st: PaneState, length: number): void {
    if (st.composing) {
      if (st.dirty) {
        soon(pane, 'display');
      }
      return;
    }
    if (length <= LIVE_SYNC_LIMIT) {
      soon(pane, 'check');
      return;
    }
    if (st.dirty) {
      soon(pane, 'display');
    }
    if (st.timer === undefined) {
      st.timer = setTimeout(
        () => {
          st.timer = undefined;
          checkNow(pane);
        },
        Math.max(0, st.checkedAt + LIVE_RECHECK_MS - Date.now())
      );
    }
  }

  /** 一处改动之后：先让「此刻画着的」跟上，再安排重算。 */
  function onEdit(pane: Pane, file: OpenFile, change: TextChange | undefined): void {
    const st = stateOf(pane);
    if (!spec.applies(file) && !st.applies && st.painted.length === 0) {
      // 不归这一层管：什么都没画，也不用算（几 MB 的 json 每敲一下不必过这一趟）。
      return;
    }
    if (st.path !== pane.activePath) {
      resetFor(pane, st);
      schedule(pane, st, file.draft.length);
      return;
    }
    const after = shownText(file);
    if (
      change &&
      !st.composing &&
      st.text.length - change.removed.length + change.inserted.length === after.length &&
      st.text.slice(change.at, change.at + change.removed.length) === change.removed
    ) {
      // 与 highlight.ts 平移图层同一条规则：它那一份与这里记的仍然一样，不必重画。
      st.painted = shiftRanges(st.painted, change);
    } else {
      // 撤销 / 重做、组字中途、上屏（改动是对着组字之前那一份算的）：按前后文字差挪，镜像层那一份必须重画。
      const d = diffChange(st.text, after);
      if (d) {
        st.painted = shiftRanges(st.painted, d);
      }
      st.dirty = true;
    }
    st.text = after;
    schedule(pane, st, after.length);
  }

  const hooked = new WeakSet<Pane>();

  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    pane.area.addEventListener('compositionstart', () => {
      stateOf(pane).composing = true;
    });
    // pane.ts 自己的 compositionend 先跑（它先挂），上屏那一下的 `edit` 已经发过了；这里收尾、安排重算。
    pane.area.addEventListener('compositionend', () => {
      const st = stateOf(pane);
      st.composing = false;
      const file = pane.activeFile();
      if (file) {
        schedule(pane, st, file.draft.length);
      }
    });
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      const pane = ev.pane;
      hook(pane);
      const st = stateOf(pane);
      const file = pane.activeFile();
      if (st.path !== pane.activePath) {
        // 换了文件、关了标签：当场按新文件画（各层有缓存的不重找）。
        resetFor(pane, st);
        checkNow(pane);
      } else if ((!!file && spec.applies(file)) !== st.applies) {
        // 同一个文件换了 `kind`（保存回执带来的）：归不归这一层变了，重算。
        checkNow(pane);
      } else if (file && st.text !== shownText(file)) {
        // 同一个文件、文字却换了（没改过的标签被磁盘上的新版换掉）：先挪、再算。
        onEdit(pane, file, undefined);
      } else {
        spec.rendered?.(pane);
      }
      return;
    }
    if (ev.file === ev.pane.activeFile()) {
      onEdit(ev.pane, ev.file, ev.change);
    }
  });

  for (const pane of Object.values(panes)) {
    if (pane) {
      hook(pane);
    }
  }

  return {
    checkNow,
    recheckAll(force = false) {
      for (const pane of Object.values(panes)) {
        if (pane) {
          if (force) {
            stateOf(pane).dirty = true;
          }
          checkNow(pane);
        }
      }
    },
    composing: (pane) => stateOf(pane).composing,
  };
}
