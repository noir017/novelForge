import type { BuiltinSkill } from './types';
import { AI_TONE_KEEP, AI_TONE_RULES } from './aiTone';

/**
 * 去 AI 味（修稿）：修稿合同只许改清单指到的地方，而合同排在技能之后——所以这一份只说
 * 「清单里有 AI 腔一类的审稿项时怎么改」，不写「顺手清理」。
 */
export const lessAiToneRefinement: BuiltinSkill = {
  name: 'less-ai-tone-refinement',
  raw: [
    '---',
    'name: less-ai-tone-refinement',
    'display_name: 去 AI 味（修稿）',
    'description: 修稿时，清单里有「AI 腔」或模板化表达一类的审稿项，按实测句式清单最小改动地改，信息不增不减。',
    'version: 1.0.0',
    'stage: refinement',
    '---',
    '审稿清单里有「AI 腔」、模板化、套话一类的问题时，按下面的句式清单和改法修。清单没指到的句子照旧一字不改。',
    '',
    '【句式与改法】',
    ...AI_TONE_RULES,
    '',
    '【改的分寸】',
    '- 只改解决该问题所必需的部分，不顺手润色相邻的句子。同一句命中几类时，先处理揭底句，改完重看，已经不命中的就不再叠加改。',
    '- 信息守恒：不新增人物、动作、数值、对白、心理活动、因果；改写后每个实词都要能在原句里找到出处。不删情节事实、伏笔和情绪的内容——删的是「一丝」「一股」「一种」这层壳，不是「贪婪」「恼怒」本身。',
    '- 引号里的对白不改。',
    `- 不许碰的：${AI_TONE_KEEP}也不要为了「像人写的」补虚词、补对白、拆段落——那等于新增内容。`,
    '',
  ].join('\n'),
};
