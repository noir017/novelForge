/**
 * 内置编辑器：关标签时问「保存 / 不保存 / 取消」（`editor/closing.ts` + `editor/dialog.ts`），以及「还原」
 * 「用编辑器内容强制保存」的确认——编辑器里不再用 `window.confirm`。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 三颗按钮，焦点在「保存」上；Enter 选它、Esc 取消、Tab 不出对话框 | 键盘可用；`window.confirm` 说不出「保存」与「不保存」的区别 |
 * | 「保存」等回执才关；撞上冲突不关、冲突条留着 | 存没存成要看后端，关早了冲突那一份就没处取舍了 |
 * | 批量关闭合成一个对话框问一次，列出哪几份 | 从前是每个脏标签各弹一个原生框 |
 * | 还原 / 强制保存两颗按钮，取消就什么都不发 | 同一种对话框 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function setup(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'fakeTimers'] });
  ui.window.confirm = () => {
    throw new Error('不该调 window.confirm');
  };
  const area = () => ui.doc.getElementById('edArea');
  const tabs = () => [...ui.panes()[0].querySelectorAll('.ed-tab')];
  const names = () => tabs().map((t) => t.querySelector('.ed-tab-name').textContent);
  const tabEl = (name) => tabs().find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const open = (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, extra) });
  const keyOn = (target, k, extra = {}) =>
    target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const saves = () => ui.sent.filter((m) => m.type === 'saveFile');
  const closeBtn = (name) => tabEl(name).querySelector('.ed-tab-close');
  return { ui, area, tabs, names, tabEl, type, open, keyOn, saves, closeBtn };
}

describe('关一个有未保存修改的标签', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.open('b.md', '乙');
  });

  test('没改过的直接关，不问', () => {
    s.ui.clickEl(s.closeBtn('b.md'));
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('改过的先问：取消 / 不保存 / 保存，焦点在「保存」上', () => {
    s.type('甲，改了');
    s.ui.clickEl(s.closeBtn('a.md'));
    const dlg = s.ui.dialog();
    assert.ok(dlg, '没有弹对话框');
    assert.equal(dlg.getAttribute('role'), 'dialog');
    assert.match(dlg.textContent, /「a\.md」有未保存的修改/);
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '不保存', '保存']);
    assert.equal(s.ui.doc.activeElement.textContent, '保存');
  });

  test('取消：标签留着，修改一个字不少', async () => {
    await s.ui.answer('取消');
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
    assert.equal(s.area().value, '甲，改了');
  });

  test('Esc 等于取消', async () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    s.keyOn(s.ui.doc.activeElement, 'Escape');
    await s.ui.flush();
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('Tab 在几颗按钮之间绕，不出对话框', () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    s.keyOn(s.ui.doc.activeElement, 'Tab');
    assert.equal(s.ui.doc.activeElement.textContent, '取消', '从最右的「保存」往后绕回第一颗');
    s.keyOn(s.ui.doc.activeElement, 'Tab', { shiftKey: true });
    assert.equal(s.ui.doc.activeElement.textContent, '保存');
  });

  test('对话框开着时 Ctrl+S 不往下传', () => {
    const before = s.saves().length;
    s.keyOn(s.ui.doc.activeElement, 's', { ctrlKey: true });
    assert.equal(s.saves().length, before);
    assert.ok(s.ui.dialog());
  });

  test('Enter 选主按钮「保存」：发出保存，回执回来之前标签还在', async () => {
    s.keyOn(s.ui.doc.activeElement, 'Enter');
    await s.ui.flush();
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.last('saveFile').text, '甲，改了');
    assert.deepEqual(s.names(), ['a.md'], '还没收到回执，不能关');
    assert.equal(s.ui.doc.getElementById('edStatusSave').textContent, '保存中…');
  });

  test('回执回来才关', async () => {
    s.ui.post({ type: 'editorSaved', file: file('a.md', '甲，改了', { hash: 'h-a2' }) });
    await s.ui.flush();
    assert.deepEqual(s.names(), []);
  });

  test('「不保存」：直接关，不发保存', async () => {
    s.open('c.md', '丙');
    s.type('丙，改了');
    const before = s.saves().length;
    s.ui.clickEl(s.closeBtn('c.md'));
    await s.ui.answer('不保存');
    assert.deepEqual(s.names(), []);
    assert.equal(s.saves().length, before);
  });
});

describe('「保存」撞上冲突就不关', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.open('b.md', '乙');
  });

  test('点了保存、回来的是冲突：标签留着，切过去挂着冲突条', async () => {
    // 从另一个标签上关 a（右键「关闭」也是同一条路）：先切回 a 再点它的叉。
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('保存');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁盘）', diskHash: 'h-disk' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'b.md']);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active .ed-tab-name').textContent, 'a.md');
    assert.equal(s.ui.doc.getElementById('edConflict').classList.contains('hidden'), false);
    assert.equal(s.area().value, '甲，改了');
  });

  test('出错（比如越界、太大）也不关', async () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('保存');
    s.ui.post({ type: 'editorError', path: 'a.md', message: '内容超过大小上限，未写入。' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'b.md']);
  });

  test('等回执的工夫里又改了：存成了也不关（关了那几笔就没了）', async () => {
    s.ui.clickEl(s.tabEl('a.md'));
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('保存');
    const sent = s.ui.last('saveFile').text;
    s.type(`${sent}又一笔`);
    s.ui.post({ type: 'editorSaved', file: file('a.md', sent, { hash: 'h-a3' }) });
    await s.ui.flush();
    assert.ok(s.names().includes('a.md'));
  });
});

describe('批量关闭合成一个对话框', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup(['view.js', 'editor.js']);
    s.open('a.md', '甲');
    s.open('b.md', '乙');
    s.type('乙，改了');
    s.open('c.md', '丙');
    s.type('丙，改了');
    s.open('d.md', '丁');
  });

  const closeOthersOf = (name) => {
    const menu = s.ui.rightClick(s.tabEl(name));
    const label = s.ui.itemsOf(menu).find((l) => l.startsWith('关闭其它'));
    s.ui.pick(menu, label);
  };

  test('关闭其它：只弹一个对话框，列出没保存的那几份', () => {
    closeOthersOf('a.md');
    const dlgs = s.ui.doc.querySelectorAll('.ed-dialog');
    assert.equal(dlgs.length, 1);
    assert.match(dlgs[0].textContent, /这 2 份有未保存的修改/);
    const items = [...dlgs[0].querySelectorAll('.ed-dialog-list li')].map((li) => li.textContent);
    assert.deepEqual(items, ['b.md', 'c.md']);
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '全部不保存', '全部保存']);
  });

  test('取消：一个都不关（没改过的也不关）', async () => {
    await s.ui.answer('取消');
    assert.deepEqual(s.names(), ['a.md', 'b.md', 'c.md', 'd.md']);
  });

  test('全部保存：两份各发一次保存，没改过的那份先不关', async () => {
    closeOthersOf('a.md');
    const before = s.saves().length;
    await s.ui.answer('全部保存');
    const sent = s.saves().slice(before);
    assert.deepEqual(sent.map((m) => m.path), ['b.md', 'c.md']);
    assert.deepEqual(s.names(), ['a.md', 'b.md', 'c.md', 'd.md']);
  });

  test('一份存成、一份撞冲突：存成的与没改过的关掉，冲突的留着', async () => {
    s.ui.post({ type: 'editorSaved', file: file('b.md', '乙，改了', { hash: 'h-b2' }) });
    s.ui.post({ type: 'editorConflict', path: 'c.md', diskText: '丙（磁盘）', diskHash: 'h-c-disk' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'c.md']);
  });

  test('全部不保存：一下都关掉', async () => {
    s.open('e.md', '戊');
    s.type('戊，改了');
    s.ui.clickEl(s.tabEl('a.md'));
    closeOthersOf('a.md');
    assert.deepEqual(
      [...s.ui.dialog().querySelectorAll('.ed-dialog-list li')].map((li) => li.textContent),
      ['c.md', 'e.md']
    );
    await s.ui.answer('全部不保存');
    assert.deepEqual(s.names(), ['a.md']);
  });
});

describe('Ctrl+W 与「文件 → 关闭编辑器」同样先问', { skip: JSDOM_SKIP }, () => {
  test('Ctrl+W 关有修改的标签弹三选一', async () => {
    const s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.keyOn(s.area(), 'w', { ctrlKey: true });
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '不保存', '保存']);
    // 连按两下不叠第二个对话框。
    s.keyOn(s.area(), 'w', { ctrlKey: true });
    assert.equal(s.ui.doc.querySelectorAll('.ed-dialog').length, 1);
    await s.ui.answer('取消');
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('「关闭编辑器」命令也一样', async () => {
    const s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.ui.window.dispatchEvent(new s.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'close' } }));
    assert.ok(s.ui.dialog());
    await s.ui.answer('不保存');
    assert.deepEqual(s.names(), []);
  });
});

describe('「还原」与「用编辑器内容强制保存」的确认', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
  });

  test('还原：两颗按钮，取消就不发 reloadFile', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '放弃修改']);
    await s.ui.answer('取消');
    assert.equal(s.ui.last('reloadFile'), undefined);
    assert.equal(s.area().value, '甲，改了');
  });

  test('还原：点「放弃修改」才发', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    await s.ui.answer('放弃修改');
    assert.equal(s.ui.last('reloadFile').path, 'a.md');
  });

  test('没改过时点还原不问', () => {
    const r = setup();
    r.open('a.md', '甲');
    r.ui.clickEl(r.ui.doc.getElementById('edRevertBtn'));
    assert.equal(r.ui.dialog(), null);
    assert.ok(r.ui.last('reloadFile'));
  });

  test('强制保存：两颗按钮，取消就什么都不发', async () => {
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h-a' }) });
    s.type('甲，又改了');
    s.keyOn(s.area(), 's', { ctrlKey: true });
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁盘）', diskHash: 'h-disk' });
    const before = s.saves().length;
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '覆盖磁盘上的版本']);
    await s.ui.answer('取消');
    assert.equal(s.saves().length, before);
  });

  test('强制保存：确认之后发不带基线的保存', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    await s.ui.answer('覆盖磁盘上的版本');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.baseHash, undefined);
    assert.equal(msg.text, '甲，又改了');
  });

  test('关掉之后焦点回到打开之前的地方', async () => {
    s.ui.post({ type: 'editorSaved', file: file('a.md', '甲，又改了', { hash: 'h-a9' }) });
    s.type('再改一笔');
    s.area().focus();
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    assert.notEqual(s.ui.doc.activeElement, s.area());
    await s.ui.answer('取消');
    assert.equal(s.ui.doc.activeElement, s.area());
  });
});
