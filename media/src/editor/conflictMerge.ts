/**
 * 冲突条上的「对比合并…」（放第一个，主要动作；原来那两颗「用磁盘版本覆盖编辑器」「用编辑器内容强制保存」
 * 留着）。从前保存撞上冲突只能整份二选一，看不到两边差在哪。
 *
 * 点下去把编辑器里的这一份发给后端（`mergeWithDisk`）；后端读磁盘上此刻的那一份，开合并视图（左边磁盘上的、
 * 右边编辑器里的，逐处挑、可以手改）。作者点「放回编辑器」之后后端回 `editorReplace`（带 `base`），
 * `replace.ts` 换内容（一步撤销）、把乐观锁基线换成磁盘那份、收起冲突条——这时它仍是未保存，照常 Ctrl+S，
 * 不必强制保存。放弃或关掉合并视图：什么都不变。
 *
 * 按钮不写进 `page.ts` / `createPaneElements`：与「排版」按钮（`layout.ts`）同一个做法，每块编辑区第一次
 * 重画时插进它的冲突条（`.ed-conflict`，说明文字后面），两块编辑区走同一条路，`pane.ts` 不必知道它。
 * 冲突条显隐、说明文字仍归 `pane.ts`。磁盘上已经没有这一份（`OpenFile.gone`）时冲突条也亮着（说的是「被删或
 * 改名」），那时没有磁盘版本可合并，这颗藏起来。
 */
import { el } from '../dom';
import type { InMessage } from '../protocol';
import { onEditorChange } from './api';
import type { Pane } from './api';
import { newRequestId } from './replace';

export function installConflictMerge(post: (msg: InMessage) => void): void {
  const buttons = new WeakMap<Pane, HTMLButtonElement>();
  onEditorChange((ev) => {
    if (ev.type !== 'render') {
      return;
    }
    const pane = ev.pane;
    let btn = buttons.get(pane);
    if (!btn) {
      const bar = pane.root.querySelector<HTMLElement>('.ed-conflict');
      if (!bar) {
        return;
      }
      btn = el('button', 'chip-btn ed-conflict-merge', '对比合并…');
      btn.type = 'button';
      btn.title = '左边磁盘上的、右边编辑器里的，逐处挑、可以手改；放回编辑器之后照常保存';
      btn.addEventListener('click', () => {
        const file = pane.activeFile();
        if (file && !file.gone) {
          post({ type: 'mergeWithDisk', path: file.path, text: file.draft, requestId: newRequestId('merge') });
        }
      });
      const text = bar.querySelector('.ed-conflict-text');
      bar.insertBefore(btn, text ? text.nextSibling : bar.firstChild);
      buttons.set(pane, btn);
    }
    // 磁盘上已经没有这一份（`OpenFile.gone`，冲突条这时说的是「被删或改名」）：没有磁盘版本可合并，藏起来——
    // 与「用磁盘版本覆盖编辑器」同一个判法。
    btn.classList.toggle('hidden', !!pane.activeFile()?.gone);
  });
}
