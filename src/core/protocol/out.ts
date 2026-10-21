import type { DirListing } from '../files/fileTree';
import type { CallPrompt } from '../model/callChoice';
import type { LogEntry } from '../runtime/logger';
import type { TaskOpen, TaskSnapshot } from '../runtime/progress';
import type { SkillSource, SkillStage } from '../model/writingSkill';
import type { ArtifactKind } from '../workspace/kind';
import type { QuickOpenIndex } from './quickOpen';
import type { CheckTermsView } from './check';
import type { NameIndex } from './nameIndex';
import type { ThreadsOverview } from './threadsOverview';
import type { BookFindResult, BookReplaceSummary } from './bookFind';
import type {
  EditorOpenIntent,
  EditorPane,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';
import type {
  ChapterIndexEntry,
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
   * 写正文的进度（W7）：第几轮（0 = 第一次调用，k = 自动续写第 k 轮）、这一章写到多少字了、
   * 目标多少。流式期间约 300ms 一次。前端在流式气泡顶上画一条进度。
   */
  | { type: 'writeProgress'; turnId: string; round: number; words: number; target?: number }
  /**
   * 流式气泡退回到这一份文字：正文续写丢弃了一轮（被截断又没写出东西），那一轮已经流进
   * 气泡里了，不退回去作者看着的是一段不会被写入的文字。
   */
  | { type: 'streamReset'; turnId: string; text: string }
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
   * **两种问法共用这一条**：外部 agent 的 `always` 动作动手前（`controller/mcp.ts`），以及
   * **产物落盘前那一句**（第 19 条，任何情况下都问）。两种都只有两颗按钮
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
      /**
       * 要作者特别留意的一句（画成红色块）。目前只有正文重演：开头与上一章结尾大段重合，
       * 这里是重合的那一段原文。
       */
      danger?: string;
      /**
       * 给了就要点两下才算同意：第一下把按钮上的字换成它，第二下才发出去。按钮文案两段式，
       * 不叠弹窗（总计划 §2.4）。
       */
      confirm?: string;
      /**
       * 给了就在按钮上方多一格理由输入框与第三颗按钮（`label`），填了理由才能点；点了算同意，
       * 理由随 `gateResult.remember` 带回。目前只有一致性预检用它：「记为刻意安排，照写」
       * （五期补遗 §2）。
       */
      remember?: { label: string; placeholder: string };
    }
  /**
   * 那张卡片可以收了：作者在另一个视图上答了，或者这一轮被取消/结束了。
   *
   * 两个视图（侧边栏与编辑器标签页）挂的是同一个 controller，只在被点的那
   * 一边收卡片的话，另一边会留着一张点了没反应的卡。
   */
  | { type: 'gateDone'; requestId: string; verdict: 'proceed' | 'skip' | 'cancelled' }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  /**
   * 回 `copyContext`：拼好的完整上下文（`model/session.ts` 的 `renderContextText`），或者为什么
   * 拿不到。认不出的 `requestId` 前端静默丢弃（另一个视图点的）。
   */
  | { type: 'contextText'; requestId: string; text?: string; error?: string }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  /**
   * 内置编辑器的章节索引（章节条、上一章 / 下一章）：一个章号一行，升序。**哪个页签都推**——工程树只在
   * 「工程」页签开着时推，作者大多待在对话页。随 `init` 推一次，之后每次 `pushState` 都算（与 `state` 里
   * 目标下拉那份同一趟流水线索引，不多读盘），**内容变了才推**。
   */
  | { type: 'chapterIndex'; chapters: ChapterIndexEntry[] }
  /**
   * 内置编辑器「写作体检」的词表（禁用词与自定义敏感词表，`protocol/check.ts`）。随 `init` 推一次，之后每次
   * `pushState` 都现算，**内容变了才推**；只给有内置编辑器的宿主推。
   */
  | { type: 'checkTerms'; terms: CheckTermsView }
  | { type: 'summary'; summary: PlotSummaryView }
  /** 回 `requestQuickOpen`：「转到…」面板要的索引。认不出的 `requestId` 前端静默丢弃（另一个视图要的）。 */
  | { type: 'quickOpenIndex'; requestId: string; index: QuickOpenIndex }
  /**
   * 回 `requestNameIndex`：「名词补全」要的名词表。`sig` 是这份表的指纹；与请求里的 `have` 对得上时不带 `index`
   * （前端手上那份就是最新的）。认不出的 `requestId` 前端静默丢弃。
   */
  | { type: 'nameIndex'; requestId: string; sig: string; index?: NameIndex }
  /**
   * 回 `requestThreadsOverview`：编辑区「叙事线总览」标签要的矩阵（章 × 线，`protocol/threadsOverview.ts`）。认不出的
   * `requestId` 前端静默丢弃（另一个视图要的）。
   */
  | { type: 'threadsOverview'; requestId: string; overview: ThreadsOverview }
  | {
      type: 'pipeline';
      pipeline?: PlotPipelineView;
      next?: NextStepView;
      workbench: WorkbenchView;
    }
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  /**
   * 设置页「技能」：技能库与本工程的阶段绑定。每次切到那一页、装卸绑之后重推（每次都重扫：作者可能
   * 刚手放了一份进来）。`installed`：刚装好的那一份的 id，前端据此收起检查结果。
   */
  | { type: 'skills'; view: SkillsView; installed?: string }
  /** 「检查」的结果：给了 `inspection` 是检查成了（不等于装得了，见 `blockers`），给了 `error` 是没检查成。 */
  | { type: 'skillInspection'; url: string; inspection?: SkillInspectionView; error?: string }
  | { type: 'toast'; message: string; level: 'info' | 'error' }
  /** `preview` / `replace` 是打开请求上带的那两个标记（`EditorOpenIntent`），原样带回。 */
  | ({ type: 'editorOpen'; file: EditorFileView; pane?: EditorPane } & EditorOpenIntent)
  | { type: 'editorSaved'; file: EditorFileView }
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  | { type: 'editorError'; path: string; message: string }
  /**
   * `checkEditorFiles` 的回答：这份文件在磁盘上与编辑器知道的那份不一样了（定稿写回细纲、批量写章、
   * 外部 agent 的 `edit`、外部编辑器 / git 改了它），带上磁盘上的新版。编辑器就地换掉没改过的标签、
   * 给改过的挂冲突条——**不切标签、不抢焦点**（这正是它不复用 `editorOpen` 的原因）。
   */
  | { type: 'editorDiskChanged'; file: EditorFileView }
  /**
   * 磁盘上已经没有这份文件了（被删、被改名）。两处会发：`checkEditorFiles` 读不到它；`saveFile` 带了基线、
   * 文件却不在、又没说 `recreate`（此时什么都没写）。
   */
  | { type: 'editorDiskGone'; path: string }
  /**
   * 在编辑区里选中这一句并滚到它（五期 W10：点审稿报告上的引文）。紧跟在那一份的 `editorOpen`
   * 之后推。定位按 model/review.ts 的 `locateQuote`（与引文校验同一个归一化）。
   */
  | { type: 'editorReveal'; path: string; quote: string }
  /**
   * 把编辑区里这份文件换成这段文字（`Pane.applyEdit`：一步撤销，成为未保存，不写盘）。冲突条「对比合并」
   * 采纳之后带 `base`：乐观锁基线换成磁盘上那一份（冲突条随之收起，之后照常 Ctrl+S，不必强制保存）；
   * 对比历史版本之后不带，基线不变。**只有发起的那个页面认**（`requestId`）——回复是广播，同一个工程
   * 开着两个窗口时，另一个窗口里那一份不该被换掉。
   */
  | { type: 'editorReplace'; requestId: string; path: string; text: string; base?: { text: string; hash: string } }
  /**
   * 这份文件的历史版本（`workspace/history.ts`），新的在前。`unavailable`：不存历史版本的原因（不是工程里的
   * 创作产物、还不是小说工程……），这时 `entries` 是空的。
   */
  | { type: 'versions'; path: string; entries: VersionView[]; unavailable?: string }
  /** 回 `readVersion`：那一个快照的全文；读不到时给 `error`。 */
  | { type: 'versionText'; requestId: string; path: string; id: string; text?: string; error?: string }
  /** 回 `bookFind`：全书查找（或预览替换）的结果。认不出的 `requestId` 前端静默丢弃（另一个窗口要的、或已经叫停的）。 */
  | { type: 'bookFindResult'; requestId: string; result: BookFindResult }
  /** 回 `bookReplace`：替换了几个文件几处、跳过了哪些与为什么、指纹链怎么处理的。之后紧跟一次 `pushState`。 */
  | { type: 'bookReplaceDone'; requestId: string; summary: BookReplaceSummary }
  | { type: 'dirListings'; listings: DirListing[] }
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
  | { type: 'tasks'; tasks: TaskSnapshot[] }
  /** 长任务说完了那一句（D24）：前端出一条提示，带按钮时点了打开那一章。 */
  | { type: 'taskDone'; title: string; message: string; level: 'info' | 'error'; open?: TaskOpen }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'logHistory'; entries: LogEntry[]; exhausted: boolean }
  | {
      type: 'prompt';
      requestId: string;
      /**
       * `merge`（五期 W11）：覆盖审阅的段级 diff / 合并视图。`current` / `proposed` 是两个版本，
       * `mergeable` 为真时可以逐段挑、结果可以手改，回的是 `{"verdict":"apply"|"discard","merged"?}`
       * 的 JSON；为假时只读，只有采纳 / 放弃。`sides` 是两栏的称呼（缺省「原文 / 新版」，按钮上的字跟着变），
       * `applyLabel` 是采纳那颗按钮上的字（缺省「写入合并结果」）——冲突时的对比合并与历史版本的对比
       * 不写盘，是「放回编辑器」。
       *
       * `file`：选本机任意一个文件（`Host.pickHostFile`）。`value` 是起始目录，`options` 是允许的扩展名
       * （不带点），回的是选中文件的绝对路径；取消回 undefined。
       *
       * `confirm` 的 `value` 是补充说明（`Host.confirm` 的 `detail`），多行；`actions` 是按钮，一个一颗，回的是点的那颗上的字，
       * 取消回 undefined。带 `call` 的是调模型之前的那一问（`Host.confirmCall`）：按钮上面多两个下拉框（模型、上下文详细度），
       * 回答另带 `promptResult.choice`。
       */
      kind: 'input' | 'confirm' | 'pick' | 'merge' | 'file';
      actions?: string[];
      call?: CallPrompt;
      title: string;
      message?: string;
      placeholder?: string;
      value?: string;
      password?: boolean;
      multiline?: boolean;
      options?: string[];
      current?: string;
      proposed?: string;
      mergeable?: boolean;
      sides?: { current: string; proposed: string };
      applyLabel?: string;
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
      /** 设置「新窗口中打开项目」。前端打开工程时据此决定换掉本窗口的工程还是开新窗口。 */
      openInNewWindow?: boolean;
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

/** 技能库里的一份写作技能。 */
export interface SkillRow {
  /** `来源:名字`，绑定与卸载都认它。 */
  id: string;
  source: SkillSource;
  name: string;
  /** 显示名（`display_name` → `name`）。 */
  label: string;
  description: string;
  version?: string;
  /** frontmatter 写明的阶段，没写就是按内容猜的。只是建议。 */
  suggestedStage: SkillStage;
  compatible: boolean;
  /** 不兼容的原因，已经是给人看的话。 */
  reasons: string[];
  /** 正文的 UTF-8 字节数。 */
  bytes: number;
  /** 本工程的技能在工程里的路径（点得开）。 */
  relPath?: string;
  /** 在本工程里绑在哪几个阶段。 */
  boundTo: SkillStage[];
}

export interface SkillsView {
  rows: SkillRow[];
  /** 本工程每个阶段绑了哪份。**没打开工程时缺席**：绑定跟着工程走。 */
  bindings?: Partial<Record<SkillStage, string>>;
  /** 绑定文件读不懂的地方（`.novelforge/skills.json`）。 */
  problems: string[];
  /** 我的技能库在哪：手放技能的作者要知道往哪放。 */
  userDir: string;
}

/** 检查一份 GitHub 上的技能得到的东西。**带正文**：装之前作者看得到它写了什么。 */
export interface SkillInspectionView {
  url: string;
  resolvedUrl: string;
  name: string;
  label: string;
  description: string;
  version?: string;
  suggestedStage: SkillStage;
  bytes: number;
  body: string;
  /** 装不了的原因。空 = 可以装。 */
  blockers: string[];
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

/**
 * 一个历史版本（快照，`workspace/history.ts` 的 `SnapshotInfo`）。`id` 是快照的文件名，读它、对比它时认它；
 * `time` 是这一版在磁盘上被覆盖掉的那一刻（毫秒时间戳）。
 */
export interface VersionView {
  id: string;
  time: number;
  words: number;
  bytes: number;
}

export interface EditorFileView {
  path: string;
  name: string;
  text: string;
  hash: string;
  bytes: number;
  draftPath?: string;
  /**
   * 这份文件在工程里是什么（`kindOfPath` 算的）。内置编辑器据此分「正文」（`chapter` / `draft`）
   * 与其余文件——Tab 缩进用全角还是半角就看它。前端不自己拿路径或扩展名去猜（与 `draftPath`
   * 同一条原则：后端才知道什么算章节）。没打开工程时省略，前端当非正文。
   */
  kind?: ArtifactKind;
  /**
   * 标签与工具栏上怎么称呼这份文件（`views/editorLabel.ts`，按 `kindOfPath` 与章节 / 细纲的文件名规则算）。
   * 与 `kind`、`draftPath` 同一条原则：前端不拿路径猜。没打开工程时省略，前端退回文件名与原始路径。
   */
  label?: EditorFileLabel;
}

/** 内置编辑器工具栏面包屑的一段。带 `dir`（工程内相对路径）的是目录，点了在「文件」页定位到它。 */
export interface EditorCrumb {
  label: string;
  dir?: string;
}

/** 内置编辑器上这份文件的称呼。 */
export interface EditorFileLabel {
  /** 标签上名字前面那一小格：细纲「细纲」、草稿「草稿」、角色「角色」……正文与有中文称呼的固定文件不带（空串）。 */
  tag: string;
  /** 标签上的名字：去掉扩展名的文件名；架构几件、情节大纲这类固定文件是中文称呼；认不出的文件是原文件名。 */
  title: string;
  /** 工具栏面包屑：「细纲 › 第一卷 › 第 3 章 夜访」「角色 › 林晚」。 */
  crumbs: EditorCrumb[];
}
