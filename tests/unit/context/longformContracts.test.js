/**
 * 百章实验复盘写进提示词的几条约束：大纲每节限 5 章、终局级事件只发生一次、境界写明；细纲以既成事实为准；
 * 摘要记境界变化与毁掉的东西；正文以定稿事实为准。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/context/prompts.ts');
const sp = loadModule('src/core/features/summarizePrompt.ts');

describe('长篇约束 · 提示词', () => {
  test('大纲：每节最多 5 章、终局级事件只发生一次、每节写明境界', () => {
    const c = p.buildOutputContract({ stage: 'outline', capability: 'generate' }, { range: { from: 1, to: 20 } });
    assert.match(c, /每一节最多覆盖 5 章/);
    assert.match(c, /终局级事件.*全书只发生一次/);
    assert.match(c, /每节末尾写明主角此时的境界/);
  });

  test('细纲（非开篇）：前面定稿的事实是既成历史，终局级事件不再排', () => {
    const c = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 6, to: 10 } });
    assert.match(c, /既成历史/);
    assert.match(c, /不得再排一次/);
    const first = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 1, to: 5 } });
    assert.doesNotMatch(first, /既成历史/);
  });

  test('摘要：境界变化、毁掉的东西都记进连续性事实', () => {
    assert.match(sp.SUMMARY_SYSTEM, /境界、等级或能力在本章有变化/);
    assert.match(sp.SUMMARY_SYSTEM, /已经毁掉的地方、阵法、法宝也要记/);
  });
});
