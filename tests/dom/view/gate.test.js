/**
 * 权限请求：**固定在输入框上方那一格**，不是模态框，也不是消息流里的一张卡片。
 *
 * 最早它走 `host.confirm({ modal: true })`——VS Code 里是窗口正中一个把界面锁死
 * 的框。作者要判断的恰恰是「这一步动的是哪个文件」，而那串上下文就在被盖住的
 * 气泡里。于是改成画在对话里的一张卡片。
 *
 * 这一版把它从消息流里挪出来：挂在气泡上就会跟着内容滚——agent 随后还在说话、
 * 还在调工具，几行之后那张卡就滚出视野了，而循环正卡在它上面等回答。现在它贴
 * 在输入框上沿（`#gateDock`），不滚；答完卡片就撤，消息流里留一行记录。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | `gate` 到了 | 卡片进 `#gateDock`（输入框上方），**不进气泡**，遮罩层一动不动 |
 * | 两颗按钮 | 字全部来自后端，同意贴最右；**叫停整轮不在这张卡上** |
 * | 点一颗 | 发回 `gateResult`，卡片撤下，格子收起，消息流里补一行记录 |
 * | 重连重推同一条 | 不画出两张 |
 * | 认不出的 turnId | 卡片照样画（丢掉等于留一个没人看得见的死等） |
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
  proceed: '确认',
  skip: '跳过',
};

const dock = (ui) => ui.doc.getElementById('gateDock');
const card = (ui) => dock(ui).querySelector('.gate');
const buttons = (ui) => [...card(ui).querySelectorAll('button')];
const note = (ui) => ui.bubble('a1') && ui.bubble('a1').querySelector('.gate-note');

function running() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '把北境那条设定补上') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  ui.post({ type: 'delta', turnId: 'a1', text: '我来写一条设定。' });
  return ui;
}

describe('权限请求固定在输入框上方', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
  });

  test('卡片进输入框上方那一格，格子跟着露出来', () => {
    assert.ok(card(ui), dock(ui).innerHTML);
    assert.equal(dock(ui).classList.contains('hidden'), false);
  });

  // ★ 这一版的改动本身：它不该再挂在气泡上跟着内容滚。
  test('不在消息流里', () => {
    assert.equal(ui.bubble('a1').querySelector('.gate'), null);
    assert.equal(card(ui).closest('.messages'), null);
  });

  // 位置就是它的全部意义：在输入框**上面**，且与输入框在同一块（.composer）里。
  test('就在输入框上沿', () => {
    assert.ok(dock(ui).closest('.composer'), dock(ui).parentElement.className);
    const kids = [...dock(ui).parentElement.children];
    assert.ok(kids.indexOf(dock(ui)) < kids.findIndex((n) => n.id === 'composerInput'));
  });

  test('遮罩层一动不动', () => {
    assert.ok(ui.doc.getElementById('providerModal').classList.contains('hidden'));
  });

  test('说清了要做什么、动的是哪个文件', () => {
    assert.ok(card(ui).textContent.includes('要写入设定'), card(ui).textContent);
    assert.ok(card(ui).textContent.includes('北境雪原.md'), card(ui).textContent);
  });

  test('参数收在折叠里，不摊开把输入框顶下去', () => {
    const det = card(ui).querySelector('details.gate-args');
    assert.ok(det);
    assert.equal(det.open, false);
  });

  // 同意贴最右（离「发送」最近的那一侧就是「继续」）。叫停整轮是输入框旁边
  // 那颗「停止」，不在这张卡上——摆进闸门只会被误当成「跳过」，而两者的后果
  // 差着一整轮。
  test('两颗按钮，字来自后端，同意在最右', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['跳过', '确认']);
  });

  test('正文没被冲掉', () => {
    assert.equal(ui.bodyOf('a1').textContent, '我来写一条设定。');
  });

  test('重连重推同一条不会画出两张', () => {
    ui.post(GATE);
    assert.equal(dock(ui).querySelectorAll('.gate').length, 1);
  });

  // 卡片不再挂在气泡上，认不出的 turnId 也照样有地方画——丢掉那一张等于让
  // 循环停在一个没人看得见的等待上。
  test('认不出的 turnId 照样画得出来', () => {
    ui.post({ ...GATE, requestId: 'g9', turnId: '并不存在' });
    assert.equal(dock(ui).querySelectorAll('.gate').length, 2);
  });

  // 一格里叠着好几张时，作者得知道自己在答哪一张。
  test('叠了两张才编号', () => {
    assert.deepEqual(
      [...dock(ui).querySelectorAll('.gate-count')].map((n) => n.textContent),
      ['1 / 2', '2 / 2']
    );
  });
});

describe('点下去', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[1]);
  });

  test('把结论发回后端', () => {
    const sent = ui.last('gateResult');
    assert.equal(sent.requestId, 'g1');
    assert.equal(sent.verdict, 'proceed');
  });

  // 后端回话之前不撤的话，作者能把两颗都点一遍，而只有第一下算数。
  test('卡片撤下，格子空了就收起来', () => {
    assert.equal(card(ui), null);
    assert.ok(dock(ui).classList.contains('hidden'));
  });

  // 紧跟着的那条工具条只会说「未执行」，「因为我按了跳过」得有地方讲。
  test('消息流里留一行记录，排在工具串里', () => {
    assert.ok(note(ui), ui.bubble('a1').innerHTML);
    assert.ok(note(ui).textContent.includes('已允许'), note(ui).textContent);
    assert.ok(note(ui).textContent.includes('要写入设定'), note(ui).textContent);
    assert.ok(note(ui).closest('.tools'), note(ui).parentElement.className);
  });

  // 后端随后会广播 gateDone（两个视图都要收卡）——这边已经答过了，不能再补一行。
  test('后端广播回来不再补第二行', () => {
    ui.post({ type: 'gateDone', requestId: 'g1', verdict: 'proceed' });
    assert.equal(ui.bubble('a1').querySelectorAll('.gate-note').length, 1);
  });
});

describe('跳过', { skip: JSDOM_SKIP }, () => {
  test('发回 skip，并标成「拒绝了」那一档', () => {
    const ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[0]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
    assert.ok(note(ui).textContent.includes('已跳过'), note(ui).textContent);
    assert.ok(note(ui).classList.contains('declined'), note(ui).className);
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
    assert.equal(card(ui), null);
    assert.ok(dock(ui).classList.contains('hidden'));
  });

  test('说的是「取消」，不是作者答的那两个', () => {
    assert.ok(note(ui).textContent.includes('已取消'), note(ui).textContent);
  });

  test('没往后端发东西——不是作者答的', () => {
    assert.equal(ui.last('gateResult'), undefined);
  });

  test('认不出的 requestId 不炸', () => {
    assert.doesNotThrow(() => ui.post({ type: 'gateDone', requestId: '并不存在', verdict: 'skip' }));
  });
});

// 产出之后那张落盘卡片：拒绝那颗写的不是「跳过」而是「不采纳」（这一问不是
// 「跳过一步」，是「这份产物我不要」），答完那一行也挂在正文**下面**——那份
// 产物就是作者做判断的依据。
describe('产物落盘那一张', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post({
      ...GATE,
      callId: undefined,
      name: 'artifact',
      title: '把这份产物写入到「第 12 章《夜入青云》 · 剧情」',
      detail: '剧情 · 4/4 节',
      argsText: undefined,
      proceed: '确认',
      skip: '不采纳',
    });
  });

  test('拒绝那颗写「不采纳」', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['不采纳', '确认']);
  });

  test('点「不采纳」照样发回结论', () => {
    ui.clickEl(buttons(ui)[0]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
  });

  // 排进工具串的话它会跑到正文上面去——那一行说的是「这份产物没落地」。
  test('那一行记录挂在正文下面，不在工具串里', () => {
    assert.equal(note(ui).closest('.tools'), null, note(ui).parentElement.className);
    const kids = [...ui.bubble('a1').children];
    assert.ok(kids.indexOf(note(ui)) > kids.findIndex((n) => n.classList.contains('msg-body')));
  });
});
