/**
 * 「不丢稿」那几样的装配入口：`index.ts` 启动时调一次 {@link installSaveSafety}。
 *
 * | 模块 | 管什么 |
 * |---|---|
 * | `diskSync.ts` | 磁盘上的改动同步到已开的标签（`checkEditorFiles` ↔ `editorDiskChanged` / `editorDiskGone`） |
 * | `saving.ts` | 保存本身：同一份只有一个在路上、状态栏的保存状态、磁盘上没了先问、自动保存的闸 |
 * | `closing.ts` | 关标签时问「保存 / 不保存 / 取消」，批量关闭合成一次 |
 * | `dialog.ts` | 页内对话框（编辑器里不再用 `window.confirm`） |
 * | `autosave.ts` | 自动保存（缺省关）：停笔 2 秒、切标签、窗口失焦 |
 *
 * `pane.ts` 只认 `saving.ts` / `closing.ts` / `dialog.ts` 的几个函数；收消息与定时都在这几个模块自己身上。
 */
import { installAutoSave } from './autosave';
import { installDiskSync } from './diskSync';
import { installSaving } from './saving';

export function installSaveSafety(): void {
  installSaving();
  installDiskSync();
  installAutoSave();
}
