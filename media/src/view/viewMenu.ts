/**
 * 标题栏「视图」菜单（独立版，放在「编辑」与「帮助」之间）。
 *
 * **一组一个函数**：`viewMenuEntries` 只把各组按顺序接起来、组与组之间隔一条线。之后的阶段往「视图」里加东西，
 * 写一个返回 `MenuEntry[]` 的函数接在 `GROUPS` 里即可，不往 `menubar.ts` 的 `run` 分支表里加。状态问编辑器
 * （`nf-view-query`，`editor/viewPrefs.ts` 回答），开关经 `nf-view-command` 交给它——那是编辑器的偏好，
 * 按浏览器记（`novelforge.editor.prefs`）。编辑器没装（空窗口之外不会发生；插件里根本没有菜单栏）时置灰。
 */
import { commandViewPrefs, queryViewPrefs } from '../globals';
import type { ViewPrefsStatus } from '../globals';
import { checkMenuEntries } from './checkMenu';
import { appearanceEntries, focusEntries } from './lookMenu';
import type { MenuEntry } from './menubar';
import { statsMenuEntries } from './statsMenu';

/**
 * 「视图」里的各组，从上到下：标签 → 外观 → 专注 → 统计 → 体检。「外观」「专注」两组在 `lookMenu.ts`，「统计」在
 * `statsMenu.ts`，「体检」在 `checkMenu.ts`（后两组的状态自己问编辑器）。
 */
const GROUPS: ((status: ViewPrefsStatus) => MenuEntry[])[] = [
  editorTabs,
  appearanceEntries,
  focusEntries,
  statsMenuEntries,
  checkMenuEntries,
];

export function viewMenuEntries(): MenuEntry[] {
  const status = queryViewPrefs();
  const out: MenuEntry[] = [];
  for (const group of GROUPS) {
    const entries = group(status);
    if (entries.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push({ label: 'sep' });
    }
    out.push(...entries);
  }
  return out;
}

/** 编辑器的标签：单击打开为临时标签。 */
function editorTabs(status: ViewPrefsStatus): MenuEntry[] {
  return [
    {
      label: '单击打开为临时标签',
      checked: status.previewTabs,
      disabled: !status.available,
      detail: '在工程页 / 文件页单击打开的文件是临时标签（名字斜体），下一次单击别的文件时换掉它；编辑、保存或双击就固定下来。',
      run: () => commandViewPrefs('togglePreviewTabs'),
    },
  ];
}
