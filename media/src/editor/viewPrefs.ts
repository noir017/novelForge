/**
 * 标题栏「视图」菜单的编辑器那一半：回答 `nf-view-query`、执行 `nf-view-command`（菜单那一半在
 * `view/viewMenu.ts`）。之后的阶段往「视图」里加的开关照这个样子各加一个字段、一个命令名。
 *
 * - **单击打开为临时标签**（缺省开，记在 `novelforge.editor.prefs`）：关掉时两块编辑区里现有的临时标签
 *   一律转正——开关说「不要临时标签」，留着一个斜体的会让人以为没关上。
 */
import { panes } from './store';
import { onPrefsChange, previewTabsEnabled, setPreviewTabs } from './paragraphState';

export function installViewPrefs(): void {
  window.addEventListener('nf-view-query', (e) => {
    e.detail.available = true;
    e.detail.previewTabs = previewTabsEnabled();
  });

  window.addEventListener('nf-view-command', (e) => {
    if (e.detail.name === 'togglePreviewTabs') {
      setPreviewTabs(!previewTabsEnabled());
    }
  });

  onPrefsChange(() => {
    if (previewTabsEnabled()) {
      return;
    }
    for (const pane of Object.values(panes)) {
      for (const file of [...pane.files.values()]) {
        if (file.preview) {
          pane.pin(file.path);
        }
      }
    }
  });
}
