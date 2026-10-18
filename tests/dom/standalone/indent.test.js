/**
 * 内置编辑器的 Tab / Shift+Tab 缩进。
 *
 * 从前选中一段按 Tab，整段被换成两个空格（`value.slice(0, start) + '  ' + value.slice(end)`），
 * 而且断撤销。现在：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 缩进单位 | 正文（kind 是 chapter / draft）两个全角空格，其余文件两个半角空格，没给 kind 当非正文 |
 * | 选中一行里的几个字按 Tab | **字不丢**，行首加一级，选区跟着平移 |
 * | 选中多行按 Tab | 每行行首加一级、空行跳过，选区仍覆盖这几行；止于下一行行首时那一行不算 |
 * | Shift+Tab | 每行去一级（全角两个 / 单个全角 / 两个半角 / 一个半角 / \t），没有选区就是光标那一行 |
 * | 撤销 | 一次按键一步 |
 * | 输入法组字 | 组字时的 Tab 放行给输入法，不处理 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const W = '　';

describe('Tab 缩进', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const open = (path, text, kind) =>
    ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  const tab = () => press({ key: 'Tab' });
  const shiftTab = () => press({ key: 'Tab', shiftKey: true });
  const select = (start, end = start) => area().setSelectionRange(start, end);
  const selected = () => area().value.slice(area().selectionStart, area().selectionEnd);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('正文：没有选区时在光标处插两个全角空格', () => {
    open('chapters/001-雨夜.md', '雨夜。', 'chapter');
    select(0);
    const ev = tab();
    assert.equal(ev.defaultPrevented, true, 'Tab 不能切走焦点');
    assert.equal(area().value, `${W}${W}雨夜。`);
    assert.equal(area().selectionStart, 2);
  });

  test('草稿也是正文', () => {
    open('drafts/001-雨夜.md', '草稿', 'draft');
    select(0);
    tab();
    assert.equal(area().value, `${W}${W}草稿`);
  });

  test('角色卡等 Markdown：两个半角空格', () => {
    open('.novelforge/characters/林昭.md', '- 身份', 'character');
    select(0);
    tab();
    assert.equal(area().value, '  - 身份');
  });

  test('后端没给 kind：当非正文，用半角', () => {
    open('notes.txt', '随手记');
    select(0);
    tab();
    assert.equal(area().value, '  随手记');
  });

  test('选中一行里的几个字按 Tab：字不丢，行首加一级，选区跟着平移', () => {
    open('chapters/002-入镇.md', '林昭推开客栈的门。\n第二行', 'chapter');
    select(2, 6);
    assert.equal(selected(), '推开客栈');
    tab();
    assert.equal(area().value, `${W}${W}林昭推开客栈的门。\n第二行`);
    assert.equal(selected(), '推开客栈', '选区仍是那几个字');
  });

  test('选中多行按 Tab：每行加一级，空行跳过，选区仍覆盖这几行', () => {
    open('chapters/003-夜访.md', '第一段\n\n第二段\n第三段', 'chapter');
    select(0, '第一段\n\n第二段'.length);
    tab();
    assert.equal(area().value, `${W}${W}第一段\n\n${W}${W}第二段\n第三段`);
    assert.equal(selected(), `${W}${W}第一段\n\n${W}${W}第二段`, '从行首起选的，新缩进算进选区');
  });

  test('选区止于下一行行首：那一行不缩进', () => {
    open('chapters/004-北行.md', '甲\n乙\n丙', 'chapter');
    select(0, '甲\n'.length);
    tab();
    assert.equal(area().value, `${W}${W}甲\n乙\n丙`);
  });

  test('一次按键一步撤销', () => {
    open('chapters/005-赤星.md', '一\n二\n三', 'chapter');
    select(0, area().value.length);
    tab();
    assert.equal(area().value, `${W}${W}一\n${W}${W}二\n${W}${W}三`);
    press({ key: 'z', ctrlKey: true });
    assert.equal(area().value, '一\n二\n三');
    assert.equal(area().selectionStart, 0);
    assert.equal(area().selectionEnd, area().value.length, '撤销后选区回到按 Tab 之前');
  });

  test('Shift+Tab：每行去一级，认全角两个 / 单个全角 / 两个半角 / 一个半角 / \\t', () => {
    const text = [`${W}${W}${W}甲`, `${W}乙`, '   丙', ' 丁', '\t戊', '己'].join('\n');
    open('chapters/006-去缩进.md', text, 'chapter');
    select(0, text.length);
    shiftTab();
    assert.equal(area().value, [`${W}甲`, '乙', ' 丙', '丁', '戊', '己'].join('\n'), '每行最多去一级');
    assert.equal(area().selectionStart, 0);
    assert.equal(area().selectionEnd, area().value.length);
  });

  test('Shift+Tab 没有选区：去光标所在那一行的一级，光标跟着挪', () => {
    open('chapters/007-一行.md', `甲\n${W}${W}乙丙\n丁`, 'chapter');
    select(`甲\n${W}${W}乙`.length);
    shiftTab();
    assert.equal(area().value, '甲\n乙丙\n丁');
    assert.equal(area().selectionStart, '甲\n乙'.length);
  });

  test('Shift+Tab 行首没有缩进：什么都不动，也不记撤销', () => {
    open('chapters/008-无缩进.md', '甲乙', 'chapter');
    select(1);
    shiftTab();
    assert.equal(area().value, '甲乙');
    press({ key: 'z', ctrlKey: true });
    assert.equal(area().value, '甲乙');
  });

  test('输入法组字时的 Tab 放行给输入法，不处理', () => {
    open('chapters/009-组字.md', '雨夜', 'chapter');
    select(0);
    const ev = press({ key: 'Tab', isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(area().value, '雨夜');
    const old = press({ key: 'Tab', keyCode: 229 });
    assert.equal(old.defaultPrevented, false, '老浏览器组字时 keyCode 是 229');
    assert.equal(area().value, '雨夜');
  });
});
