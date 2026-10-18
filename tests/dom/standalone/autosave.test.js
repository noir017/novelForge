/**
 * 内置编辑器：保存状态（`editor/saving.ts`）与自动保存（`editor/autosave.ts`）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 「● 未保存」→「保存中…」→「已保存 14:32」，存成了不弹 toast，冲突照样弹 | 从前每次 Ctrl+S 都弹「已保存 路径」 |
 * | 发出去 10 秒没回音说一句 | 断线时消息在 bridge 的 outbox 里等重连，作者得知道还没存上 |
 * | 同一份同一时刻只有一个保存在路上，期间又改了等回执后再存一次 | 两个保存同时在路上，后一个带的是过期的基线，必撞假冲突 |
 * | 自动保存缺省关，「文件 → 自动保存」打 ✓，状态栏标出来 | 正文一保存，定稿过的章就回到「待定稿」，得是作者自己选的 |
 * | 停笔 2 秒（组字中不算）、切走标签、窗口失焦 / 页面藏起来时保存 | 三个时机 |
 * | 撞上冲突就停止自动保存这一份，直到冲突解决；磁盘上没了的不存；对话框开着不存 | 绝不强制保存、绝不静默重建、不抢在作者决定之前 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function setup(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'fakeTimers'] });
  const toasts = [];
  // view.js 没装时 editor 的 toast 落到这里；装了的话也换成记录，好断言。
  ui.window.__nfToast = (message, isError) => toasts.push({ message, isError: !!isError });
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = (name) =>
    [...ui.panes()[0].querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const key = (k, extra = {}) =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const saves = () => ui.sent.filter((m) => m.type === 'saveFile');
  const status = () => ui.doc.getElementById('edStatusSave').textContent;
  const flag = () => ui.panes()[0].querySelector('.ed-status .ed-autosave');
  const tick = (ms) => ui.window.__clock.tick(ms);
  const toggleAutoSave = () =>
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
  const saved = (path, text, hash) => ui.post({ type: 'editorSaved', file: file(path, text, { hash }) });
  return { ui, toasts, area, tabEl, type, key, saves, status, flag, tick, toggleAutoSave, saved };
}

describe('保存状态', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
  });

  test('这次会话还没存过：「已保存」', () => {
    assert.equal(s.status(), '已保存');
  });

  test('改了：「● 未保存」', () => {
    s.type('甲，改了');
    assert.match(s.status(), /^● 未保存/);
  });

  test('发出去：「保存中…」', () => {
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 1);
    assert.equal(s.status(), '保存中…');
  });

  test('回执到了：「已保存 时:分」，不弹 toast', () => {
    s.saved('a.md', '甲，改了', 'h1');
    assert.match(s.status(), /^已保存 \d\d:\d\d$/);
    assert.equal(s.toasts.length, 0);
  });

  test('发出去 10 秒没回音：说一句', () => {
    s.type('甲，又改了');
    s.key('s', { ctrlKey: true });
    s.tick(9999);
    assert.equal(s.status(), '保存中…');
    s.tick(1);
    assert.match(s.status(), /还没收到回音/);
    assert.match(s.ui.doc.getElementById('edStatusSave').title, /连接断了的话/);
  });

  test('回音终于到了：照常「已保存」', () => {
    s.saved('a.md', '甲，又改了', 'h2');
    assert.match(s.status(), /^已保存 \d\d:\d\d$/);
  });

  test('冲突照样弹 toast', () => {
    s.type('甲，第三版');
    s.key('s', { ctrlKey: true });
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁盘）', diskHash: 'h-disk' });
    assert.equal(s.toasts.length, 1);
    assert.equal(s.toasts[0].isError, true);
    assert.match(s.status(), /^● 未保存/);
  });

  test('出错照样弹 toast（index.ts 那条），状态栏不再「保存中」', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲') });
    t.type('甲，改了');
    t.key('s', { ctrlKey: true });
    t.ui.post({ type: 'editorError', path: 'a.md', message: '内容超过大小上限，未写入。' });
    assert.equal(t.toasts.at(-1).message, '内容超过大小上限，未写入。');
    assert.match(t.status(), /^● 未保存/);
  });

  test('保存期间又打了字：回执之后照实写「未保存」', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
    t.type('甲，改了');
    t.key('s', { ctrlKey: true });
    t.type('甲，改了，又打了几个字');
    t.saved('a.md', '甲，改了', 'h1');
    assert.match(t.status(), /^● 未保存/);
  });
});

describe('同一份同一时刻只有一个保存在路上', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
    s.type('甲，改了');
    s.key('s', { ctrlKey: true });
  });

  test('回执回来之前再按 Ctrl+S 不发第二个', () => {
    s.type('甲，改了，又改了');
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 1);
  });

  test('回执是「存成了」而还有没存上的修改：接着再存一次，带新的基线', () => {
    s.saved('a.md', '甲，改了', 'h1');
    assert.equal(s.saves().length, 2);
    assert.equal(s.saves()[1].baseHash, 'h1');
    assert.equal(s.saves()[1].text, '甲，改了，又改了');
  });

  test('撞上冲突就不再接着存', () => {
    s.type('甲，改了，又改了，第三次');
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 2, '第二个还在路上');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁盘）', diskHash: 'h-disk' });
    assert.equal(s.saves().length, 2);
  });
});

describe('自动保存：开关', { skip: JSDOM_SKIP }, () => {
  let s;
  const fileMenu = () => {
    s.ui.clickEl(s.ui.doc.querySelector('[data-menu="file"]'));
    return [...s.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
  };
  const autoItem = () => fileMenu().find((b) => b.querySelector('.wb-menu-label')?.textContent === '自动保存');

  before(() => {
    s = setup(['view.js', 'editor.js']);
    s.ui.window.__nfToast = () => {};
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
  });

  test('「文件」菜单里「自动保存」紧跟在「全部保存」后面', () => {
    const labels = fileMenu().map((b) => b.querySelector('.wb-menu-label')?.textContent);
    s.ui.closeMenu();
    assert.equal(labels[labels.indexOf('全部保存') + 1], '自动保存');
  });

  test('缺省关：没有 ✓，状态栏不挂「自动保存」，停笔也不存', () => {
    const item = autoItem();
    assert.equal(item.getAttribute('aria-checked'), 'false');
    s.ui.closeMenu();
    assert.equal(s.flag(), null);
    s.type('甲，改了');
    s.tick(5000);
    assert.equal(s.saves().length, 0);
  });

  test('点一下打开：打 ✓，状态栏挂「自动保存」', () => {
    s.ui.clickEl(autoItem());
    const item = autoItem();
    assert.equal(item.getAttribute('aria-checked'), 'true');
    assert.equal(item.querySelector('.wb-menu-check').textContent, '✓');
    s.ui.closeMenu();
    assert.equal(s.flag()?.textContent, '自动保存');
  });

  test('再点一下关掉：✓ 与状态栏那一枚都没了', () => {
    s.ui.clickEl(autoItem());
    assert.equal(autoItem().getAttribute('aria-checked'), 'false');
    s.ui.closeMenu();
    assert.equal(s.flag(), null);
  });
});

describe('自动保存：三个时机', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    s.ui.post({ type: 'editorOpen', file: file('b.md', '乙', { hash: 'hb' }) });
    s.toggleAutoSave();
  });

  test('停笔 2 秒存那一份，照样带基线', () => {
    s.type('乙，改了');
    s.tick(1999);
    assert.equal(s.saves().length, 0);
    s.tick(1);
    assert.equal(s.saves().length, 1);
    assert.equal(s.saves()[0].path, 'b.md');
    assert.equal(s.saves()[0].baseHash, 'hb');
    s.saved('b.md', '乙，改了', 'hb2');
  });

  test('一直在打字就一直不存', () => {
    for (let i = 0; i < 5; i++) {
      s.type(`乙，改了${'。'.repeat(i + 1)}`);
      s.tick(1500);
    }
    assert.equal(s.saves().length, 1);
    s.tick(500);
    assert.equal(s.saves().length, 2);
    s.saved('b.md', s.saves()[1].text, 'hb3');
  });

  test('输入法组字中途不算停笔，上屏之后重新计时', () => {
    const a = s.area();
    a.dispatchEvent(new s.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    a.value = `${a.value}lin`;
    a.dispatchEvent(new s.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    s.tick(5000);
    assert.equal(s.saves().length, 2, '组字中途存了');
    a.value = a.value.replace(/lin$/, '林');
    a.dispatchEvent(new s.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林' }));
    s.tick(1999);
    assert.equal(s.saves().length, 2);
    s.tick(1);
    assert.equal(s.saves().length, 3);
    assert.match(s.saves()[2].text, /林$/);
    s.saved('b.md', s.saves()[2].text, 'hb4');
  });

  test('切走一个标签时存它', () => {
    s.type('乙，切走之前改的');
    s.ui.clickEl(s.tabEl('a.md'));
    assert.equal(s.saves().length, 4);
    assert.equal(s.saves()[3].path, 'b.md');
    s.saved('b.md', '乙，切走之前改的', 'hb5');
  });

  test('窗口失去焦点时存全部有修改的', () => {
    s.type('甲，改了');
    s.ui.clickEl(s.tabEl('b.md'));
    s.saved('a.md', '甲，改了', 'ha2');
    s.type('乙，又改了');
    s.ui.clickEl(s.tabEl('a.md'));
    s.saved('b.md', '乙，又改了', 'hb6');
    s.type('甲，失焦之前改的');
    const before = s.saves().length;
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    const sent = s.saves().slice(before);
    assert.deepEqual(sent.map((m) => m.path), ['a.md']);
    s.saved('a.md', '甲，失焦之前改的', 'ha3');
  });

  test('页面藏起来时也存', () => {
    s.type('甲，藏起来之前改的');
    Object.defineProperty(s.ui.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const before = s.saves().length;
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    assert.equal(s.saves().length, before + 1);
    s.saved('a.md', '甲，藏起来之前改的', 'ha4');
  });

  test('存成了不弹 toast', () => {
    assert.equal(s.toasts.length, 0);
  });
});

describe('自动保存：闸', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    s.toggleAutoSave();
  });

  test('同一份只有一个在路上：期间又改了，等回执后再存一次', () => {
    s.type('甲，改了');
    s.tick(2000);
    assert.equal(s.saves().length, 1);
    s.type('甲，改了，又改了');
    s.tick(2000);
    assert.equal(s.saves().length, 1, '第一个还在路上');
    s.saved('a.md', '甲，改了', 'ha2');
    assert.equal(s.saves().length, 2);
    assert.equal(s.saves()[1].baseHash, 'ha2');
    s.saved('a.md', '甲，改了，又改了', 'ha3');
  });

  test('撞上冲突：不强制保存，这一份停止自动保存，不切标签', () => {
    s.ui.post({ type: 'editorOpen', file: file('b.md', '乙', { hash: 'hb' }) });
    s.ui.clickEl(s.tabEl('a.md'));
    s.type('甲，冲突之前');
    s.ui.clickEl(s.tabEl('b.md')); // 切走时存 a
    const sent = s.saves().at(-1);
    assert.equal(sent.path, 'a.md');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（别处改的）', diskHash: 'ha-disk' });
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active .ed-tab-name').textContent, 'b.md', '自动保存撞上的冲突不切标签');
    assert.ok(s.tabEl('a.md').querySelector('.ed-tab-flag'));
    assert.equal(s.toasts.at(-1).isError, true);
    assert.ok(s.saves().every((m) => m.baseHash !== undefined), '绝不强制保存');
  });

  test('冲突没解决之前，停笔、切标签、失焦都不再存它，状态栏写「自动保存已暂停」', () => {
    s.ui.clickEl(s.tabEl('a.md'));
    const before = s.saves().length;
    s.type('甲，冲突之后又写');
    s.tick(5000);
    s.ui.clickEl(s.tabEl('b.md'));
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    assert.equal(s.saves().filter((m) => m.path === 'a.md').length, s.saves().slice(0, before).filter((m) => m.path === 'a.md').length);
    s.ui.clickEl(s.tabEl('a.md'));
    assert.equal(s.flag()?.textContent, '自动保存已暂停');
  });

  test('在冲突条上选了（用磁盘版本），之后接着自动保存', () => {
    s.key('s', { ctrlKey: true }); // 冲突条收起了：按 Ctrl+S 再看一遍
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（别处改的）', diskHash: 'ha-disk' });
    s.ui.clickEl(s.ui.doc.getElementById('edConflictTake'));
    assert.equal(s.flag()?.textContent, '自动保存');
    const before = s.saves().length;
    s.type('甲（别处改的），接着写');
    s.tick(2000);
    assert.equal(s.saves().length, before + 1);
    assert.equal(s.saves().at(-1).baseHash, 'ha-disk');
    s.saved('a.md', '甲（别处改的），接着写', 'ha5');
  });

  test('磁盘上没了的不自动保存', () => {
    s.ui.post({ type: 'editorDiskGone', path: 'a.md' });
    const before = s.saves().length;
    s.type('甲，磁盘上没了之后写的');
    s.tick(5000);
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    assert.equal(s.saves().length, before);
    assert.equal(s.flag()?.textContent, '自动保存已暂停');
    assert.equal(s.ui.dialog(), null, '自动保存不弹「要不要重建」');
  });

  test('核对磁盘发现改过的标签在磁盘上变了：也停下', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，改了');
    t.ui.post({ type: 'editorDiskChanged', file: file('a.md', '甲（agent 改的）', { hash: 'ha2' }) });
    t.tick(5000);
    assert.equal(t.saves().length, 0);
  });

  test('对话框开着时不存（比如正问着要不要还原），答完之后照常', async () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，改了');
    t.ui.clickEl(t.ui.doc.getElementById('edRevertBtn'));
    assert.ok(t.ui.dialog());
    t.tick(5000);
    t.ui.window.dispatchEvent(new t.ui.window.Event('blur'));
    assert.equal(t.saves().length, 0, '作者正决定要不要丢掉这些修改');
    await t.ui.answer('取消');
    t.tick(2000);
    assert.equal(t.saves().length, 1);
  });

  test('点了「还原」：磁盘版回来之前不把要丢掉的修改存下去', async () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，要丢掉的');
    t.ui.clickEl(t.ui.doc.getElementById('edRevertBtn'));
    await t.ui.answer('放弃修改');
    t.tick(5000);
    t.ui.window.dispatchEvent(new t.ui.window.Event('blur'));
    assert.equal(t.saves().length, 0);
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    assert.equal(t.area().value, '甲');
    t.type('甲，还原之后写的');
    t.tick(2000);
    assert.equal(t.saves().length, 1);
  });
});
