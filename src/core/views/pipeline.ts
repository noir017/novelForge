/**
 * 单章流水线的读取聚合：把磁盘上散落的产物合成一份「这一章现在到哪一步了」。
 *
 * 与 [cast.ts](cast.ts) 同级、同类——那边把各章摘要反向聚合成出场索引，
 * 这边把大纲/细纲/场景/正文/摘要聚合成流水线状态。判断逻辑全在纯函数
 * [model/pipeline.ts](../model/pipeline.ts) 里，这里只负责取数。
 *
 * ## 两条轴，不再按号合并
 *
 * 规划的单位是**剧情段**（`plots/`），发布的单位是**章**（`chapters/`），
 * 一段可以拆成三章——所以段号与章号是两条独立的轴，`buildPipelineIndex`
 * 分别遍历它们，**不再按号把两边并成一行**。
 *
 * 从前是并的：一份细纲对应一章，两者同号。那条不变量随「一段拆成几章」一起
 * 没了——拆分不再把后面几十份细纲整体改名顺延（那是一次要连带搬走场景目录与
 * 中转站正文的重命名风暴），于是段号会与章号撞车，而撞车的两者根本不是同一
 * 件东西。
 *
 * 「这一段交付到了哪几章」现在**显式记在细纲的 frontmatter 里**
 * （`chapters:`，见 `chaptersOfSegment`）。老工程没有这个字段，那时退回同号
 * 判定——判据只在这一处写一次。
 *
 * 于是列表上有两种行：
 *
 * - **已发布的章**（`chapters/`）：包括老工程里那些从没经过本工具的章。
 *   它们照旧能总结、能进上下文。
 * - **未交付的剧情段**（`plots/` 里还没记下落点的那些）：带阶段徽章与四段进度，
 *   界面上称「剧情 N」，那个 N 是推导出来的位次（`segmentDisplayNo`）。
 *
 * ## 新鲜度链：把「变更影响」做成传播，而不是一次模型调用
 *
 * ```
 * outline.md ───hash──▶ volumes/*.md      (frontmatter.upstreamHash)
 * volumes/V.md ─hash──▶ plots/V/*.md      (frontmatter.upstreamHash)
 * plots/X.md ───hash──▶ scenes/X/*.md     (frontmatter.upstreamHash)
 * scenes/X/* ───hash──▶ manuscripts/X.md  (frontmatter.beatsHash)
 * chapters/X ───hash──▶ summaries/X.md    (frontmatter.sourceHash)
 * ```
 *
 * 改了全书大纲，所有卷纲标脏；改了某一卷，**那一卷的**剧情段标脏（从前是
 * 改大纲让全书每一段都标脏——粒度太粗，改一句立意换来一屏 ⟳）；改了某一段，
 * 该段全部场景标脏；改了某一场，该段正文标脏；改了正文，摘要过期。
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
import { VOLUME_SECTION_KEYS, Volume } from '../model/volumeFile';
import { Scene } from '../model/sceneFile';
import {
  NextStepFacts,
  PipelineFacts,
  PipelineProgress,
  PlotStage,
  deriveProgress,
  deriveStage,
  emptyFacts,
  segmentDisplayNo,
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
  /** 段号（文件名前缀）。只是 `plots/` 里的排序键，不是章号。 */
  no: number;
  /**
   * 界面上那个「剧情 N」的 N：**最新章号 + 在未交付的段里排第几**。
   *
   * 由 `buildPipelineIndex` 统一算（它手上有全书章节列表）。单段取数
   * （`buildPlotPipeline`）算不出位次，那时等于 `no`——那条路上的调用方
   * 拿它只做日志与标题，不排列表。
   */
  displayNo: number;
  /**
   * 这一段已经交付：正文拆成发布章了。界面上它不再是一个待做的剧情段，
   * 由它拆出来的那几章各自成行。
   */
  consumed: boolean;
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
  /**
   * 发布区里的成品。拆分之后才有。
   *
   * 一段可以拆成几章，所以 `relPath` 是**第一章**、`words` 是几章的**总字数**，
   * 全部落点在 `chapterPaths` 里。界面上「打开正文」开第一章就够了——那是
   * 这一段的开头，作者顺着往下翻。
   */
  chapter: { exists: boolean; relPath: string; words: number; chapterPaths: string[] };
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
  context?: {
    outlineHash?: string;
    summaries?: SummaryIndex;
    chapters?: Chapter[];
    /** 这一段所属那一卷的内容指纹。不给就退回全书大纲的（未分卷的段本来就是它）。 */
    upstreamHash?: string;
    /** 界面位次。批量路径算得出，单段路径算不出，那时退回段号。 */
    displayNo?: number;
  }
): Promise<PlotPipeline> {
  const { no, plot } = entry;
  const outlineHash = context?.outlineHash ?? hash(await project.readOutline());

  // 只有成品的章（老工程）没有细纲，也就没有场景与中转站正文可读——
  // 那几次读盘直接省掉，五百章的老工程刷新一次能省一千多次。
  const scenes = plot ? await project.listScenes(plot.relPath) : [];
  const manuscript = plot ? await project.readManuscript(plot.relPath) : undefined;

  // 这一段交付到了哪几章。调用方给了单章（选中一个只有成品的老章那条路）时
  // 以它为准，否则按 frontmatter 的落点记录去认（老工程退回同号）。
  const allChapters = context?.chapters ?? (plot ? await project.listChapters() : []);
  const produced = plot
    ? chaptersOfSegment(project, plot, allChapters)
    : entry.chapter
      ? [entry.chapter]
      : [];
  const chapter = produced[0] ?? entry.chapter;
  const summaries = await Promise.all(
    produced.map((c) => summaryOf(project, c.relPath, context?.summaries))
  );

  // 细纲的上游是**它所属那一卷**的卷纲（未分卷的段是全书大纲）。upstreamHash
  // 为空 = 这一段是作者手写的（或来自还没记录指纹的旧版本）——**不标脏**：
  // 手写的东西没有「上游」，拿一个凭空的过期标记去催作者重做，比不标更糟。
  const upstream = context?.upstreamHash ?? outlineHash;
  const plotStale = !!plot?.upstreamHash && plot.upstreamHash !== upstream;
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

  // 摘要按**这一段拆出来的每一章**算：全都总结过、且都不过期才算齐。
  // 只看第一章的话，一段拆成三章之后作者总结了第一章就会显示「已完成」。
  const producedWords = produced.reduce((sum, c) => sum + c.wordCount, 0);
  const summaryExists = produced.length > 0 && summaries.every((s) => !!s);
  const summaryStale =
    produced.length === 0 ||
    produced.some((c, i) => !summaries[i] || summaries[i]!.sourceHash !== c.contentHash);

  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: !!plot && isPlotFilled(plot.sections),
    sceneCount: sceneViews.length,
    sceneReady: sceneViews.filter((s) => s.ready).length,
    sceneWritten: sceneViews.filter((s) => s.status === 'written').length,
    // 字数以成品为准，还没交付就报中转站里那份——两者说的是同一批文字。
    words: produced.length > 0 ? producedWords : (manuscript?.wordCount ?? 0),
    beatsStale,
    chapterExists: produced.length > 0,
    summaryExists,
    summaryStale,
    markedDone: !!plot?.done,
  };

  return {
    plotRelPath: plot?.relPath ?? '',
    no,
    displayNo: context?.displayNo ?? no,
    consumed: produced.length > 0,
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
      exists: produced.length > 0,
      relPath: chapter?.relPath ?? '',
      words: produced.length > 0 ? producedWords : (chapter?.wordCount ?? 0),
      chapterPaths: produced.map((c) => c.relPath),
    },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

/**
 * 全书的流水线索引。**两条轴各遍历一遍，不按号合并**（见文件头）。
 *
 * 大纲、卷纲、manifest 与全书摘要都只读一次，摊给所有段——五百段工程逐段重读
 * 这些文件会把工程页刷新变成几百次多余的读盘。
 *
 * 建好的摘要索引与 manifest 一并返回：工程树与出场索引要的是同一批摘要、同一份
 * manifest，让它们接着用这一份，而不是各自再读一遍。
 */
export async function buildPipelineIndex(
  project: NovelProject
): Promise<{
  /** 全部剧情段（含已交付的），按细纲路径索引。 */
  pipelines: Map<string, PlotPipeline>;
  /** **还没交付**的剧情段，按段号升序，`displayNo` 已经算好。界面上那一串「剧情 N」。 */
  segments: PlotPipeline[];
  /** 已发布的章，按章号升序。 */
  chapters: Chapter[];
  /** 全书分卷，按卷号升序。 */
  volumes: Volume[];
  summaries: SummaryIndex;
  manifest: ProjectManifest;
  /** 大纲原文。工程页要用它判全书阶段（有没有大纲），不必自己再读一遍。 */
  outline: string;
}> {
  const startedAt = Date.now();
  const [plots, chapters, volumes, outline, manifest] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    project.listVolumes(),
    project.readOutline(),
    project.readManifest(),
  ]);
  const summaries = await buildSummaryIndex(project, chapters);
  const outlineHash = hash(outline);
  // 每一卷的内容指纹算一次，摊给它收纳的全部段——逐段现算等于把同一份卷纲
  // 哈希几十遍。键是那一卷的段目录，正是段路径的前缀。
  const volumeHash = new Map(
    volumes.map((v) => [project.plotsMirrorRelPathForVolume(v.relPath), volumeContentHash(v)])
  );

  const context = { outlineHash, summaries, chapters };
  const pipelines = new Map<string, PlotPipeline>();
  const live: PlotPipeline[] = [];

  // 位次要按**顺序**数，所以先把未交付的挑出来，再逐段构建。
  const liveePlots = plots.filter((p) => !isConsumedSegment(project, p, chapters));
  const max = maxChapterNo(chapters);
  const displayNoOf = new Map(
    liveePlots.map((p, i) => [p.relPath, segmentDisplayNo(max, i)] as const)
  );

  for (const plot of plots) {
    const built = await buildPlotPipeline(project, { no: plot.no, plot }, {
      ...context,
      upstreamHash: volumeHash.get(dirOf(plot.relPath)) ?? outlineHash,
      displayNo: displayNoOf.get(plot.relPath) ?? plot.no,
    });
    pipelines.set(plot.relPath, built);
    if (!built.consumed) {
      live.push(built);
    }
  }

  const stale = live.filter(
    (p) => p.plot.upstreamStale || p.manuscript.beatsStale || p.scenes.some((s) => s.upstreamStale)
  );
  if (stale.length > 0) {
    // 上游变更是「作者需要知道但不会主动去翻」的那类事，进日志才留得住。
    log.debug(
      `${stale.length} 个剧情段的上游产物有变更`,
      `${stale.map((p) => `剧情 ${p.displayNo}`).join('、')}｜耗时 ${Date.now() - startedAt}ms`
    );
  }
  return { pipelines, segments: live, chapters, volumes, summaries, manifest, outline };
}

/** 全书最大章号；一章都没有时 0。剧情段的显示位次从它往后数。 */
export function maxChapterNo(chapters: Chapter[]): number {
  return chapters.reduce((max, c) => Math.max(max, c.order), 0);
}

/**
 * 这一段交付到了哪几章。
 *
 * 判据**只有一条半**：
 *
 * 1. frontmatter 的 `chapters` 记着落点（`Workspace.splitManuscript` 写的）。
 *    落点文件被作者删掉时这里自然收不回它——那一段于是又变回待做项，是对的。
 * 2. **老口径兜底**：没有落点记录、段又直接躺在 `plots/` 根下（未分卷）时，
 *    按「同号的章」认。本层出现之前一段就是一章、两者同号，那些工程一个字节
 *    都没改就得能继续用。
 *
 * 兜底**只对根下的段生效**，卷里的段一律只认显式记录。原因是新口径下段号会
 * 与章号撞车（一段拆成三章，后面的段号不再让路），拿同号去认会把一个刚拆出来
 * 的空段误判成「已经交付」——那一段会从待做列表里凭空消失。根下不会有这种误判：
 * 分卷之后新建的段都落进卷目录，`newPlotFlow` 也把手工新建的段放进最后一卷。
 */
export function chaptersOfSegment(
  project: NovelProject,
  plot: Plot,
  chapters: Chapter[]
): Chapter[] {
  if (plot.chapters.length > 0) {
    const wanted = new Set(plot.chapters);
    return chapters.filter((c) => wanted.has(c.relPath));
  }
  return isUnfiled(project, plot) ? chapters.filter((c) => c.order === plot.no) : [];
}

/** 这一段已经交付（正文拆成发布章了）。判据见 {@link chaptersOfSegment}。 */
export function isConsumedSegment(
  project: NovelProject,
  plot: Plot,
  chapters: Chapter[]
): boolean {
  return chaptersOfSegment(project, plot, chapters).length > 0;
}

/** 未分卷的段：直接躺在 `plots/` 根下，不在任何一卷的目录里。 */
function isUnfiled(project: NovelProject, plot: Plot): boolean {
  return dirOf(plot.relPath) === project.relPath(project.plotsDir);
}

/** 一个工作区相对路径所在的目录（正斜杠）。根下的给空串。 */
function dirOf(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? '' : rel.slice(0, slash);
}

/**
 * 流水线 → `deriveNextStep` 要的那几个事实。
 *
 * **只有一份**：创作页的主按钮（`controller/chat.ts`）与 agent 每回合的状态注入
 * （`agent/context.ts`）都吃它。看着只是个字段搬运，其实带着两条判据——
 * 「第一个还没备素材的场景」与「第一个还没写正文的场景」。各写一遍的话，
 * 界面上的主按钮会说「设计场景 2」而 agent 去写了场景 3，而这种分叉没有
 * 任何测试拦得住（AGENTS 第 20 条）。
 *
 * 参数写成结构类型而不是 `PlotPipeline`：数据层的 `PlotPipeline` 与线上的
 * `PlotPipelineView` 在这几个字段上同形，两处调用共用一份。
 */
export function factsOf(p: {
  scenes: { no: number; ready: boolean; status: string }[];
  manuscript: { beatsStale: boolean };
}): NextStepFacts {
  return {
    sceneCount: p.scenes.length,
    firstUnreadyScene: p.scenes.find((s) => !s.ready)?.no,
    firstUnwrittenScene: p.scenes.find((s) => s.status !== 'written')?.no,
    beatsStale: p.manuscript.beatsStale,
  };
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

/**
 * 卷纲的内容指纹——剧情段的上游。
 *
 * 与 `plotContentHash` 逐条同理：只哈希四个小节，不含 frontmatter（`upstreamHash`
 * 自己就在里面，算进去会让「拆一次卷」立刻使全卷的段过期），也不含 `status`。
 */
export function volumeContentHash(volume: Volume): string {
  return hash(VOLUME_SECTION_KEYS.map((key) => volume.sections[key]).join('\n---\n'));
}
