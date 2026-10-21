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
 * ## 与细纲七节的对应
 *
 * `synopsis` → 梗概，`characters` → 出场人物（计划），`timePlace` → 时间地点，`keyEvents` → 关键事件，
 * `highlights` → 看点（爽点与章末吊着读者的东西，从前单列的章末钩子并在这里），`stateChange` → 状态变更。
 * 连续性事实计划时没有（证据要回正文定位），定稿时才生成。
 * 上游的 `relationships` 不要（细纲里没有它的位置）；`newCharacters` 可选，写入细纲时直接给新角色建卡（D19）。
 *
 * `threads`（叙事线二期，原来的 `foreshadowing` 换成它）不进细纲：这一章在哪条线上计划发生什么（推进、关系、收束、
 * 埋〈伏笔〉、收〈伏笔〉），写入细纲时整组换掉各条线里这一章的计划事件（generation/accept.ts → features/threadPlan.ts）。
 * 细纲里不再有任何关于线的小节（设计稿：同一样东西只有一份）。
 *
 * `keyEvents` 是一条一件事的列表，与定稿时写出来的「关键事件」同一个形状（定稿才能逐条改，
 * 而不是把一整段重写一遍）。给成一段字也认（老合同的形状）：按换行与分号切成条。
 *
 * `title` / `synopsis` 必须非空、`keyEvents` 至少一条、`characters` 至少一个人；其余几个字段可以是空的——
 * 过渡章不推进哪条线是常事，为一个空数组作废整批、再花一次调用不划算。写成别的形状（该是数组给了一行字）
 * 照收，不报诊断。
 */
import { normalizeGender } from '../model/gender';
import { BLUEPRINT_LIMITS } from '../model/plotFile';
import { LoreLine, loreLinesFromJson } from '../model/loreFile';
import { PlanEntry, decodePlanEntries, planEntryJson } from '../model/threadFile';
import type { PlotFields } from './artifact';
import { parseJson, singleJsonObject } from './structuredJson';

/** 一章的蓝图。 */
export interface BlueprintItem {
  no: number;
  title: string;
  /** 梗概：这一章计划发生什么，写清因果链。 */
  synopsis: string;
  /** 计划出场的人。 */
  characters: string[];
  timePlace: string;
  /** 关键事件：按发生的顺序一条一件事，至少一条。 */
  keyEvents: string[];
  /** 看点：一条一句。 */
  highlights: string[];
  stateChange: string;
  /**
   * 这一章在叙事线上的计划（叙事线二期）：写入时整组换掉各条线里这一章的计划事件。没写（老会话里存着的草稿）是 undefined
   * ——写入时不动这一章原来的计划（第 1 条）。
   */
  threads?: PlanEntry[];
  /** 本章首次登场、后面还会出场的重要角色。名字一定在 `characters` 里；性别建卡时落进卡上。 */
  newCharacters: { name: string; role: string; gender?: string }[];
  /**
   * 本章计划用到或引入的设定（「设定」一节，设定名录）。`isNew` 的是本章首次引入、后面还会用到的，
   * 随细纲一起建空条目（同新角色建卡，D19）；`note` 一句话写它是什么。
   */
  settings: (LoreLine & { isNew: boolean })[];
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

/** 列表元素行首的编号与「-」：合同说了不要写，模型照写的也不少。 */
function stripMarker(s: string): string {
  return s.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim();
}

/**
 * 关键事件给成了一段字 → 一条一项：按换行与分号（`；` `;`）切，去掉行首的列表记号。
 * 不按句号切——一条里可以有好几句。
 */
export function splitKeyEvents(text: string): string[] {
  return text.split(/\r?\n|[；;]/).map(stripMarker).filter(Boolean);
}

/**
 * 关键事件的原值 → 一条一项。数组按元素收（某一条带了换行就按行拆开：落盘后一行就是一条，
 * 拆开了读回来才是同一份），一段字走 {@link splitKeyEvents}；都去掉行首的列表记号。
 * 形状不对（数字、对象、元素不全是字符串的数组）返回 undefined。
 *
 * 批次（{@link decodeBlueprints}）与单章（features/artifact.ts 的 `parsePlotStrict`）共用这一份：
 * 两个入口的输出契约一致（第 22 条）。
 */
export function keyEventList(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    return splitKeyEvents(v);
  }
  if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) {
    return v.flatMap((x) => x.split(/\r?\n/)).map(stripMarker).filter(Boolean);
  }
  return undefined;
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
      synopsis: field('synopsis', ['synopsis', '梗概'], BLUEPRINT_LIMITS.synopsis),
    };
    for (const v of Object.values(fields)) {
      if (typeof v !== 'string') {
        return { ok: false, diagnostic: v };
      }
    }
    const f = fields as Record<keyof typeof fields, string>;

    const keyEvents = eventsField(o, path, no, warnings);
    if (!Array.isArray(keyEvents)) {
      return { ok: false, diagnostic: keyEvents };
    }

    /** 可以空着的一行字。给成数组就拼起来；超长截断并记一条。 */
    const loose = (name: string, keys: readonly string[], max: number): string => {
      const v = pick(o, keys);
      const s = (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('；') : typeof v === 'string' ? v : '').trim();
      if (chars(s) > max) {
        warnings.push(`第 ${no} 章的 ${name} 超过 ${max} 字，已截断`);
        return clip(s, max);
      }
      return s;
    };
    /** 可以空着的一条一句的列表。给成一行字就当一条；条数、每条字数超了截断并记一条。 */
    const listField = (name: string, keys: readonly string[]): string[] => {
      const v = pick(o, keys);
      const raw = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
        .filter((x): x is string => typeof x === 'string')
        .map(stripMarker)
        .filter(Boolean);
      if (raw.length > BLUEPRINT_LIMITS.listItems) {
        warnings.push(`第 ${no} 章的 ${name} 列了 ${raw.length} 条，只留前 ${BLUEPRINT_LIMITS.listItems} 条`);
        raw.length = BLUEPRINT_LIMITS.listItems;
      }
      return raw.map((x) => {
        if (chars(x) > BLUEPRINT_LIMITS.listItem) {
          warnings.push(`第 ${no} 章的 ${name} 有一条超过 ${BLUEPRINT_LIMITS.listItem} 字，已截断`);
          return clip(x, BLUEPRINT_LIMITS.listItem);
        }
        return x;
      });
    };

    const rawCast = pick(o, ['characters', '出场人物', '出场角色']);
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
          const gender = normalizeGender(e?.gender ?? e?.性别);
          newCharacters.push({ name, role: roleLabel(typeof e?.role === 'string' ? e.role : ''), ...(gender ? { gender } : {}) });
        }
      }
    }

    items.push({
      no,
      title: clipTitle(f.title),
      synopsis: f.synopsis,
      characters: cast,
      timePlace: loose('timePlace', ['timePlace', 'time_place', '时间地点'], BLUEPRINT_LIMITS.timePlace),
      keyEvents,
      highlights: listField('highlights', ['highlights', '看点']),
      stateChange: loose('stateChange', ['stateChange', 'state_change', '状态变更'], BLUEPRINT_LIMITS.stateChange),
      ...planOf(pick(o, ['threads', '叙事线']), no, warnings),
      newCharacters,
      settings: blueprintSettings(pick(o, ['settings', 'lore', '设定']), no, warnings),
    });
  }
  return { ok: true, items, warnings };
}

/**
 * 关键事件：一条一件事的列表，至少一条（{@link keyEventList}）。条数超过 `BLUEPRINT_LIMITS.keyEventItems`
 * 只留前面的，合计字数超过 `BLUEPRINT_LIMITS.keyEvents` 从超出的那一条起截掉；两样都记一条说明，不作废。
 */
function eventsField(
  o: Record<string, unknown>,
  path: string,
  no: number,
  warnings: string[]
): string[] | BlueprintDiagnostic {
  const at = `${path}.keyEvents`;
  const v = pick(o, ['keyEvents', 'key_events', '关键事件']);
  if (v === undefined) {
    return { code: 'missing_field', path: at, message: `第 ${no} 章缺 keyEvents` };
  }
  const raw = keyEventList(v);
  if (!raw) {
    return { code: 'invalid_type', path: at, message: `第 ${no} 章的 keyEvents 不是一条一件事的文本列表` };
  }
  if (raw.length === 0) {
    return { code: 'empty_value', path: at, message: `第 ${no} 章的 keyEvents 是空的` };
  }

  const maxItems = BLUEPRINT_LIMITS.keyEventItems;
  if (raw.length > maxItems) {
    warnings.push(`第 ${no} 章的 keyEvents 列了 ${raw.length} 条，只留前 ${maxItems} 条`);
    raw.length = maxItems;
  }
  const maxChars = BLUEPRINT_LIMITS.keyEvents;
  if (raw.reduce((n, event) => n + chars(event), 0) <= maxChars) {
    return raw;
  }
  warnings.push(`第 ${no} 章的 keyEvents 超过 ${maxChars} 字，已截断`);
  const out: string[] = [];
  let left = maxChars;
  for (const event of raw) {
    if (left <= 0) {
      break;
    }
    out.push(chars(event) > left ? clip(event, left) : event);
    left -= chars(event);
  }
  return out;
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

/**
 * 一章蓝图 → 细纲的七节（落盘时用），外加「设定」一节。出场人物写成「林昭、沈氏」一行，关键事件、
 * 看点一条一行（`- …`），与定稿写出来的样子一致；连续性事实计划时是空的。`threads` 随产物带着，不进细纲。
 */
export function blueprintToPlot(item: BlueprintItem): PlotFields {
  return {
    sections: {
      梗概: item.synopsis,
      出场人物: item.characters.join('、'),
      时间地点: item.timePlace,
      关键事件: listText(item.keyEvents),
      看点: listText(item.highlights),
      状态变更: item.stateChange,
      连续性事实: '',
    },
    title: item.title,
    // 会话里存着的老草稿没有这个字段（第 1 条）。
    lore: (item.settings ?? []).map(({ name, category, note }) => ({ name, category, note })),
    ...(item.threads ? { threads: item.threads } : {}),
  };
}

/** 一章的 `threads`（{@link decodePlanEntries}）：没写就不带这个字段；没收的那几条进 `warnings`（落到卡片上）。 */
function planOf(raw: unknown, no: number, warnings: string[]): Pick<BlueprintItem, 'threads'> {
  const { entries, notes } = decodePlanEntries(raw, no);
  warnings.push(...notes);
  return entries ? { threads: entries } : {};
}

/** 一章最多计划几条设定。 */
const BLUEPRINT_SETTINGS = 8;

/**
 * 蓝图的 `settings`（可选，宽松收）：写法与定稿的「设定」字段同一套（`loreLinesFromJson`），
 * 外加 `isNew`。不是数组、没写都当没有，不让一个可选字段拖垮整批；超出 8 条只留前 8 条并说明。
 */
function blueprintSettings(raw: unknown, no: number, warnings: string[]): BlueprintItem['settings'] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const lines = loreLinesFromJson(raw);
  const flags = Array.isArray(raw) ? raw : [];
  const out = lines.map((line) => {
    const src = flags.find(
      (x) => x && typeof x === 'object' && (x as Record<string, unknown>).name === line.name
    ) as Record<string, unknown> | undefined;
    const isNew = src?.isNew === true || src?.isNew === 'true' || src?.新 === true;
    return { ...line, isNew };
  });
  if (out.length > BLUEPRINT_SETTINGS) {
    warnings.push(`第 ${no} 章列了 ${out.length} 条设定，只留前 ${BLUEPRINT_SETTINGS} 条`);
    out.length = BLUEPRINT_SETTINGS;
  }
  return out;
}

function listText(items: readonly string[]): string {
  return items.map((x) => `- ${x}`).join('\n');
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
    synopsis: b.synopsis,
    characters: b.characters,
    timePlace: b.timePlace,
    keyEvents: b.keyEvents,
    highlights: b.highlights,
    stateChange: b.stateChange,
    ...(b.threads ? { threads: b.threads.map(planEntryJson) } : {}),
    ...(b.newCharacters.length > 0 ? { newCharacters: b.newCharacters } : {}),
    ...(b.settings?.length ? { settings: b.settings.map(({ name, category, isNew, note }) => ({ name, category, isNew, note })) } : {}),
  }));
  return JSON.stringify({ blueprints }, null, 2);
}
