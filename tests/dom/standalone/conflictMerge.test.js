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
 * | 磁盘上没了（`gone`） | 冲突条亮着说「被删或改名」，「对比合并…」藏起来（没有磁盘版本可合并）；文件回来了又出现 |
 * | 合并之后的自动保存 | 撞冲突停下的自动保存接着走：状态栏不再「已暂停」，停笔 2 秒就存，带的是磁盘那份的 hash |
 * | 合并之后磁盘再变 | 核对磁盘带的是新基线；磁盘再变——哪怕变回撞冲突时见过的那一份——照样报、挂冲突条 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';

function harness(extraShims = []) {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', ...extraShims] });
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
    autoFlag: () => ui.doc.querySelector('#wbEditor .ed-status .ed-autosave'),
    saves: () => ui.sent.filter((m) => m.type === 'saveFile'),
    tick: (ms) => ui.window.__clock.tick(ms),
    toggleAutoSave: () =>
      ui.window.dispatchEvent(new ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } })),
    /** 推一条 state，等核对磁盘的去抖过去，回那一次 checkEditorFiles 里这份文件带的 hash。 */
    checkedHash(path) {
      ui.post({ type: 'state', state: viewState() });
      ui.window.__clock.tick(400);
      const msg = ui.sent.filter((m) => m.type === 'checkEditorFiles').at(-1);
      return msg?.files.find((f) => f.path === path)?.hash;
    },
    /** 点「对比合并…」，后端把 `text` 放回、基线换成 `base`。 */
    merge(text, base) {
      ui.clickEl(ui.doc.querySelector('#edConflict .ed-conflict-merge'));
      const { requestId } = ui.sent.filter((m) => m.type === 'mergeWithDisk').at(-1);
      ui.post({ type: 'editorReplace', requestId, path: PATH, text, base });
    },
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

describe('磁盘上没了：没有可合并的', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('编辑器里改过的。');
    h.ui.post({ type: 'editorDiskGone', path: PATH });
  });

  test('冲突条亮着说「被删或改名」，「对比合并…」藏起来（与「用磁盘版本覆盖」同一个判法）', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.match(h.ui.doc.getElementById('edConflictText').textContent, /磁盘上已经没有/);
    assert.ok(h.mergeBtn().classList.contains('hidden'));
    assert.ok(h.ui.doc.getElementById('edConflictTake').classList.contains('hidden'));
  });

  test('接着打字也不冒出来', () => {
    h.type('编辑器里又改了。');
    assert.ok(h.mergeBtn().classList.contains('hidden'));
  });

  test('磁盘上又有了、而且与编辑器里的不一样：冲突条换成「被改动」，「对比合并…」回来', () => {
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '别处又建了一份。', { kind: 'chapter', hash: 'h-back' }) });
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.match(h.ui.doc.getElementById('edConflictText').textContent, /已被改动/);
    assert.ok(!h.mergeBtn().classList.contains('hidden'));
  });
});

describe('合并之后：撞冲突停下的自动保存接着走', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['fakeTimers']);
    h.ui.post({ type: 'editorOpen', file: file(PATH, '甲。', { kind: 'chapter', hash: 'h0' }) });
    h.toggleAutoSave();
    h.type('甲，改了。');
    h.tick(2000);
    // 自动保存撞上冲突：这一份停下。
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '甲（别处改的）。', diskHash: 'h-disk' });
  });

  test('起点：自动保存已暂停', () => {
    assert.equal(h.autoFlag()?.textContent, '自动保存已暂停');
    const before = h.saves().length;
    h.tick(5000);
    assert.equal(h.saves().length, before);
  });

  test('放回编辑器之后：不再暂停，停笔 2 秒就存，带的是磁盘那份的 hash', () => {
    h.merge('甲（别处改的），改了。', { text: '甲（别处改的）。', hash: 'h-disk' });
    assert.equal(h.autoFlag()?.textContent, '自动保存');
    const before = h.saves().length;
    h.tick(2000);
    assert.equal(h.saves().length, before + 1);
    const sent = h.saves().at(-1);
    assert.equal(sent.text, '甲（别处改的），改了。');
    assert.equal(sent.baseHash, 'h-disk');
  });

  test('回执到了：已保存，之后照常', () => {
    h.ui.post({ type: 'editorSaved', file: file(PATH, '甲（别处改的），改了。', { kind: 'chapter', hash: 'h1' }) });
    assert.match(h.status(), /^已保存/);
    h.type('甲（别处改的），改了，再写一句。');
    h.tick(2000);
    assert.equal(h.saves().at(-1).baseHash, 'h1');
  });

  test('磁盘那份正好变回了撞冲突时的基线（hash 一样）：闸照样放开', () => {
    const g = harness(['fakeTimers']);
    g.ui.post({ type: 'editorOpen', file: file(PATH, '乙。', { kind: 'chapter', hash: 'h0' }) });
    g.toggleAutoSave();
    g.type('乙，改了。');
    g.tick(2000);
    g.ui.post({ type: 'editorConflict', path: PATH, diskText: '乙（别处改的）。', diskHash: 'h-disk' });
    // 合并时读到的磁盘那份已经被人改回去了，hash 与撞冲突时编辑器的基线一样。
    g.merge('乙，改了，合并过。', { text: '乙。', hash: 'h0' });
    assert.equal(g.autoFlag()?.textContent, '自动保存');
    const before = g.saves().length;
    g.tick(2000);
    assert.equal(g.saves().length, before + 1);
    assert.equal(g.saves().at(-1).baseHash, 'h0');
  });
});

describe('合并之后：磁盘再变照样报', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['fakeTimers']);
    h.ui.post({ type: 'editorOpen', file: file(PATH, '丙。', { kind: 'chapter', hash: 'h0' }) });
    h.type('丙，改了。');
    // 核对磁盘发现别处改成了 h-seen：挂冲突条，这一份新版记下来（同一份不报第二次）。
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丙（第一次别处改的）。', { kind: 'chapter', hash: 'h-seen' }) });
  });

  test('起点：冲突条亮着，核对磁盘带的是见过的那一份', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.equal(h.checkedHash(PATH), 'h-seen');
  });

  test('放回编辑器（合并时磁盘已经又变成 h-now）：核对磁盘带的是新基线 h-now', () => {
    h.merge('丙，改了，合并过。', { text: '丙（第二次别处改的）。', hash: 'h-now' });
    assert.ok(h.bar().classList.contains('hidden'));
    assert.equal(h.checkedHash(PATH), 'h-now');
  });

  test('磁盘变回撞冲突时见过的那一份（h-seen）：照样报，挂冲突条、标签上标「!」', () => {
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丙（第一次别处改的）。', { kind: 'chapter', hash: 'h-seen' }) });
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.ok(h.tab().querySelector('.ed-tab-flag'));
    assert.equal(h.area().value, '丙，改了，合并过。', '编辑器里的一个字不动');
  });

  test('磁盘变成又一份新的：同样报', () => {
    const g = harness(['fakeTimers']);
    g.ui.post({ type: 'editorOpen', file: file(PATH, '丁。', { kind: 'chapter', hash: 'h0' }) });
    g.type('丁，改了。');
    g.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丁（别处改的）。', { kind: 'chapter', hash: 'h-seen' }) });
    g.merge('丁，合并过。', { text: '丁（别处改的）。', hash: 'h-seen' });
    assert.ok(g.bar().classList.contains('hidden'));
    g.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丁（别处又改的）。', { kind: 'chapter', hash: 'h-later' }) });
    assert.ok(!g.bar().classList.contains('hidden'));
  });
});
