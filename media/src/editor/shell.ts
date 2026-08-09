/**
 * 工作台外壳里归编辑器管的那几件事：主题切换、两条分隔条的宽度拖拽、
 * 窄屏下把编辑区翻上来。
 *
 * 都只在独立版存在（插件形态由 VS Code 自己负责这些），所以放在 editor 下面
 * 而不是共用层。
 */
import { byId } from '../dom';

const THEME_KEY = 'novelforge.theme';
const WIDTH_KEY = 'novelforge.sideWidth';
const DRAFT_WIDTH_KEY = 'novelforge.draftWidth';

const DEFAULT_SIDE_WIDTH = 460;
const DEFAULT_DRAFT_WIDTH = 420;
/** 窄屏阈值，与 standalone.css 的 media query 保持一致。 */
const NARROW_WIDTH = 900;

export interface Shell {
  themeBtn: HTMLElement;
  editorToggle: HTMLElement;
  side: HTMLElement;
  resizer: HTMLElement;
  editors: HTMLElement;
  draftResizer: HTMLElement;
}

export function collectShell(): Shell {
  return {
    themeBtn: byId('wbThemeBtn'),
    editorToggle: byId('wbEditorToggle'),
    side: byId('wbSide'),
    resizer: byId('wbResizer'),
    editors: byId('wbEditors'),
    draftResizer: byId('wbDraftResizer'),
  };
}

// ---------------------------------------------------------------- 主题

export function initTheme(shell: Shell): void {
  const apply = (theme: 'dark' | 'light') => {
    document.documentElement.dataset.theme = theme;
    shell.themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
    shell.themeBtn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 存不下就只在本次会话生效 */
    }
  };

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* 读不到就跟随系统 */
  }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  apply(saved === 'light' || saved === 'dark' ? saved : prefersLight ? 'light' : 'dark');

  shell.themeBtn.addEventListener('click', () => {
    apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
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
    shell.side.style.width = `${sideWidth}px`;
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

export function initNarrowToggle(shell: Shell): void {
  shell.editorToggle.addEventListener('click', () => {
    document.body.classList.toggle('editor-open');
  });
}

/** 窄屏下编辑区是覆盖层，打开文件时得把它翻上来。 */
export function revealEditor(): void {
  if (window.innerWidth <= NARROW_WIDTH) {
    document.body.classList.add('editor-open');
  }
}
