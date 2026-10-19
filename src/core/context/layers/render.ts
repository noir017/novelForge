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
  LoreEntry,
} from '../../model/types';
import { LORE_HIDDEN_MARK, PLOT_LORE_KEY, loreBrief, renderLoreLines, splitLoreHidden } from '../../model/loreFile';
import type { Focus } from './focus';

/**
 * 本章自己的细纲（`plotSelf`）。第九节「设定」只在这里带：这一章打算引入什么、用到什么，写的人要知道；
 * 前几章细纲、细纲一览、全书摘要的输入都不带它，免得几十章的细纲一起变长。
 */
export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 细纲】`;
  const lore = plot.lore?.length ? `\n\n## ${PLOT_LORE_KEY}\n\n${renderLoreLines(plot.lore)}` : '';
  return `${head}\n${renderPlotSections(plot) || '（尚未填写）'}${lore}`;
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

/** 设定名后面的 `〔分类〕`（分类就是目录，根目录下的不写）。 */
function loreHead(entry: LoreEntry): string {
  return `${entry.title}${entry.category ? `〔${entry.category}〕` : ''}`;
}

/** 写正文时去掉了一条设定的暗设，明细里注的那一句（第 2 条）。lore 层与 @ 引用共用。 */
export const LORE_HIDDEN_DROPPED_NOTE = '暗设没带：写正文不带读者还不知道的事，要让这一章揭开就写进本章细纲';

/**
 * 条目正文按场合处理「暗设」那一节（完善设定，2026-10-19）：
 *
 * - 写正文（`withHidden: false`）：只带明面（`splitLoreHidden` 的 `visible`）。写正文本来不需要知道真相，
 *   需要的铺垫细纲里已经写了；带上了，正文模型看见就容易说漏。`dropped` 告诉调用方有没有真去掉东西，
 *   去掉了要在明细里注一句（第 2 条）。
 * - 规划时（设定 / 大纲 / 细纲）：整份带，暗设挪到最后、标题换成 {@link LORE_HIDDEN_MARK}。
 *
 * 没有暗设的条目原样带（只是去掉首尾空白）。
 */
export function loreBodyFor(body: string, withHidden: boolean): { text: string; dropped: boolean } {
  const { visible, hidden } = splitLoreHidden(body);
  if (!hidden) {
    // 有个空的「## 暗设」标题时写正文也去掉它：一个空标题只会让模型去猜下面藏了什么。
    return { text: withHidden ? (body ?? '').trim() : visible, dropped: false };
  }
  if (!withHidden) {
    return { text: visible, dropped: true };
  }
  return { text: [visible, `## ${LORE_HIDDEN_MARK}\n\n${hidden}`].filter(Boolean).join('\n\n'), dropped: false };
}

/**
 * 整条带的设定：`【名〔分类〕】一句话`，下面是正文，最后是还没整合进条目的新事实（带章号）。
 * 尾巴是条目落后于正文时的那几句——没有它，模型拿到的是整合那时候的样子。
 *
 * `withHidden`：带不带「暗设」那一节（{@link loreBodyFor}）。写正文与续写不带，规划时带并标明。
 */
export function renderLoreFull(
  entry: LoreEntry,
  tail: readonly { no: number; text: string }[],
  withHidden: boolean
): string {
  // 没写 brief 时一句话就是正文第一句，下面整份正文还会再带一遍，标题行上不重复。
  const brief = entry.brief.trim() ? loreBrief(entry) : '';
  const lines = [`【${loreHead(entry)}】${brief}`];
  const body = loreBodyFor(entry.body, withHidden).text;
  if (body) {
    lines.push(body);
  }
  if (tail.length > 0) {
    const since = entry.updatedThrough ? `第 ${entry.updatedThrough} 章之后` : '定稿里';
    lines.push(`${since}新出现的（还没整合进这一条）：`, ...tail.map((f) => `- 第 ${f.no} 章：${f.text}`));
  }
  return lines.join('\n');
}

/** 只带一句话的设定：`- 名〔分类〕：一句话`。 */
export function renderLoreLine(entry: LoreEntry): string {
  const brief = loreBrief(entry);
  return `- ${loreHead(entry)}${brief ? `：${brief}` : ''}`;
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
