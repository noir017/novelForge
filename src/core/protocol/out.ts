import type { DirListing } from '../fileTree';
import type { LogEntry } from '../logger';
import type { TaskSnapshot } from '../progress';
import type {
  EditorPane,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';
import type {
  ChapterPipelineView,
  ChapterSummaryView,
  NextStepView,
  ProjectTree,
  SerializedDigest,
  SerializedSession,
  SerializedTurn,
  SessionListItem,
  ViewState,
  WorkbenchView,
} from './views';

/** 扩展 → Webview */
export type OutMessage =
  | { type: 'init'; state: ViewState }
  | { type: 'state'; state: ViewState }
  | { type: 'tab'; tab: Tab }
  | { type: 'session'; session: SerializedSession }
  | { type: 'sessions'; list: SessionListItem[] }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'reasoning'; turnId: string; text: string }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  | { type: 'summary'; summary: ChapterSummaryView }
  | {
      type: 'pipeline';
      pipeline?: ChapterPipelineView;
      next?: NextStepView;
      workbench: WorkbenchView;
    }
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  | { type: 'toast'; message: string; level: 'info' | 'error' }
  | { type: 'editorOpen'; file: EditorFileView; pane?: EditorPane }
  | { type: 'editorSaved'; file: EditorFileView }
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  | { type: 'editorError'; path: string; message: string }
  | { type: 'dirListings'; listings: DirListing[] }
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
  | { type: 'tasks'; tasks: TaskSnapshot[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'logHistory'; entries: LogEntry[]; exhausted: boolean }
  | {
      type: 'prompt';
      requestId: string;
      kind: 'input' | 'confirm' | 'pick';
      title: string;
      message?: string;
      placeholder?: string;
      value?: string;
      password?: boolean;
      multiline?: boolean;
      options?: string[];
    };

export interface SerializedProvider {
  id: string;
  label?: string;
  kind: 'openai' | 'anthropic' | 'vscode-lm';
  baseUrl?: string;
  models: SerializedModel[];
}

export interface SerializedModel {
  name: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface FileOpResult {
  from: string;
  to?: string;
  ok: boolean;
  error?: string;
}

export interface EditorFileView {
  path: string;
  name: string;
  text: string;
  hash: string;
  bytes: number;
  draftPath?: string;
}
