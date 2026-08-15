/**
 * 统一入口守卫。**六处各带一部分保护、谁也不认识谁**的局面到此为止。
 *
 * 从前的分布：
 *
 * | 位置 | 带哪些保护 |
 * | --- | --- |
 * | `files/fileOps.ts` | 区界限、同名不覆盖、`.trash` |
 * | `files/fileEditing.ts` | 工程根包含、扩展名白名单、大小上限、内容 hash 乐观锁 |
 * | `files/projectFiles.ts` | 工程根包含、`isProtectedPath`、同名不覆盖 |
 * | `features/creation.ts` | `confirmOverwrite` / `reviewReplace` |
 *
 * 这就是为什么从前不敢给 agent 一个 `write`。八条守卫收进这一份，
 * `workspace/index.ts` 的六个方法全过一遍，**新代码不许绕过这里直接
 * `fs.writeFile`**。
 *
 * | # | 守卫 | 触发时怎么办 |
 * |---|---|---|
 * | 1 | 路径规范化（绝对路径 / `..` 逃逸 / 空串） | `WsError('outOfRoot')` |
 * | 2 | 工程根包含检查（解析成绝对路径再比一次） | `WsError('outOfRoot')` |
 * | 3 | 固定目录保护（改名/删除） | `WsError('protected')` |
 * | 4 | `.trash/` 内容不可**改**（读得到，作者要能找回东西） | `WsError('inTrash')` |
 * | 5 | 大小上限 2MB（读、写各一次） | `WsError('tooLarge')` |
 * | 6 | 同名不覆盖（`mode: 'create'`） | `WsError('exists')` |
 * | 7 | 覆盖前审阅（`reviewReplace` 或确认框） | 用户拒绝 → 调用方 `{skipped:true}` |
 * | 8 | 内容 hash 乐观锁 | `WsConflictError(diskText, diskHash)` |
 *
 * **区界限不在这里**：`fileOps` 的三区约束（章节挪不进角色目录）是**工程页
 * 的产品承诺**，比这里的工程根约束更严。那一层留在 `fileOps` 里，先判区再
 * 调网关。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { normalizeRel } from './kind';

const log = scoped('工作区');

export type WsErrorCode =
  | 'outOfRoot'
  | 'protected'
  | 'inTrash'
  | 'tooLarge'
  | 'exists'
  | 'notFound'
  | 'notFile'
  | 'notUnique'
  | 'conflict';

/** 守卫拒绝的统一形状。`code` 是给调用方分支用的，`message` 直接进 toast。 */
export class WsError extends Error {
  readonly name = 'WsError';
  constructor(
    readonly code: WsErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * 乐观锁失败：磁盘上的内容与调用方的基线不一致。
 *
 * 带上磁盘版本交回前端由用户取舍——**绝不静默覆盖**（AGENTS 第 3 条）。
 */
export class WsConflictError extends WsError {
  constructor(
    readonly diskText: string,
    readonly diskHash: string
  ) {
    super('conflict', '文件已被外部修改，保存已取消。');
  }
}

/**
 * 单文件大小上限。再大就不进编辑器、也不进网关——一个 textarea 装不下，
 * 塞进模型上下文更是纯烧钱。
 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/**
 * 工程的固定目录：改名/搬走会让工程结构散架（章节索引、草稿镜像、
 * 元数据与会话）。
 *
 * `.novelforge/` 下的每一个目录名都被代码写死在某处查找逻辑里：剧情、场景、
 * 正文、摘要四套路径与会话存储都是按目录名拼出来的，改了名就等于那批数据凭空
 * 消失，**而界面上只会显示「还没生成过」**。所以这里列的是全部固定子目录，
 * 不只是作者常看见的那几个。
 */
export function isProtectedPath(project: NovelProject, relPath: string): boolean {
  const rel = normalizeRel(relPath);
  if (!rel) {
    return true;
  }
  const fixed = [
    project.relPath(project.chaptersDir),
    project.relPath(project.draftsDir),
    '.novelforge',
    '.novelforge/characters',
    '.novelforge/lore',
    '.novelforge/summaries',
    '.novelforge/plots',
    '.novelforge/scenes',
    '.novelforge/manuscripts',
    '.novelforge/sessions',
    '.novelforge/.trash',
  ];
  return fixed.includes(rel);
}

/** 这条路径在回收站里。`.trash/` 里躺着刚删掉的东西，不是操作对象。 */
export function isInTrash(project: NovelProject, rel: string): boolean {
  const trash = project.relPath(project.trashDir);
  return rel === trash || rel.startsWith(`${trash}/`);
}

/**
 * 守卫 1 + 2：相对路径 → 绝对路径，并保证不逃出工程根。
 *
 * 两道各拦一半：`normalizeRel` 挡的是字面上的越界（`../`、`C:\`、空串），
 * 这里挡的是**归一化之后仍然逃出去**的（`a/../../b`）与工程根自己。
 * 只做逻辑路径包含检查（不解析 symlink）：本机单用户场景下够了，
 * realpath 会让每次读写多一次系统调用。
 *
 * 只收 `root` 而不是整个 `NovelProject`：目录列举（`files/fileTree.ts`）
 * 手里只有一个路径字符串，它要的也正是这一条判据。
 */
export function resolveInRoot(root: string, relPath: string): string {
  const rel = normalizeRel(relPath);
  if (rel === undefined) {
    throw new WsError('outOfRoot', `路径超出工程目录：${relPath}`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const back = path.relative(base, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new WsError('outOfRoot', `路径超出工程目录：${relPath}`);
  }
  return abs;
}

/** 绝对路径 → 工程内相对路径（正斜杠，跨平台一致）。 */
export function toRelPosix(root: string, absPath: string): string {
  return path.relative(path.resolve(root), absPath).replace(/\\/g, '/');
}

/**
 * 读之前过一遍：返回绝对路径。
 *
 * **回收站里的东西读得到**——作者要能翻进去找回删掉的稿子。不可操作的是
 * 改名/删除/写入，见 `guardMutate` / `guardWrite`。
 */
export async function guardRead(project: NovelProject, relPath: string): Promise<string> {
  const abs = resolveInRoot(project.root, relPath);

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new WsError('notFound', `文件不存在：${relPath}`);
  }
  if (!stat.isFile()) {
    throw new WsError('notFile', `不是文件：${relPath}`);
  }
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new WsError(
      'tooLarge',
      `文件超过 ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB，不读：${relPath}`
    );
  }
  return abs;
}

export interface GuardWriteOptions {
  mode: 'create' | 'overwrite' | 'append';
  /** 乐观锁基线。给了就比对，磁盘变过报冲突。 */
  baseHash?: string;
  /** 要写的内容。给了就一并做大小检查——写超限的东西不该等到落盘才发现。 */
  text?: string;
}

export interface GuardWriteResult {
  abs: string;
  existed: boolean;
  /** 目标已存在时的当前内容。供覆盖审阅比对，省掉调用方再读一次。 */
  current?: string;
}

/**
 * 写之前过一遍。返回绝对路径与「目标是否已存在」。
 *
 * 检查顺序是有意的：越界 → 回收站 → 大小 → 存在性 → 同名 → 乐观锁。
 * 先拦最便宜、最致命的，最后才读盘。
 */
export async function guardWrite(
  project: NovelProject,
  relPath: string,
  opts: GuardWriteOptions
): Promise<GuardWriteResult> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;

  if (isInTrash(project, rel)) {
    throw new WsError('inTrash', `回收站里的内容不能写：${rel}`);
  }
  if (opts.text !== undefined && Buffer.byteLength(opts.text, 'utf8') > MAX_EDITABLE_BYTES) {
    throw new WsError('tooLarge', '内容超过大小上限，未写入。');
  }

  let stat: import('node:fs').Stats | undefined;
  try {
    stat = await fs.stat(abs);
  } catch {
    stat = undefined;
  }
  if (stat && !stat.isFile()) {
    throw new WsError('notFile', `目标不是文件：${rel}`);
  }
  if (stat && opts.mode === 'create') {
    throw new WsError('exists', `已存在：${rel}`);
  }

  let current: string | undefined;
  if (stat) {
    current = await fs.readFile(abs, 'utf8');
  }

  // 守卫 8：磁盘上的当前 hash 与基线不一致 = 作者在别处改过（或另一个标签页
  // 存过）。**文件被删了不算冲突**，当作新建处理——逐字沿用 fileEditing 的行为。
  if (opts.baseHash && current !== undefined) {
    const diskHash = hash(current);
    if (diskHash !== opts.baseHash) {
      log.warn(
        `写入被拒：${rel} 在磁盘上已被改过`,
        `基线 ${opts.baseHash}，磁盘 ${diskHash}。已把磁盘版本交回调用方由用户取舍，未覆盖。`
      );
      throw new WsConflictError(current, diskHash);
    }
  }

  return { abs, existed: stat !== undefined, current };
}

/**
 * 改名/移动/删除之前过一遍。比读多两条：保护路径、回收站。
 *
 * 目录也是合法对象（搬 `chapters/卷一/` 是正常操作），所以不判 `isFile`。
 */
export async function guardMutate(project: NovelProject, relPath: string): Promise<string> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;

  if (isProtectedPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是工程的固定目录，不能改名或搬走。`);
  }
  if (isInTrash(project, rel)) {
    throw new WsError('inTrash', `回收站里的内容不能操作：${rel}`);
  }
  try {
    await fs.stat(abs);
  } catch {
    throw new WsError('notFound', `找不到：${rel}`);
  }
  return abs;
}

/**
 * 覆盖前审阅。返回「可以写了吗」。
 *
 * 有 `reviewReplace` 的宿主（插件）开 diff 编辑器，作者能逐行看清改了什么；
 * 没有的（独立版目前）退化成一个带字数对比的确认框。**都没有确认就不写。**
 *
 * 内容一模一样时不问——一字未变还弹个框，只会让人以为自己点错了。
 *
 * 逐字搬自 `features/creation.ts` 的 `confirmOverwrite`：那两句文案
 * （`「${what}」已经有内容了，用新版本覆盖？`、`现有 N 字，新版 M 字`）
 * **是产品承诺的一部分，不要改措辞**。
 */
export async function reviewOverwrite(
  what: string,
  relPath: string,
  current: string,
  next: string
): Promise<boolean> {
  if (current.trim() === next.trim()) {
    return true;
  }

  const host = getHost();
  const verdict = host.reviewReplace
    ? await host.reviewReplace(what, current, next)
    : await host
        .confirm(`「${what}」已经有内容了，用新版本覆盖？`, ['覆盖', '保留原样'], {
          modal: true,
          detail: `现有 ${current.length} 字，新版 ${next.length} 字。\n${relPath}`,
        })
        .then((pick) => (pick === '覆盖' ? 'apply' : pick === '保留原样' ? 'discard' : undefined));

  if (verdict !== 'apply') {
    log.info(`未覆盖${what}`, verdict === 'discard' ? '用户选择保留原样' : '用户取消');
    return false;
  }
  return true;
}
