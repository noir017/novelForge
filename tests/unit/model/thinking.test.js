/**
 * 思考深度的档位表与两家的字段映射。
 *
 * 三条硬约束在这里钉住：
 * - **「不思考」是不带字段**（两家的映射都返回 undefined）——显式关掉的写法
 *   两家都只有部分模型认，而「不带」在所有模型上都合法，也正是这个功能出现
 *   之前的行为；
 * - **界面只有一个「极限」，两家的名字不同**（OpenAI 是 `xhigh`，Anthropic 是
 *   `max`）：作者选的是「想到底」，不是某家的枚举值；
 * - **手动预算必须小于输出上限且不低于 1024**，装不下就不带思考字段，而不是
 *   发一个必然 400 的请求。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let m;
before(() => {
  m = loadModule('src/core/model/thinking.ts');
});

describe('model/thinking · 档位表', () => {
  test('五档，顺序由浅到深', () => {
    assert.deepEqual(m.THINKING_DEPTHS, ['off', 'low', 'medium', 'high', 'max']);
  });

  // 第 4 条：思考 token 按输出计费，得作者主动选才开。
  test('缺省不思考', () => {
    assert.equal(m.DEFAULT_THINKING_DEPTH, 'off');
  });

  test('每一档都有说法与提示', () => {
    for (const depth of m.THINKING_DEPTHS) {
      assert.ok(m.THINKING_LABEL[depth], depth);
      assert.ok(m.THINKING_HINT[depth], depth);
    }
  });

  test('认不出的值一律回落「不思考」，不抛', () => {
    assert.equal(m.normalizeThinkingDepth('deep'), 'off');
    assert.equal(m.normalizeThinkingDepth(undefined), 'off');
    assert.equal(m.normalizeThinkingDepth(3), 'off');
    assert.equal(m.normalizeThinkingDepth('high'), 'high');
    assert.equal(m.isThinkingDepth('max'), true);
    assert.equal(m.isThinkingDepth('ultra'), false);
  });
});

describe('model/thinking · 两家的字段映射', () => {
  test('不思考时两家都不带字段', () => {
    assert.equal(m.responsesEffort('off'), undefined);
    assert.equal(m.anthropicEffort('off'), undefined);
    assert.equal(m.thinkingBudget('off', 16000), undefined);
  });

  test('低 / 中 / 深三档两家同名', () => {
    for (const depth of ['low', 'medium', 'high']) {
      assert.equal(m.responsesEffort(depth), depth);
      assert.equal(m.anthropicEffort(depth), depth);
    }
  });

  test('极限档在两家的名字不同', () => {
    assert.equal(m.responsesEffort('max'), 'xhigh');
    assert.equal(m.anthropicEffort('max'), 'max');
  });
});

describe('model/thinking · 手动预算按输出上限收紧', () => {
  test('上限够时用档位自己的预算', () => {
    assert.equal(m.thinkingBudget('low', 32000), 4096);
    assert.equal(m.thinkingBudget('medium', 32000), 10240);
  });

  // 预算必须小于 max_tokens（思考 token 算在输出上限里），留 1024 给正文。
  test('上限不够时按上限收紧', () => {
    assert.equal(m.thinkingBudget('max', 4000), 4000 - 1024);
    assert.equal(m.thinkingBudget('high', 8000), 8000 - 1024);
  });

  test('连 1024 都留不出来时不带思考字段', () => {
    assert.equal(m.thinkingBudget('max', 2047), undefined);
    assert.equal(m.thinkingBudget('low', 1024), undefined);
  });
});

describe('model/thinking · 降档', () => {
  // 上游不认某个 effort 值时退一步再试，而不是把这一轮判死。
  test('逐档往下退，到不思考为止', () => {
    assert.equal(m.downgradeDepth('max'), 'high');
    assert.equal(m.downgradeDepth('high'), 'medium');
    assert.equal(m.downgradeDepth('medium'), 'low');
    assert.equal(m.downgradeDepth('low'), 'off');
    assert.equal(m.downgradeDepth('off'), 'off');
  });
});
