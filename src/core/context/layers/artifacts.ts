import { plotLabel, volumeLabel } from '../../model/pipeline';
import type { LayerFn } from './assembly';
import {
  isPlaceholder,
  renderPlot,
  renderPlotBrief,
  renderSegmentBrief,
  renderVolume,
  renderVolumeBrief,
} from './render';

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
      label: '全书大纲',
      source: a.project.relPath(a.project.outlinePath),
      text: outline,
    },
    { force: spec.force }
  );
};

/**
 * 全书分卷一览。拆卷时它是「已经有哪些卷」，拆段时是「我这一卷排第几」。
 *
 * 一卷一行，整本书十几行——比把每卷的走向都铺开便宜两个数量级，而这一层要的
 * 只是位置感。
 */
export const volumeList: LayerFn = async (a, spec) => {
  if (a.focus.volumes.length === 0) {
    return;
  }
  a.admit(
    {
      id: 'volumeList',
      kind: 'volume',
      priority: spec.priority,
      label: `分卷一览（${a.focus.volumes.length} 卷）`,
      text: `【全书分卷】\n${a.focus.volumes.map(renderVolumeBrief).join('\n')}`,
    },
    { force: spec.force }
  );
};

/** 目标那一卷的卷纲原文。从这一卷拆剧情段时的主要依据。 */
export const volumeSelf: LayerFn = async (a, spec) => {
  const volume = a.focus.volume;
  if (!volume) {
    return;
  }
  a.admit(
    {
      id: `volume:${volume.relPath}`,
      kind: 'volume',
      priority: spec.priority,
      label: `${volumeLabel(volume.no, volume.title)} · 卷纲`,
      source: volume.relPath,
      text: renderVolume(volume),
    },
    { force: spec.force }
  );
};

/**
 * 这一卷已经拆出来、还没交付的剧情段（每段一行目标）。
 *
 * 少了它，「再拆一段」会把已经排过的那几段重新发明一遍——那是「一次只拆一段」
 * 这条设计能不能成立的前提。
 */
export const volumeSegments: LayerFn = async (a, spec) => {
  const segments = a.focus.volumeSegments;
  if (segments.length === 0) {
    return;
  }
  a.admit(
    {
      id: 'volumeSegments',
      kind: 'volume',
      priority: spec.priority,
      label: `本卷已排的剧情段（${segments.length} 段）`,
      text:
        '【本卷已经排到这里】\n' +
        segments.map(({ plot, displayNo }) => renderSegmentBrief(plot, displayNo)).join('\n'),
    },
    { force: spec.force }
  );
};

export const plotSelf: LayerFn = async (a, spec) => {
  const plot = a.focus.plot;
  if (!plot) {
    return;
  }
  a.admit(
    {
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 剧情`,
      source: plot.relPath,
      text: renderPlot(plot),
    },
    { force: spec.force }
  );
};

/**
 * 前几章的细纲原文（上文）。
 *
 * 带**原文**而不是摘要：摘要说「林昭进了宗门」，原文说「他是靠那半枚令牌
 * 被破例放进去的，代价是必须说出令牌的来路」——接着往下写的人要的是后者。
 * 更早的章才降级成摘要（`plotSummary` 层）。
 *
 * `focus.prevPlots` 已经滤掉没有细纲的章（老工程里那些），所以这里的
 * `c.plot` 一定在。
 */
export const plotPrev: LayerFn = async (a, spec) => {
  for (const { plot } of a.focus.prevPlots) {
    if (!plot) {
      continue;
    }
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 剧情（上文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '上文'),
    });
  }
};

/**
 * 后一章的细纲原文（下文）。
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
      label: `${plotLabel(plot.no, plot.title)} · 剧情（下文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '下文'),
    });
  }
};
