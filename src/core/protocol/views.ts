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
  /** 创作页目标下拉框里的候选：剧情段，不是发布章节。 */
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
  /** 剧情段数。工程页分组标题上那个数字。 */
  plotCount: number;
  /** 发布区的章节数。 */
  chapterCount: number;
  /** 已写正文的总字数（按剧情段算，不是按章节）。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 创作流水线那一组。 */
  plots: ProjectPlotNode[];
  /** 发布区，纯文件列表。 */
  chapters: ProjectNode[];
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
  /** 全书走到哪一步（还没大纲 / 还没拆段 / 已经在写）。主按钮吃它。 */
  bookStage: BookStage;
}

/**
 * 工程页「剧情」组里的一行。
 *
 * 扁平列表，不折目录——`plots/` 本身就是扁平的（分卷靠 frontmatter 的 `arc`），
 * 而流水线的顺序恰恰是这一层最要紧的信息，折进目录反而看不出来。
 */
export interface ProjectPlotNode {
  no: number;
  title: string;
  relPath: string;
  /** 这一段正文的字数。没写就是 0。 */
  wordCount: number;
  /** 摘要缺失或过期。 */
  stale: boolean;
  summaryPath: string;
  manuscriptPath: string;
  stage: PlotStage;
  progress: PipelineProgress;
  upstreamStale: boolean;
}

export type ProjectNode = ProjectDirNode | ProjectChapterNode | ProjectFileNode;

export interface ProjectDirNode {
  kind: 'dir';
  label: string;
  relPath: string;
  children: ProjectNode[];
  fileCount: number;
}

export interface ProjectChapterNode extends ProjectChapter {
  kind: 'chapter';
}

export interface ProjectFileNode extends ProjectFile {
  kind: 'file';
}

/**
 * 发布区的一章。
 *
 * **没有流水线字段**：章节是作者从 `manuscripts/` 切出来的成品，工具只提供
 * 文件操作（打开/改名/移动/删除/草稿），不分析内容、不生成摘要、不挂状态。
 */
export interface ProjectChapter {
  order: number;
  title: string;
  relPath: string;
  wordCount: number;
  draftPath: string;
  hasDraft: boolean;
}

export interface PlotPipelineView {
  plotRelPath: string;
  no: number;
  title: string;
  plot: { relPath: string; filled: boolean; upstreamStale: boolean };
  scenes: ScenePipelineView[];
  manuscript: { relPath: string; words: number; beatsStale: boolean };
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
  /** 出场段号。 */
  plots: number[];
  detail: string;
}

export interface CastSummary {
  /** 出场段号。 */
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
}

export interface SerializedArtifact {
  where: string;
  summary: string;
  overwrites: boolean;
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
