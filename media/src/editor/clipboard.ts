/**
 * 正文区的剪切/复制/粘贴。
 *
 * 优先 `execCommand`——它保留 textarea 的**原生撤销栈**，这在写作时很要紧：
 * 用手动拼接 value 代替，Ctrl+Z 就再也退不回去了。Clipboard API 作为读剪贴板
 * 的正路（粘贴）与写不进去时的兜底。
 *
 * 之所以要自己实现这三样：全局 `contextmenu` 监听无条件 `preventDefault()`
 * （菜单风格统一），原生的复制/粘贴菜单不会出现，代价就是这里得补回来。
 */
import { toast } from '../globals';

/** 手动改过 value 之后补一发 input：脏标记、字数、自动存草稿都挂在它上面。 */
function notifyInput(area: HTMLTextAreaElement): void {
  area.dispatchEvent(new Event('input'));
}

export function areaCopy(area: HTMLTextAreaElement): void {
  area.focus();
  if (document.execCommand?.('copy')) {
    return;
  }
  const text = area.value.slice(area.selectionStart, area.selectionEnd);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => toast('复制失败，请手动选中复制。', true));
  } else {
    toast('当前环境不支持剪贴板。', true);
  }
}

export function areaCut(area: HTMLTextAreaElement): void {
  area.focus();
  if (document.execCommand?.('cut')) {
    return;
  }
  // 兜底：先复制再手动删选区。
  areaCopy(area);
  const start = area.selectionStart;
  area.value = area.value.slice(0, start) + area.value.slice(area.selectionEnd);
  area.selectionStart = area.selectionEnd = start;
  notifyInput(area);
}

export async function areaPaste(area: HTMLTextAreaElement): Promise<void> {
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
  area.focus();
  // insertText 保留撤销栈；不支持时退回手动拼接（丢撤销，但能贴上）。
  if (document.execCommand?.('insertText', false, text)) {
    return;
  }
  const start = area.selectionStart;
  area.value = area.value.slice(0, start) + text + area.value.slice(area.selectionEnd);
  area.selectionStart = area.selectionEnd = start + text.length;
  notifyInput(area);
}

/**
 * Tab 在 textarea 里默认是切焦点；写作时更需要它插缩进。
 * Shift+Tab 反向：行首有两个空格就去掉。
 */
export function handleTabKey(area: HTMLTextAreaElement, e: KeyboardEvent): void {
  e.preventDefault();
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const value = area.value;

  if (e.shiftKey) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    if (value.slice(lineStart, lineStart + 2) === '  ') {
      area.value = value.slice(0, lineStart) + value.slice(lineStart + 2);
      area.selectionStart = area.selectionEnd = Math.max(lineStart, start - 2);
      notifyInput(area);
    }
    return;
  }

  area.value = `${value.slice(0, start)}  ${value.slice(end)}`;
  area.selectionStart = area.selectionEnd = start + 2;
  notifyInput(area);
}
