/**
 * 资源管理器的全部可变状态，以及 localStorage 的读写。
 *
 * 单独拎出来的理由：rows.ts 建行时要读展开集合、剪贴板、当前高亮，
 * index.ts 收消息时要写它们——把状态摊在模块作用域里，两边就都不必
 * 互相 import 对方的内部字段。
 */
import type { DirListing, FsEntry } from '../protocol';

const OPEN_KEY = 'novelforge.files.open';

/** 剪贴板：剪切/复制只是登记，真正的磁盘动作只有「粘贴」一次。 */
export interface Clipboard {
  op: 'cut' | 'copy';
  paths: string[];
}

/**
 * 展开着的目录（工程内相对路径，空串是工程根）。
 *
 * 工程根永远在集合里：它就是这棵树本身，折叠它等于把整页清空。
 */
export const openDirs = new Set<string>(['']);

/** relPath -> DirListing。后端整批替换，这里也整批更新。 */
export const listings = new Map<string, DirListing>();

/** 已经请求过、还没等到回应的目录：画一行「载入中…」而不是空白。 */
export const pending = new Set<string>();

/** 可变的那几项。放在一个对象里，跨模块读写才拿得到最新值。 */
export const state: {
  /** 编辑器里当前激活的文件路径，树上高亮它。 */
  activeFile: string | null;
  clipboard: Clipboard | null;
  /** 当前选中行（点击或键盘焦点到达的行）。Ctrl+X/C/V 作用在它上面。 */
  selectedEntry: FsEntry | null;
} = {
  activeFile: null,
  clipboard: null,
  selectedEntry: null,
};

export function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/** 这一项是不是剪切的源（行要压暗）。 */
export function isCut(relPath: string): boolean {
  return state.clipboard?.op === 'cut' && state.clipboard.paths.includes(relPath);
}

/**
 * 折叠一个目录时，连同它的子目录一起收起来：再展开时它们不该凭空还开着，
 * 后端那边也不必继续为看不见的目录读盘。
 */
export function collapse(relPath: string): void {
  openDirs.delete(relPath);
  for (const dir of [...openDirs]) {
    if (dir.startsWith(`${relPath}/`)) {
      openDirs.delete(dir);
    }
  }
}

/** 展开到某个路径（含其全部祖先目录）。「定位当前文件」与外部跳转用。 */
export function expandTo(relPath: string): void {
  const parts = relPath.split('/');
  let cur = '';
  // 最后一段是文件本身，不进展开集合。
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    openDirs.add(cur);
  }
}

/** 把已有结果标记为待刷新，但不清空——清了会闪一下白。 */
export function markAllPending(): void {
  for (const dir of openDirs) {
    pending.add(dir);
  }
}

export function persistOpen(): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openDirs]));
  } catch {
    /* 隐私模式下写不进去，退化为仅本次会话保留 */
  }
}

export function restoreOpen(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
  } catch {
    return;
  }
  if (!Array.isArray(saved)) {
    return;
  }
  for (const dir of saved) {
    if (typeof dir === 'string') {
      openDirs.add(dir);
    }
  }
}
