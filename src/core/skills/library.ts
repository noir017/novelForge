/**
 * 技能库：三个来源的技能从哪读、我的技能库怎么装与卸。
 *
 * | 来源 | 在哪 | 谁往里放 |
 * |---|---|---|
 * | 内置 | 代码里（[builtin/](builtin/index.ts)，一份一个文件） | 随应用发布，删不掉 |
 * | 我的技能库 | `~/.novelforge/skills/<名字>/SKILL.md`，所有工程共用 | 设置页「技能」或 agent 从 GitHub 装；也可以手放 |
 * | 本工程 | `.novelforge/skills/<名字>/SKILL.md`，跟着工程走、可进 Git | 作者手放 |
 *
 * **每次都读盘**（与 `NovelProject` 的约定一样）：作者随时可能在编辑器里改一份技能，下一次
 * 生成就该用改过的那份。一次装配只读绑定的那一份，不扫全库。
 *
 * ## 容错
 *
 * 一份读不出来的技能不连累其余的（上游同样「单个无效不阻断其余」）；目录不存在就是没有；
 * 别的读目录错误记一条 warn、当作这个来源是空的——上游在这里直接抛，于是工程里一个读不了的
 * `.vela/skills` 会让该工程**每一个**工作流都起不来，哪怕一份技能都没绑。
 *
 * **不跟链接**：符号链接的目录与文件一律跳过（上游 `app-data-controller.ts:285-309` 同样只认
 * 真目录）。我的技能库在工程外，没有 workspace 网关替它守边界，这一条就是它的边界。
 */
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homeDir } from '../stores';
import type { NovelProject } from '../model/project';
import {
  SkillInspection,
  SkillSource,
  inspectSkillMarkdown,
  isSkillName,
  parseSkillId,
  skillId,
} from '../model/writingSkill';
import { scoped } from '../runtime/logger';
import { BUILTIN_SKILLS } from './builtin';

const log = scoped('技能');

const SKILL_FILE = 'SKILL.md';

export interface LoadedSkill {
  /** `来源:名字`。 */
  id: string;
  source: SkillSource;
  /** id 里的名字。用户与工程技能就是目录名。 */
  name: string;
  inspection: SkillInspection;
  /** 本工程技能在工程里的相对路径（明细与设置页上点得开）。其余来源没有。 */
  relPath?: string;
  /** 磁盘上那份 `SKILL.md` 的绝对路径。内置没有。 */
  filePath?: string;
}

// ---------------------------------------------------------------- 我的技能库在哪

let userDirOverride: string | undefined;

/** `~/.novelforge/skills/`。 */
export function userSkillsDir(): string {
  return userDirOverride ?? path.join(homeDir(), 'skills');
}

/** 测试用：把「我的技能库」指到临时目录。传 undefined 复原。 */
export function setUserSkillsDir(dir: string | undefined): void {
  userDirOverride = dir;
}

/** 卸载的技能挪去哪：与技能库同级的 `.trash/skills/`（默认即 `~/.novelforge/.trash/skills/`）。 */
function userTrashDir(): string {
  return path.join(path.dirname(userSkillsDir()), '.trash', 'skills');
}

// ---------------------------------------------------------------- 读

function builtins(): LoadedSkill[] {
  return BUILTIN_SKILLS.map((b) => ({
    id: skillId('builtin', b.name),
    source: 'builtin' as const,
    name: b.name,
    inspection: inspectSkillMarkdown(b.raw, b.name),
  }));
}

/** 全部技能：内置 → 我的技能库 → 本工程（给了工程才扫）。各来源内按名字排。 */
export async function listSkills(project?: NovelProject): Promise<LoadedSkill[]> {
  const [user, own] = await Promise.all([
    scan(userSkillsDir(), 'user'),
    project ? scan(project.skillsDir, 'project', project) : Promise.resolve([]),
  ]);
  return [...builtins(), ...user, ...own];
}

/** 按 id 读一份。找不到（没有、读不出、是链接、id 不合法）一律 undefined。 */
export async function loadSkill(id: string, project?: NovelProject): Promise<LoadedSkill | undefined> {
  const parsed = parseSkillId(id);
  if (!parsed) {
    return undefined;
  }
  if (parsed.source === 'builtin') {
    return builtins().find((s) => s.name === parsed.name);
  }
  if (parsed.source === 'project' && !project) {
    return undefined;
  }
  const root = parsed.source === 'user' ? userSkillsDir() : project!.skillsDir;
  return readOne(root, parsed.name, parsed.source, project);
}

async function scan(root: string, source: SkillSource, project?: NovelProject): Promise<LoadedSkill[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`读不了技能目录 ${root}，这个来源当作没有技能`, String((err as Error)?.message ?? err));
    }
    return [];
  }
  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    // Dirent 对符号链接报 isSymbolicLink、不报 isDirectory：链接在这里就被跳过了。
    if (!entry.isDirectory()) {
      continue;
    }
    if (!isSkillName(entry.name)) {
      log.warn(
        `技能目录「${entry.name}」的名字不合法，跳过`,
        '名字要以字母或数字开头，只能含字母、数字、. _ -，最长 64 个字符。'
      );
      continue;
    }
    const skill = await readOne(root, entry.name, source, project);
    if (skill) {
      out.push(skill);
    }
  }
  // 按码点排，不用 localeCompare：那个跟着系统区域走，中文名排在英文前还是后因机器而异。
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function readOne(
  root: string,
  name: string,
  source: SkillSource,
  project?: NovelProject
): Promise<LoadedSkill | undefined> {
  if (!isSkillName(name)) {
    return undefined;
  }
  const dir = path.join(root, name);
  const filePath = path.join(dir, SKILL_FILE);
  try {
    const [dirInfo, fileInfo] = await Promise.all([fs.lstat(dir), fs.lstat(filePath)]);
    if (!dirInfo.isDirectory() || !fileInfo.isFile()) {
      return undefined;
    }
    const raw = await fs.readFile(filePath, 'utf8');
    return {
      id: skillId(source, name),
      source,
      name,
      inspection: inspectSkillMarkdown(raw, name),
      relPath: source === 'project' && project ? project.relPath(filePath) : undefined,
      filePath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`读不了技能 ${skillId(source, name)}`, String((err as Error)?.message ?? err));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- 我的技能库：装与卸

/**
 * 把一份 `SKILL.md` 原样写进我的技能库。**同名的已经有了就报错退出**，不覆盖（第 3 条；
 * 上游同样拒绝同名重装——要换新版先卸载旧的）。
 *
 * 兼容与否、是不是检查过的那一份，由调用方（[github.ts](github.ts)）把关；这里只管落盘。
 */
export async function installUserSkill(name: string, raw: string): Promise<LoadedSkill> {
  if (!isSkillName(name)) {
    throw new Error(`技能名「${name}」不合法：要以字母或数字开头，只能含字母、数字、. _ -，最长 64 个字符。`);
  }
  const root = userSkillsDir();
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) {
    throw new Error(`${root} 是一个链接，不往里写。`);
  }
  const dir = path.join(root, name);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`我的技能库里已经有「${name}」了。要换新版，先卸载旧的。`);
    }
    throw err;
  }
  await fs.writeFile(path.join(dir, SKILL_FILE), raw, { encoding: 'utf8', mode: 0o600 });
  const skill = await readOne(root, name, 'user');
  if (!skill) {
    throw new Error(`「${name}」写进去之后读不回来。`);
  }
  log.info(`已装进我的技能库：${name}`, path.join(dir, SKILL_FILE));
  return skill;
}

/**
 * 从我的技能库卸载：**整个目录挪进回收站**（`.trash/skills/`，同名的加 `-2`），不真删（第 6 条
 * 的精神；上游是 `rmSync`）。返回落点；本来就没有时返回 undefined。
 */
export async function uninstallUserSkill(name: string): Promise<string | undefined> {
  if (!isSkillName(name)) {
    throw new Error(`技能名「${name}」不合法。`);
  }
  const dir = path.join(userSkillsDir(), name);
  let info: Stats;
  try {
    info = await fs.lstat(dir);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${dir} 不是一个普通目录，不动它。`);
  }
  const trash = userTrashDir();
  await fs.mkdir(trash, { recursive: true });
  let dest = path.join(trash, name);
  for (let i = 2; await present(dest); i++) {
    dest = path.join(trash, `${name}-${i}`);
  }
  await fs.rename(dir, dest);
  log.info(`已从我的技能库卸载：${name}`, `挪到 ${dest}`);
  return dest;
}

async function present(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
