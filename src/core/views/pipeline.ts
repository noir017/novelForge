/**
 * 剧情段流水线的读取聚合：把磁盘上散落的四层产物合成一份「这一段现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把各段摘要反向聚合成出场索引，
 * 这边把大纲/剧情/场景/正文/摘要聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](../model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md ──hash──▶ plots/*.md        (frontmatter.upstreamHash)
 * plots/X.md ──hash──▶ scenes/X/*.md     (frontmatter.upstreamHash)
 * scenes/X/* ──hash──▶ manuscripts/X.md  (frontmatter.beatsHash)
 * manuscripts/X ─hash▶ summaries/X.md    (frontmatter.sourceHash)
 * ```
 *
 * 改了全书大纲，所有剧情段标脏；改了某段剧情，该段全部场景标脏；改了某一场，
 * 该段正文标脏；改了正文，摘要过期。
 *
 * **代价是零次模型调用、零幻觉、零 token。** 这是有意的取舍：把「变更影响」
 * 做成 AI 功能，等于每改一行剧情就烧一次钱，而且会给出看起来很像但没有依据
 * 的影响清单。真正需要语义判断的跨段影响（「第 15 段提到他曾翻越侧峰」）只能
 * 由作者显式触发，不在这里自动跑。
 *
 * `chapters/` **不在这条链上**：它是作者切好的发布区，工具不分析它的内容。
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
import { ProjectManifest } from '../model/types';
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
  /** 生成这一场之后，本段剧情改过——前置条件可能已经失效。 */
  upstreamStale: boolean;
}

export interface PlotPipeline {
  plotRelPath: string;
  no: number;
  title: string;
  /** 这一段的剧情本身。文件一定存在（它就是这一段），只是可能还没排。 */
  plot: {
    relPath: string;
    /** 排过这一段之后，全书大纲改过。 */
    upstreamStale: boolean;
    filled: boolean;
  };
  scenes: SceneView[];
  manuscript: {
    relPath: string;
    words: number;
    /** 写完正文之后，场景改过——正文可能已经与细节对不上。 */
    beatsStale: boolean;
  };
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

/**
 * 一段的流水线状态。
 *
 * `outlineHash` / `summaries` 由调用方传入：批量构建（工程页要为几百段各算一份）
 * 时大纲只读一次、摘要整体读一次，否则每段都去读一遍同样的文件。
 */
export async function buildPlotPipeline(
  project: NovelProject,
  plot: Plot,
  context?: { outlineHash?: string; summaries?: SummaryIndex }
): Promise<PlotPipeline> {
  const outlineHash = context?.outlineHash ?? hash(await project.readOutline());

  const scenes = await project.listScenes(plot.relPath);
  const manuscript = await project.readManuscript(plot.relPath);
  const summary = await summaryOf(project, plot.relPath, context?.summaries);

  // 剧情段的上游是全书大纲。upstreamHash 为空 = 这一段是作者手写的
  // （或来自还没记录指纹的旧版本）——**不标脏**：手写的东西没有「上游」，
  // 拿一个凭空的过期标记去催作者重做，比不标更糟。
  const plotStale = !!plot.upstreamHash && plot.upstreamHash !== outlineHash;
  const plotHash = plotContentHash(plot);

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
  // 全书刷新时那是每段多读一整个场景目录。
  const beatsHash = await project.beatsHashFor(plot.relPath, scenes);
  // 同理：没记录过 beatsHash（正文是作者自己贴进来的）不标脏。
  // 只有「记录过一次、现在对不上」才说明场景确实改过。
  const beatsStale = !!manuscript?.beatsHash && !!beatsHash && manuscript.beatsHash !== beatsHash;

  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: isPlotFilled(plot.sections),
    sceneCount: sceneViews.length,
    sceneReady: sceneViews.filter((s) => s.ready).length,
    sceneWritten: sceneViews.filter((s) => s.status === 'written').length,
    words: manuscript?.wordCount ?? 0,
    beatsStale,
    summaryExists: !!summary,
    summaryStale: !summary || !manuscript || summary.sourceHash !== manuscript.contentHash,
    markedDone: plot.done,
  };

  return {
    plotRelPath: plot.relPath,
    no: plot.no,
    title: plot.title,
    plot: { relPath: plot.relPath, upstreamStale: plotStale, filled: facts.plotFilled },
    scenes: sceneViews,
    manuscript: {
      relPath: manuscript?.relPath ?? project.manuscriptMirrorRelPath(plot.relPath),
      words: facts.words,
      beatsStale,
    },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

/**
 * 全书的流水线索引，按剧情段 relPath 索引。
 *
 * 大纲、manifest 与全书摘要都只读一次，摊给所有段——五百段工程逐段重读这些
 * 文件会把工程页刷新变成几百次多余的读盘。
 *
 * 建好的摘要索引与 manifest 一并返回：工程树与出场索引要的是同一批摘要、同一份
 * manifest，让它们接着用这一份，而不是各自再读一遍。**manifest 这一趟只是替
 * 工程页读的**——流水线自己用不上它（`beatsHash` 落在正文的 frontmatter 里，
 * 不在 manifest 中），放在这里是因为工程页那次 `Promise.all` 已经在等这个函数了。
 */
export async function buildPipelineIndex(
  project: NovelProject
): Promise<{
  pipelines: Map<string, PlotPipeline>;
  summaries: SummaryIndex;
  manifest: ProjectManifest;
  /** 大纲原文。工程页要用它判全书阶段（有没有大纲），不必自己再读一遍。 */
  outline: string;
}> {
  const startedAt = Date.now();
  const [plots, outline, manifest] = await Promise.all([
    project.listPlots(),
    project.readOutline(),
    project.readManifest(),
  ]);
  const summaries = await buildSummaryIndex(project, plots);
  const context = { outlineHash: hash(outline), summaries };

  const out = new Map<string, PlotPipeline>();
  for (const plot of plots) {
    out.set(plot.relPath, await buildPlotPipeline(project, plot, context));
  }

  const stale = [...out.values()].filter(
    (p) => p.plot.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale)
  );
  if (stale.length > 0) {
    // 上游变更是「作者需要知道但不会主动去翻」的那类事，进日志才留得住。
    log.debug(
      `${stale.length} 段的上游产物有变更`,
      `${stale.map((p) => `第 ${p.no} 段`).join('、')}｜耗时 ${Date.now() - startedAt}ms`
    );
  }
  return { pipelines: out, summaries, manifest, outline };
}

/**
 * 剧情段的内容指纹——场景的上游。
 *
 * 只哈希**四个小节**，不含 frontmatter：`upstreamHash` 自己就在 frontmatter 里，
 * 把它算进去会让「排一次剧情」立刻使全部场景过期。同理不含 `status`——
 * 作者把这一段标成 done 不该让四个场景一起标脏。
 */
export function plotContentHash(plot: Plot): string {
  return hash(PLOT_SECTION_KEYS.map((key) => plot.sections[key]).join('\n---\n'));
}
