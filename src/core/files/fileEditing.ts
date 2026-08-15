import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { isChapterFileName } from '../model/chapterFile';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Workspace } from '../workspace';
import {
  MAX_EDITABLE_BYTES,
  WsConflictError,
  WsError,
  resolveInRoot,
  toRelPosix,
} from '../workspace/guard';

const log = scoped('编辑器');

/**
 * 内置编辑器的文件读写。宿主无关：独立版把它接到网页编辑器上，
 * 插件壳不用（那边直接开 VS Code 的编辑器 tab）。
 *
 * ## 只剩两件事
 *
 * 三条硬约束（工程根包含、大小上限、内容 hash 乐观锁）已经搬进
 * `workspace/guard.ts`，这里只留：
 *
 * 1. **可编辑判定**（扩展名白名单 ∪ 章节文件名规则）——那是**这个编辑器**
 *    的口径，不是网关的：网关照样读写 `.rtf`，只是网页里的 textarea 不该
 *    去打开一个 `.png`。
 * 2. **`EditorFile` 的形状转换**——前端要的是 `{path, name, text, hash, bytes}`，
 *    网关给的是 `WsFile`。
 *
 * 落盘因此**经网关**：作者在内置编辑器里改一份细纲，`upstreamHash` 现在会
 * 跟着更新（记账下沉，见 workspace/README.md）。从前那条路直接
 * `fs.writeFile`，指纹链就断在那儿。
 */

/**
 * 允许在内置编辑器里打开/保存的扩展名。都是纯文本，与「数据即 Markdown」的承诺一致。
 * 章节另有一条规则，见 isEditablePath。
 */
export const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml'];

export { MAX_EDITABLE_BYTES, resolveInRoot, toRelPosix };

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
  if (!isEditablePath(relPath)) {
    throw new FileEditError(`不是可编辑的文本文件：${relPath}`);
  }
  const ws = new Workspace(NovelProject.open(root));
  try {
    const file = await ws.read(relPath);
    log.debug(`打开 ${relPath}`, `${file.bytes} 字节`);
    return { path: file.rel, name: path.basename(file.rel), text: file.text, hash: file.hash, bytes: file.bytes };
  } catch (err) {
    throw asEditError(err, relPath);
  }
}

/**
 * 保存编辑器里的内容。
 *
 * `baseHash` 是前端拿到这份文件时的 hash：磁盘上的当前 hash 与它不一致，
 * 说明作者在别处改过（或另一个标签页存过），此时抛 FileConflictError 而不是覆盖。
 * 传空 baseHash 表示放弃乐观锁（用户已在冲突提示里明确选择「强制覆盖」）。
 *
 * **`review: false` 是有意的**：乐观锁已经是这条路自己那道闸，作者手里的
 * 那份就是他要写的东西，再拿它和自己 diff 一遍没有意义。
 */
export async function writeFileFromEditor(
  root: string,
  relPath: string,
  text: string,
  baseHash?: string
): Promise<EditorFile> {
  if (!isEditablePath(relPath)) {
    throw new FileEditError(`不是可编辑的文本文件：${relPath}`);
  }
  if (!baseHash) {
    log.warn(`强制保存 ${relPath}（用户已确认覆盖磁盘版本）`);
  }

  const ws = new Workspace(NovelProject.open(root));
  try {
    const r = await ws.write(relPath, { text }, { mode: 'overwrite', review: false, baseHash });
    const bytes = Buffer.byteLength(text, 'utf8');
    log.info(`已保存 ${relPath}`, `${bytes} 字节${r.side?.length ? `｜${r.side.join('｜')}` : ''}`);
    return { path: r.rel, name: path.basename(r.rel), text, hash: hash(text), bytes };
  } catch (err) {
    throw asEditError(err, relPath);
  }
}

/**
 * 网关的错误 → 编辑器的错误。
 *
 * 两类要分开：冲突带着磁盘版本回前端由用户取舍，其余一律是「打不开/存不下」。
 * 不是 `WsError` 的（真正的 I/O 异常）原样上抛——那些是调用方该知道的事。
 */
function asEditError(err: unknown, relPath: string): unknown {
  if (err instanceof WsConflictError) {
    log.warn(
      `保存被拒：${relPath} 在磁盘上已被改过`,
      `磁盘 ${err.diskHash}。已把磁盘版本交回前端由用户取舍，未覆盖。`
    );
    return new FileConflictError(err.diskText, err.diskHash);
  }
  if (err instanceof WsError) {
    return new FileEditError(err.message);
  }
  return err;
}
