/**
 * 产物解析：模型的一坨输出 → 可以采纳落盘的结构化产物。
 *
 * ## 为什么要单独一层
 *
 * `generate` / `settle` 两个能力产出的是**要写进文件的东西**，不是聊天气泡。
 * 写进文件就意味着解析失败＝这一次生成白花钱，而且用户看着一段像模像样的回答
 * 却等不来那张「写入吗」的卡片，只会以为是插件坏了。
 *
 * 所以沿用摘要那一套**三层降级**（summarize.ts 的 parseSummaryResponse）：
 *
 * 1. **JSON**——提示词要求的形状。字段缺失、类型不对、数组/字符串混用逐个兜住，
 *    不整体作废。
 * 2. **Markdown 小节**——模型忽略 JSON 要求、改用 `## 关键事件` 时走这条。
 *    作者手改过的产物重新解析时也走这条。
 * 3. **全文塞进主字段**——信息密度低，但比让这次生成彻底作废强。
 *
 * ## 解析不落盘
 *
 * 这里只把文本变成对象，**一个字都不写磁盘**。落盘在 `generation/accept.ts`，
 * 且必须由用户在那张权限卡片上点了「写入」才发生（AGENTS.md 第 3 / 19 条：
 * 不静默覆盖、产物落盘前必须过一遍人）。分开还有一个好处：产出先摊在气泡里
 * 给他看，他改两个字再点写入。
 *
 * ## 本期（一期）的架构产物是过渡版
 *
 * 架构四件与细纲批次的提示词、JSON 合同、修复链从 AI-Novel-Writer 移植过来是二期
 * 的事。这里先认最朴素的两种形状（JSON 同名键 / Markdown 小节），保证新链路
 * 每一层都有落点。
 */
import { pickSections } from '../model/markdown';
import { PLOT_SECTION_KEYS, PlotSections, emptyPlotSections } from '../model/plotFile';
import {
  BookConfig,
  NARRATIVE_POVS,
  NarrativePov,
  PLOT_STRUCTURES,
  PlotStructure,
  SETTING_SECTION_KEYS,
  SettingFileDoc,
} from '../model/settingFile';
import { CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { CreationAction, CreationTarget, SettingDoc } from '../model/pipeline';
import { extractJsonObject, stripCodeFence } from './parse';
import { toSectionText } from './summarize';

// ---------------------------------------------------------------- 产物形状

/** 配置的 frontmatter 字段。产物给了就用产物的，没给就沿用磁盘那份。 */
export type ConfigFields = Partial<
  Pick<BookConfig, 'genre' | 'subGenre' | 'audience' | 'structure' | 'pov' | 'totalChapters' | 'wordsPerChapter'>
>;

/** 角色图谱里的一个人。落盘时变成一张角色卡（同名已存在的不动）。 */
export interface RosterEntry {
  name: string;
  /** 主角 / 盟友 / 对手……落进角色卡的 tags。 */
  role: string;
  aliases: string[];
  sections: Partial<CharacterSections>;
}

/** 一章细纲的规划字段（三节之外的那些）。 */
export interface PlotFields {
  sections: PlotSections;
  title?: string;
  role?: string;
  characters?: string[];
  targetWords?: number;
}

/**
 * 解析出来的产物。`kind` 与 `CreationTarget.kind` 不完全对应：架构层四件里
 * 「角色图谱」产出的是一组角色卡，其余三件是一份文档。
 */
export type Artifact =
  | { kind: 'settingDoc'; doc: SettingFileDoc; sections: Record<string, string>; config?: ConfigFields }
  | { kind: 'characterRoster'; characters: RosterEntry[] }
  | { kind: 'outlineDoc'; text: string }
  | ({ kind: 'plot' } & PlotFields)
  | { kind: 'manuscript'; text: string };

/**
 * 按 action 解析。**绝不抛**：解析这一步出异常，用户丢的是刚花掉的那次调用。
 * 实在认不出就退回一个「全文塞进主字段」的产物，让他至少能手工取用。
 *
 * 架构层要看 target 才分得清是哪一件（四件同属一个阶段）；其余阶段只看 action。
 */
export function parseArtifact(action: CreationAction, raw: string, target?: CreationTarget): Artifact {
  const text = stripCodeFence(raw).trim();
  switch (action.stage) {
    case 'manuscript':
      return { kind: 'manuscript', text };
    case 'outline':
      // 大纲是 Markdown，没有 JSON 可解——原样收下。
      return { kind: 'outlineDoc', text };
    case 'plot':
      return { kind: 'plot', ...(parsePlotStrict(text) ?? { sections: { ...emptyPlotSections(), 关键事件: text } }) };
    case 'setting': {
      const doc: SettingDoc = target?.kind === 'setting' ? target.doc : 'config';
      return doc === 'characters'
        ? { kind: 'characterRoster', characters: parseRoster(text) }
        : parseSettingArtifact(doc, text);
    }
  }
}

/** 产物是不是空的。空产物不必问「写不写」——写下去只会得到一个空文件。 */
export function isArtifactEmpty(artifact: Artifact): boolean {
  switch (artifact.kind) {
    case 'outlineDoc':
    case 'manuscript':
      return !artifact.text.trim();
    case 'settingDoc':
      return !Object.values(artifact.sections).some((v) => v.trim());
    case 'characterRoster':
      return artifact.characters.length === 0;
    case 'plot':
      return !Object.values(artifact.sections).some((v) => v.trim());
  }
}

/** 一句话描述，给落盘卡片与气泡末尾那一行用（「细纲 · 3/3 节」「角色图谱 · 5 人」）。 */
export function describeArtifact(artifact: Artifact): string {
  switch (artifact.kind) {
    case 'settingDoc': {
      const keys = SETTING_SECTION_KEYS[artifact.doc];
      const filled = keys.filter((k) => artifact.sections[k]?.trim()).length;
      return `${SETTING_TITLE[artifact.doc]} · ${filled}/${keys.length} 节`;
    }
    case 'characterRoster':
      return `角色图谱 · ${artifact.characters.length} 人`;
    case 'outlineDoc':
      return `情节大纲 · ${artifact.text.length} 字`;
    case 'plot': {
      const filled = Object.values(artifact.sections).filter((v) => v.trim()).length;
      return `细纲 · ${filled}/${PLOT_SECTION_KEYS.length} 节`;
    }
    case 'manuscript':
      return `正文 · ${artifact.text.length} 字`;
  }
}

const SETTING_TITLE: Record<SettingFileDoc, string> = {
  config: '小说配置',
  premise: '故事前提',
  world: '世界观',
};

// ---------------------------------------------------------------- 细纲

/** JSON 里三节的别名：移植过来的蓝图合同用的是英文键。 */
const PLOT_KEY_ALIASES: Record<(typeof PLOT_SECTION_KEYS)[number], string[]> = {
  本章目的: ['本章目的', 'purpose', '目的', 'goal', '目标'],
  关键事件: ['关键事件', 'keyEvents', 'events', '事件'],
  章末钩子: ['章末钩子', 'suspenseHook', 'hook', '钩子'],
};

/**
 * 只走前两层，**不做全文兜底**。解析不出结构就返回 undefined。
 *
 * 批量路径（工程页一次给几十章写细纲）必须用这个：那里没有人逐份过目，
 * 而全文兜底会把模型的一句「我不太确定这一章写什么」变成一份「已规划」的
 * 细纲——流水线状态从此开始撒谎，紧接着的批量写正文会照着这份垃圾往下写。
 *
 * 创作页反过来走 {@link parseArtifact} 的兜底：那里产物就摊在屏幕上，
 * 用户看得见它是什么，兜底至少留住了这次调用的钱。
 */
export function parsePlotStrict(text: string): PlotFields | undefined {
  const fromJson = objectOf(text);
  if (fromJson) {
    const sections = emptyPlotSections();
    for (const key of PLOT_SECTION_KEYS) {
      sections[key] = toSectionText(pickAlias(fromJson, PLOT_KEY_ALIASES[key]));
    }
    // 语法合法但完全不相干的 JSON（`{"text":"..."}`）认下来会得到一份空细纲
    // **并且不再降级**，比解析失败更糟。
    if (Object.values(sections).some((v) => v.trim())) {
      return {
        sections,
        title: clipTitle(str(fromJson.title ?? fromJson.标题)),
        role: str(fromJson.role ?? fromJson.结构功能 ?? fromJson.功能),
        characters: strList(fromJson.characters ?? fromJson.出场角色 ?? fromJson.人物),
        targetWords: num(fromJson.targetWords ?? fromJson.目标字数),
      };
    }
  }

  const picked = pickSections(text, PLOT_SECTION_KEYS) as PlotSections;
  return Object.values(picked).some((v) => v.trim()) ? { sections: { ...emptyPlotSections(), ...picked } } : undefined;
}

// ---------------------------------------------------------------- 架构

/** 各件兜底塞进哪一节：那一件的主体，也就是「填过没有」看的那一节。 */
const SETTING_FALLBACK: Record<SettingFileDoc, string> = {
  config: '核心梗概',
  premise: '核心冲突链',
  world: '规则与漏洞',
};

/** 小说配置 / 前提 / 世界观：JSON 同名键 → Markdown 小节 → 全文塞进主体那一节。 */
export function parseSettingArtifact(doc: SettingFileDoc, text: string): Extract<Artifact, { kind: 'settingDoc' }> {
  const keys = SETTING_SECTION_KEYS[doc];
  const obj = objectOf(text);
  const sections: Record<string, string> = Object.fromEntries(keys.map((k) => [k, '']));
  let config: ConfigFields | undefined;

  if (obj) {
    for (const key of keys) {
      sections[key] = toSectionText(obj[key]);
    }
    if (doc === 'config') {
      config = {
        genre: str(obj.genre ?? obj.类型) || undefined,
        subGenre: str(obj.subGenre ?? obj.子类型) || undefined,
        audience: str(obj.audience ?? obj.targetAudience ?? obj.受众) || undefined,
        structure: pickEnum<PlotStructure>(obj.structure ?? obj.plotStructure, PLOT_STRUCTURES),
        pov: pickEnum<NarrativePov>(obj.pov ?? obj.narrativePOV, NARRATIVE_POVS),
        totalChapters: num(obj.totalChapters ?? obj.总章数),
        wordsPerChapter: num(obj.wordsPerChapter ?? obj.每章字数),
      };
    }
  }
  if (!Object.values(sections).some((v) => v.trim())) {
    const picked = pickSections(text, keys);
    for (const key of keys) {
      sections[key] = picked[key] ?? '';
    }
  }
  if (!Object.values(sections).some((v) => v.trim()) && text.trim()) {
    sections[SETTING_FALLBACK[doc]] = text.trim();
  }
  return { kind: 'settingDoc', doc, sections, config };
}

/**
 * 角色图谱：`{characters:[{name, role, 身份, 性格, …}]}` → 裸数组 → 每个 `## 名字` 一人。
 *
 * Markdown 那一层把整节内容当作「身份」：模型不按 JSON 答时，能留住的就是
 * 「这个人是谁」这一段。名字相同的只收第一个。
 */
export function parseRoster(text: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: RosterEntry) => {
    if (entry.name && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  };

  const rows = listOf(text, 'characters', 'roster', '角色', '人物');
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const sections: Partial<CharacterSections> = {};
    for (const key of CHARACTER_SECTION_KEYS) {
      const value = toSectionText(o[key]);
      if (value) {
        sections[key] = value;
      }
    }
    if (!sections.身份) {
      const identity = str(o.identity ?? o.profile ?? o.description ?? o.简介);
      if (identity) {
        sections.身份 = identity;
      }
    }
    push({
      name: clipTitle(str(o.name ?? o.姓名 ?? o.名字)),
      role: str(o.role ?? o.定位 ?? o.角色定位),
      aliases: strList(o.aliases ?? o.别名),
      sections,
    });
  }
  if (out.length > 0) {
    return out;
  }

  // Markdown：每个 `## 名字` 一节。
  const lines = text.split(/\r?\n/);
  let current: { name: string; buf: string[] } | undefined;
  const flush = () => {
    if (current) {
      const body = current.buf.join('\n').trim();
      push({ name: clipTitle(current.name), role: '', aliases: [], sections: body ? { 身份: body } : {} });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = { name: m[1].replace(/[（(].*$/, '').trim(), buf: [] };
    } else {
      current?.buf.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- 取值工具

/** 最外层 JSON 对象。不是对象（数组、纯文本）返回 undefined。 */
function objectOf(text: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(text);
  if (!json) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(json);
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 清单：`{characters:[…]}` → `[…]` 裸数组。
 *
 * 模型漏掉外层键是每天都会遇到的事；键名认不出时取第一个数组值——
 * `{"角色列表":[…]}` 这种也别丢。
 */
function listOf(text: string, ...keys: string[]): unknown[] {
  const obj = objectOf(text);
  if (obj) {
    for (const key of keys) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) {
      return firstArray;
    }
  }
  return bareArray(text) ?? [];
}

function bareArray(text: string): unknown[] | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function pickAlias(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) {
      return obj[key];
    }
  }
  return undefined;
}

function pickEnum<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  const s = str(v).toLowerCase();
  return values.find((x) => x === s);
}

/**
 * 标题长度收口。
 *
 * 标题会变成文件名（`012-<标题>.md`），而模型很爱把一整句梗概当标题。
 * 在标点处断一次再截断，比硬切 18 个字读起来像个标题。
 */
function clipTitle(text: string): string {
  const head = text.split(/[。！？；;\n]/)[0].trim() || text.trim();
  return head.length > 18 ? head.slice(0, 18) : head;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** 字符串数组；写成 `a、b` 的一个字符串也拆开。 */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
