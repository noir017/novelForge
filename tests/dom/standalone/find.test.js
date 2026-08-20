/**
 * 编辑器查找条：Ctrl+F 打开，匹配落到 textarea 选区。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

describe('内置编辑器：查找', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001.md', '甲乙甲丙') });
  });

  test('Ctrl+F 打开查找条', () => {
    ui.doc.dispatchEvent(
      new ui.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
    );
    assert.equal(ui.doc.getElementById('edFind').classList.contains('hidden'), false);
  });

  test('输入后选中第一处', () => {
    const input = ui.doc.getElementById('edFindInput');
    const area = ui.doc.getElementById('edArea');
    input.value = '甲';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.equal(area.selectionStart, 0);
    assert.equal(area.selectionEnd, 1);
    assert.equal(ui.doc.getElementById('edFindCount').textContent, '1/2');
  });

  test('Enter 跳到下一处', () => {
    const input = ui.doc.getElementById('edFindInput');
    const area = ui.doc.getElementById('edArea');
    input.dispatchEvent(
      new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    assert.equal(area.selectionStart, 2);
    assert.equal(area.selectionEnd, 3);
    assert.equal(ui.doc.getElementById('edFindCount').textContent, '2/2');
  });
});
