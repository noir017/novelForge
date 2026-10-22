import * as fs from 'node:fs/promises';
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
 * 外加编辑器自己的两条口径：保存时磁盘上没了这个文件就停下来问（`FileGoneError`，比网关严一档），
 * 以及按 hash 核对开着的几份文件在磁盘上变没变（`checkEditorFiles`，只读）。
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

/**
 * 保存时带了基线、磁盘上却已经没有这个文件（被删、被改名），而作者没说要在原路径重建。
 *
 * 网关自己的口径是「文件被删了不算冲突，当新建处理」（`workspace/guard.ts` 守卫 8）——对谁都一样的
 * 写入入口，这么定没错。**编辑器这条路收紧一档**：编辑器里那份是照着一个已经不在的文件改的，
 * 静默在原路径重建一份，作者在外面改的名就白改了（新名字那边一份、原名字这边又冒出一份）。
 * 所以先停下来交回前端问一句，答应了再带 `recreate` 来。
 */
export class FileGoneError extends Error {
  readonly name = 'FileGoneError';
  constructor(readonly relPath: string) {
    super(`磁盘上已经没有这个文件：${relPath}`);
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
 * 带了 baseHash、磁盘上却没有这个文件时抛 {@link FileGoneError}，**不在原路径重建**；
 * `opts.recreate` 是作者答应过重建（这时照常带着基线：期间又有人在原路径放了一份的话，乐观锁照样拦）。
 *
 * **`review: false` 是有意的**：乐观锁已经是这条路自己那道闸，作者手里的
 * 那份就是他要写的东西，再拿它和自己 diff 一遍没有意义。
 */
export async function writeFileFromEditor(
  root: string,
  relPath: string,
  text: string,
  baseHash?: string,
  opts?: { recreate?: boolean }
): Promise<EditorFile> {
  if (!isEditablePath(relPath)) {
    throw new FileEditError(`不是可编辑的文本文件：${relPath}`);
  }
  // 越界先拦：`../escape.md` 也是 `.md`，可编辑判定放它过。放到后面的话，
  // 下面那句「强制保存」会先落进日志，而这次保存根本没发生。
  let abs: string;
  try {
    abs = resolveInRoot(root, relPath);
  } catch (err) {
    throw asEditError(err, relPath);
  }
  const ws = new Workspace(NovelProject.open(root));
  if (!baseHash) {
    log.warn(`强制保存 ${relPath}（用户已确认覆盖磁盘版本）`);
  } else if (!opts?.recreate && !ws.isOutline(relPath) && !(await exists(abs))) {
    // 情节大纲本来就没有文件（各章细纲梗概的汇总），不算「磁盘上没有了」。
    log.warn(`保存被拒：${relPath} 在磁盘上已经没有了`, '没有在原路径重建，交回前端问作者。');
    throw new FileGoneError(relPath);
  }

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
 * 一次最多核对几份。两块编辑区开着的标签远到不了这个数；超出的不核对（不回话），
 * 免得一条手搓的消息让后端读几千个文件。
 */
export const MAX_CHECKED_FILES = 200;

/** {@link checkEditorFiles} 的结果：磁盘上变了的（带新版），以及读不到的（被删、被改名）。 */
export interface EditorDiskReport {
  changed: EditorFile[];
  gone: string[];
}

/**
 * 核对编辑器里开着的几份文件在磁盘上还是不是编辑器知道的那一份（`checkEditorFiles` 消息）。
 *
 * - hash 对不上：进 `changed`，带磁盘上的新版（`path` 原样用前端给的，前端按它认标签）。
 * - 读不到（不存在、不是文件）：进 `gone`。
 * - 越界、不可编辑、超过大小上限、路径不是字符串：跳过，不回话——这几样编辑器本来就打不开，
 *   核对它们没有意义，也不该因为一条坏消息让整批作废。
 *
 * 只读，一个字节都不写。同一路径给了两次只核对一次。
 */
export async function checkEditorFiles(
  root: string,
  files: readonly { path?: unknown; hash?: unknown }[]
): Promise<EditorDiskReport> {
  const report: EditorDiskReport = { changed: [], gone: [] };
  const ws = new Workspace(NovelProject.open(root));
  const seen = new Set<string>();
  for (const item of files.slice(0, MAX_CHECKED_FILES)) {
    const rel = item?.path;
    const known = item?.hash;
    if (typeof rel !== 'string' || typeof known !== 'string' || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    if (!isEditablePath(rel)) {
      continue;
    }
    try {
      resolveInRoot(root, rel);
    } catch {
      log.warn(`核对磁盘时跳过越界路径：${rel}`);
      continue;
    }
    try {
      const file = await ws.read(rel);
      if (file.hash !== known) {
        report.changed.push({ path: rel, name: path.basename(file.rel), text: file.text, hash: file.hash, bytes: file.bytes });
      }
    } catch (err) {
      if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        report.gone.push(rel);
      } else if (!(err instanceof WsError)) {
        throw err;
      }
    }
  }
  if (report.changed.length || report.gone.length) {
    log.debug(
      '核对磁盘',
      `变了 ${report.changed.map((f) => f.path).join('、') || '无'}；没了 ${report.gone.join('、') || '无'}`
    );
  }
  return report;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
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
