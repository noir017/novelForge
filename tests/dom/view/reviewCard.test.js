/**
 * 审稿报告卡（五期 W10）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 审稿那一轮 | 画报告卡，不画可就地编辑的正文 |
 * | 分组与计数 | 目标核对在前，严重 / 建议分组，通过与丢掉的意见折叠 |
 * | 缺省勾选 | 严重、建议、未完成勾上；待核实不勾；已完成没有勾 |
 * | 勾选数进按钮 | 「按勾选的 n 条修稿」，提示里写调用次数；0 条禁用 |
 * | 点引文 | 发 `revealQuote`，带正文路径与那一句 |
 * | 点修稿 | 发 `reviseChapter`，只带勾选的 id |
 * | 气泡重建 | 勾选状态不丢（界面状态留在前端） |
 * | 正在生成 | 修稿按钮禁用 |
 * | 用户气泡 | `/按审稿修稿` 下面列出勾了哪几条 |
 * | 编辑问题（五期补遗 §3） | 表里能改能加，模型给的不能删；重建不丢；保存发 `editReview`；推回后作者加的缺省勾上 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const REPORT = {
  chapterNo: 2,
  chapterTitle: '客栈',
  chapterRelPath: 'chapters/002-客栈.md',
  chapterHash: 'h',
  summary: '一处硬伤',
  issues: [
    { id: 'i1', category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已经交出去了' },
    { id: 'i2', category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '左臂有伤却动作如常' },
  ],
  passes: [{ category: '前后章节串联', description: '接得上' }],
  goals: [
    { id: 'g1', kind: 'event', text: '林昭回到客栈', status: 'completed', judgment: '回到了', quotes: ['林昭推开客栈的门'] },
    { id: 'g2', kind: 'event', text: '林昭当晚离开', status: 'unmet', judgment: '他说明天走', quotes: ['天一亮就走'] },
    { id: 'g3', kind: 'hook', text: '门外有人敲门', status: 'unknown', judgment: '没写到', quotes: [] },
  ],
  coverage: 'complete',
  dropped: [{ category: '角色状态', severity: 'warning', description: '编的', quote: '林昭拔剑', why: '引文在正文里找不到' }],
};

const reviewTurn = () =>
  turn('a1', 'assistant', '# 第 2 章《客栈》审稿', {
    review: { report: REPORT, picks: ['i1', 'i2', 'g2'], notes: ['丢掉 1 条引文站不住的意见'], calls: 1 },
  });

describe('审稿报告卡', { skip: JSDOM_SKIP }, () => {
  let ui;
  const card = () => ui.bubble('a1').querySelector('.review-card');
  const box = (id) => card().querySelector(`input[data-pick="${id}"]`);
  const submit = () => card().querySelector('.review-submit');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '', { command: '审稿' }) });
    ui.post({ type: 'turnDone', turn: reviewTurn() });
  });

  test('画报告卡，不画可就地编辑的正文', () => {
    assert.ok(card());
    assert.equal(ui.bubble('a1').querySelector('.msg-body'), null);
  });

  test('头部：第几章与一句话概括', () => {
    assert.match(card().querySelector('.review-title').textContent, /审稿 · 第 2 章《客栈》/);
    assert.equal(card().querySelector('.review-counts').textContent, '1 严重 · 1 建议 · 目标 1/3 已完成（1 项待核实）');
    assert.equal(card().querySelector('.review-summary').textContent, '一处硬伤');
  });

  test('分组：目标在前，严重、建议各一组；通过、丢掉的、说明折叠', () => {
    const titles = [...card().querySelectorAll('.review-section-title')].map((n) => n.textContent);
    assert.match(titles[0], /^本章目标/);
    assert.deepEqual(titles.slice(1), ['严重（1）', '建议（1）']);
    const folded = [...card().querySelectorAll('.review-folded summary')].map((n) => n.textContent);
    assert.deepEqual(folded, ['通过（1）', '丢掉的意见（1，引文站不住）', '说明（1）']);
  });

  test('缺省勾选：严重、建议、未完成勾上；待核实不勾；已完成没有勾', () => {
    assert.equal(box('i1').checked, true);
    assert.equal(box('i2').checked, true);
    assert.equal(box('g2').checked, true);
    assert.equal(box('g3').checked, false);
    assert.equal(box('g1'), null);
  });

  test('按钮写勾了几条；提示里写调用次数', () => {
    assert.equal(submit().textContent, '按勾选的 3 条修稿');
    assert.match(submit().title, /预计 1 次调用，最多 4 次/);
  });

  test('点引文：发 revealQuote', () => {
    const q = [...card().querySelectorAll('.review-quote')].find((n) => n.textContent.includes('残令'));
    ui.clickEl(q);
    const sent = ui.last('revealQuote');
    assert.deepEqual({ relPath: sent.relPath, quote: sent.quote }, { relPath: 'chapters/002-客栈.md', quote: '她把那块残令收进了袖中' });
  });

  test('改勾选之后按钮跟着变；点修稿只带勾选的 id', () => {
    box('i2').checked = false;
    box('i2').dispatchEvent(new ui.window.Event('change'));
    box('g3').checked = true;
    box('g3').dispatchEvent(new ui.window.Event('change'));
    assert.equal(submit().textContent, '按勾选的 3 条修稿');
    ui.clickEl(submit());
    assert.deepEqual([...ui.last('reviseChapter').picks].sort(), ['g2', 'g3', 'i1']);
  });

  test('气泡重建：勾选状态不丢', () => {
    ui.post({ type: 'turnDone', turn: reviewTurn() });
    assert.equal(box('i2').checked, false);
    assert.equal(box('g3').checked, true);
  });

  test('一条都没勾：按钮禁用', () => {
    for (const id of ['i1', 'g2', 'g3']) {
      box(id).checked = false;
      box(id).dispatchEvent(new ui.window.Event('change'));
    }
    assert.equal(submit().disabled, true);
    assert.equal(submit().textContent, '勾选要修的条目');
  });

  test('正在生成：修稿按钮禁用', () => {
    box('i1').checked = true;
    box('i1').dispatchEvent(new ui.window.Event('change'));
    assert.equal(submit().disabled, false);
    ui.post({ type: 'busy', value: true });
    assert.equal(submit().disabled, true);
    ui.post({ type: 'busy', value: false });
    assert.equal(submit().disabled, false);
  });

  test('用户气泡：/按审稿修稿 下面列出勾了哪几条', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('u2', 'user', '', { command: '按审稿修稿', revise: { items: ['[严重] 剧情合理性：残令前文已经交出去了'] } }),
    });
    const bubble = ui.bubble('u2');
    assert.equal(bubble.querySelector('.msg-command').textContent, '/按审稿修稿');
    assert.deepEqual([...bubble.querySelectorAll('.msg-revise-items li')].map((n) => n.textContent), ['[严重] 剧情合理性：残令前文已经交出去了']);
  });
});

// 五期补遗 §3：编辑模式。
describe('审稿报告卡 · 编辑问题', { skip: JSDOM_SKIP }, () => {
  let ui;
  const card = () => ui.bubble('a9').querySelector('.review-card');
  const btn = (cls) => card().querySelector(cls);
  const rows = () => [...card().querySelectorAll('.review-edit-row')];
  const set = (node, value) => {
    node.value = value;
    node.dispatchEvent(new ui.window.Event(node.tagName === 'SELECT' ? 'change' : 'input'));
  };
  const theTurn = (report = REPORT, picks = ['i1', 'i2', 'g2']) =>
    turn('a9', 'assistant', '# 审稿', { review: { report, picks, calls: 1 } });

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: theTurn() });
  });

  test('点「编辑问题」：问题那几组换成可改的表，修稿那一颗收起来', () => {
    ui.clickEl(btn('.review-edit'));
    assert.ok(card().classList.contains('editing'));
    assert.equal(rows().length, 2);
    assert.equal(card().querySelector('.review-submit'), null);
    assert.equal(rows()[0].querySelector('.review-edit-desc').value, '残令前文已经交出去了');
    assert.equal(rows()[0].querySelector('.review-edit-remove'), null, '模型给的不能删');
  });

  test('新增一条：作者补充，可以删', () => {
    ui.clickEl(btn('.review-edit-add'));
    assert.equal(rows().length, 3);
    const added = rows()[2];
    assert.ok(added.classList.contains('author'));
    assert.equal(added.querySelector('.review-edit-category').value, '作者补充');
    assert.ok(added.querySelector('.review-edit-remove'));
  });

  test('气泡重建：编辑中的表与刚敲的字不丢', () => {
    set(rows()[2].querySelector('.review-edit-desc'), '结尾太急');
    set(rows()[1].querySelector('.review-edit-severity'), 'error');
    ui.post({ type: 'turnDone', turn: theTurn() });
    assert.equal(rows().length, 3);
    assert.equal(rows()[2].querySelector('.review-edit-desc').value, '结尾太急');
    assert.equal(rows()[1].querySelector('.review-edit-severity').value, 'error');
  });

  test('保存：发 editReview，整张表，新加的不带 id；退出编辑模式', () => {
    ui.clickEl(btn('.review-edit-save'));
    const sent = ui.last('editReview');
    assert.equal(sent.turnId, 'a9');
    assert.deepEqual(
      sent.issues.map((i) => [i.id ?? '', i.severity, i.description]),
      [
        ['i1', 'error', '残令前文已经交出去了'],
        ['i2', 'error', '左臂有伤却动作如常'],
        ['', 'warning', '结尾太急'],
      ]
    );
    assert.ok(!card().classList.contains('editing'));
    assert.ok(card().querySelector('.review-submit'));
  });

  test('后端推回新报告：作者加的标「作者补充」、没有引文不画引文、缺省勾上；改过的标「已改」', () => {
    const next = {
      ...REPORT,
      issues: [
        REPORT.issues[0],
        { ...REPORT.issues[1], severity: 'error', edited: true },
        { id: 'a1', category: '作者补充', severity: 'warning', quote: '', description: '结尾太急', origin: 'author' },
      ],
    };
    ui.post({ type: 'turnDone', turn: theTurn(next, ['i1', 'i2', 'a1', 'g2']) });
    const a1 = card().querySelector('.review-item[data-item="a1"]');
    assert.equal(a1.querySelector('.review-tag').textContent, '作者补充');
    assert.equal(a1.querySelector('.review-quote'), null);
    assert.equal(a1.querySelector('input[data-pick="a1"]').checked, true);
    assert.equal(card().querySelector('.review-item[data-item="i2"] .review-tag').textContent, '已改');
    assert.equal(card().querySelector('.review-submit').textContent, '按勾选的 4 条修稿');
  });

  test('取消：不发消息，回到原样', () => {
    const before = ui.sent.length;
    ui.clickEl(btn('.review-edit'));
    ui.clickEl(btn('.review-edit-cancel'));
    assert.equal(ui.sent.length, before);
    assert.ok(!card().classList.contains('editing'));
  });
});
