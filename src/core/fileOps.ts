import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from './host';
import { NovelProject, exists, readText, sanitizeFileName, writeText } from './model/project';

/**
 * 工程页的类文件操作：新建文件夹、重命名、移动、删除。
 *
 * 三条硬约束：
 *
 * 1. **不越界**：每个操作都锁在它所属的区（chapters/ 、characters/ 、lore/）里。
 *    章节挪不进角色目录，任何路径也出不了工程根——`..` 一律拒绝。
 * 2. **不静默覆盖**：目标已存在就报错退出，绝不覆盖作者的文件。
 * 3. **不真删**：删除是搬进 `.novelforge/.trash/`，与会话删除同一套做法。
 */

/** 三个可管理的区。每个区有自己的根目录，操作不跨区。 */
export type Section = 'chapters' | 'characters' | 'lore';

export interface SectionInfo {
  section: Section;
  /** 该区根目录的工作区相对路径。 */
  root: string;
  /** 该区根目录的绝对路径。 */
  rootAbs: string;
  label: string;
}

export function sectionRoots(project: NovelProject): SectionInfo[] {
  return [
    { section: 'chapters', root: project.relPath(project.chaptersDir), rootAbs: project.chaptersDir, label: '章节' },
    {
      section: 'characters',
      root: project.relPath(project.charactersDir),
      rootAbs: project.charactersDir,
      label: '角色',
    },
    { section: 'lore', root: project.relPath(project.loreDir), rootAbs: project.loreDir, label: '设定' },
  ];
}

/** 某个相对路径属于哪个区。不在任何区里（或越界）时返回 undefined。 */
export function sectionOf(project: NovelProject, relPath: string): SectionInfo | undefined {
  const normalized = normalizeRel(relPath);
  if (normalized === undefined) {
    return undefined;
  }
  return sectionRoots(project).find((s) => normalized === s.root || normalized.startsWith(`${s.root}/`));
}

/**
 * 「在这个目录里新建」的落点收敛：给定的目录必须落在该区内，
 * 否则退回区根目录。新建类流程都经这里，`dir` 越界不会把文件写到工程外面去。
 */
export function resolveSectionDir(project: NovelProject, section: Section, dir?: string): string {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  return resolveDirWithin(info, dir) ?? info.root;
}

/**
 * 把用户/前端给来的相对路径收敛为「工程内的、用正斜杠的」相对路径。
 * 绝对路径、`..` 逃逸、空路径一律返回 undefined。
 */
export function normalizeRel(relPath: string): string | undefined {
  const trimmed = (relPath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  const resolved = path.posix.normalize(trimmed);
  if (resolved === '..' || resolved.startsWith('../') || resolved === '.') {
    return undefined;
  }
  return resolved;
}

// ---------------------------------------------------------------- 新建文件夹

/**
 * 在某个区里新建文件夹。`parentRel` 缺省为该区根目录。
 * 返回新目录的相对路径；用户取消或失败返回 undefined。
 */
export async function newFolder(
  project: NovelProject,
  section: Section,
  parentRel?: string
): Promise<string | undefined> {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  const parent = resolveDirWithin(info, parentRel) ?? info.root;

  const name = await getHost().input({
    title: '新建文件夹',
    prompt: `在 ${parent}/ 下新建文件夹`,
    placeHolder: '如「第一卷」',
    validate: (v) => validateName(v),
  });
  if (!name) {
    return undefined;
  }

  const rel = `${parent}/${sanitizeFileName(name)}`;
  const abs = project.pathOf(rel);
  if (await exists(abs)) {
    getHost().toast(`已存在：${rel}`, 'error');
    return undefined;
  }
  await fs.mkdir(abs, { recursive: true });
  project.invalidate();
  getHost().toast(`已新建文件夹 ${rel}`);
  return rel;
}

// ---------------------------------------------------------------- 重命名

/**
 * 重命名文件或文件夹。改的是**磁盘上的名字**，不动文件内容——
 * 唯一的例外见下面 renamedBody 的说明。
 *
 * 章节文件的 `NNN-` 序号前缀由重命名保留：序号决定全书顺序，
 * 不该在改个标题时被顺手改掉。
 */
export async function renameEntry(project: NovelProject, relPath: string): Promise<string | undefined> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return undefined;
  }
  const { abs, rel, info, isDir } = target;

  const base = path.basename(rel);
  const ext = isDir ? '' : path.extname(base);
  const stem = isDir ? base : base.slice(0, base.length - ext.length);
  // 章节的序号前缀单独拆出来，让用户只编辑标题部分。
  const prefixMatch = !isDir && info.section === 'chapters' ? /^(\d{1,5}[-_.\s]*)(.*)$/.exec(stem) : null;
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const editable = prefixMatch ? prefixMatch[2] : stem;

  const input = await getHost().input({
    title: isDir ? '重命名文件夹' : '重命名文件',
    prompt: prefix ? `序号前缀「${prefix}」会保留` : `当前：${rel}`,
    value: editable,
    validate: (v) => validateName(v),
  });
  if (input === undefined || input.trim() === editable) {
    return undefined;
  }

  const nextStem = sanitizeFileName(input);
  const nextRel = `${path.posix.dirname(rel)}/${prefix}${nextStem}${ext}`;
  if (nextRel === rel) {
    return undefined;
  }
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    getHost().toast(`已存在同名项：${nextRel}`, 'error');
    return undefined;
  }

  // 先改内容再改名：改名成功后内容一定是对的，反过来则可能留下半吊子状态。
  // 用清洗后的 nextStem 而不是用户原样输入，H1 才会继续与文件名一致，
  // 下次改名时仍然认得出「这个 H1 是跟着文件名走的」。
  if (!isDir && info.section === 'chapters') {
    const body = await readText(abs);
    const updated = renamedBody(body, editable, nextStem);
    if (updated !== body) {
      await writeText(abs, updated);
    }
  }

  await fs.rename(abs, nextAbs);
  project.invalidate();
  if (info.section === 'chapters') {
    await project.syncManifest();
  }
  getHost().toast(`已重命名为 ${nextRel}`);
  return nextRel;
}

/**
 * 章节改名时同步正文里的 `# 标题` 行——但**只在它与旧文件名一致时**。
 *
 * 两者一致说明作者从没单独改过标题，把它们继续保持同步是他要的；
 * 一旦不一致，那个 H1 就是作者手写的东西，改名不该动它。
 */
export function renamedBody(body: string, oldTitle: string, newTitle: string): string {
  if (!oldTitle || oldTitle === newTitle) {
    return body;
  }
  const m = /^(\s*)#\s+(.+?)[ \t]*(\r?\n|$)/.exec(body);
  if (!m || m[2].trim() !== oldTitle.trim()) {
    return body;
  }
  return `${m[1]}# ${newTitle}${m[3]}${body.slice(m[0].length)}`;
}

// ---------------------------------------------------------------- 移动

/**
 * 把文件或文件夹移到同区的另一个目录下。
 * `targetDir` 缺省时弹目录选择（含该区根目录）。
 */
export async function moveEntry(
  project: NovelProject,
  relPath: string,
  targetDir?: string
): Promise<string | undefined> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return undefined;
  }
  const { abs, rel, info, isDir } = target;

  let destRel = targetDir === undefined ? undefined : resolveDirWithin(info, targetDir);
  if (targetDir !== undefined && destRel === undefined) {
    getHost().toast(`目标目录不在「${info.label}」区里：${targetDir}`, 'error');
    return undefined;
  }
  if (destRel === undefined) {
    destRel = await pickDestination(project, info, rel, isDir);
    if (destRel === undefined) {
      return undefined;
    }
  }

  const currentParent = path.posix.dirname(rel);
  if (destRel === currentParent) {
    getHost().toast('已经在这个目录里了。');
    return undefined;
  }
  // 目录不能移进自己的子孙里——那会把这棵子树从文件系统上摘下来。
  if (isDir && (destRel === rel || destRel.startsWith(`${rel}/`))) {
    getHost().toast('不能把文件夹移动到它自己里面。', 'error');
    return undefined;
  }
  if (!(await exists(project.pathOf(destRel)))) {
    getHost().toast(`目标目录不存在：${destRel}`, 'error');
    return undefined;
  }

  const nextRel = `${destRel}/${path.basename(rel)}`;
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    getHost().toast(`目标目录里已有同名项：${nextRel}`, 'error');
    return undefined;
  }

  await fs.rename(abs, nextAbs);
  project.invalidate();
  if (info.section === 'chapters') {
    // 路径变了但序号没变，syncManifest 会按 order 兜底找回 summaryHash。
    await project.syncManifest();
  }
  getHost().toast(`已移动到 ${nextRel}`);
  return nextRel;
}

async function pickDestination(
  project: NovelProject,
  info: SectionInfo,
  rel: string,
  isDir: boolean
): Promise<string | undefined> {
  const folders = await project.listFolders(info.rootAbs);
  const candidates = [info.root, ...folders].filter(
    // 自己和自己的子孙都不能当落点。
    (dir) => !(isDir && (dir === rel || dir.startsWith(`${rel}/`)))
  );
  const currentParent = path.posix.dirname(rel);
  return getHost().pick(
    candidates.map((dir) => ({
      label: dir === info.root ? `${info.label}（根目录）` : dir.slice(info.root.length + 1),
      description: dir === currentParent ? '当前位置' : undefined,
      detail: dir,
      value: dir,
    })),
    `把「${path.basename(rel)}」移动到`
  );
}

// ---------------------------------------------------------------- 删除

/**
 * 删除文件或文件夹：搬进 `.novelforge/.trash/`，不真删。
 * 目录连同里面的东西整体搬走，垃圾箱里保留原来的相对路径以便找回。
 */
export async function deleteEntry(project: NovelProject, relPath: string): Promise<boolean> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return false;
  }
  const { abs, rel, info, isDir } = target;

  const detail = isDir ? await describeFolder(project, rel) : undefined;
  const pick = await getHost().confirm(`删除${isDir ? '文件夹' : ''}「${path.basename(rel)}」？`, ['删除'], {
    modal: true,
    detail: [detail, '会移到 .novelforge/.trash/，可手动找回。'].filter(Boolean).join('\n'),
  });
  if (pick !== '删除') {
    return false;
  }

  const dest = await trashPathFor(project, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(abs, dest);
  project.invalidate();
  if (info.section === 'chapters') {
    await project.syncManifest();
  }
  getHost().toast(`已移到回收站：${rel}`);
  return true;
}

/** 删文件夹前先说清楚里面有多少东西——整棵子树一起没了不该是个意外。 */
async function describeFolder(project: NovelProject, rel: string): Promise<string> {
  const abs = project.pathOf(rel);
  let files = 0;
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs++;
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        files++;
      }
    }
  };
  await walk(abs, 1);
  if (files === 0 && dirs === 0) {
    return '这个文件夹是空的。';
  }
  return `里面有 ${files} 个文件${dirs > 0 ? `、${dirs} 个子文件夹` : ''}，会一并移走。`;
}

/** 垃圾箱里保留原相对路径；同名冲突时加序号，不覆盖之前删掉的东西。 */
async function trashPathFor(project: NovelProject, rel: string): Promise<string> {
  const base = path.join(project.trashDir, rel);
  if (!(await exists(base))) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------- 内部工具

interface ResolvedTarget {
  abs: string;
  rel: string;
  info: SectionInfo;
  isDir: boolean;
}

/** 解析操作对象：必须存在、必须在某个区里、且不能是区的根目录本身。 */
async function resolveTarget(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  const info = sectionOf(project, rel);
  if (!info) {
    getHost().toast('只能操作章节、角色、设定目录里的内容。', 'error');
    return undefined;
  }
  if (rel === info.root) {
    getHost().toast(`「${info.label}」是工程的固定目录，不能重命名或删除。`, 'error');
    return undefined;
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  return { abs, rel, info, isDir };
}

/** 把一个「目录相对路径」收敛到某个区内；不在区里返回 undefined。 */
function resolveDirWithin(info: SectionInfo, dirRel?: string): string | undefined {
  if (dirRel === undefined || dirRel.trim() === '') {
    return info.root;
  }
  const rel = normalizeRel(dirRel);
  if (!rel) {
    return undefined;
  }
  return rel === info.root || rel.startsWith(`${info.root}/`) ? rel : undefined;
}

function validateName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return '不能为空';
  }
  if (/[\\/]/.test(trimmed)) {
    return '名字里不能有斜杠';
  }
  if (trimmed === '.' || trimmed === '..') {
    return '这个名字不能用';
  }
  // sanitizeFileName 会把非法字符全删掉，只剩兜底名——那等于用户什么也没输入。
  if (/^[\\/:*?"<>|\s]+$/.test(trimmed)) {
    return '名字里的字符都不能用于文件名';
  }
  return undefined;
}
