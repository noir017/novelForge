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
 * 1. **`scene` / `manuscript` / `summary` 的归属靠镜像目录名反推**，
 *    `scenes/012-入宗/02-翻越侧峰.md` → 细纲是 `plots/012-入宗.md`。反推是
 *    `project.plotStem` 的逆运算；**找不到对应的细纲文件时仍然返回
 *    `kind: 'scene'`**（那个文件确实在那儿），只是 `plotRelPath` 指向那个
 *    「应该存在」的位置。零 I/O 的代价与好处都在这里：不查盘，所以判定稳定。
 * 2. **`chapter` 与 `other` 的边界不看是不是 `.md`**（AGENTS 第 9 条：章节
 *    不认扩展名）。章节根之下 + 数字前缀 + 扩展名不在二进制黑名单 → `chapter`。
 *    角色 / 设定 / 细纲 / 场景**不**跟着放宽，它们是插件自己的数据格式。
 * 3. **规则各自只定义一次**：章节名规则在 `model/chapterFile.ts`，细纲名在
 *    `model/plotFile.ts`，场景名在 `model/sceneFile.ts`。这里只 import，
 *    绝不复制一份正则出来——复制的那份会慢慢跑偏。
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { CreationStage, CreationTarget } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName, plotFileName } from '../model/plotFile';
import { parseSceneFileName } from '../model/sceneFile';

export type ArtifactKind =
  | 'outline'
  | 'style'
  | 'globalSummary'
  | 'plot'
  | 'scene'
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
  /** 章号。章节 / 细纲 / 场景 / 中转站正文 / 摘要都有。 */
  no?: number;
  /** 场号，只有 `scene` 有。 */
  sceneNo?: number;
  /** scene / manuscript 这类镜像产物所属的细纲路径。 */
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
  plots: string;
  scenes: string;
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
    plots: project.relPath(project.plotsDir),
    scenes: project.relPath(project.scenesDir),
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

/** 只认 markdown 家族的那几个区（细纲 / 场景 / 角色 / 设定 / 摘要）共用。 */
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

  // ---- 细纲。扁平目录，只认 markdown 家族。
  const inPlots = under(rel, d.plots);
  if (inPlots !== undefined && inPlots) {
    const parsed = parsePlotFileName(path.posix.basename(inPlots));
    // 扁平：`plots/卷一/012.md` 不是细纲（listPlots 也扫不到它那一层的语义）。
    if (parsed && !inPlots.includes('/')) {
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

  // ---- 场景。`scenes/<细纲词干>/NN-标题.md`，归属靠目录名反推。
  const inScenes = under(rel, d.scenes);
  if (inScenes !== undefined && inScenes) {
    const slash = inScenes.indexOf('/');
    const stem = slash < 0 ? '' : inScenes.slice(0, slash);
    const name = slash < 0 ? inScenes : inScenes.slice(slash + 1);
    const parsed = stem && !name.includes('/') ? parseSceneFileName(name) : undefined;
    if (parsed) {
      const plotRelPath = plotPathOfStem(project, stem);
      return {
        kind: 'scene',
        rel,
        no: parsePlotFileName(path.posix.basename(plotRelPath))?.no,
        sceneNo: parsed.no,
        stage: 'scene',
        target: { kind: 'scene', plotRelPath, sceneNo: parsed.no },
        plotRelPath,
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 中转站正文。与细纲同名同层。
  const inManuscripts = under(rel, d.manuscripts);
  if (inManuscripts !== undefined && inManuscripts) {
    const parsed = parsePlotFileName(path.posix.basename(inManuscripts));
    if (parsed && !inManuscripts.includes('/')) {
      const plotRelPath = plotPathOfStem(project, stemOf(inManuscripts));
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

/** `.novelforge/manuscripts/012-入宗.md` → `012-入宗`。 */
function stemOf(relOrName: string): string {
  return path.posix.basename(relOrName, path.posix.extname(relOrName));
}

/**
 * 镜像目录/文件的词干 → 它所属细纲的路径。`project.plotStem` 的逆运算。
 *
 * **不查盘**：返回的是「那份细纲应该在哪」。词干本身就带着序号与标题
 * （`012-入宗`），所以直接拼回 `plots/<词干>.md` 即可——`plotFileName` 那条
 * 拼装规则的产物正是这个形状。
 */
function plotPathOfStem(project: NovelProject, stem: string): string {
  const plotsRoot = project.relPath(project.plotsDir);
  return `${plotsRoot}/${stem}.md`;
}

/**
 * 反过来：这个创作目标该落在哪个路径。`acceptArtifact` 用它。
 *
 * 与 `kindOfPath` 互为逆运算（见 tests/unit/workspace/kind.test.js 的往返用例）。
 * **正文落在中转站而不是 `chapters/`**——切成发布章是作者的活（第 23 条）。
 * 场景的落点这里只给「按目标标题算出来的位置」的上一级信息不够：文件名由
 * 「场号 + 标题」决定，而标题要读盘才知道，所以这里给的是**纯序号名**
 * （`scenes/<stem>/02.md`）。真正落盘时由 scene handler 用磁盘上那份的标题
 * 定文件名——改写一张卡不该顺手改掉文件名。
 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return project.relPath(project.outlinePath);
    case 'plot':
      return target.plotRelPath;
    case 'scene':
      return `${project.sceneMirrorRelPath(target.plotRelPath)}/${sceneStemName(target.sceneNo)}`;
    case 'manuscript':
      return project.manuscriptMirrorRelPath(target.plotRelPath);
  }
}

/** 场号 → 纯序号文件名。与 `sceneFileName(no, '')` 一致，不引入第二套规则。 */
function sceneStemName(no: number): string {
  return `${String(Math.max(1, Math.trunc(no))).padStart(2, '0')}.md`;
}

/**
 * 这个路径是不是一份细纲。工程页的 rename/move/delete 据此分流。
 *
 * `files/fileOps.ts` 的同名导出转发到这里，调用方不必改。
 */
export function isPlotPath(project: NovelProject, relPath: string): boolean {
  return kindOfPath(project, relPath).kind === 'plot';
}

/** 章号 + 标题 → 细纲**应该**落在哪。`plotFileName` 的薄包装，供网关内部拼路径。 */
export function plotRelPathFor(project: NovelProject, no: number, safeTitle: string): string {
  return `${project.relPath(project.plotsDir)}/${plotFileName(no, safeTitle)}`;
}
