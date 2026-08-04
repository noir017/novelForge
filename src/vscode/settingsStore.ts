import * as vscode from 'vscode';
import { ConfigStore, PersistedSettings } from '../core/config';
import { SecretStore } from '../core/stores';

/**
 * 过渡后端：继续读写工作区 settings.json 的 novel.*。
 * Task 12 迁移完成后，插件壳也切到 FileConfigStore，本文件删除。
 */
export class SettingsJsonConfigStore implements ConfigStore {
  read(): PersistedSettings | undefined {
    const cfg = vscode.workspace.getConfiguration('novel');
    // 没配置过新结构时返回 undefined，让 legacy reader 有机会兜底。
    if (!cfg.get<unknown[]>('providers', []).length && !cfg.get<string>('model', '')) {
      return undefined;
    }
    const keys = [
      'providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
      'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir',
      'summaryBatchSize', 'requestTimeoutMs',
    ];
    const out: PersistedSettings = {};
    for (const k of keys) {
      const v = cfg.get(k);
      if (v !== undefined) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  }

  async write(settings: PersistedSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('novel');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) {
        await cfg.update(k, v, target);
      }
    }
  }
}

/**
 * 遗留单服务商键的读取器（novel.provider / novel.openai.baseUrl …），
 * 供 config.ts 的 seedFromLegacyRaw 兜底。
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

/** SecretStorage 后端的 SecretStore 适配。 */
export class SecretStorageSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
