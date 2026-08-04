import { firstModelRef, normalizeProviders, resolveModelRef, seedFromLegacy } from './model/providers';
import { NovelConfig } from './model/types';

/**
 * 配置读取层。数据源由宿主注入（ConfigStore），core 不再直接碰
 * vscode.workspace.getConfiguration。
 */

/** 落盘的设置形状（与 SettingsPayload 对齐，另加 chaptersDir）。 */
export interface PersistedSettings {
  providers?: unknown[];
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  recentChaptersFullText?: number;
  prevChapterTailChars?: number;
  chaptersDir?: string;
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
  if (!model) {
    model = firstModelRef(providers);
  }

  const active = resolveModelRef(providers, model);
  const globalWindow = c.contextWindow ?? 128000;
  const globalOutput = c.maxOutputTokens ?? 4096;

  return {
    providers,
    model,
    active,
    // 模型自带的窗口优先——同一个服务商下 32k 和 200k 的模型常常并存。
    contextWindow: active?.model.contextWindow ?? globalWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? globalOutput,
    temperature: c.temperature ?? 0.8,
    recentChaptersFullText: c.recentChaptersFullText ?? 2,
    prevChapterTailChars: c.prevChapterTailChars ?? 1500,
    chaptersDir: c.chaptersDir ?? 'chapters',
    summaryBatchSize: c.summaryBatchSize ?? 15,
    requestTimeoutMs: c.requestTimeoutMs ?? 300000,
  };
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
  await store.write({ ...raw(), ...patch });
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
