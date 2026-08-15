/**
 * 单章流水线的读取聚合：把磁盘上散落的产物合成一份「这一章现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把各章摘要反向聚合成出场索引，
 * 这边把大纲/细纲/场景/正文/摘要聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](../model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 一章有两副面孔
 *
 * 一章可能有细纲（`plots/`）、可能有成品（`chapters/`），也可能两者都有：
 *
 * - **两者都有**：正常走完流水线的章。
 * - **只有细纲**：规划了还没写完、或写完还没拆分的章。
 * - **只有成品**：老工程里那些从没经过本工具的章——它们一样要出现在列表上，
 *   一样能总结、能进上下文。这是「原有的章节天生就算数」最直接的落点。
 *
 * 所以这一层按**章号**把两边合起来（见 `buildPipelineIndex`），而不是只遍历
 * 其中一侧。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md ──hash──▶ plots/*.md        (frontmatter.upstreamHash)
 * plots/X.md ──hash──▶ scenes/X/*.md     (frontmatter.upstreamHash)
 * scenes/X/* ──hash──▶ manuscripts/X.md  (frontmatter.beatsHash)
 * chapters/X ──hash──▶ summaries/X.md    (frontmatter.sourceHash)
 * ```
 *
 * 改了全书大纲，所有细纲标脏；改了某章细纲，该章全部场景标脏；改了某一场，
 * 该章正文标脏；改了正文，摘要过期。
 *
 * **代价是零次模型调用、零幻觉、零 token。** 这是有意的取舍：把「变更影响」
 * 做成 AI 功能，等于每改一行剧情就烧一次钱，而且会给出看起来很像但没有依据
 * 的影响清单。真正需要语义判断的跨章影响（「第 15 章提到他曾翻越侧峰」）只能
 * 由作者显式触发，不在这里自动跑。
 *
 * 注意最后一环的上游是 `chapters/` 而不是中转站：摘要描述的是成品。
 */
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, PLOT_SECTION_KEYS, isPlotFilled } from '../model/plotFile';
import { Scene } from '../model/sceneFile';
import {
  PipelineFacts,
  PipelineProgress,
  PlotStage,
  deriveProgress,
  deriveStage,
  emptyFacts,
} from '../model/pipeline';
import { Chapter, ProjectManifest } from '../model/types';
import { SummaryIndex, buildSummaryIndex, summaryOf } from './summaryIndex';

const log = scoped('流水线');

/** 一场在流水线视图里的样子。比 Scene 少了正文全文，多了新鲜度。 */
export interface SceneView {
  no: number;
  title: string;
  relPath: string;
  place: string;
  time: string;
  characters: string[];
  status: Scene['status'];
  /** 已经有素材了，可以写正文。 */
  ready: boolean;
  /** 生成这一场之后，本章细纲改过——前置条件可能已经失效。 */
  upstreamStale: boolean;
}

export interface PlotPipeline {
  /**
   * 细纲的工作区相对路径。**这一章还没有细纲时是空串**（老工程里的章）——
   * 界面上那些「进入这一层」的入口据此收起来。
   */
  plotRelPath: string;
  no: number;
  title: string;
  /** 这一章的细纲。 */
  plot: {
    relPath: string;
    /** 有这份文件。老工程里只有成品的章为 false。 */
    exists: boolean;
    /** 排过这一章之后，全书大纲改过。 */
    upstreamStale: boolean;
    filled: boolean;
  };
  scenes: SceneView[];
  /** 中转站里的正文（等着拆分那份）。拆完就没有了。 */
  manuscript: {
    relPath: string;
    words: number;
    /** 写完正文之后，场景改过——正文可能已经与细节对不上。 */
    beatsStale: boolean;
  };
  /** 发布区里的成品。拆分之后才有。 */
  chapter: { exists: boolean; relPath: string; words: number };
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

/**
 * 一章的流水线状态。
 *
 * `plot` 与 `chapter` 至少有一个在：前者是规划，后者是成品。
 *
 * `outlineHash` / `summaries` 由调用方传入：批量构建（工程页要为几百章各算一份）
 * 时大纲只读一次、摘要整体读一次，否则每章都去读一遍同样的文件。
 *
 * `entry` 上那个 `sections?: never` 是防呆：`Plot` 自己就有 `no`，另外两个字段
 * 又是可选的，所以**直接把一份 `Plot` 递进来是编译得过的**，代价是 plot 与
 * chapter 双双 undefined、整章按空事实推导——界面于是一律说「待写剧情」，
 * 而这条路正是「选中一章 = 进入它当前该做的那一步」的判据。这种错不会报错，
 * 只会安静地说谎，所以拿一个 `Plot` 有、这里绝不该有的字段把它挡在编译期。
 */
export async function buildPlotPipeline(
  project: NovelProject,
  entry: { no: number; plot?: Plot; chapter?: Chapter; sections?: never },
  context?: { outlineHash?: string; summaries?: SummaryIndex }
): Promise<PlotPipeline> {
  const { no, plot, chapter } = entry;
  const outlineHash = context?.outlineHash ?? hash(await project.readOutline());

  // 只有成品的章（老工程）没有细纲，也就没有场景与中转站正文可读——
  // 那几次读盘直接省掉，五百章的老工程刷新一次能省一千多次。
  const scenes = plot ? await project.listScenes(plot.relPath) : [];
  const manuscript = plot ? await project.readManuscript(plot.relPath) : undefined;
  const summary = chapter ? await summaryOf(project, chapter.relPath, context?.summaries) : undefined;

  // 细纲的上游是全书大纲。upstreamHash 为空 = 这一章是作者手写的
  // （或来自还没记录指纹的旧版本）——**不标脏**：手写的东西没有「上游」，
  // 拿一个凭空的过期标记去催作者重做，比不标更糟。
  const plotStale = !!plot?.upstreamHash && plot.upstreamHash !== outlineHash;
  const plotHash = plot ? plotContentHash(plot) : '';

  const sceneViews = scenes.map<SceneView>((s) => ({
    no: s.no,
    title: s.title,
    relPath: s.relPath,
    place: s.place,
    time: s.time,
    characters: s.characters,
    status: s.status,
    ready: s.status === 'ready' || s.status === 'written',
    upstreamStale: !!s.upstreamHash && !!plotHash && s.upstreamHash !== plotHash,
  }));

  // 场景上面刚读过，复用它——`beatsHashFor` 不给场景就会再 listScenes 一遍，
  // 全书刷新时那是每章多读一整个场景目录。
  const beatsHash = plot ? await project.beatsHashFor(plot.relPath, scenes) : '';
  // 同理：没记录过 beatsHash（正文是作者自己贴进来的）不标脏。
  // 只有「记录过一次、现在对不上」才说明场景确实改过。
  const beatsStale = !!manuscript?.beatsHash && !!beatsHash && manuscript.beatsHash !== beatsHash;

  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: !!plot && isPlotFilled(plot.sections),
    sceneCount: sceneViews.length,
    sceneReady: sceneViews.filter((s) => s.ready).length,
    sceneWritten: sceneViews.filter((s) => s.status === 'written').length,
    words: manuscript?.wordCount ?? 0,
    beatsStale,
    chapterExists: !!chapter,
    summaryExists: !!summary,
    // 成品的 hash 是摘要的上游。没有成品时无从判断，一律算过期
    // （那时 stage 也走不到审阅那一步，这个值只影响进度条的最后一格）。
    summaryStale: !summary || !chapter || summary.sourceHash !== chapter.contentHash,
    markedDone: !!plot?.done,
  };

  return {
    plotRelPath: plot?.relPath ?? '',
    no,
    title: plot?.title || chapter?.title || '',
    plot: {
      relPath: plot?.relPath ?? '',
      exists: !!plot,
      upstreamStale: plotStale,
      filled: facts.plotFilled,
    },
    scenes: sceneViews,
    manuscript: {
      relPath: manuscript?.relPath ?? (plot ? project.manuscriptMirrorRelPath(plot.relPath) : ''),
      words: facts.words,
      beatsStale,
    },
    chapter: {
      exists: !!chapter,
      relPath: chapter?.relPath ?? '',
      words: chapter?.wordCount ?? 0,
    },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

/**
 * 全书的流水线索引，按**章号**索引。
 *
 * 把 `plots/`（规划）与 `chapters/`（成品）按章号并起来：两边都有的是正常走完
 * 流水线的章，只有一边的分别是「还没写完」与「老工程里已经写好的」。
 *
 * 大纲、manifest 与全书摘要都只读一次，摊给所有章——五百章工程逐章重读这些
 * 文件会把工程页刷新变成几百次多余的读盘。
 *
 * 建好的摘要索引与 manifest 一并返回：工程树与出场索引要的是同一批摘要、同一份
 * manifest，让它们接着用这一份，而不是各自再读一遍。
 */
export async function buildPipelineIndex(
  project: NovelProject
): Promise<{
  pipelines: Map<number, PlotPipeline>;
  summaries: SummaryIndex;
  manifest: ProjectManifest;
  /** 大纲原文。工程页要用它判全书阶段（有没有大纲），不必自己再读一遍。 */
  outline: string;
}> {
  const startedAt = Date.now();
  const [plots, chapters, outline, manifest] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    project.readOutline(),
    project.readManifest(),
  ]);
  const summaries = await buildSummaryIndex(project, chapters);
  const context = { outlineHash: hash(outline), summaries };

  // 章号是两边共同的身份。同号多份（作者手改文件名撞了号）时后来的覆盖前面的，
  // 与 listChapters/listPlots 各自的稳定排序一致——列表里两条都在，
  // 流水线状态取排在后面那条，界面上看得出冲突。
  const byNo = new Map<number, { no: number; plot?: Plot; chapter?: Chapter }>();
  for (const plot of plots) {
    byNo.set(plot.no, { ...byNo.get(plot.no), no: plot.no, plot });
  }
  for (const chapter of chapters) {
    byNo.set(chapter.order, { ...byNo.get(chapter.order), no: chapter.order, chapter });
  }

  const out = new Map<number, PlotPipeline>();
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    out.set(no, await buildPlotPipeline(project, byNo.get(no)!, context));
  }

  const stale = [...out.values()].filter(
    (p) => p.plot.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale)
  );
  if (stale.length > 0) {
    // 上游变更是「作者需要知道但不会主动去翻」的那类事，进日志才留得住。
    log.debug(
      `${stale.length} 章的上游产物有变更`,
      `${stale.map((p) => `第 ${p.no} 章`).join('、')}｜耗时 ${Date.now() - startedAt}ms`
    );
  }
  return { pipelines: out, summaries, manifest, outline };
}

/**
 * 细纲的内容指纹——场景的上游。
 *
 * 只哈希**四个小节**，不含 frontmatter：`upstreamHash` 自己就在 frontmatter 里，
 * 把它算进去会让「排一次剧情」立刻使全部场景过期。同理不含 `status`——
 * 作者把这一章标成 done 不该让四个场景一起标脏。
 */
export function plotContentHash(plot: Plot): string {
  return hash(PLOT_SECTION_KEYS.map((key) => plot.sections[key]).join('\n---\n'));
}
