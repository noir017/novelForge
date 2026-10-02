/**
 * 内置技能：随应用发布，不可删除，**不自动绑定**（与上游一样——绑不绑由作者定）。
 *
 * 只搬了上游七个内置里真给生成用的两个（AI-Novel-Writer `skill-registry.ts:398-432`，
 * 中文正文照抄 `localizedContent['zh-CN']`）。其余五个（章节审阅、脑暴、角色分析、连续性检查、
 * 写作教练）是上游 AI 助手对话用的，正文让模型去调它自己的 `read_drafts` 一类工具、按星级表格
 * 作答——放进这里的生成链只会让模型以为自己能调一个不存在的工具。
 *
 * 写成整份 `SKILL.md` 文本而不是拆好的字段：内置与用户、工程技能走同一个解析器，兼容检查与
 * 字节数也是按真正注入的那份算的（上游内置的兼容性是拿一份短的替身算的）。
 */
export interface BuiltinSkill {
  /** 也是 id 里的名字：`builtin:<name>`。 */
  name: string;
  raw: string;
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
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
  },
  {
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
  },
];
