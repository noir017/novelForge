/**
 * 装配清单摘要行上的「复制完整上下文」（前端一半）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 留着完整消息的回复才有这颗按钮 | 功能加上之前的回复只存了清单，给一颗点了必失败的按钮是骗人 |
 * | 点它发 `copyContext`，折叠块不跟着开合 | 一下就够；按钮长在 `<summary>` 里，点它不该顺带把清单打开 |
 * | 只认自己发的那个 `requestId` | 回复是广播，侧栏与编辑器标签页都收得到，两边都写剪贴板会弹两次提示 |
 * | 写进剪贴板的是后端给的那份，一个字不动 | 复制出去的就是发给模型的那份 |
 * | 后端说拿不到就报那一句 | 不假装复制成功 |
 * | 剪贴板不让写时给「再点一下复制」 | 中间隔着一趟来回，WebKit 可能不认那一下点击；再点一下是新的点击 |
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const digest = {
  usedTokens: 1200,
  budget: 100000,
  clamped: false,
  detail: 3,
  items: [{ id: 'style', label: '文风指南', kind: 'style', priority: 0, tokens: 1200, status: 'included' }],
};

const FULL = '【完整上下文】估算 1200 / 100000 token · 详细度：详细 · 2 条消息\n\n━━━━━━━━ system ━━━━━━━━\n你是作者。';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('复制完整上下文', { skip: JSDOM_SKIP }, () => {
  let ui;
  /** 每次 writeText 写了什么；`reject` 置真时假装浏览器不让写。 */
  let written;
  let reject;

  const copyBtn = (id) => ui.bubble(id)?.querySelector('details.ctx > summary .ctx-copy') ?? null;
  const toast = () => ui.doc.getElementById('toast');
  const lastCopy = () => ui.last('copyContext');

  before(() => {
    ui = mount();
    ui.window.navigator.clipboard = {
      writeText: (text) => {
        written.push(text);
        return reject ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
    };
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '这一版', { context: digest, fullContext: true }) });
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '老会话里的一版', { context: digest }) });
  });

  beforeEach(() => {
    written = [];
    reject = false;
  });

  test('留着完整消息的回复：摘要行末尾有按钮', () => {
    assert.equal(copyBtn('a1')?.textContent, '复制完整上下文');
  });

  test('只存了清单的老回复：没有按钮，清单照旧', () => {
    assert.equal(copyBtn('a2'), null);
    assert.ok(ui.bubble('a2').querySelector('details.ctx'));
  });

  test('点它发 copyContext，折叠块不开合', () => {
    const det = ui.bubble('a1').querySelector('details.ctx');
    ui.clickEl(copyBtn('a1'));
    const msg = lastCopy();
    assert.equal(msg.turnId, 'a1');
    assert.ok(msg.requestId);
    assert.equal(det.open, false);
  });

  test('别的视图点的（requestId 对不上）：不写剪贴板', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: '另一个视图', text: FULL });
    await tick();
    assert.deepEqual(written, []);
  });

  test('自己点的：原样写进剪贴板，提示已复制', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, text: FULL });
    await tick();
    assert.deepEqual(written, [FULL]);
    assert.match(toast().textContent, /^已复制完整上下文/);
  });

  test('同一个回复只认一次', async () => {
    ui.clickEl(copyBtn('a1'));
    const requestId = lastCopy().requestId;
    ui.post({ type: 'contextText', requestId, text: FULL });
    ui.post({ type: 'contextText', requestId, text: FULL });
    await tick();
    assert.equal(written.length, 1);
  });

  test('后端说拿不到：报那一句，不碰剪贴板', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, error: '这一轮没有留下完整上下文。' });
    await tick();
    assert.deepEqual(written, []);
    assert.equal(toast().textContent, '这一轮没有留下完整上下文。');
    assert.ok(toast().classList.contains('error'));
  });

  test('剪贴板不让写：给「再点一下复制」，点了再写一次', async () => {
    reject = true;
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, text: FULL });
    await tick();
    const again = toast().querySelector('.toast-action');
    assert.equal(again?.textContent, '再点一下复制');

    reject = false;
    ui.clickEl(again);
    await tick();
    assert.deepEqual(written, [FULL, FULL]);
    assert.match(toast().textContent, /^已复制完整上下文/);
  });
});
