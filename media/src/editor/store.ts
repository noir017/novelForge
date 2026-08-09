/**
 * 两块编辑区之间共享的那点东西：登记表、当前是哪一块、待恢复的草稿，
 * 以及刷新恢复用的 localStorage 读写。
 *
 * 单独一层的理由是打破环：`pane.ts`（一块编辑区的行为）要调 `persist()`、
 * 要认下自己是 activePane；而「有哪几块」这件事又得等 pane 造出来才知道。
 * 把状态放这儿，方向就只剩 index → pane → store 一条。
 */
import { announceEditorActive } from '../globals';
import type { EditorFileView, InMessage } from '../protocol';
import type { CarriedDraft, OpenFile, PaneId } from './paneElements';

/** 一块编辑区对外的样子。createPane 的返回值实现它。 */
export interface Pane {
  readonly id: PaneId;
  /** 这块区的根节点，供整块显示/隐藏。 */
  readonly root: HTMLElement;
  readonly files: Map<string, OpenFile>;
  activePath: string | null;
  activeFile(): OpenFile | undefined;
  hasDirty(): boolean;
  snapshot(): PaneSnapshot;
  activate(path: string): void;
  closeFile(path: string): void;
  /**
   * 不问不提示地移走一个文件。用于「同一路径被另一块编辑区接管」——
   * 那不是关闭，是搬家：返回未保存内容（没有则返回 true）好让新的一块贴回去。
   */
  closeSilently(path: string): CarriedDraft | boolean;
  upsertFile(incoming: EditorFileView, carried?: CarriedDraft): void;
  save(force: boolean): void;
  applySaved(incoming: EditorFileView): void;
  applyConflict(path: string, diskText: string, diskHash: string): void;
}

export interface PaneSnapshot {
  open: { path: string; hash: string; draft?: string }[];
  active: string | null;
}

const STORE_KEY = 'novelforge.editor.v1';

/** path -> 待恢复的未保存内容，等对应的 editorOpen 到达时消费。 */
export const pendingDrafts = new Map<string, CarriedDraft>();

/** paneId -> 恢复完成后应该激活的 path。 */
export const pendingActive = new Map<PaneId, string | null>();

/** 已经造出来的编辑区。草稿区惰性创建，一开始只有主区。 */
export const panes: Partial<Record<PaneId, Pane>> = {};

/** 把新造的一块登记进来。造与登记分开，createPane 就不必知道这张表。 */
export function registerPane(pane: Pane): Pane {
  panes[pane.id] = pane;
  return pane;
}

/** 由 index.ts 在启动时装上。 */
let post: (msg: InMessage) => void = () => {};
/** 草稿区没有打开的文件时，连同那条分隔条一起收起来。 */
let draftResizer: HTMLElement | undefined;

export function bindStore(deps: {
  post: (msg: InMessage) => void;
  draftResizer: HTMLElement;
}): void {
  post = deps.post;
  draftResizer = deps.draftResizer;
}

/** 当前这一块——Ctrl+S / Ctrl+W 作用于它。 */
export let activePane: Pane;

export function setActivePane(pane: Pane): void {
  activePane = pane;
}

/**
 * 广播「现在编辑的是哪个文件」。资源管理器据此高亮那一行。
 *
 * `activePane` 每次易主都要跟一句，否则高亮会停在上一个文件上。
 */
export function announceActive(): void {
  const file = activePane?.activeFile();
  announceEditorActive(file ? file.path : null);
}

/** 哪一块编辑区持有这个路径。单 pane 拥有权保证结果唯一。 */
export function paneOwning(path: string): Pane | undefined {
  for (const pane of Object.values(panes)) {
    if (pane.files.has(path)) {
      return pane;
    }
  }
  return undefined;
}

/** 草稿区里没有打开的文件时整块收起来，连同那条分隔条。 */
export function syncDraftVisibility(): void {
  const draft = panes.draft;
  const open = !!draft && draft.files.size > 0;
  draft?.root.classList.toggle('hidden', !open);
  draftResizer?.classList.toggle('hidden', !open);
}

// ---------------------------------------------------------------- 持久化

/**
 * 刷新页面不该丢掉未保存的修改——浏览器里 F5 太容易按到。
 * 存的是草稿与基线 hash，重连后重新拉一次文件再比对。
 */
export function persist(): void {
  try {
    const data = {
      v: 2,
      panes: Object.fromEntries(
        Object.entries(panes).map(([id, pane]) => [id, pane.snapshot()])
      ),
      activePane: activePane?.id,
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，丢了也不影响主流程 */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** 敲字时每次都写 localStorage 太浪费，攒一下。 */
export function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

/**
 * 刷新后重开上次的标签页。
 *
 * 这里只发 `openEditor`、把草稿记进 `pendingDrafts`；真正贴回去由
 * `upsertFile` 在文件到达时做，并且要比对 hash——磁盘变过就丢弃草稿，
 * 不拿旧内容盖新内容。
 */
export function restore(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') {
    return;
  }
  const raw = saved as { open?: unknown; active?: unknown; panes?: unknown };

  // v1 只有一块编辑区，形状是 { open, active }——老用户的标签页不该在
  // 升级后凭空消失，按主区读进来。
  const stored: Record<string, { open?: unknown; active?: unknown }> = Array.isArray(raw.open)
    ? { main: { open: raw.open, active: raw.active } }
    : ((raw.panes as Record<string, { open?: unknown; active?: unknown }>) ?? {});

  for (const paneId of ['main', 'draft'] as const) {
    const data = stored[paneId];
    if (!data || !Array.isArray(data.open) || data.open.length === 0) {
      continue;
    }
    pendingActive.set(paneId, typeof data.active === 'string' ? data.active : null);
    for (const item of data.open as { path?: unknown; hash?: unknown; draft?: unknown }[]) {
      if (!item || typeof item.path !== 'string') {
        continue;
      }
      pendingDrafts.set(item.path, {
        hash: typeof item.hash === 'string' ? item.hash : undefined,
        draft: typeof item.draft === 'string' ? item.draft : undefined,
      });
      post({ type: 'openEditor', path: item.path, pane: paneId });
    }
  }
}

/**
 * 文件改名/搬家后，把 localStorage 里的旧路径条目改写成新路径，草稿不丢。
 * 读不下/写不进都无所谓，最坏退化为丢一次刷新恢复。
 */
export function rekeyStorage(from: string, to: string): void {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!data?.panes) {
      return;
    }
    for (const paneData of Object.values(data.panes) as { open?: unknown; active?: unknown }[]) {
      if (Array.isArray(paneData?.open)) {
        for (const item of paneData.open as { path?: string }[]) {
          if (item?.path === from) {
            item.path = to;
          }
        }
      }
      if (paneData?.active === from) {
        paneData.active = to;
      }
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* 同上 */
  }
}
