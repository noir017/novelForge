/**
 * 展开一条设定（完善设定，2026-10-19）的解码、规范化与气泡往返。**纯函数、绝不抛。**
 *
 * 合同（context/loreExpandPrompt.ts）：
 *
 * ```json
 * { "brief": "…", "keywords": ["…"],
 *   "body": { "概要": "…", "规则与边界": "…", "现状": "…", "暗设": "…" },
 *   "children": [{ "name": "…", "category": "…", "brief": "…" }],
 *   "questions": ["…"] }
 * ```
 *
 * 程序这一侧的校验不加调用（设计稿 §1「合同」）：一句话截 {@link LORE_ENTRY_LIMITS}.brief 字；明面三节按上限截
 * （合计 {@link LORE_ENTRY_LIMITS}.body，做法同设定清单的 `normalizeLoreBody`），暗设另截
 * {@link LORE_ENTRY_LIMITS}.暗设；新关键词过 `cleanLoreKeywords`；`children` 丢掉名字已有条目的、是人名的、
 * 重名的，最多 {@link LORE_EXPAND_LIMITS}.children 条；`questions` 最多 {@link LORE_EXPAND_LIMITS}.questions 条、
 * 每条截 {@link LORE_EXPAND_LIMITS}.question 字。
 *
 * **解析不了就没有产物**，不做全文兜底：条目被一段没解析开的原文盖掉，比没写更糟（同定稿）。
 *
 * ## 气泡里放的就是将要落盘的样子
 *
 * 生成链（generation/structured.ts 的 `completeLoreExpand`）解码之后把规范化结果交给气泡
 * （{@link renderLoreExpansion}，与合同同一个形状），采纳时拿气泡里当下的文本重新解析（作者可能改过，
 * {@link parseLoreExpansion}）。往返不丢字段：`questions` 也在里面——它只上卡片，不写进任何文件
 * （generation/accept.ts 的 `acceptLoreEntries` 不读它）。
 */
import { hasContent, pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_LINE_LIMITS,
  cleanLoreKeywords,
  createLoreLookup,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import { loreFolderOf, normalizeLoreBody } from './loreList';
import { stripCodeFence, stripTrailingCommas } from './parse';
import { parseJson, singleJsonObject } from './structuredJson';

/**
 * 一条要落盘的设定（`loreEntries` 产物里的一项）。展开时第一项是目标条目（带 `relPath`，按路径认、不按标题——
 * 展开不改名），其余是建议拆出来的子条目（没有 `relPath`，正文空着，落盘时建空条目）。
 */
export interface LoreDraft {
  /** 已有条目的工程相对路径；要新建的没有。 */
  relPath?: string;
  title: string;
  /** 分类（相对 `lore/` 的目录）。目标条目以它实际所在的目录为准，这里是空串。 */
  category: string;
  keywords: string[];
  brief: string;
  /** 正文：明面三节，有暗设时最后一节是 `## 暗设`。子条目是空串。 */
  body: string;
}

/** 建议拆出来的一条子条目：只有名字、分类、一句话。 */
export interface LoreChild {
  name: string;
  category: string;
  brief: string;
}

/** 规范化之后的一份展开。 */
export interface LoreExpansion {
  brief: string;
  /** 模型这一次给的关键词（已过滤），落盘时并进已有的（只增不减）。 */
  keywords: string[];
  /** 正文：明面三节 + 可选的 `## 暗设`。 */
  body: string;
  children: LoreChild[];
  questions: string[];
}

/** 解码要对照的已有东西。不给就只做形状上的校验（采纳时拿气泡文本重新解析，那时不读盘）。 */
export interface LoreExpandKnown {
  /** 目标条目的标题：子条目不许与它同名，关键词里去掉它。 */
  title: string;
  /** 全部条目（含目标条目）：子条目名字已有条目的丢掉；别的条目的标题不进关键词。 */
  entries: readonly LoreEntry[];
  /** 角色卡上的名字与别称：人不是设定，不进关键词、不拆成子条目。 */
  people: readonly string[];
  /** 名录里另记着、还没建条目的名字：不进关键词（同建条目、整合）。 */
  recorded: readonly string[];
}

export type LoreExpandDecode =
  | { ok: true; value: LoreExpansion; warnings: string[] }
  | { ok: false; message: string };

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

/** 字符串数组；写成一个字符串时按 `sep` 拆开。 */
function strings(v: unknown, sep: RegExp): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(sep).map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * 最外层那个对象：整段就是 JSON → 唯一一个完整对象 → 去掉 `]` `}` 前多出来的逗号再试一次（模型最常见的
 * 语法错，不改任何值，不必为它调一次模型）。都不行返回 undefined。展开与落定设定共用（`loreJsonObject`）。
 */
export function loreJsonObject(text: string): Record<string, unknown> | undefined {
  const whole = parseJson(text);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    return whole as Record<string, unknown>;
  }
  const single = singleJsonObject(text);
  if (single.ok) {
    return single.value;
  }
  const fixed = parseJson(stripTrailingCommas(stripCodeFence(text)));
  return fixed && typeof fixed === 'object' && !Array.isArray(fixed) ? (fixed as Record<string, unknown>) : undefined;
}

/** 模型没包一层 `body`、直接把几节写成顶层字段时（`{brief, 概要, 规则与边界, …}`）。 */
function bodyValueOf(o: Record<string, unknown>): unknown {
  if (o.body !== undefined) {
    return o.body;
  }
  if (o.content !== undefined) {
    return o.content;
  }
  return LORE_BODY_KEYS.some((k) => o[k] !== undefined) ? o : undefined;
}

/** 一节的文字：数组按行接起来。 */
function sectionText(v: unknown): string {
  return Array.isArray(v) ? v.map(str).filter(Boolean).join('\n') : str(v);
}

/**
 * 正文拆成明面与暗设：给成对象按键取（暗设认 `暗设` / `hidden`，也认写在顶层的），给成 Markdown 按
 * 「暗设」开头的二级标题切（`splitLoreHidden`，与条目的认法同一份）。
 */
function splitBody(value: unknown, o: Record<string, unknown>): { visible: unknown; hidden: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const b = value as Record<string, unknown>;
    const hidden = sectionText(b[LORE_HIDDEN_KEY] ?? b.hidden ?? o[LORE_HIDDEN_KEY] ?? o.hidden);
    return { visible: b, hidden };
  }
  const text = sectionText(value);
  const split = splitLoreHidden(text);
  return { visible: split.visible, hidden: split.hidden || sectionText(o[LORE_HIDDEN_KEY] ?? o.hidden) };
}

/** 「（未交代）」「无」「没有」这类写法当没有暗设。 */
const NO_HIDDEN = /^[（(]?\s*(?:未交代|无|暂无|没有|空)\s*[)）]?$/u;

/**
 * 解码一份展开。`known` 给了就按磁盘上的东西过滤（生成链里那一次）；不给只做形状上的校验与截断
 * （采纳时拿气泡文本重新解析）。明面三节一节内容都没有算解析不了。
 */
export function decodeLoreExpansion(text: string, known?: LoreExpandKnown): LoreExpandDecode {
  const o = loreJsonObject(text);
  if (!o) {
    return { ok: false, message: '不是 {"brief","keywords","body",…} 形状的 JSON 对象' };
  }
  const warnings: string[] = [];
  const body = decodeLoreBody(o, warnings);
  if (!body) {
    return { ok: false, message: '正文三节（概要 / 规则与边界 / 现状）一节内容都没有' };
  }

  const rawBrief = str(o.brief ?? o.一句话 ?? o.简介);
  if (length(rawBrief) > LORE_ENTRY_LIMITS.brief) {
    warnings.push(`一句话超过 ${LORE_ENTRY_LIMITS.brief} 字，已截断`);
  }
  const brief = clip(rawBrief, LORE_ENTRY_LIMITS.brief);

  const children = decodeChildren(o.children ?? o.子条目 ?? o.split, known, warnings);
  const keywords = decodeKeywords(strings(o.keywords ?? o.关键词, /[,，、]/), children, known);
  const questions = decodeLoreQuestions(o.questions ?? o.问题 ?? o.还没定的, warnings);
  return { ok: true, value: { brief, keywords, body, children, questions }, warnings };
}

/**
 * 一条的正文：明面三节按上限截（合计 {@link LORE_ENTRY_LIMITS}.body，做法同设定清单的 `normalizeLoreBody`），
 * 暗设另截 {@link LORE_ENTRY_LIMITS}.暗设，有就接在最后一节 `## 暗设`。明面一节内容都没有返回空串。截了什么写进
 * `warnings`，`who` 是前缀（落定设定一次好几条，说清是哪一条）。展开与落定设定（features/loreSettle.ts）共用。
 */
export function decodeLoreBody(o: Record<string, unknown>, warnings: string[], who = ''): string {
  const { visible, hidden: rawHidden } = splitBody(bodyValueOf(o), o);
  const { body: visibleBody, clipped } = normalizeLoreBody(visible, LORE_ENTRY_LIMITS.body);
  if (!visibleBody) {
    return '';
  }
  if (clipped) {
    warnings.push(
      `${who}正文超长，已截断（每节不超过 ${LORE_BODY_KEYS.map((k) => LORE_ENTRY_LIMITS[k]).join(' / ')} 字，合计不超过 ${LORE_ENTRY_LIMITS.body} 字）`
    );
  }
  const hiddenText = hasContent(rawHidden) && !NO_HIDDEN.test(rawHidden.trim()) ? rawHidden.trim() : '';
  const hidden = Array.from(hiddenText).slice(0, LORE_ENTRY_LIMITS.暗设).join('').trim();
  if (hidden.length < hiddenText.length) {
    warnings.push(`${who}暗设超过 ${LORE_ENTRY_LIMITS.暗设} 字，已截断`);
  }
  return hidden ? `${visibleBody}\n\n## ${LORE_HIDDEN_KEY}\n${hidden}` : visibleBody;
}

/**
 * 关键词：截长、去重、去掉与本条同名的，最多 {@link LORE_EXPAND_LIMITS}.keywords 个。有 `known` 时再过
 * `cleanLoreKeywords`：人名、别的条目的标题（含这一次建议拆出去的子条目——那是别的东西）、名录里另记着的名字都不要。
 */
function decodeKeywords(raw: readonly string[], children: readonly LoreChild[], known?: LoreExpandKnown): string[] {
  const words = raw.map((k) => clip(k, LORE_LINE_LIMITS.name)).filter(Boolean);
  const title = known?.title ?? '';
  const cleaned = known
    ? cleanLoreKeywords(title, words, {
        titles: [...known.entries.filter((e) => normalizeLoreName(e.title) !== normalizeLoreName(title)).map((e) => e.title), ...children.map((c) => c.name)],
        people: known.people,
        recorded: known.recorded,
      })
    : [...new Set(words)];
  return cleaned.slice(0, LORE_EXPAND_LIMITS.keywords);
}

/**
 * 子条目：只收名字、分类、一句话。名字截长；与本条同名的、重名的丢掉；有 `known` 时名字（或关键词）已被
 * 已有条目占了的、是角色卡上的人的也丢掉（落盘时按磁盘再认一遍）。最多 {@link LORE_EXPAND_LIMITS}.children 条。
 */
function decodeChildren(raw: unknown, known: LoreExpandKnown | undefined, warnings: string[]): LoreChild[] {
  const rows = Array.isArray(raw) ? raw : [];
  const lookup = known ? createLoreLookup(known.entries) : undefined;
  const people = new Set((known?.people ?? []).map(normalizeLoreName).filter(Boolean));
  const self = normalizeLoreName(known?.title ?? '');
  const seen = new Set<string>();
  const out: LoreChild[] = [];
  for (const row of rows) {
    const c = row && typeof row === 'object' ? (row as Record<string, unknown>) : typeof row === 'string' ? { name: row } : undefined;
    const name = clip(str(c?.name ?? c?.title ?? c?.名称 ?? c?.名字), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(name);
    if (!c || !key || key === self || seen.has(key)) {
      continue;
    }
    if (people.has(key)) {
      warnings.push(`建议拆出的「${name}」是角色卡上的人，人不是设定，丢掉`);
      continue;
    }
    if (lookup?.find(name)) {
      warnings.push(`建议拆出的「${name}」已经有条目了（${lookup.find(name)!.title}），不另建`);
      continue;
    }
    seen.add(key);
    if (out.length >= LORE_EXPAND_LIMITS.children) {
      warnings.push(`建议拆出的子条目超过 ${LORE_EXPAND_LIMITS.children} 条，「${name}」及之后的没收`);
      break;
    }
    out.push({
      name,
      category: loreFolderOf(str(c.category ?? c.分类)),
      brief: clip(str(c.brief ?? c.一句话 ?? c.简介), LORE_ENTRY_LIMITS.brief),
    });
  }
  return out;
}

/**
 * 还没定的问题：一条一行，去重，每条截 {@link LORE_EXPAND_LIMITS}.question 字，最多 {@link LORE_EXPAND_LIMITS}.questions 条。
 * 展开与落定设定共用。
 */
export function decodeLoreQuestions(raw: unknown, warnings: string[]): string[] {
  // 问题里常有逗号，写成一个字符串时只按换行拆。
  const list = strings(raw, /\n+/).map((q) => q.replace(/^\s*(?:[-*·•]|\d+[.、)．])\s*/u, ''));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of list) {
    const text = clip(q, LORE_EXPAND_LIMITS.question);
    const key = normalizeLoreName(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(text);
  }
  if (out.length > LORE_EXPAND_LIMITS.questions) {
    warnings.push(`还没定的问题有 ${out.length} 条，只留前 ${LORE_EXPAND_LIMITS.questions} 条`);
  }
  return out.slice(0, LORE_EXPAND_LIMITS.questions);
}

/**
 * 规范化输出：生成链最后交给气泡的那一份，也是采纳时重新解析的那一份。与合同同一个形状——作者在气泡里改了
 * 再点写入，走的是同一个 {@link decodeLoreExpansion}。
 */
export function renderLoreExpansion(e: LoreExpansion): string {
  const { visible, hidden } = splitLoreHidden(e.body);
  const sections = pickSections(visible, LORE_BODY_KEYS);
  return JSON.stringify(
    {
      brief: e.brief,
      keywords: e.keywords,
      body: { ...sections, [LORE_HIDDEN_KEY]: hidden },
      children: e.children,
      questions: e.questions,
    },
    null,
    2
  );
}

/**
 * 气泡文本 → `loreEntries` 产物的两样：目标条目在第一项（按 `relPath` 认，标题取文件名，落盘时以磁盘上的
 * 标题为准），其余是子条目（关键词就是名字本身，正文空着）。解析不了是空的——采纳时据此说「解析不出」，
 * 不写任何东西。
 */
export function parseLoreExpansion(text: string, relPath: string): { entries: LoreDraft[]; questions: string[] } {
  const decoded = decodeLoreExpansion(text);
  if (!decoded.ok) {
    return { entries: [], questions: [] };
  }
  const { value } = decoded;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
  return {
    entries: [
      { relPath, title: base, category: '', keywords: value.keywords, brief: value.brief, body: value.body },
      ...value.children.map((c) => ({ title: c.name, category: c.category, keywords: [c.name], brief: c.brief, body: '' })),
    ],
    questions: value.questions,
  };
}
