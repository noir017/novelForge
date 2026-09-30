/**
 * 故事结构指导：按总章数把六种结构切成章号区间，写情节大纲时注入。
 *
 * **纯函数、零 I/O**。思路与三幕、起承转合、多线、自由四种的写法来自 AI-Novel-Writer
 * （GPL-3.0，源自 AI_NovelGenerator）的 `getPlotStructureGuide`
 * （`src/services/workflows/architecture-workflow.ts:226-284`）。
 *
 * ## 为什么每一段都要有章号
 *
 * 大纲要写「结构拐点」，而拐点落在第几章决定了节奏：一百章的书把中点放在第 30 章，
 * 后七十章就只剩收尾。不给章号，模型会按它熟悉的篇幅（多半是一部电影）去排，
 * 写出来的大纲与总章数对不上。
 *
 * **上游的缺口**：英雄之旅与节拍表只有一行「全书共 N 章...」的占位，没有任何区间
 * （`architecture-workflow.ts:238-241`）。这里六种都用同一个分配函数按累计百分比切，
 * 十二阶段与十五拍的百分比取常见的写法（Vogler、Blake Snyder），不是精确科学，
 * 只是让每一段落在一个说得过去的位置上。
 *
 * ## 大纲是分批写的
 *
 * 超过 20 章的书先只写第 1–20 章（D20）。结构指导仍然给**全书**的切分——模型要知道
 * 这 20 章在整本书里是第一幕的开头还是全部——再用 {@link structureStagesIn} 点明
 * 本批落在哪几段。
 */
import { NARRATIVE_POV_LABEL, NarrativePov, PLOT_STRUCTURE_LABEL, PlotStructure } from './settingFile';

/** 结构里的一段（一幕 / 一个阶段 / 一拍），带章号区间（闭区间）。 */
export interface StructureStage {
  name: string;
  /** 这一段要完成什么。 */
  hint: string;
  from: number;
  to: number;
}

interface StageSpec {
  name: string;
  hint: string;
  /** 这一段结束时，全书写到了百分之几（累计，0..1；最后一段必须是 1）。 */
  end: number;
}

const SPECS: Record<PlotStructure, StageSpec[]> = {
  three_act: [
    { name: '第一幕 · 建置', hint: '立起主角、世界与开局困境，抛出打破平衡的事件', end: 0.2 },
    { name: '第二幕 · 对抗与发展', hint: '目标确立、阻力层层升级，中段有一次改变局势的转折', end: 0.75 },
    { name: '第三幕 · 高潮与结局', hint: '最大危机爆发，主角付出代价做出选择，收束主线', end: 1 },
  ],
  heros_journey: [
    { name: '平凡世界', hint: '主角的日常、缺憾与处境', end: 0.05 },
    { name: '冒险召唤', hint: '打破日常的事件，指出一条非走不可的路', end: 0.1 },
    { name: '拒绝召唤', hint: '恐惧、牵挂或代价让主角迟疑', end: 0.13 },
    { name: '遇见导师', hint: '获得指点、工具或信念', end: 0.18 },
    { name: '跨越第一道门槛', hint: '主动踏进陌生的世界，退路断了', end: 0.25 },
    { name: '考验、盟友与敌人', hint: '在新世界里立足，结识同伴与对手，学会规则', end: 0.4 },
    { name: '接近最深的洞穴', hint: '逼近核心危险，计划与准备', end: 0.5 },
    { name: '磨难', hint: '最大的考验，几乎失去一切', end: 0.6 },
    { name: '奖赏', hint: '熬过磨难，得到想要的东西或真相', end: 0.7 },
    { name: '归途', hint: '带着所得往回走，追兵与后果随之而来', end: 0.8 },
    { name: '复活', hint: '最终决战，主角完成蜕变', end: 0.92 },
    { name: '携宝归来', hint: '回到起点，世界因他而变', end: 1 },
  ],
  save_the_cat: [
    { name: '开场画面', hint: '一个定调的画面，显出主角的「之前」', end: 0.01 },
    { name: '主题呈现', hint: '有人点出主角要学会的那件事', end: 0.05 },
    { name: '铺垫', hint: '主角的世界、缺陷与身边人', end: 0.1 },
    { name: '催化剂', hint: '改变命运的事件发生', end: 0.12 },
    { name: '犹豫', hint: '要不要走出去', end: 0.2 },
    { name: '进入第二幕', hint: '主角主动选择踏进新局面', end: 0.22 },
    { name: 'B 故事', hint: '引出承载主题的副线与人物', end: 0.25 },
    { name: '游戏时间', hint: '兑现卖点：新世界里的爽点与乐趣', end: 0.5 },
    { name: '中点', hint: '虚假的胜利或失败，赌注抬高', end: 0.52 },
    { name: '坏人逼近', hint: '外部压力与内部裂痕同时收紧', end: 0.72 },
    { name: '一无所有', hint: '跌到谷底，失去最重要的东西', end: 0.75 },
    { name: '灵魂黑夜', hint: '消化失败，想明白真正要的是什么', end: 0.8 },
    { name: '进入第三幕', hint: '找到解法，带着新认识出发', end: 0.82 },
    { name: '终局', hint: '执行计划、最终对决，主副线合一', end: 0.98 },
    { name: '终场画面', hint: '与开场画面对照，显出主角的「之后」', end: 1 },
  ],
  kishotenketsu: [
    { name: '起', hint: '介绍世界、角色和日常，建立读者认同', end: 0.25 },
    { name: '承', hint: '延续与深化，展现角色关系和冲突苗头', end: 0.5 },
    { name: '转', hint: '核心转折，出人意料的变化打破既有格局', end: 0.75 },
    { name: '合', hint: '收束所有线索，揭示主题，给出结局', end: 1 },
  ],
  multi_thread: [
    { name: '各线铺开', hint: '2–4 条独立又交织的故事线各自立起主角或视角', end: 0.25 },
    { name: '第一次交汇之后', hint: '在本段开头安排各线的第一次碰撞，之后交替推进，别让哪条线长期消失', end: 0.5 },
    { name: '第二次交汇之后', hint: '再一次交汇，冲突升级，各线的代价开始相互传导', end: 0.75 },
    { name: '合流与终局', hint: '所有线索开始汇聚，走向统一高潮', end: 1 },
  ],
  freeform: [
    { name: '开篇建置', hint: '清晰地立起人物、世界与核心问题', end: 0.12 },
    { name: '中段', hint: '按内容自由编排，每 10–20 章一个小高潮或悬念释放点，适时安排转折，避免节奏单一', end: 0.88 },
    { name: '收尾', hint: '回收伏笔，给出结局', end: 1 },
  ],
};

/** 每种结构开头那一句「怎么用它」。 */
const LEAD: Record<PlotStructure, string> = {
  three_act: '严格按以下结构组织大纲',
  heros_journey: '严格按以下阶段组织大纲',
  save_the_cat: '严格按以下节拍组织大纲',
  kishotenketsu: '严格按以下四段组织大纲',
  multi_thread: '按多条故事线并行推进的方式组织大纲',
  freeform: '不限定特定叙事框架，根据故事内容自然编排；插叙、倒叙、片段式叙事只在服务于故事时使用',
};

/**
 * 按累计百分比把 1..total 切成连续的几段。
 *
 * - 章数够分时每段至少一章：第 i 段的终点取 `round(total × p_i)`，但不早于上一段终点 + 1，
 *   也不晚到让后面几段一章都分不到。
 * - 章数比段数还少（二十章写十五拍）时允许相邻几段共用一章——不然只能丢掉几拍，
 *   而那几拍恰恰是结构本身。
 *
 * 两种情形都保证连续、首章是 1、末章是 total。
 */
export function allocateStages(total: number, ends: readonly number[]): Array<{ from: number; to: number }> {
  const n = ends.length;
  const t = Math.max(1, Math.floor(total));
  const out: Array<{ from: number; to: number }> = [];
  if (n === 0) {
    return out;
  }
  if (t >= n) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const target = i === n - 1 ? t : Math.round(t * ends[i]);
      const to = Math.max(prev + 1, Math.min(target, t - (n - 1 - i)));
      out.push({ from: prev + 1, to });
      prev = to;
    }
    return out;
  }
  let prevTo = 0;
  for (let i = 0; i < n; i++) {
    const target = i === n - 1 ? t : Math.max(1, Math.round(t * ends[i]));
    const to = Math.max(prevTo, Math.min(target, t));
    const from = to > prevTo ? prevTo + 1 : Math.max(1, to);
    out.push({ from, to: Math.max(from, to) });
    prevTo = Math.max(prevTo, to);
  }
  return out;
}

/** 某种结构在这本书里的切分。结构缺席时按三幕算（上游 `default` 分支同样如此）。 */
export function structureStages(structure: PlotStructure | undefined, totalChapters: number): StructureStage[] {
  const specs = SPECS[structure ?? 'three_act'] ?? SPECS.three_act;
  const ranges = allocateStages(totalChapters, specs.map((s) => s.end));
  return specs.map((s, i) => ({ name: s.name, hint: s.hint, ...ranges[i] }));
}

/** 与 [from, to] 相交的那几段——告诉模型本批落在结构的哪里。 */
export function structureStagesIn(stages: readonly StructureStage[], range: { from: number; to: number }): StructureStage[] {
  return stages.filter((s) => s.from <= range.to && s.to >= range.from);
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 注入大纲层的那段指导文字。
 *
 * `range` 给了就在末尾点明「本次只写哪几章、它们落在哪几段」；这一句比整张表更要紧：
 * 分批写大纲时，模型最常见的错是把第 1–20 章写成全书的缩略版。
 */
export function structureGuideText(
  structure: PlotStructure | undefined,
  totalChapters: number,
  range?: { from: number; to: number }
): string {
  const key = structure ?? 'three_act';
  const stages = structureStages(key, totalChapters);
  const lines = [
    `【${PLOT_STRUCTURE_LABEL[key]}】（${LEAD[key]}）`,
    `全书共 ${totalChapters} 章，建议章节分配：`,
    ...stages.map((s) => `- ${s.name}（${span(s.from, s.to)}）：${s.hint}`),
  ];
  if (range) {
    const inside = structureStagesIn(stages, range);
    if (inside.length > 0) {
      lines.push(
        '',
        `本次只写${span(range.from, range.to)}，它们落在：${inside.map((s) => `${s.name}（${span(s.from, s.to)}）`).join('、')}。` +
          '按这几段该完成的事展开，不要把后面的结构节点提前写掉。'
      );
    }
  }
  return lines.join('\n');
}

/** 叙事视角的中文说法；缺席时 undefined，调用方决定写不写。 */
export function povLabel(pov: NarrativePov | undefined): string | undefined {
  return pov ? NARRATIVE_POV_LABEL[pov] : undefined;
}
