import { firstModelRef, normalizeProviders, resolveModelRef, seedFromLegacy } from './model/providers';
import { scoped } from './logger';
import { NovelConfig } from './model/types';
import { isLlmTask, isModelTier, LlmTask, MODEL_TIERS, ModelTier, TierModels } from './model/tiers';

const log = scoped('配置');

/** 并发与 fallback 的取值范围。超出一律 clamp，并说明一次。 */
export const CONCURRENCY_RANGE = { min: 1, max: 16, def: 3 };
export const FALLBACK_RANGE = { min: 0, max: 5, def: 2 };

/**
 * 配置读取层。数据源由宿主注入（ConfigStore），core 不再直接碰
 * vscode.workspace.getConfiguration。
 */

/** 落盘的设置形状（与 SettingsPayload 对齐，另加 chaptersDir）。 */
export interface PersistedSettings {
  providers?: unknown[];
  /**
   * 默认模型列表，按顺序，第一个是首选。工程页的后台任务从这里取模型。
   *
   * 与 `model` 的关系：`model` 恒等于 `models[0]`，两者都写盘——
   * 前者是 0.2.x 就有的键（对话页下拉、上下文装配都读它），
   * 后者是本版新增的。只有 `model` 的旧配置会被自动升级成单元素列表。
   */
  models?: string[];
  model?: string;
  /**
   * 三档（快速 / 均衡 / 精标）各自的模型清单，与 `models` 同构。
   *
   * 某一档为空 = 该档的任务沿用 `models`。三档都空则整个分档不生效，
   * 行为与分档之前完全一致（见 model/tiers.ts 的两条硬约束）。
   */
  tierModels?: Record<string, unknown>;
  /**
   * 任务 → 档位的**覆盖**。只存与内置默认（`DEFAULT_TASK_TIERS`）不同的项，
   * 这样日后调整默认值时，没动过的任务会跟着新默认走。
   */
  taskTiers?: Record<string, unknown>;
  /** 工程页批量任务的并发请求数。 */
  concurrency?: number;
  /** 一次调用失败后，换模型重试的次数上限。 */
  fallbackAttempts?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  recentChaptersFullText?: number;
  prevChapterTailChars?: number;
  chaptersDir?: string;
  draftsDir?: string;
  summaryBatchSize?: number;
  requestTimeoutMs?: number;
}

export interface ConfigStore {
  /** 未迁移/未保存过时返回 undefined。 */
  read(): PersistedSettings | undefined;
  write(settings: PersistedSettings): Promise<void>;
}

/**
 * 0.1.x 遗留配置读取器。VS Code 壳注入（读 settings.json 的 novel.*），
 * 用于尚未迁移到 ~/.novelforge/config.json 的老用户；独立版不注入。
 */
export interface LegacyConfigReader { read(): PersistedSettings; }

let store: ConfigStore | undefined;
let legacy: LegacyConfigReader | undefined;

/** 由 initHost 调用：配置跟随宿主。 */
export function initConfigFromHost(host: { config: ConfigStore }): void {
  store = host.config;
}

export function setLegacyConfigReader(reader: LegacyConfigReader): void {
  legacy = reader;
}

function raw(): PersistedSettings {
  return store?.read() ?? legacy?.read() ?? {};
}

export function readConfig(): NovelConfig {
  const c = raw();
  let providers = normalizeProviders(c.providers ?? []);
  let models = normalizeModelList(c.models);
  let model = (c.model ?? '').trim();

  // 0.1.x 的单服务商设置。只在新结构为空且宿主提供了遗留读取器时兜底，
  // 不写回磁盘——用户一旦在设置页保存过，就以 providers 为准。
  if (providers.length === 0 && legacy) {
    const seeded = seedFromLegacyRaw(c);
    providers = seeded.providers;
    if (!model) {
      model = seeded.activeRef;
    }
  }
  // 只有 `model` 的旧配置自动升级成单元素列表；两者都空则取第一个可用模型。
  if (models.length === 0) {
    models = normalizeModelList([model || firstModelRef(providers)]);
  }
  // 列表是唯一真相：`model` 恒等于首项。
  model = models[0] ?? '';

  const active = resolveModelRef(providers, model);
  const globalWindow = c.contextWindow ?? 128000;
  const globalOutput = c.maxOutputTokens ?? 4096;

  return {
    providers,
    models,
    model,
    active,
    tierModels: normalizeTierModels(c.tierModels),
    taskTiers: normalizeTaskTiers(c.taskTiers),
    // 模型自带的窗口优先——同一个服务商下 32k 和 200k 的模型常常并存。
    contextWindow: active?.model.contextWindow ?? globalWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? globalOutput,
    temperature: c.temperature ?? 0.8,
    recentChaptersFullText: c.recentChaptersFullText ?? 2,
    prevChapterTailChars: c.prevChapterTailChars ?? 1500,
    chaptersDir: c.chaptersDir ?? 'chapters',
    draftsDir: c.draftsDir ?? 'drafts',
    summaryBatchSize: c.summaryBatchSize ?? 15,
    requestTimeoutMs: c.requestTimeoutMs ?? 300000,
    concurrency: clamp('并发请求数', c.concurrency, CONCURRENCY_RANGE),
    fallbackAttempts: clamp('换模型重试次数', c.fallbackAttempts, FALLBACK_RANGE),
  };
}

/**
 * 默认模型列表的容错读取：去空、去重、保序。
 *
 * **不**在这里剔除解析不出的引用——保留才能让设置页说清「这个模型没了」，
 * 与 `model` 的处理一致（模型池会在构造时剔除并 warn）。
 */
export function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return typeof raw === 'string' && raw.trim() ? [raw.trim()] : [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const ref = typeof entry === 'string' ? entry.trim() : '';
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * 三档模型清单的容错读取。每档都走 `normalizeModelList`（去空、去重、保序），
 * 缺席或类型不对的档退化为空数组 = 该档沿用默认模型清单。
 *
 * 与 `models` 一致，这里**不**剔除解析不出的引用——留着才能让设置页说清
 * 「这个模型没了」，模型池会在构造时剔除并 warn。
 */
export function normalizeTierModels(raw: unknown): TierModels {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as TierModels;
  for (const tier of MODEL_TIERS) {
    out[tier] = normalizeModelList(source[tier]);
  }
  return out;
}

/**
 * 任务 → 档位覆盖的容错读取。
 *
 * 认不出的任务名（旧版本留下的键、手改配置写错）与非法档位名一律丢弃，
 * 那一项回落内置默认。配置文件被手改坏不该让工程页任务无法启动。
 */
export function normalizeTaskTiers(raw: unknown): Partial<Record<LlmTask, ModelTier>> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<LlmTask, ModelTier>> = {};
  for (const [task, tier] of Object.entries(source)) {
    if (isLlmTask(task) && isModelTier(tier)) {
      out[task] = tier;
    }
  }
  return out;
}

/**
 * 数字设置项收进合法区间。
 *
 * readConfig 每次推状态都会跑，所以「被 clamp 了」只说一次：
 * 同一个越界值反复刷屏会把日志页挤没。
 */
const clampWarned = new Map<string, unknown>();

function clamp(label: string, value: unknown, range: { min: number; max: number; def: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return range.def;
  }
  const n = Math.floor(value);
  const bounded = Math.min(range.max, Math.max(range.min, n));
  if (bounded !== n && clampWarned.get(label) !== n) {
    clampWarned.set(label, n);
    log.warn(`${label} 设为 ${n}，超出 ${range.min}~${range.max}，按 ${bounded} 生效`);
  }
  return bounded;
}


/** 设置页要显示的全局默认值（不被当前模型的覆盖值遮住）。 */
export function readGlobalBudget(): { contextWindow: number; maxOutputTokens: number } {
  const c = raw();
  return {
    contextWindow: c.contextWindow ?? 128000,
    maxOutputTokens: c.maxOutputTokens ?? 4096,
  };
}

/** 整体落盘（merge 后写）。 */
export async function updateSettings(patch: PersistedSettings): Promise<void> {
  if (!store) {
    throw new Error('配置后端尚未初始化');
  }
  // 合并的基线必须是**解析后**的配置，不能是 raw()。
  // config.json 还不存在时 raw() 来自 legacy reader，其中的 providers 可能缺席；
  // 直接 merge 会把只改一个字段（例如下拉框切模型）的写入变成
  // 「一份没有 providers 的 config.json」，此后 model 指向的服务商再也解析不出来。
  const merged = { ...effectiveSettings(), ...patch };
  // 「列表是唯一真相」的落盘保证：只改了 models 的补丁也要把 model 带上，
  // 否则磁盘上会留下一个指向旧首选的 model，被 0.2.x 的读取器当真。
  const models = normalizeModelList(merged.models);
  if (models.length > 0) {
    merged.models = models;
    merged.model = models[0];
  }
  await store.write(merged);
}

/**
 * 把某个模型提到默认模型列表的首位（= 切换当前模型）。
 *
 * 「列表是唯一真相」的唯一写入口：`model` 由 `models[0]` 决定，所以
 * **不能只写 `model`**——那会在下一次 `updateSettings` 时被首项盖回去。
 * 对话页的下拉框与命令面板的「选择模型」都走这里。
 */
export async function promoteModel(ref: string): Promise<string[]> {
  const target = ref.trim();
  const models = [target, ...readConfig().models.filter((m) => m !== target)];
  await updateSettings({ models, model: target });
  return models;
}

/**
 * 落盘用的完整快照：raw() 打底，再补上兜底推导出的 providers/models/model。
 * 保证任何一次写入都不会产出「有 model、没 providers」的配置，
 * 也不会产出「有 model、没 models」的半截列表。
 *
 * 顺手丢掉 0.1.x 的带点键：它们只是 legacy reader 的输入，写进
 * config.json 既无人读取，又会在 providers 日后被清空时重新触发兜底。
 */
function effectiveSettings(): PersistedSettings {
  const c = { ...raw() } as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (key.includes('.') || key === 'provider') {
      delete c[key];
    }
  }
  const settings = c as PersistedSettings;
  const config = readConfig();
  if (normalizeProviders(settings.providers ?? []).length === 0 && config.providers.length > 0) {
    settings.providers = config.providers;
  }
  if (normalizeModelList(settings.models).length === 0 && config.models.length > 0) {
    settings.models = config.models;
  }
  settings.model = normalizeModelList(settings.models)[0] ?? settings.model ?? config.model;
  return settings;
}

/** seedFromLegacy 原本吃 vscode 配置的分散键；这里接受扁平 raw。 */
function seedFromLegacyRaw(c: PersistedSettings) {
  // 遗留键（novel.provider / novel.openai.baseUrl 等）只会出现在 legacy reader
  // 的返回值里，因此把 raw 里的带点键直接透传给 providers.ts 的宽松入口。
  const flat = c as Record<string, unknown>;
  return seedFromLegacy({
    provider: (flat.provider as string | undefined) ?? 'openai',
    openaiBaseUrl: (flat['openai.baseUrl'] as string | undefined) ?? 'https://api.openai.com/v1',
    openaiModel: (flat['openai.model'] as string | undefined) ?? 'gpt-4o',
    anthropicBaseUrl: (flat['anthropic.baseUrl'] as string | undefined) ?? 'https://api.anthropic.com',
    anthropicModel: (flat['anthropic.model'] as string | undefined) ?? 'claude-sonnet-4-5',
    vscodeLmFamily: (flat['vscodeLm.family'] as string | undefined) ?? 'gpt-4o',
  });
}
