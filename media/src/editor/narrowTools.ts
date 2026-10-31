/**
 * 窄屏上编辑区顶上只留两行：标签条与章节条（样式在 narrow.css）。
 *
 * - 工具栏那一行收起，它的按钮挪进标签条末尾的「⋯」，外加一项「补全名词」（电脑上是 Alt+/）；
 *   「⋯」前面单留「↶」「↷」「保存」三颗（手机键盘上没有 Ctrl+Z / Ctrl+S，自动保存缺省关）。
 *   这三颗按下去不夺焦点：正在打字时点了，软键盘不收、光标还在原处。
 * - 章节条底下那一排动作（写这一章、接着写……）收进条上的「操作 ▾」（`chapterBar.ts` 挂）。
 *
 * 菜单项照着那几颗按钮现列：字、亮灭跟着按钮走，点了就是点那颗按钮——按钮以后增减、改名不用改这里。
 * 宽屏上这几颗不显示，工具栏照旧。
 */
import { el } from '../dom';
import { commandNames, showMenuAt } from '../globals';
import type { MenuItem } from '../globals';
import { touchDevice } from '../touch';
import { onEditorChange } from './api';
import type { PaneRefs } from './paneElements';
import type { Pane } from './store';

/** 一组按钮列成菜单：藏着的不列，置灰的照样置灰。菜单上要多写几个字（调用次数）的按钮带 `data-menu-label`。 */
export function menuFromButtons(buttons: Iterable<HTMLButtonElement>): MenuItem[] {
  const items: MenuItem[] = [];
  for (const b of buttons) {
    if (b.classList.contains('hidden') || b.hidden) {
      continue;
    }
    items.push({ label: b.dataset.menuLabel ?? b.textContent ?? '', disabled: b.disabled, run: () => b.click() });
  }
  return items;
}

/**
 * 在 `anchor` 底下弹菜单；菜单开着时再点它就收起（这一下点击冒到 document 上去收，与标签条的「▾」一样）。
 * 返回装好监听的按钮。
 */
export function menuButton(anchor: HTMLButtonElement, items: () => MenuItem[]): HTMLButtonElement {
  let menu: HTMLElement | undefined;
  anchor.addEventListener('click', (e) => {
    if (menu?.isConnected) {
      menu = undefined;
      return;
    }
    e.stopPropagation();
    const rect = anchor.getBoundingClientRect();
    menu = showMenuAt(items(), rect.right, rect.bottom);
  });
  return anchor;
}

/** 按下去不夺焦点的按钮（正在打字时点了，软键盘不收）。 */
function keepFocus(btn: HTMLButtonElement): HTMLButtonElement {
  btn.type = 'button';
  for (const type of ['pointerdown', 'mousedown'] as const) {
    btn.addEventListener(type, (e) => e.preventDefault());
  }
  return btn;
}

/** 标签条末尾的「↶」「↷」「保存」与「⋯」。 */
export function installNarrowTools(refs: PaneRefs, pane: Pane): void {
  const undo = keepFocus(el('button', 'ed-tabs-icon ed-tabs-undo', '↶'));
  undo.title = '撤销';
  undo.setAttribute('aria-label', '撤销');
  undo.addEventListener('click', () => pane.undo());
  const redo = keepFocus(el('button', 'ed-tabs-icon ed-tabs-redo', '↷'));
  redo.title = '重做';
  redo.setAttribute('aria-label', '重做');
  redo.addEventListener('click', () => pane.redo());
  // 能不能撤销看当前那份文件自己的记录：打字、撤销、切文件之后都对一次。
  const syncHistory = () => {
    const history = pane.activeFile()?.history;
    undo.disabled = !history?.canUndo;
    redo.disabled = !history?.canRedo;
  };
  onEditorChange((ev) => {
    if (ev.pane === pane) {
      syncHistory();
    }
  });

  const save = keepFocus(el('button', 'primary ed-tabs-save', '保存'));
  save.addEventListener('click', () => refs.saveBtn.click());

  const tools = el('button', 'ed-tabs-tools', '⋯');
  tools.type = 'button';
  tools.title = '预览、细纲、草稿、还原、历史……';
  menuButton(tools, () => {
    // 「外部打开」用的是服务端那台机器上的程序，手机、平板上点了没反应。
    const skip = new Set<HTMLElement>([refs.saveBtn, ...(touchDevice() ? [refs.externalBtn] : [])]);
    // 只认工具栏直属的按钮：面包屑（.ed-path）里的目录段也是按钮，点了是「在文件页中定位」。
    const buttons = menuFromButtons([...refs.toolbar.querySelectorAll<HTMLButtonElement>(':scope > button')].filter((b) => !skip.has(b)));
    // 补全名词：放回光标、在光标处弹候选（与 Alt+/、「视图 → 名词补全」同一条路，不归这一类文件时它自己说一句）。
    return [...buttons, { sep: true }, { label: '补全名词', run: () => commandNames('trigger') }];
  });

  // 跟着工具栏：没有文件（只开着叙事线总览之类）时工具栏藏着，这几颗也藏；「保存」亮灭跟着工具栏上那颗。
  const sync = () => {
    const off = refs.toolbar.classList.contains('hidden');
    for (const btn of [undo, redo, save, tools]) {
      btn.classList.toggle('hidden', off);
    }
    save.disabled = refs.saveBtn.disabled;
    syncHistory();
  };
  new MutationObserver(sync).observe(refs.toolbar, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(refs.saveBtn, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  refs.tabs.append(undo, redo, save, tools);
}
