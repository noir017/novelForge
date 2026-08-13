/**
 * 章节流水线的读取聚合：把磁盘上散落的四层产物合成一份「这一章现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把各章摘要反向聚合成出场索引，
 * 这边把大纲/细纲/场景/正文/摘要聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md ──hash──▶ plans/*.md      (frontmatter.upstreamHash)
 * plans/X.md ──hash──▶ scenes/X/*.md   (frontmatter.upstreamHash)
 * scenes/X/* ──hash──▶ chapters/X      (manifest.beatsHash)
 * chapters/X ──hash──▶ summaries/X.md  (frontmatter.sourceHash，已有)
 * ```
 *
 * 改了全书大纲，所有细纲标脏；改了某章细纲，该章全部场景标脏；改了某一场，
 * 该章正文标脏；改了正文，摘要过期（既有行为，一字未动）。
 *
 * **代价是零次模型调用、零幻觉、零 token。** 这是有意的取舍：把「变更影响」
 * 做成 AI 功能，等于每改一行细纲就烧一次钱，而且会给出看起来很像但没有依据
 * 的影响清单。真正需要语义判断的跨章影响（「第 15 章提到他曾翻越侧峰」）只能
 * 由作者显式触发，不在这里自动跑。
 */
import { scoped } from './logger';
import { hash } from './model/fs';
import { NovelProject } from './model/project';
import { ChapterPlan } from './model/planFile';
import { isPlanFilled } from './model/planFile';
import { Scene } from './model/sceneFile';
import {
  ChapterStage,
  PipelineFacts,
  PipelineProgress,
  deriveProgress,
  deriveStage,
  emptyFacts,
} from './model/pipeline';
import { Chapter, ProjectManifest } from './model/types';

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
  /** 「必须发生」已填，可以写正文了。 */
  ready: boolean;
  /** 生成这一场之后，本章细纲改过——前置条件可能已经失效。 */
  upstreamStale: boolean;
}

export interface ChapterPipeline {
  chapterRelPath: string;
  order: number;
  title: string;
  plan?: {
    relPath: string;
    /** 生成这份细纲之后，全书大纲改过。 */
    upstreamStale: boolean;
    filled: boolean;
  };
  scenes: SceneView[];
  manuscript: {
    words: number;
    /** 写完正文之后，场景改过——正文可能已经与细节对不上。 */
    beatsStale: boolean;
  };
  summary: { exists: boolean; stale: boolean };
  stage: ChapterStage;
  progress: PipelineProgress;
}

/**
 * 一章的流水线状态。
 *
 * `outlineHash` / `manifest` 由调用方传入：批量构建（工程页要为几百章各算一份）
 * 时大纲只读一次、manifest 只读一次，否则每章都去读一遍同样的两个文件。
 */
export async function buildChapterPipeline(
  project: NovelProject,
  chapter: Chapter,
  context?: { outlineHash?: string; manifest?: ProjectManifest }
): Promise<ChapterPipeline> {
  const outlineHash = context?.outlineHash ?? hash(await project.readOutline());
  const manifest = context?.manifest ?? (await project.readManifest());

  const plan = await project.readPlan(chapter.relPath);
  const scenes = await project.listScenes(chapter.relPath);
  const summary = await project.readSummary(chapter);

  // 细纲的上游是全书大纲。upstreamHash 为空 = 这份细纲是作者手写的
  // （或来自还没记录指纹的旧版本）——**不标脏**：手写的东西没有「上游」，
  // 拿一个凭空的过期标记去催作者重做，比不标更糟。
  const planStale = !!plan && !!plan.upstreamHash && plan.upstreamHash !== outlineHash;
  const planHash = plan ? planContentHash(plan) : '';

  const sceneViews = scenes.map<SceneView>((s) => ({
    no: s.no,
    title: s.title,
    relPath: s.relPath,
    place: s.place,
    time: s.time,
    characters: s.characters,
    status: s.status,
    ready: s.status === 'ready' || s.status === 'written',
    upstreamStale: !!s.upstreamHash && !!planHash && s.upstreamHash !== planHash,
  }));

  const entry = manifest.chapters.find((c) => c.file === chapter.relPath);
  const beatsHash = await project.beatsHashFor(chapter.relPath);
  // 同理：没记录过 beatsHash（正文是作者自己写的、或流水线之前就有的章节）
  // 不标脏。只有「记录过一次、现在对不上」才说明场景确实改过。
  const beatsStale = !!entry?.beatsHash && !!beatsHash && entry.beatsHash !== beatsHash;

  const facts: PipelineFacts = {
    ...emptyFacts(),
    hasPlan: !!plan,
    planFilled: !!plan && isPlanFilled(plan.sections),
    sceneCount: sceneViews.length,
    sceneReady: sceneViews.filter((s) => s.ready).length,
    sceneWritten: sceneViews.filter((s) => s.status === 'written').length,
    words: chapter.wordCount,
    beatsStale,
    summaryExists: !!summary,
    summaryStale: !summary || summary.sourceHash !== chapter.contentHash,
    markedDone: !!plan?.done,
  };

  return {
    chapterRelPath: chapter.relPath,
    order: chapter.order,
    title: chapter.title,
    plan: plan ? { relPath: plan.relPath, upstreamStale: planStale, filled: facts.planFilled } : undefined,
    scenes: sceneViews,
    manuscript: { words: chapter.wordCount, beatsStale },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

/**
 * 全书的流水线索引，按章节 relPath 索引。
 *
 * 大纲与 manifest 只读一次，摊给所有章节——五百章工程逐章重读这两个文件
 * 会把工程页刷新变成几百次多余的读盘。
 */
export async function buildPipelineIndex(
  project: NovelProject
): Promise<Map<string, ChapterPipeline>> {
  const startedAt = Date.now();
  const [chapters, outline, manifest] = await Promise.all([
    project.listChapters(),
    project.readOutline(),
    project.readManifest(),
  ]);
  const context = { outlineHash: hash(outline), manifest };

  const out = new Map<string, ChapterPipeline>();
  for (const chapter of chapters) {
    out.set(chapter.relPath, await buildChapterPipeline(project, chapter, context));
  }

  const stale = [...out.values()].filter(
    (p) => p.plan?.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale)
  );
  if (stale.length > 0) {
    // 上游变更是「作者需要知道但不会主动去翻」的那类事，进日志才留得住。
    log.debug(
      `${stale.length} 章的上游产物有变更`,
      `${stale.map((p) => `第 ${p.order} 章`).join('、')}｜耗时 ${Date.now() - startedAt}ms`
    );
  }
  return out;
}

/**
 * 细纲的内容指纹——场景的上游。
 *
 * 只哈希**五个小节**，不含 frontmatter：`upstreamHash` 自己就在 frontmatter 里，
 * 把它算进去会让「写一次细纲」立刻使全部场景过期。同理不含 `status`——
 * 作者把这一章标成 done 不该让四个场景一起标脏。
 */
export function planContentHash(plan: ChapterPlan): string {
  return hash(
    [
      plan.sections.本章目标,
      plan.sections.开头,
      plan.sections.结尾,
      plan.sections.冲突与节奏,
      plan.sections.伏笔与回收,
    ].join('\n---\n')
  );
}
