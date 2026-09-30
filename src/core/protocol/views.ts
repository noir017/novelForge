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
} from '../model/pipeline';
import type { ThinkingDepth } from '../model/thinking';
import type { ReviewReport } from '../model/review';
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
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProjectTree {
  initialized: boolean;
  title: string;
  author: string;
  /** 章节组的行数（每个出现过的章号一行）。 */
  plotCount: number;
  /** 已经有正文文件的章数。 */
  chapterCount: number;
  /** 已写正文的总字数。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 「故事架构」组的五行：架构四件 + 情节大纲。 */
  architecture: ArchitectureRow[];
  /** 章节组的全部行，一个章号一行，升序。 */
  plots: ProjectPlotNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  cast: CastEntry[];
  castByCard: Record<string, CastSummary>;
  summaryCount: number;
  failures: Record<string, FailureView[]>;
  castConflicts: CastConflictView[];
  plotsRoot: string;
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  globalSummaryThrough: number;
  styleGuidePath: string;
  outlinePath: string;
  globalSummaryPath: string;
  /** 全书走到哪一步（架构 / 大纲 / 细纲 / 在写 / 写完）。 */
  bookStage: BookStage;
  /** 下一个该写的章（从第 1 章起连续有正文的最大章号 + 1）。只有这一行给「写这一章」。 */
  nextChapterNo: number;
  /** 一句话、拆细纲两个弹窗的默认值（W4 / W5）。 */
  book: BookView;
}

/** 一句话弹窗的默认值。主按钮是「生成小说配置」时随下一步一起给。 */
export interface IdeaDefaults {
  /** `config.md` 里「一句话」那一节的原文。 */
  idea: string;
  totalChapters?: number;
  wordsPerChapter?: number;
  /** `config.md` 写过任何一节：弹窗据此写明「保留原文，追加生成」。 */
  configHasContent: boolean;
}

/** 工程页两个弹窗要的全书事实。 */
export interface BookView extends IdeaDefaults {
  /** 大纲覆盖到第几章。说不上（散文式大纲）或还没写时缺席——JSON 里放不下 Infinity。 */
  outlineCoverage?: number;
  /** 排好细纲的章号：拆细纲弹窗据此算这一段要跳过几章。 */
  plotFilledNos: number[];
}

/**
 * 「故事架构」组里的一行。
 *
 * `key` 是架构四件之一或 `outline`（情节大纲）。角色图谱那一行没有自己的文件，
 * `relPath` 给角色目录；点它是跳到「角色」那一组，不是打开文件。
 */
export interface ArchitectureRow {
  key: SettingDoc | 'outline';
  label: string;
  relPath: string;
  filled: boolean;
  /** 一句话副标题（「3 人」「覆盖到第 20 章」）。 */
  detail: string;
}

/**
 * 工程页「章节」组里的一行：**一个章号**。细纲号 = 章号，所以细纲与正文是同一行
 * 的两面，各自有没有、齐不齐都写在这一行上。
 *
 * 扁平列表，不折目录——顺序恰恰是这一层最要紧的信息，折进目录反而看不出来。
 * `chapters/` 下的分卷子目录因此不体现在这里（作者仍可以建，文件操作照常）。
 */
export interface ProjectPlotNode {
  /** 章号。 */
  no: number;
  /** 界面上那一行的完整说法（「第 12 章《夜访》」）。 */
  label: string;
  title: string;
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
  /** 摘要缺失或过期（只对有正文的章有意义）。 */
  stale: boolean;
  summaryPath: string;
  stage: PlotStage;
  progress: PipelineProgress;
  /** 细纲或正文的上游变过（⟳）。 */
  upstreamStale: boolean;
  /** 有草稿文件。只有正文才有草稿。 */
  hasDraft: boolean;
  draftPath: string;
}

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
  title: string;
  relPath: string;
  sections: WorkbenchSection[];
  warning?: string;
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

export interface PlotSummaryView {
  no: number;
  title: string;
  /** 浮窗标题里那一行（「第 12 章《夜访》」）。由后端给，文案只有一份。 */
  label: string;
  exists: boolean;
  stale: boolean;
  relPath: string;
  sections: { name: string; text: string }[];
  /**
   * 没有摘要时那句话。有正文是「还没定稿」（右键就能定稿），没有正文是
   * 「还没写」——对一章还没写的说「右键定稿」是在指一条走不通的路。
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
  targetWords?: number;
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
   * 没有段就是一块正文（单步创作那条路，没有工具可交替）。**旧会话在
   * `serializeTurn` 里已经归一过**，所以前端不必认第二种形状。
   */
  segments?: SerializedSegment[];
  /**
   * 仅 assistant 轮：这一轮 agent 跑下来的花销。气泡末尾那一行。
   *
   * **必须留在会话里**（第 4 条：不偷偷烧 token）：只在跑的时候闪一下，
   * 作者第二天回来翻这一轮就看不出它花了多少。
   */
  agentRun?: SerializedAgentRun;
}

/** 一轮 agent 的花销与结局。只够画一行，不够回放。 */
export interface SerializedAgentRun {
  steps: number;
  /** 花钱的调用次数（generate 与 run 的批量动作都记在这里）。 */
  calls: number;
  tokens: number;
  /** `done` 之外的都要在那一行上说清为什么停。 */
  stopReason: string;
  message?: string;
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
