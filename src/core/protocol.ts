/** Webview ↔ 扩展 的消息协议。两个宿主（侧边栏 / 编辑器面板）共用。 */

import { LogEntry } from './logger';
import { TaskSnapshot } from './progress';

export type Tab = 'chat' | 'project' | 'history' | 'settings' | 'logs';

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

/**
 * 独立版的两块编辑区：主区放正文，草稿区放草稿，左右并列。
 * 缺省 `main`——插件壳与旧消息都当主区处理。
 */
export type EditorPane = 'main' | 'draft';

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
   *
   * `pane` 只有独立版用得上：刷新后恢复标签页时要说清楚开在哪一块。
   */
  | { type: 'openEditor'; path: string; pane?: EditorPane }
  /**
   * 打开某章的草稿。`path` 是**章节**的工作区相对路径，草稿路径由后端推导。
   *
   * 首次点击时按需创建（已存在则原样打开，绝不覆盖）；
   * 独立版开在第二块编辑区，插件壳开在正文旁边一栏。
   */
  | { type: 'openDraft'; path: string }
  /** 保存编辑器里的内容。`baseHash` 为空表示用户已确认强制覆盖。 */
  | { type: 'saveFile'; path: string; text: string; baseHash?: string }
  /** 重新从磁盘读一份（放弃本地修改 / 冲突后取磁盘版）。 */
  | { type: 'reloadFile'; path: string }
  /** 用系统默认程序打开（编辑器里「在外部打开」）。 */
  | { type: 'openExternal'; path: string }
  | { type: 'syncSummaries' }
  /** `dir` 为新建类动作指定落点目录（工作区相对路径），缺省落在该区的根目录。 */
  | { type: 'projectAction'; action: ProjectAction; order?: number; dir?: string }
  /**
   * 角色卡动作。`name` 是角色名（未建卡的人物只有名字）；
   * `relPath` 在更新已有卡时给出，指向那张卡。
   */
  | { type: 'characterAction'; action: CharacterAction; name: string; relPath?: string }
  /** 工程页的类文件操作。`relPath` 是操作对象（文件或目录）。 */
  | { type: 'fileAction'; action: FileAction; relPath: string; targetDir?: string }
  | { type: 'selectModel'; ref: string }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  /**
   * 测试某个模型能不能用。
   *
   * `provider` 是设置页当前**屏幕上**的那份服务商配置（可能还没保存）。
   * 带上它，测试就测所见即所得的这一份——刚加的模型、刚改的 baseUrl
   * 不必先保存也能验。留空则退回已保存的配置。
   */
  | { type: 'testConnection'; ref?: string; provider?: SerializedProvider }
  | { type: 'openNativeSettings' }
  /** 取消一个正在跑的长任务（进度条上的「停止」）。 */
  | { type: 'cancelTask'; id: string }
  /** 日志页：要一份缓冲全量（切到该页 / 点刷新时发）。 */
  | { type: 'requestLogs' }
  /** 日志页：清空缓冲。 */
  | { type: 'clearLogs' }
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
 * 角色相关的动作。与 `projectAction` 分开是因为它们的作用对象是**一个角色**
 * （用名字标识），而不是一个文件或一个章节。
 *
 * - `updateCard` / `rebuildCard`：更新已有角色卡。前者只读上次更新之后的新章节
 *   （增量），后者从头通读该角色的全部出场章节。`relPath` 指向那张卡。
 * - `createCard`：给摘要里出现但还没建卡的人物建一张卡，并立刻用它的出场章节
 *   跑一次提取。`name` 是摘要里的名字。
 */
export type CharacterAction = 'updateCard' | 'rebuildCard' | 'createCard';

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
  /** 推理模型的思考增量。前端折叠显示，不计入正文。 */
  | { type: 'reasoning'; turnId: string; text: string }
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
  /**
   * 内置编辑器：打开/重载一份文件（仅独立版）。
   * `pane` 指明开在哪一块编辑区，缺省主区。
   */
  | { type: 'editorOpen'; file: EditorFileView; pane?: EditorPane }
  /** 内置编辑器：保存成功，带回新的 hash 基线。 */
  | { type: 'editorSaved'; file: EditorFileView }
  /** 内置编辑器：磁盘上已被改过，保存被拒。前端展示取舍界面，绝不静默覆盖。 */
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  /** 内置编辑器：打开/保存失败（越界、扩展名不符、过大等）。 */
  | { type: 'editorError'; path: string; message: string }
  /**
   * 正在跑的长任务快照，全量替换。
   *
   * 任何变化（新增/进度/结束）都重推整份——列表最多两三项，
   * 增量协议换来的那点带宽不值得让前端维护一份可能对不上的副本。
   */
  | { type: 'tasks'; tasks: TaskSnapshot[] }
  /** 日志：增量一条（实时追加），或全量一批（日志页首次加载/清空后）。 */
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
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
  /**
   * 这份文件是某一章的正文时，给出它草稿的相对路径（文件不一定已存在）。
   * 前端据此决定要不要显示工具栏上的「草稿」按钮，不必自己复刻章节判定规则。
   */
  draftPath?: string;
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
  /**
   * 摘要已是最新的章节数。`staleCount + summarizedCount === chapterCount`。
   *
   * 与 staleCount 一起给，前端才画得出「已完成 N/M」的进度条——
   * 只有 staleCount 时，用户看到「76 章待总结」不知道分母是多少，
   * 同步跑到一半也说不清还剩几章。
   */
  summarizedCount: number;
  chapters: ProjectNode[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  /**
   * 摘要里出现、但还没有角色卡的人物，按出场章数降序。
   *
   * 与 `characters` 分开而不是混在一起：那棵树是**文件树**（能重命名、移动、
   * 删除），这些人还没有文件。混进去会让右键菜单上的「删除」无从谈起。
   */
  cast: CastEntry[];
  /**
   * 已建卡角色的出场统计，按角色卡的 relPath 索引。
   * 前端据此给角色行加「出场 12 章」的副标题，不必自己去翻摘要。
   */
  castByCard: Record<string, CastSummary>;
  /** 参与统计的摘要数。为 0 说明还没生成过摘要，前端据此改文案。 */
  summaryCount: number;
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
  /** 这一章草稿的工作区相对路径；不在章节根下时为空串。文件不一定已存在。 */
  draftPath: string;
  /** 草稿文件已经存在。决定菜单文案（打开草稿 / 新建草稿）与行上的标记。 */
  hasDraft: boolean;
}

export interface ProjectFile {
  label: string;
  relPath: string;
  /** 副标题，如角色别名、设定关键词。 */
  detail: string;
}

/** 摘要里出现、尚未建卡的一位人物。 */
export interface CastEntry {
  name: string;
  /** 摘要里见过的其它称呼。 */
  aliases: string[];
  /** 出场章节序号，升序。 */
  chapters: number[];
  /** 人类可读的出场描述，如「第 3、7、12 章」。后端生成，两处文案不会分叉。 */
  detail: string;
}

/** 一位已建卡角色的出场统计。 */
export interface CastSummary {
  chapters: number[];
  detail: string;
  /** 上次更新角色卡时读到第几章；0 表示从未更新过。 */
  updatedThrough: number;
  /** 上次更新之后新增的出场章节数。>0 时前端在行上给个提示点。 */
  pending: number;
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
  /** 推理模型的思考过程。折叠展示，不属于正文，采纳时不写入章节。 */
  reasoning?: string;
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

/** 日志与任务的形状定义在各自模块里，这里转出去供前端与壳统一从协议引用。 */
export type { LogEntry, LogLevel } from './logger';
export type { TaskSnapshot } from './progress';

/** CSP 用的一次性 nonce。 */
export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
