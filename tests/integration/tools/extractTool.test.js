/**
 * `extract` 工具：从已写的东西里提炼参考材料（文风指南、设定条目、叙事线）。
 *
 * 三样都是工程页工具栏上那几颗按钮背后的同一个函数，确认框照弹。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 作者取消就零调用，账上也记 0 | 文风、设定不报次数：次数只在确认框里，这里猜一个数就是第 4 条要防的对不上 |
 * | 排叙事线报次数；取消时回话说清没调模型 | 不说清楚它会原地再发一遍 |
 * | 一个参数都不认 | 三个动作都不要参数，给了就是模型记错了工具 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'extract');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
  fake.calls.length = 0;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () => '{}',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  // 一章排过的细纲 + 一章正文：三个动作都有东西可提炼，确认框一定会弹。
  t = await makeTempProject(bundle.project, { prefix: 'extractTool', title: '青云剑录' });
  const ws = new bundle.ws.Workspace(t.project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    role: '',
    characters: [],
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '进入宗门', 关键事件: '踩点、失手、翻墙。' },
  });
  t.write('chapters/001-夜入青云.md', '# 夜入青云\n\n雨下了三天。山门在雨里，林昭在门外。\n');
  t.project.invalidate();
  await t.project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('排叙事线：转发给工程页那个动作', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ action: 'threads' });
  });

  test('确认框写着从哪几章的细纲排、预计调用几次', () => {
    assert.match(h.confirms.at(-1).message, /^要从第 1–1 章的细纲排出叙事线，预计 1 次调用/);
  });

  test('作者取消：一次模型都不调，账上也不记', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(r.text.includes('排叙事线这一次没有调用模型'), r.text);
  });
});

describe('文风与设定：交出去，账上记 0', () => {
  // 样章先让作者挑（输入框）：取消就什么都不做。
  test('style：作者取消挑样章，零调用，回话指到 style.md', async () => {
    resetCtx();
    const inputs = h.inputs.length;
    h.expect();
    const r = await run({ action: 'style' });
    assert.equal(h.inputs.length, inputs + 1, '该先让作者挑样章');
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('.novelforge/style.md'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  test('lore：确认框写着逐章识别要调几次；作者取消，零调用、账上记 0', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'lore' });
    assert.ok(h.confirms.at(-1).message.startsWith('将通读已写的正文生成设定：逐章识别固定调用模型 1 次'), h.confirms.at(-1).message);
    assert.ok(r.text.includes('设定生成已交给 Novel Forge 执行'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('工具定义本身', () => {
  test('参数只有 action', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties), ['action']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['style', 'lore', 'threads']);
  });

  test('三个动作都调模型：costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });

  // 哪个动作都不认的参数：报错里不列「只有 X 认」。
  test('给了参数当场报错，不弹框', async () => {
    resetCtx();
    const before = h.confirms.length;
    const r = await run({ action: 'threads', path: '.novelforge/plots/001-夜入青云.md' });
    assert.equal(r.error, 'threads 不认 path。');
    assert.equal(h.confirms.length, before);
  });
});
