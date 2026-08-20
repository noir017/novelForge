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
  /**
   * 创作页目标下拉框里的候选：已发布的章 + 还没交付的剧情段。
   *
   * `label` 由后端给（「第 12 章《夜访》」/「剧情 4《楼道》」）——两种行的说法
   * 完全不同，让前端按 `no` 自己拼会拼错一半（见 model/pipeline.ts 的
   * `segmentLabel`）。
   */
  plots: {
    kind: 'chapter' | 'segment';
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
  /** 卷数。工程页「卷」那一组的标题上那个数字。 */
  volumeCount: number;
  /** 还没交付的剧情段数。工程页「章节」组标题里那个「+N 剧情」。 */
  segmentCount: number;
  /** 章节组的行数（已发布的章 + 未交付的剧情段）。 */
  plotCount: number;
  /** 已发布的章数。 */
  chapterCount: number;
  /** 已写正文的总字数。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 全书分卷。**前端复用章节行组件**渲染它。 */
  volumes: ProjectVolumeNode[];
  /** 章节组的全部行：已发布的章在前，还没交付的剧情段在后。 */
  plots: ProjectPlotNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  cast: CastEntry[];
  castByCard: Record<string, CastSummary>;
  summaryCount: number;
  failures: Record<string, FailureView[]>;
  castConflicts: CastConflictView[];
  volumesRoot: string;
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
 * 工程页「卷」组里的一行。
 *
 * 前端复用章节行的组件渲染它（`buildPlotRow` 那一套：序号 + 名字 + 徽章 +
 * 右键菜单），所以字段刻意与 `ProjectPlotNode` 同形——同一个组件读两种数据时，
 * 字段对不上就得在前端写分支。
 */
export interface ProjectVolumeNode {
  no: number;
  title: string;
  /** 卷纲路径。这一行的身份。 */
  relPath: string;
  /** 这一卷收纳了几个剧情段（含已交付的）。 */
  segmentCount: number;
  /** 其中已经交付（拆成章）的有几个。 */
  deliveredCount: number;
  /** 这一卷的剧情段加起来多少字（成品优先，其次中转站）。 */
  wordCount: number;
  /** 卷纲有实质内容（「剧情走向」非空）。空壳的卷拆不出像样的段。 */
  filled: boolean;
  /** 生成这一卷之后，全书大纲改过。 */
  upstreamStale: boolean;
}

/**
 * 工程页「章节」组里的一行：**一个已发布的章，或一个还没交付的剧情段**。
 *
 * 扁平列表，不折目录——顺序恰恰是这一层最要紧的信息，折进目录反而看不出来。
 * `chapters/` 与 `plots/` 下的分卷子目录因此不体现在这里（作者仍可以建，
 * 文件操作照常）。
 *
 * 从前一行同时代表规划与成品（两者同号）。现在两者是两条轴：一段可以拆成三章，
 * 拆完那一段就不再是待做项，由它拆出来的几章各自成行。
 */
export interface ProjectPlotNode {
  /**
   * 这一行是什么。**界面上的说法完全不同**：章说「第 12 章」，段说「剧情 4」，
   * 而段还带阶段徽章与四段进度。
   */
  kind: 'chapter' | 'segment';
  /**
   * 序号：章的是章号，段的是**推导出来的位次**（最新章号 + 在未交付的段里排第几，
   * 见 model/pipeline.ts 的 `segmentDisplayNo`）——不是段的文件名前缀。
   */
  no: number;
  /** 界面上那一行的完整说法（「第 12 章《夜访》」/「剧情 4《楼道》」）。 */
  label: string;
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
  /** 细纲路径。已发布的章找不到它的来源段时是空串（老工程里每一章都是）。 */
  plotPath: string;
  /** 成品路径。剧情段行永远是空串。 */
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
 * **没有「章节节点」**：章节不在这棵树里——它与剧情段合成了 `ProjectPlotNode`
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
  /** 段号（文件名前缀）。只是 `plots/` 里的排序键，不是章号。 */
  no: number;
  /** 界面上那个「剧情 N」的 N：最新章号 + 在未交付的段里排第几。 */
  displayNo: number;
  title: string;
  plot: { relPath: string; exists: boolean; filled: boolean; upstreamStale: boolean };
  scenes: ScenePipelineView[];
  /** 中转站里等着拆分的正文。 */
  manuscript: { relPath: string; words: number; beatsStale: boolean };
  /** 这一段交付到的发布章。`relPath` 是第一章，`words` 是几章的总字数。 */
  chapter: { exists: boolean; relPath: string; words: number; chapterPaths: string[] };
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
  /**
   * 浮窗标题里那一行（「第 12 章《夜访》」/「剧情 4《楼道》」）。
   *
   * 由后端给：一行可能是已发布的章，也可能是还没交付的剧情段，两者的说法
   * 完全不同（见 model/pipeline.ts 的 `segmentLabel`）。前端按 `no` 自己拼
   * 会把每一个剧情段都叫成「第 N 章」。
   */
  label: string;
  exists: boolean;
  stale: boolean;
  relPath: string;
  sections: { name: string; text: string }[];
  /**
   * 没有摘要时那句话。
   *
   * 章与段的原因不同：章是「还没总结」（右键就能总结），段是「还没拆成章，
   * 摘要挂在成品上」——对段说「右键总结这一章」是在指一条走不通的路。
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
