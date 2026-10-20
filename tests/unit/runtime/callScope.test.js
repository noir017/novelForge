/**
 * 「这一次」（runtime/callScope.ts）：作者在调模型之前的确认框上挑的模型与上下文详细度，怎么落到 `readConfig()` 与模型池上
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 作用域外照设置 | 选择只管这一次，不写回设置 |
 * | 作用域里 `readConfig()` 换了详细度、多了 `pinnedModel` | `readConfig()` 是作者的选择唯一的落点 |
 * | 钉了模型：池里只有它、失败不换人、预算用它的窗口 | 选了谁就是谁（与对话页同一条规矩）；切批用干活那个模型的窗口（第 13 条） |
 * | 嵌套：模型整项替换，详细度没问就沿用外面那一次 | 里面选「按分档」就是不钉，哪怕外面钉了 |
 * | 同时跑的两次各是各的 | `AsyncLocalStorage` 按调用链分，批量写章跑着时对话页另起一次不串 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');

let bundle;
let fake;
const behavior = {};

const SETTINGS = {
  providers: [
    {
      id: 'p',
      kind: 'vscode-lm',
      models: [
        { name: 'a', contextWindow: 100000 },
        { name: 'b', contextWindow: 32000 },
        { name: 'c', contextWindow: 64000 },
      ],
    },
  ],
  models: ['p/a'],
  tierModels: { balanced: ['p/a', 'p/c'] },
  contextDetail: 3,
};

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    config: './src/core/config.ts',
    pool: './src/core/llm/pool.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    collect: './src/core/llm/collect.ts',
    scope: './src/core/runtime/callScope.ts',
  });
  bundle.host.initHost(makeFakeHost({ supportsVscodeLm: true, settings: () => SETTINGS }).host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    reply: (messages) => `ok:${messages.ref}`,
  });
});

const readConfig = () => bundle.config.readConfig();
const withCallChoice = (choice, fn) => bundle.scope.withCallChoice(choice, fn);

describe('作用域外', () => {
  test('照设置：详细度 3，不钉模型', () => {
    const c = readConfig();
    assert.equal(c.contextDetail, 3);
    assert.equal(c.pinnedModel, undefined);
    assert.equal(bundle.scope.currentCallChoice(), undefined);
  });
});

describe('作用域里', () => {
  test('readConfig 换了详细度、钉了模型；对话页那个模型不动', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 1 }, async () => readConfig());
    assert.equal(c.contextDetail, 1);
    assert.equal(c.pinnedModel, 'p/b');
    assert.equal(c.model, 'p/a');
  });

  test('出了作用域就回到设置', async () => {
    await withCallChoice({ contextDetail: 1 }, async () => {});
    assert.equal(readConfig().contextDetail, 3);
  });

  test('钉了模型：池里只有它，标「这一次指定」，预算是它的窗口', async () => {
    const pool = await withCallChoice({ model: 'p/b' }, () => bundle.pool.createModelPool({ task: 'manuscript' }));
    assert.deepEqual(pool.refs, ['p/b']);
    assert.ok(pool.label.includes('这一次指定'), pool.label);
    assert.equal(pool.tier, 'balanced');
    assert.equal(pool.primaryBudget.contextWindow, 32000);
    assert.equal(bundle.pool.budgetForTask('manuscript').contextWindow, 100000);
    const pinned = await withCallChoice({ model: 'p/b' }, async () => bundle.pool.budgetForTask('manuscript'));
    assert.equal(pinned.contextWindow, 32000);
  });

  test('钉了模型：失败不换同档其余模型', async () => {
    for (const k of Object.keys(behavior)) delete behavior[k];
    behavior['p/b'] = 'fail';
    fake.reset();
    await withCallChoice({ model: 'p/b' }, async () => {
      const pool = await bundle.pool.createModelPool({ task: 'manuscript' });
      await assert.rejects(pool.run('第 1 章', (llm) => bundle.collect.collectText(llm.stream([], {}))));
    });
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/b']);
    delete behavior['p/b'];
  });
});

describe('嵌套', () => {
  test('里面选「按分档」：不钉了；详细度没问就沿用外面', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 2 }, () => withCallChoice({}, async () => readConfig()));
    assert.equal(c.pinnedModel, undefined);
    assert.equal(c.contextDetail, 2);
  });

  test('里面另挑了：里面的优先', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 2 }, () =>
      withCallChoice({ model: 'p/c', contextDetail: 4 }, async () => readConfig())
    );
    assert.equal(c.pinnedModel, 'p/c');
    assert.equal(c.contextDetail, 4);
  });
});

describe('同时跑的两次', () => {
  test('各是各的，中间的 await 不串', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const seen = (choice) =>
      withCallChoice(choice, async () => {
        const out = [];
        for (let i = 0; i < 3; i++) {
          await tick();
          out.push(`${readConfig().pinnedModel}/${readConfig().contextDetail}`);
        }
        return out;
      });
    const [x, y] = await Promise.all([seen({ model: 'p/b', contextDetail: 1 }), seen({ model: 'p/c', contextDetail: 4 })]);
    assert.deepEqual(x, ['p/b/1', 'p/b/1', 'p/b/1']);
    assert.deepEqual(y, ['p/c/4', 'p/c/4', 'p/c/4']);
  });
});
