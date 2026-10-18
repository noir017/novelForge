/**
 * 标题栏「编辑」菜单里段落那一组（独立版）：
 *
 * - 「段落格式 ▸」三项（空行分段 / 段首缩进 / 缩进加空行），当前那项打 ✓；没开工程（或还不是小说工程）时置灰。
 *   点了直接发 `setParagraphStyle` 给后端——那是工程的设置，后端只改 `config.md` 的这一个键，再 `pushState`，
 *   勾随新的 `ViewState.paragraphStyle` 回来（前端无状态）。
 * - 「成对符号自动补全」开关（打 ✓）：编辑器的偏好，按浏览器记，经 `nf-paragraph-command` 交给编辑器。
 * - 「一键排版」「半角标点转全角」：作用于当前那块编辑区，当前文件不是正文时置灰。
 *
 * 状态问编辑器（`nf-paragraph-query`，`editor/paragraph.ts` 回答）；编辑器没装（插件）时这一组根本不出现——
 * 菜单栏本身就只在独立版里有。
 */
import { DEFAULT_PARAGRAPH_STYLE, PARAGRAPH_STYLES, PARAGRAPH_STYLE_HINT, PARAGRAPH_STYLE_LABEL } from '../protocol';
import { commandParagraph, queryParagraph } from '../globals';
import type { MenuEntry } from './menubar';
import { hasWorkspace, store, vscode } from './store';

export function paragraphMenuEntries(): MenuEntry[] {
  const project = hasWorkspace() && !!store.state?.initialized;
  const current = store.state?.paragraphStyle ?? DEFAULT_PARAGRAPH_STYLE;
  const status = queryParagraph();
  return [
    { label: 'sep' },
    {
      label: '段落格式',
      disabled: !project,
      submenu: PARAGRAPH_STYLES.map((style) => ({
        label: PARAGRAPH_STYLE_LABEL[style],
        detail: PARAGRAPH_STYLE_HINT[style],
        checked: style === current,
        run: () => vscode.postMessage({ type: 'setParagraphStyle', style }),
      })),
    },
    { label: '成对符号自动补全', checked: status.autoPair, run: () => commandParagraph('toggleAutoPair') },
    { label: 'sep' },
    { label: '一键排版', disabled: !status.prose, run: () => commandParagraph('formatProse') },
    { label: '半角标点转全角', disabled: !status.prose, run: () => commandParagraph('fullWidthPunct') },
  ];
}
