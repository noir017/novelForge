import { CONTEXT_DETAIL_LABEL, takeLast } from '../../model/contextDetail';
import { plotLabel } from '../../model/pipeline';
import {
  OutlineEntry,
  outlineBrief,
  outlineToSplit,
  outlineWindow,
  renderOutlineEntry,
  renderOutlineWindow,
} from '../../model/outlineFile';
import { isPlotFilled, sectionLine } from '../../model/plotFile';
import {
  PLOT_STRUCTURE_LABEL,
  SETTING_DOC_HEADING,
  SETTING_FILE_DOCS,
  SETTING_SECTION_KEYS,
  SettingFileDoc,
} from '../../model/settingFile';
import { structureGuideText } from '../../model/structureGuide';
import { hasContent, stringifySections } from '../../model/markdown';
import { estimateTokens } from '../tokenizer';
import type { LayerSpec } from '../types';
import type { Assembly, LayerFn } from './assembly';
import { clipLine, isPlaceholder, renderPlot, renderPlotBrief, renderRosterLine } from './render';

/*
 * 前序细纲一览最多带几章：按上下文详细度（`plotListMax`），缺省 100——上游
 * `chapter_blueprint_chunk` 的「最近 100 章」。大纲阶段只带第一行的那一段也按它封顶，更早的看全文大纲。
 */

/** 批次模式下，一览里最后几章写得详细些（带看点）——下一批要紧接着它们往下排。 */
const PLOT_LIST_DETAILED = 3;

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 情节大纲，按远近带分三段（model/outlineFile.ts 的 `outlineWindow`，docs/design/plans/2026-10-22-planning-context-bands.md）：
 * 离这一次要写的地方最近的 10 章带整条（强制），再往前最多 `plotListMax` 章只带第一行（不强制，放不下从最老的丢起），
 * 更早的交给全文大纲——从前更早的一章不落地全列、还强制带，写到七八百章光这一层就能把窗口撑满。
 *
 * - 大纲阶段（续写、重写、讨论）：区间之后已经排好的也只带第一行，接得上（不强制，放不下从最远的丢起）。
 * - 细纲阶段：只带这一次要拆的（{@link outlineToSplitDoc}）。
 *
 * 一条章标题都认不出（旧格式的区间分节、散文式大纲）就不带，在明细里说清（第 2 条）。
 */
export const outlineDoc: LayerFn = async (a, spec) => {
  const outline = a.request.outlineDraft ?? (await a.project.readOutline());
  if (!outline.trim() || isPlaceholder(outline)) {
    return;
  }
  const no = a.focus.no;
  const range = a.request.range ?? (Number.isFinite(no) ? { from: no, to: no } : undefined);
  const planning = a.request.action.stage === 'outline';
  const source = a.project.relPath(a.project.outlinePath);
  const win = outlineWindow(outline, { range, after: planning, maxBefore: a.limits.plotListMax });
  if (!win) {
    a.reject(
      { id: 'outlineDoc', kind: 'outlineDoc', priority: spec.priority, label: '情节大纲', source, text: '' },
      'dropped',
      '认不出「## 第N章：标题」这样的章标题（区间分节是旧格式，不认），重写大纲之后才带'
    );
    return;
  }
  if (!planning && range) {
    await outlineToSplitDoc(a, spec, outline, range, source);
    return;
  }
  // 分段重写：说清哪几章是这次刚写的新版、哪几章是待重写的旧版，免得模型照抄旧版。
  const rewriting = a.request.outlineDraft !== undefined && range;
  const start = a.request.outlineRewriteFrom ?? 1;
  const lead = rewriting
    ? `【重写中】${range.from > start ? `${span(start, range.from - 1)}是这次刚重写好的新版；` : ''}第 ${range.from} 章起是旧版，${span(range.from, range.to)}正是这一次要重写的，旧版只作参考。

`
    : '';
  // 近段强制；中段由近及远、区间之后由近及远，各自放到预算用完为止（只算一行一行，段落开头与空行忽略不计）。
  let room = a.remaining - estimateTokens(`${lead}${renderOutlineWindow({ before: [], near: win.near, later: [] })}`);
  const fit = (list: OutlineEntry[]): OutlineEntry[] => {
    const kept: OutlineEntry[] = [];
    for (const e of list) {
      const cost = estimateTokens(`- ${outlineBrief(e)}\n`);
      if (cost > room) {
        break;
      }
      room -= cost;
      kept.push(e);
    }
    return kept;
  };
  const before = fit([...win.before].reverse()).reverse();
  const later = fit(win.later);
  const cut = [...win.before.slice(0, win.before.length - before.length), ...win.later.slice(later.length)].map((e) => e.no);
  const brief = [...before, ...later].map((e) => e.no);
  const notes = [
    rewriting ? `分段重写：第 ${range.from} 章以前是新版，以后是旧版` : '',
    brief.length > 0 ? `${spansOf(brief)}只带第一行，${win.near.length > 0 ? `${spansOf(win.near.map((e) => e.no))}带整条` : '其余不带'}` : '',
    win.folded.length > 0
      ? await foldedNote(
          a,
          `${spansOf(win.folded)}没逐章列（一章一行最多 ${a.limits.plotListMax} 章，上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」）`,
          win.folded
        )
      : '',
    cut.length > 0 ? `预算不足，${spansOf(cut)}没带` : '',
  ].filter(Boolean);
  const item = {
    id: 'outlineDoc',
    kind: 'outlineDoc' as const,
    priority: spec.priority,
    label: rewriting ? '情节大纲（重写中）' : '情节大纲',
    source,
    text: `${lead}${renderOutlineWindow({ before, near: win.near, later })}`,
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
  if (cut.length > 0 && !a.excluded.has(item.id)) {
    a.accept({ ...item, status: 'degraded' }, estimateTokens(item.text));
    return;
  }
  a.admit(item, { force: spec.force });
};

/**
 * 拆细纲时的大纲：只带这一次要拆的（`outlineToSplit`）——批次是区间里那几条，外加区间前面还没拆的空壳；单章时这一章的
 * 梗概已经在本章细纲里，只剩前面的空壳，一条都没有就不出这一层。已经拆过的章前序细纲一览（与单章时的前几章细纲）
 * 带了，从前这里再带一遍它们的梗概，同一份细纲进了两次。
 */
async function outlineToSplitDoc(
  a: Assembly,
  spec: LayerSpec,
  outline: string,
  range: { from: number; to: number },
  source: string
): Promise<void> {
  const stubs = new Set(a.focus.previous.filter((c) => c.plot && !isPlotFilled(c.plot.sections)).map((c) => c.no));
  const entries = outlineToSplit(outline, range, { stubs, skip: a.request.range ? undefined : range.from });
  if (entries.length === 0) {
    return;
  }
  const early = entries.filter((e) => e.no < range.from).map((e) => e.no);
  a.admit(
    {
      id: 'outlineDoc',
      kind: 'outlineDoc',
      priority: spec.priority,
      label: '情节大纲',
      source,
      text: entries.map(renderOutlineEntry).join('\n\n'),
      note: [
        early.length > 0 ? `${spansOf(early)}还没拆细纲，带梗概` : '',
        `只带这一次要拆的：已经拆过的章看前序细纲一览，第 ${range.to} 章以后的不带`,
      ]
        .filter(Boolean)
        .join('；'),
    },
    { force: spec.force }
  );
}

/**
 * 远段不逐章列、交给全文大纲：`head` 说清按哪一级封的顶，后面接全文大纲接不接得住——没有、或没写到那里时照实说
 * （第 2 条）。不自动更新全文大纲（第 4 条）。
 */
async function foldedNote(a: Assembly, head: string, folded: number[]): Promise<string> {
  const summary = await a.project.readGlobalSummary();
  if (!summary.trim() || isPlaceholder(summary)) {
    return `${head}，还没有全文大纲：${spansOf(folded)}这次没带`;
  }
  const upTo = folded[folded.length - 1];
  const through = (await a.project.readManifest()).globalSummaryThrough ?? 0;
  return through > 0 && through < upTo
    ? `${head}，更早的看全文大纲；全文大纲只写到第 ${through} 章：${span(Math.max(through + 1, folded[0]), upTo)}这次没带`
    : `${head}，更早的看全文大纲`;
}

/** `[1,2,3,7,8]` → 「第 1–3 章、第 7–8 章」。 */
function spansOf(nos: number[]): string {
  const runs: [number, number][] = [];
  for (const n of nos) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) {
      last[1] = n;
    } else {
      runs.push([n, n]);
    }
  }
  return runs.map(([from, to]) => span(from, to)).join('、');
}

/**
 * 架构层的三份文档（小说配置 / 故事前提 / 世界观），填过的才带。
 *
 * 一件一条：作者在明细里能单独取消某一件（比如重写前提时不想让旧前提带偏模型）。
 * 正在生成的那一件也照带——目标已有内容时再生成，那一版就是修改的底稿。
 */
export const settingDocs: LayerFn = async (a, spec) => {
  await admitSettingDocs(a, spec);
};

/**
 * 写正文用的架构：小说配置（**除全局要求**）、故事前提、世界观，一件一条。
 *
 * 与 `settingDocs` 同一份取数，只少一节：「全局要求」由 `guidance` 层单独强制带（P0），
 * 这里再带一遍就是同一段规则出现两次。整层是 P1——写一章正文时，本章细纲、上一章结尾
 * 与文风比架构的全文要紧，放不下时让它先让。
 */
export const premiseWorld: LayerFn = async (a, spec) => {
  await admitSettingDocs(a, spec, { config: [GUIDANCE_KEY] });
};

/** 「全局要求」那一节的小节名。 */
const GUIDANCE_KEY = '全局要求';

async function admitSettingDocs(a: Assembly, spec: LayerSpec, omit: Partial<Record<SettingFileDoc, string[]>> = {}): Promise<void> {
  for (const doc of SETTING_FILE_DOCS) {
    const parsed = await a.project.readSettingDoc(doc);
    const keys = SETTING_SECTION_KEYS[doc].filter((k) => !(omit[doc] ?? []).includes(k));
    const body = stringifySections(parsed.sections, keys);
    if (!body.trim()) {
      continue;
    }
    a.admit(
      {
        id: `setting:${doc}`,
        kind: 'setting',
        priority: spec.priority,
        label: SETTING_DOC_HEADING[doc],
        source: parsed.relPath,
        text: `【${SETTING_DOC_HEADING[doc]}】\n${body}`,
        note: omit[doc]?.length ? `不含${omit[doc]!.map((k) => `「${k}」`).join('')}（单独带）` : undefined,
      },
      { force: spec.force }
    );
  }
}

/**
 * 小说配置里的「全局要求」：跨章有效的写作规则（「不写上帝视角」「每章结尾留一个未决的问题」）。
 *
 * 上游每一章正文都带它（`next_chapter_draft` 的 `global_guidance`，PT:827），而且是作者
 * 定下的规矩——写正文时强制带、单独成段，不和架构的其余几节一起排队。
 */
export const guidance: LayerFn = async (a, spec) => {
  const parsed = await a.project.readSettingDoc('config');
  const text = parsed.sections[GUIDANCE_KEY]?.trim() ?? '';
  if (!hasContent(text)) {
    return;
  }
  a.admit(
    {
      id: 'guidance',
      kind: 'guidance',
      priority: spec.priority,
      label: '全局要求',
      source: parsed.relPath,
      text,
    },
    { force: spec.force }
  );
};

/**
 * 角色图谱一览：全部角色卡压成一人一段（名字、定位、身份、人物关系、当前状态）。
 *
 * 架构的后几件、大纲、细纲批次都要知道「这本书里有谁、彼此什么关系」，但用不着每个人的
 * 外貌与语言习惯——那是写正文时的事（正文层带的是完整角色卡）。每段截短写在明细里。
 */
export const rosterDoc: LayerFn = async (a, spec) => {
  const cards = await a.project.listCharacters();
  if (cards.length === 0) {
    return;
  }
  a.admit(
    {
      id: 'roster',
      kind: 'setting',
      priority: spec.priority,
      label: `角色图谱（${cards.length} 人）`,
      source: a.project.relPath(a.project.charactersDir),
      text: `【角色图谱】\n${cards.map(renderRosterLine).join('\n')}`,
      note: '每人只取身份、人物关系、当前状态的开头；完整角色卡在正文层才带',
    },
    { force: spec.force }
  );
};

/**
 * 故事结构指导：按总章数算好的章号区间（model/structureGuide.ts）。
 *
 * 大纲层要它排结构拐点；细纲层要它知道这一批落在结构的哪一段。没写总章数就算不出
 * 区间——不带，并在明细里说清是为什么。
 */
export const structure: LayerFn = async (a, spec) => {
  const total = a.request.setup?.totalChapters ?? a.book.totalChapters;
  const base = {
    id: 'structure',
    kind: 'guide' as const,
    priority: spec.priority,
    label: `故事结构指导 · ${PLOT_STRUCTURE_LABEL[a.book.structure ?? 'three_act']}`,
    source: a.book.relPath || undefined,
  };
  if (!total) {
    a.reject({ ...base, text: '' }, 'dropped', '小说配置里没写总章数，算不出章号区间');
    return;
  }
  a.admit({ ...base, text: structureGuideText(a.book.structure, total, a.request.range) }, { force: spec.force });
};

/**
 * 前序细纲一览：一章一行的目录进度（上游 `chapter_blueprint_chunk` 的 chapter_list）。
 *
 * - **单章**时，紧挨着的前几章由 `plotPrev` 详细带，这里只列更早的那些；
 * - **批次**时 `plotPrev` 不出场，这里全包：更早的一章一行，最后几章带上看点（爽点与章末
 *   吊着读者的东西）——下一批要紧接着它们往下排。生成链里刚排好、还没落盘的那几章（`draftPlots`，
 *   拆半重试时的前一半）接在最后。
 * - 最多 `plotListMax` 章，更早的看全文大纲（明细里说清它写到哪）；预算不够时从最老的丢起，不整份丢
 *   （第 4 级不封顶，几百章的书照样带得出最近那一截）。
 */
export const plotList: LayerFn = async (a, spec) => {
  const batch = !!a.request.range;
  const skip = new Set(batch ? [] : a.focus.prevPlots.map((c) => c.no));
  const disk = a.focus.previous
    .filter((c) => c.plot && isPlotFilled(c.plot.sections) && !skip.has(c.no))
    .map((c) => ({
      no: c.no,
      title: c.plot!.title || c.title,
      keyEvents: c.plot!.sections.关键事件,
      highlights: c.plot!.sections.看点,
      draft: false,
    }));
  const drafts = (a.request.draftPlots ?? []).map((d) => ({ ...d, draft: true }));
  const all = [...disk, ...drafts];
  const rows = takeLast(all, a.limits.plotListMax);
  if (rows.length === 0) {
    return;
  }
  const detailedFrom = batch ? rows.length - PLOT_LIST_DETAILED : rows.length;
  // 关键事件、看点都是一条一行的列表：一章一行时条与条之间用「；」接。
  const lines = rows.map((r, i) => {
    const head = `第${r.no}章 ${r.title || '（未命名）'}${r.draft ? '（刚排好，还没写入文件）' : ''}`;
    const events = sectionLine(r.keyEvents);
    const highlights = sectionLine(r.highlights);
    return i >= detailedFrom
      ? `${head}：${clipLine(events, 400)}${highlights ? `｜看点：${clipLine(highlights, 120)}` : ''}`
      : `${head}：${clipLine(events, 120)}`;
  });
  // 由近及远放到预算用完为止；强制带时整份带。
  let kept = rows.length;
  if (!spec.force) {
    let room = a.remaining;
    kept = 0;
    while (kept < lines.length) {
      const cost = estimateTokens(`${lines[lines.length - 1 - kept]}\n`);
      if (cost > room) {
        break;
      }
      room -= cost;
      kept++;
    }
  }
  // 一行都放不下：整份交给 admit 判 dropped，写明需要多少、剩多少。
  const trimmed = kept > 0 && kept < rows.length;
  const shown = trimmed ? rows.slice(rows.length - kept) : rows;
  const folded = all.slice(0, all.length - rows.length).map((r) => r.no);
  const notes = [
    folded.length > 0
      ? await foldedNote(a, `只带最近 ${a.limits.plotListMax} 章（上下文详细度「${CONTEXT_DETAIL_LABEL[a.detail]}」）`, folded)
      : '',
    trimmed ? `预算不足，${spansOf(rows.slice(0, rows.length - kept).map((r) => r.no))}没带` : '',
  ].filter(Boolean);
  const item = {
    id: 'plotList',
    kind: 'plotList' as const,
    priority: spec.priority,
    label: `前序细纲一览（${shown.length} 章）`,
    text: lines.slice(lines.length - shown.length).join('\n'),
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
  if (trimmed && !a.excluded.has(item.id)) {
    a.accept({ ...item, status: 'degraded' }, estimateTokens(item.text));
    return;
  }
  a.admit(item, { force: spec.force });
};

export const plotSelf: LayerFn = async (a, spec) => {
  const plot = a.focus.plot;
  // 批次（给了区间）没有「本章」：区间第一章那份多半是个空壳，带上只会让模型以为只写它。
  if (!plot || a.request.range) {
    return;
  }
  a.admit(
    {
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 细纲`,
      source: plot.relPath,
      text: renderPlot(plot),
    },
    { force: spec.force }
  );
};

/**
 * 前几章的细纲（上文）。
 *
 * 带梗概、关键事件与状态变更（`renderPlotBrief`）：梗概说「林昭进了宗门」，关键事件说「他是靠
 * 那半枚令牌被破例放进去的」，状态变更说他此刻落在什么处境——接着往下排的人三样都要。
 * 更早的章由前序细纲一览一章一行带。
 *
 * `focus.prevPlots` 已经滤掉没有细纲的章（老工程里那些），所以这里的
 * `c.plot` 一定在。
 *
 * 写正文时（2026-10-21）这是唯一带的前几章细纲：更早几十章的细纲不再带。条目记成 `plotSummary`，
 * 在「前几章细纲」单列一节——和本章细纲混在「细纲」一节里，模型分不清哪份是这一章要写的。还没定稿的
 * 块头标「计划」（模型才不会把计划当成已经发生的事）；定稿之后正文又改过的在明细里打 ⚠。
 */
export const plotPrev: LayerFn = async (a, spec) => {
  // 批次时由前序细纲一览全包（见 `plotList`）。
  if (a.request.range) {
    return;
  }
  const writing = a.request.action.stage === 'manuscript';
  for (const { plot, chapter } of a.focus.prevPlots) {
    if (!plot) {
      continue;
    }
    const planned = writing && !plot.sourceHash;
    // 定稿的上游是正文，直接比它的 hash——不必再读一遍正文。
    const drifted = writing && !!plot.sourceHash && !!chapter && plot.sourceHash !== chapter.contentHash;
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: writing ? 'plotSummary' : 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 细纲（上文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '上文', planned ? '计划' : undefined),
      note: planned ? '还没同步：带的是写之前的计划' : drifted ? '⚠ 同步之后正文又改过，这份细纲可能没跟上' : undefined,
    });
  }
};

/**
 * 后一章的细纲（下文）。
 *
 * 只在它已经排过的时候才有——多数时候是在往后写，这一层就是空的。但改中间
 * 某一章时它是关键：不知道后面已经定了什么，模型会把收尾写到一个下一章接不上
 * 的局面，读起来就是「转折突兀」。
 */
export const plotNext: LayerFn = async (a, spec) => {
  for (const { plot } of a.focus.nextPlots) {
    if (!plot) {
      continue;
    }
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 细纲（下文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '下文'),
    });
  }
};

/** 边界里每一章的关键事件截到多长：够看出「那一章要发生什么」，又不至于把它写成第二份细纲。 */
const AHEAD_EVENT_CHARS = 300;

/**
 * 后 5 章的细纲，一章一行：写正文时的**边界**。移植自 AI-Novel-Writer 的「后续章节大纲
 * 预告（仅供了解后续剧情发力点，请绝对不要在本章提前写出后续内容！）」（PT:744、816；
 * 取数 GD:456-474）。
 *
 * 不带它，模型写到这一章的钩子时手上没有「后面要发生什么」，最顺手的做法就是把下一章
 * 的事提前演掉——下一章于是无事可写。P0：这一层管的是整条流水线的节奏，不是锦上添花。
 *
 * 只带排过细纲的章（空壳里没有可当边界的事），按章号窗口取（focus.ts 的 `AHEAD_PLOTS`）。
 */
export const plotAhead: LayerFn = async (a, spec) => {
  const ahead = a.focus.aheadPlots;
  if (ahead.length === 0) {
    return;
  }
  const lines = ahead.map(({ no, plot }) => {
    const title = plot!.title ? ` ${plot!.title}` : '';
    return `第${no}章${title}：${clipLine(sectionLine(plot!.sections.关键事件), AHEAD_EVENT_CHARS)}`;
  });
  const first = ahead[0].no;
  const last = ahead[ahead.length - 1].no;
  a.admit(
    {
      id: `plotAhead:${first}-${last}`,
      kind: 'boundary',
      priority: spec.priority,
      label: `后续章节细纲 · ${span(first, last)}（边界）`,
      text: lines.join('\n'),
      note: '只为让模型知道后面要发生什么、不在本章提前写掉',
    },
    { force: spec.force }
  );
};
