/**
 * 流水线的读取聚合：把磁盘上散落的产物合成一份「这一章 / 这本书现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把各章摘要反向聚合成出场索引，
 * 这边把大纲 / 细纲 / 正文 / 摘要聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](../model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 一条轴，按号合并
 *
 * 细纲号 = 章号。第 N 章的细纲（`plots/NNN-*.md`）、正文（`chapters/NNN-*`）、
 * 摘要按号互认，**认号只在这个文件里做**（{@link chapterOfPlotNo}）。同号的细纲或章节
 * 有两份时（作者手改文件名撞了号）取路径排序第一份，并记一条 warn——不猜、不崩，
 * 让作者在工程页上看得见两份。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md 里覆盖第 N 章那一节 ─hash─▶ plots/N.md    (frontmatter.upstreamHash)
 * plots/N.md 三个小节              ─hash─▶ plots/N.md    (frontmatter.writtenFrom，正文落盘时记)
 * chapters/N                       ─hash─▶ summaries/N   (frontmatter.sourceHash)
 * ```
 *
 * 改了大纲的某一节，那一节覆盖的几章细纲标脏；改了某一章的细纲，那一章的正文
 * 标脏；改了正文，摘要过期。**代价是零次模型调用、零幻觉、零 token。**
 *
 * 正文那一环的指纹记在**细纲**上而不是章节上：章节是作者的文件，可以是 `.txt`、
 * 没有 frontmatter（第 9 条）。架构 → 大纲那一环留到二期（大纲生成移植过来之后）。
 */
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { hash, pad3, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, PLOT_SECTION_KEYS, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { BookConfig } from '../model/settingFile';
import { isOutlineFilled, outlineCoverage, outlineUpstreamHash } from '../model/outlineFile';
import {
  BookFacts,
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
import { Chapter, ProjectManifest } from '../model/types';
import { SummaryIndex, buildSummaryIndex, summaryOf } from './summaryIndex';

const log = scoped('流水线');

export interface PlotPipeline {
  /** 章号。 */
  no: number;
  title: string;
  /** 这一章的细纲。**没有细纲时 `relPath` 是它应该在的位置**（`plotPathForNo`）。 */
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
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

/**
 * 一章的流水线状态。`plot` 与 `chapter` 至少有一个在，都没有时就是一份空壳
 * （「写第 N 章细纲」）。
 *
 * `context` 由调用方传入：批量构建（工程页要为几百章各算一份）时大纲、配置只读
 * 一次、摘要整体读一次，否则每章都去读一遍同样的文件。
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
    summaries?: SummaryIndex;
    chapters?: Chapter[];
  }
): Promise<PlotPipeline> {
  const { no, plot } = entry;
  const outline = context?.outline ?? (await project.readOutline());
  const config = context?.config ?? (await project.readBookConfig());
  const chapters = context?.chapters ?? (await project.listChapters());
  const chapter = entry.chapter ?? chapterOfPlotNo(chapters, no);
  const summary = chapter ? await summaryOf(project, chapter.relPath, context?.summaries) : undefined;

  // upstreamHash 为空 = 这份细纲是作者手写的（或来自还没记录指纹的旧版本）——
  // **不标脏**：手写的东西没有「上游」，拿一个凭空的过期标记去催作者重做，比不标更糟。
  const plotStale = !!plot?.upstreamHash && plot.upstreamHash !== outlineUpstreamHash(outline, no);
  // 同理：没记过 writtenFrom（正文是作者自己写的）不标脏——只有「记录过一次、
  // 现在对不上」才说明细纲确实在正文之后改过（第 18a 条）。
  const chapterStale = !!chapter && !!plot?.writtenFrom && plot.writtenFrom !== plotContentHash(plot);

  const targetWords = plot?.targetWords ?? config.wordsPerChapter;
  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: !!plot && isPlotFilled(plot.sections),
    words: chapter?.wordCount ?? 0,
    targetWords,
    upstreamStale: chapterStale,
    chapterExists: !!chapter,
    summaryExists: !!summary,
    summaryStale: !chapter || !summary || summary.sourceHash !== chapter.contentHash,
    markedDone: !!plot?.done,
  };

  return {
    no,
    title: plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : ''),
    plot: {
      relPath: plot?.relPath ?? project.plotPathForNo(no, chapter?.title ?? ''),
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
  summaries: SummaryIndex;
  manifest: ProjectManifest;
  outline: string;
  config: BookConfig;
}

/**
 * 全书的流水线索引。**按号合并**两条列表（见文件头）。
 *
 * 大纲、配置、manifest 与摘要都只读一次，摊给所有章——五百章工程逐章重读
 * 这些文件会把工程页刷新变成几百次多余的读盘。建好的摘要索引与 manifest 一并返回：
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
  const summaries = await buildSummaryIndex(project, chapters);
  const context = { outline, config, summaries, chapters };

  const plotByNo = firstByNo(plots, (p) => p.no, 'plots');
  const chapterNos = new Set(chapters.map((c) => c.order));
  const nos = [...new Set([...plotByNo.keys(), ...chapterNos])].sort((a, b) => a - b);

  const rows: PlotPipeline[] = [];
  for (const no of nos) {
    rows.push(await buildPlotPipeline(project, { no, plot: plotByNo.get(no) }, context));
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
  return { rows, byNo, plots, chapters, summaries, manifest, outline, config };
}

/**
 * 第 N 章的正文：同号章节里路径排序第一份。**认号只在这里做一次**。
 *
 * 同号有两份时两份都还在工程页上（章节列表照常列出），只是流水线认第一份——
 * 作者看得见冲突，才能去改。
 */
export function chapterOfPlotNo(chapters: Chapter[], no: number): Chapter | undefined {
  return chapters.find((c) => c.order === no);
}

/** 按号取第一份，撞号时记一条 warn。 */
function firstByNo<T>(items: T[], noOf: (item: T) => number, what: string): Map<number, T> {
  const out = new Map<number, T>();
  const dup = new Set<number>();
  for (const item of items) {
    const no = noOf(item);
    if (out.has(no)) {
      dup.add(no);
    } else {
      out.set(no, item);
    }
  }
  if (dup.size > 0) {
    log.warn(`${what} 里有撞号的文件，流水线只认路径排序第一份`, [...dup].map((n) => `第 ${n} 章`).join('、'));
  }
  return out;
}

/**
 * 第 N 章的正文该落在哪。**要读盘**，所以不放进纯函数 `pathOfTarget`。
 *
 * 同号章节已存在就用它（`exists: true`，落盘走追加）；否则是
 * `chapters/NNN-<细纲标题>.md`（细纲没有标题就是纯序号名）。
 */
export async function chapterTargetOf(
  project: NovelProject,
  plotRelPath: string
): Promise<{ no: number; rel: string; exists: boolean; title: string }> {
  const no = parsePlotFileName(path.posix.basename(plotRelPath))?.no;
  if (no === undefined) {
    throw new Error(`认不出这份细纲的章号：${plotRelPath}`);
  }
  const existing = await project.getChapter(no);
  if (existing) {
    return { no, rel: existing.relPath, exists: true, title: existing.title };
  }
  const plot = await project.readPlot(plotRelPath);
  const title = plot?.title?.trim() ?? '';
  const stem = title ? sanitizeFileName(title) : '';
  const dir = project.relPath(project.chaptersDir);
  const fileName = stem ? `${pad3(no)}-${stem}.md` : `${pad3(no)}.md`;
  return { no, rel: dir ? `${dir}/${fileName}` : fileName, exists: false, title };
}

/**
 * 全书状态机要的事实（`deriveBookStage` / `deriveBookNextStep`）。
 *
 * **只有这一份**：创作页的主按钮（controller/chat.ts）、工程页的全书阶段
 * （views/projectView.ts）与 agent 每回合的状态注入（agent/context.ts）都吃它
 * ——各取各的，界面上的主按钮就会与 agent 说的下一步分叉（第 20 条）。
 */
export async function buildBookFacts(project: NovelProject, index?: PipelineIndex): Promise<BookFacts> {
  const built = index ?? (await buildPipelineIndex(project));
  const settings = await project.settingFilled();
  const nextChapterNo = nextWritableChapterNo(built.chapters);
  const nextPlot = built.plots.find((p) => p.no === nextChapterNo);
  return {
    settings,
    outlineFilled: isOutlineFilled(built.outline),
    outlineCoverage: outlineCoverage(built.outline),
    totalChapters: built.config.totalChapters,
    nextChapterNo,
    nextPlotFilled: !!nextPlot && isPlotFilled(nextPlot.sections),
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

/**
 * 细纲的内容指纹——**这一章正文的上游**。
 *
 * 只哈希**三个小节**，不含 frontmatter：`upstreamHash` / `writtenFrom` 自己就在
 * frontmatter 里，把它算进去会让「排一次细纲」立刻使刚写好的正文过期。同理不含
 * `status`——作者把这一章标成 done 不该让它的正文标脏。
 */
export function plotContentHash(plot: Plot): string {
  return hash(PLOT_SECTION_KEYS.map((key) => plot.sections[key]).join('\n---\n'));
}
