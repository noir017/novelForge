export type {
  CharacterAction,
  EditorPane,
  FileAction,
  InMessage,
  ProjectAction,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';

export type {
  EditorFileView,
  FileOpResult,
  HostDirEntry,
  OutMessage,
  SerializedModel,
  SerializedProvider,
  WorkspaceItem,
  WorkspaceRecent,
} from './out';

export type {
  CastConflictView,
  CastEntry,
  CastSummary,
  PlotPipelineView,
  PlotSummaryView,
  FailureView,
  NextStepView,
  ProjectPlotNode,
  ProjectVolumeNode,
  ProjectDirNode,
  ProjectFile,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
  SerializedAgentRun,
  SerializedArtifact,
  SerializedSegment,
  SerializedSession,
  SerializedTurn,
  SerializedToolCall,
  SessionListItem,
  ViewState,
  WorkbenchSection,
  WorkbenchView,
} from './views';

export type { LogEntry, LogLevel } from '../runtime/logger';
export type { TaskSnapshot } from '../runtime/progress';
export type { DirListing, FsEntry } from '../files/fileTree';
export type {
  BookStage,
  CreationJob,
  CreationStage,
  CreationTarget,
  NextStepFacts,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
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
