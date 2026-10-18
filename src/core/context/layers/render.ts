import { exists, readText } from '../../model/fs';
import { takeLast } from '../../model/contextDetail';
import { stringifySections } from '../../model/markdown';
import { plotLabel } from '../../model/pipeline';
import { Plot, PLOT_SECTION_KEYS, sectionItems } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  CharacterCard,
} from '../../model/types';
import type { Focus } from './focus';

export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 细纲】`;
  return `${head}\n${renderPlotSections(plot) || '（尚未填写）'}`;
}

/** 细纲有内容的那几节，`## 小节` 一节一段。一节都没填是空串。 */
export function renderPlotSections(plot: Plot): string {
  return stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS as readonly string[]);
}

/**
 * 前后章只注入几节——够让排这一章的人知道上文停在哪个局面、下文要接到哪：
 * 上文给「梗概 / 关键事件 / 状态变更」（发生了什么、人物落在什么处境），下文给
 * 「梗概 / 关键事件」（要去哪、要发生什么）。其余几节是那一章自己的账，
 * 摊在这里只会挤掉本章的预算，还容易被误当成本章要处理的东西。
 */
export function renderPlotBrief(plot: Plot, relation: '上文' | '下文'): string {
  const lines = [`【${plotLabel(plot.no, plot.title)} · ${relation}】`];
  const keys = relation === '上文' ? (['梗概', '关键事件', '状态变更'] as const) : (['梗概', '关键事件'] as const);
  for (const key of keys) {
    const value = plot.sections[key]?.trim();
    if (value) {
      lines.push(labeledSection(key, value));
    }
  }
  return lines.join('\n');
}

/**
 * 「小节：内容」一行。内容是一条一行的列表（关键事件、看点……）时另起一行照原样列，
 * 不然第一条会挤在冒号后面（「关键事件：- 甲」）；只有一条就去掉列表记号接在冒号后面。
 */
export function labeledSection(key: string, value: string): string {
  const v = value.trim();
  if (v.includes('\n')) {
    return `${key}：\n${v}`;
  }
  return `${key}：${sectionItems(v)[0] ?? v}`;
}

/** 本层产物的文本，供设定关键词匹配。 */
export function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.plot) {
    parts.push(...Object.values(focus.plot.sections));
  }
  return parts.filter(Boolean).join('\n');
}

/** 压成一行并截短：换行变空格，超过 `max` 字截断并补省略号。 */
export function clipLine(text: string, max: number): string {
  const one = (text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : one;
}

/** 名字后面那对括号：性别与别名，「（女；又称 清河）」。两样都没有就是空串。 */
function cardNote(card: CharacterCard): string {
  const parts = [card.gender, card.aliases.length > 0 ? `又称 ${card.aliases.join('、')}` : ''].filter(Boolean);
  return parts.length > 0 ? `（${parts.join('；')}）` : '';
}

/**
 * 角色图谱一览里的一个人：名字、性别与别名、定位，下面缩进三行身份 / 关系 / 当前状态的开头。
 * 完整角色卡由 `characters` 层按需带（正文层）。
 */
export function renderRosterLine(card: CharacterCard): string {
  const tags = card.tags.length > 0 ? `［${card.tags.join('、')}］` : '';
  const parts = [`- ${card.name}${cardNote(card)}${tags}`];
  const add = (label: string, text: string, max: number) => {
    if (text?.trim()) {
      parts.push(`  ${label}：${clipLine(text, max)}`);
    }
  };
  add('身份', card.sections.身份, 120);
  add('人物关系', card.sections.人物关系, 160);
  add('当前状态', card.sections.当前状态, 80);
  return parts.join('\n');
}

export function renderCharacter(card: CharacterCard, essentialOnly: boolean): string {
  const keys = essentialOnly ? CHARACTER_ESSENTIAL_KEYS : CHARACTER_SECTION_KEYS;
  // 性别跟着名字走，预算再紧只带三节时也在。
  const header = `【${card.name}${cardNote(card)}】`;
  const body = stringifySections(card.sections as unknown as Record<string, string>, keys as readonly string[]);
  return `${header}\n${body || '（暂无设定）'}`;
}

/** 按字符数取结尾，并对齐到段落边界。 */
export function tailByChars(text: string, chars: number): string {
  if (text.length <= chars) {
    return text;
  }
  let slice = text.slice(-chars);
  const br = slice.indexOf('\n');
  if (br !== -1 && br < chars * 0.25) {
    slice = slice.slice(br + 1);
  }
  return `……（前略）\n\n${slice.trimStart()}`;
}

/** 续写时带已写正文的最后多少字（AI-Novel-Writer 的 `CONTINUE_PROMPT_MAX_CHARS`）。 */
export const CONTINUE_TAIL_CHARS = 1600;

/**
 * 已写正文的最后 {@link CONTINUE_TAIL_CHARS} 字，开头对齐到段落边界。
 *
 * 与 {@link tailByChars} 的差别是**不加「（前略）」**：这一段是要让模型从末尾接着写的，
 * 开头多一行说明，模型会以为那也是正文的一部分、跟着学。
 */
export function continuationTail(text: string, max = CONTINUE_TAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const slice = trimmed.slice(-max);
  const br = slice.indexOf('\n');
  return (br !== -1 && br < max * 0.25 ? slice.slice(br + 1) : slice).trimStart();
}

export function isPlaceholder(text: string): boolean {
  return /尚未生成|（待补充）/.test(text) && text.replace(/[#\s（）()]/g, '').length < 80;
}

export const ATTACHMENT_NOTE: Record<Attachment['kind'], string> = {
  selection: '编辑器选中片段',
  file: '整文件引用',
  chapter: '章节原文引用',
  character: '角色卡引用',
  lore: '设定条目引用',
  summary: '摘要引用',
};

/** 选区使用快照，整文件引用每次读取最新内容。 */
export async function resolveAttachment(project: NovelProject, att: Attachment): Promise<string> {
  if (att.text !== undefined) {
    return att.text;
  }
  if (!att.relPath) {
    return '';
  }
  const abs = project.pathOf(att.relPath);
  if (!(await exists(abs))) {
    return '';
  }
  try {
    return (await readText(abs)).trim();
  } catch {
    return '';
  }
}

export interface CharacterHit {
  card: CharacterCard;
  reason: string;
}

/**
 * 计划出场、提及人物、近邻章人物与主角的有序并集。
 *
 * **第一条是本章细纲的 `characters[]`**（D13）：细纲里明写了这一章有谁，那比在
 * 用户那句话里做子串匹配准得多。还没定稿时那是计划出场，只在**这里**用——出场统计
 * 只认定稿过的细纲（第 14 条），两者混在一起会污染统计。之后才是这一轮的输入、前几章
 * （`castWindow`，上下文详细度，缺省 2）定稿过的出场人物与主角。
 */
export function selectCharacters(
  cards: CharacterCard[],
  ask: string,
  focus: Focus,
  castWindow: number
): CharacterHit[] {
  const hits = new Map<string, CharacterHit>();

  const planned = focus.plot?.characters ?? [];
  for (const name of planned) {
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    if (card && !hits.has(card.slug)) {
      hits.set(card.slug, { card, reason: '本章细纲计划出场' });
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    const hit = matchesKeywords(ask, [card.name, ...card.aliases]);
    if (hit) {
      hits.set(card.slug, { card, reason: `这一轮的要求里提到「${hit}」` });
    }
  }

  for (const ref of takeLast(focus.previous, castWindow)) {
    // 只认定稿过的细纲：没定稿的那一节写的是计划出场，不是这一章实际写到了谁。
    const cast = ref.plot?.sourceHash ? ref.plot.sections.出场人物 : '';
    if (!cast.trim()) {
      continue;
    }
    for (const card of cards) {
      if (hits.has(card.slug)) {
        continue;
      }
      if (matchesKeywords(cast, [card.name, ...card.aliases])) {
        hits.set(card.slug, { card, reason: `第 ${ref.no} 章出场` });
      }
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    if (card.tags.some((t) => /主角|主要人物|main/i.test(t))) {
      hits.set(card.slug, { card, reason: '主角，始终注入' });
    }
  }

  return [...hits.values()];
}

/** 返回命中的关键词，未命中返回 undefined。 */
export function matchesKeywords(text: string, keywords: string[]): string | undefined {
  const haystack = text.toLowerCase();
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (needle.length >= 2 && haystack.includes(needle)) {
      return kw.trim();
    }
  }
  return undefined;
}
