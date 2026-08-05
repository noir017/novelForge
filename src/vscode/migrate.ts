import * as vscode from 'vscode';
import { PersistedSettings } from '../core/config';
import { normalizeProviders } from '../core/model/providers';
import { FileConfigStore, FileSecretStore } from '../core/stores';

/**
 * 遗留单服务商键的读取器（novel.provider / novel.openai.baseUrl …），
 * 供 config.ts 的 seedFromLegacyRaw 兜底（未迁移或回滚用户）。
 */
export const legacySettingsReader = {
  read(): PersistedSettings {
    const cfg = vscode.workspace.getConfiguration('novel');
    return {
      provider: cfg.get<string>('provider'),
      'openai.baseUrl': cfg.get<string>('openai.baseUrl'),
      'openai.model': cfg.get<string>('openai.model'),
      'anthropic.baseUrl': cfg.get<string>('anthropic.baseUrl'),
      'anthropic.model': cfg.get<string>('anthropic.model'),
      'vscodeLm.family': cfg.get<string>('vscodeLm.family'),
    } as unknown as PersistedSettings;
  },
};

const SETTING_KEYS = [
  'providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
  'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir',
  'summaryBatchSize', 'requestTimeoutMs',
];

/**
 * 一次性迁移：settings.json 的 novel.* + SecretStorage → ~/.novelforge/。
 * 已迁移过（config.json 存在）则跳过。迁移成功后不删旧配置，
 * 只在 VS Code 里提示「可清理」，避免用户回滚时丢东西。
 * 返回是否真的执行了迁移。
 */
export async function migrateVscodeSettings(secrets: vscode.SecretStorage): Promise<boolean> {
  const store = new FileConfigStore();
  if (store.read()) {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('novel');
  const settings: PersistedSettings = {};
  for (const k of SETTING_KEYS) {
    const v = cfg.get(k);
    if (v !== undefined) {
      (settings as Record<string, unknown>)[k] = v;
    }
  }
  // 没配过新结构：把遗留单服务商键一并搬过去（seedFromLegacyRaw 会消费带点键）。
  if ((settings.providers ?? []).length === 0 && !settings.model) {
    const legacy = legacySettingsReader.read();
    Object.assign(settings, legacy as Record<string, unknown>);
  }
  if (Object.keys(settings).length === 0) {
    return false;
  }
  await store.write(settings);

  // SecretStorage → ~/.novelforge/secrets.json，key 命名与 registry 完全一致。
  const secretStore = new FileSecretStore();
  const ids = new Set<string>(normalizeProviders(settings.providers ?? []).map((p) => p.id));
  ids.add('openai');
  ids.add('anthropic');
  for (const id of ids) {
    const key = `novel-forge.apiKey.provider.${id}`;
    if (!(await secretStore.get(key))) {
      const v = await secrets.get(key);
      if (v) {
        await secretStore.set(key, v);
      }
    }
  }
  for (const legacyKey of ['novel-forge.apiKey.openai', 'novel-forge.apiKey.anthropic']) {
    if (!(await secretStore.get(legacyKey))) {
      const v = await secrets.get(legacyKey);
      if (v) {
        await secretStore.set(legacyKey, v);
      }
    }
  }

  void vscode.window.showInformationMessage(
    'Novel Forge：配置与密钥已迁移到 ~/.novelforge/，VS Code 内的旧配置可手动清理。'
  );
  return true;
}
