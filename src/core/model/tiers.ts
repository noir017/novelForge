/**
 * 模型分档：把「哪个模型干哪种活」变成配置。
 *
 * 工程页的后台任务在难度与调用量上差得很远：
 *
 * - 「把 76 章正文各总结一遍」是 76 次调用，每次只看一章、输出固定结构；
 * - 「把几十份阶段摘要合并成一份全文大纲」全书只调一次，却要跨几十万字取舍主线。
 *
 * 两者用同一个模型，作者只能在「贵而好」与「省而糙」之间二选一。分档就是
 * 让前者走便宜模型、后者走聪明模型：**简单大量的活省钱，困难的活花钱**。
 *
 * 三档各是一份**有序清单**，与 `config.models` 同构，因此模型池的既有能力
 * （串行恒用首选、失败随机换人、并发轮转负载均衡）在档内原样保留。
 *
 * 两条硬约束：
 *
 * 1. **空档位继承 `config.models`**。三档都没配时，每个任务取到的清单与分档
 *    之前逐字节一致——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。
 * 2. **对话页续写不在此列**。它严格用作者在下拉框里选定的那个模型（`models[0]`），
 *    中途换人会让文风断掉。这里的档位只作用于工程页的后台任务。
 *
 * 唯一的例外是**转写**（`transcribe`，2026-10-25 起，细纲试点之后推到全部结构化产物）：干活的模型按格式写好自然语言
 * 之后，由它把原文照抄成程序要的 JSON（features/transcribe.ts）。它不写内容，对话页与工程页都走它这一档，作者在确认框上
 * 为这一次指定的模型也不管它（作者定的：固定的转写模型）。
 */

/** 三档智能水平。顺序即由省到贵。 */
export type ModelTier = 'fast' | 'balanced' | 'quality';

export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'quality'];

/** 档位的中文名。设置页、确认框、日志共用这一份，不在前端另写。 */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: '快速档',
  balanced: '均衡档',
  quality: '精标档',
};


/** 档位说明，只给设置页用。 */
export const TIER_HINT: Record<ModelTier, string> = {
  fast: '便宜、快，用于量大而单次简单的活',
  balanced: '折中，用于量不小但质量也要紧的活',
  quality: '最聪明的模型，用于一次定调、错了代价大的活',
};

/**
 * 会调模型的后台任务。
 *
 * 粒度按「难度是否不同」切，而不是按功能切——`rebuildGlobalSummary` 一个功能
 * 里的分批汇总与最终合并难度差一个数量级，因此拆成两项；反过来，角色卡的
 * 单卡更新 / 批量更新 / 批量建卡干的是同一件事，合成一项。
 */
export type LlmTask =
  | 'plotSummary'
  | 'globalSummaryStage'
  | 'globalSummaryMerge'
  | 'setting'
  | 'plotOutline'
  | 'manuscript'
  | 'review'
  | 'loreScan'
  | 'loreSynthesis'
  | 'characterCard'
  | 'extractCharacters'
  | 'extractStyle'
  | 'transcribe';

export const LLM_TASKS: LlmTask[] = [
  'plotSummary',
  'globalSummaryStage',
  'globalSummaryMerge',
  'setting',
  'plotOutline',
  'manuscript',
  'review',
  'loreScan',
  'loreSynthesis',
  'characterCard',
  'extractCharacters',
  'extractStyle',
  'transcribe',
];

/** 任务的中文名。确认框与日志里出现的就是它。 */
export const TASK_LABEL: Record<LlmTask, string> = {
  plotSummary: '同步 · 照正文更新细纲',
  globalSummaryStage: '全文大纲 · 分批汇总',
  globalSummaryMerge: '全文大纲 · 最终合并',
  setting: '故事架构',
  plotOutline: '剧情细纲',
  manuscript: '批量写正文',
  review: '批量审稿',
  loreScan: '设定 · 记设定',
  loreSynthesis: '设定 · 建条目与整合',
  characterCard: '角色卡 · 更新 / 建卡',
  extractCharacters: '提取角色',
  extractStyle: '提取文风',
  transcribe: '转写 · 整理成 JSON',
};

/** 设置页那张表里每行的补充说明：这活为什么归在这一档。 */
export const TASK_HINT: Record<LlmTask, string> = {
  plotSummary: '一章一次调用，几十上百次；输入只有单章正文与它的细纲，输出是固定结构。批量同步时认叙事线事件、更新当前进度、归并也走这一档',
  globalSummaryStage: '每批一次调用，批数多且各批独立',
  globalSummaryMerge: '全书只调一次，要跨几十万字取舍主线',
  setting: '配置、前提、角色图谱、世界观各一次（角色图谱分两步）；全书只跑一次，后面每一章都吃它',
  plotOutline: '每批 5 章一次调用；要在大纲与前后章之间排出这几章的关键事件与看点，写歪了后面全歪。从情节大纲排叙事线也走这一档',
  manuscript: '一章一次调用，是最烧 token 的活；文风与语气全看它',
  review: '批量写章「写完即审稿」时一章一次；要逐字引正文、判细纲的每一项落实了没有，判错了作者会照着去改',
  loreScan: '单独记一章、补记老章节时一章一次：读正文，只记下出现了哪些设定（同步时顺手记的那份不走这一档）',
  loreSynthesis: '建条目、整合每条一次，要合并同步过的章里的记录且不能推翻作者写的内容；按目录整理也走这一档',
  characterCard: '按出场章分批精炼，产物每次续写都注入上下文',
  extractCharacters: '一次调用定「谁是谁」，判错会污染整个角色体系',
  extractStyle: '一次调用，产出的文风指南每次续写都注入',
  transcribe:
    '干活的模型按格式写自然语言（细纲、同步、叙事线、角色卡、设定、审稿……），写完由这一档照抄成 JSON：只搬不写，每段文字都得出自原文。每一步多一次调用；对话页与工程页都用它，确认框上为这一次换的模型不管它',
};

/**
 * 内置默认映射。
 *
 * 判据是「调用次数 × 单次难度」：次数多而单次简单的归快速档，
 * 次数少而一次定调的归精标档。作者可在设置页逐项改。
 *
 * 两处需要解释：
 *
 * - **细纲归均衡档**：它每批 5 章一次调用，量不算大，但决定这几章讲什么、怎么转，
 *   **写歪了那几章的正文整篇跟着歪**，而正文是最贵的一项。这一格省下来的钱
 *   会在下一格翻倍还回去。
 * - **批量写正文归均衡档**：它是量最大也最贵的一项，但正文的文风与语气直接
 *   决定成品质量，压到快速档等于用便宜模型写整本书。归均衡是折中——真要
 *   省钱或真要质量，作者在设置页改一格就行，而默认值不该替他做这个取舍。
 */
export const DEFAULT_TASK_TIERS: Record<LlmTask, ModelTier> = {
  plotSummary: 'fast',
  globalSummaryStage: 'fast',
  loreScan: 'fast',
  loreSynthesis: 'balanced',
  characterCard: 'balanced',
  setting: 'quality',
  plotOutline: 'balanced',
  manuscript: 'balanced',
  review: 'balanced',
  globalSummaryMerge: 'quality',
  extractCharacters: 'quality',
  extractStyle: 'quality',
  transcribe: 'fast',
};

/** 三档的模型清单，归一化后的完整形状（每档都在，可能是空数组）。 */
export type TierModels = Record<ModelTier, string[]>;

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as string[]).includes(value);
}

export function isLlmTask(value: unknown): value is LlmTask {
  return typeof value === 'string' && (LLM_TASKS as string[]).includes(value);
}

/** 该任务归在哪一档：作者的覆盖优先，否则用内置默认。 */
export function tierOf(config: TierConfig, task: LlmTask): ModelTier {
  const override = config.taskTiers?.[task];
  // 非法档位名（手改配置文件写错、旧版本留下的键）退回默认，不抛。
  return isModelTier(override) ? override : DEFAULT_TASK_TIERS[task];
}

/** `refsForTask` 只需要配置里的这几项，收窄依赖便于单测。 */
export interface TierConfig {
  models: string[];
  tierModels: TierModels;
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  /** 作者在确认框上为这一次指定的模型（`readConfig()` 从调用链上取，见 runtime/callScope.ts）。 */
  pinnedModel?: string;
}

export interface TaskModels {
  tier: ModelTier;
  /** 该任务实际要用的引用清单，按顺序。 */
  refs: string[];
  /** true 表示该档没配模型，这份清单是从「默认模型」继承来的。 */
  inherited: boolean;
  /** true 表示作者为这一次指定了模型：清单只有它一个，不按档、不换人。 */
  pinned: boolean;
}

/**
 * 某个任务实际该用哪些模型。
 *
 * **确认框与日志的文案必须从这里取**，不能再打印 `config.models`——
 * 弹窗写着一个模型、实际跑另一个，是「不偷偷烧 token」这条产品承诺的反面。
 *
 * 作者在确认框上指定了模型（`pinnedModel`）就只给它：选了谁就是谁，与对话页同一条规矩。转写（`transcribe`）除外，
 * 它固定按档走（见文件头）。
 */
export function refsForTask(config: TierConfig, task: LlmTask): TaskModels {
  const tier = tierOf(config, task);
  if (config.pinnedModel && task !== 'transcribe') {
    return { tier, refs: [config.pinnedModel], inherited: false, pinned: true };
  }
  const refs = config.tierModels[tier] ?? [];
  if (refs.length > 0) {
    return { tier, refs, inherited: false, pinned: false };
  }
  return { tier, refs: config.models, inherited: true, pinned: false };
}

/**
 * 保存设置时写进日志的分档摘要。
 *
 * 只报配过的档与改过的归属：三档全空时就是「未分档」一句话，
 * 免得每次保存都在日志里刷八行没人改过的默认值。
 */
export function describeTierConfig(
  tierModels: TierModels,
  taskTiers: Partial<Record<LlmTask, ModelTier>>
): string {
  const configured = MODEL_TIERS.filter((t) => (tierModels[t] ?? []).length > 0).map(
    (t) => `${TIER_LABEL[t]} ${tierModels[t].join('、')}`
  );
  const overrides = Object.entries(taskTiers).filter(([task, tier]) => isLlmTask(task) && isModelTier(tier));
  if (configured.length === 0 && overrides.length === 0) {
    return '未分档（全部任务用默认模型）';
  }
  const parts = [configured.length > 0 ? configured.join('／') : '三档均未配置'];
  if (overrides.length > 0) {
    parts.push(
      `${overrides.length} 项任务改过归属（${overrides
        .map(([task, tier]) => `${TASK_LABEL[task as LlmTask]}→${TIER_LABEL[tier as ModelTier]}`)
        .join('、')}）`
    );
  }
  return parts.join('｜');
}

/** 给确认框和日志用的一句话，如「快速档（未配置，沿用默认模型）」「这一次指定」。 */
export function describeTier(picked: TaskModels): string {
  if (picked.pinned) {
    return '这一次指定';
  }
  return picked.inherited ? `${TIER_LABEL[picked.tier]}（未配置，沿用默认模型）` : TIER_LABEL[picked.tier];
}

/**
 * 确认框里那一行「这活交给谁做」。
 *
 * 调模型之前的确认框（`features/askCall.ts`）在「按分档」下面逐项列它，因为它们都要回答同一个问题，
 * 而**说错的代价是用户以为省了钱其实没省**（或反过来）。所以档位、实际模型清单、会不会换人、
 * 是不是继承来的，四件事都写在这里。
 */
export function describeTaskModels(config: TierConfig, task: LlmTask): string {
  const picked = refsForTask(config, task);
  if (picked.refs.length === 0) {
    return `${TASK_LABEL[task]}：${TIER_LABEL[picked.tier]}（还没有可用的模型）`;
  }
  const fallback = picked.refs.length > 1 ? '（失败会自动换用同档其余模型重试）' : '';
  return `${TASK_LABEL[task]} → ${describeTier(picked)}：${picked.refs.join('、')}${fallback}`;
}
