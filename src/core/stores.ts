import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, PersistedSettings } from './config';

/**
 * 文件后端的配置与密钥存储，双壳共用（独立版直接用；VS Code 壳在
 * 迁移完成后切过来）。落点统一在 ~/.novelforge/。
 */

/** ~/.novelforge/ —— 配置与密钥的用户主目录存储。 */
export function homeDir(): string {
  return path.join(os.homedir(), '.novelforge');
}

export class FileConfigStore implements ConfigStore {
  readonly filePath = path.join(homeDir(), 'config.json');

  read(): PersistedSettings | undefined {
    // read() 是同步接口（readConfig 到处同步调用）；文件极小，同步读可接受。
    try {
      return JSON.parse(fsSync.readFileSync(this.filePath, 'utf8')) as PersistedSettings;
    } catch {
      return undefined;
    }
  }

  async write(settings: PersistedSettings): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * ~/.novelforge/secrets.json。JSON 无法写文件头注释，首次创建时
 * 同目录放一个 README.txt 说明「不要提交 secrets.json」。
 * Windows 无 POSIX 权限位，仅依赖用户主目录隔离。
 */
export class FileSecretStore implements SecretStore {
  private readonly filePath = path.join(homeDir(), 'secrets.json');

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const readme = path.join(homeDir(), 'README.txt');
    try {
      await fs.stat(readme);
    } catch {
      await fs.writeFile(readme, 'secrets.json 存放各服务商的 API Key，请勿提交到版本库。\n', 'utf8');
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (!(key in data)) {
      return;
    }
    delete data[key];
    await this.save(data);
  }
}
