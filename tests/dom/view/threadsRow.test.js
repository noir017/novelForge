/**
 * 工程页「文风与摘要」组的「叙事线」一行（七期）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 说明写条数、进行中、已收、已过回收章 | 不展开文件就知道线的大概 |
 * | 没有线时「从细纲排出」，有了「从细纲补充」，都发 generateThreads | 按钮不直接花钱：后端先弹确认框 |
 * | 还没有细纲时不给按钮，说明写清先做什么 | 没有东西可排 |
 * | 文件不存在时点名字不去开它、菜单里没有「打开」 | 没有文件可开 |
 * | 不进「故事架构」那一组 | 叙事线是可选的，不挡路（x/5 不变） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('工程页 · 叙事线一行', { skip: JSDOM_SKIP }, () => {
  let ui;
  const threadsRow = () =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.querySelector('.row-label')?.textContent === '叙事线');
  const detailOf = () => threadsRow().querySelector('.row-detail')?.textContent ?? '';
  const buttonOf = () => threadsRow().querySelector('.row-actions button');
  const groupOf = (row) => row.closest('.group')?.querySelector('.group-name')?.textContent;

  before(() => {
    ui = mount();
  });

  test('有线时：条数、进行中、已收、已过回收章；按钮是「从细纲补充」', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.equal(detailOf(), '4 条 · 3 条进行中 · 1 条已收 · ⚠ 1 条已过回收章');
    assert.equal(buttonOf()?.textContent, '从细纲补充');
    assert.equal(groupOf(threadsRow()), '文风与摘要');
  });

  test('按钮发 generateThreads（后端先弹确认框，不直接花钱）', () => {
    ui.clickEl(buttonOf());
    assert.equal(ui.last('projectAction')?.action, 'generateThreads');
  });

  test('右键：打开、从细纲补充叙事线', () => {
    const items = ui.itemsOf(ui.rightClick(threadsRow()));
    assert.ok(items.includes('打开') && items.includes('从细纲补充叙事线'), JSON.stringify(items));
    assert.ok(!items.includes('删除（移到回收站）'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('点名字打开 threads.md', () => {
    const before = ui.sent.length;
    ui.clickEl(threadsRow().querySelector('.row-label'));
    const opened = ui.sent.slice(before).find((m) => m.type === 'openEditor' || m.type === 'openFile');
    assert.equal(opened?.path, '.novelforge/threads.md', JSON.stringify(ui.sent.slice(before)));
  });

  test('还没排过：「未生成」+「从细纲排出」；点名字不开文件、菜单里没有「打开」', () => {
    ui.post({
      type: 'project',
      tree: { ...sampleTree(), threads: { exists: false, total: 0, open: 0, closed: 0, overdue: 0 } },
    });
    assert.equal(detailOf(), '未生成');
    assert.equal(buttonOf()?.textContent, '从细纲排出');
    const before = ui.sent.length;
    ui.clickEl(threadsRow().querySelector('.row-label'));
    assert.equal(ui.sent.length, before, JSON.stringify(ui.sent.slice(before)));
    const items = ui.itemsOf(ui.rightClick(threadsRow()));
    assert.ok(!items.includes('打开') && items.includes('从细纲排出叙事线'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('还没有细纲：不给按钮，说明写清先拆细纲', () => {
    const tree = sampleTree();
    ui.post({
      type: 'project',
      tree: { ...tree, book: { ...tree.book, plotFilledNos: [] }, threads: { exists: false, total: 0, open: 0, closed: 0, overdue: 0 } },
    });
    assert.equal(detailOf(), '未生成 · 拆出细纲之后可以从细纲排出');
    assert.equal(buttonOf(), null);
    const items = ui.itemsOf(ui.rightClick(threadsRow()));
    assert.ok(!items.some((x) => x.includes('叙事线')), JSON.stringify(items));
    ui.closeMenu();
  });

  test('「故事架构」组标题仍是 x/5', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const head = [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '故事架构');
    assert.match(head.querySelector('.group-head').textContent, /4\/5/);
  });
});
