/**
 * 装配器的公共类型。
 *
 * 单独成文件是为了打断 `recipes.ts`（配方引用层名）与 `layers/`（层实现
 * 引用配方里的 cap/force）之间的循环引用——两边都只依赖这里，谁也不依赖谁。
 */
import { AgentMessage } from '../llm/provider';
import { CreationAction, CreationTarget, WriteMode } from '../model/pipeline';
import { Attachment, ChatTurn } from '../model/session';

/** 上下文条目在 prompt 中的分层，数字越小越先保证。 */
export type Priority = 0 | 1 | 2 | 3 | 4;

/**
 * 条目类别。**前端只用它做分组显示**，不据此做逻辑判断，
 * 所以这里加一类不会牵动界面（`SerializedDigest.items[].kind` 是 string）。
 */
export type ItemKind =
  | 'system'
  /** 用户这一轮说的话。正文阶段它是剧情纲要，其余阶段是一句要求。 */
  | 'ask'
  | 'attachment'
  | 'history'
  /** 架构层的一份文档（小说配置 / 故事前提 / 世界观 / 角色图谱一览）。 */
  | 'setting'
  /** 小说配置里的「全局要求」：跨章的写作规则，写正文时单独成段。 */
  | 'guidance'
  /** 故事结构指导（按总章数算好的章号区间）。是指令，不是产物。 */
  | 'guide'
  /** 前序细纲一览：一章一行的目录进度（细纲批次用）。 */
  | 'plotList'
  /** 后几章的细纲：写正文时的边界——知道后面要发生什么，才不会在这一章提前写掉。 */
  | 'boundary'
  /** 本章已经写好的正文末尾：「接着写」与续写那几轮从这里往下接。 */
  | 'chapterSoFar'
  /** 情节大纲原文。与 `ask` 分开：一个是产物，一个是这一轮的指令。 */
  | 'outlineDoc'
  /** 一章的细纲。 */
  | 'plot'
  | 'prevTail'
  | 'style'
  | 'globalSummary'
  | 'character'
  /** 前面某章的正文全文。 */
  | 'manuscriptFull'
  /** 前面某章的摘要。 */
  | 'plotSummary'
  | 'lore'
  | 'revision';

export type ItemStatus = 'included' | 'degraded' | 'dropped' | 'excluded';

/** 一条上下文明细，供 Webview 展示与勾选。 */
export interface ContextItem {
  /** 稳定 id，Webview 用它回传「取消勾选」。 */
  id: string;
  kind: ItemKind;
  priority: Priority;
  /** 展示名，如「第 12 章 · 原文」。 */
  label: string;
  /** 来源文件相对路径，可点击打开。 */
  source?: string;
  /** 最终注入的文本；status 为 dropped/excluded 时为空。 */
  text: string;
  tokens: number;
  status: ItemStatus;
  /** 降级或丢弃的原因，直接展示给作者。 */
  note?: string;
}

// ---------------------------------------------------------------- 层与配方

/**
 * 可装配的层。**配方从这里选，层实现按这个名字注册**，两边对不上编译就报错。
 *
 * 前四层是「这一轮对话本身」，任何阶段都有；中间几层是各阶段的产物；
 * 后面是共享的背景知识。
 */
export type LayerId =
  | 'system'
  | 'ask'
  | 'attachments'
  | 'history'
  // 产物
  /** 架构层的三份文档，填过的才带。 */
  | 'settingDocs'
  /** 小说配置的「全局要求」一节。写正文时单独带、强制带（上游每一章都带它）。 */
  | 'guidance'
  /** 写正文用的架构：小说配置（除全局要求）、故事前提、世界观，一件一条。 */
  | 'premiseWorld'
  /** 角色图谱一览：全部角色卡压成一人一段（名字、定位、身份、人物关系）。 */
  | 'rosterDoc'
  | 'outlineDoc'
  /** 情节大纲里覆盖本章 / 本批的那几节。没有区间标题的大纲退回全文。 */
  | 'outlineSlice'
  /** 故事结构指导（model/structureGuide.ts）。 */
  | 'structure'
  /** 前序细纲一览（最近 100 章，一章一行）。 */
  | 'plotList'
  | 'plotSelf'
  /** 前几章的细纲原文（上文）。 */
  | 'plotPrev'
  /** 后一章的细纲原文（下文）。有了它，这一章的收尾才接得上已经排好的下一章。 */
  | 'plotNext'
  /** 后 5 章的细纲，一章一行：写正文时的边界（「禁止提前写」）。 */
  | 'plotAhead'
  /** 本章已经写好的正文末尾（「接着写」与续写那几轮）。 */
  | 'chapterSoFar'
  // 背景
  | 'style'
  | 'globalSummary'
  | 'characters'
  | 'lore'
  | 'prevTail'
  | 'manuscriptFull'
  | 'plotSummary'
  | 'revision';

export interface LayerSpec {
  layer: LayerId;
  priority: Priority;
  /**
   * 该层最多吃掉预算的比例。只有本身可能无限大的层需要（附件、历史）。
   * 不给则不单独封顶，只受全局余额约束。
   */
  cap?: number;
  /** 强制注入，不参与预算竞争（对应 admit 的 force）。 */
  force?: boolean;
}

// ---------------------------------------------------------------- 请求与结果

export interface BuildRequest {
  /** 这一次要 AI 干什么：哪一层的身份 + 什么能力。决定提示词与装配配方。 */
  action: CreationAction;
  /** 在改哪一个产物。决定「本层产物」几层取哪个文件。 */
  target: CreationTarget;
  /** 用户这一轮写的内容。正文阶段是剧情纲要，其余阶段是一句要求。 */
  ask: string;
  /**
   * 目标章的细纲**尚未落盘**时用它定位「前文」的边界（要写第 4 章，磁盘上只有 3 章）。
   * 细纲已经存在时以磁盘上的章号为准，这个字段被忽略；全书大纲阶段也忽略它。
   */
  targetNo?: number;
  /** 目标字数，写进 prompt 指令。 */
  targetWords?: number;
  /**
   * 写正文的写法（model/pipeline.ts 的 `WriteMode`）。生成层按磁盘定好了再交过来：
   * `continue` 时装配器带上本章已写正文的末尾、契约改成「只写新增的那一段」；
   * `rewrite` 时上一版正文经 `revision` 带进来。缺省按 `write`。
   */
  writeMode?: WriteMode;
  /**
   * 这一步覆盖的章号区间：大纲写哪一段、细纲拆哪一批（**给了就是一批**）。
   * 前文的边界取 `from`，后文从 `to` 之后算起。
   */
  range?: { from: number; to: number };
  /** 一句话弹窗带过来的规模（总章数、每章字数）。给了就以它为准。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /** 多步生成里的哪一步（generation/structured.ts）。缺省 = 第一步。 */
  step?: ChainStep;
  /**
   * 生成链里已经过了校验、还没落盘的细纲（拆半重试时的前一半）。前序细纲一览把它们
   * 接在磁盘上那些后面——不然后一半看不见前一半刚写了什么。
   */
  draftPlots?: DraftPlotLine[];
  /** 额外写作指令，如「加强对白」。 */
  extraInstruction?: string;
  /** 上一版生成结果 + 修改意见，用于「重写」。 */
  revision?: { previousDraft: string; feedback: string };
  /** 被用户手动取消勾选的条目 id。 */
  excludedIds?: string[];
  /** provider 的硬性输入上限，会与 contextWindow 取小。 */
  providerMaxInputTokens?: number;
  /** 用户本轮 @ 进来的文件 / 选区引用（Cursor 式）。 */
  attachments?: Attachment[];
  /** 本会话之前的对话轮次，按时间正序，不含本轮。 */
  history?: ChatTurn[];
}

/** 多步生成里除第一步之外的那几步。 */
export type ChainStep =
  /** 角色图谱第二步：按冻结的身份清单补这几个人的详情。 */
  | { kind: 'rosterDetails'; manifest: string; slotIds: string[]; done: string }
  /** 细纲批次里某一章的紧凑重建：上一次截断或解不出来，只重做这一章。 */
  | { kind: 'blueprintCompact'; diagnostic?: string }
  /**
   * 正文的续写那几轮（generation/continuation.ts）。`tail` 是已写正文的最后 1600 字，
   * `written` 是这一章到此为止的总字数，`remaining` 是离目标还差多少字（没有目标时缺席）。
   * `recovery`：上一轮被截断又没写出新东西、已经丢掉了，这是唯一一次恢复机会。
   */
  | { kind: 'continuation'; tail: string; written: number; remaining?: number; recovery: boolean };

/** 一章已经排好、还没落盘的细纲，给前序细纲一览用。 */
export interface DraftPlotLine {
  no: number;
  title: string;
  keyEvents: string;
  suspenseHook: string;
}

export interface BuiltContext {
  messages: AgentMessage[];
  items: ContextItem[];
  /** 实际使用的输入 token 估算值。 */
  usedTokens: number;
  /** 输入预算上限。 */
  budget: number;
  /** 上限是否被 provider 配额压低。 */
  budgetClampedByProvider: boolean;
}
