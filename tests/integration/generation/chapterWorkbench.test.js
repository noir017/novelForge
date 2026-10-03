/**
 * 章节工作台的后端一半（W6）：`openChapter` 与 `chapterAction`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 有正文、有细纲、宿主能并排 | 正文开在主区，细纲并排——点一下就能对照着看 |
 * | 宿主不能并排 | 只开正文（能力探测，不判断是哪个壳） |
 * | 还没有正文 | 只开细纲 |
 * | 两样都没有 | 说找不到，不开一个空文件 |
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

const P1 = '.novelforge/plots/001-夜入青云.md';
const P2 = '.novelforge/plots/002-客栈.md';
const CH1 = 'chapters/001-夜入青云.md';

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
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
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
  installFakeProvider(bundle.registry, {
    reply: () => replies.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'chapter-bench', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  for (const [no, title] of [[1, '夜入青云'], [2, '客栈']]) {
    await ws.writePlot({
      no, title, role: '', characters: [], targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...empty, 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章的关键事件`, 章末钩子: `第 ${no} 章的钩子` },
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

async function open(plotRelPath) {
  h.expect();
  beside = [];
  posted = [];
  await controller.handle({ type: 'openChapter', plotRelPath });
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
    const r = await open('.novelforge/plots/009.md');
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
    assert.ok(toasts.some((m) => m.includes('无法定稿')), JSON.stringify(toasts));
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

  test('写了要求：切到那一件、发一轮生成，要求进了用户那一轮，照样当场问写不写', async () => {
    h.expect('主角的金手指换成剑灵');
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
  });

  test('不是架构或大纲的目标：什么都不做', async () => {
    h.expect('x');
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'plot', plotRelPath: P1 } });
    assert.equal(h.inputs.length, 0);
    assert.equal(posted.length, 0);
  });
});
