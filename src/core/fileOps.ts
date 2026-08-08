import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from './host';
import { scoped } from './logger';
import { isMarkdownPath } from './model/chapterFile';
import { NovelProject, exists, readText, sanitizeFileName, writeText } from './model/project';

const log = scoped('文件');

/**
 * 工程页的类文件操作：新建文件夹、重命名、移动、删除。
 *
 * 三条硬约束：
 *
 * 1. **不越界**：每个操作都锁在它所属的区（chapters/ 、characters/ 、lore/）里。
 *    章节挪不进角色目录，任何路径也出不了工程根——`..` 一律拒绝。
 * 2. **不静默覆盖**：目标已存在就报错退出，绝不覆盖作者的文件。
 * 3. **不真删**：删除是搬进 `.novelforge/.trash/`，与会话删除同一套做法。
 *
 * 章节改名/移动时，`drafts/` 里对应的草稿一并搬走（见 carryDraft）——
 * 草稿不是可管理区，但它的位置由章节路径推导，章节动了就必须跟着动。
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

/**
 * 工程的固定目录：改名/搬走会让工程结构散架（章节索引、草稿镜像、
 * 元数据与会话）。文件页的根范围操作对这些路径一律拒绝。
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
    '.novelforge/.trash',
  ];
  return fixed.includes(rel);
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
    log.warn(`新建文件夹被拒：已存在 ${rel}`);
    getHost().toast(`已存在：${rel}`, 'error');
    return undefined;
  }
  await fs.mkdir(abs, { recursive: true });
  project.invalidate();
  log.info(`已新建文件夹 ${rel}`);
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
  return renameEntryImpl(project, relPath, true);
}

/**
 * 工程根范围的重命名（文件页用）。不再要求路径在三个管理区内，
 * 但固定目录受 isProtectedPath 保护；章节的序号前缀/H1 同步与草稿跟随
 * 在路径确实位于章节区时照常生效。
 */
export async function renameEntryInRoot(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, false);
}

async function renameEntryImpl(
  project: NovelProject,
  relPath: string,
  requireSection: boolean
): Promise<string | undefined> {
  const target = requireSection
    ? await resolveTarget(project, relPath)
    : await resolveTargetInRoot(project, relPath);
  if (!target) {
    return undefined;
  }
  const { abs, rel, isDir } = target;

  const base = path.basename(rel);
  const ext = isDir ? '' : path.extname(base);
  const stem = isDir ? base : base.slice(0, base.length - ext.length);
  // 章节的序号前缀单独拆出来，让用户只编辑标题部分。
  const prefixMatch = !isDir && target.info?.section === 'chapters' ? /^(\d{1,5}[-_.\s]*)(.*)$/.exec(stem) : null;
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
    log.warn(`重命名被拒：已存在同名项 ${nextRel}`);
    getHost().toast(`已存在同名项：${nextRel}`, 'error');
    return undefined;
  }

  // 先改内容再改名：改名成功后内容一定是对的，反过来则可能留下半吊子状态。
  // 用清洗后的 nextStem 而不是用户原样输入，H1 才会继续与文件名一致，
  // 下次改名时仍然认得出「这个 H1 是跟着文件名走的」。
  //
  // 只对 markdown 家族做：.txt 章节的标题本来就只取文件名，往里写一行 `# x`
  // 是凭空多出来的 markdown 痕迹；.json 章节则是直接写坏文件。
  if (!isDir && target.info?.section === 'chapters' && isMarkdownPath(rel)) {
    const body = await readText(abs);
    const updated = renamedBody(body, editable, nextStem);
    if (updated !== body) {
      await writeText(abs, updated);
      log.debug(`正文里的 # 标题跟着改名同步`, `「${editable}」→「${nextStem}」`);
    }
  }

  await fs.rename(abs, nextAbs);
  project.invalidate();
  if (target.info?.section === 'chapters') {
    await carryDraft(project, rel, nextRel, isDir);
    await project.syncManifest();
  }
  log.info(`已重命名${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
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
    log.warn(`移动被拒：目标目录不在「${info.label}」区里`, `${rel} → ${targetDir}`);
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
    log.warn(`移动被拒：不能把文件夹移进自己里面`, `${rel} → ${destRel}`);
    getHost().toast('不能把文件夹移动到它自己里面。', 'error');
    return undefined;
  }
  if (!(await exists(project.pathOf(destRel)))) {
    log.warn(`移动被拒：目标目录不存在 ${destRel}`);
    getHost().toast(`目标目录不存在：${destRel}`, 'error');
    return undefined;
  }

  const nextRel = `${destRel}/${path.basename(rel)}`;
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`移动被拒：目标目录里已有同名项 ${nextRel}`);
    getHost().toast(`目标目录里已有同名项：${nextRel}`, 'error');
    return undefined;
  }

  await fs.rename(abs, nextAbs);
  project.invalidate();
  if (info.section === 'chapters') {
    await carryDraft(project, rel, nextRel, isDir);
    // 路径变了但序号没变，syncManifest 会按 order 兜底找回 summaryHash。
    await project.syncManifest();
  }
  log.info(`已移动${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
  getHost().toast(`已移动到 ${nextRel}`);
  return nextRel;
}

/**
 * 章节改名/移动后，把它的草稿一并搬过去。
 *
 * 不搬的话草稿就成了孤儿：下次点「打开草稿」会在新位置静默新建一个空文件，
 * 之前写的东西还躺在旧路径下，没人告诉作者。文件与目录都要搬——
 * 移动 `chapters/卷一/` 时 `drafts/卷一/` 得跟着走。
 *
 * 目标位置已有草稿时**不覆盖**：两份都留着，提示作者自己去合。
 */
export async function carryDraft(
  project: NovelProject,
  fromRel: string,
  toRel: string,
  isDir: boolean
): Promise<void> {
  const fromDraft = project.draftRelPathFor(fromRel);
  const toDraft = project.draftRelPathFor(toRel);
  if (!fromDraft || !toDraft || fromDraft === toDraft) {
    return;
  }
  const fromAbs = project.pathOf(fromDraft);
  if (!(await exists(fromAbs))) {
    return;
  }
  const toAbs = project.pathOf(toDraft);
  if (await exists(toAbs)) {
    log.warn(
      `新位置已有${isDir ? '草稿目录' : '草稿'}，旧草稿未动`,
      `目标 ${toDraft}｜旧草稿仍在 ${fromDraft}`
    );
    getHost().toast(
      `新位置已有${isDir ? '草稿目录' : '草稿'}：${toDraft}，旧草稿留在 ${fromDraft} 未动。`,
      'error'
    );
    return;
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  log.info(`草稿已跟随移动`, `${fromDraft} → ${toDraft}`);
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
  // 草稿不跟着删——那是作者另写的东西，删正文不代表要连草稿一起丢。
  // 但得说一句，否则「删了这一章」之后草稿还在，下次看见会以为闹鬼。
  const draftNote = await describeDraft(project, rel, info.section);
  const pick = await getHost().confirm(`删除${isDir ? '文件夹' : ''}「${path.basename(rel)}」？`, ['删除'], {
    modal: true,
    detail: [detail, draftNote, '会移到 .novelforge/.trash/，可手动找回。'].filter(Boolean).join('\n'),
  });
  if (pick !== '删除') {
    log.info(`用户取消了删除 ${rel}`);
    return false;
  }

  const dest = await trashPathFor(project, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(abs, dest);
  project.invalidate();
  if (info.section === 'chapters') {
    await project.syncManifest();
  }
  log.info(`已移到回收站：${rel}`, `落点 ${project.relPath(dest)}${detail ? `｜${detail}` : ''}`);
  getHost().toast(`已移到回收站：${rel}`);
  return true;
}

/** 有草稿时在确认框里说一声——它不会跟着删。 */
async function describeDraft(project: NovelProject, rel: string, section: Section): Promise<string | undefined> {
  if (section !== 'chapters') {
    return undefined;
  }
  const draft = project.draftRelPathFor(rel);
  if (!draft || !(await exists(project.pathOf(draft)))) {
    return undefined;
  }
  return `草稿 ${draft} 不会一起删除。`;
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
    log.warn(`操作被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  const info = sectionOf(project, rel);
  if (!info) {
    log.warn(`操作被拒：${rel} 不在章节/角色/设定三个区里`);
    getHost().toast('只能操作章节、角色、设定目录里的内容。', 'error');
    return undefined;
  }
  if (rel === info.root) {
    log.warn(`操作被拒：${rel} 是「${info.label}」区的固定根目录`);
    getHost().toast(`「${info.label}」是工程的固定目录，不能重命名或删除。`, 'error');
    return undefined;
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能刚被改名或删除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  return { abs, rel, info, isDir };
}

/** 根范围解析：路径合法、不是固定目录、存在即可（不要求在三区内）。 */
async function resolveTargetInRoot(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`操作被拒：${rel} 是工程的固定目录`);
    getHost().toast(`「${rel}」是工程的固定目录，不能改名或搬走。`, 'error');
    return undefined;
  }
  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能刚被改名或删除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  // 区外路径 info 为 undefined：下游用 `target.info?.section` 守卫。
  const info = sectionOf(project, rel);
  return { abs, rel, info: info as SectionInfo, isDir };
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

export function validateName(value: string): string | undefined {
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
