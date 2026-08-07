import { SECTION_PLACEHOLDER } from './model/markdown';
import { NovelProject } from './model/project';
import { SUMMARY_SECTION_KEYS } from './model/types';
import {
  ChapterSummaryView,
  ProjectChapterNode,
  ProjectDirNode,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
} from './protocol';

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
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      outlinePath,
      globalSummaryPath,
    };
  }

  const [manifest, chapters, characters, lore, chapterDirs, characterDirs, loreDirs, draftPaths] =
    await Promise.all([
      project.readManifest(),
      project.listChapters(),
      project.listCharacters(),
      project.listLore(),
      project.listFolders(project.chaptersDir),
      project.listFolders(project.charactersDir),
      project.listFolders(project.loreDir),
      // 一次遍历拿到全部已存在的草稿，胜过每章一次 stat。
      project.listDraftPaths(),
    ]);

  const chapterLeaves: ProjectChapterNode[] = [];
  for (const chapter of chapters) {
    // 以摘要文件里的 sourceHash 为准，与 staleChapters() 同一套判据。
    const summary = await project.readSummary(chapter.order);
    const draftPath = project.draftRelPathFor(chapter.relPath) ?? '';
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

  const staleCount = chapterLeaves.filter((r) => r.stale).length;
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
  const summary = await project.readSummary(order);
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
