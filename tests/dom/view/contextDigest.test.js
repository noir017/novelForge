/**
 * 装配清单的摘要行点名上下文详细度：作者回看某一轮时知道它是按哪一级装的。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 带 `detail` 的摘要行末尾写「详细度：精简」 | 级别是全局设置，改过之后，老气泡上得看得出当时按哪一级 |
 * | 没有 `detail`（这个开关出现之前存下的会话）就不说 | 不编一个出来 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const digest = (extra) => ({
  usedTokens: 1200,
  budget: 100000,
  clamped: false,
  items: [{ id: 'style', label: '文风指南', kind: 'style', priority: 0, tokens: 1200, status: 'included' }],
  ...extra,
});

describe('装配清单：上下文详细度', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '第一版') });
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '老会话里的一版') });
    ui.post({ type: 'context', turnId: 'a1', digest: digest({ detail: 1 }) });
    ui.post({ type: 'context', turnId: 'a2', digest: digest() });
  });

  test('带级别的写「详细度：精简」', () => {
    const text = [...ui.doc.querySelectorAll('details.ctx summary')].map((s) => s.textContent);
    assert.equal(text.length, 2, text.join(' | '));
    assert.match(text[0], /· 1 项 · 详细度：精简$/);
  });

  test('没有级别的不说', () => {
    const text = [...ui.doc.querySelectorAll('details.ctx summary')].map((s) => s.textContent);
    assert.doesNotMatch(text[1], /详细度/);
  });
});
