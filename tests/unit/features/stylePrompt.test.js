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

describe('stylePrompt.ts · 不完整就重问', () => {
  const full = (system) =>
    system
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((h) => `${h}\n内容`)
      .join('\n\n');

  test('网关半路断流：重问一次就拿到完整的', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    const replies = [{ text: '## 叙事视角\n第三人称' }, { text: '```markdown\n' + full(STYLE_SYSTEM) + '\n```', stopReason: 'end' }];
    const retries = [];
    const text = await collectComplete(STYLE_SYSTEM, async () => replies.shift(), {
      maxOut: 8000,
      onRetry: (attempt, reason) => retries.push([attempt, reason]),
    });
    assert.equal(text, full(STYLE_SYSTEM));
    assert.equal(retries.length, 1);
    assert.match(retries[0][1], /缺了「句式节奏」/);
  });

  test('撞了输出上限：不重问，直接报错', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    let calls = 0;
    await assert.rejects(
      collectComplete(STYLE_SYSTEM, async () => (calls++, { text: '## 叙事视角', stopReason: 'maxTokens' }), { maxOut: 8000 }),
      /输出上限/
    );
    assert.equal(calls, 1);
  });

  test('一直不完整：重问用完后报错，说明问了几次', async () => {
    const { collectComplete, INCOMPLETE_RETRIES, REFERENCE_SKILL_SYSTEM } = mod();
    let calls = 0;
    await assert.rejects(
      collectComplete(REFERENCE_SKILL_SYSTEM, async () => (calls++, { text: '' }), { maxOut: 8000 }),
      new RegExp(`回答是空的.*连问 ${INCOMPLETE_RETRIES + 1} 次`)
    );
    assert.equal(calls, INCOMPLETE_RETRIES + 1);
  });

  test('已取消：不核小节，原样返回', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    const ctl = new AbortController();
    ctl.abort();
    const text = await collectComplete(STYLE_SYSTEM, async () => ({ text: '## 叙事视角' }), { maxOut: 8000, signal: ctl.signal });
    assert.equal(text, '## 叙事视角');
  });
});
