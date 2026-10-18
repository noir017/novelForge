/**
 * `editorReplace`（「把编辑区里这份文件换成这段文字」）的接收端。冲突条的「对比合并…」（`conflictMerge.ts`）
 * 与历史版本的「对比…」（`versions.ts`）共用；「恢复这一版」也走这里的 {@link replaceInEditor}。
 *
 * - **只认自己发出去的 `requestId`**：回复是广播，同一个工程开着两个窗口时，另一个窗口里那一份不该被换掉。
 * - **换内容只走 `Pane.applyEdit`**（`api.ts` 的硬规矩）：整份换掉也只记一步撤销，成为未保存，**不写盘**。
 * - **带 `base` 时先 `rebase` 再换内容**：乐观锁基线换成磁盘上那一份、冲突条收起；顺序反过来的话，换内容
 *   那一刻的脏标记与标签圆点是对着旧基线算的。
 */
import { toast } from '../globals';
import type { OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { paneOwning } from './store';

type ReplaceMessage = Extract<OutMessage, { type: 'editorReplace' }>;

/** 本页发出去、还在等回话的请求。放弃合并时后端不回话，那几个就一直留着——几个字符串，不值得清。 */
const pending = new Set<string>();
let seq = 0;

/** 给一次要等 `editorReplace` / `versionText` 回话的请求起个名字，并记下「这是我发的」。 */
export function newRequestId(prefix: string): string {
  const id = `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  pending.add(id);
  return id;
}

/** 这个 `requestId` 是不是本页发的（认过一次就划掉）。 */
export function claimRequest(id: string): boolean {
  return pending.delete(id);
}

export type ReplaceResult = 'changed' | 'unchanged' | 'closed';

/**
 * 把开着的这份文件的内容整份换成 `text`（一步撤销，不写盘）。给了 `base` 就先换乐观锁基线、收冲突条。
 * 文件不在当前标签上（或在预览里）时先切过去——`applyEdit` 作用于那块编辑区的当前文件。
 */
export function replaceInEditor(path: string, text: string, base?: { text: string; hash: string }): ReplaceResult {
  const pane = paneOwning(path);
  if (!pane) {
    return 'closed';
  }
  if (base) {
    pane.rebase(path, base.text, base.hash);
  }
  if (pane.activePath !== path || pane.isPreviewing()) {
    pane.activate(path);
  }
  return pane.applyEdit(0, pane.area.value.length, text) ? 'changed' : 'unchanged';
}

function handle(msg: ReplaceMessage): void {
  if (!claimRequest(msg.requestId)) {
    return;
  }
  const result = replaceInEditor(msg.path, msg.text, msg.base);
  if (result === 'closed') {
    toast('这份文件已经关掉了，没有放回编辑区。', true);
    return;
  }
  const file = paneOwning(msg.path)?.files.get(msg.path);
  const dirty = !!file && file.draft !== file.text;
  if (msg.base) {
    toast(dirty ? '已放回编辑区：还没保存，照常 Ctrl+S 保存即可（不必强制保存）。' : '已放回编辑区，与磁盘上的一致，不用再存。');
  } else {
    toast(result === 'changed' ? '已放回编辑区：还没保存，Ctrl+Z 可以退回。' : '编辑区内容没有变化。');
  }
}

export function installEditorReplace(): void {
  onMessage((msg) => {
    if (msg.type === 'editorReplace') {
      handle(msg);
    }
  });
}
