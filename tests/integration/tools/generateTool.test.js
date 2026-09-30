/**
 * `generate` 工具：agent 的「实际生成」入口。
 *
 * 这里钉六件事，每一件都是这一层特有的（generate 本身的行为由
 * `tests/integration/generation/generate.test.js` 守着）：
 *
 * 1. **产物不回灌**——返回文本里只有形状与 draftId，一个正文字都没有。
 *    三千字正文塞回循环，agent 每走一步重烧一遍。
 * 2. **层由路径决定**：架构三件、大纲、细纲各有自己的路径；**正文层给章节路径**
 *    （`chapters/NNN-标题.md`），工具按章号去认同号的细纲（细纲号 = 章号），
 *    target 以那份细纲的路径为身份。老工程的中转站、卷纲路径认不出，一律拦下。
 * 3. **能力只有三种**（discuss / generate / settle），`split` 随卷与中转站一起删了。
 * 4. **`settle` 明确不支持**：它要沉淀的是一段讨论，而 agent 手上没有。
 * 5. **`history` 恒为空**——混进装配器会把工具调用当成作者的创作要求。
 * 6. **走对话页选定的那个模型**（不传 provider），第 12 条。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

/** 细纲层的应答：D3 三节 + 规划字段。 */
const PLOT_JSON = JSON.stringify({
  title: '夜入青云',
  role: '开篇',
  characters: ['林昭'],
  本章目的: '进入宗门',
  关键事件: '踩点、失手、翻墙；收在藏书阁门口。',
  章末钩子: '第三块令牌在墙内等着他',
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
/** 第 1 章的正文路径。文件还不存在——正文就是要写到这里。 */
const CHAPTER_REL = 'chapters/001-夜入青云.md';
const CONFIG_REL = '.novelforge/config.md';

let replyFn = () => PLOT_JSON;
const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'generate');
const run = (args) => tool().run(ctx, args);
/** 最近一次模型调用里的 system 与 user 两段。 */
const lastSystem = () => fake.calls[fake.calls.length - 1][0].content;
const lastUser = () => {
  const call = fake.calls[fake.calls.length - 1];
  return call[call.length - 1].content;
};

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
  // 只起了个头的细纲：「关键事件」空着，所以还不算排过。
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    role: '',
    characters: [],
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '林昭进入宗门' },
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

  test('draft 是细纲层的产物', () => {
    assert.deepEqual(stored[0].draft.target, { kind: 'plot', plotRelPath: PLOT_REL });
    assert.equal(stored[0].draft.artifact.kind, 'plot');
  });

  test('返回文本里有 draftId', () => {
    assert.ok(r.text.includes(stored[0].draft.id), r.text);
  });

  // D3 三节：本章目的 / 关键事件 / 章末钩子。
  test('返回文本里有形状摘要', () => {
    assert.ok(r.text.includes('细纲 · 3/3 节'), r.text);
  });

  test('返回文本里有落点', () => {
    assert.ok(r.text.includes(PLOT_REL), r.text);
  });

  // 这条是本 Task 的核心：三千字正文塞回循环，agent 每走一步重烧一遍。
  test('返回文本里没有正文', () => {
    assert.ok(!r.text.includes('踩点、失手、翻墙'), r.text);
    assert.ok(!r.text.includes('第三块令牌'), r.text);
  });

  // 工具自己不落盘：写不写由调用方当场问作者（`controller` 的落盘卡片）。
  test('返回文本说清了落盘是另一回事', () => {
    assert.ok(r.text.includes('落盘'), r.text);
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

/**
 * ★ 一章一纲之后正文直接落 `chapters/`，agent 看到的「这一章」就是那个章节文件。
 * 工具要按章号认出同号的细纲，把它当成正文层的 target——细纲**就是**写正文的依据，
 * 认错了号，模型手上就是另一章的事件。
 */
describe('给章节路径：按章号认成正文层', () => {
  let r;
  let draft;

  before(async () => {
    resetCtx();
    replyFn = () => '雨下了三天。山门在雨里。';
    r = await run({ target: CHAPTER_REL, capability: 'generate', targetWords: 800 });
    draft = stored[0]?.draft;
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('是正文层的生成', () => {
    assert.deepEqual(draft.action, { stage: 'manuscript', capability: 'generate' });
  });

  // target 以细纲路径为身份（号会撞、路径不会），这里认的是同号那一份。
  test('target 指向同号的细纲', () => {
    assert.deepEqual(draft.target, { kind: 'manuscript', plotRelPath: PLOT_REL });
  });

  test('系统提示是作者的身份', () => {
    assert.ok(lastSystem().includes('中文长篇小说作者，正在为'), lastSystem().slice(0, 60));
  });

  // 细纲是写正文的依据：认对了号，那一章的细纲就在上下文里。
  test('那一章的细纲进了上下文', () => {
    assert.ok(lastUser().includes('# 细纲'), lastUser().slice(-600));
    assert.ok(lastUser().includes('林昭进入宗门'), lastUser().slice(-600));
  });

  test('目标字数传进了 prompt', () => {
    assert.ok(lastUser().includes('800 字'), lastUser().slice(-400));
  });

  test('返回文本里的落点是作者给的那个章节路径', () => {
    assert.ok(r.text.includes(`落点：${CHAPTER_REL}`), r.text);
  });

  test('确实没写盘（章节文件还不在）', () => {
    assert.ok(!t.has(CHAPTER_REL));
  });

  // 老工程里只有正文、没有细纲的章：target 落在同号细纲**应该**在的位置，
  // 取正文的标题；写正文的依据退化成空，但层与章号不会认错。
  test('已有正文、还没有细纲的章：target 落在同号细纲应在的位置', async () => {
    t.write('chapters/003-雪夜.md', '# 雪夜\n\n雪下了一夜。\n');
    project.invalidate();
    resetCtx();
    await run({ target: 'chapters/003-雪夜.md', capability: 'generate' });
    assert.deepEqual(stored[0].draft.target, { kind: 'manuscript', plotRelPath: '.novelforge/plots/003-雪夜.md' });
  });

  test('章节还不存在、也没有细纲时同样认成正文层', async () => {
    resetCtx();
    await run({ target: 'chapters/002-藏书阁.md', capability: 'generate' });
    const target = stored[0].draft.target;
    assert.equal(target.kind, 'manuscript', JSON.stringify(target));
    assert.ok(target.plotRelPath.startsWith('.novelforge/plots/002'), JSON.stringify(target));
  });
});

describe('对架构文档调 generate', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => '## 一句话\n\n少年入宗。\n\n## 核心梗概\n\n林昭夜入青云宗，追查一块令牌的来历。\n';
    r = await run({ target: CONFIG_REL, capability: 'generate', ask: '玄幻，入宗流' });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  // 四件同属一个阶段，target 要带上是哪一件，契约与落点都看它。
  test('target 是架构层的「小说配置」那一件', () => {
    assert.deepEqual(stored[0].draft.target, { kind: 'setting', doc: 'config' });
  });

  test('系统提示是策划的身份', () => {
    assert.ok(lastSystem().includes('资深网文策划编辑'), lastSystem().slice(0, 60));
  });

  // 配置用上游的 JSON 合同（英文键，解码时对到 config.md 的七节）。
  test('输出契约是小说配置的 JSON 合同', () => {
    assert.ok(lastUser().includes('"coreOutline"') && lastUser().includes('"globalGuidance"'), lastUser().slice(-600));
  });

  test('返回文本里有形状摘要', () => {
    assert.ok(r.text.includes('小说配置 · 2/7 节'), r.text);
  });

  test('返回文本里没有正文', () => {
    assert.ok(!r.text.includes('追查一块令牌'), r.text);
  });
});

describe('能力只有三种，由 STAGE_CAPABILITIES 说了算', () => {
  // 拆卷、拆段、拆章都删了。agent 拿着老提示词来试的话，要在这里被拦住，
  // 并被告知现在有哪几种能力。
  test('split 不再是能力，给 error', async () => {
    resetCtx();
    const r = await run({ target: CHAPTER_REL, capability: 'split' });
    assert.ok(r.error && r.error.includes('capability'), JSON.stringify(r));
  });

  test('error 里列出实际能用什么', async () => {
    resetCtx();
    const r = await run({ target: PLOT_REL, capability: 'split' });
    assert.ok(r.error.includes('generate') && r.error.includes('discuss'), r.error);
  });

  test('不支持的能力不调模型', async () => {
    resetCtx();
    await run({ target: PLOT_REL, capability: 'split' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
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
    assert.ok(r.error.includes('chapters/'), r.error);
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

  // 老工程磁盘上的中转站、卷纲、按卷分的细纲子目录一个字节都不动，但代码不再认它们：
  // 对着它们生成，产物没有落点，只会白花一次钱。
  for (const [what, legacy] of [
    ['中转站正文', '.novelforge/manuscripts/001-夜入青云.md'],
    ['卷纲', '.novelforge/volumes/01-觉醒之日.md'],
    ['按卷分目录的细纲', '.novelforge/plots/01-觉醒之日/001-夜入青云.md'],
  ]) {
    test(`老工程的${what}路径认不出，不调模型`, async () => {
      resetCtx();
      const bad = await run({ target: legacy, capability: 'generate' });
      assert.ok(bad.error, JSON.stringify(bad));
      assert.equal(fake.calls.length, 0, String(fake.calls.length));
      assert.equal(ctx.usage.calls, 0);
    });
  }
});

describe('正文层用对话页选定的那个模型', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => '雨下了三天。山门在雨里。';
    r = await run({ target: CHAPTER_REL, capability: 'generate', targetWords: 800 });
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

  // 一个字都不写磁盘。
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

  test('描述里给出各层的路径形状（架构 / 细纲 / 章节）', () => {
    const d = tool().description;
    assert.ok(d.includes('config.md') && d.includes('.novelforge/plots/') && d.includes('chapters/'), d);
  });

  test('描述里的能力清单没有 split', () => {
    assert.ok(!tool().description.includes('split'), tool().description);
  });

  // 细纲路径经 kindOfPath 恒判成细纲层、工具也没有别的参数能改层——描述要是许诺
  // 「细纲路径也能当正文层」，agent 照着给细纲路径想写正文，拿到的会是一份细纲
  // （还走了细纲那一档的便宜模型）。
  test('描述不许诺「细纲路径也能当正文层」，并说清细纲路径永远是细纲层', () => {
    assert.ok(!tool().description.includes('正文层也可以给那一章细纲的路径'), tool().description);
    assert.ok(tool().description.includes('细纲路径永远是细纲层'), tool().description);
  });

  test('参数是扁平的四个标量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['ask', 'capability', 'target', 'targetWords']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });
});
