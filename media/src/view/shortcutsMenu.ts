/**
 * 标题栏「帮助 → 快捷键一览」（独立版，紧跟「使用说明」）：打开内置编辑器的快捷键一览面板
 * （`editor/shortcutsPanel.ts`，与 `Ctrl+/` 同一件事）。能不能用问编辑器（`nf-shortcuts-query`）——编辑器没装时没人回答，
 * 置灰。与 `quickOpenMenu.ts` 同一个做法：经 `MenuEntry.run` 接进 `menubar`，不往它的 `run` 分支表里加。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandShortcuts, queryShortcuts } from '../globals';
import type { MenuEntry } from './menubar';

export function shortcutsMenuEntry(): MenuEntry {
  const available = queryShortcuts();
  return {
    label: '快捷键一览',
    kbd: shortcutLabel('shortcuts'),
    disabled: !available,
    detail: available ? '编辑器与菜单的全部快捷键，按分组列出，可以筛选' : '没有内置编辑器',
    run: () => commandShortcuts(),
  };
}
