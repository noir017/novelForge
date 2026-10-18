/**
 * 标签条：一行能横着滚的标签，末尾一颗「▾」。
 *
 * - **滚轮横着滚**：标签多了挤不下，标签条本身没有竖向可滚的东西，竖着拨滚轮就当横着滚
 *   （触控板的横向拨动原样认）。
 * - **当前那个自动滚进视野**：每次重画标签之后，激活的那个不在视野里就滚到刚好露出来。重画之前的
 *   滚动位置先留住——整排换掉 DOM 那一下浏览器会把它归零，不留的话点一下别的标签整排就跳回开头。
 * - **「▾」**：两块编辑区里开着的全部文件（按块分组、标出哪个没保存、哪个是当前的），点了切过去；
 *   底下是最近关掉的几个，点了重新打开。弹的是 view 的那个菜单引擎（`showMenuAt`），与右键菜单
 *   同一种样子、同时只有一个。
 *
 * DOM 由这里现造进每块编辑区的 `.ed-tabs`（`page.ts` 与 `createPaneElements` 里只有那个空容器）：
 * `.ed-tabs-list` 放标签，`.ed-tabs-more` 是「▾」。
 */
import { el } from '../dom';
import { showMenuAt } from '../globals';
import type { MenuItem } from '../globals';
import { tabNames } from './tabLabels';
import type { TabName } from './tabLabels';
import type { PaneId } from './paneElements';
import { activePane, allOpenFiles, panes, recentClosed, reopenClosed } from './store';

/** 两块编辑区在界面上的叫法。 */
export const PANE_LABEL: Record<PaneId, string> = { main: '左侧', draft: '右侧' };

export interface TabStrip {
  /** 放标签的那一格（会横着滚）。 */
  list: HTMLElement;
  /** 整排换掉标签之前调：留住滚动位置。 */
  beforeRender(): number;
  /** 换完之后调：放回滚动位置，再把当前那个滚进视野。 */
  afterRender(scrollLeft: number, active: HTMLElement | null): void;
}

export function createTabStrip(container: HTMLElement): TabStrip {
  const list = el('div', 'ed-tabs-list');
  const more = el('button', 'ed-tabs-more', '▾');
  more.type = 'button';
  more.title = '打开的文件（两块编辑区）与最近关闭';
  container.replaceChildren(list, more);

  list.addEventListener(
    'wheel',
    (e) => {
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) {
        return;
      }
      // deltaMode：0 像素、1 行、2 页。
      const px = e.deltaMode === 1 ? delta * 16 : e.deltaMode === 2 ? delta * (list.clientWidth || 200) : delta;
      list.scrollLeft += px;
      e.preventDefault();
    },
    { passive: false }
  );

  /** 菜单开着时再点「▾」：让这一下点击冒到 document 上去收起它。 */
  let menu: HTMLElement | undefined;
  more.addEventListener('click', (e) => {
    if (menu?.isConnected) {
      menu = undefined;
      return;
    }
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    menu = showMenuAt(openFilesMenu(), rect.left, rect.bottom);
  });

  return {
    list,
    beforeRender: () => list.scrollLeft,
    afterRender(scrollLeft, active) {
      list.scrollLeft = scrollLeft;
      if (active) {
        scrollIntoView(list, active);
      }
    },
  };
}

/** 当前那个标签不在视野里就滚到刚好露出来（左边藏着贴左、右边藏着贴右）。 */
function scrollIntoView(list: HTMLElement, tab: HTMLElement): void {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  const width = list.clientWidth;
  if (left < list.scrollLeft) {
    list.scrollLeft = left;
  } else if (width > 0 && right > list.scrollLeft + width) {
    list.scrollLeft = right - width;
  }
}

/** 标签上写的那几个字（「▾」列表、右键菜单、对话框里都这么称呼它）。 */
export function tabText(name: TabName): string {
  return `${name.tag ? `${name.tag} ` : ''}${name.title}${name.desc ? ` · ${name.desc}` : ''}`;
}

/** 「▾」列表：两块编辑区里开着的文件按块分组，底下是最近关掉的几个。 */
function openFilesMenu(): MenuItem[] {
  const names = tabNames(allOpenFiles());
  const items: MenuItem[] = [];
  const open = (['main', 'draft'] as const).map((id) => panes[id]).filter((p) => !!p && p.files.size > 0);
  for (const pane of open) {
    items.push({ label: `${PANE_LABEL[pane!.id]}编辑区`, disabled: true });
    for (const file of pane!.files.values()) {
      const dirty = file.draft !== file.text;
      const current = pane === activePane && pane!.activePath === file.path;
      const mark = dirty ? '● ' : current ? '› ' : '　 ';
      items.push({
        label: `${mark}${tabText(names.get(file.path)!)}${dirty ? '（未保存）' : ''}`,
        // activate 自己会认下这一块、广播「正在编辑哪个文件」。
        run: () => pane!.activate(file.path),
      });
    }
  }
  const closed = recentClosed();
  if (closed.length > 0) {
    items.push({ sep: true }, { label: '最近关闭', disabled: true });
    for (const entry of closed) {
      items.push({ label: `　 ${entry.title} · ${PANE_LABEL[entry.pane]}`, run: () => reopenClosed(entry) });
    }
  }
  return items;
}
