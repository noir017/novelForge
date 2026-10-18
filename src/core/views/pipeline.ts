/**
 * 流水线的读取聚合：把磁盘上散落的产物合成一份「这一章 / 这本书现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把定稿过的细纲反向聚合成出场索引，
 * 这边把大纲 / 细纲 / 正文聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](../model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 一条轴，细纲镜像正文的路径
 *
 * 一个章号一行。第 N 章的正文按文件名前缀认（同号有两份时取路径排序第一份，并记一条 warn——
 * 不猜、不崩，让作者在工程页上看得见两份）；它的细纲**按路径配对**：正文在章节根下的相对路径
 * 镜像到 `summaries/` 下（`NovelProject.plotFor`）。还没有正文的章只有细纲，按号认。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md 里覆盖第 N 章那一节 ─hash─▶ 细纲 (frontmatter.upstreamHash)
 * 细纲八个小节                    ─hash─▶ 细纲 (frontmatter.writtenFrom，正文落盘时记、定稿时刷新)
 * chapters/…/N-标题               ─hash─▶ 细纲 (frontmatter.sourceHash，定稿反向更新时记)
 * ```
 *
 * 改了大纲的某一节，那一节覆盖的几章细纲标脏；改了某一章的细纲（包括定稿之后再改），
 * 那一章的正文标脏；改了正文，定稿对不上了。**代价是零次模型调用、零幻觉、零 token。**
 *
 * 正文那一环的指纹记在**细纲**上而不是章节上：章节是作者的文件，可以是 `.txt`、
 * 没有 frontmatter（第 9 条）。架构 → 大纲那一环还没有：改了设定四件，大纲不会挂 ⟳。
 */
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { pad3, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled, parsePlotFileName, plotContentHash } from '../model/plotFile';
import { BookConfig } from '../model/settingFile';
import { isOutlineFilled, outlineCoverage, outlineUpstreamHash } from '../model/outlineFile';
import {
  BookFacts,
  ChapterGap,
  NextStepFacts,
  PipelineFacts,
  PipelineProgress,
  PlotStage,
  deriveProgress,
  deriveStage,
  emptyFacts,
  isFallbackChapterTitle,
  manuscriptRatio,
} from '../model/pipeline';
import { Chapter, CharacterCard, LoreEntry, ProjectManifest } from '../model/types';

const log = scoped('流水线');

export interface PlotPipeline {
  /** 章号。 */
  no: number;
  title: string;
  /** 这一章的细纲。**没有细纲时 `relPath` 是它应该在的位置**（有正文就是正文的镜像）。 */
  plot: {
    relPath: string;
    /** 有这份文件。老工程里只有正文的章为 false。 */
    exists: boolean;
    filled: boolean;
    /** 排过这一章之后，大纲里覆盖它的那一节改过。 */
    upstreamStale: boolean;
  };
  /** 同号的章节（正文）。 */
  chapter: {
    exists: boolean;
    /** 没有正文时是空串。正文该落在哪要问 {@link chapterTargetOf}。 */
    relPath: string;
    words: number;
    /** 目标字数：细纲的 `targetWords`，没写就是 `config.md` 的每章字数。都没有是 undefined。 */
    targetWords?: number;
    /** 写完正文之后，这一章的细纲改过——正文可能已经与它对不上。 */
    upstreamStale: boolean;
  };
  /** 定稿：`exists` = 细纲定稿过（有 `sourceHash`），`stale` = 没定稿过或定稿之后正文又改过。 */
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

/**
 * 一章的流水线状态。`plot` 与 `chapter` 至少有一个在，都没有时就是一份空壳
 * （「写第 N 章细纲」）。
 *
 * `context` 由调用方传入：批量构建（工程页要为几百章各算一份）时大纲、配置、章节列表只读
 * 一次，否则每章都去读一遍同样的文件。
 *
 * `entry` 上那个 `sections?: never` 是防呆：`Plot` 自己就有 `no`，另外两个字段
 * 又是可选的，所以**直接把一份 `Plot` 递进来是编译得过的**，代价是 plot 与
 * chapter 双双 undefined、整章按空事实推导——那种错不会报错，只会安静地说谎。
 */
export async function buildPlotPipeline(
  project: NovelProject,
  entry: { no: number; plot?: Plot; chapter?: Chapter; sections?: never },
  context?: {
    outline?: string;
    config?: BookConfig;
    chapters?: Chapter[];
  }
): Promise<PlotPipeline> {
  const { no, plot } = entry;
  const outline = context?.outline ?? (await project.readOutline());
  const config = context?.config ?? (await project.readBookConfig());
  const chapters = context?.chapters ?? (await project.listChapters());
  const chapter = entry.chapter ?? chapterOfPlotNo(chapters, no);

  // upstreamHash 为空 = 这份细纲是作者手写的（或来自还没记录指纹的旧版本）——
  // **不标脏**：手写的东西没有「上游」，拿一个凭空的过期标记去催作者重做，比不标更糟。
  const plotStale = !!plot?.upstreamHash && plot.upstreamHash !== outlineUpstreamHash(outline, no);
  // 同理：没记过 writtenFrom（正文是作者自己写的）不标脏——只有「记录过一次、
  // 现在对不上」才说明细纲确实在正文（或定稿）之后改过（第 18a 条）。
  const chapterStale = !!chapter && !!plot?.writtenFrom && plot.writtenFrom !== plotContentHash(plot);
  // 定稿过 = 细纲上记着 sourceHash；对得上 = 定稿之后正文没再改过（第 23 条）。
  const finalized = !!plot?.sourceHash;

  const targetWords = plot?.targetWords ?? config.wordsPerChapter;
  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: !!plot && isPlotFilled(plot.sections),
    words: chapter?.wordCount ?? 0,
    targetWords,
    upstreamStale: chapterStale,
    chapterExists: !!chapter,
    summaryExists: finalized,
    summaryStale: !chapter || !finalized || plot!.sourceHash !== chapter.contentHash,
    markedDone: !!plot?.done,
  };

  return {
    no,
    title: plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : ''),
    plot: {
      relPath:
        plot?.relPath ??
        (chapter ? project.plotPathForChapter(chapter.relPath) : await project.plotPathForNewChapter(no)),
      exists: !!plot,
      filled: facts.plotFilled,
      upstreamStale: plotStale,
    },
    chapter: {
      exists: !!chapter,
      relPath: chapter?.relPath ?? '',
      words: facts.words,
      targetWords,
      upstreamStale: chapterStale,
    },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

export interface PipelineIndex {
  /** 每一个出现过的章号一行（细纲号 ∪ 章节号），升序。缺号的不补空行。 */
  rows: PlotPipeline[];
  /** 按章号索引。 */
  byNo: Map<number, PlotPipeline>;
  plots: Plot[];
  chapters: Chapter[];
  manifest: ProjectManifest;
  outline: string;
  config: BookConfig;
}

/**
 * 全书的流水线索引。一个章号一行，细纲**按路径配对**（见文件头）。
 *
 * 大纲、配置、manifest 都只读一次，摊给所有章——五百章工程逐章重读
 * 这些文件会把工程页刷新变成几百次多余的读盘。细纲列表与 manifest 一并返回：
 * 工程树与出场索引要的是同一批，让它们接着用这一份。
 */
export async function buildPipelineIndex(project: NovelProject): Promise<PipelineIndex> {
  const startedAt = Date.now();
  const [plots, chapters, outline, manifest, config] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    project.readOutline(),
    project.readManifest(),
    project.readBookConfig(),
  ]);
  const context = { outline, config, chapters };

  const duplicates = duplicateChapterNos(chapters);
  if (duplicates.length > 0) {
    log.warn('有几个章号不止一个正文文件，流水线只认路径排序第一份', duplicates.map((n) => `第 ${n} 章`).join('、'));
  }
  const nos = [...new Set([...plots.map((p) => p.no), ...chapters.map((c) => c.order)])].sort((a, b) => a - b);

  const rows: PlotPipeline[] = [];
  for (const no of nos) {
    rows.push(await buildPlotPipeline(project, { no, plot: project.plotFor(no, plots, chapters) }, context));
  }
  const byNo = new Map(rows.map((r) => [r.no, r]));

  const stale = rows.filter((p) => p.plot.upstreamStale || p.chapter.upstreamStale);
  if (stale.length > 0) {
    // 上游变更是「作者需要知道但不会主动去翻」的那类事，进日志才留得住。
    log.debug(
      `${stale.length} 章的上游产物有变更`,
      `${stale.map((p) => `第 ${p.no} 章`).join('、')}｜耗时 ${Date.now() - startedAt}ms`
    );
  }
  return { rows, byNo, plots, chapters, manifest, outline, config };
}

/**
 * 第 N 章的正文：同号章节里路径排序第一份。
 *
 * 同号有两份时两份都还在工程页上（章节列表照常列出），只是流水线认第一份——
 * 作者看得见冲突，才能去改。它的细纲是这一份正文的镜像（`NovelProject.plotFor`）。
 */
export function chapterOfPlotNo(chapters: Chapter[], no: number): Chapter | undefined {
  return chapters.find((c) => c.order === no);
}

/**
 * 第 N 章的正文该落在哪。**要读盘**，所以不放进纯函数 `pathOfTarget`。
 *
 * 同号章节已存在就用它（`exists: true`，落盘走追加）；否则**落在细纲所在的那个子目录**
 * （`summaries/第二卷/010-雪夜.md` → `chapters/第二卷/010-雪夜.md`），文件名沿用细纲的；细纲是
 * 还没起名时建的纯序号名（`030.md`）而标题已经有了，就按标题起 `030-<标题>.md`，`plotRelPath`
 * 交给 `Workspace.createChapterAt` 把细纲改名到新正文的镜像——两边从此按路径认得出彼此。
 * 连细纲都没有时跟上一章放在一起，`NNN-<标题>.md`。
 */
export async function chapterTargetOf(
  project: NovelProject,
  plotRelPath: string
): Promise<{ no: number; rel: string; exists: boolean; title: string; plotRelPath?: string }> {
  const no = parsePlotFileName(path.posix.basename(plotRelPath))?.no;
  if (no === undefined) {
    throw new Error(`认不出这份细纲的章号：${plotRelPath}`);
  }
  const existing = await project.getChapter(no);
  if (existing) {
    return { no, rel: existing.relPath, exists: true, title: existing.title };
  }
  const plot = await project.resolvePlot(plotRelPath);
  const title = plot?.title?.trim() ?? '';
  const stem = title ? sanitizeFileName(title) : '';
  const named = stem ? `${pad3(no)}-${stem}.md` : `${pad3(no)}.md`;
  const mirrored = plot ? project.chapterPathForPlot(plot.relPath) : undefined;
  if (plot && mirrored) {
    const keepName = !!parsePlotFileName(path.posix.basename(plot.relPath))?.stem.trim() || !stem;
    const rel = keepName ? mirrored : `${path.posix.dirname(mirrored)}/${named}`;
    return { no, rel, exists: false, title, plotRelPath: plot.relPath };
  }
  const dir = project.relPath(path.join(project.chaptersDir, await project.subdirForNewChapter(no)));
  return { no, rel: dir ? `${dir}/${named}` : named, exists: false, title };
}

/**
 * 全书状态机要的事实（`deriveBookStage` / `deriveBookNextStep`）。
 *
 * **只有这一份**：创作页的主按钮（controller/chat.ts）、工程页的全书阶段
 * （views/projectView.ts）与给外部 agent 的状态简报（views/stateBrief.ts）都吃它
 * ——各取各的，界面上的主按钮就会与 agent 说的下一步分叉（第 20 条）。
 */
export async function buildBookFacts(
  project: NovelProject,
  index?: PipelineIndex,
  known?: { characters?: CharacterCard[]; lore?: readonly LoreEntry[] }
): Promise<BookFacts> {
  const built = index ?? (await buildPipelineIndex(project));
  // 配置与章节在索引里已经读过；角色卡、设定条目调用方手上有就用它的（工程页刷新时已经列过一遍）。
  const settings = await project.settingFilled({
    config: built.config,
    chapters: built.chapters,
    characters: known?.characters,
    lore: known?.lore,
  });
  const nextChapterNo = nextWritableChapterNo(built.chapters);
  const nextPlot = project.plotFor(nextChapterNo, built.plots, built.chapters);
  const gap = chapterGapOf(built.chapters);
  return {
    settings,
    outlineFilled: isOutlineFilled(built.outline),
    outlineCoverage: outlineCoverage(built.outline),
    totalChapters: built.config.totalChapters,
    nextChapterNo,
    ...(gap ? { gap } : {}),
    nextPlotFilled: !!nextPlot && isPlotFilled(nextPlot.sections),
    plotFilledNos: project.pairPlots(built.plots, built.chapters).filter((p) => isPlotFilled(p.sections)).map((p) => p.no),
  };
}

/**
 * 下一个该写的章：从第 1 章起**连续**有正文（字数 > 0）的最大章号 + 1。
 *
 * 空文件不算写过：作者新建了一个空章节占位，主按钮仍该说「写这一章」。
 */
export function nextWritableChapterNo(chapters: Chapter[]): number {
  const written = new Set(chapters.filter((c) => c.wordCount > 0).map((c) => c.order));
  let n = 1;
  while (written.has(n)) {
    n++;
  }
  return n;
}

/**
 * 已写的正文中间断了一截：第 {@link nextWritableChapterNo} 章没有正文，后面却还有。
 * 缺口后面一章正文都没有时 undefined——那只是还没写到。
 */
export function chapterGapOf(chapters: Chapter[]): ChapterGap | undefined {
  const from = nextWritableChapterNo(chapters);
  const later = [...new Set(chapters.filter((c) => c.wordCount > 0 && c.order > from).map((c) => c.order))].sort((a, b) => a - b);
  if (later.length === 0) {
    return undefined;
  }
  return { from, to: later[0] - 1, later: later.length, last: later[later.length - 1] };
}

/** 有不止一个文件的章号（升序）：工程只按文件名开头的数字认章，同号的几个文件会抢同一章。 */
export function duplicateChapterNos(chapters: Chapter[]): number[] {
  const seen = new Map<number, number>();
  for (const c of chapters) {
    seen.set(c.order, (seen.get(c.order) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([no]) => no).sort((a, b) => a - b);
}

/**
 * 流水线 → `deriveNextStep` 要的那几个事实。
 *
 * **只有一份**：创作页的主按钮与 agent 每回合的状态注入都吃它。看着只是个字段
 * 搬运，其实带着一条判据——正文写到几成（`manuscriptRatio`，与 `deriveStage` 同源）。
 *
 * 参数写成结构类型而不是 `PlotPipeline`：数据层的 `PlotPipeline` 与线上的
 * `PlotPipelineView` 在这几个字段上同形，两处调用共用一份。
 */
export function factsOf(p: {
  no: number;
  chapter: { words: number; targetWords?: number; upstreamStale: boolean };
}): NextStepFacts {
  const { words, targetWords, upstreamStale } = p.chapter;
  return {
    no: p.no,
    words,
    ratio: manuscriptRatio({ words, targetWords }),
    upstreamStale,
  };
}
