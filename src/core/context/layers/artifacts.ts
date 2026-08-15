import { describeScene } from '../../model/sceneFile';
import { plotLabel } from '../../model/pipeline';
import type { LayerFn } from './assembly';
import { isPlaceholder, renderPlot, renderPlotBrief, renderScene, renderSceneBrief } from './render';

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
 * 前几段的剧情原文（上文）。
 *
 * 带**原文**而不是摘要：摘要说「林昭进了宗门」，原文说「他是靠那半枚令牌
 * 被破例放进去的，代价是必须说出令牌的来路」——接着往下写的人要的是后者。
 * 更早的段才降级成摘要（`plotSummary` 层）。
 */
export const plotPrev: LayerFn = async (a, spec) => {
  for (const plot of a.focus.prevPlots) {
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
 * 后一段的剧情原文（下文）。
 *
 * 只在它已经排过的时候才有——多数时候是在往后写，这一层就是空的。但改中间
 * 某一段时它是关键：不知道后面已经定了什么，模型会把收尾写到一个下一段接不上
 * 的局面，读起来就是「转折突兀」。
 */
export const plotNext: LayerFn = async (a, spec) => {
  for (const plot of a.focus.nextPlots) {
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

export const sceneSelf: LayerFn = async (a, spec) => {
  const scene = a.focus.scene;
  if (!scene) {
    return;
  }
  a.admit(
    {
      id: `scene:${scene.relPath}`,
      kind: 'scene',
      priority: spec.priority,
      label: `场景 ${describeScene(scene)}`,
      source: scene.relPath,
      text: renderScene(scene),
    },
    { force: spec.force }
  );
};

export const sceneSiblings: LayerFn = async (a, spec) => {
  const self = a.focus.scene;
  const siblings = self
    ? a.focus.scenes.filter((s) => s.no === self.no - 1 || s.no === self.no + 1)
    : a.focus.scenes;
  for (const scene of siblings) {
    const relation = !self ? '' : scene.no < self.no ? '（上一场）' : '（下一场）';
    a.admit({
      id: `scene:${scene.relPath}`,
      kind: 'scene',
      priority: spec.priority,
      label: `场景 ${describeScene(scene)}${relation}`,
      source: scene.relPath,
      text: renderSceneBrief(scene, relation),
    });
  }
};
