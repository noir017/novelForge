/**
 * 设置页的本地编辑状态，以及保存前的校验。
 *
 * `dirty` 是必要的：FileSystemWatcher 一刷新就会推一份新设置过来，
 * 如果无条件重渲染，用户正在填的 baseUrl 会被磁盘上的旧值冲掉。
 */
import type { SerializedProvider } from '../../protocol';

export const draft: {
  providers: SerializedProvider[];
  /** 默认模型列表（有序，第一个是首选），每项形如 `glm/glm-4-plus`。 */
  models: string[];
  /** providerId -> 有没有存过 API Key。Key 本身从不回显。 */
  keys: Record<string, boolean>;
  dirty: boolean;
} = { providers: [], models: [], keys: {}, dirty: false };

export function touch(): void {
  draft.dirty = true;
}

/** 生成一个不与现有服务商冲突的 id。 */
export function uniqueId(base: string): string {
  if (!draft.providers.some((p) => p.id === base)) {
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!draft.providers.some((p) => p.id === candidate)) {
      return candidate;
    }
  }
}

/** draft 里全部模型的引用，按配置顺序。 */
export function allRefs(): string[] {
  return draft.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m.name}`));
}

/**
 * 保存前挡住会让引用无法解析的配置。返回错误信息，没问题返回空串。
 *
 * 模型引用**只在第一个斜杠处切分**，所以前缀里绝不能有斜杠——
 * `openrouter/z-ai/glm-4.6` 的服务商是 `openrouter`，模型名是 `z-ai/glm-4.6`。
 */
export function validateProviders(providers: SerializedProvider[]): string {
  const ids = new Set<string>();
  for (const p of providers) {
    const id = (p.id || '').trim();
    if (!id) return '服务商的前缀 id 不能为空。';
    if (id.includes('/')) return `前缀「${id}」不能含斜杠，否则模型引用无法切分。`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return `前缀「${id}」只能用字母、数字、点、下划线和连字符。`;
    if (ids.has(id)) return `前缀「${id}」重复了，每个服务商的前缀必须唯一。`;
    ids.add(id);

    if (p.models.length === 0) return `服务商「${id}」下没有模型。`;
    const names = new Set<string>();
    for (const m of p.models) {
      const name = (m.name || '').trim();
      if (!name) return `服务商「${id}」下有模型名为空。`;
      if (names.has(name)) return `服务商「${id}」下的模型「${name}」重复了。`;
      names.add(name);
      if (m.contextWindow && m.maxOutputTokens && m.maxOutputTokens >= m.contextWindow) {
        return `${id}/${name} 的输出上限必须小于它的窗口。`;
      }
    }
  }
  return '';
}
