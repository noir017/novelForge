/**
 * Tab / Shift+Tab 缩进的纯函数（`media/src/editor/indent.ts`）。编辑器里的整条链路
 * （按键、缩进单位、撤销、输入法）在 tests/dom/standalone/indent.test.js，这里只钉边角。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { indentLines, outdentLines } = loadModule('media/src/editor/indent.ts');

const W = '　';
const sel = (start, end = start) => ({ start, end });
/** 把一次缩进的结果套回原文，返回新文字与新选区里的字。 */
function run(value, edit) {
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { next, picked: next.slice(edit.selection.start, edit.selection.end) };
}

describe('indentLines', () => {
  test('只有空白的行也跳过', () => {
    const value = `甲\n${W}\n乙`;
    const { next } = run(value, indentLines(value, sel(0, value.length), '  '));
    assert.equal(next, `  甲\n${W}\n  乙`);
  });

  test('碰到的全是空行：不动', () => {
    assert.equal(indentLines('\n\n', sel(0, 2), '  '), undefined);
  });

  test('选区从第一行中间起：起点跟着平移', () => {
    const value = '甲乙丙\n丁';
    const r = run(value, indentLines(value, sel(1, 5), '  '));
    assert.equal(r.next, '  甲乙丙\n  丁');
    assert.equal(r.picked, '乙丙\n  丁');
  });

  test('开头就是换行时，第一行认得对', () => {
    const value = '\n甲';
    const r = run(value, indentLines(value, sel(0, 2), '  '));
    assert.equal(r.next, '\n  甲');
  });
});

describe('outdentLines', () => {
  test('光标在被去掉的缩进中间：挪到行首', () => {
    const value = `${W}${W}甲`;
    const edit = outdentLines(value, sel(1));
    assert.equal(edit.text, '甲');
    assert.deepEqual(edit.selection, sel(0));
  });

  test('第一行在文首、光标在 0：去的是第一行', () => {
    const value = '  甲\n  乙';
    const r = run(value, outdentLines(value, sel(0)));
    assert.equal(r.next, '甲\n  乙');
  });

  test('一处都没去：返回 undefined', () => {
    assert.equal(outdentLines('甲\n乙', sel(0, 3)), undefined);
  });
});
