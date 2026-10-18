/**
 * 磁盘上的改动同步到已开的标签。
 *
 * 后端从前只在 `openFile` 时推 `editorOpen`；定稿写回细纲、批量写章、外部 agent 经 MCP 的 `edit`、外部编辑器 /
 * git 改了文件，watcher 只触发 `pushState` 刷界面，编辑器里还是旧内容——作者改两笔一保存就撞冲突。
 *
 * - **什么时候核对**：每收到一条 `state` / `init`（每次磁盘变动后的 `pushState` 都会推，哪个页签都推）就去抖
 *   {@link DISK_SYNC_DELAY_MS}，窗口重新拿到焦点、页面重新可见时也来一次；把两块编辑区里**所有打开的文件**的
 *   `{ path, hash }` 发给后端（`checkEditorFiles`）。`hash` 是 `Pane.knownDiskHash`：已删除的给空串，见过一份
 *   没载入的磁盘新版就给那一份的（同一个新版不再报一次）。正在保存的那几份不带——以保存的回执为准。
 * - **回话**：`editorDiskChanged` 交给拥有它的那一块 `applyDiskChange`（没改过的就地换、改过的挂冲突条，
 *   不切标签、不抢焦点）；`editorDiskGone` 交给 `markGone`（标成已删除）。自己那次保存还在路上时收到的
 *   「变了」不认：多半是读到了自己刚写下去的那一份，回执会说清楚。
 *
 * **自己保存之后不误报**：`editorSaved` 先到（基线换成新的 hash）、`state` 后到（WebSocket 保证顺序），
 * 于是这之后核对时带的就是新 hash。
 */
import type { EditorFileCheck } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isSaving } from './saving';
import { paneOwning, panes, postToHost } from './store';

/** 收到 `state` 之后等多久再核对：一次磁盘变动常常连着推好几条。 */
export const DISK_SYNC_DELAY_MS = 400;

export function installDiskSync(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(check, DISK_SYNC_DELAY_MS);
  };

  onMessage((msg) => {
    if (msg.type === 'state' || msg.type === 'init') {
      schedule();
    } else if (msg.type === 'editorDiskChanged') {
      if (!isSaving(msg.file.path)) {
        paneOwning(msg.file.path)?.applyDiskChange(msg.file);
      }
    } else if (msg.type === 'editorDiskGone') {
      paneOwning(msg.path)?.markGone(msg.path);
    }
  });

  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedule();
    }
  });
}

/** 把开着的文件报给后端核对。一个都没开就不发。 */
function check(): void {
  const files: EditorFileCheck[] = [];
  for (const pane of Object.values(panes)) {
    for (const path of pane.files.keys()) {
      if (!isSaving(path)) {
        files.push({ path, hash: pane.knownDiskHash(path) });
      }
    }
  }
  if (files.length > 0) {
    postToHost({ type: 'checkEditorFiles', files });
  }
}
