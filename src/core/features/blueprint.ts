/**
 * 细纲批次（章节蓝图）的解码：`{"blueprints":[…]}` → 一章一份的规划字段。
 *
 * **纯函数、绝不抛**。合同与校验规则移植自 AI-Novel-Writer（GPL-3.0，源自
 * AI_NovelGenerator）的 `src/shared/blueprint-semantic-contract.ts` 与
 * `commands/directory.command.ts` 的 `decodeGeneratedBlueprints`。
 *
 * ## 严格，但只对「结构」严格
 *
 * 批次路径上没有人逐份过目（第 19 条的批量那一面），全文兜底会把模型的一句
 * 「我不太确定」变成一份「已规划」的细纲。所以这里**缺必填字段、类型不对就报诊断**，
 * 由生成链决定拆半重试还是单章重建（generation/structured.ts）。
 *
 * 但**超长不算错**：上游在 `value_too_long` 时同样截断后再收（`normalizeGeneratedBlueprintText`）。
 * 超了几十个字就作废整批、再花一次调用，不划算；截断写进 `warnings`，落到卡片上。
 *
 * ## 与 D3 三节的对应
 *
 * `purpose` → 本章目的，`keyEvents` → 关键事件，`suspenseHook` → 章末钩子。上游的
 * `relationships` 不要（D3 的细纲里没有它的位置）；`newCharacters` 可选，写入细纲时
 * 直接给新角色建卡（D19）。
 */
import { BLUEPRINT_LIMITS } from '../model/plotFile';
import type { PlotFields } from './artifact';
import { parseJson, singleJsonObject } from './structuredJson';

/** 一章的蓝图。 */
export interface BlueprintItem {
  no: number;
  title: string;
  role: string;
  purpose: string;
  keyEvents: string;
  characters: string[];
  /** 本章首次登场、后面还会出场的重要角色。名字一定在 `characters` 里。 */
  newCharacters: { name: string; role: string }[];
  suspenseHook: string;
}

export { BLUEPRINT_LIMITS };

export interface BlueprintDiagnostic {
  code: 'not_json' | 'no_list' | 'missing_field' | 'invalid_type' | 'empty_value' | 'invalid_value';
  /** 出错的位置，如 `blueprints[2].keyEvents`。紧凑重建时原样告诉模型。 */
  path: string;
  /** 一句人话。 */
  message: string;
}

export type BlueprintDecode =
  | { ok: true; items: BlueprintItem[]; warnings: string[] }
  | { ok: false; diagnostic: BlueprintDiagnostic };

/** 上游角色定位枚举 → 角色卡 tags 里的说法。中文原样收。 */
const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  minor: '次要',
};

export function roleLabel(role: string): string {
  const s = role.trim();
  return ROLE_LABEL[s.toLowerCase()] ?? s;
}

function pick(o: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      return o[key];
    }
  }
  return undefined;
}

function chars(s: string): number {
  return Array.from(s).length;
}

function clip(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('');
}

/** 标题在标点处断一次再截：模型很爱把一整句梗概当标题。 */
function clipTitle(s: string): string {
  const head = s.split(/[。！？；;\n]/)[0].trim() || s.trim();
  return chars(head) > BLUEPRINT_LIMITS.title ? clip(head, BLUEPRINT_LIMITS.title) : head;
}

/**
 * 解出蓝图清单。认 `{"blueprints":[…]}`，也认裸数组；整段不是 JSON 时再试一次
 * 「唯一一个完整对象」（模型在 JSON 前后多说了两句话）。
 */
export function decodeBlueprints(text: string): BlueprintDecode {
  let data = parseJson(text);
  if (data === undefined) {
    const single = singleJsonObject(text);
    if (!single.ok) {
      return {
        ok: false,
        diagnostic: {
          code: 'not_json',
          path: '$',
          message: single.reason === 'truncated' ? '输出的 JSON 没有写完' : '输出不是一个完整的 JSON 对象',
        },
      };
    }
    data = single.value;
  }
  const list =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).blueprints ?? (data as Record<string, unknown>).chapters
      : data;
  if (!Array.isArray(list)) {
    return { ok: false, diagnostic: { code: 'no_list', path: 'blueprints', message: '输出里没有 blueprints 列表' } };
  }

  const items: BlueprintItem[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const path = `blueprints[${i}]`;
    const row = list[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, diagnostic: { code: 'invalid_type', path, message: `第 ${i + 1} 项不是对象` } };
    }
    const o = row as Record<string, unknown>;

    const rawNo = pick(o, ['chapterNumber', 'chapter_number', 'no', 'chapter']);
    const no = typeof rawNo === 'number' ? rawNo : typeof rawNo === 'string' ? Number(rawNo.trim()) : NaN;
    if (rawNo === undefined) {
      return { ok: false, diagnostic: { code: 'missing_field', path: `${path}.chapterNumber`, message: `第 ${i + 1} 项缺 chapterNumber` } };
    }
    if (!Number.isSafeInteger(no) || no < 1) {
      return { ok: false, diagnostic: { code: 'invalid_value', path: `${path}.chapterNumber`, message: `第 ${i + 1} 项的章号不是正整数` } };
    }

    const field = (name: string, keys: readonly string[], max: number): string | BlueprintDiagnostic => {
      const v = pick(o, keys);
      if (v === undefined) {
        return { code: 'missing_field', path: `${path}.${name}`, message: `第 ${no} 章缺 ${name}` };
      }
      if (typeof v !== 'string') {
        return { code: 'invalid_type', path: `${path}.${name}`, message: `第 ${no} 章的 ${name} 不是文本` };
      }
      const s = v.trim();
      if (!s) {
        return { code: 'empty_value', path: `${path}.${name}`, message: `第 ${no} 章的 ${name} 是空的` };
      }
      if (chars(s) > max) {
        warnings.push(`第 ${no} 章的 ${name} 超过 ${max} 字，已截断`);
        return clip(s, max);
      }
      return s;
    };

    const fields = {
      title: field('title', ['title', '标题'], Number.MAX_SAFE_INTEGER),
      role: field('role', ['role', '结构功能'], BLUEPRINT_LIMITS.role),
      purpose: field('purpose', ['purpose', '本章目的'], BLUEPRINT_LIMITS.purpose),
      keyEvents: field('keyEvents', ['keyEvents', 'key_events', '关键事件'], BLUEPRINT_LIMITS.keyEvents),
      suspenseHook: field('suspenseHook', ['suspenseHook', 'suspense_hook', '章末钩子'], BLUEPRINT_LIMITS.suspenseHook),
    };
    for (const v of Object.values(fields)) {
      if (typeof v !== 'string') {
        return { ok: false, diagnostic: v };
      }
    }
    const f = fields as Record<keyof typeof fields, string>;

    const rawCast = pick(o, ['characters', '出场角色']);
    if (!Array.isArray(rawCast)) {
      return {
        ok: false,
        diagnostic: {
          code: rawCast === undefined ? 'missing_field' : 'invalid_type',
          path: `${path}.characters`,
          message: `第 ${no} 章的 characters 不是名单`,
        },
      };
    }
    const cast = [...new Set(rawCast.filter((x): x is string => typeof x === 'string').map((x) => clip(x.trim(), BLUEPRINT_LIMITS.name)).filter(Boolean))];
    if (cast.length === 0) {
      return { ok: false, diagnostic: { code: 'empty_value', path: `${path}.characters`, message: `第 ${no} 章没有列出场角色` } };
    }
    if (cast.length > BLUEPRINT_LIMITS.characters) {
      warnings.push(`第 ${no} 章列了 ${cast.length} 个出场角色，只留前 ${BLUEPRINT_LIMITS.characters} 个`);
      cast.length = BLUEPRINT_LIMITS.characters;
    }

    const newCharacters: BlueprintItem['newCharacters'] = [];
    const rawNew = pick(o, ['newCharacters', 'newCharacterCandidates', '新角色']);
    if (Array.isArray(rawNew)) {
      for (const entry of rawNew) {
        const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
        const name = typeof e?.name === 'string' ? e.name.trim() : typeof entry === 'string' ? entry.trim() : '';
        if (!name) {
          continue;
        }
        // 合同要求名字逐字出现在 characters 里：别名、简称会建出一张重复的卡。
        if (!cast.includes(name)) {
          warnings.push(`第 ${no} 章的新角色「${name}」不在出场名单里，没有建卡`);
          continue;
        }
        if (!newCharacters.some((c) => c.name === name)) {
          newCharacters.push({ name, role: roleLabel(typeof e?.role === 'string' ? e.role : '') });
        }
      }
    }

    items.push({
      no,
      title: clipTitle(f.title),
      role: f.role,
      purpose: f.purpose,
      keyEvents: f.keyEvents,
      characters: cast,
      newCharacters,
      suspenseHook: f.suspenseHook,
    });
  }
  return { ok: true, items, warnings };
}

/** 解出来的章号与这一批该有的章号对不对得上。 */
export interface BlueprintCoverage {
  missing: number[];
  duplicate: number[];
  unexpected: number[];
}

export function checkCoverage(items: readonly BlueprintItem[], expected: readonly number[]): BlueprintCoverage {
  const want = new Set(expected);
  const seen = new Set<number>();
  const duplicate = new Set<number>();
  const unexpected = new Set<number>();
  for (const item of items) {
    if (seen.has(item.no)) {
      duplicate.add(item.no);
    }
    seen.add(item.no);
    if (!want.has(item.no)) {
      unexpected.add(item.no);
    }
  }
  return {
    missing: expected.filter((no) => !seen.has(no)),
    duplicate: [...duplicate].sort((a, b) => a - b),
    unexpected: [...unexpected].sort((a, b) => a - b),
  };
}

/** 一章蓝图 → 细纲的规划字段（落盘时用）。 */
export function blueprintToPlot(item: BlueprintItem): PlotFields {
  return {
    sections: { 本章目的: item.purpose, 关键事件: item.keyEvents, 章末钩子: item.suspenseHook },
    title: item.title,
    role: item.role,
    characters: item.characters,
  };
}

/**
 * 规范化输出：生成链最后交给气泡、也是采纳时重新解析的那一份。
 *
 * 用合同里的英文键写回去，而不是细纲文件的样子：作者在气泡里改了再点写入时，
 * 走的是同一个 {@link decodeBlueprints}，形状必须原样认得。
 */
export function renderBlueprints(items: readonly BlueprintItem[]): string {
  const blueprints = items.map((b) => ({
    chapterNumber: b.no,
    title: b.title,
    role: b.role,
    purpose: b.purpose,
    keyEvents: b.keyEvents,
    characters: b.characters,
    ...(b.newCharacters.length > 0 ? { newCharacters: b.newCharacters } : {}),
    suspenseHook: b.suspenseHook,
  }));
  return JSON.stringify({ blueprints }, null, 2);
}
