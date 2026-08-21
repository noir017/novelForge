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
  /**
   * 模型**自己说的话**的增量。前端追加到当前那一段文字上。
   *
   * 工具产出的正文不走这条（那是 `toolDelta`）：`generate` 内部那次调用会流出
   * 几千字产物，从前它和这一条挤在同一条通道里，于是「我先看看工程结构」和
   * 一份 6104 字的大纲拼在同一个文本节点里，谁也认不出边界在哪。
   */
  | { type: 'delta'; turnId: string; text: string }
  /**
   * 某个工具产出的正文增量（目前只有 `generate`）。前端追加到那一次调用的卡片里。
   *
   * 认 `callId` 而不认 turnId 就够了那一半：一轮里可能连着生成好几份，各自
   * 一张卡。
   */
  | { type: 'toolDelta'; turnId: string; callId: string; text: string }
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
  /**
   * 要动手了，等作者点头。**问在对话页里，不是一个盖住整个窗口的模态框。**
   *
   * 全局模态框把作者从他正在看的东西上拽走：他要判断的恰恰是「这一步动的是
   * 哪个文件」，而那串上下文就在被盖住的消息流里。所以这一条画成**输入框上方
   * 那一格里的一张卡片**——不跟着消息流滚（循环正卡在这一问上，一张会滚出视野
   * 的卡片等于没人看见），页面照常能滚、能翻、能点别的。
   *
   * `turnId` / `callId` 仍然带着：答完之后前端往那一轮的工具串（或产物正文
   * 下面）补一行「已跳过/已允许」当记录。
   *
   * **两种问法共用这一条**：agent 动手前的闸门（`agent/policy.ts`），以及
   * **产物落盘前那一句**（第 19 条，任何模式下都问）。两种都只有两颗按钮
   * ——**叫停整轮不在这张卡上**，那是输入框旁边那颗「停止」；与「这一个
   * 文件要不要动」是两件事，混进闸门只会被误当成「跳过」。
   *
   * `requestId` 是这次询问的身份（不是 `callId`：同一次调用在重连后会重发
   * 同一条询问，回答要认得出是哪一次）。按钮上的字一律由后端给，前端不写死
   * ——改一次文案两边就对不上。
   */
  | {
      type: 'gate';
      requestId: string;
      turnId: string;
      callId?: string;
      name: string;
      title: string;
      detail?: string;
      argsText?: string;
      proceed: string;
      skip: string;
    }
  /**
   * 那张卡片可以收了：作者在另一个视图上答了，或者这一轮被取消/结束了。
   *
   * 两个视图（侧边栏与编辑器标签页）挂的是同一个 controller，只在被点的那
   * 一边收卡片的话，另一边会留着一张点了没反应的卡。
   */
  | { type: 'gateDone'; requestId: string; verdict: 'proceed' | 'skip' | 'cancelled' }
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
  kind: 'openai' | 'openai-responses' | 'anthropic' | 'vscode-lm';
  baseUrl?: string;
  /** 只有 `kind: 'openai'` 用得上：这个网关的思考字段是哪一套。 */
  thinkingStyle?: string;
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
