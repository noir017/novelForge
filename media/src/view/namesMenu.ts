/**
 * 标题栏「视图」菜单里「补全」那一组（独立版）：「名词补全」（与 `Alt+/` 同一件事）与「边打边弹名词补全」开关。
 * 接在 `viewMenu.ts` 的 `GROUPS` 里（一组一个函数）。
 *
 * 状态问编辑器（`nf-names-query`，`editor/names.ts` 回答），动作经 `nf-names-command` 交给它——边打边弹是编辑器的偏好，
 * 按浏览器记（`novelforge.editor.prefs` 的 `nameAutoPopup`）。编辑器没装时整组置灰。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandNames, queryNames } from '../globals';
import type { MenuEntry } from './menubar';

export function namesMenuEntries(): MenuEntry[] {
  const status = queryNames();
  // 快捷键（⚑ Alt+/）登记在 editor/shortcuts.ts，菜单上的字从那张表取。
  const keyLabel = shortcutLabel('names');
  return [
    {
      label: '名词补全',
      kbd: keyLabel,
      disabled: !status.available || !status.canTrigger,
      detail: status.canTrigger
        ? '在光标处列出角色名、别名、设定（地点、势力、物品……）与名录里出现过的名字，按光标前已经打的几个字筛。'
        : status.reason ?? '先在编辑区里打开一章正文、细纲、角色卡或设定。',
      run: () => commandNames('trigger'),
    },
    {
      label: '边打边弹名词补全',
      checked: status.auto,
      disabled: !status.available,
      detail: `打出某个名字的开头两个字（还没打完整）就弹出来；按 Tab 接受，回车照常换段，接着打别的字就收起。关着时只在按 ${keyLabel} 时弹。`,
      run: () => commandNames('toggleAuto'),
    },
  ];
}
