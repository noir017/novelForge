/**
 * 段级 diff（W11）：合并视图按段对齐两个版本。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 相同的段连成一截，相邻的增删改并成一处 | 一段改写 = 删一段 + 加一段，挨着的就是同一处 |
 * | 只差空白的两段算同一段 | 不值得让作者为一个换行点一次「采用」 |
 * | 拼合并结果：没给的用新版、空的整段删 | 合并视图交回去的就是这一份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const d = loadModule('src/core/model/paragraphDiff.ts');

describe('paragraphDiff.ts · 切段', () => {
  test('按空行切，段内换行保留，首尾空白去掉', () => {
    assert.deepEqual(d.splitParagraphs('\n\n甲\n乙\n\n  \n丙  \n\n\n'), ['甲\n乙', '丙']);
  });

  test('CRLF 照认', () => {
    assert.deepEqual(d.splitParagraphs('甲\r\n\r\n乙'), ['甲', '乙']);
  });
});

describe('paragraphDiff.ts · diff', () => {
  test('一模一样：一截 same', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n乙', '甲\n\n乙'), [{ kind: 'same', paragraphs: ['甲', '乙'] }]);
  });

  test('改了中间一段：删一段 + 加一段并成一处', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n乙二\n\n丙'), [
      { kind: 'same', paragraphs: ['甲'] },
      { kind: 'change', old: ['乙'], new: ['乙二'] },
      { kind: 'same', paragraphs: ['丙'] },
    ]);
  });

  test('只增、只删', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n丙', '甲\n\n乙\n\n丙')[1], { kind: 'change', old: [], new: ['乙'] });
    assert.deepEqual(d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n丙')[1], { kind: 'change', old: ['乙'], new: [] });
  });

  test('两处不相邻的改动是两处', () => {
    const segs = d.diffParagraphs('一\n\n二\n\n三\n\n四', '一改\n\n二\n\n三\n\n四改');
    assert.equal(d.changeCount(segs), 2);
  });

  test('只差空白的两段算同一段，文字取新版', () => {
    const segs = d.diffParagraphs('甲 乙', '甲乙');
    assert.deepEqual(segs, [{ kind: 'same', paragraphs: ['甲乙'] }]);
  });

  test('一边是空的', () => {
    assert.deepEqual(d.diffParagraphs('', '甲'), [{ kind: 'change', old: [], new: ['甲'] }]);
    assert.deepEqual(d.diffParagraphs('', ''), []);
  });
});

describe('paragraphDiff.ts · 拼结果', () => {
  const segs = d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n乙二\n\n丙');

  test('没给结果的用新版', () => {
    assert.equal(d.joinMerge(segs), '甲\n\n乙二\n\n丙\n');
  });

  test('保留原文 / 手改 / 整段删', () => {
    assert.equal(d.joinMerge(segs, { 1: d.sideText(segs[1], 'old') }), '甲\n\n乙\n\n丙\n');
    assert.equal(d.joinMerge(segs, { 1: '作者自己写的' }), '甲\n\n作者自己写的\n\n丙\n');
    assert.equal(d.joinMerge(segs, { 1: '' }), '甲\n\n丙\n');
  });
});
