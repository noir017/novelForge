const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mod = () => loadModule('src/core/features/stylePrompt.ts');

describe('stylePrompt.ts · 截断检查', () => {
  test('写法技能写到一半：报出缺的小节', () => {
    const { missingSections, REFERENCE_SKILL_SYSTEM } = mod();
    const half = '## 章节结构\n\n- 一章两到三个场景。\n- **结尾停靠**：\n  1. 视觉峰值\n  2. 规则';
    assert.deepEqual(missingSections(REFERENCE_SKILL_SYSTEM, half), [
      '场景推进',
      '钩子与悬念',
      '节奏与爽点',
      '信息投放',
      '开篇写法',
      '规划时怎么用',
    ]);
  });

  test('七节齐全的文风指南放行，标题前后的空白不算数', () => {
    const { assertComplete, missingSections, STYLE_SYSTEM } = mod();
    const heads = ['叙事视角', '句式节奏', '遣词特征', '对白风格', '描写偏好', '修辞习惯', '禁用清单'];
    const full = heads.map((h) => `## ${h} \n内容`).join('\n\n');
    assert.deepEqual(missingSections(STYLE_SYSTEM, full), []);
    assert.doesNotThrow(() => assertComplete(STYLE_SYSTEM, full, 'end', 8000));
    assert.doesNotThrow(() => assertComplete(STYLE_SYSTEM, full, undefined, 8000));
  });

  test('上游报撞上限：小节齐全也不放行', () => {
    const { assertComplete, STYLE_SYSTEM } = mod();
    const heads = ['叙事视角', '句式节奏', '遣词特征', '对白风格', '描写偏好', '修辞习惯', '禁用清单'];
    const full = heads.map((h) => `## ${h}\n内容`).join('\n\n');
    assert.throws(() => assertComplete(STYLE_SYSTEM, full, 'maxTokens', 8000), /输出上限（8000 token）/);
  });

  test('网关不报收尾原因：靠缺小节拦下', () => {
    const { assertComplete, STYLE_SYSTEM } = mod();
    assert.throws(() => assertComplete(STYLE_SYSTEM, '## 叙事视角\n第三人称', undefined, 8000), /缺了「句式节奏」/);
  });
});
