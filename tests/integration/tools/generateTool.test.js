/**
 * `generate` 工具：agent 的「实际生成」入口。
 *
 * 这里钉五件事，每一件都是这一层特有的（generate 本身的行为由
 * `tests/integration/generation/generate.test.js` 守着）：
 *
 * 1. **产物不回灌**——返回文本里只有形状与 draftId，一个正文字都没有。
 *    三千字正文塞回循环，agent 每走一步重烧一遍。
 * 2. **层与能力的组合由 `STAGE_CAPABILITIES` 说了算**，不是这里另判一套。
 * 3. **`settle` 明确不支持**：它要沉淀的是一段讨论，而 agent 手上没有。
 * 4. **`history` 恒为空**——混进装配器会把工具调用当成作者的创作要求。
 * 5. **走对话页选定的那个模型**（不传 provider），第 12 条。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const PLOT_JSON = JSON.stringify({
  目标: '进入宗门',
  剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
  冲突与转折: '三拍推进',
  伏笔与回收: '第三块令牌',
});

let bundle;
let t;
let project;
let fake;
let h;
let ctx;
let settings;
/** 工具经 `ctx.report` 说的话（进气泡，不进 agent 上下文）。 */
let reports;
/** 工具经 `ctx.onDelta` 推给前端的正文增量。 */
let deltas;
/** 存进 DraftStore 的草稿。 */
let stored;

const PLOT_REL = '.novelforge/plots/001-夜入青云.md';
const MANUSCRIPT_REL = '.novelforge/manuscripts/001-夜入青云.md';

let replyFn = () => PLOT_JSON;
const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'generate');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  reports = [];
  deltas = [];
  stored = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { put: (draft, sessionId) => stored.push({ draft, sessionId }) },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: (d) => deltas.push(d),
  };
  fake.calls.length = 0;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    plotFile: './src/core/model/plotFile.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });

  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agentgen', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    arc: '',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '林昭进入宗门' },
  });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('对细纲调 generate', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => PLOT_JSON;
    r = await run({ target: PLOT_REL, capability: 'generate', ask: '排一下这一章' });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('draft 落进了 store', () => {
    assert.equal(stored.length, 1, JSON.stringify(stored.map((s) => s.draft && s.draft.id)));
  });

  test('draft 按会话分桶', () => {
    assert.equal(stored[0].sessionId, 's1');
  });

  test('返回文本里有 draftId', () => {
    assert.ok(r.text.includes(stored[0].draft.id), r.text);
  });

  test('返回文本里有形状摘要', () => {
    assert.ok(r.text.includes('剧情 · 4/4 节'), r.text);
  });

  test('返回文本里有落点', () => {
    assert.ok(r.text.includes(PLOT_REL), r.text);
  });

  // 这条是本 Task 的核心：三千字正文塞回循环，agent 每走一步重烧一遍。
  test('返回文本里没有正文', () => {
    assert.ok(!r.text.includes('踩点、失手、翻墙'), r.text);
    assert.ok(!r.text.includes('第三块令牌'), r.text);
  });

  test('返回文本明说了没写盘', () => {
    assert.ok(r.text.includes('没有写进磁盘') || r.text.includes('采纳'), r.text);
  });

  test('确实没写盘', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('调用一次报一次', () => {
    assert.equal(ctx.usage.calls, 1);
  });

  // 第 4 条：花了多少必须让作者看见。工具说「生成了什么」，
  // 「已用 1/10 次生成」那半句由调用方补——上限只有它知道。
  test('产出了什么在气泡里说出来了', () => {
    assert.ok(reports.some((m) => m.includes('已生成')), JSON.stringify(reports));
  });

  // 工具不该知道上限是多少，说出「1/10」就是又把预算耦合回来了。
  test('工具自己不提上限', () => {
    assert.ok(!reports.join('|').includes('/10'), JSON.stringify(reports));
  });

  test('正文流给了前端', () => {
    assert.ok(deltas.join('').includes('踩点'), JSON.stringify(deltas));
  });

  test('display 给界面画一行', () => {
    assert.ok(r.display && r.display.title.includes('generate'), JSON.stringify(r.display));
  });
});

describe('history 恒为空', () => {
  before(async () => {
    resetCtx();
    replyFn = () => PLOT_JSON;
    await run({ target: PLOT_REL, capability: 'generate', ask: '排一下' });
  });

  // agent 的工具调用不是作者的讨论。混进去，装配器会把 `list .novelforge/plots`
  // 当成作者提的创作要求。
  test('装配出的消息里没有工具调用的痕迹', () => {
    const all = JSON.stringify(fake.calls[0]);
    assert.ok(!all.includes('draftId'), all.slice(0, 400));
    assert.ok(!all.includes('toolCall'), all.slice(0, 400));
  });

  test('只调了一次模型', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
  });
});

describe('层与能力的组合由 STAGE_CAPABILITIES 说了算', () => {
  test('正文层不支持 split，给 error', async () => {
    resetCtx();
    const r = await run({ target: MANUSCRIPT_REL, capability: 'split' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('error 里列出这一层实际能用什么', async () => {
    resetCtx();
    const r = await run({ target: MANUSCRIPT_REL, capability: 'split' });
    assert.ok(r.error.includes('generate'), r.error);
  });

  test('不支持的组合不调模型', async () => {
    resetCtx();
    await run({ target: MANUSCRIPT_REL, capability: 'split' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('剧情层的 split（拆场景）是支持的', async () => {
    resetCtx();
    replyFn = () => JSON.stringify({ 场景: [{ 序号: 1, 标题: '踩点', 目的: '摸清位置' }] });
    const r = await run({ target: PLOT_REL, capability: 'split' });
    assert.equal(r.error, undefined, r.error);
  });

  test('认不出的 capability 给 error', async () => {
    resetCtx();
    const r = await run({ target: PLOT_REL, capability: '排一下' });
    assert.ok(r.error && r.error.includes('capability'), JSON.stringify(r));
  });
});

describe('settle 明确不支持', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ target: PLOT_REL, capability: 'settle' });
  });

  test('给 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 喂它一个空历史，它会凭空编一份「刚才讨论出的结论」——比不支持更糟。
  test('error 指路到对话页手动执行', () => {
    assert.ok(r.error.includes('对话页'), r.error);
  });

  test('一次模型都没调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('一次调用都不报', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('认不出的路径', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ target: '随手写的一个路径.txt', capability: 'generate' });
  });

  test('给 error 而不是抛', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  test('error 里给出各层正确的路径形状', () => {
    assert.ok(r.error.includes('.novelforge/plots/'), r.error);
    assert.ok(r.error.includes('list'), r.error);
  });

  test('一次模型都没调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('越界路径同样给 error', async () => {
    resetCtx();
    const bad = await run({ target: '../../etc/passwd', capability: 'generate' });
    assert.ok(bad.error, JSON.stringify(bad));
  });
});

describe('正文层用对话页选定的那个模型', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => '雨下了三天。山门在雨里。';
    r = await run({ target: MANUSCRIPT_REL, capability: 'generate', targetWords: 800 });
  });

  // 第 12 条：中途换人会让文风断掉。不传 provider = 走 config.active。
  test('用的是 config.active 那个模型', () => {
    assert.equal(fake.calls[0].ref, 'p/m', String(fake.calls[0].ref));
  });

  test('产出了 draft', () => {
    assert.equal(stored.length, 1, JSON.stringify(stored.length));
  });

  // 正文层最容易犯这个错：一章三千字全塞回 agent 上下文。
  test('返回给模型的文本里没有正文', () => {
    assert.ok(!r.text.includes('雨下了三天'), r.text);
  });

  test('但正文流给了前端气泡', () => {
    assert.ok(deltas.join('').includes('雨下了三天'), JSON.stringify(deltas));
  });

  test('给模型的只有字数与 draftId', () => {
    assert.ok(r.text.includes(stored[0].draft.id), r.text);
    assert.ok(/\d+ 字/.test(r.text), r.text);
  });
});

describe('模型失败', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => {
      throw new bundle.provider.LlmError('假装 429 限流');
    };
    r = await run({ target: PLOT_REL, capability: 'generate' });
  });

  test('给 error 而不是抛', () => {
    assert.ok(r.error && r.error.includes('429'), JSON.stringify(r));
  });

  test('没有 draft 落进 store', () => {
    assert.equal(stored.length, 0, JSON.stringify(stored.length));
  });

  // 钱已经花出去了（请求发出去了），账要记上。
  test('仍然报了一次', () => {
    assert.equal(ctx.usage.calls, 1);
  });
});

describe('工具定义本身', () => {
  test('标了 costly', () => {
    assert.equal(tool().costly, true);
  });

  // 三期一个字都不写磁盘。
  test('没标 mutating', () => {
    assert.ok(!tool().mutating, String(tool().mutating));
  });

  // 领域知识在 context/prompts.ts 里，由 generate 内部那次调用自己带着。
  // 在工具描述里再写一遍会白烧 token，且两处迟早跑偏。
  test('描述里不写领域知识', () => {
    const d = tool().description;
    assert.ok(!d.includes('天气'), d);
    assert.ok(!d.includes('台词'), d);
    assert.ok(!d.includes('画面'), d);
  });

  test('参数是扁平的四个标量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['ask', 'capability', 'target', 'targetWords']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });
});
