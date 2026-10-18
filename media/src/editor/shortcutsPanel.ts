/**
 * 「帮助 → 快捷键一览」与 `Ctrl+/`（⚑）：一个页内面板，按分组列出 `shortcuts.ts` 那张表——键（按平台写，Mac 上 ⌘ / ⌥）、
 * 做什么、在哪儿管用、补充说明（浏览器拦不住的那几个写在这里），顶上一个筛选框。
 *
 * 写法与样式照 `dialog.ts`：DOM 现造现拆、页面模板里没有它，外观复用 `css/view/modal.css` 那一套（`.modal-overlay` /
 * `.modal` / `.modal-head` / `.modal-body`），焦点进筛选框、关掉之后回到打开之前的地方。它是模态的（外面那一层是
 * `.modal-overlay`，`Ctrl+P` 之类开着时不开），但不是一问一答：不算 `isDialogOpen()`（不拦自动保存），开着时别的
 * 快捷键照常（筛选框里 `Ctrl+A` / `Ctrl+V` 要能用）。`Esc`、点外面那一层、×、再按一下 `Ctrl+/` 都关。
 *
 * 只在独立版：它在 editor.js 里，插件形态没有内置编辑器、也没有标题栏，`editor/index.ts` 探测不到 `#wbEditor` 就整个不装。
 */
import { el } from '../dom';
import { isImeComposing } from './api';
import {
  SHORTCUTS,
  filterShortcuts,
  formatKey,
  groupShortcuts,
  isMacPlatform,
  matchesShortcut,
  scopeText,
} from './shortcuts';
import type { Shortcut } from './shortcuts';

interface Panel {
  overlay: HTMLElement;
  input: HTMLInputElement;
}

let panel: Panel | undefined;

/**
 * 打开（开着就把焦点放回筛选框）。别的弹窗（`.modal-overlay`：设置里的服务商弹窗、表单、页内对话框）开着时不开，
 * 返回 false。
 */
export function openShortcutsPanel(): boolean {
  if (panel) {
    panel.input.focus();
    return true;
  }
  if (document.querySelector('.modal-overlay:not(.hidden)')) {
    return false;
  }
  panel = buildPanel();
  return true;
}

function buildPanel(): Panel {
  const previous = document.activeElement as HTMLElement | null;
  const mac = isMacPlatform();

  const overlay = el('div', 'modal-overlay ed-keys-overlay');
  const box = el('div', 'modal ed-keys');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const titleId = `edKeysTitle${Date.now().toString(36)}`;
  box.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'modal-head');
  const title = el('span', 'modal-title', '快捷键一览');
  title.id = titleId;
  const x = el('button', 'icon-btn ed-keys-x', '×');
  x.type = 'button';
  x.title = '关闭（Esc）';
  head.append(title, x);

  const body = el('div', 'modal-body');
  const input = el('input', 'ed-keys-filter');
  input.type = 'search';
  input.placeholder = mac ? '筛选：按键或说明，比如 ⌘F、查找、预览' : '筛选：按键或说明，比如 Ctrl+F、查找、预览';
  input.setAttribute('aria-label', '筛选快捷键');
  const list = el('div', 'ed-keys-list');
  const count = el('p', 'hint ed-keys-count');
  body.append(input, count, list);
  box.append(head, body);
  overlay.appendChild(box);

  const render = (): void => {
    const shown = filterShortcuts(SHORTCUTS, input.value);
    list.replaceChildren();
    if (shown.length === 0) {
      list.appendChild(el('p', 'ed-keys-empty', '没有匹配的快捷键。'));
    }
    for (const { group, items } of groupShortcuts(shown)) {
      const section = el('section', 'ed-keys-group');
      section.appendChild(el('h3', 'ed-keys-group-title', group));
      const table = el('div', 'ed-keys-table');
      for (const s of items) {
        table.appendChild(row(s, mac));
      }
      section.appendChild(table);
      list.appendChild(section);
    }
    count.textContent = input.value.trim()
      ? `找到 ${shown.length} 个（一共 ${SHORTCUTS.length} 个）`
      : `一共 ${SHORTCUTS.length} 个。标着「浏览器多半拦不住」的，在浏览器里会被浏览器拿去，桌面版里管用。`;
  };
  render();
  // 组字中途不筛（拼音字母不算），上屏那一下再筛。
  input.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      render();
    }
  });
  input.addEventListener('compositionend', render);

  const onKey = (e: KeyboardEvent): void => {
    if (isImeComposing(e)) {
      return;
    }
    // 开着时 Esc 只收这一个面板（不连带退出专注模式、不收查找条）；再按一下 Ctrl+/ 也是关。
    if (e.key === 'Escape' || matchesShortcut(e, 'shortcuts')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // 点外面那一层（不是面板本身）就关。
  const onDown = (e: MouseEvent): void => {
    if (e.target === overlay) {
      e.preventDefault();
      close();
    }
  };
  // Tab 不出面板：焦点被挪到外面去了就拉回筛选框。
  const keepFocus = (e: FocusEvent): void => {
    if (!box.contains(e.target as Node)) {
      input.focus();
    }
  };

  function close(): void {
    if (panel?.overlay !== overlay) {
      return;
    }
    panel = undefined;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', keepFocus, true);
    overlay.remove();
    if (previous?.isConnected) {
      previous.focus();
    }
  }

  x.addEventListener('click', close);
  overlay.addEventListener('mousedown', onDown);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', keepFocus, true);
  document.body.appendChild(overlay);
  input.focus();
  return { overlay, input };
}

/** 一行：键（几种按法各一个 `<kbd>`）、做什么（下面一行小字是补充说明）、在哪儿管用。 */
function row(s: Shortcut, mac: boolean): HTMLElement {
  const line = el('div', 'ed-keys-row');
  line.dataset.id = s.id;
  const keys = el('span', 'ed-keys-keys');
  s.keys.forEach((spec, i) => {
    if (i > 0) {
      keys.appendChild(el('span', 'ed-keys-or', ' / '));
    }
    keys.appendChild(el('kbd', undefined, formatKey(spec, mac)));
  });
  const what = el('span', 'ed-keys-label', s.label);
  if (s.note) {
    what.appendChild(el('span', 'hint ed-keys-note', s.note));
  }
  line.append(keys, what, el('span', 'ed-keys-where', scopeText(s)));
  return line;
}

let installed = false;

/** 装上 `Ctrl+/` 与「帮助 → 快捷键一览」的编辑器那一半。`editor/index.ts` 调一次。 */
export function installShortcutsPanel(): void {
  if (installed) {
    return;
  }
  installed = true;

  // 哪里都认（对话输入框里也是：这个键在那里没有别的用处）；开着时由面板自己在捕获阶段接走、关掉。
  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !matchesShortcut(e, 'shortcuts')) {
      return;
    }
    if (openShortcutsPanel()) {
      e.preventDefault();
    }
  });

  window.addEventListener('nf-shortcuts-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-shortcuts-command', () => openShortcutsPanel());
}
