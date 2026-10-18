/**
 * 覆盖审阅的段级 diff / 合并视图（五期 W11，独立版）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 两个版本 | 相同的段一行带过，每一处改动左右两栏 + 一格结果；顶上「已处理 k / n 处」 |
 * | 什么都不动就写入 | 交回 `apply`（原样用新版，不经段拼接） |
 * | 采用 / 保留 | 结果格跟着换，进度跟着涨 |
 * | **手改过的那一格** | 「采用新版」「保留原文」「全部采用新版」「全部保留原文」都不动它；「撤销手改」才放开 |
 * | 写入 | 交回的是合并结果（逐格拼起来） |
 * | 放弃 | 交回 `discard` |
 * | 只读模式 | 没有结果格、没有逐段按钮，底部是「采纳」 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const CURRENT = ['雨下了一整夜。', '她把那块残令收进了袖中。', '天亮时，林昭离开了青崖镇。', '他没有回头。'].join('\n\n');
const PROPOSED = ['雨下了一整夜。', '她看了一眼他空着的手，什么也没问。', '天亮时，林昭离开了青崖镇。', '他回头看了一眼客栈。'].join('\n\n');

function open(ui, extra = {}) {
  ui.post({
    type: 'prompt',
    requestId: extra.requestId ?? 'p1',
    kind: 'merge',
    title: '对比「第 2 章的正文」：现有 ↔ 新版',
    message: 'chapters/002-客栈.md',
    current: CURRENT,
    proposed: PROPOSED,
    mergeable: true,
    ...extra,
  });
}

describe('合并视图', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('mergeModal');
  const hunks = () => [...modal().querySelectorAll('.merge-hunk')];
  const result = (i) => hunks()[i].querySelector('.merge-result');
  const btn = (i, cls) => hunks()[i].querySelector(`.${cls}`);
  const progress = () => ui.doc.getElementById('mergeProgress').textContent;
  const reply = () => JSON.parse(ui.last('promptResult').value);
  const type = (area, text) => {
    area.value = text;
    area.dispatchEvent(new ui.window.Event('input'));
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('相同的段一行带过，两处改动各一块；结果格缺省是新版', () => {
    open(ui);
    assert.ok(!modal().classList.contains('hidden'));
    assert.equal(hunks().length, 2);
    assert.equal(modal().querySelectorAll('.merge-same').length, 2);
    assert.match(hunks()[0].querySelector('.merge-old').textContent, /残令/);
    assert.match(hunks()[0].querySelector('.merge-new').textContent, /空着的手/);
    assert.equal(result(0).value, '她看了一眼他空着的手，什么也没问。');
    assert.equal(progress(), '已处理 0 / 2 处');
    assert.equal(ui.doc.getElementById('mergePath').textContent, 'chapters/002-客栈.md');
  });

  test('什么都不动就写入：交回 apply，原样用新版', () => {
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.deepEqual(reply(), { verdict: 'apply' });
    assert.ok(modal().classList.contains('hidden'));
  });

  test('保留原文：结果格换成原文，进度涨；写入交回合并结果', () => {
    open(ui, { requestId: 'p2' });
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(result(0).value, '她把那块残令收进了袖中。');
    assert.equal(progress(), '已处理 1 / 2 处');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    const r = reply();
    assert.equal(r.verdict, 'apply');
    assert.equal(r.merged, ['雨下了一整夜。', '她把那块残令收进了袖中。', '天亮时，林昭离开了青崖镇。', '他回头看了一眼客栈。'].join('\n\n') + '\n');
  });

  test('手改过的那一格：采用、保留、全部采用、全部保留都不动它', () => {
    open(ui, { requestId: 'p3' });
    type(result(0), '作者自己改的一句。');
    assert.ok(hunks()[0].classList.contains('edited'));
    assert.equal(btn(0, 'merge-take-new').disabled, true);
    assert.equal(btn(0, 'merge-take-old').disabled, true);
    ui.clickEl(btn(0, 'merge-take-old'));
    ui.clickEl(ui.doc.getElementById('mergeAllOld'));
    ui.clickEl(ui.doc.getElementById('mergeAllNew'));
    assert.equal(result(0).value, '作者自己改的一句。');
    // 没手改过的那一格照常跟着「全部采用」走。
    assert.equal(result(1).value, '他回头看了一眼客栈。');
    assert.equal(progress(), '已处理 2 / 2 处');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.match(reply().merged, /作者自己改的一句。/);
  });

  test('撤销手改：放开按钮，回到当下挑的那一边', () => {
    open(ui, { requestId: 'p4' });
    type(result(0), '改了一下。');
    ui.clickEl(btn(0, 'merge-undo'));
    assert.equal(hunks()[0].classList.contains('edited'), false);
    assert.equal(btn(0, 'merge-take-old').disabled, false);
    assert.equal(result(0).value, '她看了一眼他空着的手，什么也没问。');
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(result(0).value, '她把那块残令收进了袖中。');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
    assert.deepEqual(reply(), { verdict: 'discard' });
  });

  test('结果格清空：这一处整段删掉', () => {
    open(ui, { requestId: 'p5' });
    type(result(1), '');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.doesNotMatch(reply().merged, /回头/);
    assert.match(reply().merged, /青崖镇。\n$/);
  });

  test('只读模式：没有结果格、没有逐段按钮，底部是「采纳」', () => {
    open(ui, { requestId: 'p6', mergeable: false });
    assert.equal(modal().querySelectorAll('.merge-result').length, 0);
    assert.equal(modal().querySelectorAll('.merge-take-new').length, 0);
    assert.ok(ui.doc.getElementById('mergeAllNew').classList.contains('hidden'));
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '采纳');
    assert.equal(progress(), '2 处改动');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.deepEqual(reply(), { verdict: 'apply' });
  });

  test('带两栏称呼（冲突时的对比合并）：两栏、逐处与整体的按钮、状态、采纳按钮都换说法', () => {
    open(ui, {
      requestId: 'p7',
      sides: { current: '磁盘上的', proposed: '编辑器里的' },
      applyLabel: '放回编辑器',
    });
    const h0 = hunks()[0];
    assert.equal(h0.querySelector('.merge-old .merge-side-label').textContent, '磁盘上的');
    assert.equal(h0.querySelector('.merge-new .merge-side-label').textContent, '编辑器里的');
    assert.equal(btn(0, 'merge-take-old').textContent, '用磁盘上的');
    assert.equal(btn(0, 'merge-take-new').textContent, '用编辑器里的');
    assert.equal(h0.querySelector('.merge-state').textContent, '未处理（缺省是编辑器里的）');
    assert.equal(ui.doc.getElementById('mergeAllOld').textContent, '全部用磁盘上的');
    assert.equal(ui.doc.getElementById('mergeAllNew').textContent, '全部用编辑器里的');
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '放回编辑器');
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(h0.querySelector('.merge-state').textContent, '已用磁盘上的');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
  });

  test('下一次不带称呼：回到「原文 / 新版」与「写入合并结果」', () => {
    open(ui, { requestId: 'p8' });
    assert.equal(hunks()[0].querySelector('.merge-old .merge-side-label').textContent, '原文');
    assert.equal(btn(0, 'merge-take-old').textContent, '保留原文');
    assert.equal(ui.doc.getElementById('mergeAllNew').textContent, '全部采用新版');
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '写入合并结果');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
  });
});
