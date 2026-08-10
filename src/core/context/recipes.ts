/**
 * 装配配方：**每个阶段带什么、优先级多少**。
 *
 * 分阶段装配是这次重构里最直接的质量与成本改动。改之前无论问什么都装同一套
 * （近三章原文 + 全部命中角色卡 + 全部摘要）：
 *
 * - **细纲阶段被几万字原文塞满，却一个字都用不上**——它要的是大纲、上一章
 *   细纲、角色此刻的状态。这一层的 token 因此降一个数量级。
 * - **正文阶段的文风指南排在 P1**，一段长对话（历史封顶 30%）加上几张角色卡
 *   就能把它挤掉。而它恰恰是「读者感觉不到换人执笔」的唯一保障。
 *
 * 所以有两处刻意的抬高，见下表的 ★。
 */
import { CreationStage } from '../model/pipeline';
import { LayerSpec } from './types';

/** 单条附件最多吃掉多少预算——用户 @ 一个大文件不该把前文全挤掉。 */
const ATTACHMENT_CAP = 0.35;
/** 全部历史对话最多吃掉多少预算。 */
const HISTORY_CAP = 0.3;

/**
 * 四张配方。**顺序即填充顺序**：靠前的先拿预算，靠后的可能被降级或丢弃。
 *
 * 每张的前四层都一样（系统提示 / 用户输入 / 引用 / 历史）——那是「这一轮
 * 对话本身」，任何阶段都不能少。差别从第五层开始。
 */
export const STAGE_RECIPES: Record<CreationStage, LayerSpec[]> = {
  // ---------------------------------------------------------------- 大纲
  // 策划编辑要看全局：现有大纲全文 + 全书摘要。**不看正文原文**——
  // 讨论故事结构时读三章原文既没用又昂贵。
  outline: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'chapterSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 细纲
  // 剧情导演要看：本章在大纲里的位置、这一章现有的细纲、上一章发生了什么。
  // **不看正文原文**：一章三千字 × 三章，够装下整本书的摘要还有富余。
  plan: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'planSelf', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'planPrev', priority: 1 },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'chapterSummary', priority: 3 },
    { layer: 'prevTail', priority: 4 },
  ],

  // ---------------------------------------------------------------- 细节
  // 编剧要看：本章细纲（这一场在整章里的位置）、这一场现在的样子、前后两场
  // （前置条件与不能提前发生的事都来自邻居）。
  // ★ 角色卡升到 P1：场景 frontmatter 里明写了这一幕有谁，比在用户那一句话里
  //   做子串匹配准得多，而「人物此刻知道什么」正是这一层的核心产出。
  scene: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'sceneSelf', priority: 0, force: true },
    { layer: 'planSelf', priority: 0, force: true },
    { layer: 'sceneSiblings', priority: 1 },
    { layer: 'characters', priority: 1 },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'prevTail', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'globalSummary', priority: 3 },
    { layer: 'chapterSummary', priority: 4 },
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
    { layer: 'planSelf', priority: 0 },
    { layer: 'prevTail', priority: 0, force: true },
    { layer: 'revision', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'characters', priority: 1 },
    { layer: 'globalSummary', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'chapterFull', priority: 3 },
    { layer: 'chapterSummary', priority: 4 },
  ],
};

export function recipeFor(stage: CreationStage): LayerSpec[] {
  return STAGE_RECIPES[stage] ?? STAGE_RECIPES.manuscript;
}
