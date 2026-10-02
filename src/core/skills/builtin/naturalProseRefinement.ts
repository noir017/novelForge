import type { BuiltinSkill } from './types';

/**
 * 自然语言润色。上游 AI-Novel-Writer `skill-registry.ts:398-432`，中文正文照抄
 * `localizedContent['zh-CN']`。
 */
export const naturalProseRefinement: BuiltinSkill = {
  name: 'natural-prose-refinement',
  raw: [
    '---',
    'name: natural-prose-refinement',
    'display_name: 自然语言润色',
    'description: 在修稿阶段减少模板化表达，让动作、感官和句式服务于人物与场景。',
    'version: 1.0.0',
    'stage: refinement',
    '---',
    '在不改变作者事实和情节结果的前提下润色正文。用有选择的具体动作替代空泛概述，调整句式节奏，保持视角人物的语言质感，并删除元话术和重复的过渡表达。',
    '',
  ].join('\n'),
};
