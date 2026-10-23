import type {
  BookStage,
  Capability,
  WriteLength,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
  SettingDoc,
  ThreadWatch,
} from '../model/pipeline';
import type { ThinkingDepth } from '../model/thinking';
import type { ContextDetail } from '../model/contextDetail';
import type { ReviewReport } from '../model/review';
import type { ParagraphStyle } from '../model/paragraphFormat';
import type { LoreThinKind } from '../model/loreFile';
import type { ThreadKind, ThreadStatus } from '../model/threadFile';
import type { SerializedAttachment } from './in';

export interface ViewState {
  initialized: boolean;
  /**
   * 创作页目标下拉框里的候选：**每个章号一行**（细纲号 = 章号）。
   *
   * `label` 由后端给（「第 12 章《夜访》」），`relPath` 是这一章细纲的路径
   * （还没有细纲时是它应该在的位置）——选中它就是「进入这一章」。
   */
  plots: {
    no: number;
    label: string;
    title: string;
    wordCount: number;
    relPath: string;
  }[];
  nextNo: number;
  staleCount: number;
  model: string;
  modelLabel: string;
  modelIssue?: string;
  models: { ref: string; label: string; group: string }[];
  /** 设置页上的上下文详细度：工程页批量表单上那个下拉框的缺省（表单只为这一次换，不改它）。 */
  contextDetail: ContextDetail;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 正文的分段格式（`config.md` 的 `paragraphStyle`，没写是 `blank`）。工程树里也有一份；这里再带一份，
   * 是因为工程树只在「工程」页签开着时才推，而内置编辑器的回车、标题栏「段落格式」的勾在哪个页签都要用。
   */
  paragraphStyle: ParagraphStyle;
}

export interface ProjectTree {
  initialized: boolean;
  /** 章节组的行数（每个出现过的章号一行）。 */
  plotCount: number;
  /** 已经有正文文件的章数。 */
  chapterCount: number;
  /** 已写正文的总字数。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 「故事架构」组的六行：架构五件 + 情节大纲。 */
  architecture: ArchitectureRow[];
  /** 章节组的全部行，一个章号一行，升序。 */
  plots: ProjectPlotNode[];
  /**
   * 「章节」页签的分卷（2026-10-23）：`chapters/` 下的一级目录，按卷里最小的章号排，还空着的卷排在最后。
   * 有章直接放在章节根下时多一段「未分卷」（`name` 是空串），照章号排在它该在的位置。
   * 一卷都没建是空数组——页签照旧一章一行平铺。
   */
  volumes: VolumeView[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  cast: CastEntry[];
  castByCard: Record<string, CastSummary>;
  /** 设定名录（views/lore.ts）：已建条目的出现章与待整合，按条目 relPath 索引。 */
  loreByEntry: Record<string, LoreSummary>;
  /** 定稿里出现过、还没有条目的名字，按出现章数降序。 */
  loreUnfiled: LoreUnfiledEntry[];
  /**
   * 待完善（完善设定，2026-10-19）：还没写的那几章细纲「设定」一节点名、却还没有条目或条目还只有一句话的设定，
   * 按最早要用到的章升序。
   */
  loreThin: LoreThinEntry[];
  /** 定稿过、但还没记过设定（细纲没有「设定」一节）的章数。 */
  loreUnrecorded: number;
  failures: Record<string, FailureView[]>;
  castConflicts: CastConflictView[];
  /** 章节区根目录（`chapters`）。「章节」组右键「新建卷…」建的卷目录落在这里。 */
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  globalSummaryThrough: number;
  styleGuidePath: string;
  globalSummaryPath: string;
  /** 叙事线目录（`threads/`，一条线一个文件）。排线失败的红 ❗ 挂在它上面（`failures` 按它索引）。 */
  threadsPath: string;
  /** 工程页「叙事线」页签：一条线一行，最后是「未归属的伏笔」（`views/threads.ts`）。 */
  threads: ThreadsView;
  /** 全书走到哪一步（架构 / 大纲 / 细纲 / 在写 / 写完）。 */
  bookStage: BookStage;
  /** 下一个该写的章（从第 1 章起连续有正文的最大章号 + 1）。只有这一行给「写这一章」。 */
  nextChapterNo: number;
  /**
   * 全书那一档的下一步（生成架构 / 情节大纲 / 拆细纲），与对话页主按钮在全书那一档给的
   * 同一步。工程页的空状态写「下一步：……」用它（W12）。在写、写完了时缺席。
   */
  next?: NextStepView;
  /** 一句话、拆细纲两个弹窗的默认值（W4 / W5）。 */
  book: BookView;
  /** 正文的分段格式（`config.md` 的 `paragraphStyle`）。总是有值，没写是 `blank`。 */
  paragraphStyle: ParagraphStyle;
}

/**
 * 工程页「叙事线」页签（叙事线重做第 8 个提交，`views/threads.ts` 现算）：一条线一行，按主线 → 支线 → 感情线 →
 * 人物线、同种类按最近一次推进排；最后一行是「未归属的伏笔」。状态一律按「现在」（`current`）算、不落盘（第 18 条）。
 */
export interface ThreadsView {
  /** 一条线一行，已经排好序。 */
  lines: ThreadLineView[];
  /** 「未归属的伏笔」那一行。文件里一条伏笔都没有（或没有这份文件）时缺席。 */
  unfiled?: ThreadUnfiledView;
  /** 定稿到的最后一章（定稿过的章里章号最大的；一章都没定稿是 0）。 */
  current: number;
  /**
   * 叙事线判到第几章（四期：`project.json` 的水位，从第 1 章起连续判过的，不超过 {@link current}）。线的状态（断了几章、伏笔逾期、
   * 过了计划收束章）按它算——定稿了还没判的章上线里本来就没有事件；写前提醒注「还没记上」的那几章也按它（前端批量写章弹窗）。
   */
  through: number;
  /**
   * 定稿过、叙事线还没判的章（四期）：工程页「⚠ 第 31–60 章还没判」（`text` 不带 ⚠，前端加）与「从已写正文补记」那一项。
   * 没有落后时缺席。
   */
  lag?: { count: number; text: string };
  /**
   * 写前检查的叙事线提醒要的数（二期）：前端批量写章弹窗拿它与要写的那几章算提醒（`threadRemindersFor`，与后端确认框同源）。
   * 按现在的样子算（不 asOf）。
   */
  watch: ThreadWatch;
}

/** 「叙事线」页签的一行：`林昭与沈青 · 感情线 · 进行中 · 最近第 12 章 · 2 条伏笔没收`，有问题的另加几个 ⚠。 */
export interface ThreadLineView {
  /** 线名（文件名就是线名）。 */
  name: string;
  /** 这条线的文件。点这一行打开它；当前进度作者改过的黄 ❗ 挂在它上面。 */
  relPath: string;
  kind: ThreadKind;
  status: ThreadStatus;
  /** 最近一次实际事件在第几章。 */
  lastActive?: number;
  /** 名字后面那一串：种类 · 状态 · 最近第 N 章（还没推进过写计划区间）· 几条伏笔没收。 */
  detail: string;
  /** 有问题的（不带 ⚠，前端加）：`断了 15 章`、`1 条伏笔逾期`、`过了计划收束的第 40 章`。 */
  warnings: string[];
  /** 鼠标移上去看的：意图与当前进度。 */
  tip: string;
}

/** 「未归属的伏笔 · N 条」那一行。 */
export interface ThreadUnfiledView {
  relPath: string;
  /** 一共几条伏笔。 */
  total: number;
  /** `4 条`，有收了的另写「几条没收」。 */
  detail: string;
  /** 同一条线那一行的 ⚠（只有「几条伏笔逾期」）。 */
  warnings: string[];
}

/** 一句话弹窗的默认值。主按钮是「生成小说配置」时随下一步一起给。 */
export interface IdeaDefaults {
  /** `config.md` 里「一句话」那一节的原文。 */
  idea: string;
  totalChapters?: number;
  wordsPerChapter?: number;
  /** `config.md` 写过任何一节：弹窗据此写明「保留原文，追加生成」。 */
  configHasContent: boolean;
  /** 第 1 章起连续有正文写到第几章。有就是照已写正文生成，那句话可以不写。 */
  writtenThrough?: number;
}

/** 工程页两个弹窗要的全书事实。 */
export interface BookView extends IdeaDefaults {
  /** 大纲覆盖到第几章。还没写（或一条章标题都认不出）时缺席。 */
  outlineCoverage?: number;
  /** 排好细纲的章号：拆细纲弹窗据此算这一段要跳过几章。 */
  plotFilledNos: number[];
}

/**
 * 「故事架构」组里的一行。
 *
 * `key` 是架构五件之一或 `outline`（情节大纲）。角色图谱、设定清单那两行没有自己的文件，
 * `relPath` 给角色目录 / 设定目录；点它是跳到「角色」/「设定」那一组，不是打开文件。
 */
export interface ArchitectureRow {
  key: SettingDoc | 'outline';
  label: string;
  relPath: string;
  filled: boolean;
  /** 一句话副标题（「3 人」「24 条」「覆盖到第 20 章」）。 */
  detail: string;
}

/**
 * 工程页「章节」组里的一行：**一个章号**。细纲号 = 章号，所以细纲与正文是同一行
 * 的两面，各自有没有、齐不齐都写在这一行上。
 *
 * 一行一章、按章号排——顺序恰恰是这一层最要紧的信息。分了卷的书（`chapters/` 下有一级目录）按卷分段画
 * （{@link ProjectTree.volumes}），卷里照旧按章号；卷里更深的子目录不体现在这里（作者仍可以建，文件操作照常）。
 */
export interface ProjectPlotNode {
  /** 章号。 */
  no: number;
  /** 界面上那一行的完整说法（「第 12 章《夜访》」）。 */
  label: string;
  title: string;
  /** 这一章在哪一卷（{@link VolumeView.name}）：有正文看正文，否则看细纲。直接放在章节根下是空串。 */
  volume: string;
  /**
   * 这一行的**主路径**：有正文就是正文，否则是细纲（还没有细纲时是它应该在的位置）。
   * 它是这一章在协议上的身份——`selectPlot` / 重命名 / 删除都拿它去认那一章。
   */
  relPath: string;
  /** 细纲路径。还没有细纲时是它**应该**在的位置（切到细纲层、写细纲都要一个落点）。 */
  plotPath: string;
  /** 细纲文件在不在。「打开细纲」只在它在的时候给。 */
  plotExists: boolean;
  /** 正文路径。还没有正文时是空串。 */
  chapterPath: string;
  wordCount: number;
  /** 目标字数（细纲的，或配置的每章字数）。都没有是 undefined。 */
  targetWords?: number;
  /** 有正文却还没定稿，或定稿之后正文又改过（只对有正文的章有意义）。 */
  stale: boolean;
  stage: PlotStage;
  progress: PipelineProgress;
  /** 细纲或正文的上游变过（⟳）。 */
  upstreamStale: boolean;
  /** 有草稿文件。只有正文才有草稿。 */
  hasDraft: boolean;
  draftPath: string;
}

/**
 * 「章节」页签上的一卷（2026-10-23）：`chapters/` 下的一个一级目录，细纲在 `summaries/` 下镜像同一个目录。
 * 卷只是收纳——章号全书连续，不按卷重排。
 */
export interface VolumeView {
  /** 卷名（目录名）。直接放在章节根下的那几章是空串，界面上叫「未分卷」。 */
  name: string;
  /** 卷目录（`chapters/第二卷`）；「未分卷」是章节根。卷标题右键「在此卷新建章节文件」的落点。 */
  relPath: string;
  /** 这一卷的第一章与最后一章（章号）。还空着的卷两个都缺席。 */
  from?: number;
  to?: number;
  /** 这一卷已写正文的字数。 */
  words: number;
  /** 接在最后新排的细纲、新建的章节文件默认落进这一卷（`NovelProject.subdirForNewChapter`）。最多一卷是 true。 */
  latest: boolean;
}

/**
 * 内置编辑器的章节索引里的一行（`chapterIndex` 消息）：工程树那一行里章节条与上一章 / 下一章要的那几个字段，
 * 由同一个函数算（`views/chapterIndex.ts`），两处说法一字不差。
 */
export type ChapterIndexEntry = Pick<
  ProjectPlotNode,
  'no' | 'label' | 'title' | 'relPath' | 'plotPath' | 'plotExists' | 'chapterPath' | 'wordCount' | 'targetWords' | 'stage'
>;

/**
 * 角色 / 设定两个区的树节点。
 *
 * **没有「章节节点」**：章节不在这棵树里——它与细纲合成了 `ProjectPlotNode`
 * 那一条扁平列表（见上）。这两个区仍是任意深度的目录树。
 */
export type ProjectNode = ProjectDirNode | ProjectFileNode;

export interface ProjectDirNode {
  kind: 'dir';
  label: string;
  relPath: string;
  children: ProjectNode[];
  fileCount: number;
}

export interface ProjectFileNode extends ProjectFile {
  kind: 'file';
}

export interface PlotPipelineView {
  plotRelPath: string;
  /** 章号。 */
  no: number;
  title: string;
  plot: { relPath: string; exists: boolean; filled: boolean; upstreamStale: boolean };
  /** 同号的正文。 */
  chapter: {
    exists: boolean;
    relPath: string;
    words: number;
    /** 目标字数。都没写就 undefined，那时「有字就算写够」。 */
    targetWords?: number;
    /** 写完正文之后，这一章的细纲改过。 */
    upstreamStale: boolean;
  };
  /** 定稿：`exists` = 细纲定稿过，`stale` = 没定稿过或定稿之后正文又改过。 */
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

export interface NextStepView extends NextStepPlan {
  target: CreationTarget;
  no?: number;
  /** `form: 'idea'` 时一句话弹窗的默认值。 */
  formDefaults?: IdeaDefaults;
}

export interface WorkbenchSection {
  key: string;
  text: string;
}

export interface WorkbenchView {
  stage: CreationStage;
  /** 浮窗标题（「正文 · 第 4 章《空匣》」「架构 · 故事前提」）。 */
  title: string;
  /**
   * 这一层叫什么（「正文」「细纲」「故事前提」「情节大纲」「设定条目」）。流水线条上的入口只写它——
   * 章名、文档名已经在上面那行面包屑上，入口再写一遍就是同一句话说两次。
   */
  layer: string;
  relPath: string;
  sections: WorkbenchSection[];
  warning?: string;
  /**
   * 不是出了问题、只是提个醒（完善设定三期 · 写前提醒）：正文目标上「本章要用的 天机阁 还只有一句话」。零调用、不拦，
   * 不进主按钮（第 20 条）。与 `warning`（上游变过，⟳）分开：两件事长得一样，作者就分不清哪个要紧。
   */
  notice?: string;
  empty?: string;
}

export interface ProjectFile {
  label: string;
  relPath: string;
  detail: string;
}

export interface CastEntry {
  name: string;
  aliases: string[];
  /** 出场章号。 */
  plots: number[];
  detail: string;
}

export interface CastSummary {
  /** 出场章号。 */
  plots: number[];
  detail: string;
  updatedThrough: number;
  pending: number;
}

/** 一条设定在定稿里的出现与落后（工程页设定行的副标题与 `＋N`）。 */
export interface LoreSummary {
  /** 定稿过的细纲「设定」一节点名它的章，升序。 */
  chapters: number[];
  /** `第 3–57 章 · 12 章`；一次都没出现是空串。 */
  detail: string;
  updatedThrough: number;
  /** 水位之后还有几章的新事实没整合。 */
  pending: number;
  /** 关键词（别称）。行上不显示，名录筛选框按它也能找到。 */
  keywords: string[];
}

/** 「出现过 · 未建条目」那一组的一行。 */
export interface LoreUnfiledEntry {
  name: string;
  /** 建议的分类（各章写的多数票），没写过是空串。 */
  category: string;
  chapters: number[];
  /** `5 章 · 第 3 章起`。 */
  detail: string;
}

/**
 * 「待完善」那一组的一行（完善设定，2026-10-19）。右键「展开…」：有条目发 `expandLore` 带 `relPath`，
 * 没有条目带 `name` 与 `category`（后端先按分类建空条目）。
 */
export interface LoreThinEntry {
  /** 有条目是条目的标题；没有是细纲「设定」一节里的写法。 */
  name: string;
  /** 有条目是条目所在的目录；没有是各章「设定」一节写的多数票。没有是空串。 */
  category: string;
  /** 条目路径；还没有条目时缺席。 */
  relPath?: string;
  /** 还没有条目 / 正文是空的 / 新建设定的占位 / 三节全是「（未交代）」。 */
  kind: 'missing' | LoreThinKind;
  /** 要用到它的章，升序。 */
  chapters: number[];
  /** `第 12 章起要用 · 只有一句话`。 */
  detail: string;
  /** 条目里有作者的字：「全部展开」跳过它（完善设定三期，`views/lore.ts` 的 `ThinLore.authored`）。 */
  authored?: true;
}

export interface FailureView {
  at: string;
  severity: 'error' | 'warn';
  message: string;
  detail?: string;
  /**
   * 哪个动作留下的（`summarize` / `cardState` …）。前端只拿它决定多给哪一项菜单：角色卡上挂着
   * `cardState`（定稿时作者改过的当前状态没被覆盖，D15）就多一项「对比…」。
   */
  op?: string;
}

export interface CastConflictView {
  name: string;
  kind: 'name' | 'alias';
  cards: { name: string; relPath: string }[];
}

/** 工程页悬停在章节行上时那只浮窗：这一章的细纲（计划，或定稿过的档案）。 */
export interface PlotSummaryView {
  no: number;
  title: string;
  /** 浮窗标题里那一行（「第 12 章《夜访》」）。由后端给，文案只有一份。 */
  label: string;
  /** 有这份细纲。 */
  exists: boolean;
  /** 定稿过（细纲照正文反向更新过）。没有就是计划。 */
  finalized: boolean;
  /** 定稿过、正文后来又改过。 */
  stale: boolean;
  relPath: string;
  sections: { name: string; text: string }[];
  /**
   * 没有细纲时那句话。有正文是「右键定稿可以照正文整理一份」，没有正文就只说没有——
   * 对一章还没写的说「右键定稿」是在指一条走不通的路。
   */
  emptyHint?: string;
}

export interface SerializedSession {
  id: string;
  title: string;
  target: CreationTarget;
  stage: CreationStage;
  capability: Capability;
  targetNo?: number;
  /** 这个会话让模型想多深。输入框旁那个下拉框回显它。 */
  thinking: ThinkingDepth;
  turns: SerializedTurn[];
}

export interface SerializedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  command?: string;
  attachments?: SerializedAttachment[];
  context?: SerializedDigest;
  /**
   * 仅 assistant 轮：这一轮发给模型的完整消息留在会话文件里，装配清单上画「复制完整上下文」。
   * 正文不随这里推（一轮几万字），点了再经 `copyContext` 要。
   */
  fullContext?: boolean;
  acceptedTo?: string;
  interrupted?: boolean;
  error?: string;
  reasoning?: string;
  artifact?: SerializedArtifact;
  /**
   * 仅 assistant 轮：审稿报告（五期 W10）。有它就画报告卡，不画那段可就地编辑的正文。
   * `picks` 是缺省勾选的条目（model/review.ts 的 `defaultPicks`）——与后端同一个算法，前端不另写。
   */
  review?: { report: ReviewReport; picks: string[]; notes?: string[]; calls?: number };
  /** 仅 user 轮：按审稿修稿时勾选的那几条（气泡上 `/按审稿修稿` 下面一条一行）。 */
  revise?: { items: string[] };
  /**
   * 仅 assistant 轮：这一轮**按发生顺序**排下来的段——它说的话与它做的事交替。
   *
   * 界面认的就是这一个字段：有段就按段画（文字块 / 工具条 / generate 卡交替），
   * 没有段就是一块正文（单步创作那条路，没有工具可交替）。
   */
  segments?: SerializedSegment[];
  /** 仅 assistant 轮：外部 agent 经 MCP 调工具留下的气泡。 */
  mcp?: boolean;
  /** 仅 assistant 轮：已经移除的内置 agent 留下的旧轮次，只留着回看（`isBuiltinAgentTurn`）。 */
  builtinAgent?: boolean;
}

/**
 * 一段。文字是模型自己说的话，工具是它做的一件事。
 *
 * 工具那一段把调用**整个带上**（而不是只给一个 callId 让前端去别处找）：
 * 前端照着数组画一遍就完了，不必再维护一张表。
 */
export type SerializedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: SerializedToolCall };

export interface SerializedToolCall {
  callId: string;
  name: string;
  title: string;
  ok: boolean;
  summary: string;
  elapsedMs: number;
  /** 模型填的参数（JSON 文本，已截断）。折叠条展开后画。 */
  argsText?: string;
  /** 回给模型的那段文本（已截断）。折叠条展开后画。 */
  resultText?: string;
  /**
   * 仅 `generate`：它这一次流出来的正文（已截断）。气泡里画成一张单独的卡片
   * ——那是作者要读的产物，不是一行流水账。
   */
  output?: string;
}

/**
 * 这一轮产出过什么、落到哪儿了。**只是回放用的记录**——写不写盘在产出的
 * 当下就问过了（`gate`），气泡上不再有任何能触发写入的按钮。
 */
export interface SerializedArtifact {
  where: string;
  summary: string;
  overwrites: boolean;
  /** 作者当时没同意写。写了的那一份记在 `acceptedTo` 上。 */
  declined?: boolean;
  /** 写入时会新建的角色卡（D19：细纲里的新角色直接建卡，卡片上先列出来）。 */
  creates?: string[];
  /** 写入时会新建的设定空条目（设定名录：细纲里本章首次引入的设定，同 D19；展开一条设定时建议拆出的子条目）。 */
  createsLore?: string[];
  /**
   * 细纲写入时会写进叙事线的计划（叙事线二期，同 D19：先列出来）：「叙事线计划：林昭与沈青 推进；埋〈玉佩的来历〉」，
   * 一批几章时一章一行；认不出是哪条线、没写进去的另起一行。已经排好了的几行字（features/threadPlan.ts 的 `describeThreadPlan`）。
   */
  threadPlan?: string[];
  /**
   * 落定设定（完善设定二期）会更新的已有条目（标题）。写入前逐条对比——卡片上先列出来，作者知道会弹几次对比。
   */
  updatesLore?: string[];
  /**
   * 展开一条设定时附的「还没定的问题」（完善设定，2026-10-19）。**只上卡片，不写进任何文件**：
   * 作者在对话里答完再展开一次。
   */
  questions?: string[];
  /** 生成这一路上的降级与说明（截断重来、拆半重试、漏字段……，第 2 条）。 */
  notes?: string[];
  /** 这一轮一共调了几次模型。 */
  calls?: number;
  /** 正文写了多长（W7）：这一章写完后的总字数、目标、这一次新写的、续写了几轮、够不够八成。 */
  length?: WriteLength;
  /** 正文开头与上一章结尾重合的那一段原文（重演）。卡片标红，写入要点两下。 */
  replay?: string;
  /** 正文是追加在这一章末尾（「接着写」），不是整章写入。 */
  append?: boolean;
}

export type { WriteLength };

export interface SerializedDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  /** 按哪一级上下文详细度装的（1–4）。旧会话没有，前端不显示。 */
  detail?: number;
  items: {
    id: string;
    label: string;
    kind: string;
    priority: number;
    tokens: number;
    status: string;
    note?: string;
    source?: string;
  }[];
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
  active: boolean;
}
