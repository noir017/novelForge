/**
 * 设定清单（架构第五件，设定名录）的两段式解码：先是一张**清单**（本书的分类目录树 + 每条的名字、
 * 分类、关键词、一句话），再按冻结的清单每批 6 条补**正文**，最后拼成一条条设定条目。
 *
 * **纯函数、绝不抛**。路子与角色图谱（features/roster.ts）一样：
 *
 * ## 为什么分两步
 *
 * 一次要三十条设定的全部正文，输出长到一定会被截断；而且分类、名字在长输出里前后不一（前面叫
 * 「青云宗」、后面叫「青云门」）。先冻结一张清单——分类与名字只在清单里定一次——详情那一步**不许**
 * 增删条目、改名换分类，只补每一条自己的正文。
 *
 * ## 分类是这本书自己的目录树
 *
 * 没有固定的分类表（作者定案）：清单第一步按题材排出 `categories`，落盘时建成 `lore/` 下的目录（空的
 * 也建，作者看得到分类表）。本书已经有目录的，提示词要求照用、只补缺的。条目的 `category` 不在
 * `categories` 里的照收、补进目录树并说明；是空的放根目录（未分类）。
 *
 * ## 比合同宽松的地方
 *
 * 只有「清单里一条能用的都没有」才算失败。条数不在 12–30、分类不在表里、某条正文没出来、超长——都照收
 * 并写进 `warnings`，落盘卡片上列出来。超过 30 条只留前 30 条：调用次数是按 30 条报给作者的（第 4 条）。
 * 人名不是设定：清单里撞上角色卡上的名字或别称的丢掉（提示词说一遍，这里再过一遍）。
 */
import { sanitizeFileName } from '../model/fs';
import { hasContent, pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_LINE_LIMITS,
  LORE_LIST_BODY_MAX,
  createLoreLookup,
  normalizeLoreCategory,
  normalizeLoreName,
} from '../model/loreFile';
import { LORE_LIST_MAX } from '../model/pipeline';
import type { LoreEntry } from '../model/types';
import { parseJson, singleJsonObject } from './structuredJson';

/** 设定清单里的一条。落盘时变成一条设定条目。 */
export interface LoreListEntry {
  title: string;
  /** 分类路径（`宗门/正道`），根目录（未分类）是空串。 */
  category: string;
  keywords: string[];
  brief: string;
  /** 正文三节（`## 概要` / `## 规则与边界` / `## 现状`）。没生成出来是空串。 */
  body: string;
}

/** 清单里的一条（还没有正文）。 */
export type LoreListSlot = Omit<LoreListEntry, 'body'>;

/** 解码要对照的已有东西：本书的目录树、已有条目（照抄名字）、角色卡上的人（不进设定）。 */
export interface LoreListKnown {
  categories: readonly string[];
  entries: readonly LoreEntry[];
  people: readonly string[];
}

export type LoreManifestDecode =
  | { ok: true; categories: string[]; slots: LoreListSlot[]; warnings: string[] }
  | { ok: false; message: string };

/** 分类目录最多几层（与「按目录整理」同一个数）。 */
const CATEGORY_DEPTH = 3;
/** 一条最多几个关键词。 */
const KEYWORDS_MAX = 8;

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

function strings(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

function clip(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

/**
 * 分类写法规范成能当目录用的路径：`/` 分段、每段是合法的文件夹名、最多 {@link CATEGORY_DEPTH} 层。
 * 全是非法字符的段丢掉；「未分类」与空串都是根目录。
 */
export function loreFolderOf(value: string): string {
  return normalizeLoreCategory(value)
    .split('/')
    .filter(Boolean)
    .map((part) => sanitizeFileName(part))
    .filter((part) => part !== '未命名' && !part.startsWith('.'))
    .slice(0, CATEGORY_DEPTH)
    .join('/');
}

/**
 * 清单 `{"categories":[…],"entries":[{title,category,keywords,brief}]}`。
 *
 * - `categories` 规范成目录路径，重复的去掉；本书已有的照收（不另报）。一级分类不在 3–8 个时说一声。
 * - 已有条目（按标题、再按关键词认）的名字换成条目的标题、分类换成它实际所在的目录——已建条目以
 *   实际目录为准。
 * - 同一个名字只收第一条；撞上角色卡上的人的丢掉；超过 {@link LORE_LIST_MAX} 条只留前面的。
 */
export function decodeLoreManifest(text: string, known: LoreListKnown): LoreManifestDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings ?? obj?.lore ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  if (!Array.isArray(rows)) {
    return { ok: false, message: '设定清单不是 {"categories":[…],"entries":[…]} 的形状' };
  }
  const warnings: string[] = [];
  const categories: string[] = [];
  const addCategory = (value: string): void => {
    if (value && !categories.includes(value)) {
      categories.push(value);
    }
  };
  for (const raw of strings(obj?.categories ?? obj?.分类)) {
    const folder = loreFolderOf(raw);
    if (!folder) {
      warnings.push(`分类「${raw}」当不了目录名，丢掉`);
      continue;
    }
    addCategory(folder);
  }

  const lookup = createLoreLookup(known.entries);
  const people = new Set(known.people.map(normalizeLoreName).filter(Boolean));
  const existing = new Set(known.categories);
  const seen = new Set<string>();
  const slots: LoreListSlot[] = [];
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i] && typeof rows[i] === 'object' ? (rows[i] as Record<string, unknown>) : undefined;
    const name = clip(str(o?.title ?? o?.name ?? o?.名称), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(name);
    if (!o || !key) {
      warnings.push(`设定清单第 ${i + 1} 项没有名字，跳过`);
      continue;
    }
    if (people.has(key)) {
      warnings.push(`「${name}」是角色卡上的人，人不是设定，丢掉`);
      continue;
    }
    const entry = lookup.find(name);
    const title = entry?.title ?? name;
    const dedupe = normalizeLoreName(title);
    if (seen.has(dedupe)) {
      warnings.push(`设定清单里「${title}」出现了不止一次，只收第一条`);
      continue;
    }
    if (slots.length >= LORE_LIST_MAX) {
      warnings.push(`设定清单超过 ${LORE_LIST_MAX} 条，「${title}」及之后的没收`);
      break;
    }
    seen.add(dedupe);
    let category: string;
    if (entry) {
      category = entry.category;
    } else {
      const rawCategory = str(o.category ?? o.分类);
      category = loreFolderOf(rawCategory);
      if (!category) {
        warnings.push(`「${title}」没写分类，放在设定根目录（未分类）`);
      } else if (!categories.includes(category) && !existing.has(category)) {
        warnings.push(`「${title}」的分类「${category}」不在 categories 里，按新目录建`);
        addCategory(category);
      }
    }
    const brief = str(o.brief ?? o.一句话 ?? o.简介);
    if (Array.from(brief).length > LORE_ENTRY_LIMITS.brief) {
      warnings.push(`「${title}」的一句话超过 ${LORE_ENTRY_LIMITS.brief} 字，已截断`);
    }
    const keywords = [
      ...new Set(
        strings(o.keywords ?? o.关键词)
          .map((k) => clip(k, LORE_LINE_LIMITS.name))
          .filter((k) => k && normalizeLoreName(k) !== dedupe && !people.has(normalizeLoreName(k)))
      ),
    ].slice(0, KEYWORDS_MAX);
    slots.push({ title, category, keywords, brief: clip(brief, LORE_ENTRY_LIMITS.brief) });
  }
  if (slots.length === 0) {
    return { ok: false, message: '设定清单里一条能用的都没有' };
  }
  // 一级分类按本书已有的加上这一次新排的数：已有目录的书，模型照合同只补缺的那几个。
  const top = new Set([...known.categories, ...categories].map((c) => c.split('/')[0]));
  if (top.size < 3 || top.size > 8) {
    warnings.push(`一级分类有 ${top.size} 个，合同要求 3–8 个`);
  }
  if (slots.length < 12) {
    warnings.push(`设定清单有 ${slots.length} 条，合同要求 12–${LORE_LIST_MAX} 条`);
  }
  return { ok: true, categories, slots, warnings };
}

/** 一条的正文（详情那一步交回来的）。 */
export interface LoreDetail {
  title: string;
  body: string;
}

export type LoreDetailsDecode =
  | { ok: true; items: LoreDetail[]; warnings: string[] }
  | { ok: false; message: string };

/**
 * 一批详情 `{"entries":[{title, body}]}`。
 *
 * 只认这一批该有的名字（归一后对上），清单外的丢掉并说明（清单是冻结的，详情那一步不许加条目）。
 * `body` 给成三节 Markdown 或 `{概要, 规则与边界, 现状}` 对象都收，规范成三节、超长截断
 * （{@link normalizeLoreBody}）。整段解不出来才算失败——交给生成链拆半重试。
 */
export function decodeLoreDetails(text: string, batch: readonly LoreListSlot[]): LoreDetailsDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings;
  if (!Array.isArray(rows)) {
    return { ok: false, message: '设定详情不是 {"entries":[…]} 的形状' };
  }
  const warnings: string[] = [];
  const wanted = new Map(batch.map((s) => [normalizeLoreName(s.title), s]));
  const items: LoreDetail[] = [];
  for (const row of rows) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    if (!o) {
      continue;
    }
    const name = str(o.title ?? o.name);
    const slot = wanted.get(normalizeLoreName(name));
    if (!slot) {
      warnings.push(`详情里多出一条清单外的「${name || '（没有名字）'}」，丢掉`);
      continue;
    }
    if (items.some((d) => d.title === slot.title)) {
      continue;
    }
    const { body, clipped } = normalizeLoreBody(o.body ?? o.content ?? pickBodyFields(o));
    if (clipped) {
      warnings.push(
        `「${slot.title}」的正文超长，已截断（每节不超过 ${LORE_BODY_KEYS.map((k) => LORE_ENTRY_LIMITS[k]).join(' / ')} 字，合计不超过 ${LORE_LIST_BODY_MAX} 字）`
      );
    }
    if (body) {
      items.push({ title: slot.title, body });
    }
  }
  return { ok: true, items, warnings };
}

/** 模型没包一层 `body`、直接把三节写成字段时（`{title, 概要, 规则与边界, 现状}`）。 */
function pickBodyFields(o: Record<string, unknown>): Record<string, unknown> | undefined {
  return LORE_BODY_KEYS.some((k) => o[k] !== undefined) ? o : undefined;
}

/**
 * 正文规范成三节：`## 概要` / `## 规则与边界` / `## 现状`。给成对象按键取，给成 Markdown 按小节取，
 * 一个小节都认不出的整段当「概要」。每节不超过条目的上限（{@link LORE_ENTRY_LIMITS}），三节合计不超过
 * {@link LORE_LIST_BODY_MAX} 字——超了从超出的那一节起截掉。空着的节写「（未交代）」：起步时不必写满，
 * 节在，作者一眼看得出这里还没东西。三节全空就是空串。
 */
export function normalizeLoreBody(value: unknown): { body: string; clipped: boolean } {
  const sections: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const key of LORE_BODY_KEYS) {
      sections[key] = Array.isArray(o[key]) ? (o[key] as unknown[]).map(str).filter(Boolean).join('\n') : str(o[key]);
    }
  } else {
    const text = Array.isArray(value) ? value.map(str).filter(Boolean).join('\n') : str(value);
    const picked = pickSections(text, LORE_BODY_KEYS);
    const any = LORE_BODY_KEYS.some((k) => picked[k]?.trim());
    for (const key of LORE_BODY_KEYS) {
      sections[key] = any ? (picked[key] ?? '').trim() : key === '概要' ? text.replace(/^#+\s.*$/gm, '').trim() : '';
    }
  }
  if (!LORE_BODY_KEYS.some((k) => hasContent(sections[k]))) {
    return { body: '', clipped: false };
  }
  let left = LORE_LIST_BODY_MAX;
  let clipped = false;
  const parts = LORE_BODY_KEYS.map((key) => {
    const chars = Array.from(hasContent(sections[key]) ? sections[key].trim() : '');
    const max = Math.min(LORE_ENTRY_LIMITS[key], left);
    if (chars.length > max) {
      clipped = true;
    }
    const kept = chars.slice(0, Math.max(0, max)).join('').trim();
    left -= Array.from(kept).length;
    return `## ${key}\n${kept || '（未交代）'}`;
  });
  return { body: parts.join('\n\n'), clipped };
}

/**
 * 清单 + 详情 → 条目。详情缺席的条目照样建（只有一句话），并记一条 warning——与角色图谱
 * 「某人详情没出来照样按清单建卡」同一个口径。
 */
export function assembleLoreList(
  slots: readonly LoreListSlot[],
  details: readonly LoreDetail[]
): { entries: LoreListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byTitle = new Map(details.map((d) => [d.title, d.body]));
  const entries = slots.map((slot) => {
    const body = byTitle.get(slot.title) ?? '';
    if (!body) {
      warnings.push(`「${slot.title}」的正文没有生成出来，只按清单建条目（一句话），写到了再整合`);
    }
    return { ...slot, body };
  });
  return { entries, warnings };
}

/**
 * 规范化输出：`{"categories":[…],"entries":[{title,category,keywords,brief,body}]}`。生成链最后交给气泡的
 * 那一份，也是采纳时重新解析的那一份（artifact.ts 的 `parseLoreList` 认得它）。
 */
export function renderLoreList(categories: readonly string[], entries: readonly LoreListEntry[]): string {
  return JSON.stringify(
    {
      categories,
      entries: entries.map((e) => ({
        title: e.title,
        category: e.category,
        keywords: e.keywords,
        brief: e.brief,
        ...(e.body ? { body: e.body } : {}),
      })),
    },
    null,
    2
  );
}

/**
 * 采纳时读回来（规范化输出，或者模型第一次调用的原样清单——agent 那条路、老会话）。宽松收：
 * 没写 `categories` 就从条目的分类里收；同名只留第一条；正文按 {@link normalizeLoreBody} 规范。
 * 认不出就是空的。
 */
export function parseLoreList(text: string): { categories: string[]; entries: LoreListEntry[] } {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings ?? obj?.lore ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  const categories: string[] = [];
  const add = (c: string): void => {
    if (c && !categories.includes(c)) {
      categories.push(c);
    }
  };
  strings(obj?.categories ?? obj?.分类).map(loreFolderOf).forEach(add);
  const entries: LoreListEntry[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    const title = clip(str(o?.title ?? o?.name ?? o?.名称), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(title);
    if (!o || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const category = loreFolderOf(str(o.category ?? o.分类));
    add(category);
    entries.push({
      title,
      category,
      keywords: [...new Set(strings(o.keywords ?? o.关键词))].filter((k) => normalizeLoreName(k) !== key),
      brief: clip(str(o.brief ?? o.一句话 ?? o.简介), LORE_ENTRY_LIMITS.brief),
      body: normalizeLoreBody(o.body ?? o.content ?? pickBodyFields(o)).body,
    });
  }
  return { categories, entries };
}
