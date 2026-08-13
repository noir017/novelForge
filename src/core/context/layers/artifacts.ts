import { describeScene } from '../../model/sceneFile';
import type { LayerFn } from './assembly';
import {
  chapterLabel,
  isPlaceholder,
  renderPlan,
  renderScene,
  renderSceneBrief,
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

export const planSelf: LayerFn = async (a, spec) => {
  const plan = a.focus.plan;
  if (!plan) {
    return;
  }
  a.admit(
    {
      id: `plan:${plan.chapterRelPath}`,
      kind: 'plan',
      priority: spec.priority,
      label: `${chapterLabel(a.focus.chapter, plan)} · 细纲`,
      source: plan.relPath,
      text: renderPlan(plan),
    },
    { force: spec.force }
  );
};

export const planPrev: LayerFn = async (a, spec) => {
  const plan = a.focus.prevPlan;
  if (!plan) {
    return;
  }
  const prev = a.focus.previous[a.focus.previous.length - 1];
  a.admit(
    {
      id: `plan:${plan.chapterRelPath}`,
      kind: 'plan',
      priority: spec.priority,
      label: `${chapterLabel(prev, plan)} · 细纲`,
      source: plan.relPath,
      text: renderPlan(plan),
    },
    { force: spec.force }
  );
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
