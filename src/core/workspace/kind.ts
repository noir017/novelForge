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
 * 1. **`manuscript` / `summary` 的归属靠镜像路径反推**，
 *    `manuscripts/01-觉醒之日/012-入宗.md` → 细纲是
 *    `plots/01-觉醒之日/012-入宗.md`。反推是 `project.plotStem` 的逆运算——
 *    镜像的是段在 `plots/` 之下的**整段路径**，所以卷那一层原样带着；
 *    **找不到对应的细纲文件时仍然返回 `kind: 'manuscript'`**（那个文件确实在
 *    那儿），只是 `plotRelPath` 指向那个「应该存在」的位置。零 I/O 的代价与
 *    好处都在这里：不查盘，所以判定稳定。
 * 2. **`chapter` 与 `other` 的边界不看是不是 `.md`**（AGENTS 第 9 条：章节
 *    不认扩展名）。章节根之下 + 数字前缀 + 扩展名不在二进制黑名单 → `chapter`。
 *    角色 / 设定 / 细纲**不**跟着放宽，它们是插件自己的数据格式。
 * 3. **规则各自只定义一次**：章节名规则在 `model/chapterFile.ts`，细纲名在
 *    `model/plotFile.ts`，卷纲名在 `model/volumeFile.ts`。这里只 import，
 *    绝不复制一份正则出来——复制的那份会慢慢跑偏。
 *
 * ## `.novelforge/scenes/` 现在是 `other`
 *
 * 场景那一层已经删掉（见 `model/pipeline.ts` 的文件头）。老工程磁盘上那个目录
 * **一个字节都不动**——它是作者的文件——但代码里彻底不认它了：判成 `other`，
 * 于是工程页不显示、装配器不读、网关按普通文本处理。`guard.ts` 的
 * `isProtectedPath` 仍然把它列为受保护目录，免得哪条文件操作把它整棵删掉。
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { CreationStage, CreationTarget } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName, plotFileName } from '../model/plotFile';
import { parseVolumeFileName, volumeFileName } from '../model/volumeFile';

export type ArtifactKind =
  | 'outline'
  | 'style'
  | 'globalSummary'
  | 'volume'
  | 'plot'
  | 'manuscript'
  | 'chapter'
  | 'summary'
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
  /** 序号。章节的是章号，细纲的是段号，卷纲的是卷号。 */
  no?: number;
  /** `manuscript` 这类镜像产物所属的细纲路径。 */
  plotRelPath?: string;
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
  volumes: string;
  plots: string;
  manuscripts: string;
  summaries: string;
  characters: string;
  lore: string;
  outline: string;
  style: string;
  globalSummary: string;
}

function dirsOf(project: NovelProject): Dirs {
  return {
    chapters: project.relPath(project.chaptersDir),
    drafts: project.relPath(project.draftsDir),
    volumes: project.relPath(project.volumesDir),
    plots: project.relPath(project.plotsDir),
    manuscripts: project.relPath(project.manuscriptsDir),
    summaries: project.relPath(project.summariesDir),
    characters: project.relPath(project.charactersDir),
    lore: project.relPath(project.loreDir),
    outline: project.relPath(project.outlinePath),
    style: project.relPath(project.stylePath),
    globalSummary: project.relPath(project.globalSummaryPath),
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

/** 只认 markdown 家族的那几个区（细纲 / 角色 / 设定 / 摘要）共用。 */
function isMd(rel: string): boolean {
  const ext = path.posix.extname(rel).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/**
 * 路径 → 种类。**绝不抛。**
 *
 * 判定顺序有讲究：固定单文件（outline / style / global.md）排在各自所属目录
 * 之前——`summaries/global.md` 不是「第 0 章的摘要」。
 */
export function kindOfPath(project: NovelProject, relPath: string): PathKind {
  const rel = normalizeRel(relPath);
  if (rel === undefined) {
    return { kind: 'other' };
  }
  const d = dirsOf(project);

  // ---- 固定单文件。必须排在目录判定之前。
  if (rel === d.outline) {
    return { kind: 'outline', rel, stage: 'outline', target: { kind: 'outline' } };
  }
  if (rel === d.style) {
    return { kind: 'style', rel };
  }
  if (rel === d.globalSummary) {
    return { kind: 'globalSummary', rel };
  }

  // ---- 卷纲。扁平目录（词干要当 `plots/` 下的目录名用），只认 markdown 家族。
  const inVolumes = under(rel, d.volumes);
  if (inVolumes !== undefined && inVolumes) {
    const parsed = parseVolumeFileName(path.posix.basename(inVolumes));
    if (parsed && !inVolumes.includes('/')) {
      return {
        kind: 'volume',
        rel,
        no: parsed.no,
        stage: 'volume',
        target: { kind: 'volume', volumeRelPath: rel },
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 细纲（剧情段）。**按卷分子目录**，只认 markdown 家族。
  const inPlots = under(rel, d.plots);
  if (inPlots !== undefined && inPlots) {
    const parsed = parsePlotFileName(path.posix.basename(inPlots));
    // 一层子目录（卷）或直接躺在根下（未分卷）都算；再深就不是段了——
    // `listPlots` 递归扫得到它，但那一层没有任何语义。
    if (parsed && inPlots.split('/').length <= 2) {
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

  // ---- 中转站正文。镜像细纲在 `plots/` 之下的整段路径（可能带一层卷目录）。
  const inManuscripts = under(rel, d.manuscripts);
  if (inManuscripts !== undefined && inManuscripts) {
    const parsed = parsePlotFileName(path.posix.basename(inManuscripts));
    if (parsed && inManuscripts.split('/').length <= 2) {
      const plotRelPath = plotPathOfStem(project, stripExt(inManuscripts));
      return {
        kind: 'manuscript',
        rel,
        no: parsed.no,
        stage: 'manuscript',
        target: { kind: 'manuscript', plotRelPath },
        plotRelPath,
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 摘要。镜像 `chapters/` 下的相对路径，可能有分卷子目录。
  const inSummaries = under(rel, d.summaries);
  if (inSummaries !== undefined && inSummaries) {
    if (isMd(inSummaries)) {
      return {
        kind: 'summary',
        rel,
        no: parseChapterFileName(path.posix.basename(inSummaries))?.order,
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 角色 / 设定。递归扫描，只认 `.md`。
  const inCharacters = under(rel, d.characters);
  if (inCharacters !== undefined && inCharacters) {
    return { kind: isMd(inCharacters) ? 'character' : 'other', rel };
  }
  const inLore = under(rel, d.lore);
  if (inLore !== undefined && inLore) {
    return { kind: isMd(inLore) ? 'lore' : 'other', rel };
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
 * 镜像目录/文件的**镜像键** → 它所属细纲的路径。`project.plotStem` 的逆运算。
 *
 * **不查盘**：返回的是「那份细纲应该在哪」。键本身就是段在 `plots/` 之下的
 * 那段路径（`01-觉醒之日/012-入宗`，未分卷时就是 `012-入宗`），所以直接拼回
 * `plots/<键>.md` 即可。
 */
function plotPathOfStem(project: NovelProject, stem: string): string {
  const plotsRoot = project.relPath(project.plotsDir);
  return `${plotsRoot}/${stem}.md`;
}

/** 去掉扩展名，路径分隔符原样保留（`01-卷/012-入宗.md` → `01-卷/012-入宗`）。 */
function stripExt(rel: string): string {
  const ext = path.posix.extname(rel);
  return ext ? rel.slice(0, rel.length - ext.length) : rel;
}

/**
 * 反过来：这个创作目标该落在哪个路径。`acceptArtifact` 用它。
 *
 * 与 `kindOfPath` 互为逆运算（见 tests/unit/workspace/kind.test.js 的往返用例）。
 * **正文落在中转站而不是 `chapters/`**——切成发布章是作者的活（第 23 条）。
 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return project.relPath(project.outlinePath);
    case 'volume':
      return target.volumeRelPath;
    case 'plot':
      return target.plotRelPath;
    case 'manuscript':
      return project.manuscriptMirrorRelPath(target.plotRelPath);
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

/**
 * 段号 + 标题 → 细纲**应该**落在哪。`plotFileName` 的薄包装，供网关内部拼路径。
 *
 * `dir` 给这一段所属那一卷的段目录（`plots/01-觉醒之日`）；不给就落在
 * `plots/` 根下，那是「未分卷」。
 */
export function plotRelPathFor(
  project: NovelProject,
  no: number,
  safeTitle: string,
  dir?: string
): string {
  const parent = (dir && normalizeRel(dir)) || project.relPath(project.plotsDir);
  return `${parent}/${plotFileName(no, safeTitle)}`;
}

/** 卷号 + 标题 → 卷纲**应该**落在哪。`volumeFileName` 的薄包装。 */
export function volumeRelPathFor(project: NovelProject, no: number, safeTitle: string): string {
  return `${project.relPath(project.volumesDir)}/${volumeFileName(no, safeTitle)}`;
}
