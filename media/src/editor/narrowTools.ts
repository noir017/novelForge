/**
 * 窄屏上编辑区顶上只留两行：标签条与章节条（样式在 narrow.css）。
 *
 * - 工具栏那一行收起，它的按钮挪进标签条末尾的「⋯」；「保存」在「⋯」前面单留一颗（自动保存缺省关，手机上没有 Ctrl+S）。
 * - 章节条底下那一排动作（写这一章、接着写……）收进条上的「操作 ▾」（`chapterBar.ts` 挂）。
 *
 * 菜单项照着那几颗按钮现列：字、亮灭跟着按钮走，点了就是点那颗按钮——按钮以后增减、改名不用改这里。
 * 宽屏上这几颗不显示，工具栏照旧。
 */
import { el } from '../dom';
import { showMenuAt } from '../globals';
import type { MenuItem } from '../globals';
import { touchDevice } from '../touch';
import type { PaneRefs } from './paneElements';

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

/** 标签条末尾的「保存」与「⋯」。 */
export function installNarrowTools(refs: PaneRefs): void {
  const save = el('button', 'primary ed-tabs-save', '保存');
  save.type = 'button';
  save.addEventListener('click', () => refs.saveBtn.click());

  const tools = el('button', 'ed-tabs-tools', '⋯');
  tools.type = 'button';
  tools.title = '预览、细纲、草稿、还原、历史……';
  menuButton(tools, () => {
    // 「外部打开」用的是服务端那台机器上的程序，手机、平板上点了没反应。
    const skip = new Set<HTMLElement>([refs.saveBtn, ...(touchDevice() ? [refs.externalBtn] : [])]);
    // 只认工具栏直属的按钮：面包屑（.ed-path）里的目录段也是按钮，点了是「在文件页中定位」。
    return menuFromButtons([...refs.toolbar.querySelectorAll<HTMLButtonElement>(':scope > button')].filter((b) => !skip.has(b)));
  });

  // 跟着工具栏：没有文件（只开着叙事线总览之类）时工具栏藏着，这两颗也藏；「保存」亮灭跟着工具栏上那颗。
  const sync = () => {
    const off = refs.toolbar.classList.contains('hidden');
    save.classList.toggle('hidden', off);
    tools.classList.toggle('hidden', off);
    save.disabled = refs.saveBtn.disabled;
  };
  new MutationObserver(sync).observe(refs.toolbar, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(refs.saveBtn, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  refs.tabs.append(save, tools);
}
