import { readConfig } from '../config';
import { getHost } from '../host';
import { scoped } from '../logger';
import {
  ActiveModel,
  ProviderProfile,
  defaultBaseUrl,
  describeModelIssue,
  listModelChoices,
  makeModelRef,
  providerLabel,
  resolveModelRef,
} from '../model/providers';
import { SecretStore } from '../stores';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAiProvider } from './openaiProvider';
import { LlmProvider } from './provider';

const log = scoped('模型');

/**
 * API Key 按服务商 id 存，不再按 kind——同一种协议下可以并存
 * 多个服务商（智谱官方、OpenRouter、本地 Ollama 都是 openai 兼容），
 * 它们各有各的 Key。
 */
function secretKey(providerId: string): string {
  return `novel-forge.apiKey.provider.${providerId}`;
}

/** 0.1.x 按 kind 存的两个 Key，用于一次性迁移。 */
const LEGACY_SECRET_KEYS: Record<string, string> = {
  openai: 'novel-forge.apiKey.openai',
  anthropic: 'novel-forge.apiKey.anthropic',
};

let secrets: SecretStore | undefined;

export function initSecrets(store: SecretStore): void {
  secrets = store;
}

/** vscode-lm 走 Copilot 授权，不需要 Key。 */
export function needsApiKey(profile: ProviderProfile): boolean {
  return profile.kind !== 'vscode-lm';
}

type ExtraProviderFactory = (active: ActiveModel) => LlmProvider | undefined;
let extraFactory: ExtraProviderFactory | undefined;

/** VS Code 壳启动时注册 vscode-lm provider 工厂（core 不反向依赖 vscode 层）。 */
export function registerProviderFactory(fn: ExtraProviderFactory): void {
  extraFactory = fn;
}

/**
 * 按当前设置构造 provider。缺 API Key 时会引导用户录入；
 * 模型引用无效或用户放弃录入则返回 undefined（调用方给出说明）。
 */
export async function resolveProvider(ref?: string): Promise<LlmProvider | undefined> {
  const config = readConfig();
  const active = ref ? resolveModelRef(config.providers, ref) : config.active;
  if (!active) {
    const issue = describeModelIssue(config.providers, ref ?? config.model);
    const wanted = ref ?? config.model;
    log.error(issue, `请求的引用 ${wanted || '（空）'}｜已配置 ${config.providers.length} 个服务商`);
    getHost().toast(`${issue}`, 'error');
    return undefined;
  }
  return buildProvider(active);
}

/** 已知模型时直接构造，不再读配置。 */
export async function buildProvider(
  active: ActiveModel,
  opts: BuildProviderOptions = {}
): Promise<LlmProvider | undefined> {
  const { profile, model } = active;
  const quiet = opts.promptForKey === false;

  if (profile.kind === 'vscode-lm') {
    const provider = extraFactory?.(active);
    if (!provider) {
      const detail = `引用 ${active.ref}`;
      if (quiet) {
        log.warn('当前环境不提供 VS Code 语言模型（Copilot）', detail);
      } else {
        log.error('当前环境不提供 VS Code 语言模型（Copilot）', detail);
      }
    }
    return provider;
  }

  const key = quiet ? await lookupApiKey(profile) : await ensureApiKey(profile);
  if (!key) {
    const message = `未取得「${providerLabel(profile)}」的 API Key`;
    // 静默构造用于备选模型：缺 Key 只是把它排除在池外，不是错误。
    if (quiet) {
      log.warn(message, `引用 ${active.ref}｜可在设置页录入后重新参与`);
    } else {
      log.error(message, `引用 ${active.ref}`);
    }
    return undefined;
  }
  const baseUrl = profile.baseUrl || defaultBaseUrl(profile.kind);
  log.debug(`构造 provider ${active.ref}`, `${profile.kind}｜${baseUrl}｜模型 ${model.name}`);
  return profile.kind === 'anthropic'
    ? new AnthropicProvider(baseUrl, model.name, key)
    : new OpenAiProvider(baseUrl, model.name, key);
}

export interface BuildProviderOptions {
  /**
   * 缺 API Key 时是否弹输入框引导录入。缺省 true（与用户点了某个动作的
   * 直觉一致）。**模型池构造备选模型时必须传 false**——一个池里有五个
   * 模型就连弹五个输入框，那比没有 fallback 还糟。
   */
  promptForKey?: boolean;
}

async function ensureApiKey(profile: ProviderProfile): Promise<string | undefined> {
  const existing = await lookupApiKey(profile);
  return existing ?? promptForApiKey(profile.id);
}

/**
 * 取某服务商的 Key。
 *
 * 找不到时回落到 0.1.x 按 kind 存的 Key，并顺手迁移到新键上——
 * 老用户升级后不该被要求重新输一遍。
 */
async function lookupApiKey(profile: ProviderProfile): Promise<string | undefined> {
  const store = requireSecrets();
  const current = await store.get(secretKey(profile.id));
  if (current) {
    return current;
  }
  const legacyKey = LEGACY_SECRET_KEYS[profile.id];
  if (!legacyKey) {
    return undefined;
  }
  const legacy = await store.get(legacyKey);
  if (legacy) {
    await store.set(secretKey(profile.id), legacy);
    await store.delete(legacyKey);
    log.info(`「${providerLabel(profile)}」的 API Key 已从 0.1.x 的键位迁移`);
  }
  return legacy ?? undefined;
}

/** 某个服务商是否已存过 Key——设置页据此显示状态，不回显 Key 本身。 */
export async function hasApiKey(providerId: string): Promise<boolean> {
  if (!secrets) {
    return false;
  }
  if (await secrets.get(secretKey(providerId))) {
    return true;
  }
  const legacyKey = LEGACY_SECRET_KEYS[providerId];
  return legacyKey ? !!(await secrets.get(legacyKey)) : false;
}

/** 每个服务商的 Key 状态，一次问完，设置页一次渲染。 */
export async function apiKeyStatus(providers: ProviderProfile[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const profile of providers) {
    out[profile.id] = needsApiKey(profile) ? await hasApiKey(profile.id) : true;
  }
  return out;
}

export async function promptForApiKey(providerId?: string): Promise<string | undefined> {
  const config = readConfig();
  const profile = providerId
    ? config.providers.find((p) => p.id === providerId)
    : config.active?.profile ?? (await pickProvider(config.providers, '为哪个服务商设置 API Key？'));

  if (!profile) {
    getHost().toast(
      `${describeModelIssue(config.providers, providerId ? `${providerId}/` : config.model)}`,
      'error'
    );
    return undefined;
  }
  if (!needsApiKey(profile)) {
    getHost().toast(`「${providerLabel(profile)}」使用 VS Code 语言模型（Copilot），无需 API Key。`);
    return undefined;
  }

  const host = profile.baseUrl || defaultBaseUrl(profile.kind);
  const value = await getHost().input({
    title: `设置「${providerLabel(profile)}」的 API Key`,
    prompt: `安全保存在本机密钥存储中，不会写入配置文件。接口地址：${host}`,
    password: true,
    placeHolder: profile.kind === 'anthropic' ? 'sk-ant-...' : 'sk-...',
    validate: (v) => (v.trim().length === 0 ? 'API Key 不能为空' : undefined),
  });

  if (!value) {
    log.info(`用户取消了「${providerLabel(profile)}」的 API Key 录入`);
    return undefined;
  }
  await requireSecrets().set(secretKey(profile.id), value.trim());
  log.info(`「${providerLabel(profile)}」的 API Key 已保存`, `接口地址 ${host}`);
  getHost().toast(`「${providerLabel(profile)}」的 API Key 已保存。`);
  return value.trim();
}

export async function clearApiKey(providerId?: string): Promise<void> {
  const store = requireSecrets();
  const config = readConfig();

  // 设置页会指名清哪个；从命令面板进来则要问一下。
  const profile = providerId
    ? config.providers.find((p) => p.id === providerId)
    : await pickProvider(config.providers.filter(needsApiKey), '清除哪个服务商的 API Key？');
  if (!profile) {
    return;
  }

  await store.delete(secretKey(profile.id));
  const legacyKey = LEGACY_SECRET_KEYS[profile.id];
  if (legacyKey) {
    await store.delete(legacyKey);
  }
  log.info(`已清除「${providerLabel(profile)}」的 API Key`);
  getHost().toast(`已清除「${providerLabel(profile)}」的 API Key。`);
}

/** 清掉配置里已不存在的服务商的 Key——删掉服务商后不该在钥匙串里留下孤儿。 */
export async function pruneApiKeys(providers: ProviderProfile[], removedIds: string[]): Promise<void> {
  if (!secrets || removedIds.length === 0) {
    return;
  }
  const alive = new Set(providers.map((p) => p.id));
  for (const id of removedIds) {
    if (!alive.has(id)) {
      await secrets.delete(secretKey(id));
      const legacyKey = LEGACY_SECRET_KEYS[id];
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
      log.info(`服务商「${id}」已删除，顺手清掉它的 API Key`);
    }
  }
}

async function pickProvider(
  providers: ProviderProfile[],
  title: string
): Promise<ProviderProfile | undefined> {
  if (providers.length === 0) {
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0];
  }
  return getHost().pick(
    providers.map((p) => ({
      label: providerLabel(p),
      description: p.id,
      detail: p.baseUrl || defaultBaseUrl(p.kind),
      value: p,
    })),
    title
  );
}

/** 命令面板里的模型切换器。 */
export async function pickModelRef(): Promise<string | undefined> {
  const config = readConfig();
  const choices = listModelChoices(config.providers, getHost().supportsVscodeLm);
  if (choices.length === 0) {
    getHost().toast(`${describeModelIssue(config.providers, config.model)}`, 'error');
    return undefined;
  }

  return getHost().pick(
    choices.map((choice) => ({
      label: choice.ref,
      description: choice.label !== choice.ref.slice(choice.ref.indexOf('/') + 1) ? choice.label : undefined,
      detail: choice.contextWindow ? `窗口 ${choice.contextWindow} token` : undefined,
      group: choice.group,
      value: choice.ref,
    })),
    '选择模型'
  );
}

export { makeModelRef };

function requireSecrets(): SecretStore {
  if (!secrets) {
    throw new Error('SecretStore 尚未初始化');
  }
  return secrets;
}
