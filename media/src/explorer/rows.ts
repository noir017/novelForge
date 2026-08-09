/**
 * 树上一行的建法，以及每行的右键菜单。
 *
 * **树是扁平渲染的**：`renderDir` 递归遍历，但产出的是扁平的行数组，
 * 层级靠 paddingLeft 缩进表达而非嵌套 DOM——折叠只是重画一遍，
 * 不必搬 DOM 子树（与工程页同一套取舍）。
 */
import { el } from '../dom';
import { onContextMenu } from '../globals';
import type { MenuItem } from '../globals';
import type { FsEntry } from '../protocol';
import {
  copyPath,
  openExternal,
  openInEditor,
  pasteInto,
  renameAny,
  setClipboard,
  toggleDir,
} from './actions';
import { isCut, listings, openDirs, parentOf, pending, state } from './state';

/** 每层缩进 14px，与工程页一致。 */
const INDENT_STEP = 14;
const INDENT_BASE = 8;

/** 一个目录展开后应有的全部行（含子目录，递归展开）。 */
export function renderDir(relPath: string, depth: number): HTMLElement[] {
  const listing = listings.get(relPath);
  if (!listing) {
    return [hintRow(pending.has(relPath) ? '载入中…' : '（未载入）', depth)];
  }
  if (listing.error) {
    return [hintRow(listing.error, depth, true)];
  }
  if (listing.entries.length === 0) {
    return [hintRow('（空文件夹）', depth)];
  }

  const rows: HTMLElement[] = [];
  for (const entry of listing.entries) {
    if (entry.kind === 'dir') {
      rows.push(dirRow(entry, depth));
      if (openDirs.has(entry.relPath)) {
        rows.push(...renderDir(entry.relPath, depth + 1));
      }
    } else {
      rows.push(fileRow(entry, depth));
    }
  }
  if (listing.truncated) {
    // 不静默截断：让作者知道这个目录里还有东西没画出来。
    rows.push(
      hintRow(
        `另有 ${listing.truncated - listing.entries.length} 项未列出（共 ${listing.truncated} 项）`,
        depth,
        true
      )
    );
  }
  return rows;
}

/** 一行的公共骨架：缩进 + 可聚焦（Ctrl+X/C/V 的作用对象）。 */
function baseRow(depth: number): HTMLDivElement {
  const row = el('div', 'fx-row');
  row.style.paddingLeft = `${INDENT_BASE + depth * INDENT_STEP}px`;
  row.tabIndex = 0;
  return row;
}

function dirRow(entry: FsEntry, depth: number): HTMLElement {
  const row = baseRow(depth);
  row.classList.add('fx-dir');
  const open = openDirs.has(entry.relPath);

  row.appendChild(el('span', 'fx-caret', open ? '⌄' : '›'));
  row.appendChild(el('span', 'fx-icon', open ? '📂' : '📁'));
  row.appendChild(el('span', 'fx-name', entry.name));

  // 点开头的目录（.novelforge / .vscode）压暗一点，与 VS Code 一致：
  // 它们看得见、打得开，但不该跟正文抢注意力。
  if (entry.name.startsWith('.')) {
    row.classList.add('fx-dotted');
  }
  if (isCut(entry.relPath)) {
    row.classList.add('fx-cut');
  }

  row.addEventListener('focus', () => {
    state.selectedEntry = entry;
  });
  row.addEventListener('click', () => {
    state.selectedEntry = entry;
    toggleDir(entry.relPath);
  });

  onContextMenu(row, () => [
    ...clipboardItems(entry),
    { label: open ? '折叠' : '展开', run: () => toggleDir(entry.relPath) },
    { label: '在系统中打开', run: () => openExternal(entry.relPath) },
    { sep: true },
    { label: '复制相对路径', run: () => copyPath(entry.relPath) },
  ]);
  return row;
}

function fileRow(entry: FsEntry, depth: number): HTMLElement {
  const row = baseRow(depth);
  row.classList.add('fx-file');
  if (entry.relPath === state.activeFile) {
    row.classList.add('active');
  }
  if (!entry.editable) {
    row.classList.add('fx-binary');
  }
  if (entry.name.startsWith('.')) {
    row.classList.add('fx-dotted');
  }
  if (isCut(entry.relPath)) {
    row.classList.add('fx-cut');
  }

  // 文件行没有折叠箭头，但要占住同样的宽度，名字才与同级目录对齐。
  row.appendChild(el('span', 'fx-caret'));
  row.appendChild(el('span', 'fx-icon', iconFor(entry)));
  row.appendChild(el('span', 'fx-name', entry.name));
  row.appendChild(el('span', 'fx-size', formatBytes(entry.bytes)));

  row.title = `${entry.relPath}${entry.editable ? '' : '（不是文本文件，将用系统默认程序打开）'}`;

  row.addEventListener('focus', () => {
    state.selectedEntry = entry;
  });
  row.addEventListener('click', () => {
    state.selectedEntry = entry;
    openEntry(entry);
  });

  onContextMenu(row, () => [
    ...clipboardItems(entry),
    { label: entry.editable ? '打开' : '打开（外部程序）', run: () => openEntry(entry) },
    { label: '在系统中打开', run: () => openExternal(entry.relPath) },
    { sep: true },
    { label: '复制相对路径', run: () => copyPath(entry.relPath) },
  ]);
  return row;
}

function hintRow(text: string, depth: number, isError?: boolean): HTMLElement {
  const row = baseRow(depth);
  row.classList.add('fx-hint');
  if (isError) {
    row.classList.add('err');
  }
  row.textContent = text;
  return row;
}

/** 剪切/复制/粘贴/重命名四项。文件与文件夹行共用。 */
function clipboardItems(entry: FsEntry): MenuItem[] {
  const dest = entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath);
  return [
    { label: '剪切', run: () => setClipboard('cut', [entry.relPath]) },
    { label: '复制', run: () => setClipboard('copy', [entry.relPath]) },
    { label: '粘贴', disabled: !state.clipboard, run: () => pasteInto(dest) },
    { label: '重命名', run: () => renameAny(entry.relPath) },
    { sep: true },
  ];
}

/**
 * 打开一个条目。可编辑的进内置编辑器，其余交系统默认程序——
 * 「能不能编辑」由后端算好（与 fileEditing.ts 同一份规则），
 * 前端不复刻扩展名白名单，也就不会去撞一个必然失败的 openEditor。
 */
function openEntry(entry: FsEntry): void {
  if (entry.editable) {
    openInEditor(entry.relPath);
  } else {
    openExternal(entry.relPath);
  }
}

/** 按扩展名给个图标。纯装饰，认不出就用通用的那个。 */
function iconFor(entry: FsEntry): string {
  const name = entry.name.toLowerCase();
  if (/\.(md|markdown)$/.test(name)) return '📝';
  if (/\.(json|ya?ml)$/.test(name)) return '⚙';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/.test(name)) return '🖼';
  if (/\.(zip|rar|7z|gz|tar)$/.test(name)) return '📦';
  if (!entry.editable) return '▪';
  return '📄';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
