import { estimateTokens, takeTail } from '../tokenizer';
import type { LayerFn } from './assembly';
import {
  focusText,
  isPlaceholder,
  matchesKeywords,
  renderCharacter,
  selectCharacters,
  tailByChars,
} from './render';

export const style: LayerFn = async (a, spec) => {
  const text = await a.project.readStyleGuide();
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: 'style',
      kind: 'style',
      priority: spec.priority,
      label: '文风指南',
      source: a.project.relPath(a.project.stylePath),
      text,
    },
    { force: spec.force }
  );
};

export const globalSummary: LayerFn = async (a, spec) => {
  const summary = await a.project.readGlobalSummary();
  if (!summary.trim() || isPlaceholder(summary)) {
    return;
  }
  a.admit(
    {
      id: 'globalSummary',
      kind: 'globalSummary',
      priority: spec.priority,
      label: '全书滚动摘要',
      source: a.project.relPath(a.project.globalSummaryPath),
      text: summary,
    },
    { force: spec.force }
  );
};

export const characters: LayerFn = async (a, spec) => {
  const all = await a.project.listCharacters();
  const relevant = await selectCharacters(a.project, all, a.request.ask, a.focus);
  for (const { card, reason } of relevant) {
    const id = `character:${card.slug}`;
    const base = {
      id,
      kind: 'character' as const,
      priority: spec.priority,
      label: `角色 · ${card.name}`,
      source: card.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const fullText = renderCharacter(card, false);
    const fullTokens = estimateTokens(fullText);
    if (fullTokens <= a.remaining) {
      a.admit({ ...base, text: fullText, note: reason });
      continue;
    }
    const essential = renderCharacter(card, true);
    const essentialTokens = estimateTokens(essential);
    if (essentialTokens <= a.remaining) {
      a.accept(
        {
          ...base,
          text: essential,
          status: 'degraded',
          note: `${reason}；预算不足，仅保留身份/当前状态/未收伏笔`,
        },
        essentialTokens
      );
    } else {
      a.reject({ ...base, text: '' }, 'dropped', `${reason}；预算不足`);
    }
  }
};

export const lore: LayerFn = async (a, spec) => {
  const haystack = [a.request.ask, focusText(a.focus)].join('\n');
  const entries = await a.project.listLore();
  for (const entry of entries) {
    const hit = matchesKeywords(haystack, [entry.title, ...entry.keywords]);
    if (!hit) {
      continue;
    }
    a.admit({
      id: `lore:${entry.slug}`,
      kind: 'lore',
      priority: spec.priority,
      label: `设定 · ${entry.title}`,
      source: entry.relPath,
      text: `【${entry.title}】\n${entry.body}`,
      note: `上下文中出现「${hit}」`,
    });
  }
};

export const prevTail: LayerFn = async (a, spec) => {
  const prevChapter = a.focus.previous[a.focus.previous.length - 1];
  if (!prevChapter || a.config.prevChapterTailChars <= 0) {
    return;
  }
  const full = await a.project.readChapterText(prevChapter);
  a.scratch.prevTail = a.admit(
    {
      id: `prevTail:${prevChapter.order}`,
      kind: 'prevTail',
      priority: spec.priority,
      label: `第 ${prevChapter.order} 章《${prevChapter.title}》· 结尾原文`,
      source: prevChapter.relPath,
      text: tailByChars(full, a.config.prevChapterTailChars),
      note: '原文注入，保证语气与场景衔接',
    },
    { force: spec.force }
  );
};

export const chapterFull: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const prevChapter = previous[previous.length - 1];
  const fullTextCount = Math.max(0, a.config.recentChaptersFullText);
  const fullTextChapters = previous.slice(-fullTextCount);
  for (const chapter of fullTextChapters) {
    a.scratch.fullTextOrders.add(chapter.order);
  }

  for (const chapter of [...fullTextChapters].reverse()) {
    const id = `chapterFull:${chapter.order}`;
    const base = {
      id,
      kind: 'chapterFull' as const,
      priority: spec.priority,
      label: `第 ${chapter.order} 章《${chapter.title}》· 原文`,
      source: chapter.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }

    const text = await a.project.readChapterText(chapter);
    const block = `【第${chapter.order}章 ${chapter.title}】\n${text}`;
    const tokens = estimateTokens(block);
    const tail = a.scratch.prevTail;
    if (tail && chapter.order === prevChapter?.order && tail.status === 'included') {
      if (tokens - tail.tokens <= a.remaining) {
        a.remaining += tail.tokens - tokens;
        tail.status = 'dropped';
        tail.note = '整章原文已完整注入，无需重复结尾片段';
        tail.tokens = 0;
        tail.text = '';
        a.items.push({
          ...base,
          text: block,
          tokens,
          status: 'included',
          note: '含上一章结尾，续写将从此处接续',
        });
        continue;
      }
    }

    if (tokens <= a.remaining) {
      a.accept({ ...base, text: block, status: 'included' }, tokens);
      continue;
    }

    const summary = await a.project.readSummary(chapter);
    if (summary?.content.trim()) {
      const summaryBlock = `【第${chapter.order}章 ${chapter.title} · 摘要】\n${summary.content}`;
      const summaryTokens = estimateTokens(summaryBlock);
      if (summaryTokens <= a.remaining) {
        a.accept(
          {
            ...base,
            source: summary.relPath,
            text: summaryBlock,
            status: 'degraded',
            note: `原文需 ${tokens} token 放不下，已降级为摘要`,
          },
          summaryTokens
        );
        continue;
      }
    }
    a.reject(
      { ...base, text: '' },
      'dropped',
      summary ? '原文与摘要都放不下' : `原文需 ${tokens} token 放不下，且该章尚无摘要`
    );
  }
};

export const chapterSummary: LayerFn = async (a, spec) => {
  const candidates = a.focus.previous.filter((c) => !a.scratch.fullTextOrders.has(c.order)).reverse();
  for (const chapter of candidates) {
    const id = `chapterSummary:${chapter.order}`;
    const base = {
      id,
      kind: 'chapterSummary' as const,
      priority: spec.priority,
      label: `第 ${chapter.order} 章《${chapter.title}》· 摘要`,
      source: chapter.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, source: undefined, text: '' });
      continue;
    }
    const summary = await a.project.readSummary(chapter);
    if (!summary?.content.trim()) {
      a.reject({ ...base, text: '' }, 'dropped', '该章尚无摘要，运行「同步所有过期摘要」后可纳入');
      continue;
    }
    const block = `【第${chapter.order}章 ${chapter.title}】\n${summary.content}`;
    const tokens = estimateTokens(block);
    if (tokens > a.remaining) {
      a.reject({ ...base, source: summary.relPath, text: '' }, 'dropped', '预算已满，更早的章节不再注入');
      continue;
    }
    a.accept(
      {
        ...base,
        source: summary.relPath,
        text: block,
        status: 'included',
        note: summary.sourceHash !== chapter.contentHash ? '⚠ 该摘要已过期（正文有改动）' : undefined,
      },
      tokens
    );
  }
};

export const revision: LayerFn = async (a, spec) => {
  const value = a.request.revision;
  if (!value) {
    return;
  }
  a.admit(
    {
      id: 'revision',
      kind: 'revision',
      priority: spec.priority,
      label: '上一版草稿与修改意见',
      text: `【上一版草稿】\n${takeTail(value.previousDraft, 3000)}\n\n【修改意见】\n${value.feedback.trim()}`,
    },
    { force: spec.force }
  );
};
