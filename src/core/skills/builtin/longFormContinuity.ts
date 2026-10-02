import type { BuiltinSkill } from './types';

/**
 * 长篇连续性与场景推进。上游 AI-Novel-Writer `skill-registry.ts:398-432`，中文正文照抄
 * `localizedContent['zh-CN']`。
 */
export const longFormContinuity: BuiltinSkill = {
  name: 'long-form-continuity',
  raw: [
    '---',
    'name: long-form-continuity',
    'display_name: 长篇连续性与场景推进',
    'description: 在规划和正文阶段守住作者事实、因果链、角色状态与伏笔进度。',
    'version: 1.0.0',
    'stage: planning',
    '---',
    '以作者已经确认的事实为最高依据。持续核对因果链、角色状态和未回收的叙事线索。每个场景围绕角色的主动选择、选择的代价，以及故事状态发生的具体变化展开。',
    '',
  ].join('\n'),
};
