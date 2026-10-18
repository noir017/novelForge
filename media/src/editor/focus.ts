/**
 * 专注：专注模式、全屏、打字机滚动、段落聚焦。入口是标题栏「视图 → 专注」那一组（菜单那一半在
 * `view/lookMenu.ts`），状态经 `nf-view-query` 回答、开关经 `nf-view-command` 交过来。三个开关记在
 * `novelforge.editor.prefs`（`focusMode` / `typewriter` / `paragraphFocus`，校验在 `lookCore.ts`），全屏不记。
 *
 * - **专注模式**（快捷键 F8 ⚑，`Esc` 或再按一次退出）：`<body>` 挂 `nf-focus`，`css/standalone/focus.css` 藏起
 *   活动栏、侧栏、标题栏里菜单以外的杂项、标签条、工具栏、章节条，状态栏淡成一行（鼠标移上去才看清；字数那一格照样
 *   点得开码字统计面板）。
 *   **冲突条、查找条、历史版本抽屉照常显示**——前者是「不丢稿」的提醒，后两样是作者自己打开的。两块编辑区都开着时
 *   只专注当前那一块（`activePane`，根节点挂 `ed-focused`），另一块藏起来；当前那一块换了（从别处打开了另一块里的
 *   文件）就跟过去。F8 选它的理由：浏览器与桌面 WebView 都不占它，编辑器里也没用过；Typora 的专注模式也是 F8。
 *   `Esc` 只在别人都不接时退出：查找条、「转到…」、对话框、外观面板、码字统计面板、标题栏与右键菜单先收。
 * - **全屏**：Fullscreen API，**能力探测**（`document.fullscreenEnabled` 且有 `requestFullscreen`），不支持时菜单项置灰。
 *   全屏的是整个页面（菜单栏还在，退出不靠记快捷键）。F11 是浏览器自己的，不抢。
 * - **打字机滚动**（`typewriter.ts`）与**段落聚焦**（`paragraphFocus.ts`）各自一个模块，这里只管开关。
 */
import { toast } from '../globals';
import type { FocusStatus } from '../globals';
import { isImeComposing, onEditorChange } from './api';
import { FOCUS_KEYS, normalizeFocus } from './lookCore';
import type { FocusPrefs } from './lookCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { installParagraphFocus } from './paragraphFocus';
import { revealEditor } from './shell';
import { activePane, panes } from './store';
import { installTypewriter } from './typewriter';

/** 专注模式的快捷键（⚑）。 */
export const FOCUS_MODE_KEY = 'F8';

let prefs: FocusPrefs = { focusMode: false, typewriter: false, paragraphFocus: false };

/** 三个开关当前的值。 */
export function focusPrefs(): FocusPrefs {
  return prefs;
}

function setFocusPref(key: keyof FocusPrefs, on: boolean): void {
  if (prefs[key] !== on) {
    setStoredPrefs({ [key]: on || undefined });
  }
}

// ---------------------------------------------------------------- 全屏

/** 页面能不能全屏：能力探测，不看是哪个浏览器 / 哪个壳。 */
export function fullscreenSupported(): boolean {
  return document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function';
}

function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

function toggleFullscreen(): void {
  if (!fullscreenSupported()) {
    toast('这个浏览器（或窗口）不支持全屏。', true);
    return;
  }
  const done = isFullscreen() ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  void Promise.resolve(done).catch(() => toast('没能切换全屏（浏览器拒绝了）。', true));
}

// ---------------------------------------------------------------- 专注模式

/** 当前专注的那一块挂 `ed-focused`；不在专注模式时谁都不挂。 */
function syncFocusedPane(): void {
  const on = prefs.focusMode;
  for (const pane of Object.values(panes)) {
    pane.root.classList.toggle('ed-focused', on && pane === activePane);
  }
}

function applyFocusMode(): void {
  document.body.classList.toggle('nf-focus', prefs.focusMode);
  syncFocusedPane();
  if (prefs.focusMode) {
    // 窄屏下编辑区是覆盖层，得翻上来。
    revealEditor();
  }
}

function toggleFocusMode(): void {
  setFocusPref('focusMode', !prefs.focusMode);
}

/**
 * 刚进专注模式：焦点原本在被藏起来的地方（左边的对话输入框之类）时放进正文——不然光标落在一个看不见的框里，
 * 打的字不知道去了哪儿。焦点本来就在这一块里（编辑区、查找框）的不动。
 */
function keepFocusInside(): void {
  const pane = activePane;
  if (!pane?.activeFile() || pane.isPreviewing() || pane.root.contains(document.activeElement)) {
    return;
  }
  pane.area.focus();
}

function status(): FocusStatus {
  return {
    focusMode: prefs.focusMode,
    typewriter: prefs.typewriter,
    paragraphFocus: prefs.paragraphFocus,
    fullscreen: isFullscreen(),
    fullscreenSupported: fullscreenSupported(),
  };
}

export function installFocus(): void {
  prefs = normalizeFocus(storedPrefs());
  // 打字机滚动、段落聚焦各自订阅编辑区的变化，问这里开着没有；开关变了叫它们 `refresh` 一下。
  const typewriter = installTypewriter(() => prefs.typewriter);
  const paragraph = installParagraphFocus(() => prefs.paragraphFocus);
  applyFocusMode();
  typewriter.refresh();
  paragraph.refresh();

  onPrefsChange(() => {
    const next = normalizeFocus(storedPrefs());
    const changed = FOCUS_KEYS.filter((k) => next[k] !== prefs[k]);
    if (changed.length === 0) {
      return;
    }
    prefs = next;
    if (changed.includes('focusMode')) {
      applyFocusMode();
      if (prefs.focusMode) {
        keepFocusInside();
      }
    }
    if (changed.includes('typewriter')) {
      typewriter.refresh();
    }
    if (changed.includes('paragraphFocus')) {
      paragraph.refresh();
    }
  });

  // 当前那一块换了（从别处打开了另一块里的文件）：专注跟过去。
  onEditorChange((ev) => {
    if (ev.type === 'render' && prefs.focusMode) {
      syncFocusedPane();
    }
  });

  // 这一下 Esc 按下去的时候有没有菜单开着（标题栏的下拉、右键菜单）：它们在 document 的冒泡阶段收自己，
  // 比这里先跑、也不 preventDefault，等轮到这里菜单已经没了——所以在捕获阶段先记一笔。
  let menuWasOpen = false;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        menuWasOpen = !!document.querySelector('.wb-menu-drop, .ctx-menu');
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e)) {
      return;
    }
    if (e.key === FOCUS_MODE_KEY && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      toggleFocusMode();
      return;
    }
    // Esc 退出专注模式。别人已经接走的 Esc（查找条收起、「转到…」关掉、对话框取消、收菜单）不算——那些先退；
    // 外观面板、码字统计面板在捕获阶段就吞掉了它，根本到不了这里。
    if (
      e.key === 'Escape' &&
      prefs.focusMode &&
      !e.defaultPrevented &&
      !menuWasOpen &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !document.querySelector('.modal-overlay:not(.hidden)')
    ) {
      e.preventDefault();
      setFocusPref('focusMode', false);
    }
  });

  window.addEventListener('nf-view-query', (e) => {
    e.detail.focus = status();
  });

  window.addEventListener('nf-view-command', (e) => {
    switch (e.detail.name) {
      case 'toggleFocusMode':
        toggleFocusMode();
        break;
      case 'toggleFullscreen':
        toggleFullscreen();
        break;
      case 'toggleTypewriter':
        setFocusPref('typewriter', !prefs.typewriter);
        break;
      case 'toggleParagraphFocus':
        setFocusPref('paragraphFocus', !prefs.paragraphFocus);
        break;
    }
  });
}
