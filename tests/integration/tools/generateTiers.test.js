/**
 * agent 的 `generate` 用哪个模型（AGENTS 第 12 / 13 条的延伸）。
 *
 * | 层 | 用哪个 | 为什么 |
 * |---|---|---|
 * | 正文 | **对话页选定的那个** | 中途换人会让文风断掉 |
 * | 大纲 | 同上 | 一次定调，没有对应档位 |
 * | 架构 | `setting` 档（故事架构） | 与工程页「补齐设定」同一个模型 |
 * | 细纲 | `plotOutline` 档 | 与工程页「批量拆细纲」同一个模型 |
 *
 * 还有一条容易漏的：走池时**窗口要跟着干活那个模型走**（第 13 条），
 * 拿 200k 的对话模型窗口给快速档的 32k 模型装配上下文会稳定超窗。
 *
 * 正文层的 target 用**章节路径**给（`chapters/NNN-标题.md`）：一章一纲之后正文直接
 * 落在那里，工具按章号去认同号的细纲。
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
const CHAPTER_REL = 'chapters/001-夜入青云.md';
const OUTLINE_REL = '.novelforge/outline.md';
const CONFIG_REL = '.novelforge/config.md';

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
          { name: 'quick', contextWindow: 32000, maxOutputTokens: 1000 },
          { name: 'architect', contextWindow: 128000, maxOutputTokens: 8000 },
        ],
      },
    ],
    models: ['chat/big'],
    // plotOutline 默认归均衡档，setting（故事架构）默认归精标档。
    tierModels: { balanced: ['cheap/plotter'], fast: ['cheap/quick'], quality: ['cheap/architect'] },
    concurrency: 1,
  };
  bundle.host.initHost(makeFakeHost({ supportsVscodeLm: true, settings: () => settings }).host);
  fake = installFakeProvider(bundle.registry, {
    reply: () =>
      JSON.stringify({
        本章目的: '进入宗门',
        关键事件: '踩点、失手、翻墙。',
        章末钩子: '墙内有人在等他。',
      }),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agenttier', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    role: '',
    characters: [],
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '进入宗门' },
  });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('细纲层走 plotOutline 档', () => {
  before(async () => {
    resetCtx();
    await run({ target: PLOT_REL, capability: 'generate' });
  });

  test('用的是那一档的首选，不是对话页那个', () => {
    assert.equal(fake.calls[0].ref, 'cheap/plotter', String(fake.calls[0].ref));
  });
});

// ★ 第 12 条：中途换人会让文风断掉。
describe('正文层严格用对话页选定的那个模型', () => {
  before(async () => {
    resetCtx();
    await run({ target: CHAPTER_REL, capability: 'generate' });
  });

  test('不走池', () => {
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });

  test('把那一档配得再满也不换', async () => {
    resetCtx();
    settings.tierModels.balanced = ['cheap/plotter'];
    settings.tierModels.fast = ['cheap/quick'];
    await run({ target: CHAPTER_REL, capability: 'generate' });
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

// 架构四件与工程页「补齐设定」是同一件事：用同一档的同一个模型，作者在设置页配一处就够。
describe('架构层走 setting 档（故事架构）', () => {
  test('用的是那一档的首选，不是对话页那个', async () => {
    resetCtx();
    await run({ target: CONFIG_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'cheap/architect', String(fake.calls[0].ref));
  });

  test('那一档没配就回到对话页那个', async () => {
    resetCtx();
    const saved = settings.tierModels.quality;
    settings.tierModels.quality = [];
    await run({ target: CONFIG_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
    settings.tierModels.quality = saved;
  });
});

// 六期定了 agent 不做审稿（报告要作者勾选才修稿）：工具不该为一件它不做的事走某个档位。
describe('审稿当场拒绝，不走任何档位', () => {
  test('给 error，一次模型都不调', async () => {
    resetCtx();
    const r = await run({ target: CHAPTER_REL, capability: 'review' });
    assert.ok(r.error && r.error.includes('审稿'), JSON.stringify(r));
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });
});

// 拆场景、拆卷那两档随那两层一起删掉了。忘记删的话，设置页会多出一行点了
// 没用的档位，而作者会以为自己在配一个真存在的任务。
describe('删掉的层没有留下档位', () => {
  test('拆场景不在任务清单里', () => {
    assert.ok(!bundle.tiers.LLM_TASKS.includes('sceneBreakdown'), bundle.tiers.LLM_TASKS.join(','));
  });

  test('没有卷那一层的任务', () => {
    assert.ok(
      !bundle.tiers.LLM_TASKS.some((task) => /volume|split/i.test(task)),
      bundle.tiers.LLM_TASKS.join(',')
    );
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
