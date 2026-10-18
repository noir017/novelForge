/**
 * 外观：正文字体、字号、行距、版心宽度（取值与校验在 `lookCore.ts`），护眼主题（与深 / 浅同一个机制，
 * 在 `shell.ts`）。入口是标题栏「视图 → 外观」那一组（菜单那一半在 `view/lookMenu.ts`）与外观面板（`lookPanel.ts`）。
 *
 * - **记在哪**：`novelforge.editor.prefs`，与成对符号、自动保存同一处（`paragraphState.ts` 的
 *   `storedPrefs` / `setStoredPrefs`）；主题照旧记在 `novelforge.theme`。
 * - **怎么生效**：一组 CSS 变量写在 `<html>` 上（`lookVars`）。textarea、高亮镜像层、预览在 `css/standalone/look.css`
 *   里读同一组变量——**这里不往哪个元素上单写字号**，镜像层要与 textarea 排得一模一样，变量是唯一的那一份。
 *   镜像层每次重画仍从 textarea 的计算样式抄一遍（`highlight.ts`），两道保险。变量一变，这里让每块编辑区的
 *   镜像层当场重抄、重摆（`relayoutMirror`：尺寸没变时 `ResizeObserver` 不会叫，换了字号却必须重排）。
 * - **字号快捷键**：`Ctrl+=`（或 `Ctrl++`）放大、`Ctrl+-` 缩小、`Ctrl+0` 还原，**只在焦点在编辑区（正文的
 *   textarea）里时拦**——挂在 `addKeyHandler` 上，输入法组字中途的不收。焦点在别处时浏览器照常缩放整页。
 */
import { toast } from '../globals';
import type { LookStatus } from '../globals';
import { addKeyHandler } from './api';
import { relayoutMirror } from './highlight';
import { openLookPanel } from './lookPanel';
import {
  DEFAULT_LOOK,
  FONT_SIZE,
  LOOK_KEYS,
  lookVars,
  normalizeLook,
  sameLook,
  stepFontSize,
} from './lookCore';
import type { LookPrefs } from './lookCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { panes } from './store';

let look: LookPrefs = { ...DEFAULT_LOOK };
const listeners = new Set<() => void>();

/** 当前的外观（已校验）。 */
export function currentLook(): LookPrefs {
  return look;
}

/** 改几项（逐项校验之后记下来、当场生效）。 */
export function setLook(patch: Partial<LookPrefs>): void {
  const next = normalizeLook({ ...look, ...patch });
  if (sameLook(next, look)) {
    return;
  }
  setStoredPrefs(Object.fromEntries(LOOK_KEYS.map((k) => [k, next[k]])));
}

/** 恢复默认：从偏好里删掉这几项（以后缺省改了也跟着走），不碰主题。 */
export function resetLook(): void {
  setStoredPrefs(Object.fromEntries(LOOK_KEYS.map((k) => [k, undefined])));
}

/** 外观变了时通知（面板据此刷新显示）。 */
export function onLookChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 字号放大 / 缩小一档；到头了说一句。 */
export function zoom(dir: 1 | -1): void {
  const size = stepFontSize(look.fontSize, dir);
  if (size === look.fontSize) {
    toast(dir > 0 ? `字号已经是最大（${size}px）` : `字号已经是最小（${size}px）`);
    return;
  }
  setLook({ fontSize: size });
  toast(`字号 ${size}px`);
}

export function zoomReset(): void {
  if (look.fontSize !== DEFAULT_LOOK.fontSize) {
    setLook({ fontSize: DEFAULT_LOOK.fontSize });
  }
  toast(`字号 ${DEFAULT_LOOK.fontSize}px（缺省）`);
}

/** 把这组变量写到 `<html>` 上。 */
function applyVars(): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(lookVars(look))) {
    style.setProperty(name, value);
  }
}

/** 偏好变了（这里改的，或别处——只认外观这几项）：重算、写变量、让各块编辑区按新排版重画。 */
function sync(): void {
  const next = normalizeLook(storedPrefs());
  if (sameLook(next, look)) {
    return;
  }
  look = next;
  applyVars();
  for (const pane of Object.values(panes)) {
    relayoutMirror(pane);
  }
  for (const fn of [...listeners]) {
    fn();
  }
}

/**
 * 这一下是哪个字号快捷键。按 `key` 认（各种键盘布局上浏览器自己的页面缩放也是按它认的），小键盘的 + − 0 另按
 * `code` 认；不按主键盘的物理位置认——德语、法语布局上那几个位置是别的字（`ß`、`)`），不该被当成缩放。
 */
function zoomKey(e: KeyboardEvent): 1 | -1 | 0 | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return undefined;
  }
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') {
    return 1;
  }
  if (e.key === '-' || e.code === 'NumpadSubtract') {
    return -1;
  }
  if ((e.key === '0' && !e.shiftKey) || e.code === 'Numpad0') {
    return 0;
  }
  return undefined;
}

function status(): LookStatus {
  return {
    fontSize: look.fontSize,
    defaultFontSize: DEFAULT_LOOK.fontSize,
    canZoomIn: look.fontSize < FONT_SIZE.max,
    canZoomOut: look.fontSize > FONT_SIZE.min,
  };
}

export function installLook(): void {
  look = normalizeLook(storedPrefs());
  applyVars();
  onPrefsChange(sync);

  // 只在编辑区里拦：`addKeyHandler` 只收 textarea 的 keydown（组字中途的不收），焦点在别处时浏览器照常缩放。
  addKeyHandler((e) => {
    const dir = zoomKey(e);
    if (dir === undefined) {
      return false;
    }
    if (dir === 0) {
      zoomReset();
    } else {
      zoom(dir);
    }
    return true;
  });

  window.addEventListener('nf-view-query', (e) => {
    e.detail.look = status();
  });

  window.addEventListener('nf-view-command', (e) => {
    switch (e.detail.name) {
      case 'zoomIn':
        zoom(1);
        break;
      case 'zoomOut':
        zoom(-1);
        break;
      case 'zoomReset':
        zoomReset();
        break;
      case 'openLook':
        openLookPanel();
        break;
    }
  });
}
