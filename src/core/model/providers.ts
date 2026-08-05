/**
 * 多服务商 / 多模型的数据模型。
 *
 * 一个模型用「前缀/模型名」引用：
 *   glm/glm-4-plus              智谱官方的 glm-4-plus
 *   openrouter/z-ai/glm-4.6     OpenRouter 上的同一个模型
 *
 * 前缀是服务商的 id，模型名是原样传给 API 的字符串——它自己可以含斜杠
 * （OpenRouter 的模型名本就是 `vendor/model`），所以引用只在**第一个**
 * 斜杠处切分。
 */

export type ProviderKind = 'openai' | 'anthropic' | 'vscode-lm';

/** 某个服务商下的一个模型。 */
export interface ModelEntry {
  /** 原样传给 API 的模型名，可以含斜杠。 */
  name: string;
  /** 列表里的显示名，留空则显示模型名本身。 */
  label?: string;
  /** 该模型的上下文窗口；留空则用全局默认值。 */
  contextWindow?: number;
  /** 该模型的最大输出 token；留空则用全局默认值。 */
  maxOutputTokens?: number;
}

/** 一个服务商（一组共享 baseUrl 与 API Key 的模型）。 */
export interface ProviderProfile {
  /** 引用前缀。不能含斜杠，否则引用无法切分。 */
  id: string;
  label?: string;
  kind: ProviderKind;
  /** 留空时按 kind 取默认值。vscode-lm 不用。 */
  baseUrl?: string;
  models: ModelEntry[];
}

/** 解析成功的当前模型。 */
export interface ActiveModel {
  ref: string;
  profile: ProviderProfile;
  model: ModelEntry;
}

/** 供下拉框展示的一项。 */
export interface ModelChoice {
  ref: string;
  /** 模型的显示名。 */
  label: string;
  /** 所属服务商的显示名，用作分组标题。 */
  group: string;
  kind: ProviderKind;
  contextWindow?: number;
}

/** id 只允许这些字符——关键是不能有斜杠。 */
export const PROVIDER_ID_RE = /^[A-Za-z0-9._-]+$/;

export function defaultBaseUrl(kind: ProviderKind): string {
  switch (kind) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'vscode-lm':
      return '';
    default:
      return 'https://api.openai.com/v1';
  }
}

export function providerLabel(profile: ProviderProfile): string {
  return profile.label?.trim() || profile.id;
}

export function modelLabel(model: ModelEntry): string {
  return model.label?.trim() || model.name;
}

export function makeModelRef(providerId: string, modelName: string): string {
  return `${providerId}/${modelName}`;
}

/**
 * 拆分模型引用。
 *
 * 只在第一个斜杠处切——后面的斜杠属于模型名。
 * `openrouter/z-ai/glm-4.6` → { providerId: 'openrouter', model: 'z-ai/glm-4.6' }
 */
export function parseModelRef(ref: string): { providerId: string; model: string } | undefined {
  const trimmed = (ref ?? '').trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const providerId = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1).trim();
  if (!model) {
    return undefined;
  }
  return { providerId, model };
}

/**
 * 容错读取用户配置里的服务商列表。
 *
 * settings.json 是手写的，什么都可能出现。非法条目直接跳过而不是抛错——
 * 一个写错的服务商不该让整个插件用不了。
 */
export function normalizeProviders(raw: unknown): ProviderProfile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ProviderProfile[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const o = entry as Partial<ProviderProfile>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || !PROVIDER_ID_RE.test(id) || seen.has(id)) {
      continue;
    }
    const kind: ProviderKind =
      o.kind === 'anthropic' || o.kind === 'vscode-lm' ? o.kind : 'openai';
    const models = normalizeModels(o.models);
    if (models.length === 0) {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined,
      kind,
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl.trim() ? trimSlash(o.baseUrl) : undefined,
      models,
    });
  }
  return out;
}

function normalizeModels(raw: unknown): ModelEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    // 允许简写成纯字符串：models: ["gpt-4o", "gpt-4o-mini"]
    const o = typeof entry === 'string' ? { name: entry } : (entry as Partial<ModelEntry> | null);
    if (!o || typeof o !== 'object') {
      continue;
    }
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push({
      name,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined,
      contextWindow: positive(o.contextWindow),
      maxOutputTokens: positive(o.maxOutputTokens),
    });
  }
  return out;
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

/** 按引用找模型。找不到返回 undefined，由调用方决定怎么提示。 */
export function resolveModelRef(providers: ProviderProfile[], ref: string): ActiveModel | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed) {
    return undefined;
  }
  const profile = providers.find((p) => p.id === parsed.providerId);
  const model = profile?.models.find((m) => m.name === parsed.model);
  if (!profile || !model) {
    return undefined;
  }
  return { ref: makeModelRef(profile.id, model.name), profile, model };
}

/** 第一个可用模型的引用，用作未指定时的默认值。 */
export function firstModelRef(providers: ProviderProfile[]): string {
  for (const profile of providers) {
    const model = profile.models[0];
    if (model) {
      return makeModelRef(profile.id, model.name);
    }
  }
  return '';
}

/**
 * 全部可选模型，按配置顺序。
 * @param includeVscodeLm 独立版没有 Copilot 授权，传 false 过滤掉 vscode-lm 模型。
 */
export function listModelChoices(providers: ProviderProfile[], includeVscodeLm = true): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const profile of providers) {
    if (!includeVscodeLm && profile.kind === 'vscode-lm') {
      continue;
    }
    for (const model of profile.models) {
      out.push({
        ref: makeModelRef(profile.id, model.name),
        label: modelLabel(model),
        group: providerLabel(profile),
        kind: profile.kind,
        contextWindow: model.contextWindow,
      });
    }
  }
  return out;
}

/**
 * 引用解析失败时，说清楚是哪一步不对、可选的有哪些。
 * 「模型不可用」这种错误如果不指名道姓，用户只能靠猜。
 */
export function describeModelIssue(providers: ProviderProfile[], ref: string): string {
  if (providers.length === 0) {
    return '还没有配置任何服务商。打开侧边栏「设置」页添加一个，或运行命令「Novel: 打开设置页」。';
  }
  const trimmed = (ref ?? '').trim();
  if (!trimmed) {
    return `还没有选择模型。可选：${sample(providers)}`;
  }
  const parsed = parseModelRef(trimmed);
  if (!parsed) {
    return `模型引用「${trimmed}」格式不对，应为「服务商前缀/模型名」，例如 ${sample(providers)}`;
  }
  const profile = providers.find((p) => p.id === parsed.providerId);
  if (!profile) {
    return `找不到服务商前缀「${parsed.providerId}」。已配置的前缀：${providers
      .map((p) => p.id)
      .join('、')}`;
  }
  return `服务商「${providerLabel(profile)}」下没有模型「${parsed.model}」。它已配置的模型：${profile.models
    .map((m) => makeModelRef(profile.id, m.name))
    .join('、')}`;
}

function sample(providers: ProviderProfile[]): string {
  return (
    listModelChoices(providers)
      .slice(0, 3)
      .map((c) => c.ref)
      .join('、') || 'glm/glm-4-plus'
  );
}

// ---------------------------------------------------------------- 旧配置兼容

/** 0.1.x 的单服务商配置。 */
export interface LegacyProviderConfig {
  provider: string;
  openaiBaseUrl: string;
  openaiModel: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  vscodeLmFamily: string;
}

/**
 * 从 0.1.x 的单服务商设置生成一份服务商列表。
 *
 * 只在 `novel.providers` 为空时用作兜底——老用户升级后不该发现模型没了。
 * 不写回 settings.json：用户一旦在设置页保存过，就以新结构为准。
 */
export function seedFromLegacy(legacy: LegacyProviderConfig): {
  providers: ProviderProfile[];
  activeRef: string;
} {
  const providers: ProviderProfile[] = [];

  if (legacy.openaiModel.trim()) {
    providers.push({
      id: 'openai',
      label: 'OpenAI 兼容接口',
      kind: 'openai',
      baseUrl: trimSlash(legacy.openaiBaseUrl) || defaultBaseUrl('openai'),
      models: [{ name: legacy.openaiModel.trim() }],
    });
  }
  if (legacy.anthropicModel.trim()) {
    providers.push({
      id: 'anthropic',
      label: 'Anthropic',
      kind: 'anthropic',
      baseUrl: trimSlash(legacy.anthropicBaseUrl) || defaultBaseUrl('anthropic'),
      models: [{ name: legacy.anthropicModel.trim() }],
    });
  }
  if (legacy.vscodeLmFamily.trim()) {
    providers.push({
      id: 'copilot',
      label: 'VS Code 语言模型',
      kind: 'vscode-lm',
      models: [{ name: legacy.vscodeLmFamily.trim() }],
    });
  }

  const wanted =
    legacy.provider === 'anthropic' ? 'anthropic' : legacy.provider === 'vscode-lm' ? 'copilot' : 'openai';
  const active = providers.find((p) => p.id === wanted) ?? providers[0];
  return {
    providers,
    activeRef: active ? makeModelRef(active.id, active.models[0].name) : '',
  };
}
