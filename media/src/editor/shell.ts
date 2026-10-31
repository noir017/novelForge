/**
 * 工作台外壳里归编辑器管的那几件事：主题切换、两条分隔条的宽度拖拽、
 * 窄屏下把编辑区翻上来。
 *
 * 都只在独立版存在（插件形态由 VS Code 自己负责这些），所以放在 editor 下面
 * 而不是共用层。
 */
import { byId } from '../dom';
import { narrowScreen } from '../narrow';

const THEME_KEY = 'novelforge.theme';
const WIDTH_KEY = 'novelforge.sideWidth';
const DRAFT_WIDTH_KEY = 'novelforge.draftWidth';

const DEFAULT_SIDE_WIDTH = 460;
const DEFAULT_DRAFT_WIDTH = 420;

export interface Shell {
  themeBtn: HTMLElement;
  side: HTMLElement;
  resizer: HTMLElement;
  editors: HTMLElement;
  draftResizer: HTMLElement;
}

export function collectShell(): Shell {
  return {
    themeBtn: byId('wbThemeBtn'),
    side: byId('wbSide'),
    resizer: byId('wbResizer'),
    editors: byId('wbEditors'),
    draftResizer: byId('wbDraftResizer'),
  };
}

// ---------------------------------------------------------------- 主题

/**
 * 三套主题：深色、浅色、护眼（米黄）。切换只有这一条路——`<html data-theme>` 换值，`css/standalone/theme.css`
 * 里每套一组变量；记在 localStorage `novelforge.theme`（从前就在那儿，不并进编辑器偏好）。标题栏那颗按钮按
 * 深色 → 浅色 → 护眼 → 深色轮着换，外观面板（`lookPanel.ts`）里可以直接挑。护眼管整个界面，不只编辑区（⚑）：
 * 一半米黄一半深色，交界处更刺眼。
 */
export type Theme = 'dark' | 'light' | 'sepia';

export const THEMES: readonly Theme[] = ['dark', 'light', 'sepia'];

export const THEME_LABEL: Record<Theme, string> = { dark: '深色', light: '浅色', sepia: '护眼（米黄）' };

/** 按钮上画的是**下一套**的样子（与从前「深色时画 ☀」一致）。 */
const THEME_ICON: Record<Theme, string> = { dark: '☾', light: '☀', sepia: '◐' };

let themeBtn: HTMLElement | undefined;

function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : 'dark';
}

/** 换主题并记下来。 */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  if (themeBtn) {
    const next = nextTheme(theme);
    themeBtn.textContent = THEME_ICON[next];
    themeBtn.title = `切换到${THEME_LABEL[next]}主题`;
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

export function initTheme(shell: Shell): void {
  themeBtn = shell.themeBtn;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* 读不到就跟随系统 */
  }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  setTheme(isTheme(saved) ? saved : prefersLight ? 'light' : 'dark');

  shell.themeBtn.addEventListener('click', () => setTheme(nextTheme(currentTheme())));
}

// ---------------------------------------------------------------- 拖拽调宽

/** 两条分隔条共用一套指针拖拽：区别只在「拖到哪算多宽」。 */
function makeResizer(
  handle: HTMLElement,
  onDrag: (e: PointerEvent) => void,
  onCommit: () => void,
  onReset: () => void
): void {
  let dragging = false;
  const stop = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    onCommit();
  };

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) {
      onDrag(e);
    }
  });
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', onReset);
}

function readStoredNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function storeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

export function initResizers(shell: Shell): void {
  let sideWidth = DEFAULT_SIDE_WIDTH;
  let draftWidth = DEFAULT_DRAFT_WIDTH;

  // 两侧都留出可用空间，别让谁被拖没。
  const setSideWidth = (px: number) => {
    sideWidth = Math.max(300, Math.min(px, Math.max(320, window.innerWidth - 360)));
    // 写变量不写 width：行内的 width 压得过窄屏那条 `width: auto`，桌面上拖宽过的人把窗口缩窄（或分屏）时，
    // 侧栏会顶着几百像素的宽度把整页撑出横向滚动。
    shell.side.style.setProperty('--nf-side-width', `${sideWidth}px`);
  };
  const setDraftWidth = (px: number) => {
    draftWidth = Math.max(240, Math.min(px, Math.max(260, window.innerWidth - 640)));
    shell.editors.style.setProperty('--nf-draft-width', `${draftWidth}px`);
  };

  const savedSide = readStoredNumber(WIDTH_KEY);
  if (savedSide) {
    setSideWidth(savedSide);
  }
  setDraftWidth(readStoredNumber(DRAFT_WIDTH_KEY) || DEFAULT_DRAFT_WIDTH);

  makeResizer(
    shell.resizer,
    (e) => {
      // 左边还有一条 62px 的活动栏，拖拽位置要把它减掉。
      const bar = document.getElementById('tabbar');
      const offset = bar ? bar.getBoundingClientRect().right : 0;
      setSideWidth(e.clientX - offset);
    },
    () => storeNumber(WIDTH_KEY, sideWidth),
    () => setSideWidth(DEFAULT_SIDE_WIDTH)
  );

  makeResizer(
    shell.draftResizer,
    // 草稿区在分隔条右边：往右拖是把它压窄。
    (e) => setDraftWidth(shell.editors.getBoundingClientRect().right - e.clientX),
    () => storeNumber(DRAFT_WIDTH_KEY, draftWidth),
    () => setDraftWidth(DEFAULT_DRAFT_WIDTH)
  );
}

// ---------------------------------------------------------------- 窄屏

/** 窄屏：编辑区是盖在侧栏上的一层，底栏「正文」翻它上来（view/mobileNav.ts），草稿区不显示。 */
export const isNarrow = narrowScreen;

/** 窄屏下编辑区是覆盖层，打开文件时得把它翻上来。 */
export function revealEditor(): void {
  if (isNarrow()) {
    document.body.classList.add('editor-open');
  }
}

/** 窄屏下要看侧栏（编辑区工具栏「历史」切到「版本」页）：把编辑区翻下去。 */
export function revealSide(): void {
  document.body.classList.remove('editor-open');
}
