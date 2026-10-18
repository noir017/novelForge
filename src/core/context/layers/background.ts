import { plotLabel } from '../../model/pipeline';
import { describeStateThrough } from '../../model/characterState';
import { CONTEXT_DETAIL_LABEL, takeLast } from '../../model/contextDetail';
import { ContinuityFact, locateEvidence, parseContinuityFacts } from '../../model/continuity';
import { Thread, pickActiveThreads, threadCandidates } from '../../model/threadsFile';
import { CharacterCard, LoreEntry } from '../../model/types';
import { createLoreLookup, loreMentionIn } from '../../model/loreFile';
import { LoreFact, LoreRecord, buildLoreIndex } from '../../views/lore';
import { ContextItem } from '../types';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';
import { ChapterRef, readChapterText, readPrevManuscript } from './focus';
import {
  continuationTail,
  focusText,
  isPlaceholder,
  renderCharacter,
  renderLoreFull,
  renderLoreLine,
  renderPlotSections,
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
  const relevant = selectCharacters(all, a.request.ask, a.focus, a.limits.castSummaries);
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
    // 上下文详细度「精简」：一律只带要点，不先试整张卡。
    if (!a.limits.essentialCards) {
      const fullText = renderCharacter(card, false);
      const fullTokens = estimateTokens(fullText);
      if (fullTokens <= a.remaining) {
        a.admit({ ...base, text: fullText, note: why });
        continue;
      }
    }
    const essential = renderCharacter(card, true);
    const essentialTokens = estimateTokens(essential);
    if (essentialTokens <= a.remaining) {
      a.accept(
        {
          ...base,
          text: essential,
          status: 'degraded',
          note: a.limits.essentialCards
            ? `${why}；上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」只带身份/当前状态/未收伏笔`
            : `${why}；预算不足，仅保留身份/当前状态/未收伏笔`,
        },
        essentialTokens
      );
    } else {
      a.reject({ ...base, text: '' }, 'dropped', `${why}；预算不足`);
    }
  }
};

/**
 * 设定（设定名录，2026-10-18）。几百条的书不能「命中就整条塞」：先排序，再分两种形态装，按上下文
 * 详细度封顶，降级与丢弃都留在明细里（第 2 条）。
 *
 * 顺位：
 * - R0 本章细纲第九节「设定」点名的（没定稿是计划，定稿过是实际）——整条；
 * - R1 关键词命中：作者这次的话 + 本章细纲（接着写时再加本章已写的末尾）——整条；
 * - R2 前几章（`castSummaries` 章）定稿细纲第九节出现过的——一行；
 * - R3 只在大纲、细纲阶段：其余条目按出现章数降序——一行，让规划时照抄已有的名字，不另起一个。
 *
 * 续写那几轮只要 R0、R1：前文那几章的设定第一次调用已经带过了。
 *
 * 整条 = 一句话 + 正文 + 尾巴（水位之后、本章之前定稿的章里关于它的新事实，`loreTail` 行）：条目落后于
 * 正文时，模型照样拿得到新的那几句，不必每章定稿都调一次模型去改条目。整条超了 `loreFull`、超了
 * `loreChars` 或预算放不下就降成一行；一行也超了上限就丢。
 *
 * 架构那一层只有两件用得上它：**设定清单**当规划看（分类表 + 已有条目一行一条，清单要照用目录、照抄
 * 名字）；世界观不当规划看，只带作者点名的（已经写了正文的书再加近几章定稿里出现过的一句话）。其余几件
 * （配置、前提、角色图谱）一条都不带——它们在设定之前。
 */
export const lore: LayerFn = async (a, spec) => {
  const { stage } = a.request.action;
  const doc = a.request.target.kind === 'setting' ? a.request.target.doc : undefined;
  if (stage === 'setting' && doc !== 'lore' && doc !== 'world') {
    return;
  }
  const listing = stage === 'setting' && doc === 'lore';
  const entries = await a.project.listLore();
  // 排设定清单时一条条目都没有也要往下走：分类表（目录，空的也算）照样要给。
  if (entries.length === 0 && !listing) {
    return;
  }
  const index = await buildLoreIndex(a.project, { entries });
  const records = new Map(index.known.map((r) => [r.entry.slug, r]));
  const lookup = createLoreLookup(entries);
  const continuation = a.request.step?.kind === 'continuation';
  const planning = listing || stage === 'outline' || stage === 'plot';

  // 规划时新引入的设定要归类：分类就是目录、每本书自己的，空目录也算，模型只能从这一行里知道有哪些。
  if (planning) {
    const categories = await a.project.listLoreCategories();
    if (categories.length > 0) {
      a.admit({
        id: 'lore:categories',
        kind: 'lore',
        priority: spec.priority,
        label: '设定 · 分类表',
        source: a.project.relPath(a.project.loreDir),
        text: `本书的设定分类：${categories.join('、')}（新设定的 category 从这里挑）。`,
        note: '规划时新设定要归进哪一类',
      });
    }
  }

  const picked = new Map<string, { entry: LoreEntry; full: boolean; reason: string }>();
  const pick = (entry: LoreEntry, full: boolean, reason: string): void => {
    if (!picked.has(entry.slug)) {
      picked.set(entry.slug, { entry, full, reason });
    }
  };

  for (const line of a.focus.plot?.lore ?? []) {
    const entry = lookup.find(line.name);
    if (entry) {
      pick(entry, true, `本章细纲的设定里有「${line.name}」`);
    }
  }
  // R1 里也分先后：作者这次亲口说的 → 本章细纲 → 本章已写的末尾。整条名额有限，先给最确定要用的。
  const haystacks = [a.request.ask, focusText(a.focus), await chapterTailText(a)];
  for (const haystack of haystacks) {
    for (const entry of entries) {
      const hit = loreMentionIn(haystack, entry);
      if (hit) {
        pick(entry, true, `上下文中出现「${hit}」`);
      }
    }
  }
  let catalog = 0;
  if (!continuation) {
    const recent = a.focus.previous.filter((r) => r.plot?.sourceHash && r.plot.lore).slice(-a.limits.castSummaries);
    for (const ref of recent.reverse()) {
      for (const line of ref.plot?.lore ?? []) {
        const entry = lookup.find(line.name);
        if (entry) {
          pick(entry, false, `第 ${ref.no} 章出现过`);
        }
      }
    }
    if (planning) {
      // 稳定排序：出现章数一样的保持 listLore 的顺序（按路径，也就是按分类）。
      const rest = index.known
        .filter((r) => !picked.has(r.entry.slug))
        .sort((x, y) => y.chapters.length - x.chapters.length);
      for (const r of rest) {
        pick(r.entry, false, r.chapters.length > 0 ? `已有设定（出现 ${r.chapters.length} 章）` : '已有设定');
        catalog++;
      }
    }
  }

  const level = `上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」`;
  let fullCount = 0;
  let lineCount = 0;
  let chars = 0;
  /** R3 的一览超了上限不逐条报（几百条全是「没带」只会淹掉明细），最后并成一条。 */
  let catalogDropped = 0;
  let catalogWhy = '';
  for (const { entry, full, reason } of picked.values()) {
    const id = `lore:${entry.slug}`;
    const base = {
      id,
      kind: 'lore' as const,
      priority: spec.priority,
      label: `设定 · ${entry.title}`,
      source: entry.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const spoiler = spoilerNote(entry, a.focus.no);
    const why = spoiler ? `${reason}；${spoiler}` : reason;

    let degraded = '';
    if (full) {
      const text = renderLoreFull(entry, loreTail(records.get(entry.slug), a.focus.no, a.limits.loreTail));
      if (fullCount >= a.limits.loreFull) {
        degraded = `整条的已带满 ${a.limits.loreFull} 条（${level}）`;
      } else if (chars + text.length > a.limits.loreChars) {
        degraded = `设定已带 ${chars} 字，整条带会超过 ${a.limits.loreChars} 字（${level}）`;
      } else if (estimateTokens(text) > a.remaining) {
        degraded = '预算不足';
      } else {
        a.admit({ ...base, text, note: why });
        fullCount++;
        chars += text.length;
        continue;
      }
    }

    const line = renderLoreLine(entry);
    const tokens = estimateTokens(line);
    const over =
      lineCount >= a.limits.loreLines
        ? `一句话的已带满 ${a.limits.loreLines} 条（${level}）`
        : chars + line.length > a.limits.loreChars
          ? `设定已带满 ${a.limits.loreChars} 字（${level}）`
          : tokens > a.remaining
            ? '预算不足'
            : '';
    if (over) {
      if (!full && reason.startsWith('已有设定')) {
        catalogDropped++;
        catalogWhy ||= over;
        continue;
      }
      a.reject({ ...base, text: '' }, 'dropped', `${why}；${over}`);
      continue;
    }
    if (degraded) {
      a.accept({ ...base, text: line, status: 'degraded', note: `${why}；${degraded}，只带一句话` }, tokens);
    } else {
      a.admit({ ...base, text: line, note: why });
    }
    lineCount++;
    chars += line.length;
  }
  if (catalogDropped > 0) {
    a.reject(
      {
        id: 'lore:catalog',
        kind: 'lore',
        priority: spec.priority,
        label: `设定 · 其余 ${catalogDropped} 条`,
        text: '',
      },
      'dropped',
      `规划时的已有设定一览共 ${catalog} 条，${catalogWhy}，其余 ${catalogDropped} 条没带`
    );
  }
};

/** 接着写时本章已写的末尾（续写那几轮是 step 里那一截）：关键词命中也看它。 */
async function chapterTailText(a: Parameters<LayerFn>[0]): Promise<string> {
  const step = a.request.step?.kind === 'continuation' ? a.request.step : undefined;
  if (step) {
    return step.tail ?? '';
  }
  if (a.request.writeMode === 'continue' && a.focus.chapter) {
    return continuationTail(await a.project.readChapterText(a.focus.chapter));
  }
  return '';
}

/** 水位之后、本章之前定稿的章里关于它的新事实，最近的 `max` 条。 */
function loreTail(record: LoreRecord | undefined, beforeNo: number, max: number): LoreFact[] {
  if (!record || max <= 0) {
    return [];
  }
  return takeLast(
    record.pending.filter((f) => f.no < beforeNo),
    max
  );
}

/**
 * 条目整合到的章不早于本章（回头重写前面的章时）：条目里可能写着之后才发生的事。同角色卡的
 * 「当前状态写到第几章」。架构、大纲阶段（`no` 是无穷大）不提。
 */
function spoilerNote(entry: LoreEntry, no: number): string {
  if (entry.updatedThrough === undefined || !Number.isFinite(no) || entry.updatedThrough < no) {
    return '';
  }
  return `条目整合到第 ${entry.updatedThrough} 章，可能含第 ${no} 章之后才发生的事`;
}

export const prevTail: LayerFn = async (a, spec) => {
  const prev = a.focus.previous[a.focus.previous.length - 1];
  // 「接着写」不带：这一章的开头早就从上一章结尾接过了，要接的是本章已写的末尾
  // （`chapterSoFar`）。两个「从这里接下去」摆在一起，模型会跳回上一章去。
  if (!prev || a.limits.prevTailChars <= 0 || a.request.writeMode === 'continue') {
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
      text: tailByChars(manuscript.text, a.limits.prevTailChars),
      note: '原文注入，保证语气与场景衔接',
    },
    { force: spec.force }
  );
};

/**
 * 前面几章的**正文全文**。只有正文阶段带（配方里只有那一张有这一层）。
 *
 * 放不下时降级为该章细纲，再放不下才丢弃——三档都要留在明细里说清原因
 * （AGENTS.md 第 2 条：不静默截断）。
 */
export const manuscriptFull: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const prev = previous[previous.length - 1];
  // 0 就是一章全文都不带（`takeLast` 不踩 `slice(-0)` 等于 `slice(0)` 的坑）。
  const fullTextPlots = takeLast(previous, a.limits.fullTextChapters);

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
      // **不认领它**（不进 fullTextNos）：认领了细纲那一层（`plotSummary`）就会跳过它，
      // 而它没有正文，于是从上下文里凭空消失，明细上还看不出少了什么。
      // 留给细纲那一层，那里带它的计划并标明。
      continue;
    }
    // 确实注入了（哪怕后面降级成细纲）才认领：细纲那一层据此避免重复注入。
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

    const outline = ref.plot ? renderPlotSections(ref.plot) : '';
    if (outline) {
      const planned = !ref.plot!.sourceHash;
      const outlineBlock = `【${label} · 细纲${planned ? '（计划，没定稿）' : ''}】\n${outline}`;
      const outlineTokens = estimateTokens(outlineBlock);
      if (outlineTokens <= a.remaining) {
        a.accept(
          {
            ...base,
            source: ref.plot!.relPath,
            text: outlineBlock,
            status: 'degraded',
            note: `正文需 ${tokens} token 放不下，已降级为细纲${planned ? '（还没定稿，是写之前的计划）' : ''}`,
          },
          outlineTokens
        );
        continue;
      }
    }
    a.reject(
      { ...base, text: '' },
      'dropped',
      outline ? '正文与细纲都放不下' : `正文需 ${tokens} token 放不下，且这一章没有细纲`
    );
  }
};

/** 这一章定稿过、而且定稿之后正文没再改过（细纲的 `sourceHash` 对得上正文）。 */
function isFinalized(ref: ChapterRef): boolean {
  return !!ref.plot?.sourceHash && !!ref.chapter && ref.plot.sourceHash === ref.chapter.contentHash;
}

/**
 * 更早那些章的细纲，由近及远填充，最多带最近 `summaryChapters` 章（上下文详细度，缺省 60）。
 *
 * 定稿过的细纲是那一章实际写成的样子；**还没定稿的照样带，标明是「计划」**——作者常常先把
 * 一百章细纲排完再回头写，那些章的细纲就是这里唯一的前情，直接跳过的话模型对前面一无所知，
 * 却看不出少了什么。定稿之后正文又改过的标 ⚠。
 *
 * **封顶之外的合成一条 dropped**，不是一章一条：一百多章的书封在 5 章时，明细里摆九十几行
 * 「不带」只会把真正带了什么淹掉。更早的前情由全书摘要接着（它在 P2，比这一层先拿预算）。
 * 名额按「最近几章」数，作者手动取消勾选的那一章照样占一个名额。
 */
export const plotSummary: LayerFn = async (a, spec) => {
  const candidates = a.focus.previous.filter((p) => !a.scratch.fullTextNos.has(p.no)).reverse();
  const cap = a.limits.summaryChapters;
  const beyond = candidates.slice(cap);
  for (const ref of candidates.slice(0, cap)) {
    const id = `plotSummary:${ref.no}`;
    const label = plotLabel(ref.no, ref.title);
    const base = {
      id,
      kind: 'plotSummary' as const,
      priority: spec.priority,
      label: `${label} · 细纲`,
      source: ref.plot?.relPath ?? ref.chapter?.relPath ?? '',
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, source: undefined, text: '' });
      continue;
    }

    const content = ref.plot ? renderPlotSections(ref.plot) : '';
    if (!content) {
      a.reject({ ...base, text: '' }, 'dropped', ref.chapter ? '这一章有正文，但还没有细纲（定稿之后才有）' : '这一章还没有细纲');
      continue;
    }
    const finalized = !!ref.plot!.sourceHash;
    const block = `【${label}${finalized ? '' : ' · 计划'}】\n${content}`;
    const tokens = estimateTokens(block);
    if (tokens > a.remaining) {
      a.reject({ ...base, text: '' }, 'dropped', '预算已满，更早的章不再注入');
      continue;
    }
    a.accept(
      {
        ...base,
        text: block,
        status: 'included',
        note: !finalized
          ? '还没定稿：带的是写之前的计划'
          : // 定稿的上游是正文，直接比它的 hash——不必再读一遍正文。
            ref.chapter && ref.plot!.sourceHash !== ref.chapter.contentHash
            ? '⚠ 定稿之后正文又改过，这份细纲可能没跟上'
            : undefined,
      },
      tokens
    );
  }
  if (beyond.length > 0) {
    // `beyond` 由近及远：最后一个是最早的那章。
    const first = beyond[beyond.length - 1].no;
    const last = beyond[0].no;
    a.reject(
      {
        id: 'plotSummary:beyond',
        kind: 'plotSummary',
        priority: spec.priority,
        label: first === last ? `${plotLabel(first, beyond[0].title)} · 细纲` : `第 ${first}–${last} 章 · 细纲`,
        text: '',
      },
      'dropped',
      `上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」只带最近 ${cap} 章的细纲，更早的 ${beyond.length} 章不带`
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
      label:
        a.request.writeMode === 'revise'
          ? `已修订正文 · 末尾（已输出 ${written} 字）`
          : `本章已写正文 · 末尾（全章已有 ${written} 字）`,
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

/**
 * 前面各章的**定稿原文片段**（D18）：拿定稿过的细纲里每条连续性事实的证据原句回到那一章的正文里
 * 逐字定位，取所在段落与前后各一段（model/continuity.ts 的 `locateEvidence`）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`chapter-materials.ts` 的
 * `assembleChapterMaterials`（CM:120-187）：写正文时不拿细纲当事实，按证据回到定稿原文里取段落。
 * 不搬它的定稿收据、来源 hash 与租约（总计划 §1 #14）。
 *
 * 取多少按上下文详细度（`evidenceRecent` / `evidenceChapters` / `evidenceChars`，缺省 5 / 12 / 6000）：
 *
 * | 取哪几章 | 取什么 |
 * |---|---|
 * | 前 `evidenceRecent` 章 | 全部连续性事实 |
 * | 更早的章，一共不超过 `evidenceChapters` 章 | 只取提到本章角色的事实 |
 *
 * - 只认定稿之后正文没再改过的章（细纲的 `sourceHash` 对得上正文）：正文改过的，证据句多半已经
 *   不在原处，事实本身也可能正是改掉的那一处。
 * - 由近及远填，一共不超过 `evidenceChars` 字；放不下的章 dropped 并写原因（第 2 条）。
 * - **定位不到**（作者手改过细纲里的事实或证据句）的那几条换成事实原句，条目标 degraded 并写明几条（第 2 条）。
 * - 上一章有正文却还没定稿（或定稿之后正文又改过）：明细里多一条 dropped，说清没有事实、角色状态截至第几章（D23）。
 *   不挡路——写第 N 章不强制第 N−1 章已定稿——但不静默。
 * - 「精简」整层不带：前面有写好的章时出一条 dropped 说明，不一章一条。
 */
export const evidence: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  if (previous.length === 0) {
    return;
  }
  const { evidenceRecent, evidenceChapters, evidenceChars } = a.limits;
  if (evidenceChapters <= 0 || evidenceChars <= 0) {
    if (previous.some((p) => p.chapter && p.chapter.wordCount > 0)) {
      a.reject(
        { id: 'evidence:off', kind: 'evidence', priority: spec.priority, label: '定稿原文片段', text: '' },
        'dropped',
        `上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」不带定稿原文片段`
      );
    }
    return;
  }
  const cards = await a.project.listCharacters();
  const names = namesOf(cards, a.focus.plot?.characters ?? []);
  const recentFrom = previous.length - evidenceRecent;
  const prev = previous[previous.length - 1];
  let budget = evidenceChars;
  let taken = 0;

  for (let i = previous.length - 1; i >= 0 && taken < evidenceChapters; i--) {
    const ref = previous[i];
    if (!ref.chapter || ref.chapter.wordCount <= 0) {
      continue;
    }
    const label = `${plotLabel(ref.no, ref.title)} · 定稿原文`;
    const base = { id: `evidence:${ref.no}`, kind: 'evidence' as const, priority: spec.priority, label, source: ref.chapter.relPath };
    const finalized = isFinalized(ref);
    if (ref === prev && !finalized) {
      const through = latestState(cards, names);
      a.reject(
        { ...base, text: '' },
        'dropped',
        ref.plot?.sourceHash
          ? `第 ${ref.no} 章定稿之后正文又改过：连续性事实不作数${through !== undefined ? `，角色状态截至第 ${through} 章` : ''}`
          : `第 ${ref.no} 章还没定稿：没有连续性事实${through !== undefined ? `，角色状态截至第 ${through} 章` : ''}`
      );
      continue;
    }
    // 只认对得上的定稿：定稿之后正文改过的，证据句多半已经不在原处，事实本身也可能正是改掉的那一处。
    if (!finalized) {
      continue;
    }
    const all = parseContinuityFacts(ref.plot!.sections.连续性事实);
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
      a.reject({ ...base, text: '' }, 'dropped', `定稿原文片段一共只带 ${evidenceChars} 字，更近的几章已经用完了`);
      continue;
    }
    const notes = [i >= recentFrom ? `${facts.length} 条连续性事实` : `${facts.length} 条涉及本章角色的连续性事实`];
    const item = a.admit({ ...base, text: block, note: notes.join('；') });
    if (item.status === 'included') {
      budget -= block.length;
      if (missing > 0) {
        item.status = 'degraded';
        item.note = `${notes.join('；')}；${missing} 条证据在正文里找不到（细纲里的事实被手改过），换成事实原句`;
      }
      a.scratch.evidence.set(ref.no, item);
    }
  }
};

/**
 * 写这一章时带哪几条**叙事线**（七期）：跨章的伏笔与线索，还没收的、和本章有关的那几条。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts` 的
 * `readActiveNarrativeThreads`（GD:1452-1498）。挑哪几条、怎么排、一行怎么写都在
 * model/threadsFile.ts（`pickActiveThreads`）；这一层只管登记：
 *
 * - 一条线一个条目，按要紧程度排好（细纲提到的在最前）；note 写状态与为什么带它。
 * - 条数与字数按上下文详细度（缺省 6 条 / 1200 字），放不下的条目 dropped 并写原因（第 2 条）。
 * - 作者在明细里取消勾选的那条不占名额，后面的补上来。
 * - 没有 `threads.md`、或者没有一条有关的线：什么都不出（没有东西被截断）。
 */
export const threads: LayerFn = async (a, spec) => {
  if (!Number.isFinite(a.focus.no)) {
    return;
  }
  const list = await a.project.readThreads();
  if (list.length === 0) {
    return;
  }
  const plot = a.focus.plot;
  const focus = {
    no: a.focus.no,
    plotText: plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : '',
    names: namesOf(await a.project.listCharacters(), plot?.characters ?? []),
  };
  const source = a.project.relPath(a.project.threadsPath);
  const idOf = (t: Thread): string => `thread:${t.index}`;
  const base = (t: Thread) => ({
    id: idOf(t),
    kind: 'thread' as const,
    priority: spec.priority,
    label: `叙事线 · ${t.title}`,
    source,
  });

  const excluded = threadCandidates(list, focus).filter((c) => a.excluded.has(idOf(c.thread)));
  const { picked, dropped } = pickActiveThreads(
    list.filter((t) => !a.excluded.has(idOf(t))),
    focus,
    { count: a.limits.threadCount, chars: a.limits.threadChars }
  );
  for (const p of picked) {
    a.admit({ ...base(p.thread), text: p.line, note: `${p.status} · ${p.why}` });
  }
  for (const c of excluded) {
    a.admit({ ...base(c.thread), text: '' });
  }
  for (const d of dropped) {
    a.reject({ ...base(d.thread), text: '' }, 'dropped', d.note);
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

/**
 * 上一版正文与修改意见：「重写」与「修稿」（五期）。
 *
 * **整章都带。** 从前这里是 `takeTail(…, 3000)`——3000 token 的尾巴，长一点的章前半截直接没了，
 * 模型只能凭空重写开头，明细上还看不出少了什么（第 2 条）。修稿要求「清单没指到的地方一字不改」，
 * 手上没有原文就无从谈起。
 */
export const revision: LayerFn = async (a, spec) => {
  const value = a.request.revision;
  if (!value) {
    return;
  }
  const revise = a.request.writeMode === 'revise';
  a.admit(
    {
      id: 'revision',
      kind: 'revision',
      priority: spec.priority,
      label: revise ? '待修稿原文与勾选的审稿意见' : '上一版草稿与修改意见',
      text: revise
        ? `【待修稿原文】\n${value.previousDraft.trim()}\n\n${value.feedback.trim()}`
        : `【上一版草稿】\n${value.previousDraft.trim()}\n\n【修改意见】\n${value.feedback.trim()}`,
    },
    { force: spec.force }
  );
};

/**
 * 待审的这一章正文全文（审稿，五期）。审的就是它，P0 force；这一章还没有正文时审稿在
 * 生成层就被拦下了（generation/generate.ts），走不到这里。
 */
export const chapterFull: LayerFn = async (a, spec) => {
  const chapter = a.focus.chapter;
  if (!chapter) {
    return;
  }
  const text = await a.project.readChapterText(chapter);
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: `chapterFull:${a.focus.no}`,
      kind: 'chapterFull',
      priority: spec.priority,
      label: `${plotLabel(a.focus.no, chapter.title)} · 待审正文（${chapter.wordCount} 字）`,
      source: chapter.relPath,
      text: text.trim(),
    },
    { force: spec.force }
  );
};

/**
 * 前几章定稿留下的连续性事实（审稿，五期）：由近及远、一章一条，只带事实文字。
 * 最多几章、一共几字按上下文详细度（`factsChapters` / `factsChars`，缺省 12 章 / 3000 字）。
 *
 * 上游审稿读的是「已定稿历史的连续性投影」——每一章的要点与事实（RV:121-154），明说它是
 * 「唯一已发生事实源」。这里对应定稿过的细纲里的「连续性事实」一节。没定稿、或定稿之后正文又改过
 * 的章不带并说清楚：拿一份过期的事实去判「本章与前文矛盾」，判出来的可能正是作者改过的地方。
 */
export const recentFacts: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const { factsChapters, factsChars } = a.limits;
  let budget = factsChars;
  let taken = 0;
  for (let i = previous.length - 1; i >= 0 && taken < factsChapters; i--) {
    const ref = previous[i];
    if (!ref.chapter || ref.chapter.wordCount <= 0) {
      continue;
    }
    taken++;
    const base = {
      id: `facts:${ref.no}`,
      kind: 'facts' as const,
      priority: spec.priority,
      label: `${plotLabel(ref.no, ref.title)} · 连续性事实`,
      source: ref.chapter.relPath,
    };
    if (!isFinalized(ref)) {
      a.reject(
        { ...base, text: '' },
        'dropped',
        ref.plot?.sourceHash ? '定稿之后正文又改过，事实不作数' : '这一章还没定稿，没有连续性事实'
      );
      continue;
    }
    const facts = parseContinuityFacts(ref.plot!.sections.连续性事实);
    if (facts.length === 0) {
      continue;
    }
    const block = `【${plotLabel(ref.no, ref.title)}】\n${facts.map((f) => `- ${f.statement}`).join('\n')}`;
    if (block.length > budget) {
      a.reject({ ...base, text: '' }, 'dropped', `连续性事实一共只带 ${factsChars} 字，更近的几章已经用完了`);
      continue;
    }
    const item = a.admit({ ...base, source: ref.plot!.relPath, text: block, note: `${facts.length} 条` });
    if (item.status === 'included') {
      budget -= block.length;
    }
  }
};
