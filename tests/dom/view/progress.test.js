/**
 * 进度显示：工程页的摘要同步横幅，以及长任务进度条。
 *
 * 迁自 scripts/smoke-view.js 的这两节：
 *   == 摘要进度显示 ==（1437） == 长任务进度条 ==（1475）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree, viewState } = require('../../helpers/dom');

describe('摘要进度显示', { skip: JSDOM_SKIP }, () => {
  let ui;
  const banner = () => ui.doc.querySelector('#projectBody .banner-summary');
  const groupMeta = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((h) => h.textContent.includes(name))
      ?.querySelector('.meta')?.textContent ?? '';

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('有过期摘要时出现进度横幅', () => {
    assert.ok(banner());
  });

  test('横幅说明有几段过期', () => {
    assert.ok(banner().textContent.includes('1 段摘要缺失或已过期'), banner().textContent);
  });

  test('横幅给出已完成／总数', () => {
    assert.ok(banner().textContent.includes('已总结 2 / 3 段'), banner().textContent);
  });

  test('横幅给出百分比', () => {
    assert.ok(banner().textContent.includes('67%'), banner().textContent);
  });

  test('横幅有进度条', () => {
    assert.ok(banner().querySelector('.sum-fill'));
  });

  test('进度条按比例填充', () => {
    assert.equal(banner().querySelector('.sum-fill').style.width, '67%',
      banner().querySelector('.sum-fill').style.width);
  });

  test('没有任务时仍能点「立即同步」', () => {
    assert.ok([...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));
  });

  test('分组副标题带进度', () => {
    assert.ok(groupMeta('文风与摘要').includes('已总结 2/3 段'), groupMeta('文风与摘要'));
  });

  // 同步跑起来后，重复点只会撞上「已有任务」，所以按钮撤掉。
  test('同步进行中不再显示「立即同步」', () => {
    ui.post({
      type: 'tasks',
      tasks: [{ id: 't1', title: '同步剧情摘要', message: '第 3 段', current: 0, total: 1, elapsedMs: 0 }],
    });
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(![...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));
  });

  // 全部同步完就不该再有横幅。
  test('全部同步后横幅消失', () => {
    ui.post({ type: 'tasks', tasks: [] });
    ui.post({ type: 'project', tree: { ...sampleTree(), staleCount: 0, summarizedCount: 3 } });
    assert.ok(!banner());
  });

  test('分组副标题改为已同步', () => {
    assert.ok(groupMeta('文风与摘要').includes('已全部同步'), groupMeta('文风与摘要'));
  });
});

/**
 * 过期摘要的提示只长在工程页。
 *
 * 对话页从前也挂着一份纯文字横幅（`#staleBanner`），说的是同一句话，却常年
 * 占着消息流本就不宽裕的宽度；要处理这件事也只能去工程页。切走时由活动栏
 * 「工程」上的小圆点留记号。
 */
describe('过期摘要提示只在工程页', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({ body: 'standalone' });
    ui.post({ type: 'state', state: viewState({ staleCount: 3 }) });
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('对话页里没有横幅', () => {
    assert.equal(ui.doc.querySelector('#pane-chat .banner'), null);
  });

  test('工程页里有横幅', () => {
    assert.ok(ui.doc.querySelector('#pane-project .banner-summary'));
  });

  test('活动栏「工程」上的小圆点亮着', () => {
    assert.ok(!ui.doc.getElementById('projectStaleDot').classList.contains('hidden'));
  });

  test('全部同步后小圆点灭掉', () => {
    ui.post({ type: 'state', state: viewState({ staleCount: 0 }) });
    assert.ok(ui.doc.getElementById('projectStaleDot').classList.contains('hidden'));
  });
});

describe('长任务进度条', { skip: JSDOM_SKIP }, () => {
  let ui;
  const taskList = () => ui.doc.getElementById('taskList');
  const rows = () => [...taskList().querySelectorAll('.task')];
  const textOf = (i) => rows()[i].textContent;

  before(() => {
    ui = mount();
  });

  test('没有任务时整块隐藏', () => {
    assert.ok(taskList().classList.contains('hidden'));
  });

  test('有任务时露出来', () => {
    ui.post({
      type: 'tasks',
      tasks: [{ id: 't1', title: '同步剧情摘要', message: '第 12 段《夜访》', current: 11, total: 76, elapsedMs: 65000 }],
    });
    assert.ok(!taskList().classList.contains('hidden'));
  });

  test('渲染出一行', () => {
    assert.equal(rows().length, 1, `${rows().length}`);
  });

  test('显示标题', () => {
    assert.ok(textOf(0).includes('同步剧情摘要'), textOf(0));
  });

  test('显示当前在做什么', () => {
    assert.ok(textOf(0).includes('第 12 段《夜访》'), textOf(0));
  });

  test('显示 n/N 与百分比', () => {
    assert.ok(textOf(0).includes('11/76') && textOf(0).includes('14%'), textOf(0));
  });

  test('显示已用时（分:秒）', () => {
    assert.ok(textOf(0).includes('1:05'), textOf(0));
  });

  test('进度条按比例填充', () => {
    assert.equal(rows()[0].querySelector('.task-fill').style.width, '14%',
      rows()[0].querySelector('.task-fill').style.width);
  });

  // 点「停止」要把任务 id 发回后端。
  test('点停止发出 cancelTask', () => {
    ui.sent.length = 0;
    ui.clickEl([...rows()[0].querySelectorAll('button')].find((b) => b.textContent === '停止'));
    assert.ok(ui.sent.some((m) => m.type === 'cancelTask' && m.id === 't1'), JSON.stringify(ui.sent));
  });

  // 不知道总量时走不定量条，不显示假的百分比。
  test('无 total 时用不定量条', () => {
    ui.post({ type: 'tasks', tasks: [{ id: 't2', title: '提取文风指南', message: '分析中', elapsedMs: 3000 }] });
    assert.ok(rows()[0].querySelector('.task-bar').classList.contains('indeterminate'));
  });

  test('无 total 时不显示百分比', () => {
    assert.ok(!textOf(0).includes('%'), textOf(0));
  });

  // 多个任务并存。
  test('两个任务都渲染', () => {
    ui.post({
      type: 'tasks',
      tasks: [
        { id: 't3', title: '甲', message: '一', current: 1, total: 2, elapsedMs: 0 },
        { id: 't4', title: '乙', message: '二', current: 0, total: 5, elapsedMs: 0 },
      ],
    });
    assert.equal(rows().length, 2, `${rows().length}`);
  });

  test('任务结束后整块收起', () => {
    ui.post({ type: 'tasks', tasks: [] });
    assert.ok(taskList().classList.contains('hidden'));
  });

  test('任务结束后行清空', () => {
    assert.equal(rows().length, 0, `${rows().length}`);
  });
});
