import type { BuiltinSkill } from './types';
import { AI_TONE_KEEP, AI_TONE_RULES } from './aiTone';

/** 去 AI 味（审稿）：成密度的才报成审稿项，作者勾了，修稿那份才动它。 */
export const lessAiToneReview: BuiltinSkill = {
  name: 'less-ai-tone-review',
  raw: [
    '---',
    'name: less-ai-tone-review',
    'display_name: 去 AI 味（审稿）',
    'description: 审稿时把叙述里实测 AI 才高频的句式报成「AI 腔」审稿项，每项引一句原文、说明命中哪一类和怎么改。',
    'version: 1.0.0',
    'stage: review',
    '---',
    '审稿时另外检查叙述里的 AI 腔。下面这些句式是拿 AI 正文和人类网文逐条对照、按每千字统计出来的：AI 用得是人类的 3～31 倍。人类也会偶尔写一两处，问题在密度——一章三千字里同一类出现两三次以上，或几类扎堆在同一段，才值得报。',
    '',
    '【检查清单】',
    ...AI_TONE_RULES,
    '',
    '【怎么报】',
    '- category 写「AI 腔」，severity 用 warning；quote 引命中的那一句原文，description 写命中第几类、这一类在本章大约出现几次，以及这一句的改法（只改句式，不加情节）。',
    '- 只挑最典型、最密的几处，AI 腔合计不超过 3 项，不要挤掉剧情、连贯性、角色这些更要紧的问题。本章 AI 腔不明显就不报，也不要为它凑一条 pass。',
    '- 引号里的对白不算：人物说话可以用任何句式。',
    `- 不许报的：${AI_TONE_KEEP}`,
    '',
  ].join('\n'),
};
