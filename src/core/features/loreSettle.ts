/**
 * 落定设定（完善设定二期）的解码、规范化与气泡往返。**纯函数、绝不抛。**
 *
 * 合同（context/loreSettlePrompt.ts）：
 *
 * ```json
 * { "entries": [{ "title": "…", "category": "…", "keywords": ["…"], "brief": "…",
 *                 "body": { "概要": "…", "规则与边界": "…", "现状": "…", "暗设": "…" } }],
 *   "questions": ["…"] }
 * ```
 *
 * 程序这一侧的校验不加调用，照展开那一套（features/loreExpand.ts）：一句话截 {@link LORE_ENTRY_LIMITS}.brief 字；
 * 明面三节按上限截、暗设另截（`decodeLoreBody`）；关键词过 `cleanLoreKeywords`、最多
 * {@link LORE_EXPAND_LIMITS}.keywords 个；`questions` 同展开。另外几条是一批才有的：没名字的、同一批里重名的、
 * 是角色卡上的人的、明面一节内容都没有的丢掉；最多 {@link LORE_SETTLE_LIMITS}.entries 条。认出是已有条目、正文却和
 * 原来一字不差的也丢掉（讨论没改它，只是顺手改了一句话或关键词——真跑时一次落定弹了三张这样的对比）。丢了什么写进
 * `warnings`。
 *
 * ## 认已有条目
 *
 * 模型只给名字与分类（它不知道路径）。生成链里那一次（`known` 给了）按磁盘认出它说的是哪一条已有条目
 * （{@link findSettledEntry}：路径 → 同名（同名不同分类的按分类挑）→ 关键词），把路径、标题、分类换成那一条的，
 * 写进规范化结果——气泡里看得见哪几条是改已有的（带 `relPath`）。采纳时拿气泡文本重新解析（不读盘），落盘那一步
 * （generation/loreSettle.ts）再按磁盘认一遍：这期间作者可能改了名、删了条目、新建了同名的。两次认同一个函数。
 *
 * **解析不了就没有产物**，不做全文兜底（同展开）。
 */
import { pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_LINE_LIMITS,
  LORE_SETTLE_LIMITS,
  LoreLookup,
  cleanLoreKeywords,
  createLoreLookup,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import { LoreDraft, decodeLoreBody, decodeLoreQuestions, loreJsonObject } from './loreExpand';
import { loreFolderOf } from './loreList';
import { parseJson } from './structuredJson';

/** 解码要对照的已有东西。不给就只做形状上的校验（采纳时拿气泡文本重新解析，那时不读盘）。 */
export interface LoreSettleKnown {
  /** 全部条目：认出改的是哪一条；别的条目的标题不进关键词。 */
  entries: readonly LoreEntry[];
  /** 角色卡上的名字与别称：人不是设定，不建条目、不进关键词。 */
  people: readonly string[];
  /** 名录里另记着、还没建条目的名字：不进关键词（同建条目、整合）。 */
  recorded: readonly string[];
}

/** 规范化之后的一次落定：条目（改已有的带 `relPath`）与还没定的问题。 */
export interface LoreSettlement {
  entries: LoreDraft[];
  questions: string[];
}

export type LoreSettleDecode = { ok: true; value: LoreSettlement; warnings: string[] } | { ok: false; message: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** 压成一行、按字（不按 UTF-16 码元）截到 `max`。 */
function clip(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function length(value: string): number {
  return Array.from(value.replace(/\s+/g, ' ').trim()).length;
}

/** 字符串数组；写成一个字符串时按顿号、逗号拆开。 */
function strings(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

/** 名字后面跟着的 `〔分类〕`（`【】` `[]` 也认）：上下文里一行带的设定就长这样，模型会照抄进 title。 */
const TRAILING_CATEGORY = /\s*[〔【[]\s*([^〕】\]]*?)\s*[〕】\]]\s*$/u;

/**
 * 一条的名字与名字里夹带的分类：认几种常见的键。真跑时模型把「土地庙〔地点/青羊镇域〕」整个写进了 title，认不出
 * 是已有的土地庙，另建了一份——名字后面的 `〔…〕` 剥掉，里面的东西当分类（没另给 category 时用）。
 */
function nameOf(row: Record<string, unknown>): { title: string; category: string } {
  const raw = str(row.title ?? row.name ?? row.标题 ?? row.名称 ?? row.名字);
  const m = TRAILING_CATEGORY.exec(raw);
  const bare = m ? raw.slice(0, m.index).trim() : raw;
  return { title: clip(bare || raw, LORE_LINE_LIMITS.name), category: m && bare ? m[1] : '' };
}

function titleOf(row: Record<string, unknown>): string {
  return nameOf(row).title;
}

/** 条目那一组：`{entries:[…]}`（认几种键名），或者整段就是一个数组。认不出返回 undefined。 */
function rowsOf(text: string): { rows: unknown[]; o?: Record<string, unknown> } | undefined {
  // 先认裸数组：只有一条的 `[{…}]` 里「唯一一个完整对象」恰好是那一条自己，当成外层对象就取不到条目。
  const bare = parseJson(text);
  if (Array.isArray(bare)) {
    return { rows: bare };
  }
  const o = loreJsonObject(text);
  if (o) {
    const rows = o.entries ?? o.条目 ?? o.设定 ?? o.lore;
    return Array.isArray(rows) ? { rows, o } : undefined;
  }
  return undefined;
}

/**
 * 一条要落定的设定说的是哪一条已有条目：给了路径且那条还在 → 同名（归一后；同名的不止一条时按分类挑，挑不出取第一条）
 * → 名字是某一条的关键词。都不是就是新的。生成链与落盘共用（见文件头「认已有条目」）。
 */
export function findSettledEntry(
  entries: readonly LoreEntry[],
  draft: Pick<LoreDraft, 'relPath' | 'title' | 'category'>,
  lookup: LoreLookup = createLoreLookup(entries)
): LoreEntry | undefined {
  const byPath = draft.relPath ? entries.find((e) => e.relPath === draft.relPath) : undefined;
  if (byPath) {
    return byPath;
  }
  const key = normalizeLoreName(draft.title);
  const same = key ? entries.filter((e) => normalizeLoreName(e.title) === key) : [];
  if (same.length > 0) {
    const folder = loreFolderOf(draft.category);
    return same.find((e) => e.category === folder) ?? same[0];
  }
  return key ? lookup.find(draft.title) : undefined;
}

/**
 * 解码一次落定。`known` 给了就按磁盘认已有条目、过滤关键词与人名（生成链里那一次）；不给只做形状上的校验与截断
 * （采纳时拿气泡文本重新解析）。一条都没留下也算解析成功（讨论里可能真的一条都没定下来）——是不是空的由调用方判。
 */
export function decodeLoreSettle(text: string, known?: LoreSettleKnown): LoreSettleDecode {
  const found = rowsOf(text);
  if (!found) {
    return { ok: false, message: '不是 {"entries":[…],"questions":[…]} 形状的 JSON 对象' };
  }
  const warnings: string[] = [];
  const lookup = known ? createLoreLookup(known.entries) : undefined;
  const people = new Set((known?.people ?? []).map(normalizeLoreName).filter(Boolean));
  const rows = found.rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  // 这一批里别的条目的名字：关键词不许收（提到一条就命中两条）。
  const batchTitles = rows.map(titleOf).filter(Boolean);
  const seen = new Set<string>();
  const used = new Set<string>();
  const entries: LoreDraft[] = [];

  for (const row of rows) {
    const named = titleOf(row);
    const key = normalizeLoreName(named);
    if (!key) {
      warnings.push('有一条没写名字，丢掉');
      continue;
    }
    if (seen.has(key)) {
      warnings.push(`「${named}」在这一批里重复了，只留第一条`);
      continue;
    }
    seen.add(key);
    if (people.has(key)) {
      warnings.push(`「${named}」是角色卡上的人，人不是设定，丢掉`);
      continue;
    }
    if (entries.length >= LORE_SETTLE_LIMITS.entries) {
      warnings.push(`一次最多落定 ${LORE_SETTLE_LIMITS.entries} 条，「${named}」及之后的没收，下一轮接着落`);
      break;
    }
    const draft = {
      relPath: str(row.relPath ?? row.path) || undefined,
      title: named,
      category: loreFolderOf(str(row.category ?? row.分类) || nameOf(row).category),
    };
    const existing = known ? findSettledEntry(known.entries, draft, lookup) : undefined;
    if (existing && used.has(existing.relPath)) {
      warnings.push(`「${named}」认成了已有条目「${existing.title}」，前面已经有一条改它了，只留第一条`);
      continue;
    }
    const body = decodeLoreBody(row, warnings, `「${named}」`);
    if (!body) {
      warnings.push(`「${named}」正文三节一节内容都没有，丢掉`);
      continue;
    }
    if (existing && sameBody(body, existing.body)) {
      warnings.push(`「${existing.title}」的正文和原来一样（讨论没改它），这一次不动它`);
      continue;
    }
    if (existing) {
      used.add(existing.relPath);
      if (normalizeLoreName(existing.title) !== key) {
        warnings.push(`「${named}」认成了已有条目「${existing.title}」（${existing.relPath}），按改它算`);
      }
    }
    const title = existing?.title ?? named;
    const rawBrief = str(row.brief ?? row.一句话 ?? row.简介);
    if (length(rawBrief) > LORE_ENTRY_LIMITS.brief) {
      warnings.push(`「${title}」的一句话超过 ${LORE_ENTRY_LIMITS.brief} 字，已截断`);
    }
    entries.push({
      ...(existing ? { relPath: existing.relPath } : draft.relPath && !known ? { relPath: draft.relPath } : {}),
      title,
      category: existing?.category ?? draft.category,
      keywords: keywordsOf(row, title, existing, batchTitles, known),
      brief: clip(rawBrief, LORE_ENTRY_LIMITS.brief),
      body,
    });
  }
  const o = found.o ?? {};
  const questions = decodeLoreQuestions(o.questions ?? o.问题 ?? o.还没定的, warnings);
  return { ok: true, value: { entries, questions }, warnings };
}

/** 两份正文是不是同一份：只比字，不比空白与换行。 */
function sameBody(a: string, b: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '');
  return squash(a) === squash(b);
}

/**
 * 关键词：截长、去重、去掉与本条同名的，最多 {@link LORE_EXPAND_LIMITS}.keywords 个。有 `known` 时再过
 * `cleanLoreKeywords`：人名、别的条目的标题（已有的、这一批里别的）、名录里另记着的名字都不要。
 */
function keywordsOf(
  row: Record<string, unknown>,
  title: string,
  existing: LoreEntry | undefined,
  batchTitles: readonly string[],
  known?: LoreSettleKnown
): string[] {
  const words = strings(row.keywords ?? row.关键词).map((k) => clip(k, LORE_LINE_LIMITS.name)).filter(Boolean);
  const self = normalizeLoreName(title);
  const cleaned = known
    ? cleanLoreKeywords(title, words, {
        titles: [
          ...known.entries.filter((e) => e.relPath !== existing?.relPath).map((e) => e.title),
          ...batchTitles.filter((t) => normalizeLoreName(t) !== self),
        ],
        people: known.people,
        recorded: known.recorded,
      })
    : [...new Set(words)].filter((w) => normalizeLoreName(w) !== self);
  return cleaned.slice(0, LORE_EXPAND_LIMITS.keywords);
}

/**
 * 规范化输出：生成链最后交给气泡的那一份，也是采纳时重新解析的那一份。与合同同一个形状，改已有条目的多一个
 * `relPath`——作者在气泡里改了再点写入，走的是同一个 {@link decodeLoreSettle}。
 */
export function renderLoreSettle(value: LoreSettlement): string {
  return JSON.stringify(
    {
      entries: value.entries.map((e) => {
        const { visible, hidden } = splitLoreHidden(e.body);
        return {
          title: e.title,
          category: e.category,
          ...(e.relPath ? { relPath: e.relPath } : {}),
          keywords: e.keywords,
          brief: e.brief,
          body: { ...pickSections(visible, LORE_BODY_KEYS), [LORE_HIDDEN_KEY]: hidden },
        };
      }),
      questions: value.questions,
    },
    null,
    2
  );
}

/** 一条都没定下来时交给气泡的那一段：说清没写什么，列出还没定的（没有卡片，作者接着聊）。 */
export function renderNothingSettled(questions: readonly string[]): string {
  return [
    '讨论里还没有定下来的设定，这一次没有可写入的条目。',
    ...(questions.length > 0 ? ['', '还没定的：', ...questions.map((q, i) => `${i + 1}. ${q}`)] : []),
  ].join('\n');
}

/** 气泡文本 → `loreEntries` 产物的两样。解析不了是空的——采纳时据此说「解析不出」，不写任何东西。 */
export function parseLoreSettle(text: string): LoreSettlement {
  const decoded = decodeLoreSettle(text);
  return decoded.ok ? decoded.value : { entries: [], questions: [] };
}
