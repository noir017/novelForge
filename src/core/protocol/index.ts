/**
 * 前端 ↔ 后端的消息协议（`InMessage` / `OutMessage` / `ViewState`），插件 webview 与独立版网页共用，是前后端的
 * 唯一契约。按需要的几对消息（「转到…」的索引、名词表、全书查找、叙事线总览、时间线总览）各有一份类型文件，
 * 都带请求号、不进 `ViewState`。
 */
export type {
  ChapterAction,
  CharacterAction,
  EditorFileCheck,
  EditorOpenIntent,
  EditorPane,
  FileAction,
  InMessage,
  ProjectAction,
  SendPayload,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';

export type {
  BookInspection,
  EditorCrumb,
  EditorFileLabel,
  EditorFileView,
  FileOpResult,
  HostDirEntry,
  OutMessage,
  SerializedModel,
  SerializedProvider,
  SkillInspectionView,
  SkillRow,
  SkillsView,
  VersionView,
  WorkspaceItem,
  WorkspaceRecent,
} from './out';

export type {
  ArchitectureRow,
  BookView,
  ChapterIndexEntry,
  IdeaDefaults,
  ThreadLineView,
  ThreadsView,
  ThreadUnfiledView,
  TimelineCalendarView,
  TimelineChapterView,
  TimelineGroupView,
  TimelineIssueView,
  TimelineSegmentView,
  CastConflictView,
  CastEntry,
  CastSummary,
  LoreSummary,
  LoreThinEntry,
  LoreUnfiledEntry,
  PlotPipelineView,
  PlotSummaryView,
  FailureView,
  NextStepView,
  ProjectPlotNode,
  ProjectDirNode,
  ProjectFile,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
  VolumeView,
  WriteLength,
  SerializedArtifact,
  SerializedDigest,
  SerializedSegment,
  SerializedSession,
  SerializedTurn,
  SerializedToolCall,
  SessionListItem,
  ViewState,
  WorkbenchSection,
  WorkbenchView,
} from './views';

export type {
  QuickOpenChapter,
  QuickOpenCharacter,
  QuickOpenDoc,
  QuickOpenDocKey,
  QuickOpenDraft,
  QuickOpenIndex,
  QuickOpenLore,
} from './quickOpen';

export type { CheckSensitiveTerm, CheckTermsView } from './check';
export type { NameEntry, NameIndex, NameSource } from './nameIndex';
export type {
  ThreadsOverview,
  ThreadsOverviewChapter,
  ThreadsOverviewChapterState,
  ThreadsOverviewCell,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewGroup,
  ThreadsOverviewLine,
  ThreadsOverviewSpan,
} from './threadsOverview';
export type {
  TimelineOverview,
  TimelineOverviewCard,
  TimelineOverviewDay,
  TimelineOverviewEvent,
  TimelineOverviewThread,
} from './timelineOverview';

export type {
  BookFindFile,
  BookFindHit,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookFindSkip,
  BookReplaceDone,
  BookReplaceFileRequest,
  BookReplaceRenamedCard,
  BookReplaceRequest,
  BookReplaceSkipReason,
  BookReplaceSkipped,
  BookReplaceSummary,
} from './bookFind';

export type {
  CheckpointDiffEntry,
  CheckpointDiffView,
  CheckpointFileStatus,
  CheckpointView,
  RestoreCheckpointRequest,
} from './checkpoints';

export type { LogEntry, LogLevel } from '../runtime/logger';
export type { TaskSnapshot } from '../runtime/progress';
export type { DirListing, FsEntry } from '../files/fileTree';
export type { ArtifactKind } from '../workspace/kind';
export type {
  BookStage,
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  NextStepFacts,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
  SettingDoc,
  StageCommand,
} from '../model/pipeline';

/** CSP 用的一次性 nonce。 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
