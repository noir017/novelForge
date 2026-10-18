/**
 * 段落快捷键（`media/src/editor/lines.ts`）。「段」= 一个逻辑行，空白行被跳过。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | Alt+↑ / Alt+↓ | 与上 / 下一个非空行交换，中间的空行原地不动，选区跟着走；碰到的几行当成一块 |
 * | Shift+Alt+↓ / ↑ | 在下 / 上方复制这几行，正文按分段格式补段间隔；向下时选区落在新的那份 |
 * | Ctrl+Shift+K | 删掉这几行，正文空行分段时顺带删一个相邻的空行 |
 * | Ctrl+Enter / Cmd+Enter | 在当前段下面另起一段（正文按分段格式，其余沿用缩进） |
 * | 撤销 | 每个操作一步 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const W = '　　';

describe('段落快捷键', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const open = (path, text, kind) => ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
  const style = (paragraphStyle) => ui.post({ type: 'state', state: viewState({ paragraphStyle }) });
  const select = (start, end = start) => area().setSelectionRange(start, end);
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  const undo = () => press({ key: 'z', ctrlKey: true });
  const selected = () => area().value.slice(area().selectionStart, area().selectionEnd);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('Alt+↓：与下一个非空行交换，中间的空行原地不动，光标跟着走', () => {
    open('chapters/001-雨夜.md', '甲段\n\n乙段\n\n丙段', 'chapter');
    select(1);
    const ev = press({ key: 'ArrowDown', altKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '乙段\n\n甲段\n\n丙段');
    assert.equal(area().selectionStart, 5, '光标还在「甲」后面');
  });

  test('Alt+↑：换回去', () => {
    press({ key: 'ArrowUp', altKey: true });
    assert.equal(area().value, '甲段\n\n乙段\n\n丙段');
    assert.equal(area().selectionStart, 1);
  });

  test('一次交换一步撤销', () => {
    undo();
    assert.equal(area().value, '乙段\n\n甲段\n\n丙段');
  });

  test('选中几行：当成一块移动，选区跟着走', () => {
    open('chapters/002-块.md', '一\n二\n三\n四', 'chapter');
    select(2, 5);
    assert.equal(selected(), '二\n三');
    press({ key: 'ArrowDown', altKey: true });
    assert.equal(area().value, '一\n四\n二\n三');
    assert.equal(selected(), '二\n三');
  });

  test('到底了：不动，也接下这一下', () => {
    open('chapters/003-到底.md', '一\n二', 'chapter');
    select(3);
    const ev = press({ key: 'ArrowDown', altKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '一\n二');
  });

  test('光标在空行上：不动', () => {
    open('chapters/004-空行.md', '一\n\n二', 'chapter');
    select(2);
    press({ key: 'ArrowDown', altKey: true });
    assert.equal(area().value, '一\n\n二');
  });

  test('Shift+Alt+↓：正文空行分段，在下方复制并空一行，光标落在新的那份', () => {
    style('blank');
    open('chapters/005-复制.md', '甲段\n\n乙段', 'chapter');
    select(1);
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    assert.equal(area().value, '甲段\n\n甲段\n\n乙段');
    assert.equal(area().selectionStart, 5);
    undo();
    assert.equal(area().value, '甲段\n\n乙段');
  });

  test('Shift+Alt+↑：段首缩进时不空行，光标留在上面那份', () => {
    style('indent');
    open('chapters/006-复制.md', `${W}甲段\n${W}乙段`, 'chapter');
    select(3);
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    assert.equal(area().value, `${W}甲段\n${W}甲段\n${W}乙段`);
    assert.equal(area().selectionStart, 3);
  });

  test('非正文复制：只隔一个换行', () => {
    style('blank');
    open('.novelforge/characters/林昭.md', '- 甲\n- 乙', 'character');
    select(1);
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    assert.equal(area().value, '- 甲\n- 甲\n- 乙');
  });

  test('Ctrl+Shift+K：正文空行分段时顺带删一个相邻的空行', () => {
    open('chapters/007-删除.md', '甲段\n\n乙段\n\n丙段', 'chapter');
    select(5);
    const ev = press({ key: 'K', ctrlKey: true, shiftKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '甲段\n\n丙段');
    assert.equal(area().selectionStart, 4, '光标落在下一段的行首');
    undo();
    assert.equal(area().value, '甲段\n\n乙段\n\n丙段');
  });

  test('Ctrl+Shift+K 删最后一段：前面的空行一起删，不在文末留空行', () => {
    open('chapters/008-删除.md', '甲段\n\n乙段', 'chapter');
    select(5);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, '甲段');
  });

  test('Ctrl+Shift+K：段首缩进时只删这几行', () => {
    style('indent');
    open('chapters/009-删除.md', `${W}甲\n${W}乙\n${W}丙`, 'chapter');
    select(5, 9);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, `${W}甲`);
  });

  test('Ctrl+Shift+K：非正文只删这一行', () => {
    style('blank');
    open('notes.md', '一\n\n二\n\n三');
    select(3);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, '一\n\n\n三');
  });

  test('Ctrl+Enter：在当前段下面另起一段（正文按分段格式）', () => {
    style('both');
    open('chapters/010-另起.md', `${W}他推开门。\n\n${W}她笑了。`, 'chapter');
    select(3);
    const ev = press({ key: 'Enter', ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, `${W}他推开门。\n\n${W}\n\n${W}她笑了。`);
    assert.equal(area().selectionStart, 11);
    undo();
    assert.equal(area().value, `${W}他推开门。\n\n${W}她笑了。`);
  });

  test('Cmd+Enter 也认；非正文沿用缩进', () => {
    open('.novelforge/outline.md', '  - 第一卷\n下一行', 'outline');
    select(2);
    press({ key: 'Enter', metaKey: true });
    assert.equal(area().value, '  - 第一卷\n  \n下一行');
    assert.equal(area().selectionStart, 10);
  });

  test('Mac 的 Cmd+Shift+K 也认', () => {
    open('notes2.md', '一\n二');
    select(0);
    press({ key: 'k', metaKey: true, shiftKey: true });
    assert.equal(area().value, '二');
  });
});
