import { plotLabel } from '../../model/pipeline';
import { describeStateThrough } from '../../model/characterState';
import { ContinuityFact, locateEvidence, parseContinuityFacts } from '../../model/continuity';
import { CharacterCard } from '../../model/types';
import { ContextItem } from '../types';
import { estimateTokens, takeTail } from '../tokenizer';
import type { LayerFn } from './assembly';
import { readChapterText, readPrevManuscript } from './focus';
import {
  continuationTail,
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
    // 「当前状态」写到第几章（D23）：上一章没定稿时，这里说的是更早那一章结束时的样子。
    const through = describeStateThrough(card.stateThrough);
    const why = through ? `${reason}；${through}` : reason;
    const fullText = renderCharacter(card, false);
    const fullTokens = estimateTokens(fullText);
    if (fullTokens <= a.remaining) {
      a.admit({ ...base, text: fullText, note: why });
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
          note: `${why}；预算不足，仅保留身份/当前状态/未收伏笔`,
        },
        essentialTokens
      );
    } else {
      a.reject({ ...base, text: '' }, 'dropped', `${why}；预算不足`);
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
  // 「接着写」不带：这一章的开头早就从上一章结尾接过了，要接的是本章已写的末尾
  // （`chapterSoFar`）。两个「从这里接下去」摆在一起，模型会跳回上一章去。
  if (!prev || a.config.prevChapterTailChars <= 0 || a.request.writeMode === 'continue') {
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
  // 0 就是一章全文都不带：`slice(-0)` 等于 `slice(0)`，会把前面每一章都整章塞进来。
  const fullTextPlots = fullTextCount > 0 ? previous.slice(-fullTextCount) : [];

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
      // 只排了细纲、还没写正文——这不是错误，是这一章还没到那一步。
      // **不认领它**（不进 fullTextNos）：认领了摘要那一层就会跳过它，
      // 而它既没有正文也没有摘要，于是从上下文里凭空消失，明细上还看不出
      // 少了什么。留给摘要层，那里会退化成只带「本章目的」并说明原因。
      continue;
    }
    // 确实注入了（哪怕后面降级成摘要）才认领：摘要层据此避免重复注入。
    a.scratch.fullTextNos.add(plot.no);
    const block = `【${label}】\n${manuscript.text}`;
    const tokens = estimateTokens(block);
    // 这一章的定稿原文片段（`evidence` 层先装的）：整章进来了它就多余了，那份预算可以退回来用。
    const ev = a.scratch.evidence.get(plot.no);
    const evTokens = ev && ev.status !== 'dropped' ? ev.tokens : 0;
    const tail = a.scratch.prevTail;
    if (tail && plot.no === prev?.no && tail.status === 'included') {
      if (tokens - tail.tokens - evTokens <= a.remaining) {
        releaseEvidence(a, ev);
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

    if (tokens <= a.remaining + evTokens) {
      releaseEvidence(a, ev);
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
 * **还没写正文的章退化成只带「本章目的」**，并在明细里注明原因。这是「不静默截断」
 * 在这条链上最要紧的一处：作者常常先把一百章细纲排完再回头写，那些章没有正文
 * 也就没有摘要——直接跳过的话，排第 60 章时模型对前 59 章一无所知，却看不出
 * 少了什么。带一行目的很便宜，而且诚实。
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

    // 摘要挂在正文上；还没写的章自然没有。
    const summary = ref.chapter ? await a.project.readSummary(ref.chapter.relPath) : undefined;
    if (!summary?.content.trim()) {
      const goal = ref.plot?.sections.本章目的.trim() ?? '';
      if (!goal) {
        a.reject({ ...base, text: '' }, 'dropped', '这一章还没写正文，也没有本章目的可带');
        continue;
      }
      const block = `【${label}】\n${goal}`;
      const tokens = estimateTokens(block);
      if (tokens > a.remaining) {
        a.reject({ ...base, text: '' }, 'dropped', '预算已满，更早的章不再注入');
        continue;
      }
      a.accept(
        { ...base, text: block, status: 'degraded', note: '这一章还没写正文，只带本章目的' },
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
          // 摘要的上游是正文，直接比它的 hash——不必再读一遍正文。
          ref.chapter && summary.sourceHash !== ref.chapter.contentHash
            ? '⚠ 该摘要已过期（正文有改动）'
            : undefined,
      },
      tokens
    );
  }
};

/**
 * 本章已经写好的正文末尾（最后 1600 字）：「接着写」与续写那几轮从这里往下接。
 *
 * 两个来处：续写那几轮由生成链把「已写到哪」直接给过来（`step.tail`，含这一次刚写、
 * 还没落盘的部分）；「接着写」的第一次调用读磁盘上这一章的正文。**只带末尾**——
 * 上游续写也只带 1600 字（GD:998）：接得上靠的是最后那一场，整章塞进去只是贵。
 */
export const chapterSoFar: LayerFn = async (a, spec) => {
  const step = a.request.step?.kind === 'continuation' ? a.request.step : undefined;
  let text = step?.tail ?? '';
  let written = step?.written ?? 0;
  let source: string | undefined;
  if (!step) {
    if (a.request.writeMode !== 'continue' || !a.focus.chapter) {
      return;
    }
    const body = await a.project.readChapterText(a.focus.chapter);
    text = continuationTail(body);
    written = a.focus.chapter.wordCount;
    source = a.focus.chapter.relPath;
  }
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: 'chapterSoFar',
      kind: 'chapterSoFar',
      priority: spec.priority,
      label: `本章已写正文 · 末尾（全章已有 ${written} 字）`,
      source,
      text,
      note: '只带最后一段，从这里往下接',
    },
    { force: spec.force }
  );
};

/** 整章正文进来了：它的定稿原文片段改成 dropped、预算退回去（与上一章结尾片段同一个做法）。 */
function releaseEvidence(a: Parameters<LayerFn>[0], ev: ContextItem | undefined): void {
  if (!ev || ev.status === 'dropped' || ev.status === 'excluded') {
    return;
  }
  a.remaining += ev.tokens;
  ev.status = 'dropped';
  ev.note = '整章正文已完整注入，不再单独带片段';
  ev.tokens = 0;
  ev.text = '';
}

/** 前几章的连续性事实全取（D18）。 */
export const EVIDENCE_RECENT = 5;
/** 最多从几章里取（更早的章只取涉及本章角色的）。 */
export const EVIDENCE_MAX_CHAPTERS = 12;
/** 定稿原文片段一共多少字（上游 `MATERIAL_BUDGET_CHARS`）。 */
export const EVIDENCE_BUDGET_CHARS = 6000;

/**
 * 前面各章的**定稿原文片段**（D18）：拿摘要里每条连续性事实的证据原句回到那一章的正文里
 * 逐字定位，取所在段落与前后各一段（model/continuity.ts 的 `locateEvidence`）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`chapter-materials.ts` 的
 * `assembleChapterMaterials`（CM:120-187）：写正文时不拿摘要当事实，按证据回到定稿原文里取段落。
 * 不搬它的定稿收据、来源 hash 与租约（总计划 §1 #14）。
 *
 * | 取哪几章 | 取什么 |
 * |---|---|
 * | 前 {@link EVIDENCE_RECENT} 章 | 全部连续性事实 |
 * | 更早的章，一共不超过 {@link EVIDENCE_MAX_CHAPTERS} 章 | 只取提到本章角色的事实 |
 *
 * - 由近及远填，一共不超过 {@link EVIDENCE_BUDGET_CHARS} 字；放不下的章 dropped 并写原因（第 2 条）。
 * - **定位不到**（作者改过正文）的那几条换成事实原句，条目标 degraded 并写明几条（第 2 条）。
 * - 上一章有正文却还没定稿：明细里多一条 dropped，说清没有事实、角色状态截至第几章（D23）。
 *   不挡路——写第 N 章不强制第 N−1 章已定稿——但不静默。
 */
export const evidence: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  if (previous.length === 0) {
    return;
  }
  const cards = await a.project.listCharacters();
  const names = namesOf(cards, a.focus.plot?.characters ?? []);
  const recentFrom = previous.length - EVIDENCE_RECENT;
  const prev = previous[previous.length - 1];
  let budget = EVIDENCE_BUDGET_CHARS;
  let taken = 0;

  for (let i = previous.length - 1; i >= 0 && taken < EVIDENCE_MAX_CHAPTERS; i--) {
    const ref = previous[i];
    if (!ref.chapter || ref.chapter.wordCount <= 0) {
      continue;
    }
    const label = `${plotLabel(ref.no, ref.title)} · 定稿原文`;
    const base = { id: `evidence:${ref.no}`, kind: 'evidence' as const, priority: spec.priority, label, source: ref.chapter.relPath };
    const summary = await a.project.readSummary(ref.chapter.relPath);
    const finalized = !!summary && summary.sourceHash === ref.chapter.contentHash;
    if (ref === prev && !finalized) {
      const through = latestState(cards, names);
      a.reject(
        { ...base, text: '' },
        'dropped',
        `第 ${ref.no} 章还没定稿：没有连续性事实${through !== undefined ? `，角色状态截至第 ${through} 章` : ''}`
      );
      continue;
    }
    if (!summary) {
      continue;
    }
    const all = parseContinuityFacts(summary.sections.连续性事实);
    const facts = i >= recentFrom ? all : all.filter((f) => names.some((n) => f.statement.includes(n)));
    if (facts.length === 0) {
      continue;
    }
    taken++;
    if (a.excluded.has(base.id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const text = await a.project.readChapterText(ref.chapter);
    const { block, missing } = renderEvidence(ref.no, ref.title, text, facts);
    if (block.length > budget) {
      a.reject({ ...base, text: '' }, 'dropped', `定稿原文片段一共只带 ${EVIDENCE_BUDGET_CHARS} 字，更近的几章已经用完了`);
      continue;
    }
    const notes = [
      i >= recentFrom ? `${facts.length} 条连续性事实` : `${facts.length} 条涉及本章角色的连续性事实`,
      ...(finalized ? [] : ['⚠ 摘要已过期（正文有改动）']),
    ];
    const item = a.admit({ ...base, text: block, note: notes.join('；') });
    if (item.status === 'included') {
      budget -= block.length;
      if (missing > 0) {
        item.status = 'degraded';
        item.note = `${notes.join('；')}；${missing} 条证据在正文里找不到（正文改过），换成事实原句`;
      }
      a.scratch.evidence.set(ref.no, item);
    }
  }
};

/** 一章的片段：定位得到的原文段落在前，定位不到的事实原句在后。 */
function renderEvidence(
  no: number,
  title: string,
  text: string,
  facts: ContinuityFact[]
): { block: string; missing: number } {
  const quoted = facts.filter((f) => f.evidence);
  const { passages, hits } = locateEvidence(text, quoted.map((f) => f.evidence!));
  const lost = [...facts.filter((f) => !f.evidence), ...quoted.filter((_, k) => !hits[k])];
  const parts = [...passages];
  if (lost.length > 0) {
    parts.push(`（下面几条在正文里找不到原句，只有事实本身）\n${lost.map((f) => `- ${f.statement}`).join('\n')}`);
  }
  return { block: `【${plotLabel(no, title)}】\n${parts.join('\n\n')}`, missing: lost.length };
}

/** 本章角色（细纲 `characters[]`）的名字与他们卡上的别名。更早的章按它挑事实。 */
function namesOf(cards: CharacterCard[], planned: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of planned) {
    out.add(name);
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    if (card) {
      out.add(card.name);
      card.aliases.forEach((x) => out.add(x));
    }
  }
  return [...out].filter((n) => n.trim().length >= 2);
}

/** 本章角色里最晚的「当前状态写到第几章」。一个都没记过时 undefined。 */
function latestState(cards: CharacterCard[], names: readonly string[]): number | undefined {
  const nos = cards
    .filter((c) => names.includes(c.name))
    .map((c) => c.stateThrough)
    .filter((n): n is number => n !== undefined);
  return nos.length > 0 ? Math.max(...nos) : undefined;
}

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
