export type {
  CharacterAction,
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
  ProjectDirNode,
  ProjectFile,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
  ScenePipelineView,
  SerializedAgentRun,
  SerializedArtifact,
  SerializedDigest,
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
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  NextStepFacts,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
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
