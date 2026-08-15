/**
 * 采纳走 draftId 这条路：从生成到落盘的一整趟。
 *
 * 这一组守的是「**落点从 draft 里取，不由前端传**」（AGENTS 第 19 条最后
 * 一句）。从前前端发的是 `store.session.target`——那是**当下**选中的目标，
 * 用户生成完切了一章再点采纳，这份剧情就写到别的章去了，而界面上一切正常。
 *
 * 另外两条同样要钉住：采纳时以**气泡里当下的文本**为准重新解析（用户可能
 * 改过），以及并发控制搬到 controller 之后「已有一个生成任务在进行中」
 * 那句话与它的行为原样还在。
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

const P1 = '.novelforge/plots/001-夜入青云.md';
const P2 = '.novelforge/plots/002-藏书阁.md';

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;

let settings = {};
let replyFn = () => PLOT_JSON;

/** 发一轮「写剧情」，回收这一轮推给前端的消息。 */
async function send(target, extra = {}) {
  posted.length = 0;
  await controller.handle({
    type: 'send',
    payload: {
      text: '排一下',
      stage: 'plot',
      capability: 'generate',
      target,
      targetNo: 0,
      targetWords: 0,
      attachments: [],
      excludedIds: [],
      ...extra,
    },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    turns,
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    toasts: posted.filter((m) => m.type === 'toast'),
  };
}

async function accept(turnId, draftId, text) {
  posted.length = 0;
  await controller.handle({ type: 'acceptArtifact', turnId, draftId, text });
  return {
    toasts: posted.filter((m) => m.type === 'toast').map((m) => `${m.level ?? 'info'}: ${m.message}`),
    turn: posted.filter((m) => m.type === 'turnDone').pop()?.turn,
  };
}

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
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  // 覆盖审阅一律放行：这一组测的是「写到哪」，不是「问不问」。
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'accept', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no, title, arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: `第 ${no} 章要达成的事` },
    });
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('生成一轮 → 气泡上挂着 draftId', () => {
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('产出了回复', () => {
    assert.ok(r.assistant, JSON.stringify(r.turns.map((x) => x.role)));
  });

  test('回复带 draftId', () => {
    assert.ok(r.assistant.draftId, JSON.stringify(r.assistant));
  });

  // 展示快照仍在：即使草稿日后被清掉，气泡上还看得出产出过什么。
  test('回复带展示快照', () => {
    assert.equal(r.assistant.artifact.summary, '剧情 · 4/4 节', JSON.stringify(r.assistant.artifact));
  });

  test('快照说得出落点', () => {
    assert.ok(r.assistant.artifact.where.includes('夜入青云'), r.assistant.artifact.where);
  });

  // 一个字都不写磁盘：落盘只在用户点了采纳之后。
  test('还没采纳时磁盘上没动静', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('落点从 draft 里取，不看当下选中的那一章', () => {
  let draftId;
  let turnId;
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    const gen = await send({ kind: 'plot', plotRelPath: P1 });
    draftId = gen.assistant.draftId;
    turnId = gen.assistant.id;

    // 生成完之后**切到另一章**——这正是从前会写错地方的那一下。
    posted.length = 0;
    await controller.handle({ type: 'setTarget', target: { kind: 'plot', plotRelPath: P2 } });

    r = await accept(turnId, draftId, PLOT_JSON);
  });

  test('采纳成功', () => {
    assert.ok(!r.toasts.some((x) => x.startsWith('error:')), r.toasts.join('|'));
  });

  test('写进了生成时那一章', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('内容正是那一份', () => {
    assert.ok(t.read('.novelforge/plots/001-夜入青云.md').includes('三拍推进'));
  });

  // 关键：切过去的那一章一个字都不该被写。
  test('没有写到当下选中的那一章', async () => {
    const other = await project.readPlot(P2);
    assert.ok(!bundle.plotFile.isPlotFilled(other.sections), JSON.stringify(other.sections));
  });

  test('气泡上记下写到哪了', () => {
    assert.equal(r.turn?.acceptedTo, P1, JSON.stringify(r.turn?.acceptedTo));
  });
});

describe('采纳以气泡里当下的文本为准', () => {
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    const gen = await send({ kind: 'plot', plotRelPath: P2 });
    // 用户在气泡里把「三拍推进」改成了别的再点采纳。
    const edited = JSON.stringify({
      目标: '进入宗门',
      剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
      冲突与转折: '我自己改成了两拍',
      伏笔与回收: '第三块令牌',
    });
    h.answers.push('覆盖');
    r = await accept(gen.assistant.id, gen.assistant.draftId, edited);
  });

  test('采纳成功', () => {
    assert.ok(!r.toasts.some((x) => x.startsWith('error:')), r.toasts.join('|'));
  });

  // 用 draft.artifact 的话，用户改的那两个字就没了——而他改完才点的采纳。
  test('落盘的是改过的那一版', () => {
    assert.ok(t.read('.novelforge/plots/002-藏书阁.md').includes('我自己改成了两拍'));
  });

  test('模型原样输出的那一版没写进去', () => {
    assert.ok(!t.read('.novelforge/plots/002-藏书阁.md').includes('三拍推进'));
  });
});

describe('草稿过期了', () => {
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    const gen = await send({ kind: 'plot', plotRelPath: P1 });
    r = await accept(gen.assistant.id, '这份草稿从来没有过', PLOT_JSON);
  });

  // **不猜落点**：拿当下选中的 target 顶上，会把一份剧情写到别的章去。
  test('报错而不是乱写', () => {
    assert.ok(r.toasts.some((x) => x.startsWith('error:')), r.toasts.join('|'));
  });

  test('说得出为什么', () => {
    assert.ok(r.toasts.some((x) => x.includes('过期')), r.toasts.join('|'));
  });
});

describe('讨论型回复不给采纳的东西', () => {
  let assistant;

  before(async () => {
    replyFn = () => '我觉得这一章的冲突可以提前。';
    const gen = await send({ kind: 'plot', plotRelPath: P1 }, { capability: 'discuss' });
    assistant = gen.assistant;
  });

  test('没有 draftId', () => {
    assert.equal(assistant.draftId, undefined, assistant.draftId);
  });

  test('也没有展示快照', () => {
    assert.equal(assistant.artifact, undefined, JSON.stringify(assistant.artifact));
  });
});

/**
 * 二期唯一一处**有意的行为变化**：刷新网页后，未采纳的产物仍然可以采纳。
 *
 * 从前只有 `ChatTurn.artifact` 那份摘要活着（原文靠气泡里的文本重新解析、
 * 落点靠当下选中的 target 猜）。draft 落盘之后这条路才真的走得通。
 */
describe('刷新网页之后还能采纳', () => {
  let sessionId;
  let turnId;
  let draftId;
  let reopened;
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    // 新开一个会话，免得跟前面几组的历史搅在一起。
    await controller.handle({ type: 'newSession' });
    const gen = await send({ kind: 'plot', plotRelPath: P2 });
    sessionId = controller.current.id;
    turnId = gen.assistant.id;
    draftId = gen.assistant.draftId;

    // 「刷新网页」= 换一个 controller 从磁盘把会话读回来。
    controller.dispose();
    controller = new bundle.controller.ChatController(project);
    posted = [];
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    await controller.handle({ type: 'openSession', id: sessionId });
    reopened = posted.filter((m) => m.type === 'session').pop()?.session;

    h.answers.push('覆盖');
    r = await accept(turnId, draftId, PLOT_JSON);
  });

  test('会话读回来了', () => {
    assert.ok(reopened, JSON.stringify(posted.map((m) => m.type)));
  });

  test('气泡上的 draftId 还在', () => {
    const turn = reopened.turns.find((x) => x.id === turnId);
    assert.equal(turn?.draftId, draftId, JSON.stringify(turn));
  });

  test('展示快照也还在', () => {
    const turn = reopened.turns.find((x) => x.id === turnId);
    assert.equal(turn?.artifact?.summary, '剧情 · 4/4 节', JSON.stringify(turn?.artifact));
  });

  test('采纳成功，没报「已经过期」', () => {
    assert.ok(!r.toasts.some((x) => x.startsWith('error:')), r.toasts.join('|'));
  });

  test('内容写进了生成时那一章', () => {
    assert.ok(t.read('.novelforge/plots/002-藏书阁.md').includes('三拍推进'));
  });
});

describe('并发控制搬到 controller 之后', () => {
  let concurrent;
  let callsTotal;

  before(async () => {
    replyFn = () => PLOT_JSON;
    fake.reset();
    // 不 await 第一条：`runTurn` 一进来就占住生成位（在任何 I/O 之前），
    // 所以此刻第二条一定撞得上。
    const first = send({ kind: 'plot', plotRelPath: P1 });
    concurrent = await send({ kind: 'plot', plotRelPath: P1 });
    await first;
    callsTotal = fake.calls.length;
  });

  // 这句话与它的行为是搬家前后必须一字不差的那一条。
  test('第二条被拒，说「已有一个生成任务在进行中」', () => {
    assert.ok(
      concurrent.toasts.some((m) => m.level === 'error' && m.message.includes('已有一个生成任务在进行中')),
      JSON.stringify(concurrent.toasts)
    );
  });

  // 两条请求只该烧一次 token。
  test('被拒的那条没有调模型', () => {
    assert.equal(callsTotal, 1, `调了 ${callsTotal} 次`);
  });

  test('第一条跑完之后又能发了', async () => {
    const again = await send({ kind: 'plot', plotRelPath: P1 });
    assert.ok(again.assistant?.draftId, JSON.stringify(again.toasts));
  });
});
