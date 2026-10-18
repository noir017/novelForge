/**
 * 标题栏「视图」菜单里的「外观」那一组（接在 `viewMenu.ts` 的 `GROUPS` 里，一组一个函数）。状态问编辑器
 * （`nf-view-query` 的 `look`，`editor/look.ts` 回答），开关经 `nf-view-command` 交过去。编辑器没装
 * （插件、空窗口之外不会发生）时没人回答，整组置灰。
 */
import { commandViewPrefs } from '../globals';
import type { ViewPrefsStatus } from '../globals';
import type { MenuEntry } from './menubar';

/** 外观：字号放大 / 缩小 / 还原（快捷键只在焦点在编辑区里时拦），其余几项在外观面板里。 */
export function appearanceEntries(status: ViewPrefsStatus): MenuEntry[] {
  const look = status.look;
  const size = look ? `当前 ${look.fontSize}px，缺省 ${look.defaultFontSize}px。` : '';
  const keys = '快捷键只在焦点在编辑区里时管用，别处照常是浏览器的页面缩放。';
  return [
    {
      label: '放大字号',
      kbd: 'Ctrl+=',
      disabled: !look?.canZoomIn,
      detail: look?.canZoomIn === false ? `已经是最大字号（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomIn'),
    },
    {
      label: '缩小字号',
      kbd: 'Ctrl+-',
      disabled: !look?.canZoomOut,
      detail: look?.canZoomOut === false ? `已经是最小字号（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomOut'),
    },
    {
      label: '还原字号',
      kbd: 'Ctrl+0',
      disabled: !look,
      detail: `${size}${keys}`,
      run: () => commandViewPrefs('zoomReset'),
    },
    {
      label: '外观设置…',
      disabled: !look,
      detail: '正文字体、字号、行距、版心宽度与主题（深色 / 浅色 / 护眼），改了当场生效。',
      run: () => commandViewPrefs('openLook'),
    },
  ];
}
