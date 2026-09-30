/**
 * 角色行上的「当前状态」（四期，D15）：写到第几章了，以及定稿时作者改过、没被覆盖的那一版的对比入口。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 说明里写「状态截至第 K 章」 | 写下一章前一眼看得出状态跟没跟上 |
 * | 挂着 `cardState` 的卡右键多一项「对比第 N 章给出的状态…」，点了发 reviewState | D15：改过的不写，但给入口 |
 * | 没挂的卡没有这一项 | 别给一个点了只会说「没有待对比的」的菜单 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LIN = '.novelforge/characters/林昭.md';

describe('角色行 · 当前状态', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rowOf = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.querySelector('.row-label')?.textContent === name);

  before(() => {
    ui = mount();
    const tree = sampleTree();
    tree.characters = [
      ...tree.characters.map((n) => (n.relPath === LIN ? { ...n, detail: '主角 · 状态截至第 3 章' } : n)),
      { kind: 'file', label: '沈氏', relPath: '.novelforge/characters/沈氏.md', detail: '' },
    ];
    tree.failures = {
      [LIN]: [
        {
          at: '2026-09-30T00:00:00Z',
          severity: 'warn',
          op: 'cardState',
          message: '第 3 章定稿给出了新的「当前状态」，这一节你改过，没有覆盖',
          detail: '【第 3 章给出的当前状态】\n往北去了',
        },
      ],
    };
    ui.post({ type: 'project', tree });
  });

  test('说明里写着状态截至第几章，挂着黄 ❗', () => {
    const row = rowOf('林昭');
    assert.ok(row, ui.doc.getElementById('projectBody').textContent.slice(0, 300));
    assert.ok(row.textContent.includes('状态截至第 3 章'), row.textContent);
    assert.ok(row.querySelector('.row-failure.is-warn'));
  });

  test('右键多一项「对比第 3 章给出的状态…」，点了发 reviewState', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('林昭')));
    assert.ok(items.includes('对比第 3 章给出的状态…'), JSON.stringify(items));
    ui.closeMenu();
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('林昭')), '对比第 3 章给出的状态…');
    const msg = ui.last('characterAction');
    assert.equal(msg?.action, 'reviewState', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, LIN);
  });

  test('没挂的卡没有这一项', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('沈氏')));
    assert.ok(!items.some((x) => x.startsWith('对比第')), JSON.stringify(items));
    ui.closeMenu();
  });
});
