import { NovelProject } from '../model/project';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
  NovelConfig,
} from '../model/types';
import { stringifySections } from '../model/markdown';
import { ChatMessage } from '../llm/provider';
import { estimateTokens, takeHead, takeTail } from './tokenizer';

/** 上下文条目在 prompt 中的分层，数字越小越先保证。 */
export type Priority = 0 | 1 | 2 | 3 | 4;

export type ItemKind =
  | 'system'
  | 'outline'
  | 'prevTail'
  | 'style'
  | 'globalSummary'
  | 'character'
  | 'chapterFull'
  | 'chapterSummary'
  | 'lore'
  | 'revision';

export type ItemStatus = 'included' | 'degraded' | 'dropped' | 'excluded';

/** 一条上下文明细，供 Webview 展示与勾选。 */
export interface ContextItem {
  /** 稳定 id，Webview 用它回传「取消勾选」。 */
  id: string;
  kind: ItemKind;
  priority: Priority;
  /** 展示名，如「第 12 章 · 原文」。 */
  label: string;
  /** 来源文件相对路径，可点击打开。 */
  source?: string;
  /** 最终注入的文本；status 为 dropped/excluded 时为空。 */
  text: string;
  tokens: number;
  status: ItemStatus;
  /** 降级或丢弃的原因，直接展示给作者。 */
  note?: string;
}

export interface BuildRequest {
  /** 本次要写的章节序号（尚不存在也可以，用于定位「前文」范围）。 */
  targetOrder: number;
  /** 用户填写的剧情纲要。 */
  outline: string;
  /** 目标字数，写进 prompt 指令。 */
  targetWords?: number;
  /** 额外写作指令，如「加强对白」。 */
  extraInstruction?: string;
  /** 上一版生成结果 + 修改意见，用于「重写」。 */
  revision?: { previousDraft: string; feedback: string };
  /** 被用户手动取消勾选的条目 id。 */
  excludedIds?: string[];
  /** provider 的硬性输入上限，会与 contextWindow 取小。 */
  providerMaxInputTokens?: number;
}

export interface BuiltContext {
  messages: ChatMessage[];
  items: ContextItem[];
  /** 实际使用的输入 token 估算值。 */
  usedTokens: number;
  /** 输入预算上限。 */
  budget: number;
  /** 上限是否被 provider 配额压低。 */
  budgetClampedByProvider: boolean;
}

const SAFETY_MARGIN = 512;

/**
 * 上下文装配器。
 *
 * 装配顺序即优先级：先放死 P0（系统提示 / 纲要 / 上一章结尾原文），
 * 再依次用剩余预算填 P1→P4。任何装不下的条目都会以 dropped/degraded
 * 的形式留在 items 里——绝不静默丢弃，作者需要知道这次没带上什么。
 */
export async function buildContext(
  project: NovelProject,
  request: BuildRequest,
  config: NovelConfig
): Promise<BuiltContext> {
  const excluded = new Set(request.excludedIds ?? []);
  const items: ContextItem[] = [];

  const hardLimit = Math.min(
    config.contextWindow,
    request.providerMaxInputTokens ?? Number.POSITIVE_INFINITY
  );
  const budget = Math.max(1000, hardLimit - config.maxOutputTokens - SAFETY_MARGIN);
  const budgetClampedByProvider =
    request.providerMaxInputTokens !== undefined && request.providerMaxInputTokens < config.contextWindow;

  let remaining = budget;

  /** 尝试把一条内容放进预算。放不下就按 note 记为 dropped。 */
  const admit = (item: Omit<ContextItem, 'tokens' | 'status'>, opts: { force?: boolean } = {}): ContextItem => {
    if (excluded.has(item.id)) {
      const rejected: ContextItem = { ...item, text: '', tokens: 0, status: 'excluded', note: '已被手动排除' };
      items.push(rejected);
      return rejected;
    }
    const tokens = estimateTokens(item.text);
    if (!opts.force && tokens > remaining) {
      const dropped: ContextItem = {
        ...item,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: `预算不足（需 ${tokens} token，剩 ${Math.max(0, remaining)}）`,
      };
      items.push(dropped);
      return dropped;
    }
    remaining -= tokens;
    const included: ContextItem = { ...item, tokens, status: 'included' };
    items.push(included);
    return included;
  };

  const chapters = await project.listChapters();
  const previous = chapters.filter((c) => c.order < request.targetOrder);

  // ---------------- P0：系统提示（永远注入，不参与竞争） ----------------
  const systemText = buildSystemPrompt(request, config);
  admit(
    { id: 'system', kind: 'system', priority: 0, label: '系统提示 · 写作要求', text: systemText },
    { force: true }
  );

  // ---------------- P0：本章剧情纲要 ----------------
  admit(
    {
      id: 'outline',
      kind: 'outline',
      priority: 0,
      label: '本章剧情纲要',
      text: request.outline.trim(),
    },
    { force: true }
  );

  // ---------------- P0：上一章结尾原文 ----------------
  const prevChapter = previous[previous.length - 1];
  let prevTailItem: ContextItem | undefined;
  if (prevChapter && config.prevChapterTailChars > 0) {
    const full = await project.readChapterText(prevChapter);
    const tail = tailByChars(full, config.prevChapterTailChars);
    prevTailItem = admit(
      {
        id: `prevTail:${prevChapter.order}`,
        kind: 'prevTail',
        priority: 0,
        label: `第 ${prevChapter.order} 章《${prevChapter.title}》· 结尾原文`,
        source: prevChapter.relPath,
        text: tail,
        note: '原文注入，保证语气与场景衔接',
      },
      { force: true }
    );
  }

  // ---------------- P0：重写反馈 ----------------
  if (request.revision) {
    admit(
      {
        id: 'revision',
        kind: 'revision',
        priority: 0,
        label: '上一版草稿与修改意见',
        text: `【上一版草稿】\n${takeTail(request.revision.previousDraft, 3000)}\n\n【修改意见】\n${request.revision.feedback.trim()}`,
      },
      { force: true }
    );
  }

  // 强制项可能已经吃掉全部预算，后续条目自然会被判 dropped。

  // ---------------- P1：文风指南 ----------------
  const style = await project.readStyleGuide();
  if (style.trim()) {
    admit({
      id: 'style',
      kind: 'style',
      priority: 1,
      label: '文风指南',
      source: project.relPath(project.styleUri),
      text: style,
    });
  }

  // ---------------- P1：全书滚动摘要 ----------------
  const globalSummary = await project.readGlobalSummary();
  if (globalSummary.trim() && !isPlaceholder(globalSummary)) {
    admit({
      id: 'globalSummary',
      kind: 'globalSummary',
      priority: 1,
      label: '全书滚动摘要',
      source: project.relPath(project.globalSummaryUri),
      text: globalSummary,
    });
  }

  // ---------------- P2：相关角色卡 ----------------
  const allCharacters = await project.listCharacters();
  const relevant = await selectCharacters(project, allCharacters, request.outline, previous);
  for (const { card, reason } of relevant) {
    const fullText = renderCharacter(card, false);
    const id = `character:${card.slug}`;
    if (excluded.has(id)) {
      admit({ id, kind: 'character', priority: 2, label: `角色 · ${card.name}`, source: card.relPath, text: '' });
      continue;
    }
    const fullTokens = estimateTokens(fullText);
    if (fullTokens <= remaining) {
      admit({
        id,
        kind: 'character',
        priority: 2,
        label: `角色 · ${card.name}`,
        source: card.relPath,
        text: fullText,
        note: reason,
      });
      continue;
    }
    // 降级：只保留身份 / 当前状态 / 未收伏笔
    const essential = renderCharacter(card, true);
    if (estimateTokens(essential) <= remaining) {
      const tokens = estimateTokens(essential);
      remaining -= tokens;
      items.push({
        id,
        kind: 'character',
        priority: 2,
        label: `角色 · ${card.name}`,
        source: card.relPath,
        text: essential,
        tokens,
        status: 'degraded',
        note: `${reason}；预算不足，仅保留身份/当前状态/未收伏笔`,
      });
    } else {
      items.push({
        id,
        kind: 'character',
        priority: 2,
        label: `角色 · ${card.name}`,
        source: card.relPath,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: `${reason}；预算不足`,
      });
    }
  }

  // ---------------- P3：最近 N 章完整原文（不含已注入结尾的那一章的重复部分） ----------------
  const fullTextCount = Math.max(0, config.recentChaptersFullText);
  const fullTextChapters = previous.slice(-fullTextCount);
  const fullTextOrders = new Set(fullTextChapters.map((c) => c.order));

  for (const chapter of [...fullTextChapters].reverse()) {
    const id = `chapterFull:${chapter.order}`;
    const label = `第 ${chapter.order} 章《${chapter.title}》· 原文`;
    if (excluded.has(id)) {
      admit({ id, kind: 'chapterFull', priority: 3, label, source: chapter.relPath, text: '' });
      continue;
    }

    const text = await project.readChapterText(chapter);

    // 上一章的结尾片段已在 P0 注入。若整章原文能完整放下，就把 P0 那份撤掉，
    // 避免同一段文字在 prompt 里出现两次（既浪费预算，也容易让模型复读）。
    if (prevTailItem && chapter.order === prevChapter?.order && prevTailItem.status === 'included') {
      const block = `【第${chapter.order}章 ${chapter.title}】\n${text}`;
      const tokens = estimateTokens(block);
      if (tokens - prevTailItem.tokens <= remaining) {
        remaining += prevTailItem.tokens - tokens;
        prevTailItem.status = 'dropped';
        prevTailItem.note = '整章原文已完整注入，无需重复结尾片段';
        prevTailItem.tokens = 0;
        prevTailItem.text = '';
        items.push({
          id,
          kind: 'chapterFull',
          priority: 3,
          label,
          source: chapter.relPath,
          text: block,
          tokens,
          status: 'included',
          note: '含上一章结尾，续写将从此处接续',
        });
        continue;
      }
    }

    const block = `【第${chapter.order}章 ${chapter.title}】\n${text}`;
    const tokens = estimateTokens(block);
    if (tokens <= remaining) {
      remaining -= tokens;
      items.push({
        id,
        kind: 'chapterFull',
        priority: 3,
        label,
        source: chapter.relPath,
        text: block,
        tokens,
        status: 'included',
      });
      continue;
    }

    // 降级链：原文 → 该章摘要 → 省略
    const summary = await project.readSummary(chapter.order);
    if (summary?.content.trim()) {
      const summaryBlock = `【第${chapter.order}章 ${chapter.title} · 摘要】\n${summary.content}`;
      const summaryTokens = estimateTokens(summaryBlock);
      if (summaryTokens <= remaining) {
        remaining -= summaryTokens;
        items.push({
          id,
          kind: 'chapterFull',
          priority: 3,
          label,
          source: summary.relPath,
          text: summaryBlock,
          tokens: summaryTokens,
          status: 'degraded',
          note: `原文需 ${tokens} token 放不下，已降级为摘要`,
        });
        continue;
      }
    }
    items.push({
      id,
      kind: 'chapterFull',
      priority: 3,
      label,
      source: chapter.relPath,
      text: '',
      tokens: 0,
      status: 'dropped',
      note: summary ? '原文与摘要都放不下' : `原文需 ${tokens} token 放不下，且该章尚无摘要`,
    });
  }

  // ---------------- P4：中距离章节摘要（由近及远填充） ----------------
  const summaryCandidates = previous.filter((c) => !fullTextOrders.has(c.order)).reverse();
  for (const chapter of summaryCandidates) {
    const id = `chapterSummary:${chapter.order}`;
    const label = `第 ${chapter.order} 章《${chapter.title}》· 摘要`;
    if (excluded.has(id)) {
      admit({ id, kind: 'chapterSummary', priority: 4, label, text: '' });
      continue;
    }
    const summary = await project.readSummary(chapter.order);
    if (!summary?.content.trim()) {
      items.push({
        id,
        kind: 'chapterSummary',
        priority: 4,
        label,
        source: chapter.relPath,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: '该章尚无摘要，运行「同步所有过期摘要」后可纳入',
      });
      continue;
    }
    const stale = summary.sourceHash !== chapter.contentHash;
    const block = `【第${chapter.order}章 ${chapter.title}】\n${summary.content}`;
    const tokens = estimateTokens(block);
    if (tokens > remaining) {
      items.push({
        id,
        kind: 'chapterSummary',
        priority: 4,
        label,
        source: summary.relPath,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: '预算已满，更早的章节不再注入',
      });
      continue;
    }
    remaining -= tokens;
    items.push({
      id,
      kind: 'chapterSummary',
      priority: 4,
      label,
      source: summary.relPath,
      text: block,
      tokens,
      status: 'included',
      note: stale ? '⚠ 该摘要已过期（正文有改动）' : undefined,
    });
  }

  // ---------------- P4：相关设定条目 ----------------
  const lore = await project.listLore();
  for (const entry of lore) {
    const hit = matchesKeywords(request.outline, [entry.title, ...entry.keywords]);
    if (!hit) {
      continue;
    }
    admit({
      id: `lore:${entry.slug}`,
      kind: 'lore',
      priority: 4,
      label: `设定 · ${entry.title}`,
      source: entry.relPath,
      text: `【${entry.title}】\n${entry.body}`,
      note: `纲要中出现「${hit}」`,
    });
  }

  const messages = assembleMessages(items, request, config);
  const usedTokens = items.reduce((sum, i) => sum + i.tokens, 0);

  return { messages, items, usedTokens, budget, budgetClampedByProvider };
}

// ---------------------------------------------------------------- 组装

function assembleMessages(items: ContextItem[], request: BuildRequest, config: NovelConfig): ChatMessage[] {
  const live = items.filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim());
  const pick = (kind: ItemKind) => live.filter((i) => i.kind === kind);
  const join = (list: ContextItem[]) => list.map((i) => i.text.trim()).join('\n\n');

  const messages: ChatMessage[] = [];
  const system = pick('system')[0];
  if (system) {
    messages.push({ role: 'system', content: system.text });
  }

  const sections: string[] = [];

  const style = pick('style')[0];
  if (style) {
    sections.push(`# 文风指南（务必贴合）\n\n${style.text}`);
  }

  const global = pick('globalSummary')[0];
  if (global) {
    sections.push(`# 全书前情提要\n\n${global.text}`);
  }

  const characters = pick('character');
  if (characters.length > 0) {
    sections.push(`# 相关角色设定\n\n${join(characters)}`);
  }

  const lore = pick('lore');
  if (lore.length > 0) {
    sections.push(`# 相关世界观设定\n\n${join(lore)}`);
  }

  // 章节摘要由远及近排列，读起来是正序的时间线。
  const summaries = pick('chapterSummary').slice().sort(byOrderAsc);
  if (summaries.length > 0) {
    sections.push(`# 早前章节摘要（由远及近）\n\n${join(summaries)}`);
  }

  const fullChapters = pick('chapterFull').slice().sort(byOrderAsc);
  if (fullChapters.length > 0) {
    sections.push(`# 最近章节正文\n\n${join(fullChapters)}`);
  }

  const prevTail = pick('prevTail')[0];
  if (prevTail) {
    sections.push(`# 上一章结尾原文（你要从这里无缝接下去）\n\n${prevTail.text}`);
  } else if (fullChapters.length > 0) {
    // 结尾片段被整章原文取代时，仍要点明接续位置。
    const last = fullChapters[fullChapters.length - 1];
    sections.push(`你要从上面「${last.label.replace(' · 原文', '')}」的结尾处无缝接下去。`);
  }

  const requirements: string[] = [
    `# 本章剧情纲要（必须完整覆盖，按顺序推进）\n\n${pick('outline')[0]?.text ?? request.outline}`,
  ];
  if (request.targetWords && request.targetWords > 0) {
    requirements.push(`目标字数：约 ${request.targetWords} 字（±15% 均可）。`);
  }
  if (request.extraInstruction?.trim()) {
    requirements.push(`额外要求：${request.extraInstruction.trim()}`);
  }
  sections.push(requirements.join('\n\n'));

  const revision = pick('revision')[0];
  if (revision) {
    sections.push(`# 修订要求\n\n${revision.text}\n\n请基于上一版重写，采纳修改意见，保留其中写得好的部分。`);
  }

  sections.push(
    `现在开始写作。只输出小说正文，不要输出任何标题、序号、解释、总结或「以下是」之类的话。${
      config.recentChaptersFullText > 0 ? '注意与上文的语气、称谓、时态保持一致。' : ''
    }`
  );

  messages.push({ role: 'user', content: sections.join('\n\n---\n\n') });
  return messages;
}

function byOrderAsc(a: ContextItem, b: ContextItem): number {
  return orderOf(a) - orderOf(b);
}

function orderOf(item: ContextItem): number {
  const m = /:(\d+)$/.exec(item.id);
  return m ? Number(m[1]) : 0;
}

function buildSystemPrompt(request: BuildRequest, config: NovelConfig): string {
  const lines = [
    '你是一位资深中文长篇小说作者，正在为一部已连载的作品续写新的章节。',
    '',
    '硬性要求：',
    '1. 严格贴合已给出的文风指南与上文语气，读者应当感觉不到换人执笔。',
    '2. 人物的性格、称谓、说话习惯必须与角色设定一致，不得凭空改变人物关系或已确立的设定。',
    '3. 完整覆盖本章剧情纲要中的每一个要点，按纲要顺序推进，并把它扩写成有场景、有对白、有细节的成稿。',
    '4. 不要复述前情，不要写「上回说到」，直接从上一章结尾的情境自然接续。',
    '5. 只输出正文。不要输出章节标题、小标题、分隔线、创作说明、字数统计或任何元信息。',
    '6. 不要在结尾强行收束或做总结陈词，留出继续往下写的余地。',
  ];
  if (request.targetWords) {
    lines.push(`7. 篇幅控制在约 ${request.targetWords} 字。`);
  }
  lines.push('', `叙事语言：简体中文。温度设定 ${config.temperature}，请在保持稳定的前提下让文字有生气。`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 角色筛选

interface CharacterHit {
  card: CharacterCard;
  reason: string;
}

/**
 * 角色卡筛选，按以下顺序取并集去重：
 * 1. 纲要中出现姓名或别名的角色
 * 2. 最近两章出场的角色（依据摘要「出场人物」一节）
 * 3. 标签含「主角」的角色
 */
async function selectCharacters(
  project: NovelProject,
  cards: CharacterCard[],
  outline: string,
  previous: Chapter[]
): Promise<CharacterHit[]> {
  const hits = new Map<string, CharacterHit>();

  for (const card of cards) {
    const hit = matchesKeywords(outline, [card.name, ...card.aliases]);
    if (hit) {
      hits.set(card.slug, { card, reason: `纲要中出现「${hit}」` });
    }
  }

  const recent = previous.slice(-2);
  for (const chapter of recent) {
    const summary = await project.readSummary(chapter.order);
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
function matchesKeywords(text: string, keywords: string[]): string | undefined {
  const haystack = text.toLowerCase();
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (needle.length >= 2 && haystack.includes(needle)) {
      return kw.trim();
    }
  }
  return undefined;
}

function renderCharacter(card: CharacterCard, essentialOnly: boolean): string {
  const keys = essentialOnly ? CHARACTER_ESSENTIAL_KEYS : CHARACTER_SECTION_KEYS;
  const header = card.aliases.length > 0 ? `【${card.name}（又称 ${card.aliases.join('、')}）】` : `【${card.name}】`;
  const body = stringifySections(card.sections as unknown as Record<string, string>, keys as readonly string[]);
  return `${header}\n${body || '（暂无设定）'}`;
}

/** 按字符数取结尾，并对齐到段落边界。 */
function tailByChars(text: string, chars: number): string {
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

function isPlaceholder(text: string): boolean {
  return /尚未生成|（待补充）/.test(text) && text.replace(/[#\s（）()]/g, '').length < 80;
}

export { takeHead, takeTail };
