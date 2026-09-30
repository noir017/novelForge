import { plotLabel } from '../../model/pipeline';
import { parseOutlineRanges } from '../../model/outlineFile';
import { isPlotFilled } from '../../model/plotFile';
import {
  PLOT_STRUCTURE_LABEL,
  SETTING_DOC_HEADING,
  SETTING_FILE_DOCS,
  SETTING_SECTION_KEYS,
} from '../../model/settingFile';
import { structureGuideText } from '../../model/structureGuide';
import { stringifySections } from '../../model/markdown';
import type { LayerFn } from './assembly';
import { clipLine, isPlaceholder, renderPlot, renderPlotBrief, renderRosterLine } from './render';

/** 前序细纲一览最多带几章（上游 `chapter_blueprint_chunk` 的「最近 100 章」）。 */
export const PLOT_LIST_MAX = 100;

/** 批次模式下，一览里最后几章写得详细些（带章末钩子）——下一批要紧接着它们往下排。 */
const PLOT_LIST_DETAILED = 3;

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

export const outlineDoc: LayerFn = async (a, spec) => {
  const outline = await a.project.readOutline();
  if (!outline.trim() || isPlaceholder(outline)) {
    return;
  }
  a.admit(
    {
      id: 'outlineDoc',
      kind: 'outlineDoc',
      priority: spec.priority,
      label: '情节大纲',
      source: a.project.relPath(a.project.outlinePath),
      text: outline,
    },
    { force: spec.force }
  );
};

/**
 * 架构层的三份文档（小说配置 / 故事前提 / 世界观），填过的才带。
 *
 * 一件一条：作者在明细里能单独取消某一件（比如重写前提时不想让旧前提带偏模型）。
 * 正在生成的那一件也照带——目标已有内容时再生成，那一版就是修改的底稿。
 */
export const settingDocs: LayerFn = async (a, spec) => {
  for (const doc of SETTING_FILE_DOCS) {
    const parsed = await a.project.readSettingDoc(doc);
    const body = stringifySections(parsed.sections, SETTING_SECTION_KEYS[doc]);
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
      },
      { force: spec.force }
    );
  }
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
 * 情节大纲里覆盖本章 / 本批的那几节。
 *
 * 排第 6–10 章的细纲用不着第 60 章的大纲——整份塞进去既占预算，又会让模型提前把后面
 * 的事写掉。大纲没有区间标题（老工程、散文式大纲）或者没覆盖到这几章时退回全文，
 * 并在明细里说一句（第 2 条）。
 */
export const outlineSlice: LayerFn = async (a, spec) => {
  const outline = await a.project.readOutline();
  if (!outline.trim() || isPlaceholder(outline)) {
    return;
  }
  const no = a.focus.no;
  const range = a.request.range ?? (Number.isFinite(no) ? { from: no, to: no } : undefined);
  const source = a.project.relPath(a.project.outlinePath);
  const slices = range ? parseOutlineRanges(outline).filter((r) => r.from <= range.to && r.to >= range.from) : [];
  if (!range || slices.length === 0) {
    a.admit(
      {
        id: 'outlineDoc',
        kind: 'outlineDoc',
        priority: spec.priority,
        label: '情节大纲',
        source,
        text: outline,
        note: range ? `大纲里没有覆盖${span(range.from, range.to)}的区间节，带了全文` : undefined,
      },
      { force: spec.force }
    );
    return;
  }
  const text = slices
    .map((s) => `## ${s.from === s.to ? `第${s.from}章` : `第${s.from}–${s.to}章`}${s.title ? `：${s.title}` : ''}\n${s.text}`)
    .join('\n\n');
  a.admit(
    {
      id: `outlineSlice:${range.from}-${range.to}`,
      kind: 'outlineDoc',
      priority: spec.priority,
      label: `情节大纲 · 覆盖${span(range.from, range.to)}的 ${slices.length} 节`,
      source,
      text,
      note: '只带覆盖这几章的区间节，其余章节的大纲不带',
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
 * - **批次**时 `plotPrev` 不出场，这里全包：更早的一章一行，最后几章带上章末钩子——
 *   下一批要紧接着它们往下排。生成链里刚排好、还没落盘的那几章（`draftPlots`，
 *   拆半重试时的前一半）接在最后。
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
      suspenseHook: c.plot!.sections.章末钩子,
      draft: false,
    }));
  const drafts = (a.request.draftPlots ?? []).map((d) => ({ ...d, draft: true }));
  const rows = [...disk, ...drafts].slice(-PLOT_LIST_MAX);
  if (rows.length === 0) {
    return;
  }
  const detailedFrom = batch ? rows.length - PLOT_LIST_DETAILED : rows.length;
  const lines = rows.map((r, i) => {
    const head = `第${r.no}章 ${r.title || '（未命名）'}${r.draft ? '（刚排好，还没写入文件）' : ''}`;
    return i >= detailedFrom
      ? `${head}：${clipLine(r.keyEvents, 400)}｜章末钩子：${clipLine(r.suspenseHook, 120)}`
      : `${head}：${clipLine(r.keyEvents, 120)}`;
  });
  a.admit(
    {
      id: 'plotList',
      kind: 'plotList',
      priority: spec.priority,
      label: `前序细纲一览（${rows.length} 章）`,
      text: lines.join('\n'),
      note: disk.length + drafts.length > rows.length ? `只带最近 ${PLOT_LIST_MAX} 章` : undefined,
    },
    { force: spec.force }
  );
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
 * 带**细纲**而不是摘要：摘要说「林昭进了宗门」，细纲说「他是靠那半枚令牌被破例
 * 放进去的，章末留了一句令牌来路的疑问」——接着往下排的人要的是后者。
 * 更早的章才降级成摘要（`plotSummary` 层）。
 *
 * `focus.prevPlots` 已经滤掉没有细纲的章（老工程里那些），所以这里的
 * `c.plot` 一定在。
 */
export const plotPrev: LayerFn = async (a, spec) => {
  // 批次时由前序细纲一览全包（见 `plotList`）。
  if (a.request.range) {
    return;
  }
  for (const { plot } of a.focus.prevPlots) {
    if (!plot) {
      continue;
    }
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 细纲（上文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '上文'),
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
