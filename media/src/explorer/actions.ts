/**
 * 发给后端的那几条消息，以及剪贴板动作。
 *
 * 单独一层的理由：rows.ts（建菜单项）与 index.ts（工具栏、快捷键）都要用，
 * 而它们之间不该互相 import。
 *
 * `bind` 是这一层与渲染之间唯一的接缝：改剪贴板、展开目录之后要重画一遍树，
 * 但 render 住在 index.ts 里，直接 import 会绕成一个环。由 index.ts 启动时
 * 把它递进来，方向就只有一条。
 */
import { toast } from '../globals';
import type { InMessage } from '../protocol';
import { collapse, listings, markAllPending, openDirs, pending, persistOpen, state } from './state';

let post: (msg: InMessage) => void = () => {};
let repaint: () => void = () => {};

export function bind(deps: { post: (msg: InMessage) => void; render: () => void }): void {
  post = deps.post;
  repaint = deps.render;
}

/**
 * 把当前展开集合整个报给后端。折叠也走这条——少一条「取消关注」的消息；
 * 后端据此记住该关注哪些目录，工程有变动时原样重推。
 */
export function requestDirs(): void {
  const dirs = [...openDirs];
  for (const dir of dirs) {
    if (!listings.has(dir)) {
      pending.add(dir);
    }
  }
  post({ type: 'listDir', dirs });
}

/** 展开/折叠一个目录。 */
export function toggleDir(relPath: string): void {
  if (openDirs.has(relPath)) {
    collapse(relPath);
  } else {
    openDirs.add(relPath);
  }
  persistOpen();
  // 先请求再画：requestDirs 会把没数据的目录记进 pending，顺序反了
  // 刚展开的那一层会显示「（未载入）」而不是「载入中…」。
  requestDirs();
  repaint();
}

/** 让后端重新读一遍盘。已有结果保持显示，只标记待刷新，避免闪「载入中」。 */
export function refresh(): void {
  markAllPending();
  requestDirs();
}

export function setClipboard(op: 'cut' | 'copy', paths: string[]): void {
  state.clipboard = { op, paths };
  // 相对路径同时以纯文本写进系统剪贴板（仅外送，不读回）：
  // 在别处粘贴得到的是路径字符串。
  void navigator.clipboard?.writeText?.(paths.join('\n')).catch(() => {});
  toast(`${op === 'cut' ? '已剪切' : '已复制'} ${paths.length} 项`);
  repaint();
}

export function pasteInto(destDir: string): void {
  const clipboard = state.clipboard;
  if (!clipboard) {
    return;
  }
  post({
    type: 'fileAction',
    action: 'paste',
    op: clipboard.op,
    relPaths: clipboard.paths,
    targetDir: destDir,
  });
}

export function renameAny(relPath: string): void {
  post({ type: 'fileAction', action: 'renameAny', relPath });
}

export function openExternal(path: string): void {
  post({ type: 'openExternal', path });
}

export function openInEditor(path: string): void {
  post({ type: 'openEditor', path });
}

export function copyPath(relPath: string): void {
  if (!navigator.clipboard?.writeText) {
    toast('当前环境不支持剪贴板。', true);
    return;
  }
  navigator.clipboard.writeText(relPath).then(
    () => toast(`已复制：${relPath}`),
    () => toast('复制失败，请手动选中。', true)
  );
}
