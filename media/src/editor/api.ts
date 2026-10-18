/**
 * 编辑区的公共接口：给编辑器里的功能模块（缩进、回车自动缩进、成对标点、一键排版、
 * 查找替换……）用。这些模块**只经这里与 `Pane` 上的方法**碰编辑区，不去读 `pane.ts` 的内部状态。
 *
 * ## 三条硬规矩（`media/README.md`「内置编辑器的行为约束」同一份）
 *
 * 1. **程序改写只走 `Pane.applyEdit`**。不许直接写 `textarea.value`，也不要 `setRangeText` /
 *    `execCommand('insertText')`。绕过它的改动不进撤销记录（下一次 Ctrl+Z 核对不上，整份历史作废），
 *    脏标记、状态栏、标签圆点、草稿持久化也都不会跟着更新。
 * 2. **keydown 先过 `isImeComposing(e)`**：输入法组字时的 Tab、回车、Ctrl 组合键一律放行给输入法。
 *    用 `addKeyHandler` 挂的处理函数已经替你过了这一道。
 * 3. **正文与否看 `isProse(file)`**：后端给的 `kind`（`chapter` / `draft`），前端不拿路径或扩展名猜。
 *
 * ## 用法
 *
 * ```ts
 * import { activeEditor, addKeyHandler, indentUnit, onEditorChange } from './api';
 *
 * // 回车自动缩进：返回 true 表示这一下归我处理（pane 替你 preventDefault，后面的处理函数不再收到）。
 * addKeyHandler((e, { pane, file, area }) => {
 *   if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
 *   pane.applyEdit(area.selectionStart, area.selectionEnd, '\n' + indentUnit(file));
 *   return true;
 * });
 *
 * // 菜单里的「一键排版」：整份换掉也只记一步撤销。
 * const ed = activeEditor();
 * if (ed) ed.pane.applyEdit(0, ed.area.value.length, layout(ed.area.value));
 *
 * // 查找高亮：内容一变、换了文件就重画。
 * onEditorChange((ev) => redrawHighlights(ev.pane));
 * ```
 */
import type { TextChange, TextSelection } from './history';
import type { OpenFile } from './paneElements';
import { activePane, panes } from './store';
import type { Pane } from './store';

export type { TextChange, TextSelection } from './history';
export type { OpenFile } from './paneElements';
export type { ApplyEditOptions, Pane } from './store';

/** 一块编辑区、它当前开着的文件、它的 textarea。 */
export interface EditorContext {
  pane: Pane;
  file: OpenFile;
  /** 只读它的 `value` / `selectionStart` / `selectionEnd`；要改内容走 `pane.applyEdit`。 */
  area: HTMLTextAreaElement;
}

/** 这一块编辑区当前的文件与 textarea。没开文件时 undefined。 */
export function editorOf(pane: Pane | undefined): EditorContext | undefined {
  const file = pane?.activeFile();
  return pane && file ? { pane, file, area: pane.area } : undefined;
}

/**
 * 当前激活的那块编辑区（最后被点 / 被聚焦的那一块，`Ctrl+S` 保存的就是它）+ 它当前的文件 +
 * 它的 textarea。没开文件时 undefined。预览模式下照样返回（`applyEdit` 在预览里也能用，
 * 预览会跟着重画），要区分就看 `pane.isPreviewing()`。
 */
export function activeEditor(): EditorContext | undefined {
  return editorOf(activePane);
}

/**
 * 这份文件是不是正文（章节或它的草稿）。看后端给的 `kind`；没给（没打开工程、旧数据）当非正文。
 */
export function isProse(file: Pick<OpenFile, 'kind'> | undefined): boolean {
  return file?.kind === 'chapter' || file?.kind === 'draft';
}

/** 正文的一级缩进：两个全角空格。 */
export const PROSE_INDENT = '　　';
/** 其余文件（角色卡、细纲、设定等 Markdown，以及 json / yml）的一级缩进：两个半角空格。 */
export const PLAIN_INDENT = '  ';

/** 这份文件的一级缩进。 */
export function indentUnit(file: Pick<OpenFile, 'kind'> | undefined): string {
  return isProse(file) ? PROSE_INDENT : PLAIN_INDENT;
}

/**
 * 这一下按键是不是输入法组字中途（拼音还没上屏）。是就什么都别做，原样放行给输入法——
 * 组字时的回车是「把拼音当英文上屏」、Tab / 方向键是在候选词之间挪，拦下来就把输入法弄坏了。
 * `keyCode === 229` 是老版 Chrome / Safari 在组字时给的值（那时还没有 `isComposing`）。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

// ---------------------------------------------------------------- 按键

/**
 * 编辑区 keydown 的处理函数。返回 true 表示「这一下归我」：pane 替你 `preventDefault()`，
 * 之后的处理函数与内置的 Tab 缩进都不再收到。
 */
export type KeyHandler = (e: KeyboardEvent, ctx: EditorContext) => boolean;

const keyHandlers: KeyHandler[] = [];

/**
 * 挂一个编辑区 keydown 处理函数，两块编辑区共用。返回取消挂载的函数。
 *
 * 顺序：输入法组字中途的按键根本不会送来（`isImeComposing`）→ 撤销 / 重做（`Ctrl+Z` / `Ctrl+Y` /
 * `Ctrl+Shift+Z`，不可覆盖）→ 这里挂的函数，按挂载顺序 → 内置的 Tab / Shift+Tab 缩进
 * （想改 Tab 的行为就在这里先接走）。预览模式下 textarea 是藏着的，收不到按键。
 */
export function addKeyHandler(handler: KeyHandler): () => void {
  keyHandlers.push(handler);
  return () => {
    const i = keyHandlers.indexOf(handler);
    if (i >= 0) {
      keyHandlers.splice(i, 1);
    }
  };
}

/** pane.ts 用：依次交给挂上来的处理函数，有一个接走就停。 */
export function runKeyHandlers(e: KeyboardEvent, ctx: EditorContext): boolean {
  for (const handler of [...keyHandlers]) {
    if (handler(e, ctx)) {
      return true;
    }
  }
  return false;
}

/** 事件目标落在哪一块编辑区里（查找条、预览也算在那一块里）。 */
export function paneContaining(target: EventTarget | null): Pane | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  return Object.values(panes).find((p) => p.root.contains(target));
}

/** 别的输入框（对话输入框、下拉框、可编辑区）——编辑区之外的快捷键在那里不该抢。 */
export function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * 「编辑区里或页面上」那一档快捷键（`shortcuts.ts` 的 `workbench`：查找、F3、预览……）这一下该给哪块编辑区：
 * 焦点在某块里就是那一块；焦点在编辑区之外的输入框 / 文本框（左侧对话输入框之类）时谁都不给，留给浏览器；
 * 其余（焦点在页面上、按钮上）给当前那一块。那一块没开文件也不给。
 */
export function paneForShortcut(e: KeyboardEvent): Pane | undefined {
  const inside = paneContaining(e.target);
  const pane = inside ?? (isTextField(e.target) ? undefined : activePane);
  return pane?.activeFile() ? pane : undefined;
}

// ---------------------------------------------------------------- 变化通知

/**
 * 内容是怎么变的：`typing` 连续打字 / 删除，`input` 其余的原生输入（粘贴、拖放、剪切），
 * `composition` 输入法上屏，`program` 经 `applyEdit` 的程序改写（含「还原」「用磁盘版本覆盖」），
 * `completion` 作者在名词补全里挑了一个名字（也经 `applyEdit`，带 `opts.source`；码字统计当作者打的字算，
 * 见 `writingStats.ts`），`undo` / `redo` 撤销与重做。
 */
export type EditSource = 'typing' | 'input' | 'composition' | 'program' | 'completion' | 'undo' | 'redo';

export type EditorEvent =
  /**
   * 某块编辑区里某份文件的内容变了（已经写进 `file.draft`，若是当前文件也已写进 textarea）。
   * `change` 是这一处改动（位置按改动之前的文字算）；撤销 / 重做可能一次退好几处，不给。
   * 输入法组字中途（拼音还没上屏）也会发 `source: 'composition'` 好让显示跟上，但**不带 `change`**；
   * 上屏的那一下才带——要对「用户刚输入了什么」做反应（例如成对标点）的，只认带 `change` 的。
   */
  | { type: 'edit'; pane: Pane; file: OpenFile; source: EditSource; change?: TextChange }
  /** 这块编辑区重画了：换了文件、开 / 关了标签、切了预览、保存回执到了……当前文件取 `editorOf(pane)`。 */
  | { type: 'render'; pane: Pane };

const listeners = new Set<(ev: EditorEvent) => void>();

/** 订阅编辑区的变化。返回取消订阅的函数。 */
export function onEditorChange(fn: (ev: EditorEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** pane.ts 用。某个订阅者炸了不连累编辑器本身与其他订阅者。 */
export function emitEditorChange(ev: EditorEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(ev);
    } catch (err) {
      console.error(err);
    }
  }
}

/** 选区夹进 `[0, length]`，并保证 `start ≤ end`。 */
export function clampSelection(sel: TextSelection, length: number): TextSelection {
  const a = Math.max(0, Math.min(length, Math.floor(sel.start)));
  const b = Math.max(0, Math.min(length, Math.floor(sel.end)));
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}
