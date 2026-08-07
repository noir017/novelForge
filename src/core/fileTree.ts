import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isEditablePath, resolveInRoot, toRelPosix } from './fileEditing';
import { scoped } from './logger';

const log = scoped('文件树');

/**
 * 资源管理器（独立版侧栏的「文件」页）的数据来源。
 *
 * 与 [projectView.ts](projectView.ts) 是两件不同的事，别把它们合起来：
 * 那边是**按语义整理过的**工程视图（章节按 order 倒序、摘要新鲜度、角色别名），
 * 只包含三个可管理区里的文件；这里是**磁盘上真实的目录结构**，
 * 一个文件都不隐藏——包括 `.novelforge/`（摘要、会话、角色卡原文都在里面），
 * 作者要手改那些文件时，工程页给不了入口。
 *
 * 三条约束：
 * 1. **懒加载，一次只列一层**：工程可能有几百章外加一堆会话 JSON，
 *    整棵树全量推送会让每次刷新都遍历全盘。展开哪个目录就只列那个目录。
 * 2. **路径不越界**：复用 `fileEditing.ts` 的 `resolveInRoot`，
 *    工程根之外一律拒绝（前端传来的路径不可信）。
 * 3. **不静默截断**：目录条目过多时截断，但把真实总数放在 `truncated` 里
 *    交给前端显示，并打一条 warn。
 */

/** 单个目录一次最多返回多少条。超过就截断，但会如实告知总数。 */
export const MAX_DIR_ENTRIES = 2000;

/**
 * 不列出的目录名。只有两个：
 * `node_modules` 是噪音，`.git` 展开是几万个对象文件（而且改它没有意义）。
 *
 * **`.novelforge` 与其他点开头的目录刻意不在这里**——它们正是这个页面存在的理由。
 */
export const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** 资源管理器里的一个条目。目录与文件共用一种形状，靠 `kind` 区分。 */
export interface FsEntry {
  kind: 'dir' | 'file';
  /** 文件名（不含路径）。 */
  name: string;
  /** 工程内相对路径（正斜杠）。同时是前端的行 key 与折叠状态 key。 */
  relPath: string;
  /**
   * 能在内置编辑器里打开。false 的文件（图片、压缩包等）前端置灰，
   * 点击回落到系统默认程序，不去撞一个必然失败的 `openEditor`。
   * 目录恒为 false。
   */
  editable: boolean;
  /** 文件大小（字节）。目录为 0。 */
  bytes: number;
  /** 最后修改时间（毫秒时间戳）。读不到时为 0。 */
  modified: number;
}

/** 一个目录的列举结果。`relPath` 为空串表示工程根。 */
export interface DirListing {
  /** 被列举的目录，工程内相对路径；空串是工程根。 */
  relPath: string;
  entries: FsEntry[];
  /**
   * 条目总数超过 `MAX_DIR_ENTRIES` 时的真实总数；未截断则为 0。
   * 前端据此显示「另有 N 项未列出」——不静默截断。
   */
  truncated: number;
  /** 读取失败时的原因（目录不存在、越界、无权限）。有值时 `entries` 为空。 */
  error?: string;
}

/**
 * 列举一个目录的直接子项（不递归）。
 *
 * 失败不抛：越界 / 不存在 / 读不动都变成带 `error` 的空结果。资源管理器
 * 是个常驻侧栏，作者在别处删掉一个展开着的目录时，整页不该跟着炸。
 */
export async function listDir(root: string, relPath: string): Promise<DirListing> {
  const rel = normalizeDirRel(relPath);

  let abs: string;
  if (rel === '') {
    abs = path.resolve(root);
  } else {
    try {
      abs = resolveInRoot(root, rel);
    } catch (err) {
      return { relPath: rel, entries: [], truncated: 0, error: describe(err) };
    }
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return { relPath: rel, entries: [], truncated: 0, error: describe(err) };
  }

  const kept = dirents.filter((d) => !(d.isDirectory() && HIDDEN_DIR_NAMES.has(d.name)));
  const truncated = kept.length > MAX_DIR_ENTRIES ? kept.length : 0;
  if (truncated) {
    log.warn(
      `目录条目过多，只列出前 ${MAX_DIR_ENTRIES} 项：${rel || '（工程根）'}`,
      `实际 ${truncated} 项，其余未推给前端。`
    );
  }

  const entries: FsEntry[] = [];
  for (const dirent of kept.slice(0, MAX_DIR_ENTRIES)) {
    const childAbs = path.join(abs, dirent.name);
    const childRel = toRelPosix(root, childAbs);
    // symlink 的 isDirectory() 为假；stat 一次才知道它指向什么。
    // 顺带拿到大小与 mtime，省一轮系统调用。
    let isDir = dirent.isDirectory();
    let bytes = 0;
    let modified = 0;
    try {
      const stat = await fs.stat(childAbs);
      isDir = stat.isDirectory();
      bytes = stat.isFile() ? stat.size : 0;
      modified = stat.mtimeMs;
    } catch {
      // 断掉的 symlink、刚被删掉的文件：按 dirent 的判断走，大小留 0。
      // 仍然列出来——树上看得见才知道它坏了。
      if (!isDir && !dirent.isFile()) {
        continue; // 管道 / socket 之类，不是作者会编辑的东西
      }
    }
    entries.push({
      kind: isDir ? 'dir' : 'file',
      name: dirent.name,
      relPath: childRel,
      editable: isDir ? false : isEditablePath(childRel),
      bytes,
      modified,
    });
  }

  entries.sort(compareEntries);
  log.debug(`列出 ${rel || '（工程根）'}`, `${entries.length} 项`);
  return { relPath: rel, entries, truncated };
}

/**
 * 一次列举多个目录（前端展开着的那些）。
 *
 * 并发跑：展开十几层时逐个 await 会把一次刷新拖成十几轮盘 I/O。
 * 单个目录失败已经在 `listDir` 里降级成带 error 的结果，这里不会被带崩。
 */
export async function listDirs(root: string, relPaths: readonly string[]): Promise<DirListing[]> {
  const unique = [...new Set(relPaths.map(normalizeDirRel))];
  return Promise.all(unique.map((rel) => listDir(root, rel)));
}

/**
 * 目录相对路径的规范形状：正斜杠、无首尾斜杠、`.` 与空串都表示工程根。
 *
 * 前端的折叠状态是按这个字符串记的，规范化必须只在这一处做——
 * 后端回的 `relPath` 与前端请求的对不上，那一行就会永远转着圈。
 */
export function normalizeDirRel(relPath: string): string {
  const trimmed = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return trimmed === '.' ? '' : trimmed;
}

/** 目录在前、文件在后，各自按名称排（与 VS Code 的资源管理器一致）。 */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === 'dir' ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // ENOENT / EACCES 这类裸错误码对作者没意义，翻成人话。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return '目录不存在（可能刚被删除或改名）';
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return '没有读取这个目录的权限';
    }
    if (code === 'ENOTDIR') {
      return '不是目录';
    }
    return err.message;
  }
  return String(err);
}
