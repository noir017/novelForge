/**
 * 工程页「叙事线」页签（叙事线重做第 8 个提交）：一条线一行，最后一行是「未归属的伏笔」。一行的说法由后端给
 * （`views/threads.ts`，后端那一半在 tests/unit/views/threads.test.js），这里钉前端怎么摆、怎么点。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 第五个页签，排在「设定」后面；「文风与摘要」里那一行计数没了 | 章节、角色、设定各占一页，叙事线同一个思路 |
 * | 一条线一行，照后端排好的顺序；名字 · 种类 · 状态 · 最近第 N 章 · 几条伏笔没收，⚠ 另起一格 | 一眼看出各条线走到哪、哪条要管 |
 * | 最后一行是「未归属的伏笔 · N 条」；没有就不画 | 挂不上线的伏笔有个地方看 |
 * | 点一行打开那条线的文件，右键「打开」，没有删除 / 改名 | 一条线就是一份 Markdown，作者直接改 |
 * | 当前进度作者改过的黄 ❗ 挂在那一行；排线失败的红 ❗ 挂在标题旁 | 失败留在出错的东西身上（第 16 条） |
 * | 标题旁「从大纲排出 / 从大纲补充」发 generateThreads、不折叠这一组；没有情节大纲不给 | 按钮不直接花钱，后端先弹确认框 |
 * | 一条线都没有时说清先做什么 | 空页签不该只剩一个标题 |
 * | 「故事架构」组仍是 x/6 | 叙事线是可选的，不挡路 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('工程页 · 叙事线页签', { skip: JSDOM_SKIP }, () => {
  let ui;
  const panel = () => ui.doc.querySelector('#projectBody [data-project-panel="threads"]');
  const group = () => panel().querySelector('.group');
  const rows = () => [...panel().querySelectorAll('.row')];
  const rowOf = (name) => rows().find((n) => n.querySelector('.row-label')?.textContent === name);
  const labels = () => rows().map((n) => n.querySelector('.row-label').textContent);
  const headBtn = () => group().querySelector('.group-head .threads-head button');
  const warningsOf = (row) => [...row.querySelectorAll('.thread-warn')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('第五个页签「叙事线」，排在「设定」后面；页里只有「叙事线」一组', () => {
    const tabs = [...ui.doc.querySelectorAll('#projectTabs [data-project-tab]')].map((b) => b.textContent);
    assert.deepEqual(tabs, ['概览', '章节', '角色', '设定', '叙事线']);
    assert.deepEqual([...panel().querySelectorAll('.group-name')].map((n) => n.textContent), ['叙事线']);
  });

  test('「文风与摘要」里不再有叙事线那一行', () => {
    const overview = ui.doc.querySelector('#projectBody [data-project-panel="overview"]');
    const meta = [...overview.querySelectorAll('.group')].find((g) => g.querySelector('.group-name')?.textContent === '文风与摘要');
    assert.ok(![...meta.querySelectorAll('.row-label')].some((n) => n.textContent === '叙事线'));
  });

  test('一条线一行，照后端排好的顺序；最后一行是「未归属的伏笔」', () => {
    assert.deepEqual(labels(), ['青崖旧案', '林昭与沈氏', '李叔的旧账', '守卫的选择', '未归属的伏笔']);
  });

  test('一行：种类 · 状态 · 最近第 N 章 · 几条伏笔没收', () => {
    const row = rowOf('青崖旧案');
    assert.equal(row.querySelector('.row-detail').textContent, '主线 · 进行中 · 最近第 3 章 · 1 条伏笔没收');
    assert.deepEqual(warningsOf(row), []);
    assert.equal(row.querySelector('.dot').textContent, '●');
  });

  test('有问题的另起几格 ⚠', () => {
    assert.deepEqual(warningsOf(rowOf('林昭与沈氏')), ['⚠ 1 条伏笔逾期', '⚠ 过了计划收束的第 2 章']);
  });

  test('还没推进过的写计划区间、空心点；收束了的打勾、压暗', () => {
    assert.equal(rowOf('李叔的旧账').querySelector('.row-detail').textContent, '支线 · 计划中 · 计划第 6–12 章');
    assert.equal(rowOf('李叔的旧账').querySelector('.dot').textContent, '○');
    assert.equal(rowOf('守卫的选择').querySelector('.dot').textContent, '✓');
    assert.ok(rowOf('守卫的选择').classList.contains('row-thread-closed'));
    assert.ok(!rowOf('青崖旧案').classList.contains('row-thread-closed'));
  });

  test('「未归属的伏笔 · 2 条」', () => {
    assert.equal(rowOf('未归属的伏笔').querySelector('.row-detail').textContent, '2 条');
  });

  test('悬停名字看意图与当前进度', () => {
    const title = rowOf('青崖旧案').querySelector('.row-label').title;
    assert.ok(title.includes('意图：查清七年前那场火') && title.includes('.novelforge/threads/青崖旧案.md'), title);
  });

  test('点一行打开那条线的文件', () => {
    ui.sent.length = 0;
    ui.clickEl(rowOf('林昭与沈氏').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/林昭与沈氏.md', JSON.stringify(ui.sent));
    ui.clickEl(rowOf('未归属的伏笔').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/未归属的伏笔.md', JSON.stringify(ui.sent));
  });

  test('右键「打开」，没有删除 / 改名 / 移动', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('青崖旧案')));
    assert.ok(items.includes('打开'), JSON.stringify(items));
    assert.ok(!items.some((x) => /删除|重命名|移动/.test(x)), JSON.stringify(items));
    ui.closeMenu();
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('青崖旧案')), '打开');
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/青崖旧案.md', JSON.stringify(ui.sent));
  });

  test('组标题：几条 · 几条进行中', () => {
    assert.equal(group().querySelector('.group-head .meta').textContent, '4 条 · 2 条进行中');
  });

  test('标题旁「从大纲补充」发 generateThreads，不折叠这一组', () => {
    assert.equal(headBtn()?.textContent, '从大纲补充');
    ui.sent.length = 0;
    ui.clickEl(headBtn());
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    assert.equal(labels().length, 5, '点按钮把组折起来了');
  });

  test('标题与页里空白处右键「从大纲补充叙事线」', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(group().querySelector('.group-head')), '从大纲补充叙事线');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    ui.sent.length = 0;
    ui.pick(ui.rightClick(panel()), '从大纲补充叙事线');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
  });

  test('当前进度作者改过的黄 ❗ 挂在那一行；排线失败的红 ❗ 挂在标题旁', () => {
    const tree = sampleTree();
    tree.failures = {
      '.novelforge/threads/林昭与沈氏.md': [
        { at: '2026-10-20T00:00:00Z', severity: 'warn', op: 'threadProgress', message: '第 3 章给出了新的「当前进度」，这一节你改过，没有覆盖' },
      ],
      '.novelforge/threads': [{ at: '2026-10-20T00:00:00Z', severity: 'error', op: 'threads', message: '排叙事线失败：超时' }],
    };
    ui.post({ type: 'project', tree });
    assert.ok(rowOf('林昭与沈氏').querySelector('.row-failure.is-warn'));
    assert.equal(rowOf('青崖旧案').querySelector('.row-failure'), null);
    const mark = group().querySelector('.group-head .threads-head .row-failure.is-error');
    assert.ok(mark, group().querySelector('.group-head').outerHTML);
    assert.equal(mark.dataset.failureKey, '.novelforge/threads');
  });

  test('一条线都没有：「从大纲排出」，空行说清点哪里；没有「未归属的伏笔」就不画', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), threads: { lines: [], current: 0 } } });
    assert.equal(headBtn()?.textContent, '从大纲排出');
    assert.equal(group().querySelector('.group-head .meta').textContent, '还没有');
    assert.deepEqual(labels(), []);
    assert.match(panel().querySelector('.row-empty').textContent, /点标题旁的「从大纲排出」/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(items.includes('从大纲排出叙事线'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('还没有情节大纲：不给按钮，空行说清先排大纲；右键也没有排线', () => {
    const tree = sampleTree();
    ui.post({
      type: 'project',
      tree: {
        ...tree,
        architecture: tree.architecture.map((a) => (a.key === 'outline' ? { ...a, filled: false } : a)),
        threads: { lines: [], current: 0 },
      },
    });
    assert.equal(headBtn(), null);
    assert.match(panel().querySelector('.row-empty').textContent, /先排出情节大纲/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(!items.some((x) => x.includes('叙事线')), JSON.stringify(items));
    ui.closeMenu();
  });

  test('「故事架构」组标题仍是 x/6', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const head = [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '故事架构');
    assert.match(head.querySelector('.group-head').textContent, /5\/6/);
  });
});
