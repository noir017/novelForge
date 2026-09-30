/**
 * 审稿报告、按勾选修稿、一致性预检、合并结果与定位引文（五期的 controller 一半）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 审稿那一轮没有落盘卡片；报告在这一轮上、在草稿表里、在会话文件里 | D22：报告不落盘，随会话保存 |
 * | 章节条「审稿」发一轮审稿；没有正文不发 | W6 的第五颗按钮 |
 * | 修稿只把勾选的交给模型；用户气泡带清单 | 作者没勾的不该出现在模型眼前 |
 * | 正文改过之后，引文已经不在的勾选项作废并写进卡片说明 | 第 2 条 |
 * | 修稿当场问写不写，写入前审阅；合并视图交回的那一份落盘 | 第 19 条、第 3 条、W11 |
 * | 预检：细纲排了死人，先亮一张卡；「先不写」不调模型；「仅本次忽略」照写 | 零调用、不挡路但不静默 |
 * | 接着写不预检 | 开头已经写下了 |
 * | 定位引文：宿主有 revealText 就交给它，没有就打开文件并提示那一句 | 能力探测，不判断壳 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let fake;
let project;
let controller;
let posted = [];
let gates = [];
let gateAnswer = 'proceed';
let script = [];

const P2 = '.novelforge/plots/002-客栈.md';
const P3 = '.novelforge/plots/003-夜访.md';
const P4 = '.novelforge/plots/004-井.md';

const CH2 = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  filler(700, 7),
  '“你明天就走？”她问。林昭点了点头，说：“天一亮就走。”',
].join('\n\n');

const REVIEW_JSON = JSON.stringify({
  summary: '一处硬伤',
  items: [
    { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已经交出去了' },
    { category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '左臂有伤却动作如常' },
    { category: '角色状态', severity: 'warning', quote: '林昭拔剑指着她', description: '编的' },
  ],
  goalReviews: [
    { id: 'g1', status: 'completed', description: 'x', evidence: [{ quote: '林昭推开客栈的门' }] },
    { id: 'g2', status: 'unknown', description: '没写到', evidence: [] },
  ],
});

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        const verdict = typeof gateAnswer === 'function' ? gateAnswer(m) : gateAnswer;
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
      }
    },
    reveal() {},
  });
}

function reset(replies = []) {
  script = [...replies];
  posted = [];
  gates = [];
  fake.calls.length = 0;
}

const toastsPosted = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);
const turnsOf = () => posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
const lastAssistant = () => [...turnsOf()].reverse().find((x) => x.role === 'assistant');
const lastUserTurn = () => [...turnsOf()].reverse().find((x) => x.role === 'user');
const userPrompts = () => fake.calls.map((c) => c[c.length - 1].content);

async function reviewChapter2() {
  reset([{ text: REVIEW_JSON, stop: 'end' }]);
  await controller.handle({ type: 'chapterAction', plotRelPath: P2, action: 'review' });
  return lastAssistant();
}

async function writePlot(ws, no, title, characters, extra = {}) {
  const empty = bundle.plotFile.emptyPlotSections();
  await ws.writePlot({
    no, title, role: '', characters, targetWords: 800, upstreamHash: '', done: false,
    sections: { ...empty, 本章目的: `第 ${no} 章的目的`, 关键事件: extra.events ?? `第 ${no} 章的关键事件`, 章末钩子: `第 ${no} 章的钩子` },
  });
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
    session: './src/core/model/session.ts',
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
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'review-card', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await writePlot(ws, 1, '夜入青云', ['林昭']);
  await writePlot(ws, 2, '客栈', ['林昭', '沈氏'], { events: '林昭回到客栈；林昭当晚离开青崖镇' });
  await writePlot(ws, 3, '夜访', ['林昭', '阿秋']);
  await writePlot(ws, 4, '井', ['林昭']);
  await ws.createChapter(1, '夜入青云', filler(900, 1));
  await ws.createChapter(2, '客栈', CH2);
  await project.syncManifest();
  // 沈秋（别名阿秋）在角色卡上已经死了，第 3 章的细纲还排着他。
  const dir = path.join(t.dir, '.novelforge/characters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '沈秋.md'),
    ['---', 'name: 沈秋', 'aliases: [阿秋]', 'stateThrough: 2', '---', '', '# 沈秋', '', '## 当前状态', '', '已死亡（第 2 章被刺杀）', ''].join('\n')
  );
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('审稿：章节条「审稿」发一轮', () => {
  let a;
  before(async () => {
    a = await reviewChapter2();
  });

  test('一次调用，没有落盘卡片', () => {
    assert.equal(fake.calls.length, 1);
    assert.equal(gates.length, 0);
    assert.equal(a.artifact, undefined);
  });

  test('用户气泡是 /审稿', () => {
    assert.equal(lastUserTurn().command, '审稿');
  });

  test('报告在这一轮上：伪造引文的那条丢了，缺省勾选是两条问题', () => {
    assert.ok(a.review);
    assert.deepEqual(a.review.report.issues.map((i) => i.id), ['i1', 'i2']);
    assert.deepEqual(a.review.picks, ['i1', 'i2']);
    assert.match(a.review.notes.join(), /丢掉 1 条/);
    assert.equal(a.review.calls, 1);
  });

  test('气泡正文是给人读的报告', () => {
    assert.match(a.content, /^# 第 2 章《客栈》审稿/);
  });

  test('会话文件里存着报告，草稿表里也有一份', async () => {
    const file = path.join(project.sessionsDir, `${controller.current.id}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const turn = json.turns.find((x) => x.id === a.id);
    assert.equal(turn.review.report.chapterNo, 2);
    assert.ok(json.drafts.some((d) => d.review && d.review.chapterNo === 2));
  });

  test('这一章没有正文：不发', async () => {
    reset(['不该被调用']);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'review' });
    assert.equal(fake.calls.length, 0);
    assert.ok(toastsPosted().some((x) => /还没有正文，没法审稿/.test(x)), JSON.stringify(toastsPosted()));
  });
});

describe('按勾选修稿', () => {
  let reviewTurn;
  const REVISED = CH2.replace('她把那块残令收进了袖中。', '她看了一眼他空着的手，什么也没问。');

  before(async () => {
    reviewTurn = await reviewChapter2();
  });

  test('只把勾选的交给模型；用户气泡带清单；当场问写不写，写入前审阅', async () => {
    reset([{ text: REVISED, stop: 'end' }]);
    h.reviewed.length = 0;
    h.setReviewVerdict('apply');
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'g1', 'nope'] });
    assert.equal(fake.calls.length, 1);
    const prompt = userPrompts()[0];
    assert.match(prompt, /残令前文已经交出去了/);
    assert.doesNotMatch(prompt, /左臂有伤/);
    const user = lastUserTurn();
    assert.equal(user.command, '按审稿修稿');
    assert.deepEqual(user.revise.items, ['[严重] 剧情合理性：残令前文已经交出去了']);
    assert.equal(gates.length, 1);
    assert.match(gates[0].detail, /按 1 条勾选的审稿意见修稿/);
    assert.equal(h.reviewed.length, 1);
    assert.equal(h.reviewed[0].merge, true);
    const text = await project.readChapterText(await project.getChapter(2));
    assert.ok(text.includes('她看了一眼他空着的手'));
  });

  test('正文在审稿之后改过：引文已经不在的那条作废并写进卡片说明', async () => {
    // 上一个用例已经把那一句改掉了；再按同一份报告勾 i1 + i2。
    reset([{ text: CH2.replace('林昭点了点头', '林昭用右手托着左臂，点了点头'), stop: 'end' }]);
    h.setReviewVerdict('discard');
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'i2'] });
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(userPrompts()[0], /残令前文已经交出去了/);
    assert.match(userPrompts()[0], /左臂有伤却动作如常/);
    assert.match(gates[0].detail, /正文在审稿之后改过/);
    assert.match(gates[0].detail, /1 条的引文已经不在正文里了/);
  });

  test('勾选的都作废了：不调模型', async () => {
    reset(['不该被调用']);
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1'] });
    assert.equal(fake.calls.length, 0);
    assert.match(lastAssistant().error, /都找不到了/);
  });

  test('合并视图交回的那一份落盘', async () => {
    const fresh = await reviewChapter2();
    const now = await project.readChapterText(await project.getChapter(2));
    reset([{ text: now.replace('林昭推开客栈的门', '林昭推开客栈那扇旧门'), stop: 'end' }]);
    h.setReviewVerdict(({ proposed }) => ({ merged: `${proposed.trim()}\n\n作者在合并视图里加的一句。\n` }));
    // 这一章已经改过：第一条的引文不在了，重新审出来的报告里只剩「左臂有伤」那一条（i1）。
    assert.deepEqual(fresh.review.report.issues.map((i) => i.description), ['左臂有伤却动作如常']);
    await controller.handle({ type: 'reviseChapter', turnId: fresh.id, picks: ['i1'] });
    assert.equal(fake.calls.length, 1);
    const after = await project.readChapterText(await project.getChapter(2));
    assert.ok(after.includes('作者在合并视图里加的一句。'));
    h.setReviewVerdict('apply');
  });

  test('认不出的报告：不发', async () => {
    reset(['不该被调用']);
    await controller.handle({ type: 'reviseChapter', turnId: 'no-such-turn', picks: ['i1'] });
    assert.equal(fake.calls.length, 0);
    assert.ok(toastsPosted().some((x) => /找不到这份审稿报告/.test(x)));
  });
});

describe('一致性预检', () => {
  test('细纲排了角色卡上已经死了的人：先亮一张卡，「先不写」一次模型都不调', async () => {
    reset(['不该被调用']);
    gateAnswer = 'skip';
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'write' });
    gateAnswer = 'proceed';
    assert.equal(fake.calls.length, 0);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.equal(gates[0].proceed, '仅本次忽略，照写');
    assert.equal(gates[0].skip, '先不写');
    assert.match(gates[0].danger, /沈秋的当前状态（截至第 2 章）写着「已死亡」/);
    assert.match(lastAssistant().content, /一致性预检发现 1 处问题，这一次先不写——没有调用模型/);
  });

  test('「仅本次忽略」照写', async () => {
    reset([{ text: filler(700, 40), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'write' });
    assert.equal(fake.calls.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.equal(gates[1].name, 'artifact');
  });

  test('接着写不预检', async () => {
    reset([{ text: filler(300, 41), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'continue' });
    assert.ok(gates.every((g) => g.name !== 'preflight'));
  });

  test('没排死人的章不亮卡', async () => {
    reset([{ text: filler(700, 42), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P4, action: 'write' });
    assert.ok(gates.every((g) => g.name !== 'preflight'));
  });
});

describe('定位引文', () => {
  test('宿主有 revealText：交给它', async () => {
    const seen = [];
    h.host.revealText = async (rel, quote) => {
      seen.push([rel, quote]);
      return true;
    };
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客栈.md', quote: '林昭推开' });
    assert.deepEqual(seen, [['chapters/002-客栈.md', '林昭推开']]);
    delete h.host.revealText;
  });

  test('找不到那一句：提示正文可能改过', async () => {
    h.host.revealText = async () => false;
    reset();
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客栈.md', quote: '根本没有' });
    assert.ok(toastsPosted().some((x) => /找不到了（正文可能改过）/.test(x)));
    delete h.host.revealText;
  });

  test('宿主没有 revealText：打开文件并提示那一句', async () => {
    h.opened.length = 0;
    reset();
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客栈.md', quote: '林昭推开客栈' });
    assert.deepEqual(h.opened, ['chapters/002-客栈.md'], JSON.stringify({ opened: h.opened, rt: typeof h.host.revealText }));
    assert.ok(toastsPosted().some((x) => /在编辑器里找这一句：「林昭推开客栈」/.test(x)));
  });
});
