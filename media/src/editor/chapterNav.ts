/**
 * 上一章 / 下一章（章节条上的「‹ 上一章」「下一章 ›」，快捷键 Alt+PageUp / Alt+PageDown，⚑）。
 *
 * - **顺序按章号**（章节索引的顺序，第 8 条）。到头了章节条上的按钮禁用、快捷键说一句。
 * - **哪一面跟哪一面**：当前标签是正文就换成相邻那一章的正文，是细纲就换成相邻那一章的细纲。
 * - **没改过就在原位置换掉，改过就另开一个标签**：打开请求带 `replace`（后端原样带回），编辑区收到时再看一眼
 *   那一份还是不是没改过（`pane.ts` 的 `slotFor`）。
 * - **配对的那一份跟着走**：另一块编辑区正开着这一章的配对文件（正文 ↔ 细纲）时，同样换成相邻那一章的配对文件，
 *   规矩一样；它不抢焦点（`quietOpen`）——作者的光标留在他按键的那一块。
 * - **相邻那一章还没有这一面**（没写正文、没排细纲）：照实说一句，不开一个不存在的文件。
 *
 * 快捷键的取舍（⚑）：浏览器保留了 Ctrl+PageUp/PageDown（切浏览器标签页）、Alt+←/→（前进后退），编辑器自己的
 * Alt+↑/↓、Shift+Alt+↑/↓ 是段落快捷键；Alt+PageUp/PageDown 这几处都没占，「翻页」的意思也对得上「翻一章」。
 */
import { toast } from '../globals';
import type { ChapterIndexEntry, InMessage } from '../protocol';
import { isImeComposing } from './api';
import { SIDE_LABEL, chapterAt, chapterIndex, flipSide, pathOn } from './chapterIndex';
import type { ChapterSide } from './chapterIndex';
import type { Pane } from './store';
import { activePane, otherPane, paneOwning } from './store';

let post: (msg: InMessage) => void = () => {};

/** 配对那一份的打开请求：它到了不抢「当前是哪一块」（`index.ts` 收 `editorOpen` 时问）。 */
const quiet = new Set<string>();

export function takeQuietOpen(pane: string, path: string): boolean {
  return quiet.delete(`${pane}:${path}`);
}

/** 当前文件是哪一章的哪一面，前后各是哪一章。不是某一章的正文或细纲时 undefined。 */
export function neighborsOf(path: string | null | undefined):
  | { entry: ChapterIndexEntry; side: ChapterSide; prev?: ChapterIndexEntry; next?: ChapterIndexEntry }
  | undefined {
  const at = path ? chapterAt(path) : undefined;
  if (!at) {
    return undefined;
  }
  const list = chapterIndex();
  return { entry: at.entry, side: at.side, prev: list[at.index - 1], next: list[at.index + 1] };
}

/** 往前（-1）或往后（1）一章。 */
export function goChapter(step: -1 | 1): void {
  const pane = activePane;
  const file = pane?.activeFile();
  const around = neighborsOf(file?.path);
  if (!pane || !file || !around) {
    return;
  }
  const next = step < 0 ? around.prev : around.next;
  if (!next) {
    toast(step < 0 ? '已经是第一章了。' : '已经是最后一章了。');
    return;
  }
  const target = pathOn(next, around.side);
  if (!target) {
    toast(`${next.label}还没有${SIDE_LABEL[around.side]}。`);
    return;
  }

  // 配对的那一份先发：它不抢焦点，这一块的那一份后到也好、先到也好，当前的都是这一块。
  const other = otherPane(pane);
  const pairSide = flipSide(around.side);
  const pair = pathOn(around.entry, pairSide);
  let note = '';
  if (other && pair && other.files.has(pair)) {
    const pairTarget = pathOn(next, pairSide);
    if (pairTarget) {
      open(other, pair, pairTarget, true);
    } else {
      note = `${next.label}还没有${SIDE_LABEL[pairSide]}，旁边那一份没换。`;
    }
  }
  open(pane, file.path, target, false);
  if (note) {
    toast(note);
  }
}

/** 在这一块里从 `from` 换到 `to`：已经开着就切过去，否则请后端打开（没改过就原位换掉）。 */
function open(pane: Pane, from: string, to: string, background: boolean): void {
  if (paneOwning(to) === pane) {
    pane.activate(to, { focus: !background });
    return;
  }
  const old = pane.files.get(from);
  const clean = !!old && old.draft === old.text;
  if (background) {
    quiet.add(`${pane.id}:${to}`);
  }
  post({ type: 'openEditor', path: to, pane: pane.id, ...(clean ? { replace: from } : {}) });
}

/** 装快捷键。焦点在编辑器之外的输入框（对话输入框之类）里不拦。 */
export function installChapterNav(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }
    if (e.key !== 'PageUp' && e.key !== 'PageDown') {
      return;
    }
    const focus = document.activeElement;
    const inEditor = !!focus?.closest?.('.wb-editors');
    const typing = focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement || (focus as HTMLElement | null)?.isContentEditable;
    if (typing && !inEditor) {
      return;
    }
    if (!neighborsOf(activePane?.activeFile()?.path)) {
      return;
    }
    e.preventDefault();
    goChapter(e.key === 'PageUp' ? -1 : 1);
  });
}
