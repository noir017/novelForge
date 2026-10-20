/**
 * 确认框上那两个下拉框的纯函数（model/callChoice.ts）与分档在「这一次指定了模型」时的说法（model/tiers.ts）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 前端交上来的选择容错读取：不是对象 = 没问过；认不出的那一项丢掉 | 第 1 条：读坏了不崩，退回设置 |
 * | 日志与 VS Code 模态框里那一行写清用谁、换不换人、哪一级 | 作者看得出这一次跟设置哪里不一样 |
 * | 钉了模型：清单只有它，`describeTier` / `describeTaskModels` 说「这一次指定」 | 确认框与日志的说法只从 `refsForTask` 取 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let choice;
let tiers;

before(() => {
  const bundle = loadBundle({ choice: './src/core/model/callChoice.ts', tiers: './src/core/model/tiers.ts' });
  choice = bundle.choice;
  tiers = bundle.tiers;
});

describe('normalizeCallChoice', () => {
  test('不是对象：没问过', () => {
    for (const raw of [undefined, null, true, 'p/a', 3]) {
      assert.equal(choice.normalizeCallChoice(raw), undefined, String(raw));
    }
  });

  test('空对象：问过、全照缺省（按分档、设置那一级）', () => {
    assert.deepEqual(choice.normalizeCallChoice({}), {});
  });

  test('认得出的留下，认不出的丢掉', () => {
    assert.deepEqual(choice.normalizeCallChoice({ model: ' p/a ', contextDetail: 2 }), { model: 'p/a', contextDetail: 2 });
    assert.deepEqual(choice.normalizeCallChoice({ model: '', contextDetail: 5 }), {});
    assert.deepEqual(choice.normalizeCallChoice({ model: 7, contextDetail: '2' }), {});
  });
});

describe('describeCallChoice', () => {
  test('按分档 / 只用某个模型，带上级别', () => {
    assert.equal(choice.describeCallChoice({}), '按分档');
    assert.equal(choice.describeCallChoice({ contextDetail: 1 }), '按分档 · 上下文详细度「精简」');
    assert.equal(choice.describeCallChoice({ model: 'p/b', contextDetail: 4 }), '只用 p/b（失败不换人） · 上下文详细度「完整」');
  });
});

describe('分档：这一次指定了模型', () => {
  const config = { models: ['p/a'], tierModels: { fast: [], balanced: ['p/a', 'p/c'], quality: [] }, taskTiers: {} };

  test('不钉：照档位', () => {
    const picked = tiers.refsForTask(config, 'manuscript');
    assert.deepEqual(picked, { tier: 'balanced', refs: ['p/a', 'p/c'], inherited: false, pinned: false });
  });

  test('钉了：只有它，档位照记（日志用）', () => {
    const picked = tiers.refsForTask({ ...config, pinnedModel: 'p/b' }, 'manuscript');
    assert.deepEqual(picked, { tier: 'balanced', refs: ['p/b'], inherited: false, pinned: true });
    assert.equal(tiers.describeTier(picked), '这一次指定');
    assert.equal(tiers.describeTaskModels({ ...config, pinnedModel: 'p/b' }, 'manuscript'), '批量写正文 → 这一次指定：p/b');
  });
});
