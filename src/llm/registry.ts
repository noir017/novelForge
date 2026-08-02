import * as vscode from 'vscode';
import { readConfig } from '../model/project';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAiProvider } from './openaiProvider';
import { LlmProvider } from './provider';
import { VsCodeLmProvider } from './vscodeLmProvider';

const SECRET_KEYS = {
  openai: 'novel-forge.apiKey.openai',
  anthropic: 'novel-forge.apiKey.anthropic',
} as const;

let secrets: vscode.SecretStorage | undefined;

export function initSecrets(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

/**
 * 按当前设置构造 provider。缺 API Key 时会引导用户录入；
 * 用户放弃录入则返回 undefined（调用方静默结束，不报错）。
 */
export async function resolveProvider(): Promise<LlmProvider | undefined> {
  const config = readConfig();

  if (config.provider === 'vscode-lm') {
    return new VsCodeLmProvider(config.vscodeLmFamily);
  }

  const key = await ensureApiKey(config.provider);
  if (!key) {
    return undefined;
  }

  return config.provider === 'anthropic'
    ? new AnthropicProvider(config.anthropicBaseUrl, config.anthropicModel, key)
    : new OpenAiProvider(config.openaiBaseUrl, config.openaiModel, key);
}

async function ensureApiKey(provider: 'openai' | 'anthropic'): Promise<string | undefined> {
  const store = requireSecrets();
  const existing = await store.get(SECRET_KEYS[provider]);
  if (existing) {
    return existing;
  }
  return promptForApiKey(provider);
}

/** 某个服务商是否已存过 Key——设置页据此显示状态，不回显 Key 本身。 */
export async function hasApiKey(provider: 'openai' | 'anthropic'): Promise<boolean> {
  if (!secrets) {
    return false;
  }
  return !!(await secrets.get(SECRET_KEYS[provider]));
}

export async function promptForApiKey(provider?: 'openai' | 'anthropic'): Promise<string | undefined> {
  const target = provider ?? (readConfig().provider === 'anthropic' ? 'anthropic' : 'openai');
  if (readConfig().provider === 'vscode-lm' && !provider) {
    void vscode.window.showInformationMessage(
      'Novel Forge：当前使用 VS Code 语言模型（Copilot），无需 API Key。'
    );
    return undefined;
  }

  const config = readConfig();
  const host = target === 'anthropic' ? config.anthropicBaseUrl : config.openaiBaseUrl;
  const value = await vscode.window.showInputBox({
    title: `Novel Forge：设置 ${target === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容接口'} API Key`,
    prompt: `将安全保存在 VS Code SecretStorage 中，不会写入 settings.json。当前接口地址：${host}`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: target === 'anthropic' ? 'sk-ant-...' : 'sk-...',
    validateInput: (v) => (v.trim().length === 0 ? 'API Key 不能为空' : undefined),
  });

  if (!value) {
    return undefined;
  }
  await requireSecrets().store(SECRET_KEYS[target], value.trim());
  void vscode.window.showInformationMessage('Novel Forge：API Key 已保存。');
  return value.trim();
}

export async function clearApiKey(provider?: 'openai' | 'anthropic'): Promise<void> {
  const store = requireSecrets();

  // 设置页会指名清哪个；从命令面板进来则要问一下。
  if (provider) {
    await store.delete(SECRET_KEYS[provider]);
    void vscode.window.showInformationMessage(
      `Novel Forge：已清除 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容接口'} 的 API Key。`
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: 'OpenAI 兼容接口', value: 'openai' as const },
      { label: 'Anthropic', value: 'anthropic' as const },
      { label: '全部', value: 'all' as const },
    ],
    { title: '清除哪个 API Key？' }
  );
  if (!pick) {
    return;
  }
  if (pick.value === 'all') {
    await store.delete(SECRET_KEYS.openai);
    await store.delete(SECRET_KEYS.anthropic);
  } else {
    await store.delete(SECRET_KEYS[pick.value]);
  }
  void vscode.window.showInformationMessage('Novel Forge：API Key 已清除。');
}

function requireSecrets(): vscode.SecretStorage {
  if (!secrets) {
    throw new Error('SecretStorage 尚未初始化');
  }
  return secrets;
}
