import type {
  BookStage,
  Capability,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
} from '../model/pipeline';
import type { SerializedAttachment } from './in';

export interface ViewState {
  initialized: boolean;
  /** 创作页目标下拉框里的候选：全书各章。 */
  plots: { no: number; title: string; wordCount: number; relPath: string }[];
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
  /** 章数（规划的与写完的合起来去重）。工程页分组标题上那个数字。 */
  plotCount: number;
  /** 已经拆分发布的章数。 */
  chapterCount: number;
  /** 已写正文的总字数。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 全书各章。**一条列表**——规划与成品是同一章的两副面孔。 */
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
  /** 全书走到哪一步（还没大纲 / 还没规划章节 / 已经在写）。主按钮吃它。 */
  bookStage: BookStage;
}

/**
 * 工程页「章节」组里的一行。
 *
 * 扁平列表，不折目录——流水线的顺序恰恰是这一层最要紧的信息，折进目录反而
 * 看不出来。`chapters/` 下的分卷子目录因此不体现在这里（作者仍可以建，
 * 文件操作照常）。
 *
 * 一行可能只有规划（还没写完）、只有成品（老工程里的章），或两者都有。
 */
export interface ProjectPlotNode {
  no: number;
  title: string;
  /**
   * 这一行的**主路径**：有成品就是成品，否则是细纲。它是这一章在协议上的
   * 身份——`selectPlot` / `setTarget` / 重命名 / 删除都拿它去认那一章。
   *
   * **不是「点行打开哪份文件」**：那件事前端按 成品 → 待拆分的正文 → 细纲
   * 挑（见 view/project/rows.ts 的 `openTargetOf`），因为主路径漏掉了
   * 「正文写完、还没拆成章节」那一档。
   */
  relPath: string;
  /** 细纲路径。这一章还没规划过（老工程）时是空串。 */
  plotPath: string;
  /** 成品路径。还没拆分时是空串。 */
  chapterPath: string;
  /** 中转站里等着拆分的正文路径。没有就是空串。 */
  manuscriptPath: string;
  /** 这一章的字数。成品优先，其次是中转站里那份。 */
  wordCount: number;
  /** 摘要缺失或过期。 */
  stale: boolean;
  summaryPath: string;
  stage: PlotStage;
  progress: PipelineProgress;
  upstreamStale: boolean;
  /** 有草稿文件。只有成品才有草稿。 */
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
  no: number;
  title: string;
  plot: { relPath: string; exists: boolean; filled: boolean; upstreamStale: boolean };
  scenes: ScenePipelineView[];
  /** 中转站里等着拆分的正文。 */
  manuscript: { relPath: string; words: number; beatsStale: boolean };
  /** 发布区里的成品。拆分之后才有。 */
  chapter: { exists: boolean; relPath: string; words: number };
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

export interface ScenePipelineView {
  no: number;
  title: string;
  relPath: string;
  detail: string;
  status: 'draft' | 'ready' | 'written';
  ready: boolean;
  upstreamStale: boolean;
}

export interface NextStepView extends NextStepPlan {
  target: CreationTarget;
  no?: number;
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
}

export interface CastConflictView {
  name: string;
  kind: 'name' | 'alias';
  cards: { name: string; relPath: string }[];
}

export interface PlotSummaryView {
  no: number;
  title: string;
  exists: boolean;
  stale: boolean;
  relPath: string;
  sections: { name: string; text: string }[];
}

export interface SerializedSession {
  id: string;
  title: string;
  target: CreationTarget;
  stage: CreationStage;
  capability: Capability;
  targetNo?: number;
  targetWords?: number;
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
   * 仅 assistant 轮：这一轮 agent 调过的工具。重开面板要能把那串折叠条画回来。
   *
   * 那一行上只有摘要；参数与返回文本在**展开之后**才画，且都是截断过的
   * ——完整返回值可能是几万字，摊在气泡里会把回答挤出屏幕。
   */
  toolCalls?: SerializedToolCall[];
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
}

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
