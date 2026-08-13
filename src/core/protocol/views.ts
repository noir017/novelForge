import type {
  Capability,
  ChapterStage,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
} from '../model/pipeline';
import type { SerializedAttachment } from './in';

export interface ViewState {
  initialized: boolean;
  chapters: { order: number; title: string; wordCount: number; relPath: string }[];
  nextOrder: number;
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
  chapterCount: number;
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  chapters: ProjectNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  cast: CastEntry[];
  castByCard: Record<string, CastSummary>;
  summaryCount: number;
  failures: Record<string, FailureView[]>;
  castConflicts: CastConflictView[];
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  globalSummaryThrough: number;
  styleGuidePath: string;
  outlinePath: string;
  globalSummaryPath: string;
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

export interface ProjectChapter {
  order: number;
  title: string;
  relPath: string;
  wordCount: number;
  stale: boolean;
  summaryPath: string;
  draftPath: string;
  hasDraft: boolean;
  stage: ChapterStage;
  progress: PipelineProgress;
  upstreamStale: boolean;
}

export interface ChapterPipelineView {
  chapterRelPath: string;
  order: number;
  title: string;
  plan?: { relPath: string; filled: boolean; upstreamStale: boolean };
  scenes: ScenePipelineView[];
  manuscript: { words: number; beatsStale: boolean };
  summary: { exists: boolean; stale: boolean };
  stage: ChapterStage;
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
  order?: number;
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
  chapters: number[];
  detail: string;
}

export interface CastSummary {
  chapters: number[];
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

export interface ChapterSummaryView {
  order: number;
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
  targetOrder?: number;
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
