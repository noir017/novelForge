/**
 * 权限询问的收发（`controller/gate.ts`）：**那一句问变成对话里的一张卡片。**
 *
 * 两种问法共用这一条路：agent 动手前的闸门（三颗按钮），以及产物落盘前那一句
 * （单步创作那条路只有两颗——那里没有循环可停）。
 *
 * 判定（问不问、问什么）在 `policy.test.js`；这里守的是「问出去之后」那几件
 * 一旦做错就会挂住整条循环的事：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 推一条 `gate` | 卡片的身份、按钮上的字都从后端来 |
 * | 作者答了 | Promise 落地，并**广播** `gateDone`（两个视图都要收卡） |
 * | 答第二次 | 不算数，也不会再广播一条 |
 * | 认不出的 requestId | 静默丢弃，不抛 |
 * | 重连 | 还没答的原样再推一遍——前端无状态，不重推就没人看得见它在等 |
 * | 取消 | 按「停止」结算，不留一个永远悬着的 Promise |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { askGate, cancelGates, resolveGate, resendGates } = loadModule('src/core/controller/gate.ts');

/** controller 的替身：这一层只用到 `post` 与 `gates` 两样。 */
function fakeController() {
  return { posted: [], gates: new Map(), post(m) { this.posted.push(m); } };
}

const ASK = {
  turnId: 'a1',
  callId: 'c1',
  name: 'write',
  title: 'Agent 要写入设定「北境雪原」',
  detail: '.novelforge/lore/北境雪原.md · 新建',
  argsText: '{ "path": "…" }',
};

const gateMsg = (c) => c.posted.find((m) => m.type === 'gate');
const doneMsgs = (c) => c.posted.filter((m) => m.type === 'gateDone');

describe('问出去', () => {
  const c = fakeController();
  const pending = askGate(c, ASK, new AbortController().signal);

  test('推了一条 gate', () => {
    assert.ok(gateMsg(c), JSON.stringify(c.posted));
  });

  test('带着这一轮的气泡与这一次的调用', () => {
    assert.equal(gateMsg(c).turnId, 'a1');
    assert.equal(gateMsg(c).callId, 'c1');
  });

  // 两颗字都与循环里判定用的是同一份常量。前端各写一遍的话，改了文案两边
  // 就对不上。
  test('两颗按钮上的字都从后端来', () => {
    assert.equal(gateMsg(c).proceed, '确认');
    assert.equal(gateMsg(c).skip, '跳过');
    assert.equal(gateMsg(c).stop, undefined);
  });

  test('等着回答（还没落地）', async () => {
    const race = await Promise.race([pending, Promise.resolve('还在等')]);
    assert.equal(race, '还在等');
  });

  test('答了就落地', async () => {
    resolveGate(c, gateMsg(c).requestId, 'skip');
    assert.equal(await pending, 'skip');
  });

  // 两个视图挂同一个 controller：只在被点的那一边收卡，另一边会留一张
  // 点了没反应的卡。
  test('广播了一条「这张卡可以收了」', () => {
    assert.equal(doneMsgs(c).length, 1, JSON.stringify(doneMsgs(c)));
    assert.equal(doneMsgs(c)[0].verdict, 'skip');
  });

  test('答完就从表里摘掉了', () => {
    assert.equal(c.gates.size, 0);
  });

  test('再答一次不算数，也不再广播', () => {
    resolveGate(c, gateMsg(c).requestId, 'proceed');
    assert.equal(doneMsgs(c).length, 1);
  });
});

test('认不出的 requestId 静默丢弃', () => {
  const c = fakeController();
  assert.doesNotThrow(() => resolveGate(c, '并不存在', 'proceed'));
  assert.equal(c.posted.length, 0);
});

test('同一时刻问两次，两张卡各有各的身份', async () => {
  const c = fakeController();
  const a = askGate(c, ASK, new AbortController().signal);
  const b = askGate(c, { ...ASK, callId: 'c2' }, new AbortController().signal);
  const ids = c.posted.filter((m) => m.type === 'gate').map((m) => m.requestId);
  assert.equal(new Set(ids).size, 2, ids.join(' '));
  resolveGate(c, ids[0], 'proceed');
  resolveGate(c, ids[1], 'skip');
  assert.deepEqual(await Promise.all([a, b]), ['proceed', 'skip']);
});

// 前端无状态：网页刷新后卡片全没了，不重推的话循环就停在一个谁也看不见的
// 等待上，界面只剩一个转不完的忙碌标记。
describe('重连', () => {
  const c = fakeController();
  askGate(c, ASK, new AbortController().signal);
  const first = gateMsg(c);
  c.posted.length = 0;

  test('还没答的原样再推一遍', () => {
    resendGates(c);
    assert.equal(c.posted.length, 1);
    assert.equal(c.posted[0].requestId, first.requestId);
    assert.equal(c.posted[0].title, first.title);
  });

  test('答过的不再推', () => {
    resolveGate(c, first.requestId, 'proceed');
    c.posted.length = 0;
    resendGates(c);
    assert.equal(c.posted.length, 0);
  });
});

describe('取消', () => {
  test('作者点停止时按「停止」结算，不留悬着的 Promise', async () => {
    const c = fakeController();
    const abort = new AbortController();
    const pending = askGate(c, ASK, abort.signal);
    abort.abort();
    assert.equal(await pending, 'stop');
    // 说法是「取消」而不是作者答的那三个——他并没有按下任何一颗。
    assert.equal(doneMsgs(c)[0].verdict, 'cancelled');
  });

  test('已经取消了的 signal 也不会挂住', async () => {
    const c = fakeController();
    const abort = new AbortController();
    abort.abort();
    assert.equal(await askGate(c, ASK, abort.signal), 'stop');
  });
});

// 落盘那一问的拒绝那颗写「不采纳」——那不是「跳过一步」，是「这份产物我不要」。
// 叫停整轮任何时候都不在这张卡上（那是输入框旁边那颗「停止」）。
test('调用方能改按钮上的字，但改不出第三颗', () => {
  const c = fakeController();
  askGate(c, { ...ASK, skip: '不采纳' });
  assert.equal(gateMsg(c).proceed, '确认');
  assert.equal(gateMsg(c).skip, '不采纳');
  assert.equal(Object.keys(gateMsg(c)).includes('stop'), false, JSON.stringify(gateMsg(c)));
});

// 落盘那张卡没有 signal（生成早结束了、锁也放了）。作者不理它、直接开了
// 下一轮或换了会话时，它不该还留着——点下去写的是一份他已经翻篇的产物。
describe('cancelGates', () => {
  test('把还没答的全按「取消」收掉', async () => {
    const c = fakeController();
    const pending = askGate(c, ASK);
    cancelGates(c);
    assert.equal(await pending, 'stop');
    assert.equal(doneMsgs(c)[0].verdict, 'cancelled');
    assert.equal(c.gates.size, 0);
  });

  test('没有等着的时候什么也不做', () => {
    const c = fakeController();
    assert.doesNotThrow(() => cancelGates(c));
    assert.equal(c.posted.length, 0);
  });
});
