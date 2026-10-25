import { normalizeGender } from '../model/gender';
import { emptyCharacterSections } from '../model/project';
import { CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { sanitizeAliases } from '../model/naming';
import { extractJsonObject, stringArray, stripCodeFence, unique } from './parse';
import { CARD_JSON_CONTRACT } from './characterCardPrompt';
import type { TranscribeSpec } from './transcribe';

export interface ParsedCard {
  sections: CharacterSections;
  aliases: string[];
  tags: string[];
  gender?: string;
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
    gender: normalizeGender(obj.性别 ?? obj.gender),
  };
}

/**
 * 更新角色卡与建卡转写那一步（2026-10-25 起改成转写）：合同是 {@link CARD_JSON_CONTRACT}，解码就是上面的
 * {@link parseCardResponse}。性别按对应关系填（「男性」也认），不比原文；原文连「身份」「性格」这几节都没有
 * （「我不太确定」）的不转，按解析失败走——跳过这一批。
 */
export function cardTranscribeSpec(label: string): TranscribeSpec<ParsedCard> {
  return {
    label,
    contract: CARD_JSON_CONTRACT,
    decode: (json) => {
      const card = parseCardResponse(json);
      return card
        ? { ok: true, value: card }
        : { ok: false, message: '整理不出角色卡：身份到暗设七节全是空的，或者不是一个 JSON 对象' };
    },
    mapped: ['性别', 'gender'],
    looksLike: (source) => /身份|性格|语言习惯|当前状态/.test(source),
  };
}
