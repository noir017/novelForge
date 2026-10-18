/**
 * 页签切换。
 *
 * 插件形态是顶部一排文字页签，独立版是左侧竖排图标活动栏——同一份 DOM，
 * 由 standalone.css 重排（见 media/README.md 的「两形态隔离」）。
 */
import { closestFrom } from '../dom';
import type { Tab } from '../protocol';
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
  if (tab === 'chat') {
    el.input.focus();
  }
  if (tab === 'logs') {
    // 看过了就把红点收掉。
    clearUnseenErrors();
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
    if (document.getElementById('pane-files') && !isTabActive('files')) {
      showTab('files');
      vscode.postMessage({ type: 'switchTab', tab: 'files' });
    }
  });

  el.tabbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '.tab');
    if (!btn?.dataset.tab) {
      return;
    }
    showTab(btn.dataset.tab);
    vscode.postMessage({ type: 'switchTab', tab: btn.dataset.tab as Tab });
  });
}
