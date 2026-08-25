import type { DirListing } from '../files/fileTree';
import type { LogEntry } from '../runtime/logger';
import type { TaskSnapshot } from '../runtime/progress';
import type { SkillAudience, SkillMode } from '../model/skillMode';
import type {
  EditorPane,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';
import type {
  PlotPipelineView,
  PlotSummaryView,
  ProjectTree,
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
  /**
   * 模型**想的**那一段的增量（推理模型的思考过程）。
   *
   * 与 `delta` 是两条通道而不是一个带标记的字段：思考不是正文，采纳写入时
   * 不该带上它。但**正文迟迟不来时它是唯一的进度反馈**——推理模型常常先想
   * 几十秒，那段时间界面不能是空的。
   *
   * 前端把它画成段区里的一块折叠块（默认收起），**位置就是它发生的位置**：
   * agent 一轮要调好几次模型，每个回合各想一次，全灌进气泡顶上那一块的话，
   * 「它读完这三章之后在想什么」就没了。
   */
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
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  | { type: 'summary'; summary: PlotSummaryView }
  | {
      type: 'pipeline';
      pipeline?: PlotPipelineView;
      workbench: WorkbenchView;
    }
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected'; skills?: SkillRow[] }
  /**
   * 输入框上方那几枚技能标签（作者用 `/` 呼出的）。
   *
   * 与 `attachments` 分开一条而不是塞进同一条：附件走的是装配器那一层
   * （引用一个文件、一段选区，`resolveAttachment` 按种类解析），技能走的是
   * **agent 那句话的前面**——一份工作流说明不是「引用的材料」，混成一条之后
   * 两边的解析规则会互相牵扯。
   */
  | { type: 'pendingSkills'; items: PendingSkill[] }
  /**
   * `/` 面板里的候选。**「禁用」那些不在里面**——设置页那张表才列全（`skills`
   * 字段），那边要列出来才改得回去，这边列出来只是让人点了没反应。
   *
   * 与 `settings` 那条上的 `skills` 分开一条：面板要在**作者打 `/` 的那一刻**
   * 拿到最新名单（他可能刚写完一份技能），而设置那条只在切到设置页时推。
   */
  | { type: 'skillList'; items: SkillRow[] }
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

/**
 * 设置页那张技能表里的一行。
 *
 * **含 `off` 那些**：禁用了也要列出来才改得回去。`description` 可能是空串
 * （技能没写 frontmatter），那时设置页只显示名字。
 *
 * 空窗口（独立版没打开工程）时只有内置那几行——工程技能得有工程才扫得出来。
 * `source` 让设置页能把这件事说清楚，而不是让作者以为自己的技能丢了。
 */
export interface SkillRow {
  /** 带前缀的全名，配置里的键就是它。 */
  name: string;
  source: 'builtin' | 'project';
  /** 不带前缀的那一半，界面上显示的就是这个。 */
  stem: string;
  description: string;
  /** 当前档位（含缺省回落后的值，不是「配置里存了什么」）。 */
  mode: SkillMode;
  /**
   * 写给谁读的。**来自 frontmatter，改不了**——设置页只显示，不给下拉框。
   *
   * 界面靠它分辨两件事：`generate` 那一类的档位只有「启用 / 禁用」两种
   * （见 `model/skillMode.ts` 的 `isIndexed`），而 `/` 面板里挑中它时带过去的
   * 是一句指令而不是整份正文。
   */
  audience: SkillAudience;
}

/** 输入框上方那一枚技能标签。 */
export interface PendingSkill {
  /** 带前缀的全名。摘掉它、发送时找回正文都靠它。 */
  name: string;
  /** 界面上显示的那一半（不带前缀）。 */
  stem: string;
  source: 'builtin' | 'project';
  /**
   * 正文字数。标签的 tooltip 上写着，作者据此知道这一句要带多少东西过去。
   *
   * **`generate` 那一类是 0**：它的正文根本不进这一轮，后端手上也没存
   * （见 `controller/skills.ts` 的 `useSkill`）。界面据 `audience` 换一句说法，
   * 不要显示「0 字」。
   */
  chars: number;
  audience: SkillAudience;
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
