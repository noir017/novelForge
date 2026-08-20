import { basename } from 'node:path';
import { buildCastIndex, describePlots } from './cast';
import { listActiveFailures } from '../runtime/errorLog';
import { scoped } from '../runtime/logger';
import { SECTION_PLACEHOLDER } from '../model/markdown';
import { chapterLabel, deriveBookStage, segmentLabel } from '../model/pipeline';
import { hash } from '../model/fs';
import { isVolumeFilled } from '../model/volumeFile';
import { NovelProject } from '../model/project';
import { parsePlotFileName } from '../model/plotFile';
import { describeScene } from '../model/sceneFile';
import { SUMMARY_SECTION_KEYS } from '../model/types';
import { PlotPipeline, buildPlotPipeline, buildPipelineIndex, chaptersOfSegment } from './pipeline';
import { plotUpstreamHash } from '../workspace/handlers/plot';
import {
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
  ProjectVolumeNode,
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
 * ## 「卷」与「章节」两组
 *
 * - **卷**：全书分卷。每行报这一卷收纳了几段、交付了几段、多少字。前端复用
 *   章节行的组件渲染它，所以 `ProjectVolumeNode` 与 `ProjectPlotNode` 刻意同形。
 * - **章节**：**已发布的章在前，还没交付的剧情段在后**。章那几行是纯成品
 *   （摘要状态、草稿、总结）；段那几行带阶段徽章、四段进度、⟳ 标记，右键能
 *   切进任意一层。
 *
 * 两种行放同一组而不是分成两组，是因为它们合起来就是**这本书的时间线**：
 * 前面是写完的，后面是待写的。分成两组只会让作者在两边之间来回找「我写到哪了」。
 *
 * 段的位次（「剧情 4」里那个 4）由 `buildPipelineIndex` 统一算，这里只搬运——
 * 前端与装配器看到的必须是同一个数。
 *
 * 角色 / 设定两个区仍是任意深度的目录树：数据层给出扁平的文件清单（含各级
 * 子目录里的），这里按 relPath 折成层级。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.stylePath);
  const outlinePath = project.relPath(project.outlinePath);
  const globalSummaryPath = project.relPath(project.globalSummaryPath);
  const volumesRoot = project.relPath(project.volumesDir);
  const plotsRoot = project.relPath(project.plotsDir);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const charactersRoot = project.relPath(project.charactersDir);
  const loreRoot = project.relPath(project.loreDir);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      title: '',
      author: '',
      volumeCount: 0,
      segmentCount: 0,
      plotCount: 0,
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      summarizedCount: 0,
      volumes: [],
      plots: [],
      characters: [],
      lore: [],
      cast: [],
      castByCard: {},
      castConflicts: [],
      failures: {},
      summaryCount: 0,
      volumesRoot,
      plotsRoot,
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      outlinePath,
      globalSummaryPath,
      bookStage: 'outline',
    };
  }

  const [characters, lore, characterDirs, loreDirs, draftPaths, pipelineIndex] = await Promise.all([
    project.listCharacters(),
    project.listLore(),
    project.listFolders(project.charactersDir),
    project.listFolders(project.loreDir),
    // 一次遍历拿到全部已存在的草稿，胜过每章一次 stat。
    project.listDraftPaths(),
    // 全书流水线索引：大纲、卷纲、manifest 与全书摘要都只读一次摊给所有段。
    buildPipelineIndex(project),
  ]);
  // 章节列表、manifest、全书摘要与大纲原文都用流水线那一趟读到的同一份，
  // 不再单独读一次。
  const { pipelines, segments, chapters, volumes, summaries, manifest, outline } = pipelineIndex;

  // 章 → 它的来源段。右键「打开细纲」「进入这一段」据此回到规划稿；
  // 老工程里每一章都找不到来源，那时那几项菜单自然收起来。
  const sourceOf = new Map<string, PlotPipeline>();
  for (const p of pipelines.values()) {
    for (const rel of p.chapter.chapterPaths) {
      sourceOf.set(rel, p);
    }
  }

  const outlineHash = hash(outline);
  const volumeRows: ProjectVolumeNode[] = volumes.map((v) => {
    const dir = `${project.plotsMirrorRelPathForVolume(v.relPath)}/`;
    const mine = [...pipelines.values()].filter(
      (p) => p.plotRelPath.startsWith(dir) && !p.plotRelPath.slice(dir.length).includes('/')
    );
    return {
      no: v.no,
      title: v.title,
      relPath: v.relPath,
      segmentCount: mine.length,
      deliveredCount: mine.filter((p) => p.consumed).length,
      wordCount: mine.reduce(
        (sum, p) => sum + (p.chapter.exists ? p.chapter.words : p.manuscript.words),
        0
      ),
      filled: isVolumeFilled(v.sections),
      // 与细纲那一侧同一条判据：记录过上游指纹、且现在对不上，才算脏。
      upstreamStale: !!v.upstreamHash && v.upstreamHash !== outlineHash,
    };
  });

  // 已发布的章。**纯成品**：摘要状态、草稿、总结，没有流水线徽章可言
  // （造它的那一段的进度早就满格了）。
  const chapterRows: ProjectPlotNode[] = chapters.map((c) => {
    const source = sourceOf.get(c.relPath);
    const summary = summaries.get(c.relPath);
    const draftPath = project.draftRelPathFor(c.relPath) ?? '';
    return {
      kind: 'chapter',
      no: c.order,
      label: chapterLabel(c.order, c.title),
      title: c.title,
      relPath: c.relPath,
      plotPath: source?.plotRelPath ?? '',
      chapterPath: c.relPath,
      manuscriptPath: '',
      wordCount: c.wordCount,
      // 空章不算过期：那不是「摘要旧了」，是还没写。
      stale: c.wordCount > 0 && (!summary || summary.sourceHash !== c.contentHash),
      summaryPath: project.summaryMirrorRelPath(c.relPath) ?? '',
      stage: 'done',
      progress: { plot: 1, scene: 1, manuscript: 1, summary: summary ? 1 : 0 },
      upstreamStale: false,
      draftPath,
      hasDraft: draftPath !== '' && draftPaths.has(draftPath),
    };
  });

  // 还没交付的剧情段。顺序、位次都由流水线索引给，界面与装配器看到的是同一个数。
  const segmentRows: ProjectPlotNode[] = segments.map((p) => ({
    kind: 'segment',
    no: p.displayNo,
    label: segmentLabel(p.displayNo, p.title),
    title: p.title,
    // 段那一行的身份就是细纲路径——它是这一段唯一存在的文件。
    relPath: p.plot.relPath,
    plotPath: p.plot.relPath,
    chapterPath: '',
    manuscriptPath: p.manuscript.words > 0 ? p.manuscript.relPath : '',
    wordCount: p.manuscript.words,
    // 还没交付的段没有摘要可言——给它一个空心点会让整列看起来全是待办。
    stale: false,
    summaryPath: '',
    stage: p.stage,
    progress: p.progress,
    upstreamStale: isUpstreamStale(p),
    draftPath: '',
    hasDraft: false,
  }));

  const plotRows = [...chapterRows, ...segmentRows];

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

  // 摘要新鲜度只算**已经发布**的章：还没交付的段没有成品，没有成品就无从
  // 总结，算进来会让顶部黄条报一个永远清不掉的待办数。
  const published = chapterRows.filter((p) => p.wordCount > 0);
  const staleCount = published.filter((p) => p.stale).length;
  // 未解决的失败记录，一次查询拿全部（按 relPath 索引，各区共用一张表）。
  // 库不可用时是空对象——工程页照常渲染，只是没有感叹号。
  const failures = await listActiveFailures(project);
  return {
    initialized: true,
    title: manifest.title,
    author: manifest.author,
    volumeCount: volumes.length,
    segmentCount: segmentRows.length,
    plotCount: plotRows.length,
    chapterCount: chapters.length,
    totalWords: plotRows.reduce((sum, p) => sum + p.wordCount, 0),
    staleCount,
    summarizedCount: published.length - staleCount,
    volumes: volumeRows,
    plots: plotRows,
    characters: nest(charactersRoot, characterLeaves, characterDirs),
    lore: nest(loreRoot, loreLeaves, loreDirs),
    cast,
    castByCard,
    castConflicts,
    failures,
    summaryCount: castIndex.summaryCount,
    volumesRoot,
    plotsRoot,
    chaptersRoot,
    charactersRoot,
    loreRoot,
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    outlinePath,
    globalSummaryPath,
    bookStage: deriveBookStage({
      outlineFilled: outline.trim().length > 0,
      volumeCount: volumes.length,
      plotCount: plotRows.length,
    }),
  };
}

/**
 * 一章流水线的完整视图（创作页的流水线条与场景列表）。
 *
 * 与 `buildPlotSummaryView` 同一套取舍：数据小、只在切目标时取一次，
 * 所以单独一条消息，不塞进每次文件变动都全量重推的 `ProjectTree`。
 *
 * 传的是**细纲路径**。这一段没有细纲（老工程里已经写好的章）时按文件名里的号
 * 去找同号的成品，两边都没有才给空壳——作者可能刚把它改了名，界面该显示
 * 「它没了」而不是崩掉。
 */
export async function buildPlotPipelineView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotPipelineView> {
  const plot = await project.readPlot(plotRelPath);
  const chapters = await project.listChapters();
  // 细纲不在就按文件名里的号找同号的成品：老工程的每一章都走这条路。
  const no = plot?.no ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const chapter = plot ? undefined : no > 0 ? chapters.find((c) => c.order === no) : undefined;

  if (!plot && !chapter) {
    return {
      plotRelPath,
      no: 0,
      displayNo: 0,
      title: '',
      plot: { relPath: plotRelPath, exists: false, filled: false, upstreamStale: false },
      scenes: [],
      manuscript: { relPath: '', words: 0, beatsStale: false },
      chapter: { exists: false, relPath: '', words: 0, chapterPaths: [] },
      summary: { exists: false, stale: true },
      stage: 'plot',
      progress: { plot: 0, scene: 0, manuscript: 0, summary: 0 },
    };
  }
  // 单段取数算不出位次（那要全书未交付段的顺序），交给流水线索引算的那一份。
  const displayNo = plot ? (await displayNoOfSegment(project, plot.relPath)) : no;
  const p = await buildPlotPipeline(
    project,
    { no, plot, chapter },
    { chapters, upstreamHash: plot ? await plotUpstreamHash(project, plot.relPath) : undefined, displayNo }
  );
  return {
    plotRelPath: p.plotRelPath,
    no: p.no,
    displayNo: p.displayNo,
    title: p.title,
    plot: p.plot,
    scenes: p.scenes.map((s) => ({
      no: s.no,
      title: s.title,
      relPath: s.relPath,
      // 一行摘要在后端生成：创作页的场景列表、工程页的场景子节点、
      // 装配进 prompt 的场景一览，三处共用同一份文案。
      detail: describeScene(s),
      status: s.status,
      ready: s.ready,
      upstreamStale: s.upstreamStale,
    })),
    manuscript: p.manuscript,
    chapter: p.chapter,
    summary: p.summary,
    stage: p.stage,
    progress: p.progress,
  };
}

/** 有任何一层的上游变过。工程页那一行据此挂提示点。 */
function isUpstreamStale(p: PlotPipeline): boolean {
  return p.plot.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale);
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
 * 传的是**细纲路径或章节路径**（工程页那一行同时代表两者）。摘要挂在成品上，
 * 所以两种都要能解析到同一章。
 *
 * 摘要不存在不是错误——那一章可以还没总结过、甚至还没拆分。这时给
 * `exists: false`，让前端说清「还没有摘要」，而不是弹一个空浮窗或报错。
 */
export async function buildPlotSummaryView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotSummaryView> {
  const plot = await project.readPlot(plotRelPath);
  const chapters = await project.listChapters();
  // 传的就是章节路径时直接命中；传细纲路径时找它交付到的第一章。
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const produced = plot ? chaptersOfSegment(project, plot, chapters) : [];
  const chapter =
    direct ??
    produced[0] ??
    // 一份还不存在的细纲路径（老工程的章走这条）：按文件名里的号找同号的章。
    (plot ? undefined : chapters.find((c) => c.order === parsePlotFileName(basename(plotRelPath))?.no));

  const summary = chapter ? await project.readSummary(chapter.relPath) : undefined;
  const title = plot?.title || chapter?.title || '';
  // 一行要么是已发布的章、要么是还没交付的剧情段，说法完全不同。
  const isSegment = !!plot && produced.length === 0;
  const no = isSegment ? await displayNoOfSegment(project, plot!.relPath) : (chapter?.order ?? plot?.no ?? 0);
  const label = isSegment ? segmentLabel(no, title) : chapterLabel(no, title);

  if (!summary) {
    return {
      no,
      title,
      label,
      exists: false,
      stale: true,
      relPath: '',
      sections: [],
      emptyHint: isSegment
        ? '这一段还没拆成章。摘要挂在拆出来的成品上，拆完才总结得出来。'
        : '这一章还没有摘要。右键「总结这一章」可以生成。',
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

/**
 * 一段在界面上的位次（「剧情 4」里那个 4）。
 *
 * **借流水线索引算**，不在这里另算一遍：位次要数「在未交付的段里排第几」，
 * 那是一条会跑偏的判据（见 model/pipeline.ts 的 `segmentDisplayNo`）。已经交付
 * 的段没有位次，报它的段号——那时界面显示的是「第 N 章」，这个数不会被用到。
 */
async function displayNoOfSegment(project: NovelProject, plotRelPath: string): Promise<number> {
  const { pipelines } = await buildPipelineIndex(project);
  return pipelines.get(plotRelPath)?.displayNo ?? 0;
}
