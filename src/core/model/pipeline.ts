/**
 * 创作流水线的领域模型：`Job × Target`。
 *
 * **纯类型 + 纯函数，零 I/O**（与 naming.ts / identity.ts / chapterFile.ts 同类），
 * 因此前端、装配器、编排层、工程页共用同一份定义，不会各写一遍再慢慢跑偏。
 *
 * ## 为什么是一维的 Job，不是 `Stage × Capability`
 *
 * 从前这里是两个正交维度：在哪一层（stage）× 要它干什么（capability）。摆成
 * 表是八个格子，而**只有六个成立**——`split`（拆出下一层）只在大纲与卷纲上
 * 有意义，剧情层与正文层没有下一层可拆。
 *
 * 那两个空格子是要付代价的：「剧情层 + split」在类型上说得出口，于是必须有
 * 一张 `STAGE_CAPABILITIES` 表、一个 `isValidAction` 去拦它，agent 的工具里还
 * 要有一段「这一层不支持 split」的错误提示。三处代码存在的全部理由，是防一个
 * 说得出口但不成立的组合。
 *
 * 拍平成六个 job 之后，非法组合**打都打不出来**，那三处随之消失。
 *
 * 两个维度还剩下的那点用处仍然保留：`stage` 决定 AI 的身份（`STAGE_ROLE`）、
 * 装配配方（`recipeFor`）与流水线上的位置，由 `stageOfJob` 从 job 映射得出。
 *
 * ## 规划的单位是剧情段，管理的单位是章
 *
 * 展开的链是四环：
 *
 * ```
 * outline.md ──拆卷──▶ volumes/ ──拆段──▶ plots/ ──▶ manuscripts/ ──拆章──▶ chapters/
 * ```
 *
 * **剧情段与正文之间没有中间层。** 从前这里还有一层「细节」（`scenes/`）：
 * 把一段拆成几场，每场先备一份素材卡再据此写正文。删掉它的理由是
 * **那一层没有它自己要回答的问题**——「这一幕怎么发生」是写正文时才定的东西，
 * 提前落成一份文件只换来三样代价：多一次模型调用、多一层要维护的指纹链、
 * 以及一份写正文时多半要被推翻的清单。一个剧情段本来就支持分几次写、
 * 落成多个发布章（正文里那一行 `---` 就是断点），粒度已经够用。
 *
 * 生成正文时**不要求它正好凑成一章**：模型按剧情的自然长度写，正文先落在
 * 中转站 `manuscripts/`；作者在里面用 `---` 标出断点，一段正文可以拆成两章、
 * 三章。拆完中转站那份就删掉，此后那一段的正文按 `chapters/` 管理
 * （见 model/plotFile.ts 的文件头）。
 *
 * 所以段号与章号是**两条轴**：段号只是 `plots/` 里的排序键，章号必须连续。
 * 界面上剧情段称「剧情 N」，那个 N 是推导出来的位次（`segmentDisplayNo`）。
 *
 * `PlotStage` 比产物层多一档 `split`：正文写完、还没拆分。
 */

// ---------------------------------------------------------------- Stage

/**
 * 创作阶段。四层，自上而下：全书讲什么 → 这一卷怎么走 → 这一段发生什么 →
 * 怎么写出来。
 *
 * **`volume` 是一个真正的阶段**，不是 `outline` 的一种 target。从前它是后者：
 * 分卷与拆段都算「策划编辑」的活，于是借大纲那一套配方与提示词，而按钮上的
 * 说法靠 `targetKind` 特判兜着。代价有三样：卷纲拿不到自己的装配配方
 * （大纲那张里三层与卷相关的层在别的 target 上是空跑的）、每加一处文案都要
 * 记得再特判一次、以及对话页上那一排状态点里根本没有它——而作者切段之前
 * 最常回头看的就是卷纲。
 */
export type CreationStage = 'outline' | 'volume' | 'plot' | 'manuscript';

export const CREATION_STAGES: CreationStage[] = ['outline', 'volume', 'plot', 'manuscript'];

/** 阶段的中文名。前端按钮、日志、确认框共用这一份，不在前端另写。 */
export const STAGE_LABEL: Record<CreationStage, string> = {
  outline: '大纲',
  volume: '卷纲',
  plot: '剧情',
  manuscript: '正文',
};

/** 每个阶段回答的那个问题。前端的流水线条用它做 tooltip。 */
export const STAGE_QUESTION: Record<CreationStage, string> = {
  outline: '故事讲什么？',
  volume: '这一卷怎么走？',
  plot: '这一段发生什么？',
  manuscript: '怎么把它写出来？',
};

/**
 * AI 在该阶段的身份。
 *
 * 这比提示词技巧更要紧：同一句「这里冲突太弱」，策划编辑会去动故事结构，
 * 分卷编剧会去调这一卷的弧线，剧情编剧会去调这一段的事件与因果，作者会去改
 * 措辞。不说清身份，四个阶段会得到同一种泛泛而谈的回答。
 */
export const STAGE_ROLE: Record<CreationStage, string> = {
  outline: '资深长篇小说策划编辑',
  volume: '分卷编剧',
  plot: '剧情编剧',
  manuscript: '资深中文长篇小说作者',
};

export function isCreationStage(value: unknown): value is CreationStage {
  return typeof value === 'string' && (CREATION_STAGES as string[]).includes(value);
}

// ---------------------------------------------------------------- Job

/**
 * 一件创作活。**六个值穷举了这套流水线上所有能让模型干的事。**
 *
 * 名字按「产出什么」取，不按「在哪一层干什么」取——因为落点是路径的事，
 * 而这个枚举要回答的是「产出什么形状的东西」。两件事分开之后，解析
 * （`features/artifact.ts`）与输出契约（`context/prompts.ts`）都只需要看这一个值。
 *
 * 六个里有两个是**拆出下一层的骨架**（`volumeList` / `plotSegment`），产出的
 * 是下一层的空壳而不是本层的内容——这正是从前 `split` 那个能力干的事。它只在
 * 大纲与卷纲上成立，剧情段已经是最小的规划单位（场景那一层早删了，见文件头），
 * 正文拆成章是工程动作而不是一次模型调用。
 *
 * `plotSegment` **一次只拆一段**：一次吐五段只会得到一串彼此没有因果的骨架，
 * 那正是「大纲直接拆章」的老毛病。一次一段时模型手上有卷纲、也知道这一卷排到
 * 哪了，「接下来该发生什么」才答得准。
 */
export type CreationJob =
  /** 写全书大纲。产出整篇 Markdown。 */
  | 'outline'
  /** 大纲 → 分卷清单。产出若干卷的空壳卷纲。 */
  | 'volumeList'
  /** 写某一卷的卷纲。产出整篇 Markdown。 */
  | 'volume'
  /** 卷纲 → **一个**剧情段。产出一份空壳细纲。 */
  | 'plotSegment'
  /** 写某一段的剧情细纲。产出四个小节。 */
  | 'plot'
  /** 写正文。 */
  | 'manuscript';

export const CREATION_JOBS: CreationJob[] = [
  'outline',
  'volumeList',
  'volume',
  'plotSegment',
  'plot',
  'manuscript',
];

/** 人话说法。日志、gate 卡片、工具返回共用这一份。 */
export const JOB_LABEL: Record<CreationJob, string> = {
  outline: '全书大纲',
  volumeList: '分卷清单',
  volume: '卷纲',
  plotSegment: '剧情段',
  plot: '剧情细纲',
  manuscript: '正文',
};

/** 一句话说清这件活干什么。工具描述与 gate 卡片吃它。 */
export const JOB_HINT: Record<CreationJob, string> = {
  outline: '写或改全书大纲：主线走向、分卷因果、冲突升级曲线、伏笔的埋与收',
  volumeList: '把大纲拆成若干卷，每卷是一条完整的中等弧线',
  volume: '写这一卷的卷纲：从什么局面开始、经过哪些事、收在什么局面上',
  plotSegment: '从这一卷的卷纲里拆出下一个剧情段。一次只拆一段',
  plot: '排这一段的剧情脉络：发生什么、因果怎么串、收在什么局面上',
  manuscript: '把已经定好的剧情写成正文',
};

export function isCreationJob(value: unknown): value is CreationJob {
  return typeof value === 'string' && (CREATION_JOBS as string[]).includes(value);
}

/**
 * 这件活属于哪一层。
 *
 * `stage` 仍然是个有用的概念，只是不再由调用方指定：它决定 AI 的身份
 * （`STAGE_ROLE`）、装配配方（`recipeFor`）以及在流水线条上的位置。
 *
 * 两处「拆」归**上一层**而不是产出所在的那一层：拆卷时模型的身份是策划编辑、
 * 手上要的是全书大纲那套上下文；拆段时是分卷编剧、要的是这一卷的卷纲。
 * 归到产出所在层的话，拆段会拿剧情层的配方去装配，而那份配方里根本没有卷纲。
 */
const JOB_STAGE: Record<CreationJob, CreationStage> = {
  outline: 'outline',
  volumeList: 'outline',
  volume: 'volume',
  plotSegment: 'volume',
  plot: 'plot',
  manuscript: 'manuscript',
};

export function stageOfJob(job: CreationJob): CreationStage {
  return JOB_STAGE[job];
}

/**
 * 「第 12 章《夜入青云》」——一章在界面、日志、上下文标签里的统一说法。
 *
 * **未命名的章只报序号。** 拆章时标题可能还没定（`007.md`），`listChapters`
 * 的标题回落链也会给出「第 7 章」；模板一套就成了「第 7 章《第 7 章》」——
 * 读起来像出了 bug。判据就是「标题恰好等于那个回落值」，因为那正是
 * 「没有标题」在数据里的样子。
 *
 * 细纲（`plots/`）与发布文件（`chapters/`）说的是同一章，所以只有这一个说法。
 * `plotLabel` 是它在细纲那一侧的别名，两者输出一字不差——留着别名是因为
 * 调用点分属两条取数路径，读代码时能看出手里拿的是哪一份。
 *
 * 住在这里而不是 plotFile.ts，是因为**这个模块零 import**：前端直接打包它
 * （见 media/src/protocol.ts），而 plotFile.ts 要 `node:path`，带进浏览器会炸。
 */
export function chapterLabel(order: number, title?: string): string {
  const named = title?.trim();
  return named && !isFallbackChapterTitle(order, named) ? `第 ${order} 章《${named}》` : `第 ${order} 章`;
}

/**
 * 这个标题就是「没有标题」在数据里的样子。
 *
 * 无标题的章（`009.md`）在 `listChapters` 的回落链里会拿到「第 9 章」——
 * 那不是作者起的名字，是没有名字。凡是要拿标题去**造东西**的地方都得先问一句：
 * 拿它拼细纲文件名会得到 `009-第-9-章.md`，一个假标题就此进了磁盘。
 */
export function isFallbackChapterTitle(order: number, title?: string): boolean {
  return (title?.trim() ?? '') === `第 ${order} 章`;
}

/** {@link chapterLabel} 在细纲那一侧的别名。输出完全一致。 */
export const plotLabel = chapterLabel;

/** 「第 2 卷《觉醒之日》」——一卷在界面、日志、上下文标签里的统一说法。 */
export function volumeLabel(no: number, title?: string): string {
  const named = title?.trim();
  return named ? `第 ${no} 卷《${named}》` : `第 ${no} 卷`;
}

/**
 * 「剧情 4《楼道》」——一个**还没拆成章**的剧情段在界面上的统一说法。
 *
 * 为什么不叫「第 4 章」：一个剧情段可以拆成三章。管理的单位是章，但**规划的
 * 单位是段**，两者不是一对一的，把段叫成章会在两处骗人——它会让作者以为
 * 「剧情 4」将来就是第 4 章，也会让「一段拆成三章」之后后面每一段的编号都
 * 对不上。
 *
 * 这里的 `no` 是 {@link segmentDisplayNo} 推出来的**位次**，不是文件名里的段号。
 */
export function segmentLabel(no: number, title?: string): string {
  const named = title?.trim();
  return named && !isFallbackChapterTitle(no, named) ? `剧情 ${no}《${named}》` : `剧情 ${no}`;
}

/**
 * 一个未拆分的剧情段显示成「剧情 几」。
 *
 * **位次而不是文件名里的段号**：`最新章号 + 在未拆分的段里排第几`（从 1 数）。
 *
 * 举例。拆出 5 段、一章都还没有：显示剧情 1~5。作者把第 1 段写完、拆成了 3 章
 * （第 1~3 章）：那一段从待做列表里消失，剩下 4 段接着往下数——剧情 4~7。
 * 老工程写了 99 章、现在开始规划：第一段就是剧情 100。
 *
 * 三条好处：编号永远接在已发布的正文后面（作者要的是「接下来写第几篇」）；
 * 一段拆成三章之后不必把后面几十份细纲**整体改名顺延**（从前正是那样做的，
 * 一次重命名风暴要连带搬走场景目录与中转站正文）；段号于是退回成一个纯粹的
 * 排序键，与章号彻底解耦。
 */
export function segmentDisplayNo(maxChapterNo: number, index: number): number {
  return Math.max(0, maxChapterNo) + index + 1;
}

// ---------------------------------------------------------------- Target

/**
 * 当前在改哪个产物。
 *
 * **一律用 `plotRelPath` 而不是章号**：号会撞（作者手改文件名时 `007-a.md` 与
 * `007-b.md` 并存是允许的），路径不会。这与摘要、正文、失败记录三处既有取舍
 * 完全一致。
 *
 * `manuscript` **没有第二个坐标**。从前它带一个可选的 `sceneNo`：给了就是
 * 「写这一场的正文」。场景那一层删掉之后（见文件头）正文只有一个落点——
 * 那一段在中转站里的一份文件。要分几次写就多点几次，每次追加在末尾。
 */
export type CreationTarget =
  | { kind: 'outline' }
  | { kind: 'volume'; volumeRelPath: string }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'manuscript'; plotRelPath: string };

/**
 * target 属于哪个阶段。两者不是同一件事：target 是名词，stage 是动词的所在层。
 *
 * 现在是恒等映射——`volume` 成为独立阶段之后，四种 target 与四个阶段一一对应。
 * 留着这个函数是因为调用点分属两条取数路径，读代码时能看出手里拿的是名词还是
 * 动词；也因为下一次多出一种「不自成阶段」的 target 时，改动只在这里。
 */
export function stageOfTarget(target: CreationTarget): CreationStage {
  return target.kind;
}

/** 该 target 归属的细纲路径；全书大纲与卷纲都没有归属段。 */
export function plotOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'plot' || target.kind === 'manuscript' ? target.plotRelPath : undefined;
}

/** 该 target 归属的卷纲路径；只有 `volume` 有。 */
export function volumeOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'volume' ? target.volumeRelPath : undefined;
}

/**
 * 稳定的字符串键。会话分组、前端 dataset、失败记录都用它，
 * 避免各处自己拼一份格式不同的 id。
 */
export function targetKey(target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return 'outline';
    case 'volume':
      return `volume:${target.volumeRelPath}`;
    case 'plot':
      return `plot:${target.plotRelPath}`;
    case 'manuscript':
      return `manuscript:${target.plotRelPath}`;
  }
}

export function isSameTarget(a: CreationTarget, b: CreationTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * 人类可读的位置描述，如「第 12 章《入宗风波》· 正文」。
 *
 * 后端生成、前端直接显示：文案只有一份，气泡里、历史页、日志里不会分叉。
 */
export function describeTarget(
  target: CreationTarget,
  info?: { no?: number; title?: string }
): string {
  if (target.kind === 'outline') {
    return '全书大纲';
  }
  if (target.kind === 'volume') {
    return info?.no !== undefined
      ? `${volumeLabel(info.no, info.title)} · 卷纲`
      : `${target.volumeRelPath} · 卷纲`;
  }
  const head = info?.no !== undefined ? plotLabel(info.no, info.title) : target.plotRelPath;
  return target.kind === 'plot' ? `${head} · 剧情` : `${head} · 正文`;
}

/**
 * 容错归一。认不出的一律回落到 `{ kind: 'outline' }`——它是唯一一个
 * 不依赖任何一章就一定存在的产物，因此是安全的落点。**绝不抛**：
 * 这条路上的输入来自会话 JSON（作者可能手改过）与前端消息。
 *
 * **老会话里的 `scene` 落到 `plot`**：那一层已经不存在了（见文件头），
 * 而它记着的 `plotRelPath` 仍然有效——落回那一段的剧情层，是作者接着往下做
 * 最可能要去的地方（正文层要么已经写了、要么该从剧情层出发）。`sceneNo`
 * 直接丢掉，它在新模型里没有任何落点。
 */
export function normalizeTarget(raw: unknown): CreationTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const plotRelPath = typeof o.plotRelPath === 'string' ? o.plotRelPath.trim() : '';
  const volumeRelPath = typeof o.volumeRelPath === 'string' ? o.volumeRelPath.trim() : '';

  switch (o.kind) {
    case 'volume':
      return volumeRelPath ? { kind: 'volume', volumeRelPath } : { kind: 'outline' };
    case 'plot':
    // 删掉的那一层：落回它所属那一段的剧情层。
    case 'scene':
      return plotRelPath ? { kind: 'plot', plotRelPath } : { kind: 'outline' };
    case 'manuscript':
      return plotRelPath ? { kind: 'manuscript', plotRelPath } : { kind: 'outline' };
    default:
      return { kind: 'outline' };
  }
}

// ---------------------------------------------------------------- 单章流水线状态

/**
 * 这一段当前该做哪一步。
 *
 * **全部由磁盘推导，不落盘**。存一个 `status: writing` 字段的话，作者手删
 * 半段正文之后它就在撒谎；而 `wordCount` 与 hash 永远诚实。这与
 * 「摘要新鲜度看 sourceHash 而不是看某个标记位」是同一个取舍。
 *
 * `split` 这一档是中转站带来的：正文写在 `manuscripts/`，作者标好断点之后
 * 才拆进 `chapters/`。拆分之前那一章还不算数——摘要要从发布文件生成，
 * 所以状态得停在这里等他动手。
 */
export type PlotStage = 'plot' | 'manuscript' | 'split' | 'review' | 'done';

export const PLOT_STAGE_LABEL: Record<PlotStage, string> = {
  plot: '待写剧情',
  manuscript: '待写正文',
  split: '待拆分',
  review: '待审阅',
  done: '已完成',
};

/**
 * 正文写到目标字数的这个比例就算写完了。
 *
 * **为什么要一个比例而不是「有字就算」**：一段正文分几次写是常态，
 * 而写了五百字就跳到「待拆分」会让状态机在最需要说话的时候闭嘴——作者要的
 * 恰恰是「这一段还没写够，接着写」。**为什么不是 1.0**：模型不会正好停在
 * 目标字数上，卡在 0.97 会让「待写正文」永远消不掉，而那是个假的待做项。
 *
 * 判据只在这里定义一次，`deriveStage` 与 `deriveProgress` 共用——两处各写
 * 一遍的话，界面上会出现「进度 100% 但徽章说待写正文」。
 */
export const MANUSCRIPT_DONE_RATIO = 0.8;

/** 推导所需的全部事实。取数在 core/views/pipeline.ts，判断在这里，便于单测。 */
export interface PipelineFacts {
  /** 细纲有实质内容（「剧情脉络」非空，不是一份只有目标的骨架）。 */
  plotFilled: boolean;
  /** 正文字数。中转站与发布文件取其一，见 `chapterExists`。 */
  words: number;
  /**
   * 这一段的目标字数（细纲 frontmatter 的 `targetWords`）。
   *
   * **没写就没有阈值可比**，那时「有字就算写完」——不拿一个猜出来的数字
   * 骗人（比如「一段总得有三千字」）。作者想要精确的判据，就去细纲里
   * 写一行 `targetWords`。
   */
  targetWords?: number;
  /**
   * 正文所依据的细纲已经变过（正文 frontmatter 的 `upstreamHash` 对不上）。
   *
   * 从前这一格叫 `beatsStale`，上游是那一段的**场景集合**。场景那一层删掉
   * 之后正文的上游就是细纲本身——改了剧情脉络，这一段的正文要回头看。
   */
  upstreamStale: boolean;
  /**
   * 这一章在 `chapters/` 里已经有文件了——也就是正文已经拆分（或本来就是
   * 老工程里手写的章）。
   *
   * 为什么要单独一个事实：中转站里有正文**不等于**这一章成立。摘要、角色卡、
   * 设定三条下游读的都是 `chapters/`，拆分之前它们无从读起。所以这一档卡在
   * 正文与审阅之间，而不是把「没拆分」混进 `manuscript` 里——混进去的话，
   * 界面会说「待写正文」，而正文明明已经写完了。
   */
  chapterExists: boolean;
  summaryExists: boolean;
  summaryStale: boolean;
  /**
   * 细纲 frontmatter 里的 `status: done`——作者手工宣布这一章过了。
   * **只允许向前覆盖**：推导说 done 时不接受被标成未完成，
   * 否则会出现「文件明明变了但界面说完成」。
   */
  markedDone: boolean;
}

export function emptyFacts(): PipelineFacts {
  return {
    plotFilled: false,
    words: 0,
    upstreamStale: false,
    chapterExists: false,
    summaryExists: false,
    summaryStale: true,
    markedDone: false,
  };
}

/**
 * 正文的完成度，0..1。判据只有一条，`deriveStage` 与 `deriveProgress` 共用。
 *
 * 目标字数缺席时退化成布尔（有字就是 1）——见 `PipelineFacts.targetWords`。
 */
export function manuscriptRatio(f: PipelineFacts): number {
  if (f.words <= 0) {
    return 0;
  }
  if (!f.targetWords || f.targetWords <= 0) {
    return 1;
  }
  return Math.min(1, f.words / (f.targetWords * MANUSCRIPT_DONE_RATIO));
}

/**
 * 当前阶段。
 *
 * **先看这一章成品在不在**（`chapters/` 里有没有文件），再谈生产链：
 * 生产链回答的是「怎么把这一章造出来」，成品已经在了就无从谈起。这条顺序
 * 是老工程能直接用的关键——写了 99 章、从没碰过本工具的书，99 行全是
 * 「已完成 / 待审阅」，不会被倒回去要求补细纲。
 *
 * 成品不在时判据自上而下取第一个不满足的：
 * 剧情没排 → 写剧情；剧情有了正文没写够（或细纲改过） → 写正文；
 * 正文写完还在中转站 → 拆分。
 */
export function deriveStage(f: PipelineFacts): PlotStage {
  if (f.chapterExists) {
    if (!f.summaryExists || f.summaryStale) {
      // 作者说过这一章过了就不再催审阅。
      return f.markedDone ? 'done' : 'review';
    }
    return 'done';
  }
  if (!f.plotFilled) {
    return 'plot';
  }
  if (manuscriptRatio(f) < 1 || f.upstreamStale) {
    return 'manuscript';
  }
  // 正文齐了但还躺在中转站里：作者得先标断点、拆成发布章节，
  // 摘要与三条支路读的都是 `chapters/`，拆分之前它们无从读起。
  return 'split';
}

export interface PipelineProgress {
  plot: number;
  manuscript: number;
  summary: number;
}

/**
 * 三段完成度，各自 0..1。工程页的徽章与创作页的流水线条直接渲染它。
 *
 * 正文那一段用比例而不是布尔，是因为设计要的是「正文 60%」这种粒度——
 * 「目标三千字、写了一千八」和「一个字都没写」不是一回事。
 *
 * 与 `deriveStage` 同一条顺序：**成品在就是造完了**，前两段一律满格。
 * 否则老工程的 99 章会显示成「进度 33%」——它们明明已经写完了，
 * 只是没经过这条流水线。
 */
export function deriveProgress(f: PipelineFacts): PipelineProgress {
  const summary = f.summaryExists && !f.summaryStale ? 1 : 0;
  if (f.chapterExists) {
    return { plot: 1, manuscript: 1, summary };
  }
  return { plot: f.plotFilled ? 1 : 0, manuscript: manuscriptRatio(f), summary };
}

// ---------------------------------------------------------------- 下一步

/**
 * 状态机算出来的「现在该干什么」。**agent 每回合的状态注入吃这一份。**
 *
 * 这是整套流水线在判断上的落点。四层产物、三段进度、⟳ 标记都只是**信息**；
 * 真正要的是一句「所以现在该做什么」。
 *
 * 从前这还兼着创作页那颗主按钮。按钮删掉之后**判据一个字都没变**——agent 与
 * 界面本来就共用同一份输出（第 20 条），少的只是那个入口。
 *
 * **与 `deriveStage` 共用同一套判据**，不另发明一套：那边算出停在哪一层，
 * 这边把那一层翻译成一个具体动作。两处如果各判各的，agent 就会说出
 * 「状态是待写正文，下一步去拆章节」这种自相矛盾的话。
 */
export interface NextStepPlan {
  /**
   * 这一步落在哪一层。
   *
   * 留着不是为了说给谁听，而是 `targetOf` 要拿它算落点——选中一章时
   * 「进入它当前该做的那一步」正是靠这个字段定的（见 `controller/chat.ts`
   * 的 `selectPlot`）。
   */
  stage: CreationStage;
  /** 一句话说清是哪一步，如「写正文」。 */
  label: string;
  /** 为什么是这一步。 */
  hint: string;
  /**
   * 这一步不是一次模型调用，而是一个工程动作。
   *
   * 有两处用得上：正文写完要拆成发布章节（`splitManuscript`），
   * 拆完要更新摘要（`summarizePlot`）。两者都是既有的工程动作，
   * 不该假装成一次生成。
   *
   * **agent 靠它知道该用 `run` 工具而不是 `generate`**（见
   * `agent/context.ts` 的 `describeNext`）。少了这一句，它会拿一次
   * 花钱的生成去干一件不花钱的活。
   */
  projectAction?: 'summarizePlot' | 'splitManuscript';
}

/**
 * 推导下一步所需的事实。
 *
 * 只有三格，而且都来自正文那一侧——从前还有「第一个没备素材的场景」与
 * 「第一个没写正文的场景」两条判据，那是场景层留下的。现在正文只有一个落点，
 * 要说的话只剩「还没开始 / 接着写 / 上游变了要重做」。
 */
export interface NextStepFacts {
  /** 正文字数。0 = 还没开始写。 */
  words: number;
  /** 正文写到目标字数的比例，`manuscriptRatio` 算出来的那一份。 */
  ratio: number;
  /** 细纲在正文写完之后改过。 */
  upstreamStale: boolean;
}

export function deriveNextStep(stage: PlotStage, f: NextStepFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'plot':
      return {
        stage: 'plot',
        label: JOB_LABEL.plot,
        hint: '先把这一段的剧情脉络排出来：发生什么、因果怎么串、收在什么局面上。',
      };

    case 'manuscript':
      // 细纲改过而正文没跟上：要的是拿新剧情重做一版，不是往后接着写。
      if (f.upstreamStale) {
        return {
          stage: 'manuscript',
          label: '重写正文',
          hint: '剧情改过，现有正文可能已经与它对不上。',
        };
      }
      // 写过一部分但还没写够：说清是「接着写」而不是「重新写一遍」——
      // 落盘走的是追加，不会丢掉前面那几千字。
      if (f.words > 0) {
        return {
          stage: 'manuscript',
          label: '接着写',
          hint: `这一段的正文写了 ${f.words} 字，还没写够（约 ${Math.round(f.ratio * 100)}%）。` +
            '接着往下写，新的一段会追加在末尾。',
        };
      }
      return {
        stage: 'manuscript',
        label: JOB_LABEL.manuscript,
        hint: '剧情已经定好了，这一步只负责把它写成小说。',
      };

    case 'split':
      return {
        // 停在正文层：拆分改的是正文的落点，要看的也是那份正文。
        stage: 'manuscript',
        projectAction: 'splitManuscript',
        label: '拆成章节',
        hint: '正文写好了。在编辑器里用单独一行 --- 标出断点，再拆成发布章节。',
      };

    case 'review':
      return {
        stage: 'manuscript',
        projectAction: 'summarizePlot',
        label: '总结这一章',
        hint: '正文齐了。摘要是后面几百章唯一能记住这些内容的东西。',
      };

    // 都做完了就不催。给一个「下一步」等于逼作者一直有事可做。
    case 'done':
      return undefined;
  }
}

// ---------------------------------------------------------------- 全书状态

/**
 * 整本书走到哪一步。与 `PlotStage` 同构，只是粒度是全书。
 *
 * 需要它是因为 `plots/` 是一条有序序列，而「还没有大纲」「有大纲但一卷都没拆」
 * 「有卷但一段都没拆」这三种状态不属于任何一段——从前这个判断手写在 controller
 * 里（`outlineNextStep`），判据落在 I/O 层就测不到，也没法与 `deriveStage`
 * 保持同一套写法。
 */
export type BookStage = 'outline' | 'volumes' | 'plots' | 'working';

export interface BookFacts {
  /** `outline.md` 去掉模板占位后有内容。 */
  outlineFilled: boolean;
  /** `volumes/` 里有卷纲。 */
  volumeCount: number;
  /**
   * 剧情段数**加上**已经发布的章数。
   *
   * 两者都要算：只有 `chapters/` 的老工程（写了 99 章、从没用过这个工具）
   * 一样是「已经在写了」，不该被叫回去从头拆。
   */
  plotCount: number;
}

/**
 * 判据自上而下取第一个不满足的：没大纲 → 写大纲；有大纲没卷 → 拆卷；
 * 有卷没段 → 拆段；有段（或已经有章）→ 交给按段的流水线。
 *
 * **`plotCount` 先判**：老工程一份卷纲都没有，但它写了 99 章——把它拉回
 * 「先把大纲拆成卷」是荒唐的。已发布的正文天生就算数（第 8 条）。
 */
export function deriveBookStage(f: BookFacts): BookStage {
  if (!f.outlineFilled) {
    return 'outline';
  }
  if (f.plotCount > 0) {
    return 'working';
  }
  return f.volumeCount === 0 ? 'volumes' : 'plots';
}

/**
 * 全书级的下一步。段已经有了就返回 undefined——那时该做什么由**选中的那一段**
 * 决定（`deriveNextStep`），而挑哪一段是作者的选择，不是系统能替他定的。
 *
 * `plots` 那一档要落在**某一卷**上，而挑哪一卷这里定不了（它是纯函数，手上
 * 没有卷列表）。调用方（controller）拿到这一步之后把 target 指向第一卷。
 */
export function deriveBookNextStep(stage: BookStage): NextStepPlan | undefined {
  switch (stage) {
    case 'outline':
      return {
        stage: 'outline',
        label: JOB_LABEL.outline,
        hint: '先定下这个故事讲什么。后面几层都从它展开。',
      };
    case 'volumes':
      return {
        stage: 'outline',
        label: JOB_LABEL.volumeList,
        hint: '把大纲切成几卷，每卷是一条完整的中等弧线，有自己的开局、升级与收束。',
      };
    case 'plots':
      return {
        // 落在卷纲层：拆段是从一卷的卷纲里拆，要看的也是那份卷纲。
        stage: 'volume',
        label: JOB_LABEL.plotSegment,
        hint: '从第一卷的卷纲里拆出第一个剧情段。一次只拆一段，接着往下写。',
      };
    case 'working':
      return undefined;
  }
}
