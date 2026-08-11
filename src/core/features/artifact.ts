/**
 * 产物解析：模型的一坨输出 → 可以采纳落盘的结构化产物。
 *
 * ## 为什么要单独一层
 *
 * `generate` / `rewrite` / `split` 三个能力产出的是**要写进文件的东西**，
 * 不是聊天气泡。写进文件就意味着解析失败＝这一次生成白花钱，而且用户看着
 * 一段像模像样的回答却点不了「采纳」，只会以为是插件坏了。
 *
 * 所以沿用摘要那一套**三层降级**（summarize.ts 的 parseSummaryResponse）：
 *
 * 1. **JSON**——提示词要求的形状。字段缺失、类型不对、数组/字符串混用逐个兜住，
 *    不整体作废。
 * 2. **Markdown 小节**——模型忽略 JSON 要求、改用 `## 本章目标` 时走这条。
 *    作者手改过的产物重新解析时也走这条。
 * 3. **全文塞进主字段**——信息密度低，但比让这次生成彻底作废强。
 *
 * ## 解析不落盘
 *
 * 这里只把文本变成对象，**一个字都不写磁盘**。落盘在 creation.ts 的
 * `acceptArtifact`，且必须由用户点了「采纳」才发生（AGENTS.md 第 3 条：
 * 不静默覆盖）。分开还有一个好处：前端可以先把解析结果摊开给用户看，
 * 他改两个字再采纳。
 */
import { pickSections } from '../model/markdown';
import { PLAN_SECTION_KEYS, PlanSections, emptyPlanSections } from '../model/planFile';
import {
  SCENE_SECTION_KEYS,
  SceneSectionKey,
  SceneSections,
  emptySceneSections,
  parseList,
  renderList,
} from '../model/sceneFile';
import { CreationAction } from '../model/pipeline';
import { extractJsonObject, stripCodeFence, toSectionText } from './summarize';

// ---------------------------------------------------------------- 产物形状

/** 大纲拆章的一项。`order` 缺席时由调用方按现有章数续号。 */
export interface ChapterOutlineItem {
  order?: number;
  title: string;
  goal: string;
  arc: string;
}

/** 细纲拆场景的一项。 */
export interface SceneOutlineItem {
  title: string;
  place: string;
  time: string;
  characters: string[];
  goal: string;
  targetWords?: number;
}

/**
 * 解析出来的产物。`kind` 与 `CreationTarget.kind` 不完全对应——
 * `split` 产出的是**下一层**的东西（大纲 split 出章节清单，细纲 split 出场景清单）。
 */
export type Artifact =
  | { kind: 'outlineDoc'; text: string }
  | { kind: 'chapterList'; chapters: ChapterOutlineItem[] }
  | { kind: 'plan'; sections: PlanSections }
  | { kind: 'sceneList'; scenes: SceneOutlineItem[] }
  | {
      kind: 'scene';
      place: string;
      time: string;
      characters: string[];
      targetWords?: number;
      sections: SceneSections;
    }
  | { kind: 'manuscript'; text: string };

/**
 * 按 action 解析。**绝不抛**：解析这一步出异常，用户丢的是刚花掉的那次调用。
 * 实在认不出就退回一个「全文塞进主字段」的产物，让他至少能手工取用。
 */
export function parseArtifact(action: CreationAction, raw: string): Artifact {
  const text = stripCodeFence(raw).trim();
  const { stage, capability } = action;

  if (stage === 'manuscript') {
    return { kind: 'manuscript', text };
  }
  if (capability === 'split') {
    return stage === 'outline'
      ? { kind: 'chapterList', chapters: parseChapterList(text) }
      : { kind: 'sceneList', scenes: parseSceneList(text) };
  }
  switch (stage) {
    case 'outline':
      // 大纲本来就是 Markdown，没有 JSON 可解——原样收下。
      return { kind: 'outlineDoc', text };
    case 'plan':
      return { kind: 'plan', sections: parsePlanSections(text) };
    case 'scene':
      return parseSceneCard(text);
  }
}

/** 产物是不是空的。空产物不该给「采纳」按钮——点了只会写出一个空文件。 */
export function isArtifactEmpty(artifact: Artifact): boolean {
  switch (artifact.kind) {
    case 'outlineDoc':
    case 'manuscript':
      return !artifact.text.trim();
    case 'chapterList':
      return artifact.chapters.length === 0;
    case 'sceneList':
      return artifact.scenes.length === 0;
    case 'plan':
      return !Object.values(artifact.sections).some((v) => v.trim());
    case 'scene':
      return !Object.values(artifact.sections).some((v) => v.trim());
  }
}

/** 一句话描述，给采纳卡片的标题用（「4 个场景」「细纲 · 5 节」）。 */
export function describeArtifact(artifact: Artifact): string {
  switch (artifact.kind) {
    case 'outlineDoc':
      return `全书大纲 · ${artifact.text.length} 字`;
    case 'chapterList':
      return `${artifact.chapters.length} 章`;
    case 'plan': {
      const filled = Object.values(artifact.sections).filter((v) => v.trim()).length;
      return `细纲 · ${filled}/${PLAN_SECTION_KEYS.length} 节`;
    }
    case 'sceneList':
      return `${artifact.scenes.length} 场`;
    case 'scene': {
      const filled = Object.values(artifact.sections).filter((v) => v.trim()).length;
      return `场景卡 · ${filled}/${SCENE_SECTION_KEYS.length} 节`;
    }
    case 'manuscript':
      return `正文 · ${artifact.text.length} 字`;
  }
}

// ---------------------------------------------------------------- 细纲

/** 五个小节。JSON → Markdown 小节 → 全文塞进「本章目标」。 */
export function parsePlanSections(text: string): PlanSections {
  return parsePlanStrict(text) ?? { ...emptyPlanSections(), 本章目标: text.trim() };
}

/**
 * 只走前两层，**不做全文兜底**。解析不出结构就返回 undefined。
 *
 * 批量路径（工程页一次给几十章生成细纲）必须用这个：那里没有人逐份过目，
 * 而全文兜底会把模型的一句「我不太确定这一章写什么」变成一份「已规划」的
 * 细纲——流水线状态从此开始撒谎，紧接着的批量拆场景会照着这份垃圾往下拆。
 *
 * 创作页反过来该用 {@link parsePlanSections}：那里产物就摊在屏幕上，
 * 用户看得见它是什么，兜底至少留住了这次调用的钱。
 */
export function parsePlanStrict(text: string): PlanSections | undefined {
  const fromJson = objectOf(text);
  if (fromJson) {
    const sections = emptyPlanSections();
    for (const key of PLAN_SECTION_KEYS) {
      sections[key] = toSectionText(fromJson[key]);
    }
    // 判据与摘要同源：语法合法但完全不相干的 JSON（`{"text":"..."}`）
    // 认下来会得到一份空细纲**并且不再降级**，比解析失败更糟。
    if (Object.values(sections).some((v) => v.trim())) {
      return sections;
    }
  }

  const picked = pickSections(text, PLAN_SECTION_KEYS) as PlanSections;
  return Object.values(picked).some((v) => v.trim()) ? { ...emptyPlanSections(), ...picked } : undefined;
}

// ---------------------------------------------------------------- 场景卡

function parseSceneCard(text: string): Extract<Artifact, { kind: 'scene' }> {
  const obj = objectOf(text);
  const sections = emptySceneSections();

  if (obj) {
    for (const key of SCENE_SECTION_KEYS) {
      sections[key] = sectionValue(key, obj[key]);
    }
    if (Object.values(sections).some((v) => v.trim())) {
      return {
        kind: 'scene',
        place: str(obj.place ?? obj.地点),
        time: str(obj.time ?? obj.时间),
        characters: strArray(obj.characters ?? obj.人物 ?? obj.在场人物),
        targetWords: num(obj.targetWords ?? obj.目标字数),
        sections,
      };
    }
  }

  const picked = pickSections(text, SCENE_SECTION_KEYS) as SceneSections;
  const merged = Object.values(picked).some((v) => v.trim())
    ? { ...sections, ...picked }
    : { ...sections, 必须发生: text.trim() };
  return { kind: 'scene', place: '', time: '', characters: [], sections: merged };
}

/**
 * 「必须发生」「不能发生」是列表，其余是散文。
 *
 * 模型给这两节的形状最不稳定：有时数组、有时带 `-` 的多行字符串、有时一行
 * 顿号分隔。统一归一成 Markdown 列表，因为落盘的小节格式是列表，而
 * `parseList` 读回来时三种写法都认。
 */
function sectionValue(key: SceneSectionKey, v: unknown): string {
  const text = toSectionText(v);
  if (key !== '必须发生' && key !== '不能发生') {
    return text;
  }
  const items = parseList(text);
  // 单行顿号分隔的写法（`翻墙、被发现、逃走`）拆成三条，否则「3~6 条骨架」
  // 会变成一条又臭又长的。
  const expanded = items.length === 1 && /[、；;]/.test(items[0])
    ? items[0].split(/[、；;]/).map((s) => s.trim()).filter(Boolean)
    : items;
  return renderList(expanded);
}

// ---------------------------------------------------------------- 清单类

/** 大纲拆章。JSON `{chapters:[…]}` → 裸数组 → Markdown 列表逐行。 */
export function parseChapterList(text: string): ChapterOutlineItem[] {
  const rows = listOf(text, 'chapters', '章节');
  const out: ChapterOutlineItem[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const title = cleanListLine(row);
      if (title) {
        out.push({ title: clipTitle(title), goal: title, arc: '' });
      }
      continue;
    }
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const title = str(o.title ?? o.标题 ?? o.name);
    const goal = str(o.goal ?? o.目标 ?? o.summary ?? o.梗概);
    if (!title && !goal) {
      continue;
    }
    out.push({
      order: num(o.order ?? o.序号 ?? o.chapter),
      title: clipTitle(title || goal),
      goal,
      arc: str(o.arc ?? o.幕 ?? o.卷),
    });
  }
  return out;
}

/** 细纲拆场景。 */
export function parseSceneList(text: string): SceneOutlineItem[] {
  const rows = listOf(text, 'scenes', '场景');
  const out: SceneOutlineItem[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const title = cleanListLine(row);
      if (title) {
        out.push({ title: clipTitle(title), place: '', time: '', characters: [], goal: title });
      }
      continue;
    }
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const title = str(o.title ?? o.标题 ?? o.name);
    const goal = str(o.goal ?? o.目的 ?? o.目标);
    if (!title && !goal) {
      continue;
    }
    out.push({
      title: clipTitle(title || goal),
      place: str(o.place ?? o.地点),
      time: str(o.time ?? o.时间),
      characters: strArray(o.characters ?? o.人物 ?? o.在场人物),
      goal,
      targetWords: num(o.targetWords ?? o.目标字数),
    });
  }
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
 * 清单：`{chapters:[…]}` → `[…]` 裸数组 → Markdown 逐行。
 *
 * 三条路都要留。模型漏掉外层键、或整个忘了 JSON 直接列了一串
 * `1. 夜入青云 —— 林昭进入宗门`，都是每天都会遇到的事。
 */
function listOf(text: string, ...keys: string[]): unknown[] {
  const obj = objectOf(text);
  if (obj) {
    for (const key of keys) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    // 键名认不出时，取第一个数组值——`{"章节列表":[…]}` 这种也别丢。
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) {
      return firstArray;
    }
  }

  const bare = bareArray(text);
  if (bare) {
    return bare;
  }
  // 最后一层：Markdown 列表。只认真正的列表行，避免把一段说明文字拆成几十项。
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]|\d+[.)、])\s+/.test(line))
    .map((line) => cleanListLine(line))
    .filter(Boolean);
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

function cleanListLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s*/, '')
    .replace(/^\**|\**$/g, '')
    .trim();
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

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[、,，/]/).map((x) => x.trim()).filter(Boolean) : [];
}
