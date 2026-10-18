/**
 * 标题栏「文件」菜单的「转到…」（独立版，紧跟在「打开文件…」后面）：打开内置编辑器的「转到」面板
 * （`editor/quickOpen.ts`，与 Ctrl+P 同一件事）。能不能用问编辑器（`nf-quickopen-query`）——没打开工程时置灰，
 * 原因挂在提示上。与 `versionsMenu.ts` 同一个做法：经 `MenuEntry.run` 接进 `menubar`。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandQuickOpen, queryQuickOpen } from '../globals';
import type { MenuEntry } from './menubar';

export function quickOpenMenuEntry(): MenuEntry {
  const status = queryQuickOpen();
  return {
    label: '转到…',
    kbd: shortcutLabel('quickOpen'),
    disabled: !status.available,
    detail: status.available ? '按章号、标题、角色名、设定或路径转到一章或一个文件' : status.reason,
    run: () => commandQuickOpen('open'),
  };
}
