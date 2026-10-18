/**
 * 回车、段落快捷键、成对符号记录的纯函数（`media/src/editor/enter.ts` / `lines.ts` / `pairs.ts`）。
 * 编辑器里的整条链路（按键、撤销、输入法、菜单）在 tests/dom/standalone/ 的 enter / lineKeys / pairs，
 * 这里只钉边角。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const W = '　　';
const sel = (start, end = start) => ({ start, end });
/** 把一次替换套回原文，返回新文字与选区里的字。 */
function run(value, edit) {
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { next, picked: next.slice(edit.selection.start, edit.selection.end), caret: edit.selection.start };
}

let E;
let L;
let P;
before(() => {
  E = loadModule('media/src/editor/enter.ts');
  L = loadModule('media/src/editor/lines.ts');
  P = loadModule('media/src/editor/pairs.ts');
});

describe('proseEnter', () => {
  test('空文档回车：只换行', () => {
    assert.deepEqual(run('', E.proseEnter('', sel(0), 'indent')), { next: '\n', picked: '', caret: 1 });
  });

  test('光标在段首缩进的中间：整段往下推，光标落到字前面', () => {
    const value = `${W}他`;
    assert.deepEqual(run(value, E.proseEnter(value, sel(1), 'indent')), { next: `\n${W}他`, picked: '', caret: 3 });
  });

  test('选区跨两行：两行之间的字一起换掉', () => {
    const value = '甲乙\n丙丁';
    assert.equal(run(value, E.proseEnter(value, sel(1, 4), 'blank')).next, '甲\n\n丁');
  });
});

describe('markdownEnter', () => {
  test('光标在列表项中间：断开，后半截接在新的列表项后面', () => {
    const value = '- 甲乙';
    assert.equal(run(value, E.markdownEnter(value, sel(3))).next, '- 甲\n- 乙');
  });

  test('1) 这种写法也递增', () => {
    const value = '9) 甲';
    assert.equal(run(value, E.markdownEnter(value, sel(4))).next, '9) 甲\n10) ');
  });

  test('光标在标记之前：不当列表，只沿用光标前那一截缩进', () => {
    const value = '  - 甲';
    assert.equal(run(value, E.markdownEnter(value, sel(1))).next, ' \n  - 甲');
  });
});

describe('moveLines', () => {
  test('往上换：中间的空行原地不动', () => {
    const value = '甲\n\n\n乙';
    assert.deepEqual(run(value, L.moveLines(value, sel(4), -1)), { next: '乙\n\n\n甲', picked: '', caret: 0 });
  });

  test('选区止于下一行行首：那一行不跟着走', () => {
    const value = '一\n二\n三';
    const r = run(value, L.moveLines(value, sel(0, 2), 1));
    assert.equal(r.next, '二\n一\n三');
    assert.equal(r.picked, '一\n');
  });

  test('到顶了：undefined', () => {
    assert.equal(L.moveLines('\n甲', sel(1), -1), undefined);
  });
});

describe('deleteLines', () => {
  test('删第一段：后面的空行一起删', () => {
    assert.equal(run('甲\n\n乙', L.deleteLines('甲\n\n乙', sel(0), true)).next, '乙');
  });

  test('前面空一行、后面紧跟正文：不删空行（否则两段粘在一起）', () => {
    assert.equal(run('甲\n\n乙\n丙', L.deleteLines('甲\n\n乙\n丙', sel(3), true)).next, '甲\n\n丙');
  });

  test('文末带换行：删最后一段，留下恰好一个换行', () => {
    assert.equal(run('甲\n\n乙\n', L.deleteLines('甲\n\n乙\n', sel(3), true)).next, '甲\n');
  });

  test('删光了：空文档', () => {
    assert.deepEqual(run('甲', L.deleteLines('甲', sel(0), true)), { next: '', picked: '', caret: 0 });
  });
});

describe('duplicateLines', () => {
  test('全是空行：undefined', () => {
    assert.equal(L.duplicateLines('甲\n\n乙', sel(2), 1, '\n'), undefined);
  });
});

describe('mapPair：自动补的那一对跟着改动挪', () => {
  const pair = { left: 2, right: 5, open: '“', close: '”' };

  test('在左半边之前插字：两个都往后推', () => {
    assert.deepEqual(P.mapPair(pair, { at: 2, removed: '', inserted: '甲' }), { ...pair, left: 3, right: 6 });
  });

  test('在中间（含右半边之前）插字：只推右半边', () => {
    assert.deepEqual(P.mapPair(pair, { at: 5, removed: '', inserted: '甲乙' }), { ...pair, right: 7 });
  });

  test('删掉的一段碰到了右半边：作废', () => {
    assert.equal(P.mapPair(pair, { at: 4, removed: '甲”', inserted: '' }), undefined);
  });

  test('改动在右半边之后：不动', () => {
    assert.deepEqual(P.mapPair(pair, { at: 6, removed: '甲', inserted: '' }), pair);
  });
});

describe('shouldAutoClose', () => {
  test('行尾、文末、空白、收尾的标点之前补；正文之前不补', () => {
    assert.deepEqual(
      [undefined, '\n', ' ', '。', '”', '）', '他', 'a'].map((c) => P.shouldAutoClose(c)),
      [true, true, true, true, true, true, false, false]
    );
  });
});
