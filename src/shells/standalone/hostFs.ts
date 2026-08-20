import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HIDDEN_DIR_NAMES, MAX_DIR_ENTRIES } from '../../core/files/fileTree';

/**
 * 本机一层目录列举。给空窗口的「打开文件夹」用，**不是**工程内的 listDir。
 * 只返回名字与绝对路径，不读文件内容。
 */

export interface HostDirEntry {
  name: string;
  kind: 'dir' | 'file';
  absPath: string;
}

export interface HostDirListing {
  path: string;
  parent?: string;
  entries: HostDirEntry[];
  truncated: number;
  error?: string;
  roots?: boolean;
}

function compareEntries(a: HostDirEntry, b: HostDirEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === 'dir' ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
}

function parentOf(abs: string): string | undefined {
  const parent = path.dirname(abs);
  if (parent === abs) {
    return undefined;
  }
  return parent;
}

function winDrives(): HostDirListing {
  const entries: HostDirEntry[] = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      fsSync.statSync(root);
      entries.push({ name: `${letter}:`, kind: 'dir', absPath: root });
    } catch {
      // 盘符不存在就跳过
    }
  }
  return { path: '', entries, truncated: 0, roots: true };
}

function bad(pathShown: string, error: string, extra?: Partial<HostDirListing>): HostDirListing {
  return { path: pathShown, entries: [], truncated: 0, error, ...extra };
}

/** `path === ''` 在 Unix 列举 `/`，在 Windows 列举盘符。 */
export async function listHostDir(absPath: string): Promise<HostDirListing> {
  if (process.platform === 'win32' && (absPath === '' || absPath === '/' || absPath === '\\')) {
    return winDrives();
  }

  const target = absPath === '' || absPath === '/' ? path.parse(os.homedir()).root || '/' : path.resolve(absPath);
  const shown = target;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    return bad(shown, describe(err), { parent: parentOf(target) });
  }
  if (!stat.isDirectory()) {
    return bad(shown, '不是目录', { parent: parentOf(target) });
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    return bad(shown, describe(err), { parent: parentOf(target) });
  }

  const kept = dirents.filter((d) => !(d.isDirectory() && HIDDEN_DIR_NAMES.has(d.name)));
  const truncated = kept.length > MAX_DIR_ENTRIES ? kept.length : 0;
  const entries: HostDirEntry[] = [];
  for (const dirent of kept.slice(0, MAX_DIR_ENTRIES)) {
    const childAbs = path.join(target, dirent.name);
    let isDir = dirent.isDirectory();
    try {
      const st = await fs.stat(childAbs);
      isDir = st.isDirectory();
    } catch {
      if (!isDir && !dirent.isFile()) {
        continue;
      }
    }
    entries.push({
      kind: isDir ? 'dir' : 'file',
      name: dirent.name,
      absPath: childAbs,
    });
  }
  entries.sort(compareEntries);
  const parent = parentOf(target);
  return { path: shown, parent, entries, truncated };
}

const BAD_NAME = /[/\\]|\.\./;

export async function createHostDir(parent: string, name: string): Promise<HostDirListing> {
  const trimmed = (name ?? '').trim();
  if (!trimmed || BAD_NAME.test(trimmed)) {
    const listing = await listHostDir(parent);
    listing.error = '文件夹名不合法';
    return listing;
  }
  const dest = path.join(path.resolve(parent), trimmed);
  try {
    await fs.mkdir(dest);
  } catch (err) {
    const listing = await listHostDir(parent);
    const code = (err as NodeJS.ErrnoException).code;
    listing.error = code === 'EEXIST' ? '已存在同名项' : describe(err);
    return listing;
  }
  return listHostDir(parent);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return '目录不存在';
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
