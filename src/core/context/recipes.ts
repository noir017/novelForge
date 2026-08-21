/**
 * 装配配方：**每个阶段带什么、优先级多少**。
 *
 * 分阶段装配是这次重构里最直接的质量与成本改动。改之前无论问什么都装同一套
 * （近三章原文 + 全部命中角色卡 + 全部摘要）：
 *
 * - **剧情阶段被几万字原文塞满，却一个字都用不上**——它要的是大纲、前后章的
 *   剧情脉络、角色此刻的状态。这一层的 token 因此降一个数量级。
 * - **正文阶段的文风指南排在 P1**，一段长对话（历史封顶 30%）加上几张角色卡
 *   就能把它挤掉。而它恰恰是「读者感觉不到换人执笔」的唯一保障。
 *
 * 所以有几处刻意的抬高，见下面的 ★。
 */
import { Capability, CreationStage } from '../model/pipeline';
import { LayerSpec } from './types';

/** 单条附件最多吃掉多少预算——用户 @ 一个大文件不该把前文全挤掉。 */
const ATTACHMENT_CAP = 0.35;
/** 全部历史对话最多吃掉多少预算。 */
const HISTORY_CAP = 0.3;
/**
 * 「落定剧情」时历史对话的封顶。
 *
 * `settle` 要沉淀的**就是那段对话**。按常规的 30% 装，一段聊了十几轮的讨论会
 * 被由远及近截掉开头——而开头往往正是定调子的地方（「这一章主角不能赢」）。
 * 抬到 60% 并把优先级提到 0，是这条命令能不能成立的前提。
 *
 * 不抬到 100%：大纲、前后章、角色卡仍然要带，不然模型会把讨论里没提到的
 * 既有设定重新发明一遍。
 */
const SETTLE_HISTORY_CAP = 0.6;

/**
 * 四张配方，一个阶段一张。**顺序即填充顺序**：靠前的先拿预算，靠后的
 * 可能被降级或丢弃。
 *
 * 每张的前四层都一样（系统提示 / 用户输入 / 引用 / 历史）——那是「这一轮
 * 对话本身」，任何阶段都不能少。差别从第五层开始。
 *
 * **卷纲有了自己的一张。** 从前它借大纲那一张，于是那张里三层与卷相关的层
 * （`volumeSelf` / `volumeSegments`）在 target 是全书大纲时全程空跑，而
 * `volumeList` 在拆卷与拆段两种完全不同的用途上共用同一个优先级。分成两张
 * 之后各自只带自己要的东西——这正是把 `volume` 提升为独立阶段换来的第一样
 * 实际好处（见 model/pipeline.ts 的 `CreationStage`）。
 */
export const STAGE_RECIPES: Record<CreationStage, LayerSpec[]> = {
  // ---------------------------------------------------------------- 大纲
  // 策划编辑要看全局：现有大纲全文 + 分卷一览 + 全书摘要。**不看正文原文**——
  // 讨论故事结构时读三章原文既没用又昂贵。
  //
  // ★ `volumeList` 在这一层是「已经有哪些卷」：少了它，「拆成卷」会把已经拆过
  //   的卷重新发明一遍。
  outline: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'volumeList', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'plotSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 卷纲
  // 分卷编剧要看：这一卷的卷纲现在的样子、它已经拆到哪一段了、它在全书里
  // 排第几。**不看正文原文**，与大纲层同理。
  //
  // ★ `volumeSelf` 与 `volumeSegments` 是 P0 force：从一卷里拆下一段时，这两层
  //   就是全部依据。少了后者，模型会把已经排过的那几段重新发明一遍。
  // ★ `outlineDoc` 只到 P1：写一卷的卷纲要以全书大纲为准，但真正贴身的依据是
  //   这一卷自己那几节；预算紧时先保住后者。
  volume: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'volumeSelf', priority: 0, force: true },
    { layer: 'volumeSegments', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 1 },
    { layer: 'volumeList', priority: 1 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'plotSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 剧情
  // 剧情编剧要看：这一段在大纲里的位置、它现在的样子、前几段发生了什么、
  // 下一段要接到哪。**不看正文原文**：一段三千字 × 三段，够装下整本书的摘要
  // 还有富余；而排剧情要的是脉络，不是措辞。
  //
  // ★ `plotNext` 少了它，改中间某一段时模型不知道后面已经排好了什么，收尾会与
  //   下一段的开头撞车或断裂——「转折突兀」多半出在这里。
  plot: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'plotPrev', priority: 1 },
    { layer: 'plotNext', priority: 1 },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'plotSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 正文
  // 唯一保留全套装配的阶段。
  // ★ 文风指南升到 P0 force：它决定读者感不感觉到换人执笔，不该跟一段长对话
  //   抢预算。这是分阶段装配最直接的质量收益。
  // ★ `plotSelf` 升到 P0 force。从前这一格是 `sceneSelf`（这一场的素材卡），
  //   细纲只到 P0 不 force——因为写的是「这一场」，本段细纲只是背景。场景那一层
  //   删掉之后，细纲**就是**写正文的依据：少了它，模型手上只有文风与前文尾巴，
  //   会自己编一段剧情出来。
  manuscript: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'style', priority: 0, force: true },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'prevTail', priority: 0, force: true },
    { layer: 'revision', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'characters', priority: 1 },
    { layer: 'globalSummary', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'manuscriptFull', priority: 3 },
    { layer: 'plotSummary', priority: 4 },
  ],
};

/**
 * 取某阶段的配方。
 *
 * `capability` 只影响一处：`settle` 要把历史对话抬成 P0 并放宽封顶。做成
 * 「按能力微调既有配方」而不是再写一张完整配方，是因为其余十一层与
 * `generate` 一模一样——复制一份，下次改剧情层的装配策略就会漏掉一边。
 */
export function recipeFor(stage: CreationStage, capability?: Capability): LayerSpec[] {
  const recipe = STAGE_RECIPES[stage] ?? STAGE_RECIPES.manuscript;
  if (capability !== 'settle') {
    return recipe;
  }
  return recipe.map((spec) =>
    spec.layer === 'history' ? { ...spec, priority: 0 as const, cap: SETTLE_HISTORY_CAP } : spec
  );
}
