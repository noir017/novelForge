import { exists, readText } from '../../model/fs';
import { stringifySections } from '../../model/markdown';
import { plotLabel, segmentLabel, volumeLabel } from '../../model/pipeline';
import { Volume, VOLUME_SECTION_KEYS } from '../../model/volumeFile';
import { Plot, PLOT_SECTION_KEYS } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  CharacterCard,
} from '../../model/types';
import type { Focus } from './focus';

export function renderVolume(volume: Volume): string {
  const head = `【${volumeLabel(volume.no, volume.title)} · 卷纲】`;
  const body = stringifySections(
    volume.sections as unknown as Record<string, string>,
    VOLUME_SECTION_KEYS as readonly string[]
  );
  return `${head}\n${body || '（尚未填写）'}`;
}

/**
 * 分卷一览：每卷只给一行目标。
 *
 * 拆卷时它回答「已经有哪些卷」（免得再拆出一个重复的），拆段时回答「我这一卷
 * 在全书里排第几、前后两卷各要做什么」。不铺开各卷的走向——那是几千字，
 * 而这一层要的只是位置感。
 */
export function renderVolumeBrief(volume: Volume): string {
  const goal = volume.sections.目标?.trim() || volume.sections.剧情走向?.trim() || '（尚未填写）';
  return `- ${volumeLabel(volume.no, volume.title)}：${clipLine(goal)}`;
}

/**
 * 一个剧情段的一行摘要。这一卷已经拆到哪了，靠这几行说清。
 *
 * 只给「目标」，与 `renderVolumeBrief` 同一条理由：拆下一段要的是「前面几段
 * 各自达成了什么」，不是它们的完整脉络（那是 `plotPrev` 的活，而且它按段
 * 取原文）。
 */
export function renderSegmentBrief(plot: Plot, displayNo: number): string {
  const goal = plot.sections.目标?.trim() || plot.sections.剧情脉络?.trim() || '（尚未填写）';
  return `- ${segmentLabel(displayNo, plot.title)}：${clipLine(goal)}`;
}

/** 一览类的一行最多这么长。再长就该去看那一层的原文了。 */
function clipLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= 120 ? one : `${one.slice(0, 120)}…`;
}

export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 剧情${plot.arc ? ` ｜ ${plot.arc}` : ''}】`;
  const body = stringifySections(
    plot.sections as unknown as Record<string, string>,
    PLOT_SECTION_KEYS as readonly string[]
  );
  return `${head}\n${body || '（尚未填写）'}`;
}

/**
 * 前后章只注入「目标 / 剧情脉络」——够让排这一章的人知道上文停在哪个局面、
 * 下文要接到哪。不铺开「冲突与转折」「伏笔与回收」：那是那一章自己的账，
 * 摊在这里只会挤掉本章的预算，还容易被误当成本章要处理的东西。
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

/** 本层产物的文本，供设定关键词匹配。 */
export function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.volume) {
    parts.push(...Object.values(focus.volume.sections));
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

/**
 * 提及人物、近邻章人物与主角的有序并集。
 *
 * 从前第一条是「本场出场人物」——场景卡的 frontmatter 里明写了这一幕有谁，
 * 那比在用户那句话里做子串匹配准得多。场景那一层删掉之后这条依据没有了
 * （细纲不记出场人物：那是**计划**出场，与摘要里的实际出场混在一起会污染
 * 出场统计，见 AGENTS 第 14 条），所以现在从这一轮的输入与前两章的摘要里认。
 */
export async function selectCharacters(
  project: NovelProject,
  cards: CharacterCard[],
  ask: string,
  focus: Focus
): Promise<CharacterHit[]> {
  const hits = new Map<string, CharacterHit>();

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
    // 摘要挂在成品上；还没拆分的章没有摘要，也就无从取出场人物。
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
