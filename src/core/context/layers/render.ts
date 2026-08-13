import { exists, readText } from '../../model/fs';
import { stringifySections } from '../../model/markdown';
import { chapterLabel as labelOfChapter } from '../../model/pipeline';
import { ChapterPlan, PLAN_SECTION_KEYS } from '../../model/planFile';
import { NovelProject } from '../../model/project';
import { describeScene, Scene, SCENE_SECTION_KEYS } from '../../model/sceneFile';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
} from '../../model/types';
import type { Focus } from './focus';

/**
 * 装配条目标签里的章节说法。序号与标题以磁盘上的章节为准，章节还没落盘
 * （拆章之前）时退回细纲 frontmatter 里记的那一份。
 *
 * 拼字符串这件事交给 `model/pipeline.ts` 的 `chapterLabel`——未命名章节
 * 该怎么说（只报序号，不写成「第 7 章《第 7 章》」）只有一处判据。
 */
export function chapterLabel(chapter: Chapter | undefined, plan: ChapterPlan): string {
  return labelOfChapter(chapter?.order ?? plan.order, chapter?.title || plan.title);
}

export function renderPlan(plan: ChapterPlan): string {
  const head = `【第${plan.order}章 ${plan.title} · 细纲${plan.arc ? ` ｜ ${plan.arc}` : ''}】`;
  const body = stringifySections(plan.sections as unknown as Record<string, string>, PLAN_SECTION_KEYS as readonly string[]);
  return `${head}\n${body || '（尚未填写）'}`;
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

/** 邻居场景只注入「目的 / 必须发生 / 不能发生」。 */
export function renderSceneBrief(scene: Scene, relation: string): string {
  const lines = [`【场景 ${describeScene(scene)}${relation}】`];
  for (const key of ['目的', '必须发生', '不能发生'] as const) {
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
  if (focus.plan) {
    parts.push(...Object.values(focus.plan.sections));
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

/** 场景人物、提及人物、近章人物与主角的有序并集。 */
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

  for (const chapter of focus.previous.slice(-2)) {
    const summary = await project.readSummary(chapter);
    const cast = summary?.sections.出场人物 ?? '';
    if (!cast.trim()) {
      continue;
    }
    for (const card of cards) {
      if (hits.has(card.slug)) {
        continue;
      }
      if (matchesKeywords(cast, [card.name, ...card.aliases])) {
        hits.set(card.slug, { card, reason: `第 ${chapter.order} 章出场` });
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
