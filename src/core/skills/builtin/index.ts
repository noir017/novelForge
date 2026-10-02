/**
 * 内置技能：随应用发布，不可删除，**不自动绑定**（与上游一样——绑不绑由作者定）。
 *
 * 只搬了上游七个内置里真给生成用的两个（AI-Novel-Writer `skill-registry.ts:398-432`，
 * 中文正文照抄 `localizedContent['zh-CN']`）。其余五个（章节审阅、脑暴、角色分析、连续性检查、
 * 写作教练）是上游 AI 助手对话用的，正文让模型去调它自己的 `read_drafts` 一类工具、按星级表格
 * 作答——放进这里的生成链只会让模型以为自己能调一个不存在的工具。
 *
 * 另有三份去 AI 味是这边的（写正文 / 审稿 / 修稿各一份，共用 [aiTone.ts](aiTone.ts) 的句式清单）：
 * 审稿把命中的句子报成审稿项，作者勾了，修稿才动它——修稿合同只许改清单指到的地方，修稿那份
 * 不能写成「顺手清理」。
 *
 * 写成整份 `SKILL.md` 文本而不是拆好的字段：内置与用户、工程技能走同一个解析器，兼容检查与
 * 字节数也是按真正注入的那份算的（上游内置的兼容性是拿一份短的替身算的）。
 *
 * 一份技能一个文件；这里只定顺序（`listSkills` 与设置页按这个顺序列）。
 */
import { longFormContinuity } from './longFormContinuity';
import { naturalProseRefinement } from './naturalProseRefinement';
import { lessAiTone } from './lessAiTone';
import { lessAiToneReview } from './lessAiToneReview';
import { lessAiToneRefinement } from './lessAiToneRefinement';
import type { BuiltinSkill } from './types';

export type { BuiltinSkill } from './types';

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  longFormContinuity,
  naturalProseRefinement,
  lessAiTone,
  lessAiToneReview,
  lessAiToneRefinement,
];
