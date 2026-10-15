/**
 * 上下文详细度：**每一次调用带多少前文与设定。**
 *
 * 与 `thinking.ts` 同一个位置的东西——级别、界面上的说法、每一级的上限在数据层定义一次
 * （纯数据 + 纯函数、零 import，所以前端可以直接打包这一份）。装配器的各层与后台任务
 * 只经 {@link contextLimitsOf} 取上限，不再各自写死常量。
 *
 * ## 为什么是全局设置
 *
 * 它是成本偏好，不是某一轮的难度：批量写章最费上下文，而批量不跟对话走。所以与
 * `trimModifiers` 一样存在 `~/.novelforge/config.json`，对话页、工程页批量、外部 agent
 * 三条路都经 `readConfig()` 拿到同一个值。
 *
 * ## 第 3 级就是从前的行为
 *
 * 「详细」那一行逐项等于这个开关出现之前写死的常量，只多了一条：更早章的摘要最多带最近
 * 60 章。从前这一层没有上限，长篇写到七八十章会把整个窗口填满。
 *
 * ## 不分级的东西
 *
 * - **后 5 章边界**（`AHEAD_PLOTS`）：它是「不许提前写」的边界，`planWriting` 算「本章不出场」
 *   也用同一个窗口，两边必须一致。
 * - **本章已写末尾**、**@ 引用**、**落定细纲时的历史**：前两样是这一次任务本身，后一样是
 *   `settle` 要沉淀的讨论。
 * - **单章摘要、全书摘要、角色状态、建卡、设定扫描**：输入就是那一章本身，或按窗口分批——
 *   调低只会截掉要整理的东西、或多拆几次调用，不会少花。
 *
 * 任何一级都不改调用次数（第 4 条）。
 */

export type ContextDetail = 1 | 2 | 3 | 4;

export const CONTEXT_DETAILS: ContextDetail[] = [1, 2, 3, 4];

/** 缺省「详细」：升级后除了更早章摘要封顶，别的一样不变。 */
export const DEFAULT_CONTEXT_DETAIL: ContextDetail = 3;

/** 下拉框、装配清单与日志共用这一份说法，前端不另写。 */
export const CONTEXT_DETAIL_LABEL: Record<ContextDetail, string> = {
  1: '精简',
  2: '标准',
  3: '详细',
  4: '完整',
};

export const CONTEXT_DETAIL_HINT: Record<ContextDetail, string> = {
  1: '只带写这一章必需的，最省 token；长篇前情主要靠全书摘要',
  2: '近一章全文、少量定稿原文片段，日常够用',
  3: '近两章全文、定稿原文片段、最近 60 章摘要（缺省）',
  4: '近三章全文、更多片段，摘要不封顶，窗口能装多少装多少',
};

/**
 * 一级的全部上限。**扁平**：测试覆盖某一项只是一层浅合并。
 *
 * 数字 0 = 不带；`Infinity` = 不限（只在核心里用，绝不经协议发给前端——
 * `JSON.stringify` 会把它变成 `null`）。
 */
export interface ContextLimits {
  /** 写正文第一次调用带前几章的正文全文（`manuscriptFull`）。 */
  readonly fullTextChapters: number;
  /** 上一章结尾原文带多少字（`prevTail`）。 */
  readonly prevTailChars: number;
  /** 更早章的摘要最多带最近几章（`plotSummary`，正文、大纲、细纲三张配方）。 */
  readonly summaryChapters: number;
  /** 定稿原文片段：前几章的连续性事实全取（`evidence`）。 */
  readonly evidenceRecent: number;
  /** 定稿原文片段：最多从几章里取。0 = 整层不带。 */
  readonly evidenceChapters: number;
  /** 定稿原文片段：一共多少字。 */
  readonly evidenceChars: number;
  /** 近章连续性事实最多从几章里取（`recentFacts`，以及写前冲突检查）。 */
  readonly factsChapters: number;
  /** 近章连续性事实一共多少字。 */
  readonly factsChars: number;
  /** 写正文时带几条叙事线（`threads`）。 */
  readonly threadCount: number;
  /** 叙事线一共多少字（只算各行）。 */
  readonly threadChars: number;
  /** 细纲阶段的前序细纲一览最多几章（`plotList`）。 */
  readonly plotListMax: number;
  /** 细纲单章：带前几章的细纲（`plotPrev`）。 */
  readonly prevPlots: number;
  /** 细纲单章：带后几章的细纲（`plotNext`）。 */
  readonly nextPlots: number;
  /** 对话历史最多占预算的几成（落定细纲另有固定的 0.6）。 */
  readonly historyCap: number;
  /** 角色卡一律只带身份 / 当前状态 / 未收伏笔。 */
  readonly essentialCards: boolean;
  /** 挑出场角色时看前几章摘要的「出场人物」。 */
  readonly castSummaries: number;
  /** 从已写正文补齐架构时均匀抽样几章（`written`）。 */
  readonly deriveSamples: number;
  /** 提取文风：默认勾前几章当样章（作者仍可改，最多 3 章）。 */
  readonly styleSamples: number;
  /** 提取角色：默认勾最近几章。 */
  readonly characterChapters: number;
  /** 从参考书学写法：文风抽样几章。 */
  readonly referenceSamples: number;
  /** 排叙事线：情节大纲最多带多少字。 */
  readonly threadPlanOutlineChars: number;
  /** 排叙事线：细纲一览里每章关键事件截到多长。 */
  readonly threadPlanEvents: number;
  /** 定稿判叙事线：最多送几条线去判。 */
  readonly threadJudge: number;
}

/** 每一级的上限。第 3 级逐项等于从前写死的常量（外加摘要封顶 60 章）。 */
export const CONTEXT_DETAIL_LIMITS: Readonly<Record<ContextDetail, ContextLimits>> = Object.freeze({
  1: Object.freeze({
    fullTextChapters: 0,
    prevTailChars: 1000,
    summaryChapters: 5,
    evidenceRecent: 0,
    evidenceChapters: 0,
    evidenceChars: 0,
    factsChapters: 6,
    factsChars: 1500,
    threadCount: 3,
    threadChars: 600,
    plotListMax: 30,
    prevPlots: 1,
    nextPlots: 1,
    historyCap: 0.15,
    essentialCards: true,
    castSummaries: 1,
    deriveSamples: 3,
    styleSamples: 1,
    characterChapters: 1,
    referenceSamples: 3,
    threadPlanOutlineChars: 4000,
    threadPlanEvents: 60,
    threadJudge: 6,
  }),
  2: Object.freeze({
    fullTextChapters: 1,
    prevTailChars: 1500,
    summaryChapters: 20,
    evidenceRecent: 3,
    evidenceChapters: 6,
    evidenceChars: 3000,
    factsChapters: 8,
    factsChars: 2000,
    threadCount: 4,
    threadChars: 900,
    plotListMax: 50,
    prevPlots: 2,
    nextPlots: 1,
    historyCap: 0.2,
    essentialCards: false,
    castSummaries: 2,
    deriveSamples: 4,
    styleSamples: 2,
    characterChapters: 2,
    referenceSamples: 4,
    threadPlanOutlineChars: 6000,
    threadPlanEvents: 90,
    threadJudge: 9,
  }),
  3: Object.freeze({
    fullTextChapters: 2,
    prevTailChars: 1500,
    summaryChapters: 60,
    evidenceRecent: 5,
    evidenceChapters: 12,
    evidenceChars: 6000,
    factsChapters: 12,
    factsChars: 3000,
    threadCount: 6,
    threadChars: 1200,
    plotListMax: 100,
    prevPlots: 3,
    nextPlots: 1,
    historyCap: 0.3,
    essentialCards: false,
    castSummaries: 2,
    deriveSamples: 5,
    styleSamples: 2,
    characterChapters: 3,
    referenceSamples: 5,
    threadPlanOutlineChars: 8000,
    threadPlanEvents: 120,
    threadJudge: 12,
  }),
  4: Object.freeze({
    fullTextChapters: 3,
    prevTailChars: 2000,
    summaryChapters: Infinity,
    evidenceRecent: 8,
    evidenceChapters: 20,
    evidenceChars: 10000,
    factsChapters: 20,
    factsChars: 5000,
    threadCount: 8,
    threadChars: 1800,
    plotListMax: Infinity,
    prevPlots: 5,
    nextPlots: 2,
    historyCap: 0.4,
    essentialCards: false,
    castSummaries: 3,
    deriveSamples: 8,
    styleSamples: 3,
    characterChapters: 5,
    referenceSamples: 8,
    threadPlanOutlineChars: 12000,
    threadPlanEvents: 200,
    threadJudge: 16,
  }),
});

export function isContextDetail(value: unknown): value is ContextDetail {
  return typeof value === 'number' && (CONTEXT_DETAILS as number[]).includes(value);
}

/** 容错读取：认不出（缺席、越界、小数、字符串）一律回落缺省，绝不抛。 */
export function normalizeContextDetail(value: unknown): ContextDetail {
  return isContextDetail(value) ? value : DEFAULT_CONTEXT_DETAIL;
}

/**
 * 取这一份配置的上限：级别那一行，再叠上 `contextOverrides`。
 *
 * **唯一的解析入口**。参数只要求这两个字段，测试里手写的半截配置（没有 `contextDetail`）
 * 照样拿到缺省那一行。`contextOverrides` 只给代码与测试用，不从 config.json 读——
 * 作者能动的只有级别（见 config.ts）。
 */
export function contextLimitsOf(config: {
  readonly contextDetail?: unknown;
  readonly contextOverrides?: Partial<ContextLimits>;
}): ContextLimits {
  const row = CONTEXT_DETAIL_LIMITS[normalizeContextDetail(config.contextDetail)];
  return config.contextOverrides ? { ...row, ...config.contextOverrides } : row;
}

/**
 * 取最后 n 个。n ≤ 0 是空，`Infinity` 是全部。
 *
 * 不直接写 `slice(-n)`：n 为 0 时 `slice(-0)` 等于 `slice(0)`，「一章都不带」会变成整份都带
 * （四期修过一次「注入完整原文章数设成 0」就是这个坑）。
 */
export function takeLast<T>(list: readonly T[], n: number): T[] {
  if (!(n > 0)) {
    return [];
  }
  return Number.isFinite(n) ? list.slice(-n) : list.slice();
}

/** 设置页说明行：这一级具体带多少。 */
export function describeContextDetail(detail: ContextDetail): string {
  const l = CONTEXT_DETAIL_LIMITS[detail];
  const n = (v: number, unit: string): string => (v === Infinity ? '不限' : v <= 0 ? '不带' : `${v} ${unit}`);
  return [
    `近章全文 ${n(l.fullTextChapters, '章')}`,
    `上一章结尾 ${n(l.prevTailChars, '字')}`,
    `更早章摘要 ${l.summaryChapters === Infinity ? '不限' : `最近 ${l.summaryChapters} 章`}`,
    `定稿原文片段 ${l.evidenceChapters <= 0 ? '不带' : `${l.evidenceChapters} 章内 ${l.evidenceChars} 字`}`,
    `叙事线 ${l.threadCount} 条`,
    `对话历史 ${Math.round(l.historyCap * 100)}%`,
    ...(l.essentialCards ? ['角色卡只带要点'] : []),
  ].join(' · ');
}
