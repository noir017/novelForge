import { basename } from 'node:path';
import { buildCastIndex, describePlots } from './cast';
import { listActiveFailures } from '../runtime/errorLog';
import { scoped } from '../runtime/logger';
import { SECTION_PLACEHOLDER, hasContent } from '../model/markdown';
import { BookConfig } from '../model/settingFile';
import { SETTING_DOC_LABEL, chapterLabel, deriveBookStage } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { parsePlotFileName } from '../model/plotFile';
import { isOutlineFilled, outlineCoverage } from '../model/outlineFile';
import { SUMMARY_SECTION_KEYS } from '../model/types';
import { buildBookFacts, buildPlotPipeline, buildPipelineIndex, chapterOfPlotNo } from './pipeline';
import {
  ArchitectureRow,
  CastConflictView,
  CastEntry,
  CastSummary,
  PlotPipelineView,
  PlotSummaryView,
  ProjectDirNode,
  ProjectFileNode,
  ProjectNode,
  ProjectPlotNode,
  ProjectTree,
  IdeaDefaults,
} from '../protocol';

const log = scoped('角色卡');

/**
 * 上一次报过的冲突签名。工程页每次刷新都会走到这里，同一批冲突反复打进日志
 * 会把日志页淹掉——变了才说一次。
 */
let lastConflictSignature = '';

/**
 * 工程页的数据来源。
 *
 * ## 「故事架构」与「章节」两组
 *
 * - **故事架构**：小说配置 / 故事前提 / 角色图谱 / 世界观 / 情节大纲五行，各带
 *   「填过没有」。它们是后面一切的上游，排在最前面。
 * - **章节**：一个章号一行（细纲号 = 章号）。一行同时报细纲与正文两面：排过没有、
 *   写了多少、定稿没有、上游变没变。
 *
 * 角色 / 设定两个区仍是任意深度的目录树：数据层给出扁平的文件清单（含各级
 * 子目录里的），这里按 relPath 折成层级。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.stylePath);
  const outlinePath = project.relPath(project.outlinePath);
  const globalSummaryPath = project.relPath(project.globalSummaryPath);
  const plotsRoot = project.relPath(project.plotsDir);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const charactersRoot = project.relPath(project.charactersDir);
  const loreRoot = project.relPath(project.loreDir);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      title: '',
      author: '',
      plotCount: 0,
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      summarizedCount: 0,
      architecture: [],
      plots: [],
      characters: [],
      lore: [],
      cast: [],
      castByCard: {},
      castConflicts: [],
      failures: {},
      summaryCount: 0,
      plotsRoot,
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      outlinePath,
      globalSummaryPath,
      bookStage: 'setting',
      nextChapterNo: 1,
      book: { idea: '', configHasContent: false, plotFilledNos: [] },
    };
  }

  const [characters, lore, characterDirs, loreDirs, draftPaths, pipelineIndex] = await Promise.all([
    project.listCharacters(),
    project.listLore(),
    project.listFolders(project.charactersDir),
    project.listFolders(project.loreDir),
    // 一次遍历拿到全部已存在的草稿，胜过每章一次 stat。
    project.listDraftPaths(),
    // 全书流水线索引：大纲、配置、manifest 与全书摘要都只读一次摊给所有章。
    buildPipelineIndex(project),
  ]);
  // 章节列表、manifest、全书摘要与大纲原文都用流水线那一趟读到的同一份，
  // 不再单独读一次。
  const { rows, chapters, summaries, manifest, outline } = pipelineIndex;
  const book = await buildBookFacts(project, pipelineIndex, { characters });

  const plotRows: ProjectPlotNode[] = rows.map((p) => {
    const chapterPath = p.chapter.relPath;
    const summary = chapterPath ? summaries.get(chapterPath) : undefined;
    const chapter = chapterPath ? chapters.find((c) => c.relPath === chapterPath) : undefined;
    const draftPath = chapterPath ? (project.draftRelPathFor(chapterPath) ?? '') : '';
    return {
      no: p.no,
      label: chapterLabel(p.no, p.title),
      title: p.title,
      relPath: chapterPath || p.plot.relPath,
      plotPath: p.plot.relPath,
      plotExists: p.plot.exists,
      chapterPath,
      wordCount: p.chapter.words,
      targetWords: p.chapter.targetWords,
      // 空章不算过期：那不是「摘要旧了」，是还没写。
      stale: !!chapter && chapter.wordCount > 0 && (!summary || summary.sourceHash !== chapter.contentHash),
      summaryPath: chapterPath ? (project.summaryMirrorRelPath(chapterPath) ?? '') : '',
      stage: p.stage,
      progress: p.progress,
      upstreamStale: p.plot.upstreamStale || p.chapter.upstreamStale,
      draftPath,
      hasDraft: draftPath !== '' && draftPaths.has(draftPath),
    };
  });

  const coverage = outlineCoverage(outline);
  const architecture: ArchitectureRow[] = [
    ...(['config', 'premise', 'characters', 'world'] as const).map((doc) => ({
      key: doc,
      label: SETTING_DOC_LABEL[doc],
      relPath: project.relPath(project.settingPath(doc)),
      filled: book.settings[doc],
      detail: doc === 'characters' ? `${characters.length} 人` : book.settings[doc] ? '' : '待生成',
    })),
    {
      key: 'outline' as const,
      label: '情节大纲',
      relPath: outlinePath,
      filled: isOutlineFilled(outline),
      detail: !isOutlineFilled(outline)
        ? '待生成'
        : Number.isFinite(coverage)
          ? `覆盖到第 ${coverage} 章`
          : '',
    },
  ];

  const characterLeaves = characters.map<ProjectFileNode>((card) => ({
    kind: 'file',
    label: card.name,
    relPath: card.relPath,
    detail: [...card.tags, ...(card.aliases.length > 0 ? [`别名 ${card.aliases.join('/')}`] : [])].join(' · '),
  }));

  const loreLeaves = lore.map<ProjectFileNode>((entry) => ({
    kind: 'file',
    label: entry.title,
    relPath: entry.relPath,
    detail: entry.keywords.join('/'),
  }));

  // 出场人物索引：已建卡的补出场统计，未建卡的单列一组。
  // 与角色树分开——那是文件树，这些人还没有文件。
  // 摘要复用流水线那一趟读到的索引：同一次刷新里这已经是第三个要它的人了。
  const castIndex = await buildCastIndex(project, summaries);
  const castByCard: Record<string, CastSummary> = {};
  for (const member of castIndex.known) {
    if (!member.card) {
      continue;
    }
    const updatedThrough = member.card.updatedThrough ?? 0;
    castByCard[member.card.relPath] = {
      plots: member.plots,
      detail: describePlots(member.plots),
      updatedThrough,
      // 上次更新之后又出场了几章——角色行上的「有新内容可更新」提示吃这个数。
      pending: member.plots.filter((n) => n > updatedThrough).length,
    };
  }
  const cast: CastEntry[] = castIndex.unknown.map((member) => ({
    name: member.name,
    aliases: member.aliases,
    plots: member.plots,
    detail: describePlots(member.plots),
  }));

  const bySlug = new Map(characters.map((c) => [c.slug, c]));
  const castConflicts: CastConflictView[] = castIndex.conflicts.map((conflict) => ({
    name: conflict.name,
    kind: conflict.kind,
    cards: conflict.slugs
      .map((slug) => bySlug.get(slug))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ name: c.name, relPath: c.relPath })),
  }));
  reportConflicts(castConflicts);

  // 摘要新鲜度只算**有正文**的章：还没写的章无从总结，算进来会让顶部黄条报一个
  // 永远清不掉的待办数。
  const written = plotRows.filter((p) => p.chapterPath && p.wordCount > 0);
  const staleCount = written.filter((p) => p.stale).length;
  // 未解决的失败记录，一次查询拿全部（按 relPath 索引，各区共用一张表）。
  // 库不可用时是空对象——工程页照常渲染，只是没有感叹号。
  const failures = await listActiveFailures(project);
  return {
    initialized: true,
    title: manifest.title,
    author: manifest.author,
    plotCount: plotRows.length,
    chapterCount: chapters.length,
    totalWords: plotRows.reduce((sum, p) => sum + p.wordCount, 0),
    staleCount,
    summarizedCount: written.length - staleCount,
    architecture,
    plots: plotRows,
    characters: nest(charactersRoot, characterLeaves, characterDirs),
    lore: nest(loreRoot, loreLeaves, loreDirs),
    cast,
    castByCard,
    castConflicts,
    failures,
    summaryCount: castIndex.summaryCount,
    plotsRoot,
    chaptersRoot,
    charactersRoot,
    loreRoot,
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    outlinePath,
    globalSummaryPath,
    bookStage: deriveBookStage(book),
    nextChapterNo: book.nextChapterNo,
    book: {
      ...ideaDefaultsOf(pipelineIndex.config),
      outlineCoverage: Number.isFinite(coverage) && coverage > 0 ? coverage : undefined,
      plotFilledNos: [...book.plotFilledNos],
    },
  };
}

/** 一句话弹窗的默认值：`config.md` 里已经写了的那几样。 */
export function ideaDefaultsOf(config: BookConfig): IdeaDefaults {
  return {
    idea: config.sections.一句话 ?? '',
    totalChapters: config.totalChapters,
    wordsPerChapter: config.wordsPerChapter,
    configHasContent: Object.values(config.sections).some((v) => hasContent(v)),
  };
}

/**
 * 一章流水线的完整视图（创作页的流水线条）。
 *
 * 与 `buildPlotSummaryView` 同一套取舍：数据小、只在切目标时取一次，
 * 所以单独一条消息，不塞进每次文件变动都全量重推的 `ProjectTree`。
 *
 * 传的是**细纲路径**（可能还不存在）或**章节路径**，都按章号认到同一章。
 * 两边都没有时给一份空壳（「写第 N 章细纲」）——作者可能刚把它改了名，
 * 界面该显示「它还没有」而不是崩掉。
 */
export async function buildPlotPipelineView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotPipelineView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const plot = direct ? await project.getPlot(no) : await project.resolvePlot(plotRelPath);
  const p = await buildPlotPipeline(
    project,
    { no, plot, chapter: direct ?? chapterOfPlotNo(chapters, no) },
    { chapters }
  );
  return {
    plotRelPath: p.plot.relPath,
    no: p.no,
    title: p.title,
    plot: p.plot,
    chapter: p.chapter,
    summary: p.summary,
    stage: p.stage,
    progress: p.progress,
  };
}

/**
 * 冲突进日志。前端也会显示一条，但日志才是事后能翻的地方——
 * 「上周那批出场统计怎么会错」只有这里答得上。
 */
function reportConflicts(conflicts: CastConflictView[]): void {
  const signature = conflicts.map((c) => `${c.kind}:${c.name}:${c.cards.map((x) => x.relPath).join(',')}`).join('|');
  if (signature === lastConflictSignature) {
    return;
  }
  lastConflictSignature = signature;
  if (conflicts.length === 0) {
    return;
  }
  log.warn(
    `${conflicts.length} 个称呼被多张角色卡同时声明，出场统计必然有一张是错的`,
    conflicts
      .map(
        (c) =>
          `「${c.name}」← ${c.cards.map((x) => x.name).join(' / ')}` +
          `（${c.kind === 'name' ? '两张卡的正式名一模一样，多半是同一个人建了两张卡' : '被多张卡当成自己的称呼，出场统计只算给第一张'}）`
      )
      .join('；') + '｜可用角色分组右键的「查找并合并重复角色卡」「清理别名」处理'
  );
}

/**
 * 单章摘要的浮窗视图。工程页鼠标悬停在章节行上时按需取一次。
 *
 * 与 `buildProjectTree` 分开是有意的：摘要正文上千字，而那棵树每次
 * 文件变动都全量重推，把摘要塞进去等于每保存一次正文就多推几百 KB。
 *
 * 传的是**细纲路径或章节路径**（工程页那一行同时代表两者），按章号认到同一章。
 *
 * 摘要不存在不是错误——那一章可以还没定稿、甚至还没写。这时给 `exists: false`，
 * 让前端说清「还没有摘要」，而不是弹一个空浮窗或报错。
 */
export async function buildPlotSummaryView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotSummaryView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const chapter = direct ?? chapterOfPlotNo(chapters, no);
  const plot = await project.getPlot(no);

  const summary = chapter ? await project.readSummary(chapter.relPath) : undefined;
  const title = plot?.title || chapter?.title || '';
  const label = chapterLabel(no, title);

  if (!summary) {
    return {
      no,
      title,
      label,
      exists: false,
      stale: true,
      relPath: '',
      sections: [],
      emptyHint: chapter
        ? '这一章还没有摘要。右键「定稿」可以生成。'
        : '这一章还没写正文。摘要挂在正文上，写完定稿才有。',
    };
  }
  // 与 staleChapters() / buildProjectTree 同一套判据：以 sourceHash 为准。
  // 章本身没了（摘要成了孤儿）也算过期——浮窗里那句提示总比默认「新鲜」诚实。
  const stale = !chapter || summary.sourceHash !== chapter.contentHash;

  const parsed = SUMMARY_SECTION_KEYS.map((name) => ({
    name: name as string,
    text: (summary.sections[name] ?? '').trim(),
  }));
  // `keepEmpty` 写出的摘要里，没内容的小节留着标题和「（待补充）」占位。
  // 浮窗里六行占位是纯噪声，滤掉。
  const sections = parsed.filter((s) => s.text !== '' && s.text !== SECTION_PLACEHOLDER);

  // 一个小节都没认出来（作者手改摘要、把 `## 小节名` 全删了改成大白话）时
  // 退回摘要全文，总比给一个空浮窗好。
  //
  // 只在「什么都没解析出来」时才退：小节解析得出来、只是内容全是占位的，
  // 那就是一份货真价实的空摘要，退回全文只会把六行「（待补充）」摊在浮窗里。
  if (sections.length === 0 && parsed.every((s) => s.text === '') && summary.content.trim() !== '') {
    sections.push({ name: '摘要', text: summary.content.trim() });
  }
  return { no, title, label, exists: true, stale, relPath: summary.relPath, sections };
}

/**
 * 把扁平的文件清单按 relPath 折成目录树。
 *
 * `dirs` 是磁盘上实际存在的子目录（含空目录）——作者刚建好卷目录还没
 * 往里写东西时，树上也该看得见，否则「新建文件夹」点完像是什么都没发生。
 *
 * 每层内目录在前、文件在后；章节每层内正序（第 1 章在上），
 * 角色/设定保持传入顺序（已按拼音排好）。
 */
function nest(root: string, leaves: ProjectNode[], dirs: string[]): ProjectNode[] {
  const dirNodes = new Map<string, ProjectDirNode>();

  /** 建出某个目录及其所有祖先，返回它。relPath 为 root 时返回 undefined（根不是节点）。 */
  const ensureDir = (relPath: string): ProjectDirNode | undefined => {
    if (relPath === root || !relPath.startsWith(`${root}/`)) {
      return undefined;
    }
    const existing = dirNodes.get(relPath);
    if (existing) {
      return existing;
    }
    const node: ProjectDirNode = {
      kind: 'dir',
      label: relPath.slice(relPath.lastIndexOf('/') + 1),
      relPath,
      children: [],
      fileCount: 0,
    };
    dirNodes.set(relPath, node);
    return node;
  };

  for (const dir of dirs) {
    ensureDir(dir);
  }
  // 叶子所在目录可能不在 dirs 里（listFolders 与文件扫描各读一次盘，
  // 中间目录被删掉时会对不上）——按需补出来，不让文件凭空消失。
  for (const leaf of leaves) {
    const parent = leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/'));
    for (const ancestor of ancestorsOf(parent, root)) {
      ensureDir(ancestor);
    }
  }

  const topLevel: ProjectNode[] = [];
  const attach = (node: ProjectNode, parentPath: string): void => {
    const parent = dirNodes.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      topLevel.push(node);
    }
  };

  // 先挂目录（浅的在前，保证父目录已建好），再挂文件。
  for (const relPath of [...dirNodes.keys()].sort(byDepthThenName)) {
    const node = dirNodes.get(relPath)!;
    attach(node, relPath.slice(0, relPath.lastIndexOf('/')));
  }
  for (const leaf of leaves) {
    attach(leaf, leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/')));
  }

  // 每层排序 + 统计子树文件数。
  const finish = (nodes: ProjectNode[]): number => {
    nodes.sort(compareNodes);
    let count = 0;
    for (const node of nodes) {
      if (node.kind === 'dir') {
        node.fileCount = finish(node.children);
        count += node.fileCount;
      } else {
        count += 1;
      }
    }
    return count;
  };
  finish(topLevel);
  return topLevel;
}

/** `a/b/c` 在 root=`a` 下的祖先链：`a/b`、`a/b/c`。 */
function ancestorsOf(dir: string, root: string): string[] {
  if (dir === root || !dir.startsWith(`${root}/`)) {
    return [];
  }
  const out: string[] = [];
  const segments = dir.slice(root.length + 1).split('/');
  let current = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

function byDepthThenName(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-Hans-CN');
}

/**
 * 每层内目录在前、文件在后。
 *
 * 目录按名称排；角色/设定的文件保持传入顺序（已按拼音排好）。
 * 章节不走这里——它是单独的一条扁平列表（`ProjectPlotNode`），按章号排。
 */
function compareNodes(a: ProjectNode, b: ProjectNode): number {
  if (a.kind === 'dir' && b.kind !== 'dir') {
    return -1;
  }
  if (a.kind !== 'dir' && b.kind === 'dir') {
    return 1;
  }
  if (a.kind === 'dir' && b.kind === 'dir') {
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  }
  return 0;
}
