/**
 * 冲突条上的「对比合并…」（`media/src/editor/conflictMerge.ts`）与它收的 `editorReplace`（`replace.ts`）。
 * 合并视图本身由后端的 `prompt kind: 'merge'` 驱动（merge.test.js），这里只钉编辑器这一半。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 按钮 | 冲突条上排第一个（说明文字之后），原来两颗还在；草稿区的冲突条也有 |
 * | 点了 | 发 `mergeWithDisk`，带编辑器里的这一份与一个 requestId |
 * | 收到 `editorReplace`（带 base） | 内容换成合并结果、冲突条收起、仍是未保存；Ctrl+S 发的 baseHash 是磁盘那份的（不必强制保存）；一步撤销退回合并之前 |
 * | 合并结果与磁盘一样 | 换完就是已保存的样子 |
 * | 别的页面发的 requestId | 不认 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  const area = () => ui.doc.getElementById('edArea');
  return {
    ui,
    toasts,
    area,
    bar: () => ui.doc.getElementById('edConflict'),
    mergeBtn: () => ui.doc.querySelector('#edConflict .ed-conflict-merge'),
    tab: () => ui.doc.querySelector('#edTabs .ed-tab'),
    status: () => ui.doc.getElementById('edStatusSave').textContent,
    type(text) {
      area().value = text;
      area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    },
    key(key, extra = {}) {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
    },
  };
}

describe('冲突条「对比合并…」', { skip: JSDOM_SKIP }, () => {
  let h;
  let sent;

  before(() => {
    h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('编辑器里改过的。');
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '别处改过的。', diskHash: 'h-disk' });
  });

  test('冲突条亮了，「对比合并…」排第一个（说明文字之后），原来两颗还在', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    const buttons = [...h.bar().querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['对比合并…', '用磁盘版本覆盖编辑器', '用编辑器内容强制保存']);
    assert.equal(h.mergeBtn().previousElementSibling.id, 'edConflictText');
  });

  test('点了发 mergeWithDisk：编辑器里的这一份 + requestId', () => {
    h.ui.clickEl(h.mergeBtn());
    sent = h.ui.last('mergeWithDisk');
    assert.ok(sent, '没发出 mergeWithDisk');
    assert.equal(sent.path, PATH);
    assert.equal(sent.text, '编辑器里改过的。');
    assert.ok(sent.requestId);
  });

  test('别的页面发的 requestId 不认', () => {
    h.ui.post({ type: 'editorReplace', requestId: 'someone-else', path: PATH, text: '不该进来', base: { text: 'x', hash: 'h-x' } });
    assert.equal(h.area().value, '编辑器里改过的。');
    assert.ok(!h.bar().classList.contains('hidden'));
  });

  test('收到 editorReplace：内容换成合并结果、冲突条收起', () => {
    h.ui.post({
      type: 'editorReplace',
      requestId: sent.requestId,
      path: PATH,
      text: '合并之后的。',
      base: { text: '别处改过的。', hash: 'h-disk-now' },
    });
    assert.equal(h.area().value, '合并之后的。');
    assert.ok(h.bar().classList.contains('hidden'));
  });

  test('仍是未保存，提示说照常保存', () => {
    assert.ok(h.tab().classList.contains('dirty'));
    assert.match(h.status(), /未保存/);
    assert.match(h.toasts.at(-1), /还没保存.*Ctrl\+S/);
  });

  test('Ctrl+S 照常保存：baseHash 是磁盘那份的（不是强制保存）', () => {
    h.key('s');
    const save = h.ui.last('saveFile');
    assert.equal(save.text, '合并之后的。');
    assert.equal(save.baseHash, 'h-disk-now');
  });

  test('一步撤销：退回合并之前编辑器里那份', () => {
    h.key('z');
    assert.equal(h.area().value, '编辑器里改过的。');
  });

  test('同一个 requestId 只认一次', () => {
    h.ui.post({ type: 'editorReplace', requestId: sent.requestId, path: PATH, text: '第二次', base: { text: 'y', hash: 'h-y' } });
    assert.equal(h.area().value, '编辑器里改过的。');
  });
});

describe('合并结果与磁盘上的一样', { skip: JSDOM_SKIP }, () => {
  test('换完就是已保存的样子（圆点消失）', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('编辑器里的。');
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '磁盘上的。', diskHash: 'h-disk' });
    h.ui.clickEl(h.mergeBtn());
    const { requestId } = h.ui.last('mergeWithDisk');
    h.ui.post({ type: 'editorReplace', requestId, path: PATH, text: '磁盘上的。', base: { text: '磁盘上的。', hash: 'h-disk' } });
    assert.equal(h.area().value, '磁盘上的。');
    assert.ok(!h.tab().classList.contains('dirty'));
    assert.match(h.toasts.at(-1), /与磁盘上的一致/);
  });
});

describe('草稿区的冲突条', { skip: JSDOM_SKIP }, () => {
  test('也有「对比合并…」，点了发的是那一块里的文件', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿。', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const area = draft.querySelector('textarea');
    area.value = '草稿改了。';
    area.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.post({ type: 'editorConflict', path: 'drafts/001-雨夜.md', diskText: '别处的。', diskHash: 'h-d' });
    const btn = draft.querySelector('.ed-conflict .ed-conflict-merge');
    assert.ok(btn);
    h.ui.clickEl(btn);
    const sent = h.ui.last('mergeWithDisk');
    assert.equal(sent.path, 'drafts/001-雨夜.md');
    assert.equal(sent.text, '草稿改了。');
  });
});
