import { plotLabel } from '../../model/pipeline';
import { estimateTokens, takeTail } from '../tokenizer';
import type { LayerFn } from './assembly';
import { readChapterText, readPrevManuscript } from './focus';
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
  const prev = a.focus.previous[a.focus.previous.length - 1];
  if (!prev || a.config.prevChapterTailChars <= 0) {
    return;
  }
  const manuscript = await readPrevManuscript(a.project, a.focus);
  if (!manuscript?.text.trim()) {
    return;
  }
  a.scratch.prevTail = a.admit(
    {
      id: `prevTail:${prev.no}`,
      kind: 'prevTail',
      priority: spec.priority,
      label: `${plotLabel(prev.no, prev.title)} · 结尾原文`,
      source: manuscript.relPath,
      text: tailByChars(manuscript.text, a.config.prevChapterTailChars),
      note: '原文注入，保证语气与场景衔接',
    },
    { force: spec.force }
  );
};

/**
 * 前面几章的**正文全文**。只有正文阶段带（配方里只有那一张有这一层）。
 *
 * 放不下时降级为该章摘要，再放不下才丢弃——三档都要留在明细里说清原因
 * （AGENTS.md 第 2 条：不静默截断）。
 */
export const manuscriptFull: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const prev = previous[previous.length - 1];
  const fullTextCount = Math.max(0, a.config.recentChaptersFullText);
  const fullTextPlots = previous.slice(-fullTextCount);

  for (const ref of [...fullTextPlots].reverse()) {
    const plot = ref;
    const id = `manuscriptFull:${plot.no}`;
    const label = plotLabel(plot.no, plot.title);
    const base = {
      id,
      kind: 'manuscriptFull' as const,
      priority: spec.priority,
      label: `${label} · 正文`,
      source: ref.chapter?.relPath ?? ref.plot?.relPath ?? '',
    };
    if (a.excluded.has(id)) {
      a.scratch.fullTextNos.add(plot.no);
      a.admit({ ...base, text: '' });
      continue;
    }

    const manuscript = await readChapterText(a.project, ref);
    if (!manuscript?.text.trim()) {
      // 只排了剧情、还没写正文——这不是错误，是这一章还没到那一步。
      // **不认领它**（不进 fullTextNos）：认领了摘要那一层就会跳过它，
      // 而它既没有正文也没有摘要，于是从上下文里凭空消失，明细上还看不出
      // 少了什么。留给摘要层，那里会退化成只带「目标」并说明原因。
      continue;
    }
    // 确实注入了（哪怕后面降级成摘要）才认领：摘要层据此避免重复注入。
    a.scratch.fullTextNos.add(plot.no);
    const block = `【${label}】\n${manuscript.text}`;
    const tokens = estimateTokens(block);
    const tail = a.scratch.prevTail;
    if (tail && plot.no === prev?.no && tail.status === 'included') {
      if (tokens - tail.tokens <= a.remaining) {
        a.remaining += tail.tokens - tokens;
        tail.status = 'dropped';
        tail.note = '整章正文已完整注入，无需重复结尾片段';
        tail.tokens = 0;
        tail.text = '';
        a.items.push({
          ...base,
          source: manuscript.relPath,
          text: block,
          tokens,
          status: 'included',
          note: '含上一章结尾，续写将从此处接续',
        });
        continue;
      }
    }

    if (tokens <= a.remaining) {
      a.accept({ ...base, source: manuscript.relPath, text: block, status: 'included' }, tokens);
      continue;
    }

    const summary = ref.chapter ? await a.project.readSummary(ref.chapter.relPath) : undefined;
    if (summary?.content.trim()) {
      const summaryBlock = `【${label} · 摘要】\n${summary.content}`;
      const summaryTokens = estimateTokens(summaryBlock);
      if (summaryTokens <= a.remaining) {
        a.accept(
          {
            ...base,
            source: summary.relPath,
            text: summaryBlock,
            status: 'degraded',
            note: `正文需 ${tokens} token 放不下，已降级为摘要`,
          },
          summaryTokens
        );
        continue;
      }
    }
    a.reject(
      { ...base, text: '' },
      'dropped',
      summary ? '正文与摘要都放不下' : `正文需 ${tokens} token 放不下，且这一章尚无摘要`
    );
  }
};

/**
 * 更早那些章的摘要，由近及远填充。
 *
 * **还没写正文的章退化成只带「目标」**，并在明细里注明原因。这是「不静默截断」
 * 在这条链上最要紧的一处：作者常常先把一百章剧情排完再回头写，那些章没有正文
 * 也就没有摘要——直接跳过的话，排第 60 章时模型对前 59 章一无所知，却看不出
 * 少了什么。带一行目标很便宜，而且诚实。
 */
export const plotSummary: LayerFn = async (a, spec) => {
  const candidates = a.focus.previous.filter((p) => !a.scratch.fullTextNos.has(p.no)).reverse();
  for (const ref of candidates) {
    const id = `plotSummary:${ref.no}`;
    const label = plotLabel(ref.no, ref.title);
    const base = {
      id,
      kind: 'plotSummary' as const,
      priority: spec.priority,
      label: `${label} · 摘要`,
      source: ref.chapter?.relPath ?? ref.plot?.relPath ?? '',
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, source: undefined, text: '' });
      continue;
    }

    // 摘要挂在成品上；还没拆分的章自然没有。
    const summary = ref.chapter ? await a.project.readSummary(ref.chapter.relPath) : undefined;
    if (!summary?.content.trim()) {
      const goal = ref.plot?.sections.目标.trim() ?? '';
      if (!goal) {
        a.reject({ ...base, text: '' }, 'dropped', '这一章还没写正文，也没有目标可带');
        continue;
      }
      const block = `【${label}】\n${goal}`;
      const tokens = estimateTokens(block);
      if (tokens > a.remaining) {
        a.reject({ ...base, text: '' }, 'dropped', '预算已满，更早的章不再注入');
        continue;
      }
      a.accept(
        { ...base, text: block, status: 'degraded', note: '这一章还没写正文，只带目标' },
        tokens
      );
      continue;
    }

    const block = `【${label}】\n${summary.content}`;
    const tokens = estimateTokens(block);
    if (tokens > a.remaining) {
      a.reject({ ...base, source: summary.relPath, text: '' }, 'dropped', '预算已满，更早的章不再注入');
      continue;
    }
    a.accept(
      {
        ...base,
        source: summary.relPath,
        text: block,
        status: 'included',
        note:
          // 摘要的上游是成品，直接比它的 hash——不必再读一遍正文。
          ref.chapter && summary.sourceHash !== ref.chapter.contentHash
            ? '⚠ 该摘要已过期（正文有改动）'
            : undefined,
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
