/**
 * 标题栏「视图」菜单里「统计」那一组（独立版）：状态栏字数那一格显示哪几项的开关，外加「重新开始计时」。
 * 接在 `viewMenu.ts` 的 `GROUPS` 里（一组一个函数）。
 *
 * 状态问编辑器（`nf-stats-query`，`editor/stats.ts` 回答），开关与重新开始计时经 `nf-stats-command` 交给它——
 * 那是编辑器的偏好，按浏览器记（`novelforge.editor.prefs` 的 `stats`）。编辑器没装时整组置灰。
 */
import { commandStats, queryStats } from '../globals';
import type { MenuEntry } from './menubar';

export function statsMenuEntries(): MenuEntry[] {
  const status = queryStats();
  return [
    {
      label: '统计',
      disabled: !status.available,
      detail: '内置编辑器状态栏上字数那一格除了全文 / 选中字数，还显示哪几项。点那一格看码字统计。',
      submenu: [
        {
          label: '状态栏显示距目标',
          checked: status.goal,
          detail: '开着某一章的正文时，显示本章字数与目标（细纲的目标字数，没写就是小说配置的每章字数）还差多少。',
          run: () => commandStats('toggleGoal'),
        },
        {
          label: '状态栏显示本次码字',
          checked: status.session,
          detail: '从打开这个页面（或重新开始计时）起，你在编辑器里亲手打进去的净字数。',
          run: () => commandStats('toggleSession'),
        },
        {
          label: '状态栏显示今日码字',
          checked: status.today,
          detail: '这个工程今天一共码了多少字（同一个浏览器里几个窗口、刷新前后都累计）。',
          run: () => commandStats('toggleToday'),
        },
      ],
    },
    {
      label: '重新开始计时',
      disabled: !status.available,
      detail: '「本次码字」的字数与时长从现在起重新算；今日码字不受影响。',
      run: () => commandStats('restart'),
    },
  ];
}
