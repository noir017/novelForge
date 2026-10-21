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
