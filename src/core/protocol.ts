/** Webview ↔ 扩展 的消息协议。两个宿主（侧边栏 / 编辑器面板）共用。 */

export type Tab = 'chat' | 'project' | 'history' | 'settings';

export interface SendPayload {
  text: string;
  mode: 'write' | 'discuss';
  targetOrder: number;
  targetWords: number;
  attachments: SerializedAttachment[];
  excludedIds: string[];
}

export interface SerializedAttachment {
  id: string;
  kind: string;
  label: string;
  relPath?: string;
  range?: { start: number; end: number };
  text?: string;
}

/** Webview → 扩展 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  | { type: 'accept'; turnId: string; mode: 'append' | 'new'; order: number; title: string; text: string }
  | { type: 'editTurn'; turnId: string; text: string }
  | { type: 'deleteTurn'; turnId: string }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  | { type: 'addSelection' }
  | { type: 'openFile'; path: string }
  /**
   * 在内置编辑器里打开一个文本文件（仅独立版；插件壳收到会转成 openFile）。
   * 与 `openFile` 分开是为了让「点章节名」在两个壳里各自做对的事：
   * 插件开 VS Code 的 tab，独立版开自己的编辑器。
   */
  | { type: 'openEditor'; path: string }
  /** 保存编辑器里的内容。`baseHash` 为空表示用户已确认强制覆盖。 */
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  /** 重新从磁盘读一份（放弃本地修改 / 冲突后取磁盘版）。 */
  | { type: 'reloadFile'; path: string }
  /** 用系统默认程序打开（编辑器里「在外部打开」）。 */
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  /** `dir` 为新建类动作指定落点目录（工作区相对路径），缺省落在该区的根目录。 */
  | { type: 'projectAction'; action: ProjectAction; order?: number; dir?: string }
  /** 工程页的类文件操作。`relPath` 是操作对象（文件或目录）。 */
  | { type: 'fileAction'; action: FileAction; relPath: string; targetDir?: string }
  | { type: 'selectModel'; ref: string }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  | { type: 'testConnection'; ref?: string }
  | { type: 'openNativeSettings' }
  /** 网页弹窗的回执（仅独立版：host.input/confirm/pick 经 WebSocket 变成 modal）。 */
  | { type: 'promptResult'; requestId: string; value?: string };

/**
 * 工程页上可触发的动作。全部走命令，webview 只负责说「点了什么」。
 * `order` 只有章节相关的动作会带。
 */
export type ProjectAction =
  | 'initProject'
  | 'refresh'
  | 'newChapter'
  | 'newCharacter'
  | 'newLore'
  | 'newFolder'
  | 'continueFrom'
  | 'summarizeChapter'
  | 'syncSummaries'
  | 'rebuildGlobalSummary'
  | 'extractCharacters'
  | 'extractStyle';

/**
 * 类文件操作。作用对象由 `relPath` 给出，可以是文件也可以是目录。
 * `move` 另需 `targetDir`（工作区相对路径，空串表示所属区的根目录）。
 */
export type FileAction = 'rename' | 'move' | 'delete';

/** 设置页提交的全部内容。服务商列表整体替换。 */
export interface SettingsPayload {
  providers: SerializedProvider[];
  /** 当前模型引用，形如 `glm/glm-4-plus`。 */
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  recentChaptersFullText: number;
  prevChapterTailChars: number;
  summaryBatchSize: number;
  requestTimeoutMs: number;
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

/** 扩展 → Webview */
export type OutMessage =
  | { type: 'init'; state: ViewState }
  | { type: 'state'; state: ViewState }
  | { type: 'tab'; tab: Tab }
  | { type: 'session'; session: SerializedSession }
  | { type: 'sessions'; list: SessionListItem[] }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  /**
   * `ack` 标明这次推送是不是某次保存的回执：
   * `saved` 表示已落盘（前端可放心以磁盘为准），`rejected` 表示被拒
   * （前端必须保住用户的编辑）。普通刷新不带 ack。
   */
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  | { type: 'toast'; message: string; level: 'info' | 'error' }
  /** 内置编辑器：打开/重载一份文件（仅独立版）。 */
  | { type: 'editorOpen'; file: EditorFileView }
  /** 内置编辑器：保存成功，带回新的 hash 基线。 */
  | { type: 'editorSaved'; file: EditorFileView }
  /** 内置编辑器：磁盘上已被改过，保存被拒。前端展示取舍界面，绝不静默覆盖。 */
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  /** 内置编辑器：打开/保存失败（越界、扩展名不符、过大等）。 */
  | { type: 'editorError'; path: string; message: string }
  /** 要求前端弹一个 modal（仅独立版）。用户提交后回 `promptResult`。 */
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

/** 内置编辑器里一份文件的快照（core/fileEditing.ts 的 EditorFile 的线上形状）。 */
export interface EditorFileView {
  /** 工程内相对路径（正斜杠）。同时是前端标签页的 key。 */
  path: string;
  name: string;
  text: string;
  /** 保存时回传的乐观锁基线。 */
  hash: string;
  bytes: number;
}

export interface ViewState {
  initialized: boolean;
  chapters: { order: number; title: string; wordCount: number }[];
  nextOrder: number;
  staleCount: number;
  /** 当前模型引用；未配置好时为空串。 */
  model: string;
  /** 当前模型的展示名，如「智谱 GLM · glm-4-plus」。 */
  modelLabel: string;
  /** 模型引用无效时的说明，直接显示在输入框下方。 */
  modelIssue?: string;
  /** 下拉框用的全部可选模型。 */
  models: { ref: string; label: string; group: string }[];
  contextWindow: number;
  maxOutputTokens: number;
  /** 独立 Web 服务版：前端据此隐藏「在 VS Code 设置中打开」并改存储提示文案。 */
  standalone?: boolean;
}

/**
 * 工程页的全部内容。一次性推完——这些数据量很小（几十到几百行），
 * 分层懒加载换来的那点开销不值得让 webview 维护展开状态与请求往返。
 *
 * 三个区（章节/角色/设定）都是**任意深度的目录树**：`chapters` / `characters`
 * / `lore` 是各区根目录下的直接子节点，目录节点自带 `children`。
 * 展开/折叠状态仍然完全留在前端，按 relPath 记住。
 */
export interface ProjectTree {
  initialized: boolean;
  title: string;
  author: string;
  chapterCount: number;
  totalWords: number;
  staleCount: number;
  chapters: ProjectNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  /** 各区的根目录相对路径，供「在此新建」与「移动到根」用。 */
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  /** 全书摘要覆盖到第几章；0 表示还没生成。 */
  globalSummaryThrough: number;
  styleGuidePath: string;
  outlinePath: string;
  globalSummaryPath: string;
}

/**
 * 树上的一个节点：目录、章节，或角色/设定文件。
 * 目录节点只有 `label` / `relPath` / `children`；文件节点按 kind 带各自的字段。
 */
export type ProjectNode = ProjectDirNode | ProjectChapterNode | ProjectFileNode;

export interface ProjectDirNode {
  kind: 'dir';
  label: string;
  relPath: string;
  children: ProjectNode[];
  /** 子树里的文件数（含各级子目录），用于目录行的副标题。 */
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
  /** 摘要缺失或过期。 */
  stale: boolean;
  /** 摘要文件路径；没生成过则为空。 */
  summaryPath: string;
}

export interface ProjectFile {
  label: string;
  relPath: string;
  /** 副标题，如角色别名、设定关键词。 */
  detail: string;
}

export interface SerializedSession {
  id: string;
  title: string;
  targetOrder?: number;
  targetWords?: number;
  turns: SerializedTurn[];
}

export interface SerializedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  attachments?: SerializedAttachment[];
  context?: SerializedDigest;
  acceptedTo?: string;
  interrupted?: boolean;
  error?: string;
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

/** CSP 用的一次性 nonce。 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
