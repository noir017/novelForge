/**
 * 写正文那张落盘卡片（W7 的后端一半）：卡片上说清写了多长、是不是追加、有没有重演上一章结尾；
 * 写的过程中推进度，丢弃一轮时让气泡退回去。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 「x / y 字 · 已达标 / 未写够」 | 作者点写入之前就该知道这一章够不够长（D6） |
 * | 续写了几轮、一共调了几次 | 第 4 条：钱花在哪要看得见 |
 * | 接着写的卡片说「追加」，写明已有与新写各多少 | 点下去之后这一章是多长 |
 * | 重演：gate 带红色块与两段式确认 | 不替作者拒收，但不能让他一下点过去（总计划 §2.4） |
 * | 写的过程中推 `writeProgress` | 气泡顶上那条进度（W7） |
 * | 丢弃一轮时推 `streamReset` | 气泡里不留一段不会被写入的文字 |
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
let gates = [];
let script = [];

const P2 = '.novelforge/plots/002-客栈.md';
const P3 = '.novelforge/plots/003-夜访.md';
const P4 = '.novelforge/plots/004-井.md';

const CH1_END =
  '客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空，半晌才说了一句：“李叔来过，问你去了哪里，我说你出城收账去了。”林昭没有答话，把湿透的斗篷挂在门后，从灶上端下那碗早就凉了的姜汤，一口一口喝完。';

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

async function send(plotRelPath, replies, extra = {}) {
  script = [...replies];
  posted = [];
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '',
      stage: 'manuscript',
      capability: 'generate',
      target: { kind: 'manuscript', plotRelPath },
      targetNo: 0,
      attachments: [],
      excludedIds: [],
      ...extra,
    },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    gate: gates[0],
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    progress: posted.filter((m) => m.type === 'writeProgress'),
    resets: posted.filter((m) => m.type === 'streamReset'),
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
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  installFakeProvider(bundle.registry, {
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'write-card', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  for (const [no, title] of [[1, '夜入青云'], [2, '客栈'], [3, '夜访'], [4, '井']]) {
    await ws.writePlot({
      no, title, role: '', characters: [], targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...empty, 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章的关键事件`, 章末钩子: `第 ${no} 章的钩子` },
    });
  }
  await ws.createChapter(1, '夜入青云', `${filler(900, 1)}\n\n${CH1_END}`);
  await ws.createChapter(3, '夜访', filler(300, 3));
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('写第 2 章：截断续写一轮，开头重演了上一章结尾', () => {
  let r;
  before(async () => {
    r = await send(P2, [
      { text: `${CH1_END}\n\n${filler(700, 20)}`, stop: 'maxTokens', chunks: 4 },
      { text: filler(400, 21), stop: 'end' },
    ]);
  });

  test('卡片写明字数与达标', () => {
    assert.match(r.gate.detail, /\d+ \/ 1000 字 · 已达标/);
  });

  test('卡片写明续写了几轮、一共调了几次', () => {
    assert.match(r.gate.detail, /这一轮一共调了 2 次模型（续写 1 轮）/);
  });

  test('重演：红色块写明重合的原句，写入要点两下', () => {
    assert.match(r.gate.danger, /与上一章结尾大段重合/);
    assert.match(r.gate.danger, /沈氏坐在柜台后面/);
    assert.equal(r.gate.confirm, '确定仍要写入');
  });

  test('气泡上的记录也带着字数与重演', () => {
    assert.equal(r.assistant.artifact.length.target, 1000);
    assert.ok(r.assistant.artifact.replay.includes('沈氏'));
  });

  test('写的过程中推进度：第 0 轮起，报到第 1 轮', () => {
    assert.ok(r.progress.length >= 2, String(r.progress.length));
    assert.equal(r.progress[0].round, 0);
    assert.ok(r.progress.some((p) => p.round === 1));
    assert.ok(r.progress.every((p) => p.target === 1000 && p.turnId === r.assistant.id));
  });
});

describe('接着写第 3 章：卡片说「追加」', () => {
  let r;
  before(async () => {
    r = await send(P3, [{ text: filler(600, 30), stop: 'end' }], { writeMode: 'continue' });
  });

  test('标题说追加，不说覆盖', () => {
    assert.ok(r.gate.title.includes('追加到'), r.gate.title);
  });

  test('写明已有多少、这一次新写多少', () => {
    assert.match(r.gate.detail, /900 \/ 1000 字 · 已达标（已有 300 字，这一次新写 600 字，追加在末尾）/);
  });

  test('没有重演的红色块', () => {
    assert.equal(r.gate.danger, undefined);
    assert.equal(r.gate.confirm, undefined);
  });

  test('追加进了磁盘', () => {
    const text = t.read('chapters/003-夜访.md');
    assert.ok(text.includes(filler(300, 3)) && text.includes(filler(600, 30)));
  });
});

describe('写第 4 章：丢弃一轮、最后未写够', () => {
  let r;
  before(async () => {
    r = await send(P4, [
      { text: filler(400, 40), stop: 'end' },
      { text: filler(50, 41), stop: 'maxTokens' },
      { text: filler(60, 42), stop: 'maxTokens' },
    ]);
  });

  test('丢弃那一轮时推了 streamReset，退回到丢弃之前那一版', () => {
    assert.ok(r.resets.length >= 1);
    assert.equal(r.resets[0].text, filler(400, 40));
  });

  test('卡片写「未写够」，照样问写不写', () => {
    assert.ok(r.gate);
    assert.match(r.gate.detail, /400 \/ 1000 字 · 未写够/);
  });
});
