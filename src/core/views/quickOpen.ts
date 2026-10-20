import * as path from 'node:path';
import { parseChapterFileName } from '../model/chapterFile';
import { exists } from '../model/fs';
import { SETTING_DOC_LABEL, isFallbackChapterTitle } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { FIXED_DOC_LABEL, describeEditorFile } from './editorLabel';
import type {
  QuickOpenChapter,
  QuickOpenDoc,
  QuickOpenDocKey,
  QuickOpenDraft,
  QuickOpenIndex,
} from '../protocol';

/**
 * 「转到…」（独立版 Ctrl+P）的索引：章节、角色卡、设定条目、架构几件与大纲 / 文风 / 叙事线 / 全文大纲、草稿。
 *
 * **按需要**：面板打开时前端要一次（`requestQuickOpen`），不进每次文件变动都重推的工程树。匹配与排序在前端
 * （`media/src/editor/quickOpenCore.ts`），这里只给一份平铺的清单。
 *
 * ## 读了哪些盘
 *
 * 几百章的工程也要快，所以**不为索引多读任何一章**，能借的缓存都借：
 *
 * - **章节与细纲**：`NovelProject.listChapters()` / `listPlots()`。这两份列表在工程上缓存着（每次 `pushState`
 *   重算 `ViewState` 时就填上了，作者按 Ctrl+P 时几乎总是热的）——热的时候这一步**零读盘**；冷的时候各递归
 *   扫一遍 `chapters/` 与 `.novelforge/summaries/`、每个文件读一次（与工程页同一趟，之后的人搭这一班车）。
 * - **角色卡**：递归列 `.novelforge/characters/`，每张卡读一次（要 frontmatter 里的名字与别名）。
 * - **设定条目**：递归列 `.novelforge/lore/`，每条读一次（要标题）。
 * - **草稿**：递归列 `drafts/`，**只列不读**。
 * - **架构几件与大纲 / 文风 / 叙事线 / 全文大纲**：七个固定路径各 `stat` 一次，有文件的才列。
 *
 * 不读大纲、配置、manifest 的内容，也不算流水线状态——「转到」只要认得出是哪一章、在哪个文件。
 */
export async function buildQuickOpenIndex(project: NovelProject): Promise<QuickOpenIndex> {
  if (!(await project.isInitialized())) {
    return { initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] };
  }
  const [chapters, plots, characters, lore, draftPaths, docs] = await Promise.all([
    project.listChapters(),
    project.listPlots(),
    project.listCharacters(),
    project.listLore(),
    project.listDraftPaths(),
    listDocs(project),
  ]);

  const chaptersRoot = project.relPath(project.chaptersDir);
  const plotsRoot = project.relPath(project.plotsDir);
  // 第一份正文按章号认（同号两份取路径排序第一份，与流水线同一个口径）。按号建一张表，几百章也不必每章扫一遍。
  const chapterOf = new Map<number, (typeof chapters)[number]>();
  for (const chapter of chapters) {
    if (!chapterOf.has(chapter.order)) {
      chapterOf.set(chapter.order, chapter);
    }
  }
  const nos = [...new Set([...chapterOf.keys(), ...plots.map((p) => p.no)])].sort((a, b) => a - b);
  const chapterRows: QuickOpenChapter[] = nos.map((no) => {
    const chapter = chapterOf.get(no);
    // 细纲按路径配对（`NovelProject.plotFor`）：有正文只认它镜像的那一份，没有正文按号认计划。
    const plot = project.plotFor(no, plots, chapters);
    const title = plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : '');
    return {
      no,
      title,
      volume: chapter ? volumeOf(chapter.relPath, chaptersRoot) : plot ? volumeOf(plot.relPath, plotsRoot) : '',
      ...(chapter ? { chapterPath: chapter.relPath } : {}),
      ...(plot ? { plotPath: plot.relPath } : {}),
      words: chapter?.wordCount ?? 0,
    };
  });

  const drafts: QuickOpenDraft[] = [...draftPaths].sort((a, b) => a.localeCompare(b)).map((rel) => {
    const name = path.posix.basename(rel);
    const no = parseChapterFileName(name)?.order;
    return { path: rel, name, ...(no !== undefined ? { no } : {}) };
  });

  return {
    initialized: true,
    chapters: chapterRows,
    characters: characters.map((c) => ({ name: c.name, aliases: [...c.aliases], path: c.relPath })),
    lore: lore.map((e) => ({ title: e.title, path: e.relPath })),
    docs,
    drafts,
  };
}

/**
 * 架构三件、情节大纲、文风、叙事线、全文大纲：有文件的才列，按这个顺序（「故事架构」组在前）。叙事线一条线一个文件
 * （`threads/<线名>.md`），一条一项，名字是线名（与编辑器标签同一个叫法），类型标记由前端按 `key` 写「叙事线」；
 * 「未归属的伏笔」排在各条线后面。
 */
async function listDocs(project: NovelProject): Promise<QuickOpenDoc[]> {
  const candidates: { key: QuickOpenDocKey; label: string; abs: string }[] = [
    { key: 'config', label: SETTING_DOC_LABEL.config, abs: project.configPath },
    { key: 'premise', label: SETTING_DOC_LABEL.premise, abs: project.premisePath },
    { key: 'world', label: SETTING_DOC_LABEL.world, abs: project.worldPath },
    // 称呼与内置编辑器的标签、面包屑共用一张表（`views/editorLabel.ts`），同一份文件不叫两个名字。
    { key: 'outline', label: FIXED_DOC_LABEL.outline, abs: project.outlinePath },
    { key: 'style', label: FIXED_DOC_LABEL.style, abs: project.stylePath },
  ];
  const tail: { key: QuickOpenDocKey; label: string; abs: string }[] = [
    { key: 'globalSummary', label: FIXED_DOC_LABEL.globalSummary, abs: project.globalSummaryPath },
  ];
  const present = await Promise.all([...candidates, ...tail].map((c) => exists(c.abs)));
  const pick = (list: typeof candidates, offset: number): QuickOpenDoc[] =>
    list.filter((_, i) => present[offset + i]).map((c) => ({ key: c.key, label: c.label, path: project.relPath(c.abs) }));
  const threads: QuickOpenDoc[] = (await project.listThreadPaths()).map((rel) => ({
    key: 'threads',
    label: describeEditorFile(project, rel).title,
    path: rel,
  }));
  return [...pick(candidates, 0), ...threads, ...pick(tail, candidates.length)];
}

/**
 * 卷目录：文件在 `root` 下那段相对路径的目录部分（`第一卷`、`第一卷/上`），根下是空串。
 * `root` 是空串（章节根配成了工程根）时整个相对路径都算。
 */
function volumeOf(relPath: string, root: string): string {
  const under = root === '' ? relPath : relPath.startsWith(`${root}/`) ? relPath.slice(root.length + 1) : undefined;
  if (under === undefined) {
    return '';
  }
  const dir = path.posix.dirname(under);
  return dir === '.' ? '' : dir;
}
