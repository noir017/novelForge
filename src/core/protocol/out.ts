import type { DirListing } from '../files/fileTree';
import type { LogEntry } from '../runtime/logger';
import type { TaskSnapshot } from '../runtime/progress';
import type {
  EditorPane,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';
import type {
  PlotPipelineView,
  PlotSummaryView,
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
  /**
   * agent 循环开了新的一步。前端画一行「第 N 步」。
   *
   * 与 `runTask` 的进度条不冲突：那个说的是「这个长任务跑了多久」，
   * 这个说的是「它现在在做第几件事」。
   */
  | { type: 'agentStep'; turnId: string; step: number; message: string }
  /**
   * agent 要调一个工具了。前端在气泡里挂一条折叠条。
   *
   * `argsText` 是模型填的参数（JSON 文本，已截断）：展开那一条就能看到它这一步
   * 到底动的是哪个路径、搜的是哪个词。还没有结果，所以这时只有参数。
   */
  | {
      type: 'toolCall';
      turnId: string;
      callId: string;
      name: string;
      title?: string;
      detail?: string;
      argsText?: string;
    }
  /**
   * 工具跑完了。`summary` 是那一行上的**展示摘要**（几行、几处命中）。
   *
   * `argsText` / `resultText` 是展开后才画的明细，**都已截断**——工具的完整
   * 返回值可能是几万字，直接摊在气泡里会把作者要看的那段回答挤出屏幕。
   * 参数在这里再带一遍，是因为前端拿到结果时会整条重建那一行。
   */
  | {
      type: 'toolResult';
      turnId: string;
      callId: string;
      name: string;
      ok: boolean;
      summary: string;
      elapsedMs: number;
      argsText?: string;
      resultText?: string;
    }
  /** 一次 agent 循环结束。`message` 在非正常结束时说明为什么停。 */
  | {
      type: 'agentDone';
      turnId: string;
      stopReason: string;
      message: string;
      steps: number;
      calls: number;
      tokens: number;
    }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  | { type: 'summary'; summary: PlotSummaryView }
  | {
      type: 'pipeline';
      pipeline?: PlotPipelineView;
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
    }
  /**
   * 当前打开的工作区。独立版空窗口 `currentId` 为 null。
   * `recents` 给欢迎页；没有记忆时是空数组。
   */
  | {
      type: 'workspaces';
      currentId: string | null;
      items: WorkspaceItem[];
      recents: WorkspaceRecent[];
    }
  /** 本机一层目录的列举结果。失败不另造消息，原因写在 `error`。 */
  | {
      type: 'hostDir';
      path: string;
      parent?: string;
      entries: HostDirEntry[];
      truncated: number;
      error?: string;
      roots?: boolean;
    };

export interface WorkspaceItem {
  id: string;
  root: string;
  name: string;
}

export interface WorkspaceRecent {
  root: string;
  name: string;
}

export interface HostDirEntry {
  name: string;
  kind: 'dir' | 'file';
  absPath: string;
}

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
