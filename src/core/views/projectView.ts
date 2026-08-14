import { buildCastIndex, describeChapters } from './cast';
import { listActiveFailures } from '../runtime/errorLog';
import { scoped } from '../runtime/logger';
import { SECTION_PLACEHOLDER } from '../model/markdown';
import { NovelProject } from '../model/project';
import { describeScene } from '../model/sceneFile';
import { SUMMARY_SECTION_KEYS } from '../model/types';
import { ChapterPipeline, buildChapterPipeline, buildPipelineIndex } from './pipeline';
import {
  CastConflictView,
  CastEntry,
  CastSummary,
  ChapterPipelineView,
  ChapterSummaryView,
  ProjectChapterNode,
  ProjectDirNode,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
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
 * 0.2.x 之前这里是一个 TreeDataProvider，靠 VS Code 的树控件渲染。
 * 改成 webview 后只需要一份可序列化的快照——树控件那套
 * getChildren/TreeItem/ThemeIcon 全部不再需要，展开状态由前端自己管。
 *
 * 章节 / 角色 / 设定三个区都是任意深度的目录树：数据层给出扁平的
 * 文件清单（含各级子目录里的），这里按 relPath 折成层级。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.stylePath);
  const outlinePath = project.relPath(project.outlinePath);
  const globalSummaryPath = project.relPath(project.globalSummaryPath);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const charactersRoot = project.relPath(project.charactersDir);
  const loreRoot = project.relPath(project.loreDir);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      title: '',
      author: '',
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      summarizedCount: 0,
      chapters: [],
      characters: [],
      lore: [],
      cast: [],
      castByCard: {},
      castConflicts: [],
      failures: {},
      summaryCount: 0,
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      outlinePath,
      globalSummaryPath,
    };
  }

  const [chapters, characters, lore, chapterDirs, characterDirs, loreDirs, draftPaths, pipelineIndex] =
    await Promise.all([
      project.listChapters(),
      project.listCharacters(),
      project.listLore(),
      project.listFolders(project.chaptersDir),
      project.listFolders(project.charactersDir),
      project.listFolders(project.loreDir),
      // 一次遍历拿到全部已存在的草稿，胜过每章一次 stat。
      project.listDraftPaths(),
      // 全书流水线索引：大纲、manifest 与全书摘要都只读一次摊给所有章节。
      buildPipelineIndex(project),
    ]);
  // manifest 用流水线那一趟读到的同一份，不再单独读一次。
  const { pipelines, summaries, manifest } = pipelineIndex;

  const chapterLeaves: ProjectChapterNode[] = [];
  for (const chapter of chapters) {
    // 以摘要文件里的 sourceHash 为准，与 staleChapters() 同一套判据。
    // 摘要走流水线那一趟已经读过的索引，不再逐章重读。
    const summary = summaries.get(chapter.relPath);
    const draftPath = project.draftRelPathFor(chapter.relPath) ?? '';
    const pipeline = pipelines.get(chapter.relPath);
    chapterLeaves.push({
      kind: 'chapter',
      order: chapter.order,
      title: chapter.title,
      relPath: chapter.relPath,
      wordCount: chapter.wordCount,
      stale: !summary || summary.sourceHash !== chapter.contentHash,
      summaryPath: summary?.relPath ?? '',
      draftPath,
      hasDraft: draftPath !== '' && draftPaths.has(draftPath),
      // 流水线只带这两个精简字段：完整视图（含场景清单）走 requestPipeline，
      // 五百章各带一份会把每次全量推树变成几百 KB。
      stage: pipeline?.stage ?? 'plan',
      progress: pipeline?.progress ?? { plan: 0, scene: 0, manuscript: 0, summary: 0 },
      upstreamStale: !!pipeline && isUpstreamStale(pipeline),
    });
  }

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
      chapters: member.chapters,
      detail: describeChapters(member.chapters),
      updatedThrough,
      // 上次更新之后又出场了几章——角色行上的「有新章节可更新」提示吃这个数。
      pending: member.chapters.filter((o) => o > updatedThrough).length,
    };
  }
  const cast: CastEntry[] = castIndex.unknown.map((member) => ({
    name: member.name,
    aliases: member.aliases,
    chapters: member.chapters,
    detail: describeChapters(member.chapters),
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

  const staleCount = chapterLeaves.filter((r) => r.stale).length;
  // 未解决的失败记录，一次查询拿全部（按 relPath 索引，三个区共用一张表）。
  // 库不可用时是空对象——工程页照常渲染，只是没有感叹号。
  const failures = await listActiveFailures(project);
  return {
    initialized: true,
    title: manifest.title,
    author: manifest.author,
    chapterCount: chapters.length,
    totalWords: chapters.reduce((sum, c) => sum + c.wordCount, 0),
    staleCount,
    summarizedCount: chapterLeaves.length - staleCount,
    chapters: nest(chaptersRoot, chapterLeaves, chapterDirs),
    characters: nest(charactersRoot, characterLeaves, characterDirs),
    lore: nest(loreRoot, loreLeaves, loreDirs),
    cast,
    castByCard,
    castConflicts,
    failures,
    summaryCount: castIndex.summaryCount,
    chaptersRoot,
    charactersRoot,
    loreRoot,
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    outlinePath,
    globalSummaryPath,
  };
}

/**
 * 一章流水线的完整视图（创作页的流水线条与场景列表）。
 *
 * 与 `buildChapterSummaryView` 同一套取舍：数据小、只在切目标时取一次，
 * 所以单独一条消息，不塞进每次文件变动都全量重推的 `ProjectTree`。
 *
 * 章节不存在时给一份空壳而不是抛——作者可能刚把那一章改了名，
 * 界面该显示「这一章没了」而不是崩掉。
 */
export async function buildChapterPipelineView(
  project: NovelProject,
  chapterRelPath: string
): Promise<ChapterPipelineView> {
  const chapter = (await project.listChapters()).find((c) => c.relPath === chapterRelPath);
  if (!chapter) {
    return {
      chapterRelPath,
      order: 0,
      title: '',
      scenes: [],
      manuscript: { words: 0, beatsStale: false },
      summary: { exists: false, stale: true },
      stage: 'plan',
      progress: { plan: 0, scene: 0, manuscript: 0, summary: 0 },
    };
  }
  const p = await buildChapterPipeline(project, chapter);
  return {
    chapterRelPath: p.chapterRelPath,
    order: p.order,
    title: p.title,
    plan: p.plan,
    scenes: p.scenes.map((s) => ({
      no: s.no,
      title: s.title,
      relPath: s.relPath,
      // 一行摘要在后端生成：创作页的场景列表、工程页的场景子节点、
      // 细纲阶段装配进 prompt 的场景一览，三处共用同一份文案。
      detail: describeScene(s),
      status: s.status,
      ready: s.ready,
      upstreamStale: s.upstreamStale,
    })),
    manuscript: p.manuscript,
    summary: p.summary,
    stage: p.stage,
    progress: p.progress,
  };
}

/** 有任何一层的上游变过。工程页那一行据此挂提示点。 */
function isUpstreamStale(p: ChapterPipeline): boolean {
  return !!p.plan?.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale);
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
 * 与 `buildProjectTree` 分开是有意的：摘要正文一章上千字，而那棵树每次
 * 文件变动都全量重推，把摘要塞进去等于每保存一次正文就多推几百 KB。
 *
 * 摘要不存在不是错误——章节可以还没总结过。这时给 `exists: false`，
 * 让前端说清「还没有摘要」，而不是弹一个空浮窗或报错。
 */
export async function buildChapterSummaryView(
  project: NovelProject,
  order: number
): Promise<ChapterSummaryView> {
  const chapter = (await project.listChapters()).find((c) => c.order === order);
  // 摘要按章节身份（文件名+路径）读取；章节不存在（幽灵章号）时无摘要可读。
  const summary = chapter ? await project.readSummary(chapter) : undefined;
  const title = chapter?.title ?? '';

  if (!summary) {
    return { order, title, exists: false, stale: true, relPath: '', sections: [] };
  }
  // 与 staleChapters() / buildProjectTree 同一套判据：以 sourceHash 为准。
  // 章节本身没了（摘要成了孤儿）也算过期——浮窗里那句提示总比默认「新鲜」诚实。
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
  return { order, title, exists: true, stale, relPath: summary.relPath, sections };
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
 * 目录按名称排；章节在**每一层内正序**（第 1 章在上，与磁盘上的文件名顺序、
 * 与读者的阅读顺序一致）；角色/设定保持传入顺序（已按拼音排好）。
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
  if (a.kind === 'chapter' && b.kind === 'chapter') {
    // 序号重复（作者手动改名撞车）时按路径兜底，保证顺序稳定。
    return a.order - b.order || a.relPath.localeCompare(b.relPath);
  }
  return 0;
}
