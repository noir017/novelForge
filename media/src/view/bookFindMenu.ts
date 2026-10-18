/**
 * 标题栏「编辑」菜单的「全书查找替换…」（独立版，紧跟在「查找」「替换」后面）：打开内置编辑器的全书查找替换面板
 * （`editor/bookFind.ts`，与 Ctrl+Shift+F 同一件事）。能不能用问编辑器（`nf-bookfind-query`）——没打开工程时置灰，
 * 原因挂在提示上。与 `quickOpenMenu.ts` 同一个做法：经 `MenuEntry.run` 接进 `menubar`。
 */
import { commandBookFind, queryBookFind } from '../globals';
import type { MenuEntry } from './menubar';

export function bookFindMenuEntry(): MenuEntry {
  const status = queryBookFind();
  return {
    label: '全书查找替换…',
    kbd: 'Ctrl+Shift+F',
    disabled: !status.available,
    detail: status.available ? '在正文、细纲、角色卡、设定等文件里一起找；预览之后一起替换' : status.reason,
    run: () => commandBookFind('open'),
  };
}
