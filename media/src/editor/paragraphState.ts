/**
 * 段落那几个功能（回车、成对符号、段落快捷键、一键排版）共用的两样状态：
 *
 * - **分段格式**：工程级设置（`config.md` 的 `paragraphStyle`），后端说了算。从 `init` / `state`
 *   （`ViewState.paragraphStyle`，哪个页签都会推）与 `project`（工程树，只在「工程」页签开着时推）里取，
 *   没收到之前按缺省 `blank`。前端不改它——切换走标题栏「编辑 → 段落格式」发 `setParagraphStyle`，
 *   后端写完 `pushState`，新值随下一条 `state` 回来。
 * - **编辑器偏好**：按浏览器记、不进工程的开关，存 localStorage `novelforge.editor.prefs`（不按工程分键：
 *   这是作者的手感，不是这本书的设置）。三项：成对符号自动补全（缺省开）、自动保存（缺省关，见
 *   `autosave.ts`）、单击打开为临时标签（缺省开，标题栏「视图」菜单，见 `viewPrefs.ts`）。localStorage
 *   不可写（隐私模式、jsdom 的 about:blank）时照样在内存里生效，只是刷新后回到缺省。
 *   同一个对象里还平铺着别的模块记的几项——外观与专注（`look.ts` / `focus.ts`，校验在 `lookCore.ts`）、码字统计的
 *   `stats` 子对象（`stats.ts`）。这里不认识它们，但**谁写都是读出整份、合上自己那几项再整份写回**
 *   （`storedPrefs` / `setStoredPrefs`），谁也不冲掉谁；读回来的坏值由各自的模块逐项回落缺省。
 */
import { DEFAULT_PARAGRAPH_STYLE, isParagraphStyle } from '../protocol';
import type { ParagraphStyle } from '../protocol';
import { onMessage } from '../vscodeApi';

export const PREFS_KEY = 'novelforge.editor.prefs';

interface EditorPrefs {
  autoPair: boolean;
  autoSave: boolean;
  previewTabs: boolean;
}

let style: ParagraphStyle = DEFAULT_PARAGRAPH_STYLE;
/**
 * 整份偏好在内存里的那一份（含这里不认识的那几项）。localStorage 读得到时每次读都以它为准（别的模块、别的窗口
 * 可能刚写过）；读不了 / 写不进时（`storageOk` 落成 false）以内存里这一份为准，照样生效。
 * 这两个要在 `loadPrefs()` 之前声明：它会读它们。
 */
let stored: Record<string, unknown> = {};
let storageOk = true;
let prefs: EditorPrefs = loadPrefs();
const prefListeners = new Set<() => void>();

/** 当前工程的分段格式。 */
export function paragraphStyle(): ParagraphStyle {
  return style;
}

/** 成对符号自动补全开着没有。 */
export function autoPairEnabled(): boolean {
  return prefs.autoPair;
}

export function setAutoPair(on: boolean): void {
  setPref('autoPair', on);
}

/** 自动保存开着没有（缺省关）。 */
export function autoSaveEnabled(): boolean {
  return prefs.autoSave;
}

export function setAutoSave(on: boolean): void {
  setPref('autoSave', on);
}

/** 单击打开为临时标签（缺省开）。 */
export function previewTabsEnabled(): boolean {
  return prefs.previewTabs;
}

export function setPreviewTabs(on: boolean): void {
  setPref('previewTabs', on);
}

function setPref(key: keyof EditorPrefs, on: boolean): void {
  if (prefs[key] === on) {
    return;
  }
  prefs = { ...prefs, [key]: on };
  savePrefs();
  notifyPrefs();
}

function notifyPrefs(): void {
  for (const fn of [...prefListeners]) {
    fn();
  }
}

/**
 * `novelforge.editor.prefs` 现存的那一整份（不是对象就当空对象）。往这个键里记东西的模块都先读它、合上自己那几项
 * 再整份写回（这里的 `setPref` / `setStoredPrefs`、码字统计的 `stats.ts`）。各项的值原样给，由各自的模块校验。
 */
export function storedPrefs(): Readonly<Record<string, unknown>> {
  if (!storageOk) {
    return stored;
  }
  let text: string | null;
  try {
    text = localStorage.getItem(PREFS_KEY);
  } catch {
    // 读不了（隐私模式、about:blank）：以内存里那一份为准。
    storageOk = false;
    return stored;
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(text || 'null');
  } catch {
    /* 写坏了（不是 JSON）：当没记过，各项回落缺省；下一次写把它整份换掉 */
  }
  stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return stored;
}

/**
 * 往同一处写几项（外观、专注），与上面三项一起整份写回、一起通知订阅者。值给 `undefined` 就是删掉这一项
 * （回到缺省）。上面三项不经这里改。
 */
export function setStoredPrefs(patch: Record<string, unknown>): void {
  writeAll({ ...storedPrefs(), ...patch, ...prefs });
  notifyPrefs();
}

/** 偏好变了时通知（成对符号关掉时要丢掉手上记着的那几对；自动保存开关要刷新状态栏）。 */
export function onPrefsChange(fn: () => void): () => void {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

/** 跟着后端推来的 `ViewState` / 工程树更新分段格式。启动时装一次。 */
export function trackParagraphStyle(): void {
  onMessage((msg) => {
    if (msg.type === 'init' || msg.type === 'state') {
      take(msg.state.paragraphStyle);
    } else if (msg.type === 'project') {
      take(msg.tree.paragraphStyle);
    }
  });
}

/** 旧后端推来的没有这个字段：留着原来的值，不回落。 */
function take(value: unknown): void {
  if (isParagraphStyle(value)) {
    style = value;
  }
}

function loadPrefs(): EditorPrefs {
  const raw = storedPrefs() as Partial<Record<keyof EditorPrefs, unknown>>;
  // 自动保存只认明明白白的 true：缺省关，写坏了也当关。临时标签与成对符号缺省开，只认明明白白的 false。
  return { autoPair: raw.autoPair !== false, autoSave: raw.autoSave === true, previewTabs: raw.previewTabs !== false };
}

function savePrefs(): void {
  writeAll({ ...storedPrefs(), ...prefs });
}

/** 整份写回（`undefined` 的项 JSON 里自然没有）。写不进就只在内存里生效，之后读也只认内存里那一份。 */
function writeAll(next: Record<string, unknown>): void {
  stored = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    storageOk = false;
  }
}
