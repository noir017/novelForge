/**
 * 正文区右键菜单的剪切 / 复制 / 粘贴。
 *
 * 之所以要自己实现这三样：全局 `contextmenu` 监听无条件 `preventDefault()`
 * （菜单风格统一），原生的复制/粘贴菜单不会出现，代价就是这里得补回来。
 *
 * - **复制**不改正文：优先 `execCommand('copy')`（同步、在用户手势里最稳），不行再 Clipboard API。
 * - **剪切 / 粘贴**要改正文，一律经 `Pane.applyEdit`——编辑区唯一的程序改写入口，记一步撤销、
 *   更新脏标记与草稿。从前这里优先 `execCommand('cut' / 'insertText')` 是为了保住 textarea 的
 *   原生撤销栈；撤销现在由编辑器自己记（`history.ts`），这条理由没了，直接拼 `value` 的兜底更是
 *   会绕过记账，一并删掉。
 *
 * 键盘上的 Ctrl+X / Ctrl+V 不经这里：浏览器自己改 textarea、发 `input`，由 `pane.ts` 照常记账。
 */
import { toast } from '../globals';
import type { Pane } from './store';

/** 复制选中的文字。返回是否交给了剪贴板（异步写入事后失败只会提示，返回时还不知道）。 */
export function areaCopy(area: HTMLTextAreaElement): boolean {
  area.focus();
  if (document.execCommand?.('copy')) {
    return true;
  }
  const text = area.value.slice(area.selectionStart, area.selectionEnd);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => toast('复制失败，请手动选中复制。', true));
    return true;
  }
  toast('当前环境不支持剪贴板。', true);
  return false;
}

/** 剪切：先复制，复制交出去了才删——剪切丢字比不剪切糟得多（删了也能撤销回来）。 */
export function areaCut(pane: Pane): void {
  const area = pane.area;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  if (start === end || !areaCopy(area)) {
    return;
  }
  pane.applyEdit(start, end, '');
}

export async function areaPaste(pane: Pane): Promise<void> {
  if (!navigator.clipboard?.readText) {
    toast('当前环境不支持剪贴板读取。', true);
    return;
  }
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('粘贴失败：浏览器未授权剪贴板读取。', true);
    return;
  }
  const area = pane.area;
  area.focus();
  pane.applyEdit(area.selectionStart, area.selectionEnd, text);
}
