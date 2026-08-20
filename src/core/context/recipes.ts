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
 * 四张配方（卷借大纲那一张）。**顺序即填充顺序**：靠前的先拿预算，靠后的
 * 可能被降级或丢弃。
 *
 * 每张的前四层都一样（系统提示 / 用户输入 / 引用 / 历史）——那是「这一轮
 * 对话本身」，任何阶段都不能少。差别从第五层开始。
 */
export const STAGE_RECIPES: Record<CreationStage, LayerSpec[]> = {
  // ---------------------------------------------------------------- 大纲（含卷）
  // 策划编辑要看全局：现有大纲全文 + 分卷一览 + 全书摘要。**不看正文原文**——
  // 讨论故事结构时读三章原文既没用又昂贵。
  //
  // 卷不是独立的阶段（见 model/pipeline.ts 的文件头），所以它借这张配方。三层
  // 与卷相关的层在 target 不是某一卷时**自然是空的**（`volumeSelf` /
  // `volumeSegments` 都先看 `focus.volume`），不必为此另写一张配方——复制一份，
  // 下次改大纲层的装配策略就会漏掉一边（与 `settle` 只微调既有配方同一条理由）。
  //
  // ★ `volumeSelf` 与 `volumeSegments` 是 P0 force：从一卷里拆下一段时，这两层
  //   就是全部依据。少了后者，模型会把已经排过的那几段重新发明一遍。
  outline: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'volumeSelf', priority: 0, force: true },
    { layer: 'volumeSegments', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'volumeList', priority: 1 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'plotSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 剧情
  // 剧情编剧要看：这一章在大纲里的位置、它现在的样子、前几章发生了什么、
  // 下一章要接到哪。**不看正文原文**：一章三千字 × 三章，够装下整本书的摘要
  // 还有富余；而排剧情要的是脉络，不是措辞。
  //
  // ★ `plotNext` 是这次新加的一层。少了它，改中间某一章时模型不知道后面已经
  //   排好了什么，收尾会与下一章的开头撞车或断裂——「转折突兀」多半出在这里。
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

  // ---------------------------------------------------------------- 细节
  // 分镜编剧要看：本章细纲（这一场在整章里的位置）、这一场现在的样子、前后两场
  // （前置条件与不能提前发生的事都来自邻居）。
  // ★ 角色卡升到 P1：场景 frontmatter 里明写了这一幕有谁，比在用户那一句话里
  //   做子串匹配准得多，而「人物此刻知道什么」正是这一层的核心产出。
  scene: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'sceneSelf', priority: 0, force: true },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'sceneSiblings', priority: 1 },
    { layer: 'characters', priority: 1 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'prevTail', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'globalSummary', priority: 3 },
    { layer: 'plotSummary', priority: 4 },
  ],

  // ---------------------------------------------------------------- 正文
  // 唯一保留全套装配的阶段。
  // ★ 文风指南升到 P0 force：它决定读者感不感觉到换人执笔，不该跟一段长对话
  //   抢预算。这是分阶段装配最直接的质量收益。
  manuscript: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'style', priority: 0, force: true },
    { layer: 'sceneSelf', priority: 0, force: true },
    { layer: 'plotSelf', priority: 0 },
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
