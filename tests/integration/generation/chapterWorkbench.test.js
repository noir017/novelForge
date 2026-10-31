/**
 * 章节工作台的后端一半（W6）：`openChapter` 与 `chapterAction`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 有正文、有细纲、宿主能并排 | 正文开在主区，细纲并排——点一下就能对照着看 |
 * | 宿主不能并排 | 只开正文（能力探测，不判断是哪个壳） |
 * | 前端眼下没有第二块（窄屏，`beside: false`） | 同样只开正文：并排的那份开进同一块会顶掉正文的临时标签 |
 * | 还没有正文 | 只开细纲 |
 * | 两样都没有 | 说找不到，不开一个空文件 |
 * | 有正文、还没有细纲（2026-10-23） | 按模板建一份空骨架（标题是章名、没有上游指纹）再并排开；建过一次再点就认它、不另建 |
 * | 上一次并排开的是草稿（2026-10-23） | 点开一章旁边开这一章的草稿（没有就建）、不开细纲；工具栏「细纲」（`openPlot`）点过就换回细纲 |
 * | 工具栏「细纲」 | 并排开这一章的细纲，还没有就按模板建；不认真实章节列表之外的路径 |
 * | 工具条「接着写」 | 等于对这一章按主按钮：切到正文层、按那种写法生成，照样当场问写不写 |
 * | 工具条「定稿」 | 走定稿那条工程动作 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let controller;
let posted = [];
let beside = [];
let replies = [];
let fake;

const P1 = '.novelforge/summaries/001-夜入青云.md';
const P2 = '.novelforge/summaries/002-客栈.md';
const CH1 = 'chapters/001-夜入青云.txt';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  // 多配一个 strong：「重写…」的确认框上为这一轮换它。对话页选定的（`models` 首项）仍是 m。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'strong', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { openBeside: async (p) => { beside.push(p); } },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () => replies.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'chapter-bench', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  for (const [no, title] of [[1, '夜入青云'], [2, '客栈']]) {
    await ws.writePlot({
      no, title, targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...empty, 梗概: `第 ${no} 章的梗概`, 关键事件: `第 ${no} 章的关键事件`, 看点: `第 ${no} 章的看点` },
    });
  }
  await ws.createChapter(1, '夜入青云', filler(300, 1));
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

async function open(plotRelPath, extra = {}) {
  h.expect();
  beside = [];
  posted = [];
  await controller.handle({ type: 'openChapter', plotRelPath, ...extra });
  // 找不到时的那句话走面板的 toast（`c.toast` 推给前端），不走宿主的通知。
  const toasts = posted.filter((m) => m.type === 'toast').map((m) => `${m.level ?? 'info'}: ${m.message}`);
  return { opened: [...h.opened], beside: [...beside], toasts };
}

describe('openChapter', () => {
  test('有正文有细纲：正文开在主区，细纲并排', async () => {
    const r = await open(P1);
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, [P1]);
  });

  test('给的是章节路径也认得出是哪一章', async () => {
    const r = await open(CH1);
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, [P1]);
  });

  test('还没有正文：只开细纲', async () => {
    const r = await open(P2);
    assert.deepEqual(r.opened, [P2]);
    assert.deepEqual(r.beside, []);
  });

  test('两样都没有：说找不到，什么都不开', async () => {
    const r = await open('.novelforge/summaries/009.md');
    assert.deepEqual(r.opened, []);
    assert.ok(r.toasts.some((m) => m.startsWith('error:')), JSON.stringify(r.toasts));
  });

  test('宿主不能并排（没有 openBeside）：只开正文', async () => {
    const saved = h.host.openBeside;
    delete h.host.openBeside;
    try {
      const r = await open(P1);
      assert.deepEqual(r.opened, [CH1]);
      assert.deepEqual(r.beside, []);
    } finally {
      h.host.openBeside = saved;
    }
  });

  test('前端说眼下没有第二块（窄屏，beside: false）：只开正文，不并排、不建细纲', async () => {
    const r = await open(P1, { beside: false });
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, []);
  });

  // 2026-10-18 的回归：分卷的书，细纲镜像正文的相对路径躺在 `summaries/第二卷/` 里。合并细纲与摘要那一次
  // 只认 `summaries/` 根下，点章节名只开了正文，旁边那份细纲打不开。
  test('正文在卷目录里：旁边打开的是 summaries/ 同一个卷目录里的那份细纲', async () => {
    t.write('chapters/第二卷/003-雪夜.txt', '雪下了一夜。\n');
    t.write('.novelforge/summaries/第二卷/003-雪夜.md', '---\nno: 3\ntitle: 雪夜\n---\n\n## 关键事件\n\n- 雪下了一夜。\n');
    project.invalidate();
    try {
      const r = await open('chapters/第二卷/003-雪夜.txt');
      assert.deepEqual(r.opened, ['chapters/第二卷/003-雪夜.txt']);
      assert.deepEqual(r.beside, ['.novelforge/summaries/第二卷/003-雪夜.md']);
    } finally {
      // 第 3 章有正文、第 2 章没有会让后面「重写…」先问一句章号断了（features/chapterGap.ts）。
      t.remove('chapters/第二卷');
      t.remove('.novelforge/summaries/第二卷');
      project.invalidate();
    }
  });
});

describe('openChapter：没有细纲按模板建、旁边开哪一份跟上一次走', () => {
  const CH4 = 'chapters/004-远行.md';
  const P4 = '.novelforge/summaries/004-远行.md';
  const D1 = 'drafts/001-夜入青云.txt';
  const D4 = 'drafts/004-远行.md';
  const results = {};

  before(async () => {
    t.write(CH4, '# 远行\n\n天还没亮。\n');
    project.invalidate();
    results.first = await open(CH4);
    results.made = await project.readPlot(P4);
    results.again = await open(CH4);

    // 工具栏「草稿」开过一次草稿：之后点开一章，旁边开的是草稿。
    beside = [];
    await controller.handle({ type: 'openDraft', path: CH1 });
    results.draftBtn = [...beside];
    results.draftMode = await open(P1);
    results.draftMode4 = await open(CH4);

    // 工具栏「细纲」：并排开细纲，换回细纲。
    beside = [];
    await controller.handle({ type: 'openPlot', path: CH1 });
    results.plotBtn = [...beside];
    results.plotMode = await open(P1);

    posted = [];
    beside = [];
    await controller.handle({ type: 'openPlot', path: 'chapters/不存在.md' });
    results.unknown = { beside: [...beside], toasts: posted.filter((m) => m.type === 'toast').map((m) => `${m.level}: ${m.message}`) };
  });

  after(() => {
    // 第 4 章有正文、2–3 章没有会让后面「重写…」先问一句章号断了（features/chapterGap.ts）。
    for (const rel of [CH4, P4, D1, D4]) t.remove(rel);
    project.invalidate();
  });

  test('有正文没细纲：按模板建一份再并排开', () => {
    assert.deepEqual(results.first.opened, [CH4]);
    assert.deepEqual(results.first.beside, [P4]);
    assert.equal(results.made?.title, '远行');
    assert.equal(results.made?.upstreamHash ?? '', '');
    assert.deepEqual(Object.values(results.made.sections).filter((v) => v.trim()), []);
  });

  test('再点就认那一份，不另建', () => {
    assert.deepEqual(results.again.beside, [P4]);
    assert.ok(!results.again.toasts.some((m) => m.startsWith('error:')), JSON.stringify(results.again.toasts));
  });

  test('点过「草稿」之后，点开一章旁边开草稿、不开细纲', () => {
    assert.deepEqual(results.draftBtn, [D1]);
    assert.deepEqual(results.draftMode.opened, [CH1]);
    assert.deepEqual(results.draftMode.beside, [D1]);
  });

  test('那一章还没有草稿就建一份', () => {
    assert.deepEqual(results.draftMode4.beside, [D4]);
    assert.ok(t.has(D4));
  });

  test('点过「细纲」就换回细纲', () => {
    assert.deepEqual(results.plotBtn, [P1]);
    assert.deepEqual(results.plotMode.beside, [P1]);
  });

  test('「细纲」不认章节列表之外的路径', () => {
    assert.deepEqual(results.unknown.beside, []);
    assert.ok(results.unknown.toasts.some((m) => m.startsWith('error:')), JSON.stringify(results.unknown.toasts));
  });
});

describe('chapterAction', () => {
  let gate;
  let session;

  before(async () => {
    replies = [{ text: filler(800, 2), stop: 'end' }];
    posted = [];
    await controller.handle({ type: 'chapterAction', plotRelPath: P1, action: 'continue' });
    gate = posted.find((m) => m.type === 'gate');
    session = [...posted].reverse().find((m) => m.type === 'session')?.session;
  });

  test('接着写：切到这一章的正文层', () => {
    assert.deepEqual(session.target, { kind: 'manuscript', plotRelPath: P1 });
  });

  test('照样当场问写不写，说的是追加', () => {
    assert.ok(gate, JSON.stringify(posted.map((m) => m.type)));
    assert.ok(gate.title.includes('追加到'), gate.title);
  });

  test('追加进了第 1 章', () => {
    const text = t.read(CH1);
    assert.ok(text.includes(filler(300, 1)) && text.includes(filler(800, 2)));
  });

  test('还没有正文时点「定稿」：说无法定稿，不起任务', async () => {
    posted = [];
    await controller.handle({ type: 'chapterAction', plotRelPath: P2, action: 'finalize' });
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('无法同步')), JSON.stringify(toasts));
  });
});

/**
 * 工程页「故事架构」右键「重写…」：先问一句要求，再对那一件发一轮生成。
 * 取消就什么都不做；「讨论」那条（setTarget）不在这里——它只切层、不花钱。
 */
describe('rewriteArchitecture', () => {
  const PREMISE = '.novelforge/premise.md';

  before(() => {
    t.write(PREMISE, '# 故事前提\n\n少年入青云，一路被人看不起。\n');
  });

  test('取消那一句要求：不切层、不起生成', async () => {
    h.expect(undefined);
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.equal(h.inputs.length, 1);
    assert.ok(!posted.some((m) => m.type === 'session' || m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
  });

  test('写了要求、在确认框上取消：不切层、不起生成', async () => {
    h.expect('主角的金手指换成剑灵', undefined);
    posted = [];
    fake.reset();
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.equal(h.confirms.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!posted.some((m) => m.type === 'session' || m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
  });

  test('确认框：报次数，模型缺省是对话页那个，带详细度下拉框', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['开始重写']);
    assert.ok(c.message.startsWith('重写故事架构 · 故事前提：') && c.message.includes('预计 1 次调用'), c.message);
    assert.equal(c.call.model, 'p/m');
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
  });

  test('写了要求：切到那一件、发一轮生成，要求进了用户那一轮，照样当场问写不写', async () => {
    h.expect('主角的金手指换成剑灵', '开始重写');
    fake.reset();
    replies = [{ text: '# 故事前提\n\n少年得剑灵相助，入青云后一路逆袭打脸。\n', stop: 'end' }];
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    const session = [...posted].reverse().find((m) => m.type === 'session')?.session;
    assert.deepEqual(session.target, { kind: 'setting', doc: 'premise' });
    const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
    const user = turns.find((u) => u.role === 'user');
    assert.ok(user?.content.includes('剑灵'), JSON.stringify(turns.map((u) => [u.role, u.content])));
    assert.equal(user.command, '生成这份架构文档', JSON.stringify(user));
    assert.ok(posted.some((m) => m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
    assert.equal(fake.calls[0].ref, 'p/m');
  });

  // 对话页这条路认确认框上换的模型（generate 认 `pinnedModel`），只这一轮。
  test('确认框上换一个模型：这一轮只用它', async () => {
    h.expect('', { action: '开始重写', choice: { model: 'p/strong' } });
    replies = [{ text: '# 故事前提\n\n少年入青云。\n', stop: 'end' }];
    fake.reset();
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.ok(fake.callCount() >= 1, String(fake.callCount()));
    assert.deepEqual([...new Set(fake.calls.map((m) => m.ref))], ['p/strong']);
  });

  test('不是架构或大纲的目标：什么都不做', async () => {
    h.expect('x');
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'plot', plotRelPath: P1 } });
    assert.equal(h.inputs.length, 0);
    assert.equal(posted.length, 0);
  });
});
