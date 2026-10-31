/**
 * 页签切换。
 *
 * 插件形态是顶部一排文字页签，独立版是左侧竖排图标活动栏——同一份 DOM，
 * 由 standalone.css 重排（见 media/README.md 的「两形态隔离」）。
 */
import { closestFrom } from '../dom';
import type { Tab } from '../protocol';
import { avoidSoftKeyboard } from '../touch';
import { clearUnseenErrors } from './logs';
import { el } from './refs';
import { vscode } from './store';

export function showTab(tab: string): void {
  for (const btn of el.tabbar.querySelectorAll<HTMLElement>('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('active', pane.id === `pane-${tab}`);
  }
  // 手机上不顺手聚焦（一聚焦就弹软键盘盖住半屏，见 touch.ts 的 avoidSoftKeyboard）。
  if (tab === 'chat' && !avoidSoftKeyboard()) {
    el.input.focus();
  }
  if (tab === 'logs') {
    // 看过了就把红点收掉。
    clearUnseenErrors();
  }
}

/**
 * 作者要看侧栏的某一页（点页签、「更多」里挑一页、编辑器里「在文件页中定位」「历史」）：切过去并告诉后端。
 * 窄屏上编辑区是盖在侧栏上的一层，先把它收下去（宽屏上这个类不起作用）。
 * 后端推来的 `tab` 不走这里：断线重连时它会把当前页签再推一遍，不该把作者正看着的编辑区收掉。
 */
export function revealTab(tab: Tab): void {
  document.body.classList.remove('editor-open');
  if (!isTabActive(tab)) {
    showTab(tab);
    vscode.postMessage({ type: 'switchTab', tab });
  }
}

/** 某个页签当前是不是激活的。日志红点靠它判断「用户看没看见」。 */
export function isTabActive(tab: string): boolean {
  return !!document.getElementById(`pane-${tab}`)?.classList.contains('active');
}

export function installTabs(): void {
  // 编辑器里「在文件页中定位」、点面包屑的目录段：切到「文件」页（展开、高亮那一行是资源管理器自己的事）。
  // 插件里没有这一页，什么都不做。
  window.addEventListener('nf-reveal-in-files', () => {
    if (document.getElementById('pane-files')) {
      revealTab('files');
    }
  });

  // 编辑器工具栏「历史」、「文件 → 历史版本…」：切到「版本」页（内容是 editor.js 画的）。插件里没有这一页。
  window.addEventListener('nf-show-versions', () => {
    if (document.getElementById('pane-versions')) {
      revealTab('versions');
    }
  });

  // 窄屏底栏的「正文」「更多」没有 data-tab，归 mobileNav.ts。
  el.tabbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '.tab');
    if (!btn?.dataset.tab) {
      return;
    }
    document.body.classList.remove('editor-open');
    showTab(btn.dataset.tab);
    vscode.postMessage({ type: 'switchTab', tab: btn.dataset.tab as Tab });
  });
}
