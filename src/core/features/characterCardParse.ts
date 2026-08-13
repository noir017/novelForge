import { emptyCharacterSections } from '../model/project';
import { CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { sanitizeAliases } from '../naming';
import { extractJsonObject, stringArray, stripCodeFence, unique } from './parse';

export interface ParsedCard {
  sections: CharacterSections;
  aliases: string[];
  tags: string[];
}

/**
 * 解析模型返回的角色卡 JSON。
 * 解析失败返回 undefined 由调用方跳过这一批——角色卡写错比没写更麻烦。
 */
export function parseCardResponse(raw: string): ParsedCard | undefined {
  const text = stripCodeFence(raw);
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;

  const sections = emptyCharacterSections();
  let any = false;
  for (const key of CHARACTER_SECTION_KEYS) {
    const value = obj[key];
    if (typeof value === 'string') {
      sections[key] = value.trim();
    } else if (Array.isArray(value)) {
      sections[key] = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => (/^[-*·]/.test(v.trim()) ? v.trim() : `- ${v.trim()}`))
        .join('\n');
    }
    if (sections[key]) {
      any = true;
    }
  }
  if (!any) {
    return undefined;
  }
  return {
    sections,
    aliases: sanitizeAliases(unique(stringArray(obj.aliases))),
    tags: unique(stringArray(obj.tags)),
  };
}
