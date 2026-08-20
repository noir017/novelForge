/**
 * agent 的 `generate` 用哪个模型（AGENTS 第 12 / 13 条的延伸）。
 *
 * | 层 | 用哪个 | 为什么 |
 * |---|---|---|
 * | 正文 | **对话页选定的那个** | 中途换人会让文风断掉 |
 * | 大纲 | 同上 | 一次定调，没有对应档位 |
 * | 剧情 | `plotOutline` 档 | 与工程页「批量写剧情」同一个模型 |
 * | 场景 | `sceneBreakdown` 档 | 同上 |
 *
 * 还有一条容易漏的：走池时**窗口要跟着干活那个模型走**（第 13 条），
 * 拿 200k 的对话模型窗口给快速档的 32k 模型装配上下文会稳定超窗。
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
let fake;
let ctx;
let settings;

const PLOT_REL = '.novelforge/plots/001-夜入青云.md';
const SCENE_REL = '.novelforge/scenes/001-夜入青云/01-踩点.md';
const MANUSCRIPT_REL = '.novelforge/manuscripts/001-夜入青云.md';
const OUTLINE_REL = '.novelforge/outline.md';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'generate');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
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
    providers: './src/core/model/providers.ts',
    tiers: './src/core/model/tiers.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });

  settings = {
    providers: [
      {
        id: 'chat',
        kind: 'vscode-lm',
        models: [{ name: 'big', contextWindow: 200000, maxOutputTokens: 4000 }],
      },
      {
        id: 'cheap',
        kind: 'vscode-lm',
        models: [
          { name: 'plotter', contextWindow: 64000, maxOutputTokens: 2000 },
          { name: 'splitter', contextWindow: 32000, maxOutputTokens: 1000 },
        ],
      },
    ],
    models: ['chat/big'],
    // plotOutline 默认归均衡档，sceneBreakdown 默认归快速档。
    tierModels: { balanced: ['cheap/plotter'], fast: ['cheap/splitter'], quality: [] },
    concurrency: 1,
  };
  bundle.host.initHost(makeFakeHost({ supportsVscodeLm: true, settings: () => settings }).host);
  fake = installFakeProvider(bundle.registry, {
    reply: () =>
      JSON.stringify({
        目标: '进入宗门',
        剧情脉络: '踩点、失手、翻墙。',
        冲突与转折: '三拍',
        伏笔与回收: '令牌',
        场景: [{ 序号: 1, 标题: '踩点', 目的: '摸清位置' }],
      }),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agenttier', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    arc: '',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '进入宗门' },
  });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('剧情层走 plotOutline 档', () => {
  before(async () => {
    resetCtx();
    await run({ target: PLOT_REL, capability: 'generate' });
  });

  test('用的是那一档的首选，不是对话页那个', () => {
    assert.equal(fake.calls[0].ref, 'cheap/plotter', String(fake.calls[0].ref));
  });
});

describe('细节层走 sceneBreakdown 档', () => {
  before(async () => {
    resetCtx();
    await run({ target: SCENE_REL, capability: 'generate' });
  });

  test('用的是快速档那个', () => {
    assert.equal(fake.calls[0].ref, 'cheap/splitter', String(fake.calls[0].ref));
  });
});

// ★ 第 12 条：中途换人会让文风断掉。
describe('正文层严格用对话页选定的那个模型', () => {
  before(async () => {
    resetCtx();
    await run({ target: MANUSCRIPT_REL, capability: 'generate' });
  });

  test('不走池', () => {
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });

  test('把那一档配得再满也不换', async () => {
    resetCtx();
    settings.tierModels.balanced = ['cheap/plotter'];
    await run({ target: MANUSCRIPT_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });
});

describe('大纲层也用对话页那个（一次定调，没有对应档位）', () => {
  test('不走池', async () => {
    resetCtx();
    await run({ target: OUTLINE_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });
});

describe('档位没配模型时沿用默认模型清单', () => {
  test('清空那一档就回到对话页那个', async () => {
    resetCtx();
    const saved = settings.tierModels.balanced;
    settings.tierModels.balanced = [];
    await run({ target: PLOT_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
    settings.tierModels.balanced = saved;
  });
});

describe('Agent 调度是一项独立的任务档位', () => {
  test('在任务清单里', () => {
    assert.ok(bundle.tiers.LLM_TASKS.includes('agent'), bundle.tiers.LLM_TASKS.join(','));
  });

  test('有中文名与说明（设置页那张表要用）', () => {
    assert.ok(bundle.tiers.TASK_LABEL.agent, bundle.tiers.TASK_LABEL.agent);
    assert.ok(bundle.tiers.TASK_HINT.agent, bundle.tiers.TASK_HINT.agent);
  });

  // 一轮十几次调用，但每次只做「下一步调哪个工具」的判断，不产正文。
  test('默认归均衡档', () => {
    assert.equal(bundle.tiers.DEFAULT_TASK_TIERS.agent, 'balanced');
  });
});
