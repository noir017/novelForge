/**
 * 工程页的「待完善」那一组与设定行的「展开…」（完善设定，2026-10-19）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 待完善 | 只在有时出现、排在「设定」与「出现过 · 未建条目」之间、副标题写个数、默认展开；一行是 名字〔分类〕· 后端给的说明（第 N 章起要用 · 种类）；有条目的点名字打开、右键「打开」「展开…（预计 1 次调用，最多 2 次）」，展开发 `expandLore` 带 `relPath`；还没有条目的点名字不做事、右键展开带 `name` 与 `category`；菜单里列出要用到的章；筛选框也筛它 |
 * | 设定行的「展开…」 | 每一条都有：有待整合的与没有的两种菜单都带，发 `expandLore` 带这一条的路径；「整合这一条」照旧只在有待整合时出现 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LORE = '.novelforge/lore';
const EXPAND = '展开…（预计 1 次调用，最多 2 次）';

const thinTree = (extra) => ({
  ...sampleTree(),
  lore: [
    { kind: 'file', label: '天机阁', relPath: `${LORE}/天机阁.md`, detail: '' },
    { kind: 'file', label: '青崖镇', relPath: `${LORE}/青崖镇.md`, detail: '偏僻小镇' },
  ],
  loreByEntry: {
    [`${LORE}/天机阁.md`]: { chapters: [], detail: '', updatedThrough: 0, pending: 0, keywords: [] },
    [`${LORE}/青崖镇.md`]: { chapters: [3, 5], detail: '第 3–5 章 · 2 章', updatedThrough: 3, pending: 1, keywords: [] },
  },
  loreUnfiled: [{ name: '断魂香', category: '', chapters: [2], detail: '1 章 · 第 2 章起' }],
  loreThin: [
    { name: '九层楼', category: '地域/青崖', kind: 'missing', chapters: [4, 6], detail: '第 4 章起要用 · 还没有条目' },
    {
      name: '天机阁', category: '', relPath: `${LORE}/天机阁.md`, kind: 'empty', chapters: [5], detail: '第 5 章起要用 · 只有一句话',
    },
  ],
  loreUnrecorded: 0,
  ...extra,
});

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const groupNames = (ui) => [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent);
const thinGroup = (ui) => groupOf(ui, '待完善');
const thinRows = (ui) => [...(thinGroup(ui)?.querySelectorAll('.row-lore-thin') ?? [])];
const thinRow = (ui, name) => thinRows(ui).find((r) => r.querySelector('.row-label')?.textContent === name);
/** 最近一条 expandLore（jsdom 那边的对象原型不同，转一道 JSON 才比得了 deepEqual）。 */
const expandSent = (ui) => JSON.parse(JSON.stringify(ui.last('expandLore') ?? null));
const loreRow = (ui, label) =>
  [...groupOf(ui, '设定').querySelectorAll('.row-lore')].find((r) => r.querySelector('.row-label')?.textContent === label);

describe('「待完善」那一组', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: thinTree() });
  });

  test('排在「设定」与「出现过 · 未建条目」之间', () => {
    const names = groupNames(ui);
    assert.equal(names.indexOf('待完善'), names.indexOf('设定') + 1, names.join('|'));
    assert.equal(names.indexOf('出现过 · 未建条目'), names.indexOf('待完善') + 1, names.join('|'));
  });

  test('副标题写个数，默认展开', () => {
    assert.equal(thinGroup(ui).querySelector('.group-head .meta').textContent, '2 个');
    assert.equal(thinRows(ui).length, 2);
  });

  test('一行：名字〔分类〕· 后端给的说明，按后端的顺序', () => {
    assert.deepEqual(
      thinRows(ui).map((r) => r.querySelector('.row-label').textContent),
      ['九层楼', '天机阁']
    );
    const row = thinRow(ui, '九层楼');
    assert.equal(row.querySelector('.lore-category')?.textContent, '〔地域/青崖〕', row.outerHTML);
    assert.equal(row.querySelector('.row-detail')?.textContent, '第 4 章起要用 · 还没有条目');
    assert.equal(thinRow(ui, '天机阁').querySelector('.lore-category'), null);
  });

  test('有条目的：点名字打开那一条', () => {
    ui.sent.length = 0;
    ui.clickEl(thinRow(ui, '天机阁').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, `${LORE}/天机阁.md`, JSON.stringify(ui.sent));
  });

  test('还没有条目的：点名字不做事，整行压暗', () => {
    ui.sent.length = 0;
    ui.clickEl(thinRow(ui, '九层楼').querySelector('.row-label'));
    assert.deepEqual(ui.sent, []);
    assert.ok(thinRow(ui, '九层楼').classList.contains('row-cast'));
    assert.ok(!thinRow(ui, '天机阁').classList.contains('row-cast'));
  });

  test('有条目的右键：打开、展开…、要用到的章、刷新', () => {
    const items = ui.itemsOf(ui.rightClick(thinRow(ui, '天机阁')));
    assert.deepEqual(items, ['打开', EXPAND, '要用到：第 5 章', '刷新'], JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/天机阁.md` });
  });

  test('还没有条目的右键：展开带名字与分类（后端先按分类建空条目）', () => {
    const items = ui.itemsOf(ui.rightClick(thinRow(ui, '九层楼')));
    assert.deepEqual(items, [EXPAND, '要用到：第 4、6 章', '刷新'], JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', name: '九层楼', category: '地域/青崖' });
  });

  test('筛选框也筛它；一个都不匹配就整组不画', () => {
    const input = groupOf(ui, '设定').querySelector('.lore-filter-input');
    const type = (text) => {
      const box = groupOf(ui, '设定').querySelector('.lore-filter-input');
      box.focus();
      box.value = text;
      box.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    };
    assert.ok(input);
    type('地域/青');
    assert.deepEqual(thinRows(ui).map((r) => r.querySelector('.row-label').textContent), ['九层楼']);
    type('查无此物');
    assert.equal(thinGroup(ui), undefined);
    type('');
    assert.equal(thinRows(ui).length, 2);
  });

  test('没有待完善的时候整组不出现', () => {
    ui.post({ type: 'project', tree: thinTree({ loreThin: [] }) });
    assert.ok(!groupNames(ui).includes('待完善'), groupNames(ui).join('|'));
  });
});

describe('设定行右键的「展开…」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: thinTree() });
  });

  test('没有待整合的那一条也有，发 expandLore 带路径', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '天机阁')));
    assert.ok(items.includes(EXPAND), JSON.stringify(items));
    assert.ok(!items.some((i) => i.startsWith('整合这一条')), JSON.stringify(items));
    for (const label of ['打开', '重命名', '移动到…', '删除（移到回收站）']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/天机阁.md` });
  });

  test('有待整合的那一条：「整合这一条」在前、「展开…」紧跟在后', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖镇')));
    const integrate = items.findIndex((i) => i.startsWith('整合这一条'));
    assert.ok(integrate >= 0, JSON.stringify(items));
    assert.equal(items[integrate + 1], EXPAND, JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/青崖镇.md` });
  });
});
