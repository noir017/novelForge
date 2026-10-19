/**
 * 路径 → 种类。**纯函数、零 I/O、绝不抛。**
 *
 * 这是整个 workspace 网关的地基：`write` 不是「往这个路径写字节」，而是
 * 「按这个路径**应有的种类**写一份合法产物」——种类判定、渲染、记账、伴生
 * 搬迁、覆盖审阅全在网关里做一次。判定得先有一张表。
 *
 * ## 为什么必须绝不抛
 *
 * 这个函数会被**前端传上来的路径**调用（文件页的右键菜单、内置编辑器的
 * 保存、日后 agent 的工具参数）。认不出、越界、空串一律 `{ kind: 'other' }`，
 * 越界时连 `rel` 都不给——调用方据此判「这条路径根本不该碰」，而不是拿一个
 * 抛出来的异常去猜。
 *
 * ## 三条必须记住的取舍
 *
 * 1. **正文就是章节**。一章一纲之后正文直接落 `chapters/`，没有中转站了。章节路径
 *    **不带创作目标**：第 12 章的细纲是正文路径在 `summaries/` 下的镜像
 *    （`NovelProject.plotPathForChapter`），配对要读盘，不在这里做。
 * 2. **`chapter` 与 `other` 的边界不看是不是 `.md`**（AGENTS 第 9 条：章节
 *    不认扩展名）。章节根之下 + 数字前缀 + 扩展名不在二进制黑名单 → `chapter`。
 *    角色 / 设定 / 细纲**不**跟着放宽，它们是插件自己的数据格式。
 * 3. **规则各自只定义一次**：章节名规则在 `model/chapterFile.ts`，细纲名在
 *    `model/plotFile.ts`。这里只 import，绝不复制一份正则出来。
 *
 * ## 老工程的 `volumes/`、`manuscripts/`、`scenes/`、`plots/` 现在是 `other`
 *
 * 卷、中转站、场景三层都删掉了（见 `model/pipeline.ts` 的文件头）；细纲从 `plots/` 搬进了
 * `summaries/`，与单章摘要并成一份（见 `model/plotFile.ts` 的文件头）。老工程磁盘上
 * 那几个目录**一个字节都不动**——它们是作者的文件——但代码里彻底不认它们：判成
 * `other`，于是工程页不显示、装配器不读、网关按普通文本处理。`guard.ts` 的 `isProtectedPath`
 * 仍然把那几个目录列为受保护目录，免得哪条文件操作把它们整棵删掉。
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { CreationStage, CreationTarget, SettingDoc } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName } from '../model/plotFile';

export type ArtifactKind =
  | 'setting'
  | 'outline'
  | 'style'
  | 'globalSummary'
  | 'threads'
  /** 写作技能：本工程的 `.novelforge/skills/**` 与阶段绑定 `.novelforge/skills.json`。 */
  | 'skill'
  /**
   * 自定义敏感词表 `.novelforge/sensitive.txt`（内置编辑器的写作体检用）。链外：没有创作阶段、不进装配器、
   * 不记指纹；单列一种而不落 `other`，是为了它照样存历史版本（作者手维护的词表，改坏了要找得回来）。
   */
  | 'sensitive'
  | 'plot'
  | 'chapter'
  | 'draft'
  | 'character'
  | 'lore'
  | 'other';

export interface PathKind {
  kind: ArtifactKind;
  /** 规范化后的相对路径（正斜杠）。越界时是 undefined，此时 kind 恒为 'other'。 */
  rel?: string;
  /** 该路径对应的创作层。非创作产物为 undefined。 */
  stage?: CreationStage;
  /** 该路径对应的创作目标，供 generate 直接用。 */
  target?: CreationTarget;
  /** 序号。章节与细纲的都是章号。 */
  no?: number;
  /** 细纲的路径（`plot` 种类才有）。 */
  plotRelPath?: string;
  /** 架构的哪一件（`setting` 种类才有）。 */
  doc?: SettingDoc;
}

/**
 * 把用户/前端给来的相对路径收敛为「工程内的、用正斜杠的」相对路径。
 * 绝对路径、`..` 逃逸、空路径一律返回 undefined。
 *
 * 逐字搬自 `files/fileOps.ts` 的 `normalizeRel`——那是六处守卫里最早的一份，
 * 口径不能变。fileOps 现在转发到这里。
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

/** 工程里几个固定目录的工作区相对路径。每次算一遍，不缓存——chaptersDir 可配。 */
interface Dirs {
  chapters: string;
  drafts: string;
  plots: string;
  characters: string;
  lore: string;
  config: string;
  premise: string;
  world: string;
  outline: string;
  style: string;
  globalSummary: string;
  threads: string;
  skills: string;
  skillBindings: string;
  sensitive: string;
}

function dirsOf(project: NovelProject): Dirs {
  return {
    chapters: project.relPath(project.chaptersDir),
    drafts: project.relPath(project.draftsDir),
    plots: project.relPath(project.plotsDir),
    characters: project.relPath(project.charactersDir),
    lore: project.relPath(project.loreDir),
    config: project.relPath(project.configPath),
    premise: project.relPath(project.premisePath),
    world: project.relPath(project.worldPath),
    outline: project.relPath(project.outlinePath),
    style: project.relPath(project.stylePath),
    globalSummary: project.relPath(project.globalSummaryPath),
    threads: project.relPath(project.threadsPath),
    skills: project.relPath(project.skillsDir),
    skillBindings: project.relPath(project.skillBindingsPath),
    sensitive: project.relPath(project.sensitivePath),
  };
}

/** rel 落在 root 之下（含 root 本身）时返回它在 root 下的那段，否则 undefined。 */
function under(rel: string, root: string): string | undefined {
  if (!root) {
    // chaptersDir 被配成 `.` 时 root 是空串：整个工程根都算章节区。
    return rel;
  }
  if (rel === root) {
    return '';
  }
  return rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : undefined;
}

/** 只认 markdown 家族的那几个区（角色 / 设定）共用。细纲的名字规则在 `model/plotFile.ts`。 */
function isMd(rel: string): boolean {
  const ext = path.posix.extname(rel).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/**
 * 路径 → 种类。**绝不抛。**
 *
 * 判定顺序有讲究：固定单文件（架构三件 / outline / style / global.md）排在各自所属
 * 目录之前——`summaries/global.md` 是全书摘要，不是一份细纲。
 */
export function kindOfPath(project: NovelProject, relPath: string): PathKind {
  const rel = normalizeRel(relPath);
  if (rel === undefined) {
    return { kind: 'other' };
  }
  const d = dirsOf(project);

  // ---- 固定单文件。必须排在目录判定之前。
  for (const doc of ['config', 'premise', 'world'] as const) {
    if (rel === d[doc]) {
      return { kind: 'setting', rel, doc, stage: 'setting', target: { kind: 'setting', doc } };
    }
  }
  if (rel === d.outline) {
    return { kind: 'outline', rel, stage: 'outline', target: { kind: 'outline' } };
  }
  if (rel === d.style) {
    return { kind: 'style', rel };
  }
  if (rel === d.globalSummary) {
    return { kind: 'globalSummary', rel };
  }
  // 叙事线（七期）：可选的固定文件，与全书摘要同类——没有创作阶段，由工程页动作与定稿追加。
  if (rel === d.threads) {
    return { kind: 'threads', rel };
  }
  // 写作技能：链外，没有创作阶段。装配器只经 core/skills/ 读绑定的那一份。
  if (rel === d.skillBindings || under(rel, d.skills) !== undefined) {
    return { kind: 'skill', rel };
  }
  // 敏感词表：链外的固定文件，与技能同类——没有创作阶段，装配器不读，只有内置编辑器的体检读它。
  if (rel === d.sensitive) {
    return { kind: 'sensitive', rel };
  }

  // ---- 细纲。`summaries/` 下各级子目录里数字开头的 markdown 家族（镜像正文的相对路径）。
  // 根下的 `global.md` 上面已经判过；老工程的 `plots/` 落到最后的 other。
  const inPlots = under(rel, d.plots);
  if (inPlots !== undefined && inPlots) {
    const parsed = parsePlotFileName(path.posix.basename(inPlots));
    if (parsed) {
      return {
        kind: 'plot',
        rel,
        no: parsed.no,
        stage: 'plot',
        target: { kind: 'plot', plotRelPath: rel },
        plotRelPath: rel,
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 角色 / 设定。递归扫描，只认 `.md`。
  const inCharacters = under(rel, d.characters);
  if (inCharacters !== undefined && inCharacters) {
    return { kind: isMd(inCharacters) ? 'character' : 'other', rel };
  }
  // 一条设定条目是架构那一层的一个目标（展开，完善设定 2026-10-19）：MCP 的 `generate` 给条目路径就是展开它。
  // 设定目录本身仍是设定清单，那一条只在 `generate` 里认（tools/novel/generate.ts 的 `loreListPath`）。
  const inLore = under(rel, d.lore);
  if (inLore !== undefined && inLore) {
    return isMd(inLore)
      ? { kind: 'lore', rel, stage: 'setting', target: { kind: 'lore', relPath: rel } }
      : { kind: 'other', rel };
  }

  // ---- 草稿。判定必须排在章节之前：`chaptersDir` 被配成 `.` 时
  // `drafts/` 会落进章节区（`chapterSkipDirs` 是同一条防线）。
  const inDrafts = under(rel, d.drafts);
  if (inDrafts !== undefined && inDrafts) {
    return { kind: 'draft', rel };
  }

  // ---- 章节。数字前缀 + 扩展名不在二进制黑名单，**不看是不是 `.md`**。
  const inChapters = under(rel, d.chapters);
  if (inChapters !== undefined && inChapters) {
    // `.novelforge/` 在 chaptersDir 配成 `.` 时会落进来，但它上面几条已经
    // 各自拦过；剩下的 `.novelforge/xxx` 不该被当成章节。
    const parsed = inChapters.startsWith('.') ? undefined : parseChapterFileName(path.posix.basename(inChapters));
    return parsed ? { kind: 'chapter', rel, no: parsed.order } : { kind: 'other', rel };
  }

  return { kind: 'other', rel };
}

/**
 * 反过来：这个创作目标该落在哪个路径。`acceptArtifact` 用它。
 *
 * 与 `kindOfPath` 互为逆运算（见 tests/unit/workspace/kind.test.js 的往返用例）。
 *
 * **正文不在这里**：它落在同号的章节上，而同号的章节在不在、叫什么名字要读盘才
 * 知道——这个函数是纯的。正文的落点走 views/pipeline.ts 的 `chapterTargetOf`。
 * 角色图谱给的是角色目录、设定清单给的是设定目录：它们是一组卡 / 一组条目，不是一个文件。
 * 单条设定就是那一条条目自己的路径。
 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string {
  switch (target.kind) {
    case 'setting':
      return project.relPath(project.settingPath(target.doc));
    case 'outline':
      return project.relPath(project.outlinePath);
    case 'plot':
      return target.plotRelPath;
    case 'lore':
      return target.relPath;
    case 'manuscript':
      throw new Error('正文的落点要按章号去认同号的章节，请改用 views/pipeline.ts 的 chapterTargetOf。');
  }
}

/**
 * 这个路径是不是一份细纲。工程页的 rename/move/delete 据此分流。
 *
 * `files/fileOps.ts` 的同名导出转发到这里，调用方不必改。
 */
export function isPlotPath(project: NovelProject, relPath: string): boolean {
  return kindOfPath(project, relPath).kind === 'plot';
}
