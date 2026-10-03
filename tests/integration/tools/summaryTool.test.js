/**
 * `summary` 工具：定稿与摘要（定稿一章、补齐过期摘要、重建全书摘要）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 定稿按章号认，给细纲路径也行 | agent 手里多半是细纲路径；摘要落在同号章节的镜像位置 |
 * | 还没有正文就不花钱 | 摘要描述的是写出来的那一章，没有正文时调一次模型只能复述细纲 |
 * | 定稿调了几次、账上记几次 | 第 4 条：弹窗、账、回话三处的次数是同一个数 |
 * | 同步与重建的确认框照弹，作者取消就零调用 | 转发工程页那个动作，不给 agent 另开一条快路 |
 * | 越界路径给 error、不调模型 | 工程根之外的路径一律不认 |
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
let project;
let h;
let fake;
let ctx;
let reports;

const PLOT1 = '.novelforge/plots/001-夜入青云.md';
const PLOT2 = '.novelforge/plots/002-藏书阁.md';
const CH1 = 'chapters/001-夜入青云.md';
const SUMMARY_JSON = JSON.stringify({
  梗概: '林昭夜入青云宗。',
  出场人物: ['林昭'],
  时间地点: '雨夜，山门外。',
  关键事件: ['翻墙入宗'],
  新增伏笔: [],
  状态变更: '林昭进了宗门。',
});

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'summary');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  reports = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
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
    reply: () => SUMMARY_JSON,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'summaryTool', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 两章细纲，只有第 1 章写了正文：第 2 章是「有细纲、没正文」的那一种。
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no,
      title,
      role: '',
      characters: [],
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '进入宗门', 关键事件: '踩点、翻墙。' },
    });
  }
  t.write(CH1, '# 夜入青云\n\n雨下了三天。山门在雨里，林昭在门外。\n');
  project.invalidate();
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

// 先跑取消的两条：此时第 1 章有正文、没摘要，同步与重建都有活可干，确认框一定会弹。
describe('同步与重建：确认框照弹，作者取消就零调用', () => {
  test('sync：框里写着几章过期、要调几次；取消后回话说清没调模型', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'sync' });
    assert.equal(h.confirms.at(-1).message, '有 1 章摘要缺失或已过期，需要调用 1 次模型。现在同步？');
    assert.ok(r.text.includes('摘要同步这一次没有调用模型'), r.text);
    assert.ok(r.text.includes('不要重试'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  // 重建不报次数：回话只说交出去了，次数以确认框为准，账上记 0。
  test('rebuildGlobal：先提醒有过期摘要；取消后零调用，回话说交出去了', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'rebuildGlobal' });
    assert.ok(h.confirms.at(-1).message.startsWith('有 1 章摘要缺失或过期'), h.confirms.at(-1).message);
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('全书摘要重建已交给 Novel Forge 执行'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('定稿：参数', () => {
  test('缺 path 当场报错，带上参数说明', async () => {
    resetCtx();
    const r = await run({ action: 'finalize' });
    assert.ok(r.error.startsWith('finalize 需要参数：path。path：那一章的章节路径或细纲路径'), r.error);
  });

  // summary 的哪个动作都不认区间：报错里不该凭空列出「只有 X 认」。
  test('给了区间当场报错', async () => {
    resetCtx();
    const r = await run({ action: 'finalize', path: PLOT1, from: 1 });
    assert.equal(r.error, 'finalize 不认 from。');
    assert.equal(fake.calls.length, 0);
  });

  test('sync 不认 path，只有 finalize 认', async () => {
    resetCtx();
    const r = await run({ action: 'sync', path: PLOT1 });
    assert.equal(r.error, 'sync 不认 path，只有 finalize 认。');
  });
});

describe('定稿：还没有正文就不花钱', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'finalize', path: PLOT2 });
  });

  test('给 error，说清这一章还没有正文', () => {
    assert.ok(r.error && r.error.includes('还没有正文'), JSON.stringify(r));
  });

  // 不是参数错，是执行失败：error 前面挂着动作的说法，模型知道是哪一步没成。
  test('error 以动作的说法开头', () => {
    assert.ok(r.error.startsWith('给一章定稿'), r.error);
  });

  test('一次模型都没调，也一次都不报', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('定稿：按章号认，给细纲路径也行', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'finalize', path: PLOT1 });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('报的是那一章的章号', () => {
    assert.ok(r.text.includes('第 1 章'), r.text);
  });

  test('摘要落在同号章节的镜像位置', () => {
    assert.ok(t.has('.novelforge/summaries/001-夜入青云.md'));
  });

  test('调了一次、记了一次，气泡里也说了', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 1);
    assert.ok(reports.some((m) => m.includes('调用模型 1 次')), JSON.stringify(reports));
  });

  test('display 写着这一下调了几次', () => {
    assert.deepEqual(r.display, { title: 'summary finalize', detail: '1 次调用' });
  });

  test('越界路径给 error，且不调模型', async () => {
    resetCtx();
    const bad = await run({ action: 'finalize', path: '../../etc/passwd' });
    assert.ok(bad.error, JSON.stringify(bad));
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  // 只补空白：定稿之后没有过期的摘要，同步不弹框、不花钱。
  test('定稿之后再同步：没事可做，不花钱', async () => {
    resetCtx();
    const before = h.confirms.length;
    const again = await run({ action: 'sync' });
    assert.equal(h.confirms.length, before, '不该弹确认框');
    assert.equal(fake.calls.length, 0);
    assert.ok(again.text.includes('没有调用模型'), again.text);
  });
});

describe('工具定义本身', () => {
  test('三个动作都调模型：costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });

  test('参数只有 action 与 path', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'path']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['finalize', 'sync', 'rebuildGlobal']);
  });

  // 四期：定稿 = 摘要（带连续性事实）+ 出场角色的当前状态；七期再记叙事线。
  test('finalize 的说法是「定稿」：摘要与连续性事实，再更新角色状态、记叙事线', () => {
    assert.ok(
      tool().description.includes(
        'finalize=给一章定稿（摘要与连续性事实，再更新出场角色的当前状态、记下本章推进了哪几条叙事线）（调模型，要 path）'
      ),
      tool().description
    );
  });

  test('动手前那一问写着是哪一章', () => {
    const intent = tool().intent({ action: 'finalize', path: PLOT1 });
    assert.equal(intent.gate, 'mutating');
    assert.ok(intent.detail.startsWith(PLOT1), intent.detail);
  });
});
