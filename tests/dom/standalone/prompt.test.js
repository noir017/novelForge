/**
 * 独立版的小弹窗（media/src/view/prompt.ts）：右上角 ×、点遮罩、Esc 都按「取消」回后端。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | × 关确认框 | 回 `no`（与「取消」按钮同一个回答），遮罩收起——只藏遮罩不回话，后端那头会一直等 |
 * | × 关选择框 / Esc 关输入框 / 点遮罩 | 回 `undefined` |
 * | 回过一次就不再回 | 输入框里的 Esc 与全局 Esc 同时触发也只回一条 |
 * | 确认框写出补充说明 | `Host.confirm` 的 detail（调几次、看哪几章、会覆盖什么）原来在网页上整段丢了 |
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

  test('× 关确认框：回 no，遮罩收起', () => {
    open({ requestId: 'c1', kind: 'confirm', message: '现在开始？' });
    assert.ok(!modal().classList.contains('hidden'));
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['c1', 'no']);
    assert.ok(modal().classList.contains('hidden'));
  });

  test('× 关选择框：回 undefined', () => {
    open({ requestId: 'k1', kind: 'pick', options: ['两样都学', '只学文风'] });
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['k1', undefined]);
  });

  test('点遮罩空白：回 undefined', () => {
    open({ requestId: 'k2', kind: 'pick', options: ['两样都学'] });
    ui.clickEl(modal());
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
