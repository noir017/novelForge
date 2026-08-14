import { exists, readText } from '../../model/fs';
import { stringifySections } from '../../model/markdown';
import { plotLabel } from '../../model/pipeline';
import { Plot, PLOT_SECTION_KEYS } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { describeScene, Scene, SCENE_SECTION_KEYS } from '../../model/sceneFile';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  CharacterCard,
} from '../../model/types';
import type { Focus } from './focus';

export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 剧情${plot.arc ? ` ｜ ${plot.arc}` : ''}】`;
  const body = stringifySections(
    plot.sections as unknown as Record<string, string>,
    PLOT_SECTION_KEYS as readonly string[]
  );
  return `${head}\n${body || '（尚未填写）'}`;
}

/**
 * 前后段只注入「目标 / 剧情脉络」——够让排这一段的人知道上文停在哪个局面、
 * 下文要接到哪。不铺开「冲突与转折」「伏笔与回收」：那是那一段自己的账，
 * 摊在这里只会挤掉本段的预算，还容易被误当成本段要处理的东西。
 */
export function renderPlotBrief(plot: Plot, relation: string): string {
  const lines = [`【${plotLabel(plot.no, plot.title)} · ${relation}】`];
  for (const key of ['目标', '剧情脉络'] as const) {
    const value = plot.sections[key]?.trim();
    if (value) {
      lines.push(`${key}：${value}`);
    }
  }
  return lines.join('\n');
}

export function renderScene(scene: Scene): string {
  const head = `【场景 ${describeScene(scene)}】`;
  const who = scene.characters.length > 0 ? `\n在场人物：${scene.characters.join('、')}` : '';
  const words = scene.targetWords ? `\n目标篇幅：约 ${scene.targetWords} 字` : '';
  const body = stringifySections(
    scene.sections as unknown as Record<string, string>,
    SCENE_SECTION_KEYS as readonly string[]
  );
  return `${head}${who}${words}\n${body || '（尚未填写）'}`;
}

/**
 * 邻居场景只注入「目的 / 环境」——够让写这一场的人知道上一场停在哪、
 * 下一场要接到哪。不铺开动作与对话：那是那一场自己的素材，摊在这里只会
 * 挤掉本场的预算，还容易被误当成本场要写的东西。
 */
export function renderSceneBrief(scene: Scene, relation: string): string {
  const lines = [`【场景 ${describeScene(scene)}${relation}】`];
  for (const key of ['目的', '环境'] as const) {
    const value = scene.sections[key]?.trim();
    if (value) {
      lines.push(`${key}：${value}`);
    }
  }
  return lines.join('\n');
}

/** 本层产物的文本，供设定关键词匹配。 */
export function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.scene) {
    parts.push(focus.scene.place, focus.scene.time, focus.scene.characters.join('、'));
    parts.push(...Object.values(focus.scene.sections));
  }
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

/** 场景人物、提及人物、近段人物与主角的有序并集。 */
export async function selectCharacters(
  project: NovelProject,
  cards: CharacterCard[],
  ask: string,
  focus: Focus
): Promise<CharacterHit[]> {
  const hits = new Map<string, CharacterHit>();

  for (const name of focus.castNames) {
    const needle = name.trim();
    if (!needle) {
      continue;
    }
    const card = cards.find((c) => c.name === needle || c.aliases.includes(needle));
    if (card && !hits.has(card.slug)) {
      hits.set(card.slug, { card, reason: '本场出场人物' });
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

  for (const plot of focus.previous.slice(-2)) {
    const summary = await project.readSummary(plot.relPath);
    const cast = summary?.sections.出场人物 ?? '';
    if (!cast.trim()) {
      continue;
    }
    for (const card of cards) {
      if (hits.has(card.slug)) {
        continue;
      }
      if (matchesKeywords(cast, [card.name, ...card.aliases])) {
        hits.set(card.slug, { card, reason: `第 ${plot.no} 段出场` });
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
