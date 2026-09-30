/**
 * 装配配方：**每个阶段带什么、优先级多少**。
 *
 * 分阶段装配是这次重构里最直接的质量与成本改动。改之前无论问什么都装同一套
 * （近三章原文 + 全部命中角色卡 + 全部摘要）：
 *
 * - **细纲阶段被几万字原文塞满，却一个字都用不上**——它要的是大纲、前后章的
 *   细纲、角色此刻的状态。这一层的 token 因此降一个数量级。
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
 * 「落定细纲」时历史对话的封顶。
 *
 * `settle` 要沉淀的**就是那段对话**。按常规的 30% 装，一段聊了十几轮的讨论会
 * 被由远及近截掉开头——而开头往往正是定调子的地方（「这一章主角不能赢」）。
 * 抬到 60% 并把优先级提到 0，是这条命令能不能成立的前提（第 22 条）。
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
 * 本期（一期）只把卷与中转站那几层换掉，**不加新层**：细纲批次要的前序细纲一览、
 * 正文要的执行卡与后五章边界，随二、三期的提示词一起进来（见总计划 §2.3）。
 */
export const STAGE_RECIPES: Record<CreationStage, LayerSpec[]> = {
  // ---------------------------------------------------------------- 架构
  // 策划要看的是已经定下的那几件：配置、前提、世界观、已有的角色。**不看正文**
  // ——这一层在第一章之前，也不该被已经写出来的东西带着走。
  //
  // ★ `settingDocs` 是 P0 force：架构四件一件吃一件，前提要照着配置写，
  //   世界观要照着前提与角色写，少了上一件，这一件就是凭空编的。
  setting: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'settingDocs', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'characters', priority: 1 },
    { layer: 'outlineDoc', priority: 2 },
    { layer: 'lore', priority: 2 },
  ],

  // ---------------------------------------------------------------- 大纲
  // 策划编辑要看全局：架构四件 + 现有大纲全文 + 全书摘要。**不看正文原文**——
  // 讨论故事结构时读三章原文既没用又昂贵。
  outline: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'settingDocs', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'history', priority: 1, cap: HISTORY_CAP },
    { layer: 'characters', priority: 1 },
    { layer: 'globalSummary', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'plotSummary', priority: 3 },
  ],

  // ---------------------------------------------------------------- 细纲
  // 剧情编剧要看：这一章在大纲里的位置、它现在的样子、前几章排到哪、下一章要
  // 接到哪。**不看正文原文**：排细纲要的是走向，不是措辞。
  //
  // ★ `plotNext` 少了它，改中间某一章时模型不知道后面已经排好了什么，收尾会与
  //   下一章的开头撞车或断裂——「转折突兀」多半出在这里。
  plot: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0 },
    { layer: 'settingDocs', priority: 1 },
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
  // ★ `plotSelf` P0 force：细纲**就是**写正文的依据。少了它，模型手上只有文风与
  //   前文尾巴，会自己编一章出来。
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
