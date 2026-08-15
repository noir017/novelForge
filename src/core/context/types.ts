/**
 * 装配器的公共类型。
 *
 * 单独成文件是为了打断 `recipes.ts`（配方引用层名）与 `layers/`（层实现
 * 引用配方里的 cap/force）之间的循环引用——两边都只依赖这里，谁也不依赖谁。
 */
import { AgentMessage } from '../llm/provider';
import { CreationAction, CreationTarget } from '../model/pipeline';
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
  /** 全书大纲原文。与 `ask` 分开：一个是产物，一个是这一轮的指令。 */
  | 'outlineDoc'
  /** 一章的细纲。 */
  | 'plot'
  /** 场景卡。 */
  | 'scene'
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
 * 前四层是「这一轮对话本身」，任何阶段都有；中间五层是各阶段的产物；
 * 后面是共享的背景知识。
 */
export type LayerId =
  | 'system'
  | 'ask'
  | 'attachments'
  | 'history'
  // 产物
  | 'outlineDoc'
  | 'plotSelf'
  /** 前几章的细纲原文（上文）。 */
  | 'plotPrev'
  /** 后一章的细纲原文（下文）。有了它，这一章的收尾才接得上已经排好的下一章。 */
  | 'plotNext'
  | 'sceneSelf'
  | 'sceneSiblings'
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
