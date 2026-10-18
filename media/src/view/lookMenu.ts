/**
 * 标题栏「视图」菜单里的「外观」与「专注」两组（接在 `viewMenu.ts` 的 `GROUPS` 里，一组一个函数）。状态问编辑器
 * （`nf-view-query` 的 `look` / `focus`，`editor/look.ts` 与 `editor/focus.ts` 回答），开关经 `nf-view-command`
 * 交过去。编辑器没装（插件、空窗口之外不会发生）时没人回答，两组置灰。
 */
import { shortcutLabel } from '../editor/shortcuts';
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
      kbd: shortcutLabel('zoomIn'),
      disabled: !look?.canZoomIn,
      detail: look?.canZoomIn === false ? `已经是最大字号（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomIn'),
    },
    {
      label: '缩小字号',
      kbd: shortcutLabel('zoomOut'),
      disabled: !look?.canZoomOut,
      detail: look?.canZoomOut === false ? `已经是最小字号（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomOut'),
    },
    {
      label: '还原字号',
      kbd: shortcutLabel('zoomReset'),
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

/** 专注：专注模式、全屏、打字机滚动、段落聚焦，开着的打 ✓。 */
export function focusEntries(status: ViewPrefsStatus): MenuEntry[] {
  const focus = status.focus;
  return [
    {
      label: '专注模式',
      kbd: shortcutLabel('focusMode'),
      checked: !!focus?.focusMode,
      disabled: !focus,
      detail: `只留正文：藏起侧栏、标签条、工具栏与章节条，状态栏淡成一行。两块编辑区都开着时只专注当前那一块。Esc 或再按 ${shortcutLabel('focusMode')} 退出。`,
      run: () => commandViewPrefs('toggleFocusMode'),
    },
    {
      label: '全屏',
      checked: !!focus?.fullscreen,
      disabled: !focus?.fullscreenSupported,
      detail: focus?.fullscreenSupported
        ? '整个页面占满屏幕（浏览器的 F11 也行）。Esc 退出。'
        : '这个浏览器（或窗口）不支持全屏。',
      run: () => commandViewPrefs('toggleFullscreen'),
    },
    {
      label: '打字机滚动',
      checked: !!focus?.typewriter,
      disabled: !focus,
      detail: '光标所在那一行始终停在编辑区中间附近；用滚轮翻看前文时不拉回来，下一次打字才回来。',
      run: () => commandViewPrefs('toggleTypewriter'),
    },
    {
      label: '段落聚焦',
      checked: !!focus?.paragraphFocus,
      disabled: !focus,
      detail: '正文里光标所在那一段照常显示，其余变淡。按工程的分段格式认段落。',
      run: () => commandViewPrefs('toggleParagraphFocus'),
    },
  ];
}
