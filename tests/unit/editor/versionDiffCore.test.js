/**
 * 「版本」对比标签的纯函数（`media/src/editor/versionDiffCore.ts`，零 DOM）：按行比、逐字标、「用回这一处」的替换。
 * 画出来、点按钮、放回编辑区在 tests/dom/standalone/versions.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 按行比 | 三种分段格式里一行就是一段：「段首缩进」不空行也能逐段比（合并视图按空行切段，整章会成一段） |
 * | 空白 | 空行不算行、行首行尾空白不算不同；只差这些时 `onlyWhitespace` |
 * | 最短 | 随机两版：相同的行数等于 LCS，块首尾相接盖满两边 |
 * | 逐字 | 删掉的在左、加上的在右；夹在两处改动中间的一两个字并进改动；改得太多不标（给 undefined） |
 * | 用回这一处 | 两边都有、只有右边（删）、只有左边（插回去，分隔照左边原来的）、在开头 / 结尾；逐处用回去还原出左边 |
 * | 换行 | `\r\n` 归一成 `\n`，下标与编辑区 `area.value` 同一套 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { diffLines, onlyWhitespace, blockText, charDiff, revertEdit, MAX_CHAR_EDITS } = loadModule(
  'media/src/editor/versionDiffCore.ts'
);

/** 块的样子：['same' | 'change', 左边几行, 右边几行]。 */
const shape = (d) => d.blocks.map((b) => [b.kind, b.left[1] - b.left[0], b.right[1] - b.right[0]]);
const apply = (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end);

describe('diffLines：按行比', () => {
  test('「段首缩进」格式：段与段之间不空行，照样逐段比出改了哪一段', () => {
    const before = '　　他推开门。\n　　雨下了三天。\n　　灯还亮着。\n';
    const after = '　　他推开门。\n　　雨还在下。\n　　灯还亮着。\n';
    const d = diffLines(before, after);
    assert.deepEqual(shape(d), [
      ['same', 1, 1],
      ['change', 1, 1],
      ['same', 1, 1],
    ]);
    assert.equal(d.changes, 1);
    assert.equal(blockText(d, d.blocks[1], 'left'), '　　雨下了三天。');
    assert.equal(blockText(d, d.blocks[1], 'right'), '　　雨还在下。');
  });

  test('空行不算行、行首行尾空白不算不同：一键排版补的缩进、多一个空行都不是改动', () => {
    const d = diffLines('他推开门。\n\n雨下了三天。\n', '　　他推开门。\n\n\n　　雨下了三天。  \n');
    assert.equal(d.changes, 0);
    assert.equal(onlyWhitespace(d), true);
    assert.equal(onlyWhitespace(diffLines('一\n', '一\n')), false);
  });

  test('加了一段、删了一段：一边是空的', () => {
    const d = diffLines('甲\n乙\n丁\n', '甲\n乙\n丙\n丁\n');
    assert.deepEqual(shape(d), [
      ['same', 2, 2],
      ['change', 0, 1],
      ['same', 1, 1],
    ]);
    assert.deepEqual(shape(diffLines('甲\n乙\n丙\n', '乙\n丙\n')), [
      ['change', 1, 0],
      ['same', 2, 2],
    ]);
  });

  test('最短：随机两版，相同的行数等于 LCS，块首尾相接盖满两边', () => {
    const lcs = (a, b) => {
      const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      return dp[0][0];
    };
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 2000; t++) {
      const a = Array.from({ length: rnd(10) }, () => '甲乙丙'[rnd(3)]);
      const b = Array.from({ length: rnd(10) }, () => '甲乙丙'[rnd(3)]);
      const d = diffLines(a.join('\n'), b.join('\n'));
      let same = 0;
      let at = [0, 0];
      for (const blk of d.blocks) {
        assert.deepEqual([blk.left[0], blk.right[0]], at, JSON.stringify({ a, b }));
        at = [blk.left[1], blk.right[1]];
        if (blk.kind === 'same') {
          same += blk.left[1] - blk.left[0];
        }
      }
      assert.deepEqual(at, [a.length, b.length]);
      assert.equal(same, lcs(a, b), JSON.stringify({ a, b }));
    }
  });

  test('\\r\\n 归一成 \\n：下标与编辑区 area.value 同一套', () => {
    const d = diffLines('甲\r\n乙\r\n', '甲\r\n丙\r\n');
    assert.equal(d.after, '甲\n丙\n');
    assert.deepEqual([d.right[1].start, d.right[1].end], [2, 3]);
  });
});

describe('charDiff：一处改动里逐字标', () => {
  test('删掉的在左、加上的在右（下标按那段文字）', () => {
    const m = charDiff('他推开门。', '他慢慢推开门。');
    assert.deepEqual(m, { left: [], right: [[1, 3]] });
  });

  test('夹在两处改动中间的一两个字并进改动：不把一句改写切成碎片', () => {
    // 「雨下了三天」→「雨还在下」：中间碰巧相同的「下」不单独留着。
    const m = charDiff('雨下了三天。', '雨还在下。');
    assert.deepEqual(m, { left: [[1, 5]], right: [[1, 4]] });
  });

  test('码点算：emoji 不从中间切开', () => {
    const m = charDiff('好😀', '好😎');
    assert.deepEqual(m, { left: [[1, 3]], right: [[1, 3]] });
  });

  test('改得太多：给 undefined，只标整行', () => {
    const a = '甲'.repeat(MAX_CHAR_EDITS + 10);
    const b = '乙'.repeat(MAX_CHAR_EDITS + 10);
    assert.equal(charDiff(a, b), undefined);
  });
});

describe('revertEdit：用回这一处', () => {
  test('两边都有：右边那几行换成左边那几行（行首缩进照左边的）', () => {
    const before = '　　甲。\n　　乙。\n　　丙。\n';
    const after = '　　甲。\n　　乙改。\n　　丙。\n';
    const d = diffLines(before, after);
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), before);
  });

  test('只有右边（现在多出来的）：连同前面那道分隔一起删；在开头就连同后面那道', () => {
    const d = diffLines('甲\n\n丙\n', '甲\n\n乙\n\n丙\n');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), '甲\n\n丙\n');
    const d2 = diffLines('乙\n\n丙\n', '甲\n\n乙\n\n丙\n');
    assert.equal(apply(d2.after, revertEdit(d2, d2.blocks[0])), '乙\n\n丙\n');
  });

  test('只有左边（现在少了的）：插回前一行之后，分隔照左边原来的；在开头就插在第一行之前', () => {
    const d = diffLines('甲\n\n乙\n\n丙\n', '甲\n\n丙\n');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), '甲\n\n乙\n\n丙\n');
    const d2 = diffLines('甲\n\n乙\n', '乙\n');
    assert.equal(apply(d2.after, revertEdit(d2, d2.blocks[0])), '甲\n\n乙\n');
  });

  test('现在是空的：整份插回去', () => {
    const d = diffLines('甲\n乙\n', '');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[0])), '甲\n乙');
  });

  test('逐处用回去（从后往前，下标不受前面影响）：还原出左边', () => {
    const before = '一\n\n二\n\n三\n\n四\n\n五\n';
    const after = '一\n\n二改\n\n三\n\n新\n\n五\n\n六\n';
    const d = diffLines(before, after);
    let text = d.after;
    for (const blk of [...d.blocks].reverse()) {
      if (blk.kind === 'change') {
        text = apply(text, revertEdit(d, blk));
      }
    }
    assert.equal(text, '一\n\n二\n\n三\n\n四\n\n五\n');
  });
});
