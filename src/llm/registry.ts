import * as vscode from 'vscode';
import { readConfig } from '../model/project';
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
import { AnthropicProvider } from './anthropicProvider';
import { OpenAiProvider } from './openaiProvider';
import { LlmProvider } from './provider';
import { VsCodeLmProvider } from './vscodeLmProvider';

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

let secrets: vscode.SecretStorage | undefined;

export function initSecrets(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

/** vscode-lm 走 Copilot 授权，不需要 Key。 */
export function needsApiKey(profile: ProviderProfile): boolean {
  return profile.kind !== 'vscode-lm';
}

/**
 * 按当前设置构造 provider。缺 API Key 时会引导用户录入；
 * 模型引用无效或用户放弃录入则返回 undefined（调用方给出说明）。
 */
export async function resolveProvider(ref?: string): Promise<LlmProvider | undefined> {
  const config = readConfig();
  const active = ref ? resolveModelRef(config.providers, ref) : config.active;
  if (!active) {
    void vscode.window.showErrorMessage(
      `Novel Forge：${describeModelIssue(config.providers, ref ?? config.model)}`
    );
    return undefined;
  }
  return buildProvider(active);
}

/** 已知模型时直接构造，不再读配置。 */
export async function buildProvider(active: ActiveModel): Promise<LlmProvider | undefined> {
  const { profile, model } = active;

  if (profile.kind === 'vscode-lm') {
    return new VsCodeLmProvider(model.name, providerLabel(profile));
  }

  const key = await ensureApiKey(profile);
  if (!key) {
    return undefined;
  }
  const baseUrl = profile.baseUrl || defaultBaseUrl(profile.kind);
  return profile.kind === 'anthropic'
    ? new AnthropicProvider(baseUrl, model.name, key)
    : new OpenAiProvider(baseUrl, model.name, key);
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
    await store.store(secretKey(profile.id), legacy);
    await store.delete(legacyKey);
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
    void vscode.window.showErrorMessage(
      `Novel Forge：${describeModelIssue(config.providers, providerId ? `${providerId}/` : config.model)}`
    );
    return undefined;
  }
  if (!needsApiKey(profile)) {
    void vscode.window.showInformationMessage(
      `Novel Forge：「${providerLabel(profile)}」使用 VS Code 语言模型（Copilot），无需 API Key。`
    );
    return undefined;
  }

  const host = profile.baseUrl || defaultBaseUrl(profile.kind);
  const value = await vscode.window.showInputBox({
    title: `Novel Forge：设置「${providerLabel(profile)}」的 API Key`,
    prompt: `将安全保存在 VS Code SecretStorage 中，不会写入 settings.json。接口地址：${host}`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: profile.kind === 'anthropic' ? 'sk-ant-...' : 'sk-...',
    validateInput: (v) => (v.trim().length === 0 ? 'API Key 不能为空' : undefined),
  });

  if (!value) {
    return undefined;
  }
  await requireSecrets().store(secretKey(profile.id), value.trim());
  void vscode.window.showInformationMessage(`Novel Forge：「${providerLabel(profile)}」的 API Key 已保存。`);
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
  void vscode.window.showInformationMessage(`Novel Forge：已清除「${providerLabel(profile)}」的 API Key。`);
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
  const picked = await vscode.window.showQuickPick(
    providers.map((p) => ({
      label: providerLabel(p),
      description: p.id,
      detail: p.baseUrl || defaultBaseUrl(p.kind),
      profile: p,
    })),
    { title }
  );
  return picked?.profile;
}

/** 命令面板里的模型切换器。 */
export async function pickModelRef(): Promise<string | undefined> {
  const config = readConfig();
  const choices = listModelChoices(config.providers);
  if (choices.length === 0) {
    void vscode.window.showErrorMessage(`Novel Forge：${describeModelIssue(config.providers, config.model)}`);
    return undefined;
  }

  const items: (vscode.QuickPickItem & { ref?: string })[] = [];
  let group = '';
  for (const choice of choices) {
    if (choice.group !== group) {
      group = choice.group;
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: choice.ref,
      description: choice.label !== choice.ref.slice(choice.ref.indexOf('/') + 1) ? choice.label : undefined,
      detail: choice.contextWindow ? `窗口 ${choice.contextWindow} token` : undefined,
      picked: choice.ref === config.model,
      ref: choice.ref,
    });
  }

  const picked = await vscode.window.showQuickPick(items, { title: '选择模型' });
  return picked?.ref;
}

export { makeModelRef };

function requireSecrets(): vscode.SecretStorage {
  if (!secrets) {
    throw new Error('SecretStorage 尚未初始化');
  }
  return secrets;
}
