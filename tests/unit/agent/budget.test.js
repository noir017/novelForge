/**
 * `agent/budget.ts`：三条上限 + 无进展检测。
 *
 * 无进展检测是这里最要紧的一条：**模型卡在一个读不到的路径上反复重试是最
 * 常见的烧钱方式**。判据是「连续」同工具同参数——中间隔着别的动作的重复读
 * 是正常的（先看细纲、再看场景、回头核对细纲）。
 *
 * 另有一条第 11 条的断言：日志里**只有工具名与参数键名，没有参数值**——
 * 值里可能是一段正文。
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let bundle;
let Budget;
/** warn / error 级日志。 */
let logs = [];

before(() => {
  bundle = loadBundle({
    budget: './src/core/agent/budget.ts',
    logger: './src/core/runtime/logger.ts',
  });
  Budget = bundle.budget.Budget;
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      logs.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
});

beforeEach(() => {
  logs = [];
});

describe('缺省上限', () => {
  const b = () => new Budget();

  test('20 个回合', () => {
    assert.equal(b().limits.steps, 20);
  });

  test('10 次生成', () => {
    assert.equal(b().limits.calls, 10);
  });

  test('20 万 token', () => {
    assert.equal(b().limits.tokens, 200000);
  });

  test('传部分覆盖时其余沿用缺省', () => {
    const x = new Budget({ calls: 3 });
    assert.equal(x.limits.calls, 3);
    assert.equal(x.limits.steps, 20);
  });

  test('传 0 或负数当没传（不能造出一个一步都跑不了的 agent）', () => {
    assert.equal(new Budget({ steps: 0 }).limits.steps, 20);
    assert.equal(new Budget({ calls: -1 }).limits.calls, 10);
  });
});

describe('上限：回合数', () => {
  test('没跑满时不触顶', () => {
    const x = new Budget({ steps: 3 });
    x.step();
    x.step();
    assert.equal(x.exceeded(), undefined);
  });

  test('跑满就触顶', () => {
    const x = new Budget({ steps: 3 });
    x.step();
    x.step();
    x.step();
    assert.equal(x.exceeded().what, 'steps');
  });

  test('触顶说明里写清了跑了几步、上限多少', () => {
    const x = new Budget({ steps: 2 });
    x.step();
    x.step();
    const e = x.exceeded();
    assert.ok(e.message.includes('2 个回合'), e.message);
    assert.ok(e.message.includes('上限 2'), e.message);
  });
});

describe('上限：生成次数', () => {
  test('没跑满时不触顶', () => {
    const x = new Budget({ calls: 2 });
    x.calls = 1;
    assert.equal(x.exceeded(), undefined);
  });

  test('跑满就触顶', () => {
    const x = new Budget({ calls: 2 });
    x.calls = 2;
    assert.equal(x.exceeded().what, 'calls');
  });
});

describe('上限：token', () => {
  test('累加', () => {
    const x = new Budget();
    x.addTokens(1200);
    x.addTokens(800);
    assert.equal(x.tokens, 2000);
  });

  test('负数与 NaN 不记（provider 偶尔给不出用量）', () => {
    const x = new Budget();
    x.addTokens(-5);
    x.addTokens(NaN);
    x.addTokens(undefined);
    assert.equal(x.tokens, 0);
  });

  test('跑满就触顶', () => {
    const x = new Budget({ tokens: 1000 });
    x.addTokens(1000);
    assert.equal(x.exceeded().what, 'tokens');
  });

  test('触顶说明按万位报，读得动', () => {
    const x = new Budget({ tokens: 42000 });
    x.addTokens(42000);
    assert.ok(x.exceeded().message.includes('4.2 万'), x.exceeded().message);
  });
});

describe('无进展检测', () => {
  test('第一次调用不算无进展', () => {
    const x = new Budget();
    const r = x.recordTool('read', { path: 'a.md' });
    assert.deepEqual([r.stalled, r.stop], [false, false]);
  });

  // 连续两次同工具同参数：提示它换个思路。
  test('连续第 2 次同工具同参数 → stalled', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    const r = x.recordTool('read', { path: 'a.md' });
    assert.equal(r.stalled, true);
    assert.equal(r.stop, false);
  });

  // 提示过了还来第三次：直接停。这是最常见的烧钱方式。
  test('连续第 3 次 → stop', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    x.recordTool('read', { path: 'a.md' });
    const r = x.recordTool('read', { path: 'a.md' });
    assert.equal(r.stop, true);
    assert.equal(r.repeats, 3);
  });

  test('换参数就不算重复', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    const r = x.recordTool('read', { path: 'b.md' });
    assert.equal(r.stalled, false);
  });

  test('换工具就不算重复', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    const r = x.recordTool('list', { path: 'a.md' });
    assert.equal(r.stalled, false);
  });

  // 先看细纲、再看场景、回头核对细纲——这是正常的工作方式，不该被拦。
  test('中间隔了别的动作就不算连续', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    x.recordTool('read', { path: 'b.md' });
    const r = x.recordTool('read', { path: 'a.md' });
    assert.equal(r.stalled, false, JSON.stringify(r));
  });

  // 模型两次填的键序未必一样，那仍然是同一次调用。
  test('键序不同但内容相同算重复', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md', limit: 10 });
    const r = x.recordTool('read', { limit: 10, path: 'a.md' });
    assert.equal(r.stalled, true, JSON.stringify(r));
  });

  test('undefined 的可选参数不影响指纹', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    const r = x.recordTool('read', { path: 'a.md', offset: undefined });
    assert.equal(r.stalled, true, JSON.stringify(r));
  });

  test('循环引用的参数不抛', () => {
    const x = new Budget();
    const loop = { path: 'a.md' };
    loop.self = loop;
    assert.doesNotThrow(() => x.recordTool('read', loop));
  });

  test('给模型的提示说清了「重复调用不会有新信息」', () => {
    const x = new Budget();
    assert.ok(x.stallHint('read').includes('重复调用'), x.stallHint('read'));
  });
});

describe('日志不记参数值（第 11 条）', () => {
  test('重复调用打了 warn', () => {
    const x = new Budget();
    x.recordTool('generate', { target: '.novelforge/plots/012.md', ask: '雨下了三天，他站在山门外' });
    x.recordTool('generate', { target: '.novelforge/plots/012.md', ask: '雨下了三天，他站在山门外' });
    assert.ok(logs.some((l) => l.includes('generate')), JSON.stringify(logs));
  });

  // 值里可能是一整段正文。
  test('日志里没有参数值', () => {
    const x = new Budget();
    x.recordTool('generate', { target: '.novelforge/plots/012.md', ask: '雨下了三天，他站在山门外' });
    x.recordTool('generate', { target: '.novelforge/plots/012.md', ask: '雨下了三天，他站在山门外' });
    assert.ok(!logs.join('|').includes('雨下了三天'), JSON.stringify(logs));
    assert.ok(!logs.join('|').includes('012.md'), JSON.stringify(logs));
  });

  test('日志里有参数的键名（够定位问题了）', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    x.recordTool('read', { path: 'a.md' });
    assert.ok(logs.join('|').includes('path'), JSON.stringify(logs));
  });

  test('第一次调用不打日志（正常动作不该刷屏）', () => {
    const x = new Budget();
    x.recordTool('read', { path: 'a.md' });
    assert.deepEqual(logs, []);
  });
});

describe('用户可见的用量说明（第 4 条）', () => {
  test('说清用了几次生成、多少 token', () => {
    const x = new Budget({ calls: 10 });
    x.calls = 3;
    x.addTokens(42000);
    assert.equal(x.describe(), '已用 3/10 次生成，约 4.2 万 token');
  });
});
