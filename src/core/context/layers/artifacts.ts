import { plotLabel } from '../../model/pipeline';
import { SETTING_DOC_HEADING, SETTING_FILE_DOCS, SETTING_SECTION_KEYS } from '../../model/settingFile';
import { stringifySections } from '../../model/markdown';
import type { LayerFn } from './assembly';
import { isPlaceholder, renderPlot, renderPlotBrief } from './render';

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
