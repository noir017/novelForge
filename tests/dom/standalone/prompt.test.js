/**
 * 独立版的小弹窗（media/src/view/prompt.ts）：右上角 ×、Esc 都按「取消」回后端；点遮罩空白不关。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | × 关确认框 | 回 `undefined`（与「取消」按钮同一个回答），遮罩收起——只藏遮罩不回话，后端那头会一直等 |
 * | × 关选择框 / Esc 关输入框 | 回 `undefined` |
 * | 点遮罩空白 | 不关、不回话——误触不该丢掉填到一半的内容 |
 * | 回过一次就不再回 | 输入框里的 Esc 与全局 Esc 同时触发也只回一条 |
 * | 确认框写出补充说明 | `Host.confirm` 的 detail（调几次、看哪几章、会覆盖什么）原来在网页上整段丢了 |
 * | 确认框一个 action 一颗按钮 | 回的是按钮上的字。从前只画「确定 / 取消」，第二个 action（「全部直接采纳并开始」「保留原样」……）点不到 |
 * | 调模型之前的那一问（`call`） | 两个下拉框（按分档 + 各模型；四级详细度），按分档时列出各项活交给谁；回答带 `choice`；不看详细度时只有模型那一个 |
 * | 选本机文件（`kind: 'file'`） | 从给的目录起步；只列目录与允许的扩展名；确定回绝对路径，Esc / 取消回 undefined；粘完整路径回车直接选定 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('小弹窗的关闭', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('providerModal');
  /** jsdom 那一侧造的对象跨 realm，deepEqual 认不出，拆成字段比。 */
  const answer = () => {
    const m = ui.last('promptResult');
    return [m.requestId, m.value];
  };
  const results = () => ui.sent.filter((m) => m.type === 'promptResult');
  const open = (extra) => ui.post({ type: 'prompt', title: '从参考书学', ...extra });
  const esc = (target) => target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('× 关确认框：回 undefined，遮罩收起', () => {
    open({ requestId: 'c1', kind: 'confirm', message: '现在开始？', actions: ['开始'] });
    assert.ok(!modal().classList.contains('hidden'));
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['c1', undefined]);
    assert.ok(modal().classList.contains('hidden'));
  });

  test('× 关选择框：回 undefined', () => {
    open({ requestId: 'k1', kind: 'pick', options: ['两样都学', '只学文风'] });
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['k1', undefined]);
  });

  test('点遮罩空白：不关、不回话', () => {
    open({ requestId: 'k2', kind: 'pick', options: ['两样都学'] });
    const before = results().length;
    ui.clickEl(modal());
    assert.equal(results().length, before);
    assert.ok(!modal().classList.contains('hidden'));
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['k2', undefined]);
  });

  test('输入框里按 Esc：只回一条', () => {
    const before = results().length;
    open({ requestId: 'i1', kind: 'input', value: '' });
    esc(modal().querySelector('input'));
    assert.equal(results().length, before + 1);
    assert.deepEqual(answer(), ['i1', undefined]);
  });

  test('弹窗关着时点 ×、按 Esc：什么都不回', () => {
    const before = results().length;
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    esc(ui.doc.body);
    assert.equal(results().length, before);
  });

  test('确认框写出补充说明，一行一段', () => {
    open({ requestId: 'c2', kind: 'confirm', message: '现在开始？', value: '文件：D:\\书\\a.txt（UTF-8）\n\n只学怎么写。' });
    const lines = [...modal().querySelectorAll('.prompt-detail')].map((p) => p.textContent);
    assert.deepEqual(lines, ['文件：D:\\书\\a.txt（UTF-8）', '只学怎么写。']);
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
  });

  test('确认框一个 action 一颗按钮，回的是按钮上的字', () => {
    open({ requestId: 'c3', kind: 'confirm', message: '更新 3 张角色卡？', actions: ['逐张确认后开始', '全部直接采纳并开始'] });
    const labels = [...modal().querySelectorAll('.actions button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['逐张确认后开始', '全部直接采纳并开始', '取消']);
    assert.ok(modal().querySelector('.actions button').classList.contains('primary'));
    ui.clickEl([...modal().querySelectorAll('.actions button')][1]);
    assert.deepEqual(answer(), ['c3', '全部直接采纳并开始']);
    assert.equal(ui.last('promptResult').choice, undefined);
  });
});

describe('调模型之前的那一问（confirm 带 call）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('providerModal');
  const selects = () => [...modal().querySelectorAll('.call-picker select')];
  const tiers = () => modal().querySelector('.call-tiers');
  const CALL = {
    models: [
      { ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: '智谱 GLM' },
      { ref: 'or/claude', label: 'claude', group: 'OpenRouter' },
    ],
    model: '',
    tiers: ['批量写正文 → 均衡档：glm/glm-4-plus'],
    contextDetail: 3,
  };
  const open = (extra) =>
    ui.post({ type: 'prompt', title: '开始写章', kind: 'confirm', message: '要写 3 章？', actions: ['开始写章'], call: CALL, ...extra });
  const choose = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('两个下拉框：缺省按分档、打开时那一级；按分档时列出各项活交给谁', () => {
    open({ requestId: 'k1' });
    const [model, detail] = selects();
    assert.equal(model.value, '');
    assert.deepEqual([...model.options].map((o) => o.value), ['', 'glm/glm-4-plus', 'or/claude']);
    assert.equal(detail.value, '3');
    assert.ok(!tiers().classList.contains('hidden'));
    assert.ok(tiers().textContent.includes('均衡档'));
  });

  test('挑了模型：那几行收起；点按钮回按钮上的字与作者的选择', () => {
    const [model, detail] = selects();
    choose(model, 'or/claude');
    assert.ok(tiers().classList.contains('hidden'));
    choose(detail, '1');
    ui.clickEl(modal().querySelector('.actions button.primary'));
    const m = ui.last('promptResult');
    assert.deepEqual([m.requestId, m.value], ['k1', '开始写章']);
    assert.equal(JSON.stringify(m.choice), JSON.stringify({ model: 'or/claude', contextDetail: 1 }));
  });

  // 细纲试点（2026-10-25）：转写不跟这一次挑的模型，那一行挑了模型也照样显示。
  test('不跟这一次挑的模型的活（转写）：挑了模型也照样显示', () => {
    open({ requestId: 'k4', call: { ...CALL, fixed: ['转写 · 细纲整理成 JSON → 快速档：glm/glm-4-air（不跟这一次挑的模型）'] } });
    const [model] = selects();
    choose(model, 'or/claude');
    assert.ok(tiers().classList.contains('hidden'));
    const fixed = [...modal().querySelectorAll('.call-picker > p.hint')].find((p) => p.textContent.includes('转写'));
    assert.ok(fixed && !fixed.classList.contains('hidden'), modal().querySelector('.call-picker').innerHTML);
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
  });

  test('这一次不看详细度：只有模型那一个下拉框', () => {
    open({ requestId: 'k2', call: { ...CALL, contextDetail: undefined } });
    assert.equal(selects().length, 1);
    ui.clickEl(modal().querySelector('.actions button.primary'));
    assert.equal(JSON.stringify(ui.last('promptResult').choice), JSON.stringify({}));
  });

  test('取消：不带选择', () => {
    open({ requestId: 'k3' });
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    const m = ui.last('promptResult');
    assert.deepEqual([m.requestId, m.value, m.choice], ['k3', undefined, undefined]);
  });
});

describe('选本机文件', { skip: JSDOM_SKIP }, () => {
  let ui;
  const picker = () => ui.doc.querySelector('.nf-picker');
  const rows = () => [...picker().querySelectorAll('.nf-picker-row')].map((r) => r.textContent.replace(/^[📁📄]/u, ''));
  const answer = () => {
    const m = ui.last('promptResult');
    return m && [m.requestId, m.value];
  };
  const listing = (path, entries) => ui.post({ type: 'hostDir', path, parent: 'D:\\', entries, truncated: 0 });
  const ENTRIES = [
    { name: '子目录', kind: 'dir', absPath: 'D:\\书\\子目录' },
    { name: '参考.txt', kind: 'file', absPath: 'D:\\书\\参考.txt' },
    { name: '大写.TXT', kind: 'file', absPath: 'D:\\书\\大写.TXT' },
    { name: '封面.jpg', kind: 'file', absPath: 'D:\\书\\封面.jpg' },
  ];
  const openFile = (requestId) =>
    ui.post({ type: 'prompt', requestId, kind: 'file', title: '从参考书学写法：选一本 txt', value: 'D:\\工程', options: ['txt'] });

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('打开时从给的目录起步，标题写明扩展名', () => {
    openFile('f1');
    assert.ok(picker().classList.contains('open'));
    assert.equal(ui.last('listHostDir').path, 'D:\\工程');
    assert.equal(picker().querySelector('h2').textContent, '从参考书学写法：选一本 txt（.txt）');
  });

  test('只列目录与 txt（不分大小写）；选中再点确定，回绝对路径', () => {
    listing('D:\\书', ENTRIES);
    assert.deepEqual(rows(), ['..', '子目录', '参考.txt', '大写.TXT']);
    const ok = picker().querySelector('.nf-picker-actions .primary');
    assert.equal(ok.disabled, true);
    ui.clickEl([...picker().querySelectorAll('.nf-picker-row')].find((r) => r.textContent.includes('参考.txt')));
    assert.equal(ok.disabled, false);
    ui.clickEl(ok);
    assert.deepEqual(answer(), ['f1', 'D:\\书\\参考.txt']);
    assert.ok(!picker().classList.contains('open'));
  });

  test('Esc 关掉：回 undefined', () => {
    openFile('f2');
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.deepEqual(answer(), ['f2', undefined]);
    assert.ok(!picker().classList.contains('open'));
  });

  test('点取消：回 undefined', () => {
    openFile('f3');
    ui.clickEl([...picker().querySelectorAll('.nf-picker-actions button')].find((b) => b.textContent === '取消'));
    assert.deepEqual(answer(), ['f3', undefined]);
  });

  test('路径框里粘一个 txt 的完整路径回车：直接当选定', () => {
    openFile('f4');
    const input = picker().querySelector('input');
    input.value = 'E:\\下载\\某书.txt';
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(answer(), ['f4', 'E:\\下载\\某书.txt']);
  });
});
