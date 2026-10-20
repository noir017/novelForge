/**
 * 完善设定三期的前端（设计稿 §5、§6）：「待完善」组标题的「全部展开」、拆细纲弹窗的「拆完展开本批新设定」、
 * 批量写章弹窗与工作台的写前提醒。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 全部展开 | 组标题右键「全部展开（K 条，预计 K 次调用，最多 2K 次）」，K 不算作者写过的（`authored`）；点了发 `expandLoreAll`；全是作者写过的就没有这一项 |
 * | 拆细纲弹窗 | 多一项「拆完展开本批新设定」，缺省「否」；选「是」时说明里写清拆完再问次数，提交带 `expandLore`；选「否」不带 |
 * | 批量写章弹窗 | 要写的几章用到的待完善设定在说明里提一句（区间外的不算），不拦 |
 * | 工作台 | `notice` 在浮窗里淡色一句，入口挂淡色记号；有 ⟳ 时入口仍是 ⟳ |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, pipelineView, workbenchView, sampleTree } = require('../../helpers/dom');

const LORE = '.novelforge/lore';
const note = (ui) => ui.doc.querySelector('.nf-form .form-note')?.textContent ?? '';
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot button.primary');
function choose(ui, key, value) {
  const sel = field(ui, key);
  sel.value = value;
  sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}
function type(ui, key, value) {
  const input = field(ui, key);
  input.value = String(value);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
const esc = (ui) => ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

const thin = [
  { name: '九层楼', category: '地域', kind: 'missing', chapters: [5, 6], detail: '第 5 章起要用 · 还没有条目' },
  { name: '天机阁', category: '宗门', relPath: `${LORE}/宗门/天机阁.md`, kind: 'empty', chapters: [5], detail: '第 5 章起要用 · 只有一句话' },
  { name: '后山', category: '地域', relPath: `${LORE}/地域/后山.md`, kind: 'untold', chapters: [9], detail: '第 9 章起要用 · 三节全是未交代', authored: true },
];
const treeWith = (loreThin) => ({ ...sampleTree(), loreThin });
const thinHead = (ui) =>
  [...ui.doc.querySelectorAll('#projectBody .group')]
    .find((g) => g.querySelector('.group-name')?.textContent === '待完善')
    ?.querySelector('.group-head');

describe('「待完善」组标题的「全部展开」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const ALL = '全部展开（2 条，预计 2 次调用，最多 4 次）';

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: treeWith(thin) });
  });

  test('次数与后端确认框同一个数，不算作者写过的', () => {
    const items = ui.itemsOf(ui.rightClick(thinHead(ui)));
    assert.equal(items[0], ALL, JSON.stringify(items));
  });

  test('点了发 expandLoreAll，不带路径', () => {
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), ALL);
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'expandLoreAll', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, undefined);
  });

  test('全是作者写过的：没有这一项', () => {
    ui.post({ type: 'project', tree: treeWith([thin[2]]) });
    const items = ui.itemsOf(ui.rightClick(thinHead(ui)));
    ui.closeMenu();
    assert.ok(!items.some((i) => i.startsWith('全部展开')), JSON.stringify(items));
  });
});

describe('拆细纲弹窗的「拆完展开本批新设定」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const open = () => ui.clickEl(ui.doc.querySelector('#projectToolbar [data-form="plotBatch"]'));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  test('缺省「否」，说明里不提', () => {
    assert.equal(field(ui, 'expandLore')?.value, 'off');
    assert.ok(!note(ui).includes('拆完展开本批新设定'), note(ui));
  });

  test('选「否」提交不带 expandLore', () => {
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'generatePlots', JSON.stringify(ui.sent));
    assert.equal(msg.expandLore, undefined);
  });

  test('选「是」：说明里写清拆完再报次数、再问一次；提交带 expandLore', () => {
    open();
    choose(ui, 'expandLore', 'on');
    assert.ok(note(ui).includes('拆完展开本批新设定：每条 1 次，有几条要拆完才知道，到时再报次数、再问一次'), note(ui));
    // 拆细纲那一段的次数不变（展开那几次不在这里的数里）。
    assert.ok(note(ui).includes('预计 1 次调用，最多 12 次'), note(ui));
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.expandLore, true, JSON.stringify(msg));
    assert.ok(msg.call, JSON.stringify(msg));
  });
});

describe('批量写章弹窗的写前提醒', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: treeWith(thin) });
    ui.clickEl(ui.doc.querySelector('#projectToolbar [data-form="writeBatch"]'));
  });

  // 缺省写第 4–6 章：九层楼（第 5、6 章）、天机阁（第 5 章）在区间里，后山（第 9 章）不在。
  test('区间里要用到的待完善设定提一句，不拦', () => {
    assert.ok(
      note(ui).includes('区间里 2 条要用到的设定还只有一句话（九层楼、天机阁），写之前可以先在工程页「待完善」里展开；不展开也照写。'),
      note(ui)
    );
    assert.ok(!submitBtn(ui).disabled);
  });

  test('区间里没有就不提', () => {
    type(ui, 'from', 7);
    type(ui, 'to', 8);
    assert.ok(!note(ui).includes('还只有一句话'), note(ui));
    esc(ui);
  });
});

describe('工作台的写前提醒', { skip: JSDOM_SKIP }, () => {
  let ui;
  const entry = () => ui.doc.getElementById('workbench');
  const tip = () => ui.doc.querySelector('.workbench-tip');
  const NOTICE = '本章要用的 天机阁 还只有一句话，写之前可以先展开（在工程页「待完善」里右键「展开…」）。';
  const post = (extra) =>
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青云》', ...extra }),
    });

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    post({ notice: NOTICE });
  });

  test('入口挂淡色记号，不是 ⟳', () => {
    const mark = entry().querySelector('.wbt-entry-mark');
    assert.equal(mark?.textContent, '◌');
    assert.ok(mark.classList.contains('is-notice'));
  });

  test('浮窗里淡色一句，与 ⟳ 分开', () => {
    ui.clickEl(entry());
    assert.equal(tip()?.querySelector('.wbt-notice')?.textContent, `◌ ${NOTICE}`);
    assert.equal(tip().querySelector('.wbt-warning'), null);
  });

  test('同时有上游变更：入口仍是 ⟳，浮窗两句都在', () => {
    post({ notice: NOTICE, warning: '这一章的细纲在正文写完（或定稿）之后改过。' });
    assert.equal(entry().querySelector('.wbt-entry-mark')?.textContent, '⟳');
    assert.ok(tip()?.querySelector('.wbt-warning'));
    assert.ok(tip()?.querySelector('.wbt-notice'));
  });
});
