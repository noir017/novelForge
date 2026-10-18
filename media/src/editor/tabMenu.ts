/**
 * 标签右键菜单里关闭类之后的那几项：
 *
 * - **固定**：只有临时标签有（把它转正）。
 * - **移到另一侧**：左 ↔ 右，连同未保存内容、撤销历史、冲突条、「磁盘上没了」一起搬过去——走现有的搬家机制
 *   （`Pane.closeSilently` 交出去、`upsertFile(…, carried)` 接上），只是不经后端重读：`moveOut` 交出来的就是
 *   它此刻的基线。**一个路径同一时刻只属于一块**照旧成立：先从这一块拿走，再交给那一块。
 * - **在文件页中定位**：`nf-reveal-in-files`（资源管理器展开到它、高亮那一行；view 切到「文件」页）。
 * - **复制相对路径**。
 * - **重新打开刚关闭的**：这一块最近关掉的那一个（按块记，`store.ts`）。没有快捷键（⚑）：Chrome 不让页面
 *   拦 Ctrl+Shift+T，换一个组合键作者也记不住；「▾」列表底下也列着最近关掉的几个。
 */
import { revealInFiles, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { Pane } from './store';
import { lastClosed, otherPane, persist, reopenClosed, syncDraftVisibility } from './store';
import { PANE_LABEL } from './tabStrip';

export function extraTabItems(pane: Pane, path: string): MenuItem[] {
  const file = pane.files.get(path);
  if (!file) {
    return [];
  }
  const items: MenuItem[] = [{ sep: true }];
  if (file.preview) {
    items.push({ label: '固定', run: () => pane.pin(path) });
  }
  const side = PANE_LABEL[pane.id === 'main' ? 'draft' : 'main'];
  items.push(
    { label: `移到另一侧（${side}）`, run: () => moveToOtherSide(pane, path) },
    { sep: true },
    { label: '在文件页中定位', run: () => revealInFiles(path) },
    { label: '复制相对路径', run: () => copyRelPath(path) },
    { sep: true }
  );
  const closed = lastClosed(pane.id);
  items.push({
    label: closed ? `重新打开刚关闭的（${closed.title}）` : '重新打开刚关闭的',
    disabled: !closed,
    run: () => closed && reopenClosed(closed),
  });
  return items;
}

/** 把这一份搬到另一块（第二块还没造出来就现造），在那边成为当前的。 */
export function moveToOtherSide(from: Pane, path: string): void {
  const target = otherPane(from, true);
  if (!target) {
    return;
  }
  const out = from.moveOut(path);
  if (!out) {
    return;
  }
  target.upsertFile(out.view, out.carried);
  // activate：认下那一块、光标与滚动放回原处、焦点进去。
  target.activate(path);
  syncDraftVisibility();
  persist();
}

function copyRelPath(path: string): void {
  if (!navigator.clipboard?.writeText) {
    toast('当前环境不支持剪贴板。', true);
    return;
  }
  navigator.clipboard.writeText(path).then(
    () => toast(`已复制：${path}`),
    () => toast('复制失败，请手动选中。', true)
  );
}
