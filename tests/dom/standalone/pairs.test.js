/**
 * 成对符号自动补全（`media/src/editor/pairs.ts`）。
 *
 * 中文标点多半是输入法打出来的，keydown 里看不到那个字，所以补全挂在「内容变了」上：键盘打字
 * （`insertText`）与输入法上屏（`compositionend`）两条路都要测。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 敲左半边 | 补右半边、光标停中间，一次撤销两个一起退 |
 * | 输入法上屏左半边 | 同上 |
 * | 有选区时敲左半边（键盘 / 输入法） | 把选中的字包起来，之后选中被包的那段 |
 * | 紧挨着自动补的右半边再敲同一个右半边 | 跳过不重复（输入法交替出 “ ” 时也吸收） |
 * | 刚补完就退格 | 左右一起删 |
 * | 光标后面紧跟着正文 | 不补（⚑） |
 * | 不是自动补的右半边 | 不跳过 |
 * | Markdown 也补、json 不补 | 只对正文与 Markdown |
 * | 撤销之后 | 记着的那几对作废，不误删 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  const area = () => ui.doc.getElementById('edArea');
  const fire = (inputType, extra) =>
    area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  const h = {
    ui,
    area,
    open(path, text, kind) {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
    },
    select(start, end = start) {
      area().setSelectionRange(start, end);
    },
    /** 键盘打字：一下一个字，盖掉选区。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire('insertText', { data: ch });
      }
    },
    /** 输入法：组字几步，最后上屏 `commit`（盖掉组字开始时的选区）。 */
    ime(steps, commit) {
      const a = area();
      const start = a.selectionStart;
      const end = a.selectionEnd;
      const before = a.value;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of [...steps, commit]) {
        a.value = before.slice(0, start) + step + before.slice(end);
        a.setSelectionRange(start + step.length, start + step.length);
        fire('insertCompositionText', { isComposing: true });
      }
      a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
    },
    backspace() {
      const a = area();
      const s = a.selectionStart;
      a.value = a.value.slice(0, s - 1) + a.value.slice(s);
      a.setSelectionRange(s - 1, s - 1);
      fire('deleteContentBackward');
    },
    undo() {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    },
    caret: () => area().selectionStart,
    selected: () => area().value.slice(area().selectionStart, area().selectionEnd),
  };
  return h;
}

describe('成对符号：正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('键盘敲出左半边：补右半边，光标停在中间', () => {
    h.open('chapters/001-雨夜.md', '他说：', 'chapter');
    h.select(3);
    h.type('“');
    assert.equal(h.area().value, '他说：“”');
    assert.equal(h.caret(), 4);
  });

  test('补的那一下与那次输入算一步撤销', () => {
    h.undo();
    assert.equal(h.area().value, '他说：');
  });

  test('八对都补', () => {
    h.open('chapters/002-八对.md', '', 'chapter');
    for (const [l, r] of ['“”', '‘’', '「」', '『』', '（）', '《》', '【】', '〈〉']) {
      h.select(h.area().value.length);
      h.type(l);
      assert.equal(h.area().value.slice(-2), l + r, l);
      h.select(h.area().value.length);
    }
  });

  test('半角括号不补', () => {
    h.open('chapters/003-半角.md', '', 'chapter');
    h.type('(');
    assert.equal(h.area().value, '(');
  });

  test('输入法上屏左半边：也补', () => {
    h.open('chapters/004-输入法.md', '他说：', 'chapter');
    h.select(3);
    h.ime([], '“');
    assert.equal(h.area().value, '他说：“”');
    assert.equal(h.caret(), 4);
    h.undo();
    assert.equal(h.area().value, '他说：', '上屏与补的那一下一步退掉');
  });

  test('有选区时敲左半边：把选中的字包起来，之后选中被包的那段', () => {
    h.open('chapters/005-包裹.md', '他说你好吧', 'chapter');
    h.select(2, 4);
    h.type('“');
    assert.equal(h.area().value, '他说“你好”吧');
    assert.equal(h.selected(), '你好');
    h.undo();
    assert.equal(h.area().value, '他说你好吧');
    assert.equal(h.selected(), '你好', '撤销回到包之前的选区');
  });

  test('输入法上屏时也包得起来', () => {
    h.open('chapters/006-包裹.md', '书名是青云剑录', 'chapter');
    h.select(3, 7);
    h.ime([], '《');
    assert.equal(h.area().value, '书名是《青云剑录》');
    assert.equal(h.selected(), '青云剑录');
  });

  test('紧挨着自动补的右半边再敲同一个右半边：跳过，不重复', () => {
    h.open('chapters/007-跳过.md', '', 'chapter');
    h.type('“你好');
    assert.equal(h.area().value, '“你好”');
    h.type('”');
    assert.equal(h.area().value, '“你好”');
    assert.equal(h.caret(), 4, '光标挪到右半边后面');
  });

  test('输入法交替出的 ” 也吸收', () => {
    h.open('chapters/008-交替.md', '他说：', 'chapter');
    h.select(3);
    h.ime([], '“');
    h.ime(['ni', 'nihao'], '你好');
    assert.equal(h.area().value, '他说：“你好”');
    h.ime([], '”');
    assert.equal(h.area().value, '他说：“你好”');
    assert.equal(h.caret(), 7);
  });

  test('刚补完、中间还空着就退格：左右一起删，一步撤销', () => {
    h.open('chapters/009-退格.md', '他说', 'chapter');
    h.select(2);
    h.type('「');
    assert.equal(h.area().value, '他说「」');
    h.backspace();
    assert.equal(h.area().value, '他说');
    assert.equal(h.caret(), 2);
    h.undo();
    assert.equal(h.area().value, '他说「」');
  });

  test('中间有字时退格删左半边：只删左半边', () => {
    h.open('chapters/010-退格.md', '', 'chapter');
    h.type('「甲');
    h.select(1);
    h.backspace();
    assert.equal(h.area().value, '甲」');
  });

  test('光标后面紧跟着正文：不补（⚑）', () => {
    h.open('chapters/011-前面.md', '你好', 'chapter');
    h.select(0);
    h.type('“');
    assert.equal(h.area().value, '“你好');
  });

  test('光标后面是标点：补', () => {
    h.open('chapters/012-标点.md', '他说。', 'chapter');
    h.select(2);
    h.type('“');
    assert.equal(h.area().value, '他说“”。');
  });

  test('不是自动补的右半边：照常打进去，不跳过', () => {
    h.open('chapters/013-手打.md', '“你好”', 'chapter');
    h.select(3);
    h.type('”');
    assert.equal(h.area().value, '“你好””');
  });

  test('撤销之后记着的那几对作废：再敲右半边不吞字', () => {
    h.open('chapters/014-撤销.md', '', 'chapter');
    h.type('“');
    h.type('好');
    h.undo();
    assert.equal(h.area().value, '“”');
    h.select(1);
    h.type('”');
    assert.equal(h.area().value, '“””');
  });
});

describe('成对符号：别的文件', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('Markdown（角色卡）也补', () => {
    h.open('.novelforge/characters/林昭.md', '口头禅：', 'character');
    h.select(4);
    h.type('“');
    assert.equal(h.area().value, '口头禅：“”');
  });

  test('json 不补', () => {
    h.open('data.json', '', undefined);
    h.type('“');
    assert.equal(h.area().value, '“');
  });

  test('yml 不补', () => {
    h.open('a.yml', '', undefined);
    h.type('（');
    assert.equal(h.area().value, '（');
  });
});
