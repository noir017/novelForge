/**
 * 查找替换的纯函数（`media/src/editor/findCore.ts`；匹配口径本身在 core 的 `src/core/model/textFind.ts`，
 * findCore 原样转出——全书查找替换在后端用的也是它）。查找条的整条链路（按键、高亮、撤销）在
 * tests/dom/standalone/find.test.js，这里钉口径：大小写、正则、坏正则、零长度、`$1`、中文、上限、定位，
 * 以及全书替换要的「只换挑出来的那几处」（`replaceSelectedIn`）。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  MATCH_LIMIT,
  compileSearch,
  escapeRegExp,
  expandReplacement,
  findMatches,
  matchAfter,
  matchAt,
  matchBefore,
  nearestMatch,
  replaceAllIn,
  replaceSelectedIn,
  replacementFor,
  seedFromSelection,
} = loadModule('media/src/editor/findCore.ts');
const core = loadModule('src/core/model/textFind.ts');

/** 匹配到的字，按顺序。 */
const found = (text, query, opts) => findMatches(text, query, opts).matches.map((m) => text.slice(m.start, m.end));
/** 把全部替换的那一笔套回原文。 */
const applyAll = (text, query, replacement, opts) => {
  const edit = replaceAllIn(text, query, replacement, opts);
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
};

describe('findMatches：大小写与字面量', () => {
  test('缺省不区分大小写', () => {
    assert.deepEqual(found('Abc abc ABC', 'abc'), ['Abc', 'abc', 'ABC']);
  });

  test('区分大小写时只认一样的', () => {
    assert.deepEqual(found('Abc abc ABC', 'abc', { caseSensitive: true }), ['abc']);
  });

  test('不按正则时元字符是字面量', () => {
    assert.deepEqual(found('a.b axb (a.b)', 'a.b'), ['a.b', 'a.b']);
    assert.deepEqual(found('价格 $1.5 与 [注]', '$1.5'), ['$1.5']);
    assert.deepEqual(found('价格 $1.5 与 [注]', '[注]'), ['[注]']);
  });

  test('中文按字找，位置是字符串下标', () => {
    const text = '林昭推开门。林昭没有说话，林昭。';
    const { matches } = findMatches(text, '林昭');
    assert.deepEqual(matches.map((m) => m.start), [0, 6, 13]);
    assert.ok(matches.every((m) => m.end - m.start === 2));
  });

  test('匹配不重叠：从上一处的末尾往后找', () => {
    assert.deepEqual(findMatches('甲甲甲', '甲甲').matches, [{ start: 0, end: 2 }]);
  });

  test('空查找串：空结果，不报错', () => {
    assert.deepEqual(findMatches('甲乙', ''), { matches: [], truncated: false });
  });
});

describe('findMatches：正则', () => {
  test('按正则找', () => {
    assert.deepEqual(found('第3章 第12章 第章', '第\\d+章', { regex: true }), ['第3章', '第12章']);
  });

  test('^ 认每一行的开头（段首）', () => {
    const text = '　　雨夜。\n　　风起。\n不是段首　　';
    assert.deepEqual(findMatches(text, '^　　', { regex: true }).matches.map((m) => m.start), [0, 6]);
  });

  test('正则也缺省不区分大小写', () => {
    assert.deepEqual(found('Ab ab', 'a.', { regex: true }), ['Ab', 'ab']);
    assert.deepEqual(found('Ab ab', 'a.', { regex: true, caseSensitive: true }), ['ab']);
  });

  test('写错的正则：不抛，给 error', () => {
    const r = findMatches('甲（乙', '(乙', { regex: true });
    assert.deepEqual(r.matches, []);
    assert.equal(typeof r.error, 'string');
    assert.equal(compileSearch('(乙', { regex: true }).ok, false);
  });

  test('u 模式下不合法、普通模式下合法的写法退回普通模式（多写的转义照认）', () => {
    assert.deepEqual(found('他说。好', '\\。', { regex: true }), ['。']);
  });

  test('生僻字（代理对）用 . 匹配时按一个字算', () => {
    assert.deepEqual(found('𠀀甲', '.', { regex: true }), ['𠀀', '甲']);
  });

  test('零长度匹配跳过', () => {
    assert.deepEqual(found('甲乙', '^', { regex: true }), []);
    assert.deepEqual(found('ab cd', '\\b', { regex: true }), []);
    assert.deepEqual(found('xaaxa', 'a*', { regex: true }), ['aa', 'a']);
  });

  test('零长度匹配不把代理对劈开', () => {
    assert.deepEqual(found('𠀀a𠀀', 'a*', { regex: true }), ['a']);
  });

  test('超过上限：只数到上限，标 truncated', () => {
    const r = findMatches('甲'.repeat(10), '甲', {}, 4);
    assert.equal(r.matches.length, 4);
    assert.equal(r.truncated, true);
    assert.equal(findMatches('甲'.repeat(10), '甲').truncated, false);
    assert.ok(MATCH_LIMIT >= 10000);
  });
});

describe('替换：$1 这类引用与 String.prototype.replace 同语义', () => {
  /** 有零长度匹配的不比（那是查找有意跳过的）。 */
  const CASES = [
    ['林昭说：好。沈氏说：走。', '(\\S+?)说：', '$1道：'],
    ['2026-10-18', '(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1'],
    ['甲乙丙', '乙', '[$&]'],
    ['甲乙丙', '乙', "<$`|$'>"],
    ['甲乙丙', '乙', '$$1'],
    ['甲乙丙', '(乙)', '$0$1$2'],
    ['甲乙丙', '(乙)', '$10'],
    ['甲乙丙', '(乙)', '$01'],
    ['甲乙丙', '(?<name>乙)', '<$<name>>'],
    ['甲乙丙', '(?<name>乙)', '<$<nope>>'],
    ['甲乙丙', '(乙)', '$<name>'],
    ['甲乙丙', '(?<name>乙)', '$<name'],
    ['甲乙丙', '乙', '末尾一个$'],
    ['a1b22c333', '(\\d)(\\d)?', '[$2$1]'],
    ['甲乙甲乙', '(?<=甲)乙', '丁'],
    ['一行\n二行\n三行', '^(.)行$', '第$1行'],
  ];

  for (const [text, pattern, template] of CASES) {
    test(`全部替换 /${pattern}/ → ${JSON.stringify(template)}`, () => {
      const expected = text.replace(new RegExp(pattern, 'gimu'), template);
      assert.equal(applyAll(text, pattern, template, { regex: true }), expected);
    });
  }

  test('逐处替换：前后文看的是整份文字（后行断言、$` 都对）', () => {
    const text = '甲乙丙乙';
    const at = findMatches(text, '(?<=丙)乙', { regex: true }).matches[0];
    assert.deepEqual(at, { start: 3, end: 4 });
    assert.equal(replacementFor(text, at, '(?<=丙)乙', "[$`]", { regex: true }), '[甲乙丙]');
  });

  test('逐处替换：$1 取这一处自己的分组', () => {
    const text = '林昭说：好。沈氏说：走。';
    const [, second] = findMatches(text, '(\\S{2})说：', { regex: true }).matches;
    assert.equal(replacementFor(text, second, '(\\S{2})说：', '$1道：', { regex: true }), '沈氏道：');
  });

  test('逐处替换：这一处已经对不上（文字刚变过）时返回 undefined', () => {
    assert.equal(replacementFor('甲乙丙', { start: 0, end: 2 }, '乙', 'x'), undefined);
  });

  test('不按正则时 $1 是字面量', () => {
    assert.equal(applyAll('甲乙丙', '乙', '$1$&'), '甲$1$&丙');
    const at = findMatches('甲乙丙', '乙').matches[0];
    assert.equal(replacementFor('甲乙丙', at, '乙', '$1'), '$1');
  });

  test('expandReplacement 直接用：没有 $ 原样返回', () => {
    const m = /乙/.exec('甲乙');
    assert.equal(expandReplacement('丁', m, '甲乙'), '丁');
  });
});

describe('replaceAllIn：一笔改动覆盖第一处到最后一处', () => {
  test('只覆盖第一处到最后一处之间，前后不动', () => {
    const text = '开头。林昭来了，林昭走了。结尾。';
    const edit = replaceAllIn(text, '林昭', '沈氏');
    assert.equal(edit.count, 2);
    assert.equal(edit.start, 3);
    assert.equal(edit.end, 10);
    assert.equal(edit.text, '沈氏来了，沈氏');
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '开头。沈氏来了，沈氏走了。结尾。');
  });

  test('不区分大小写的全部替换', () => {
    assert.equal(applyAll('Hi hi HI', 'hi', 'yo'), 'yo yo yo');
    assert.equal(applyAll('Hi hi HI', 'hi', 'yo', { caseSensitive: true }), 'Hi yo HI');
  });

  test('替换成含查找串的文字不会没完没了', () => {
    assert.equal(applyAll('甲乙甲', '甲', '甲甲'), '甲甲乙甲甲');
  });

  test('一处都没有、空查找串、坏正则：undefined', () => {
    assert.equal(replaceAllIn('甲乙', '丙', 'x'), undefined);
    assert.equal(replaceAllIn('甲乙', '', 'x'), undefined);
    assert.equal(replaceAllIn('甲乙', '(', 'x', { regex: true }), undefined);
  });

  test('不受查找的计数上限限制', () => {
    const text = '甲'.repeat(MATCH_LIMIT + 5);
    assert.equal(replaceAllIn(text, '甲', '乙').count, MATCH_LIMIT + 5);
  });

  test('零长度匹配不算一处', () => {
    const edit = replaceAllIn('xaaxa', 'a*', '-', { regex: true });
    assert.equal(edit.count, 2);
    assert.equal('xaaxa'.slice(0, edit.start) + edit.text + 'xaaxa'.slice(edit.end), 'x-x-');
  });
});

describe('在匹配表里定位', () => {
  const ms = [{ start: 2, end: 3 }, { start: 5, end: 6 }, { start: 9, end: 10 }];

  test('matchAfter：start ≥ pos 的第一处，到头绕回第一处', () => {
    assert.equal(matchAfter(ms, 0), 0);
    assert.equal(matchAfter(ms, 2), 0);
    assert.equal(matchAfter(ms, 3), 1);
    assert.equal(matchAfter(ms, 10), 0);
    assert.equal(matchAfter([], 0), -1);
  });

  test('matchBefore：start < pos 的最后一处，到头绕回最后一处', () => {
    assert.equal(matchBefore(ms, 9), 1);
    assert.equal(matchBefore(ms, 10), 2);
    assert.equal(matchBefore(ms, 2), 2);
    assert.equal(matchBefore([], 0), -1);
  });

  test('nearestMatch：不在 pos 前面的最近一处，都在前面取最后一处', () => {
    assert.equal(nearestMatch(ms, 4), 1);
    assert.equal(nearestMatch(ms, 5), 1);
    assert.equal(nearestMatch(ms, 99), 2);
  });

  test('matchAt：正好是那一处才认', () => {
    assert.equal(matchAt(ms, 5, 6), 1);
    assert.equal(matchAt(ms, 5, 5), -1);
    assert.equal(matchAt(ms, 4, 6), -1);
  });
});

describe('选区预填', () => {
  test('一行之内的短文字预填', () => {
    assert.equal(seedFromSelection('甲乙丙', 1, 3), '乙丙');
  });

  test('没选中、跨行、太长都不预填', () => {
    assert.equal(seedFromSelection('甲乙丙', 1, 1), undefined);
    assert.equal(seedFromSelection('甲\n乙', 0, 3), undefined);
    assert.equal(seedFromSelection('甲'.repeat(200), 0, 200), undefined);
  });

  test('escapeRegExp 让预填的字在正则模式下仍按字面找', () => {
    assert.deepEqual(found('a.b axb', escapeRegExp('a.b'), { regex: true }), ['a.b']);
  });
});

describe('replaceSelectedIn：只换挑出来的那几处（全书替换）', () => {
  const text = '林晚推门。林晚没说话。林晚霞走了。';
  const all = findMatches(text, '林晚').matches;

  test('全挑：与全部替换的结果一样', () => {
    const r = replaceSelectedIn(text, all, '林晚', '林婉');
    assert.equal(r.text, applyAll(text, '林晚', '林婉'));
    assert.equal(r.replaced.length, 3);
    assert.deepEqual(r.missed, []);
  });

  test('勾掉一处（「林晚霞」是另一个人）：那一处原样留着', () => {
    const r = replaceSelectedIn(text, all.slice(0, 2), '林晚', '林婉');
    assert.equal(r.text, '林婉推门。林婉没说话。林晚霞走了。');
    assert.equal(r.replaced.length, 2);
  });

  test('挑的顺序无所谓，按位置排', () => {
    const r = replaceSelectedIn(text, [all[2], all[0]], '林晚', '林婉');
    assert.equal(r.text, '林婉推门。林晚没说话。林婉霞走了。');
  });

  test('一处都不挑：原文不动', () => {
    const r = replaceSelectedIn(text, [], '林晚', '林婉');
    assert.equal(r.text, text);
    assert.deepEqual(r.replaced, []);
  });

  test('对不上的位置（文字变过、不是一处匹配、与前一处重叠）不换，记进 missed', () => {
    const r = replaceSelectedIn(text, [{ start: 1, end: 3 }, all[1], { start: all[1].start, end: all[1].end }], '林晚', '林婉');
    assert.equal(r.text, '林晚推门。林婉没说话。林晚霞走了。');
    assert.equal(r.replaced.length, 1);
    assert.equal(r.missed.length, 2);
  });

  test('正则：$1 在原文里逐处展开，前后文看整份文字', () => {
    const t = '第1章 第2章 第3章';
    const ms = findMatches(t, '第(\\d)章', { regex: true }).matches;
    const r = replaceSelectedIn(t, [ms[0], ms[2]], '第(\\d)章', 'Ch$1', { regex: true });
    assert.equal(r.text, 'Ch1 第2章 Ch3');
    // 后行断言：只认「林」后面的「晚」，看的是整份原文
    const t2 = '林晚 夜晚';
    const ms2 = findMatches(t2, '(?<=林)晚', { regex: true }).matches;
    assert.equal(ms2.length, 1);
    assert.equal(replaceSelectedIn(t2, ms2, '(?<=林)晚', '婉', { regex: true }).text, '林婉 夜晚');
  });

  test('跨行的匹配照样换', () => {
    const t = '上一行末尾\n下一行开头';
    const ms = findMatches(t, '末尾\\n下', { regex: true }).matches;
    assert.equal(ms.length, 1);
    assert.equal(replaceSelectedIn(t, ms, '末尾\\n下', '末尾。下', { regex: true }).text, '上一行末尾。下一行开头');
  });

  test('坏正则、空查找串：undefined，不抛', () => {
    assert.equal(replaceSelectedIn(text, all, '(', 'x', { regex: true }), undefined);
    assert.equal(replaceSelectedIn(text, all, '', 'x'), undefined);
  });
});

describe('匹配口径只有一份', () => {
  test('编辑器的 findCore 转出的就是 core 的 textFind（全书查找替换在后端用的那一份）', () => {
    const t = 'Abc abc ABC a.b';
    for (const [q, o] of [['abc', {}], ['abc', { caseSensitive: true }], ['a.b', {}], ['a.b', { regex: true }], ['^', { regex: true }]]) {
      assert.deepEqual(findMatches(t, q, o), core.findMatches(t, q, o));
    }
    assert.equal(MATCH_LIMIT, core.MATCH_LIMIT);
  });
});
