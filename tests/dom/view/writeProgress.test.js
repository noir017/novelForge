/**
 * 写章过程可见（W7）：写正文时气泡顶上的进度、丢弃一轮时气泡退回、写入卡的重演红块与两段式
 * 写入、气泡上留下的字数记录、主按钮把写法带给后端。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | `writeProgress` | 「正在写 / 续写第 k 轮 · 已写 x / 目标 y 字」+ 进度条；到八成换色 |
 * | 没有目标字数 | 只报字数，进度条来回扫 |
 * | `streamReset` | 正文退回到那一份，进度条不动 |
 * | 收尾的 turnDone | 进度条随气泡重建消失；字数记录留在气泡上 |
 * | gate 带 `danger` + `confirm` | 红色块；「写入」点一下只换字，第二下才发 `gateResult` |
 * | 没有 `confirm` | 一下就发（别的卡不受影响） |
 * | 主按钮「接着写」 | 发出去的 send 带 `writeMode: 'continue'` |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, pipelineView, workbenchView } = require('../../helpers/dom');

function writing() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  return ui;
}

const progress = (ui) => ui.bubble('a1')?.querySelector('.write-progress');
const label = (ui) => progress(ui)?.querySelector('.write-progress-label').textContent;
const fill = (ui) => progress(ui)?.querySelector('.write-progress-fill').style.width;

describe('写正文的进度', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = writing();
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 0, target: 3000 });
    ui.post({ type: 'delta', turnId: 'a1', text: '雨下了三天。' });
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 1200, target: 3000 });
  });

  test('第一次调用：正在写 · 已写 x / 目标 y 字', () => {
    assert.equal(label(ui), '正在写 · 已写 1200 / 目标 3000 字');
    assert.equal(fill(ui), '40%');
  });

  test('进度条排在正文前面', () => {
    const node = ui.bubble('a1');
    const bar = progress(ui);
    const body = node.querySelector('.msg-body');
    assert.ok(bar.compareDocumentPosition(body) & ui.window.Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('没到八成不算达标', () => {
    assert.ok(!progress(ui).classList.contains('reached'));
  });

  test('续写那几轮：续写第 k 轮；到了八成换色', () => {
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 2, words: 2500, target: 3000 });
    assert.equal(label(ui), '续写第 2 轮 · 已写 2500 / 目标 3000 字');
    assert.ok(progress(ui).classList.contains('reached'));
  });

  test('只有一条进度，就地更新', () => {
    assert.equal(ui.bubble('a1').querySelectorAll('.write-progress').length, 1);
  });

  test('丢弃一轮：正文退回，进度条不动', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '这一轮会被丢掉。' });
    ui.post({ type: 'streamReset', turnId: 'a1', text: '雨下了三天。' });
    assert.equal(ui.bodyOf('a1').textContent, '雨下了三天。');
    assert.ok(progress(ui));
  });

  test('收尾的 turnDone：进度条随气泡重建消失，字数记录留在气泡上', () => {
    ui.post({ type: 'busy', value: false });
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '雨下了三天。', {
        artifact: {
          where: '第 3 章《夜访》 · 正文',
          summary: '正文 · 2500 字',
          overwrites: false,
          length: { words: 2500, target: 3000, added: 2500, rounds: 2, reached: true },
        },
      }),
    });
    assert.equal(progress(ui), null);
    const len = ui.bubble('a1').querySelector('.artifact-length');
    assert.equal(len.textContent, '2500 / 3000 字 · 已达标');
    assert.ok(!len.classList.contains('short'));
  });
});

describe('没有目标字数', { skip: JSDOM_SKIP }, () => {
  test('只报字数，进度条来回扫', () => {
    const ui = writing();
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 800 });
    assert.equal(label(ui), '正在写 · 已写 800 字');
    assert.ok(progress(ui).classList.contains('indeterminate'));
  });
});

describe('气泡上的记录：未写够与重演', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '正文', {
        artifact: {
          where: '第 3 章 · 正文',
          summary: '正文 · 1500 字',
          overwrites: false,
          declined: true,
          append: true,
          length: { words: 1500, target: 3000, added: 900, rounds: 0, reached: false },
          replay: '沈氏坐在柜台后面',
        },
      }),
    });
  });

  test('未写够用警示色，写明已有与新写', () => {
    const len = ui.bubble('a1').querySelector('.artifact-length');
    assert.ok(len.classList.contains('short'));
    assert.match(len.textContent, /1500 \/ 3000 字 · 未写够.*已有 600 字，这一次新写 900 字/);
  });

  test('重演标红，悬停看得到重合的原句', () => {
    const flag = ui.bubble('a1').querySelector('.artifact-replay');
    assert.equal(flag.textContent, '开头与上一章结尾重合');
    assert.equal(flag.title, '沈氏坐在柜台后面');
  });
});

describe('写入卡：重演时红色块与两段式写入', { skip: JSDOM_SKIP }, () => {
  let ui;
  const GATE = {
    type: 'gate',
    requestId: 'g1',
    turnId: 'a1',
    name: 'artifact',
    title: '把这份产物写入到「第 4 章《井》 · 正文」',
    detail: '正文 · 2980 字\n2980 / 3000 字 · 已达标',
    proceed: '确认',
    skip: '不采纳',
    danger: '开头与上一章结尾大段重合，可能把上一章最后一场又演了一遍：\n「沈氏坐在柜台后面」',
    confirm: '确定仍要写入',
  };
  const card = () => ui.doc.querySelector('#gateDock .gate');
  const proceedBtn = () => card().querySelector('.gate-actions button.primary');
  const results = () => ui.sent.filter((m) => m.type === 'gateResult');

  before(() => {
    ui = writing();
    ui.post(GATE);
  });

  test('红色块写着重合的原句，整张卡标成警示', () => {
    assert.match(card().querySelector('.gate-danger').textContent, /沈氏坐在柜台后面/);
    assert.ok(card().classList.contains('gate-warn'));
  });

  test('第一下只换字，不发', () => {
    ui.clickEl(proceedBtn());
    assert.equal(results().length, 0);
    assert.equal(proceedBtn().textContent, '确定仍要写入');
    assert.ok(card(), '卡片还在');
  });

  test('第二下才发 gateResult', () => {
    ui.clickEl(proceedBtn());
    assert.equal(results().length, 1);
    assert.equal(results()[0].verdict, 'proceed');
  });

  test('不采纳一下就发', () => {
    ui.post({ ...GATE, requestId: 'g2' });
    ui.clickEl(card().querySelector('.gate-actions button.secondary'));
    assert.equal(results().at(-1).verdict, 'skip');
  });

  test('没有 confirm 的卡：写入一下就发', () => {
    const plain = { ...GATE, requestId: 'g3', danger: undefined, confirm: undefined };
    ui.post(plain);
    assert.equal(card().querySelector('.gate-danger'), null);
    ui.clickEl(proceedBtn());
    assert.equal(results().at(-1).requestId, 'g3');
  });
});

describe('主按钮「接着写」把写法带给后端', { skip: JSDOM_SKIP }, () => {
  test('send 带 writeMode: continue', () => {
    const ui = mount();
    const PLOT = '.novelforge/plots/012-夜入青云.md';
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'manuscript', plotRelPath: PLOT }, stage: 'manuscript', capability: 'discuss' }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ chapter: { exists: true, relPath: 'chapters/012-夜入青云.md', words: 900, targetWords: 3000, upstreamStale: false } }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青云》' }),
      next: {
        stage: 'manuscript',
        capability: 'generate',
        label: '接着写',
        hint: '第 12 章写了 900 字，还没写够（约 38%）。',
        target: { kind: 'manuscript', plotRelPath: PLOT },
        no: 12,
        writeMode: 'continue',
        calls: { low: 1, high: 1, max: 8, why: '没写够时自动续写，最多再续 7 轮' },
      },
    });
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('nextStepBtn'));
    const sent = ui.last('send');
    assert.equal(sent?.payload.writeMode, 'continue', JSON.stringify(sent));
  });
});
