/**
 * 小说编辑器的基本功：分段格式、回车自动缩进、成对符号、段落快捷键、一键排版。`index.ts` 启动时调一次
 * {@link installParagraphTools}，各模块只经 `api.ts`（`addKeyHandler` / `onEditorChange` / `Pane.applyEdit`）
 * 碰编辑区，`pane.ts` 不知道它们的存在。
 *
 * | 模块 | 管什么 |
 * |---|---|
 * | `paragraphState.ts` | 分段格式（后端推来的）与编辑器偏好（localStorage `novelforge.editor.prefs`） |
 * | `enter.ts` | 回车 / Shift+Enter：正文按分段格式另起一段，Markdown 接着写列表，其余沿用缩进 |
 * | `pairs.ts` | 成对符号自动补全（“” 「」 （） ……） |
 * | `lines.ts` | 段落快捷键：Alt+↑↓ 交换、Shift+Alt+↑↓ 复制、Ctrl+Shift+K 删除、Ctrl+Enter 另起一段 |
 * | `layout.ts` | 一键排版、半角标点转全角、工具栏「排版」按钮 |
 *
 * 标题栏「编辑」菜单（view.js 里的 `view/paragraphMenu.ts`）经 `nf-paragraph-query` 问这里的状态、经
 * `nf-paragraph-command` 把动作交过来；切换分段格式不经这里，菜单直接发 `setParagraphStyle` 给后端。
 */
import { activeEditor, isProse } from './api';
import { installEnter } from './enter';
import { fullWidthIn, formatProseIn, installLayoutButton } from './layout';
import { installLineKeys } from './lines';
import { installPairs } from './pairs';
import { autoPairEnabled, setAutoPair, trackParagraphStyle } from './paragraphState';

export function installParagraphTools(): void {
  trackParagraphStyle();
  installEnter();
  installLineKeys();
  installPairs();
  installLayoutButton();

  window.addEventListener('nf-paragraph-query', (e) => {
    const ed = activeEditor();
    e.detail.prose = !!ed && isProse(ed.file);
    e.detail.autoPair = autoPairEnabled();
  });

  window.addEventListener('nf-paragraph-command', (e) => {
    const name = e.detail.name;
    if (name === 'toggleAutoPair') {
      setAutoPair(!autoPairEnabled());
      return;
    }
    const ed = activeEditor();
    if (!ed) {
      return;
    }
    if (name === 'formatProse') {
      formatProseIn(ed);
    } else if (name === 'fullWidthPunct') {
      fullWidthIn(ed);
    }
  });
}
