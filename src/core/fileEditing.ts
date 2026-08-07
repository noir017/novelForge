import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from './logger';
import { isChapterFileName } from './model/chapterFile';
import { hash } from './model/project';

const log = scoped('编辑器');

/**
 * 内置编辑器的文件读写。宿主无关：独立版把它接到网页编辑器上，
 * 插件壳不用（那边直接开 VS Code 的编辑器 tab）。
 *
 * 三条硬约束，全部在这里兜住，调用方不必重复检查：
 * 1. 路径必须落在工程根目录内（前端传上来的路径不可信）；
 * 2. 只碰纯文本（扩展名白名单 ∪ 章节文件名规则），且有大小上限；
 * 3. 保存时比对内容 hash，磁盘上被人改过就报冲突，绝不静默覆盖。
 */

/**
 * 允许在内置编辑器里打开/保存的扩展名。都是纯文本，与「数据即 Markdown」的承诺一致。
 * 章节另有一条规则，见 isEditablePath。
 */
export const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml'];

/** 单文件大小上限。再大就不进编辑器了——一个 textarea 装不下，也不是这个工具该干的事。 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/** 不可编辑（越界 / 扩展名不符 / 太大 / 不是文件）。调用方据此决定是否回落到系统程序。 */
export class FileEditError extends Error {
  readonly name = 'FileEditError';
}

/** 保存时发现磁盘内容已与编辑器基线不一致。带上磁盘版本，供前端展示与取舍。 */
export class FileConflictError extends Error {
  readonly name = 'FileConflictError';
  constructor(
    readonly diskText: string,
    readonly diskHash: string
  ) {
    super('文件已被外部修改，保存已取消。');
  }
}

/** 推给前端的一份文件快照。`hash` 是保存时的乐观锁基线。 */
export interface EditorFile {
  /** 工程内相对路径（正斜杠）。 */
  path: string;
  /** 文件名，标签页上显示。 */
  name: string;
  text: string;
  /** 内容 hash，保存时回传作为基线。 */
  hash: string;
  bytes: number;
}

/**
 * 相对路径 → 绝对路径，并保证不逃出工程根目录。
 *
 * 只做逻辑路径包含检查（不解析 symlink）：本机单用户场景下，
 * 扩展名白名单 + 目录包含已经够了，realpath 会让每次打开多一次系统调用。
 */
export function resolveInRoot(root: string, relPath: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, relPath);
  const rel = path.relative(base, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FileEditError(`路径超出工程目录：${relPath}`);
  }
  return abs;
}

/** 绝对路径 → 工程内相对路径（正斜杠，跨平台一致）。 */
export function toRelPosix(root: string, absPath: string): string {
  return path.relative(path.resolve(root), absPath).replace(/\\/g, '/');
}

export function isEditablePath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  if (EDITABLE_EXTENSIONS.includes(ext)) {
    return true;
  }
  // 章节可以叫 `001-楔子`（无扩展名）或 `001-手记.rtf`——白名单挡不住它们，
  // 但树上看得见就必须打得开，否则点一下只弹「不是可编辑的文本文件」。
  // 章节判定本身已经排掉了二进制扩展名，工程根包含检查与大小上限照旧兜底。
  return isChapterFileName(path.basename(relPath));
}

/**
 * 读一份给编辑器用的快照。
 * 越界、扩展名不符、体积过大、不是普通文件都抛 FileEditError。
 */
export async function readFileForEditor(root: string, relPath: string): Promise<EditorFile> {
  const abs = resolveInRoot(root, relPath);
  if (!isEditablePath(abs)) {
    throw new FileEditError(`不是可编辑的文本文件：${relPath}`);
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new FileEditError(`文件不存在：${relPath}`);
  }
  if (!stat.isFile()) {
    throw new FileEditError(`不是文件：${relPath}`);
  }
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new FileEditError(
      `文件超过 ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB，内置编辑器不打开：${relPath}`
    );
  }

  const text = await fs.readFile(abs, 'utf8');
  log.debug(`打开 ${relPath}`, `${stat.size} 字节`);
  return {
    path: toRelPosix(root, abs),
    name: path.basename(abs),
    text,
    hash: hash(text),
    bytes: stat.size,
  };
}

/**
 * 保存编辑器里的内容。
 *
 * `baseHash` 是前端拿到这份文件时的 hash：磁盘上的当前 hash 与它不一致，
 * 说明作者在别处改过（或另一个标签页存过），此时抛 FileConflictError 而不是覆盖。
 * 传空 baseHash 表示放弃乐观锁（用户已在冲突提示里明确选择「强制覆盖」）。
 */
export async function writeFileFromEditor(
  root: string,
  relPath: string,
  text: string,
  baseHash?: string
): Promise<EditorFile> {
  const abs = resolveInRoot(root, relPath);
  if (!isEditablePath(abs)) {
    throw new FileEditError(`不是可编辑的文本文件：${relPath}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_BYTES) {
    throw new FileEditError('内容超过大小上限，未保存。');
  }

  if (baseHash) {
    let diskText: string | undefined;
    try {
      diskText = await fs.readFile(abs, 'utf8');
    } catch {
      // 文件被删了：当作新建处理，不拦。
      diskText = undefined;
    }
    if (diskText !== undefined) {
      const diskHash = hash(diskText);
      if (diskHash !== baseHash) {
        log.warn(
          `保存被拒：${relPath} 在磁盘上已被改过`,
          `编辑器基线 ${baseHash}，磁盘 ${diskHash}。已把磁盘版本交回前端由用户取舍，未覆盖。`
        );
        throw new FileConflictError(diskText, diskHash);
      }
    }
  } else {
    log.warn(`强制保存 ${relPath}（用户已确认覆盖磁盘版本）`);
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  log.info(`已保存 ${relPath}`, `${Buffer.byteLength(text, 'utf8')} 字节`);
  return {
    path: toRelPosix(root, abs),
    name: path.basename(abs),
    text,
    hash: hash(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
