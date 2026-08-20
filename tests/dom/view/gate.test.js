/**
 * 权限请求卡片：**画在对话里，不是一个盖住窗口的模态框。**
 *
 * 从前它走 `host.confirm({ modal: true })`——VS Code 里是窗口正中一个把界面
 * 锁死的框，独立版里是遮罩层弹窗。作者要判断的恰恰是「这一步动的是哪个文件」，
 * 而那串上下文（前几条工具调用、刚生成的那段话）就在被盖住的气泡里。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | `gate` 到了 | 卡片进气泡的工具串，**遮罩层一动不动** |
 * | 三颗按钮 | 字全部来自后端（工具自报的说辞），前端不写死 |
 * | 点一颗 | 发回 `gateResult`，卡片就地锁上，不能再点第二颗 |
 * | 重连重推同一条 | 不画出两张 |
 * | `gateDone` | 另一个视图上答的，这边也收 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const GATE = {
  type: 'gate',
  requestId: 'g1',
  turnId: 'a1',
  callId: 'c1',
  name: 'write',
  title: 'Agent 要写入设定「北境雪原」',
  detail: '.novelforge/lore/北境雪原.md · 新建 · 约 320 字',
  argsText: '{\n  "path": ".novelforge/lore/北境雪原.md"\n}',
  proceed: '写入',
  skip: '跳过这一步',
  stop: '停止 agent',
};

const card = (ui) => ui.bubble('a1') && ui.bubble('a1').querySelector('.tool-gate');
const buttons = (ui) => [...card(ui).querySelectorAll('button')];

function running() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '把北境那条设定补上') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  ui.post({ type: 'delta', turnId: 'a1', text: '我来写一条设定。' });
  return ui;
}

describe('权限请求画在气泡里', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
  });

  test('卡片挂在这一轮的工具串上', () => {
    assert.ok(card(ui), ui.bubble('a1').innerHTML);
    assert.ok(card(ui).closest('.tools'), card(ui).parentElement.className);
  });

  // ★ 这条测试就是这次改动本身：全局模态框不该再出现。
  test('遮罩层一动不动', () => {
    assert.ok(ui.doc.getElementById('providerModal').classList.contains('hidden'));
  });

  test('说清了要做什么、动的是哪个文件', () => {
    assert.ok(card(ui).textContent.includes('要写入设定'), card(ui).textContent);
    assert.ok(card(ui).textContent.includes('北境雪原.md'), card(ui).textContent);
  });

  test('参数收在折叠里，不摊开占满气泡', () => {
    const det = card(ui).querySelector('details.tool-gate-args');
    assert.ok(det);
    assert.equal(det.open, false);
  });

  test('三颗按钮，字来自后端', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['写入', '跳过这一步', '停止 agent']);
  });

  test('正文没被冲掉（就地插入，不重建气泡）', () => {
    assert.equal(ui.bodyOf('a1').textContent, '我来写一条设定。');
  });

  test('重连重推同一条不会画出两张', () => {
    ui.post(GATE);
    assert.equal(ui.bubble('a1').querySelectorAll('.tool-gate').length, 1);
  });

  test('认不出的 turnId 不炸', () => {
    assert.doesNotThrow(() => ui.post({ ...GATE, requestId: 'g9', turnId: '并不存在' }));
  });
});

describe('点下去', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[0]);
  });

  test('把结论发回后端', () => {
    const sent = ui.last('gateResult');
    assert.equal(sent.requestId, 'g1');
    assert.equal(sent.verdict, 'proceed');
  });

  // 后端回话之前不锁的话，作者能把三颗都点一遍，而只有第一下算数。
  test('卡片就地锁上，按钮没了', () => {
    assert.ok(card(ui).classList.contains('settled'), card(ui).className);
    assert.equal(card(ui).querySelector('button'), null);
  });

  test('留下一行说明答了什么', () => {
    assert.ok(card(ui).textContent.includes('已允许'), card(ui).textContent);
  });
});

describe('跳过与停止', { skip: JSDOM_SKIP }, () => {
  test('跳过这一步', () => {
    const ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[1]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
    assert.ok(card(ui).textContent.includes('已跳过'), card(ui).textContent);
  });

  test('停止 agent', () => {
    const ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[2]);
    assert.equal(ui.last('gateResult').verdict, 'stop');
    assert.ok(card(ui).classList.contains('declined'), card(ui).className);
  });
});

// 侧边栏与编辑器标签页挂的是同一个 controller：只在被点的那一边收卡片的话，
// 另一边会留一张点了没反应的卡。
describe('另一个视图上答了 / 这一轮被取消', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
    ui.post({ type: 'gateDone', requestId: 'g1', verdict: 'cancelled' });
  });

  test('这边的卡片也收了', () => {
    assert.ok(card(ui).classList.contains('settled'), card(ui).className);
    assert.equal(card(ui).querySelector('button'), null);
  });

  test('说的是「取消」，不是作者答的那三个', () => {
    assert.ok(card(ui).textContent.includes('已取消'), card(ui).textContent);
  });

  test('认不出的 requestId 不炸', () => {
    assert.doesNotThrow(() => ui.post({ type: 'gateDone', requestId: '并不存在', verdict: 'stop' }));
  });
});

// 单步创作（点「写剧情」）产出之后那张落盘卡片：背后没有循环可停，位置也
// 不一样——它挂在正文**下面**，作者要先读完这份产物才决定写不写。
describe('产物落盘那一张', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post({
      ...GATE,
      callId: undefined,
      stop: undefined,
      name: 'artifact',
      title: '把这份产物写入到「第 12 章《夜入青云》 · 剧情」',
      detail: '剧情 · 4/4 节',
      argsText: undefined,
      proceed: '写入',
      skip: '不采纳',
    });
  });

  test('只画两颗按钮', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['写入', '不采纳']);
  });

  // 排进工具串的话它会跑到正文上面去——那时作者还没读到这份产物。
  test('挂在正文下面，不在工具串里', () => {
    assert.equal(card(ui).closest('.tools'), null, card(ui).parentElement.className);
    const kids = [...ui.bubble('a1').children];
    assert.ok(kids.indexOf(card(ui)) > kids.findIndex((n) => n.classList.contains('msg-body')));
  });

  test('点「不采纳」照样发回结论', () => {
    ui.clickEl(buttons(ui)[1]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
  });
});
