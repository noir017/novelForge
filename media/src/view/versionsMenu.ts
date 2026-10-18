/**
 * 标题栏「文件」菜单的「历史版本…」（独立版，紧跟在「另存为…」后面）：打开当前那块编辑区的历史版本面板
 * （`editor/versions.ts`）。能不能用问编辑器（`nf-versions-query`）——没开文件、没打开工程、文件不是工程里的
 * 创作产物时置灰，原因挂在提示上。与 `paragraphMenu.ts` 同一个做法：经 `MenuEntry.run` 接进 `menubar`。
 */
import { commandVersions, queryVersions } from '../globals';
import type { MenuEntry } from './menubar';

export function versionsMenuEntry(): MenuEntry {
  const status = queryVersions();
  return {
    label: '历史版本…',
    disabled: !status.available,
    detail: status.available ? '看这份文件存下的历史版本：对比、恢复到编辑区' : status.reason,
    run: () => commandVersions('open'),
  };
}
