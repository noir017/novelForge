import { exists, readText } from '../../model/fs';
import { stringifySections } from '../../model/markdown';
import { plotLabel } from '../../model/pipeline';
import { Plot, PLOT_SECTION_KEYS } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  CharacterCard,
} from '../../model/types';
import type { Focus } from './focus';

export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 细纲${plot.role ? ` ｜ ${plot.role}` : ''}】`;
  const body = stringifySections(
    plot.sections as unknown as Record<string, string>,
    PLOT_SECTION_KEYS as readonly string[]
  );
  return `${head}\n${body || '（尚未填写）'}`;
}

/**
 * 前后章只注入两节——够让排这一章的人知道上文停在哪个局面、下文要接到哪：
 * 上文给「关键事件 / 章末钩子」（发生了什么、留下了什么悬念），下文给
 * 「本章目的 / 关键事件」（要去哪、要发生什么）。第三节是那一章自己的账，
 * 摊在这里只会挤掉本章的预算，还容易被误当成本章要处理的东西。
 */
export function renderPlotBrief(plot: Plot, relation: '上文' | '下文'): string {
  const lines = [`【${plotLabel(plot.no, plot.title)} · ${relation}】`];
  const keys = relation === '上文' ? (['关键事件', '章末钩子'] as const) : (['本章目的', '关键事件'] as const);
  for (const key of keys) {
    const value = plot.sections[key]?.trim();
    if (value) {
      lines.push(`${key}：${value}`);
    }
  }
  return lines.join('\n');
}

/** 本层产物的文本，供设定关键词匹配。 */
export function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.plot) {
    parts.push(...Object.values(focus.plot.sections));
  }
  return parts.filter(Boolean).join('\n');
}

export function renderCharacter(card: CharacterCard, essentialOnly: boolean): string {
  const keys = essentialOnly ? CHARACTER_ESSENTIAL_KEYS : CHARACTER_SECTION_KEYS;
  const header = card.aliases.length > 0 ? `【${card.name}（又称 ${card.aliases.join('、')}）】` : `【${card.name}】`;
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
 * 用户那句话里做子串匹配准得多。它只在**这里**用——那是计划出场，出场统计仍然
 * 只认摘要（第 14 条），两者混在一起会污染统计。之后才是这一轮的输入、前两章的
 * 摘要与主角。
 */
export async function selectCharacters(
  project: NovelProject,
  cards: CharacterCard[],
  ask: string,
  focus: Focus
): Promise<CharacterHit[]> {
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
      hits.set(card.slug, { card, reason: `纲要中出现「${hit}」` });
    }
  }

  for (const ref of focus.previous.slice(-2)) {
    // 摘要挂在正文上；还没写的章没有摘要，也就无从取出场人物。
    const summary = ref.chapter ? await project.readSummary(ref.chapter.relPath) : undefined;
    const cast = summary?.sections.出场人物 ?? '';
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
