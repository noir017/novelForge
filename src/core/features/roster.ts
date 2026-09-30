/**
 * 角色图谱的两段式解码：先是一张**身份清单**（谁、什么定位、在故事里干什么、彼此什么关系），
 * 再按清单每批 3 人补**详情**，最后拼成一张张角色卡。
 *
 * **纯函数、绝不抛**。两段式与合同移植自 AI-Novel-Writer（GPL-3.0，源自
 * AI_NovelGenerator）的 `GenerateCharactersCommand`（`commands/architecture.command.ts:719-1647`）
 * 与 `prompt-language.ts` 的身份 / 详情合同。
 *
 * ## 为什么分两步
 *
 * 一次要八个人的全部资料，输出长到容易被截断，而且人与人之间的关系在长输出里
 * 前后打架（A 说 B 是他师兄，B 说 A 是他仇人）。先冻结一张清单，关系只在清单里
 * 写一次、由代码生成到双方的卡上；详情那一步**不许**再写关系，只补每个人自己的资料。
 *
 * ## 比上游宽松的地方
 *
 * 上游任何一处不合格都整份作废。这里只有「清单里一个能用的人都没有」才算失败；
 * 人数不在 3–8、没标主角、关系指向清单外的人、某人详情缺了——都照收并写进 `warnings`，
 * 落盘卡片上列出来。角色图谱是一次一份、摊在卡片上给作者看的产物，
 * 作者看得见缺了什么；作废它只是让他再花一轮钱。
 */
import { CHARACTER_DETAIL_LIMITS, CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { roleLabel } from './blueprint';
import { parseJson, singleJsonObject } from './structuredJson';

/** 角色图谱里的一个人。落盘时变成一张角色卡。 */
export interface RosterEntry {
  name: string;
  /** 主角 / 盟友 / 对手……落进角色卡的 tags。 */
  role: string;
  aliases: string[];
  sections: Partial<CharacterSections>;
}

/** 身份清单里的一个人。 */
export interface IdentitySlot {
  slotId: string;
  name: string;
  /** 已换成中文说法（主角 / 反派 / 配角 / 次要）。 */
  role: string;
  /** 这个人在故事里承担什么叙事职责。 */
  duty: string;
  relations: { target: string; relation: string }[];
}

export type ManifestDecode =
  | { ok: true; slots: IdentitySlot[]; warnings: string[] }
  | { ok: false; message: string };

/** 上游的四种定位。清单那一步要求模型只用这几个英文值。 */
const ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function objectOf(text: string): Record<string, unknown> | undefined {
  const whole = parseJson(text);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    return whole as Record<string, unknown>;
  }
  const single = singleJsonObject(text);
  return single.ok ? single.value : undefined;
}

/**
 * 身份清单 `{"slots":[{slotId,name,role,narrativeDuty,relations:[{targetSlotId,relation}]}]}`。
 *
 * 重名的第二个丢掉、指向清单外或指向自己的关系丢掉，都记进 warnings。
 */
export function decodeManifest(text: string): ManifestDecode {
  const obj = objectOf(text);
  const rows = obj?.slots ?? obj?.characters ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  if (!Array.isArray(rows)) {
    return { ok: false, message: '身份清单不是 {"slots":[…]} 的形状' };
  }
  const warnings: string[] = [];
  const slots: IdentitySlot[] = [];
  const raw: { slot: IdentitySlot; relations: unknown }[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i] && typeof rows[i] === 'object' ? (rows[i] as Record<string, unknown>) : undefined;
    const name = str(o?.name);
    if (!o || !name) {
      warnings.push(`身份清单第 ${i + 1} 项没有名字，跳过`);
      continue;
    }
    if (names.has(name)) {
      warnings.push(`身份清单里「${name}」出现了两次，只收第一个`);
      continue;
    }
    let slotId = str(o.slotId) || String(i + 1);
    if (ids.has(slotId)) {
      slotId = `${slotId}#${i + 1}`;
    }
    const role = str(o.role).toLowerCase();
    if (!ROLES.includes(role)) {
      warnings.push(`「${name}」的定位「${str(o.role) || '（空）'}」认不出，按配角算`);
    }
    const slot: IdentitySlot = {
      slotId,
      name,
      role: roleLabel(ROLES.includes(role) ? role : 'supporting'),
      duty: str(o.narrativeDuty ?? o.duty),
      relations: [],
    };
    ids.add(slotId);
    names.add(name);
    slots.push(slot);
    raw.push({ slot, relations: o.relations });
  }
  if (slots.length === 0) {
    return { ok: false, message: '身份清单里一个能用的人都没有' };
  }

  const byId = new Map(slots.map((s) => [s.slotId, s]));
  for (const { slot, relations } of raw) {
    for (const r of Array.isArray(relations) ? relations : []) {
      const rel = r && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
      const target = byId.get(str(rel?.targetSlotId));
      const relation = str(rel?.relation);
      if (!target || target === slot || !relation) {
        warnings.push(`「${slot.name}」有一条关系指向清单外的人或指向自己，丢掉`);
        continue;
      }
      slot.relations.push({ target: target.name, relation });
    }
  }

  if (slots.length < 3 || slots.length > 8) {
    warnings.push(`身份清单有 ${slots.length} 人，合同要求 3–8 人`);
  }
  if (!slots.some((s) => s.role === '主角')) {
    warnings.push('身份清单里没有标出主角');
  }
  return { ok: true, slots, warnings };
}

/** 详情那一步要写的六节与各自的字数上限（第 15 条：角色卡不能无限膨胀）。 */
export const DETAIL_LIMITS = CHARACTER_DETAIL_LIMITS;

export const DETAIL_KEYS = Object.keys(DETAIL_LIMITS) as (keyof typeof DETAIL_LIMITS)[];

/** 一个人的详情（不含关系——关系只来自清单）。 */
export interface CharacterDetail {
  slotId: string;
  aliases: string[];
  sections: Partial<CharacterSections>;
}

export type DetailsDecode =
  | { ok: true; items: CharacterDetail[]; warnings: string[] }
  | { ok: false; message: string };

/**
 * 一批详情 `{"entries":[{slotId,name,role,身份,外貌,…}]}`。
 *
 * 只认这一批该有的 slotId；名字或定位与冻结清单对不上时以清单为准（清单是冻结的，
 * 详情那一步不许改人）。整段解不出来才算失败——交给生成链拆半重试。
 */
export function decodeDetails(text: string, batch: readonly IdentitySlot[]): DetailsDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.characters;
  if (!Array.isArray(rows)) {
    return { ok: false, message: '角色详情不是 {"entries":[…]} 的形状' };
  }
  const warnings: string[] = [];
  const wanted = new Map(batch.map((s) => [s.slotId, s]));
  const byName = new Map(batch.map((s) => [s.name, s]));
  const items: CharacterDetail[] = [];
  for (const row of rows) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    if (!o) {
      continue;
    }
    // 模型常把 slotId 写丢，名字总还在。
    const slot = wanted.get(str(o.slotId)) ?? byName.get(str(o.name));
    if (!slot) {
      warnings.push(`详情里多出一个清单外的人「${str(o.name) || str(o.slotId)}」，丢掉`);
      continue;
    }
    if (items.some((d) => d.slotId === slot.slotId)) {
      continue;
    }
    const sections: Partial<CharacterSections> = {};
    for (const key of DETAIL_KEYS) {
      const value = toText(o[key]);
      if (!value) {
        continue;
      }
      const max = DETAIL_LIMITS[key];
      if (Array.from(value).length > max) {
        warnings.push(`「${slot.name}」的${key}超过 ${max} 字，已截断`);
        sections[key] = Array.from(value).slice(0, max).join('');
      } else {
        sections[key] = value;
      }
    }
    const aliases = Array.isArray(o.aliases)
      ? o.aliases.map(str).filter((a) => a && a !== slot.name)
      : str(o.aliases).split(/[,，、]/).map((a) => a.trim()).filter((a) => a && a !== slot.name);
    items.push({ slotId: slot.slotId, aliases: [...new Set(aliases)], sections });
  }
  return { ok: true, items, warnings };
}

function toText(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean).join('；');
  }
  return str(v);
}

/**
 * 清单 + 详情 → 角色卡。
 *
 * 「人物关系」一节由清单生成：自己写的那几条，加上别人写向自己、而自己没写回去的
 * （「A 眼中——……」），两张卡上都看得见这段关系。「叙事职责」接在身份那一节最后。
 * 详情缺席的人仍然建卡，身份那一节只有叙事职责，并记一条 warning。
 */
export function assembleRoster(
  slots: readonly IdentitySlot[],
  details: readonly CharacterDetail[]
): { entries: RosterEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const bySlot = new Map(details.map((d) => [d.slotId, d]));
  const entries = slots.map((slot) => {
    const detail = bySlot.get(slot.slotId);
    if (!detail) {
      warnings.push(`「${slot.name}」的详情没有生成出来，只按身份清单建卡`);
    }
    const sections: Partial<CharacterSections> = { ...(detail?.sections ?? {}) };
    if (slot.duty) {
      sections.身份 = [sections.身份, `叙事职责：${slot.duty}`].filter(Boolean).join('\n');
    }
    const lines = slot.relations.map((r) => `- 与${r.target}：${r.relation}`);
    for (const other of slots) {
      if (other === slot || slot.relations.some((r) => r.target === other.name)) {
        continue;
      }
      for (const r of other.relations.filter((x) => x.target === slot.name)) {
        lines.push(`- 与${other.name}：${other.name}眼中——${r.relation}`);
      }
    }
    if (lines.length > 0) {
      sections.人物关系 = lines.join('\n');
    }
    return { name: slot.name, role: slot.role, aliases: detail?.aliases ?? [], sections };
  });
  return { entries, warnings };
}

/**
 * 规范化输出：`{"characters":[…]}`，键就是角色卡的七节。生成链最后交给气泡的那一份，
 * 也是采纳时重新解析的那一份（artifact.ts 的 `parseRoster` 认得它）。
 */
export function renderRoster(entries: readonly RosterEntry[]): string {
  const characters = entries.map((e) => {
    const row: Record<string, unknown> = { name: e.name, role: e.role };
    if (e.aliases.length > 0) {
      row.aliases = e.aliases;
    }
    for (const key of CHARACTER_SECTION_KEYS) {
      if (e.sections[key]?.trim()) {
        row[key] = e.sections[key];
      }
    }
    return row;
  });
  return JSON.stringify({ characters }, null, 2);
}
