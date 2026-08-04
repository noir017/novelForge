import { NovelProject } from './model/project';
import { ProjectChapter, ProjectFile, ProjectTree } from './protocol';

/**
 * 工程页的数据来源。
 *
 * 0.2.x 之前这里是一个 TreeDataProvider，靠 VS Code 的树控件渲染。
 * 改成 webview 后只需要一份可序列化的快照——树控件那套
 * getChildren/TreeItem/ThemeIcon 全部不再需要，展开状态由前端自己管。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.styleUri);
  const outlinePath = project.relPath(project.outlineUri);
  const globalSummaryPath = project.relPath(project.globalSummaryUri);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      title: '',
      author: '',
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      chapters: [],
      characters: [],
      lore: [],
      globalSummaryThrough: 0,
      styleGuidePath,
      outlinePath,
      globalSummaryPath,
    };
  }

  const [manifest, chapters, characters, lore] = await Promise.all([
    project.readManifest(),
    project.listChapters(),
    project.listCharacters(),
    project.listLore(),
  ]);

  const rows: ProjectChapter[] = [];
  for (const chapter of chapters) {
    // 以摘要文件里的 sourceHash 为准，与 staleChapters() 同一套判据。
    const summary = await project.readSummary(chapter.order);
    rows.push({
      order: chapter.order,
      title: chapter.title,
      relPath: chapter.relPath,
      wordCount: chapter.wordCount,
      stale: !summary || summary.sourceHash !== chapter.contentHash,
      summaryPath: summary?.relPath ?? '',
    });
  }

  return {
    initialized: true,
    title: manifest.title,
    author: manifest.author,
    chapterCount: chapters.length,
    totalWords: chapters.reduce((sum, c) => sum + c.wordCount, 0),
    staleCount: rows.filter((r) => r.stale).length,
    chapters: rows,
    characters: characters.map<ProjectFile>((card) => ({
      label: card.name,
      relPath: card.relPath,
      detail: [...card.tags, ...(card.aliases.length > 0 ? [`别名 ${card.aliases.join('/')}`] : [])].join(' · '),
    })),
    lore: lore.map<ProjectFile>((entry) => ({
      label: entry.title,
      relPath: entry.relPath,
      detail: entry.keywords.join('/'),
    })),
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    outlinePath,
    globalSummaryPath,
  };
}
