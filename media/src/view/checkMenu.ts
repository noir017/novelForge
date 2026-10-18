/**
 * 标题栏「视图」菜单里「体检」那一组（独立版）：正文里的体检高亮、状态栏「体检」那一格两个开关，外加「编辑敏感词表…」。
 * 接在 `viewMenu.ts` 的 `GROUPS` 里（一组一个函数）。
 *
 * 状态问编辑器（`nf-check-query`，`editor/check.ts` 回答），开关与「编辑敏感词表…」经 `nf-check-command` 交给它——
 * 那是编辑器的偏好，按浏览器记（`novelforge.editor.prefs` 的 `check`）。编辑器没装时整组置灰。
 */
import { commandCheck, queryCheck } from '../globals';
import type { MenuEntry } from './menubar';

export function checkMenuEntries(): MenuEntry[] {
  const status = queryCheck();
  return [
    {
      label: '体检高亮',
      checked: status.highlight,
      disabled: !status.available,
      detail:
        '在正文（章节与草稿）里标出敏感词、禁用词（文风指南的禁用词表、全局要求里禁止的词、古代题材的现代说法）、' +
        '超出上限的比喻词与英文缩写。不调模型，也不会替你改字。',
      run: () => commandCheck('toggleHighlight'),
    },
    {
      label: '状态栏显示体检',
      checked: status.status,
      disabled: !status.available,
      detail: '状态栏上一格「体检 N」：一共几个问题，点开看是哪几个词、点词跳过去。',
      run: () => commandCheck('toggleStatus'),
    },
    {
      label: '编辑敏感词表…',
      disabled: !status.available || !status.canEditList,
      detail: status.canEditList
        ? '打开这本书的敏感词表（.novelforge/sensitive.txt，没有就新建一份带说明的模板）：一行一个词，「词 => 替换词」给出替换。'
        : '先打开一个工程。',
      run: () => commandCheck('editList'),
    },
  ];
}
