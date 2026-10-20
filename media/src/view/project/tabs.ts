/**
 * 工程页的四个页签：概览 / 章节 / 角色 / 设定。
 *
 * 从前一页从上到下摊着故事架构、章节、角色、设定……几百行，找一个区要翻很久。章节、角色、设定
 * 各占一页，其余（故事架构、文风与摘要、定稿进度横幅）留在「概览」。
 *
 * 四页的内容每次都全画（`index.ts` 把各组装进各自的 `.project-panel`），切页签只换哪一块露出来——
 * 不重画、不往后端要数据；分组的右键菜单、三只浮窗挂在 `#projectBody` 上的事件委托都照旧。
 * 当前页签与折叠开合同一个待遇：只在前端，重推树不换页。
 *
 * 四页共用 `#projectBody` 这一个滚动容器（它不随重画换掉，重推树时滚动位置才留得住），
 * 所以各页滚到哪由这里记：切走时记下，切回来放回去。
 */
import { el as mk } from '../../dom';
import { el } from '../refs';

export type ProjectTab = 'overview' | 'chapters' | 'characters' | 'lore';

const TABS: readonly ProjectTab[] = ['overview', 'chapters', 'characters', 'lore'];

let current: ProjectTab = 'overview';
const scrollOf: Partial<Record<ProjectTab, number>> = {};

/** 一页的容器。按当前页签决定露不露，整页重画之后不用再同步一遍。 */
export function buildPanel(tab: ProjectTab): HTMLElement {
  const panel = mk('div', 'project-panel');
  panel.dataset.projectPanel = tab;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `projectTab-${tab}`);
  panel.hidden = tab !== current;
  return panel;
}

/** 切到某一页：记下这一页滚到哪，放回那一页上次的位置。 */
export function showProjectTab(tab: ProjectTab, focus = false): void {
  if (tab !== current) {
    scrollOf[current] = el.projectBody.scrollTop;
    current = tab;
  }
  for (const btn of el.projectTabs.querySelectorAll<HTMLButtonElement>('[data-project-tab]')) {
    const active = btn.dataset.projectTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    if (active && focus) {
      btn.focus();
    }
  }
  for (const panel of el.projectBody.querySelectorAll<HTMLElement>('[data-project-panel]')) {
    panel.hidden = panel.dataset.projectPanel !== tab;
  }
  el.projectBody.scrollTop = scrollOf[tab] ?? 0;
}

/** 点页签切页；左右方向键、Home / End 在页签之间走（同设置页的分类页签）。 */
export function installProjectTabs(): void {
  for (const btn of el.projectTabs.querySelectorAll<HTMLButtonElement>('[data-project-tab]')) {
    const tab = btn.dataset.projectTab as ProjectTab;
    btn.addEventListener('click', () => showProjectTab(tab));
    btn.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(tab);
      let next = i;
      if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
      if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = TABS.length - 1;
      if (next !== i) {
        e.preventDefault();
        showProjectTab(TABS[next], true);
      }
    });
  }
}
