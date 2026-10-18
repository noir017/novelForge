/**
 * 段落聚焦认「光标在哪一段」与打字机滚动算「该滚到哪」（`media/src/editor/focusCore.ts`，纯函数、零 DOM）。
 * 分段按工程的三种分段格式认：空行分段（`blank`）/ 段首缩进（`indent`）/ 两者都要（`both`）。
 * 图层与滚动本身在 tests/dom/standalone/focus.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { paragraphRangeAt, typewriterScrollTop } = loadModule('media/src/editor/focusCore.ts');

const I = '　　';
/** 光标停在 `marker` 那几个字前面时，当前段的文字。 */
const paraAt = (text, marker, style, offset = 0) => {
  const caret = text.indexOf(marker) + offset;
  assert.ok(caret >= 0, `找不到 ${marker}`);
  const r = paragraphRangeAt(text, caret, style);
  return text.slice(r.start, r.end);
};

describe('段落聚焦：空行分段（blank）', () => {
  const text = '第一段。\n\n第二段前半，\n续行（Shift+Enter 打的）。\n\n第三段。';

  test('空行隔开的一整块是一段', () => {
    assert.equal(paraAt(text, '第一段', 'blank'), '第一段。');
  });

  test('块里不空行的换行仍在这一段里（光标在第一行）', () => {
    assert.equal(paraAt(text, '第二段', 'blank'), '第二段前半，\n续行（Shift+Enter 打的）。');
  });

  test('光标在续行里：同一段', () => {
    assert.equal(paraAt(text, '续行', 'blank'), '第二段前半，\n续行（Shift+Enter 打的）。');
  });

  test('最后一段（文末没有换行）', () => {
    assert.equal(paraAt(text, '第三段', 'blank'), '第三段。');
  });

  test('光标在行尾（换行之前）仍算这一段', () => {
    assert.equal(paraAt(text, '第一段。', 'blank', 4), '第一段。');
  });

  test('光标落在空行上：那一段就是这一行（空的）', () => {
    const r = paragraphRangeAt(text, text.indexOf('\n\n') + 1, 'blank');
    assert.deepEqual(r, { start: text.indexOf('\n\n') + 1, end: text.indexOf('\n\n') + 1 });
  });

  test('空行分段里行首有缩进也不另起一段', () => {
    const t = `${I}甲。\n${I}乙。\n\n丙。`;
    assert.equal(paraAt(t, '乙', 'blank'), `${I}甲。\n${I}乙。`);
  });

  test('标题行自成一段（后面紧跟正文也不连上）', () => {
    const t = '# 第一章\n正文第一行。\n正文第二行。';
    assert.deepEqual([paraAt(t, '第一章', 'blank'), paraAt(t, '正文第二行', 'blank')], ['# 第一章', '正文第一行。\n正文第二行。']);
  });

  test('场景分隔行自成一段', () => {
    const t = '前文。\n* * *\n后文。';
    assert.deepEqual([paraAt(t, '* * *', 'blank'), paraAt(t, '后文', 'blank')], ['* * *', '后文。']);
  });

  test('只有空白的行算空行（全角空格、制表符）', () => {
    const t = `甲。\n${I}\t\n乙。`;
    assert.equal(paraAt(t, '乙', 'blank'), '乙。');
  });

  test('空文档：光标在 0，段是空的', () => {
    assert.deepEqual(paragraphRangeAt('', 0, 'blank'), { start: 0, end: 0 });
  });

  test('光标越界夹进去，不抛', () => {
    assert.deepEqual(paragraphRangeAt('甲\n乙', 99, 'blank'), { start: 0, end: 3 });
  });
});

describe('段落聚焦：段首缩进（indent）', () => {
  const text = `${I}第一段。\n${I}第二段前半，\n续行（Shift+Enter 打的）。\n${I}第三段。`;

  test('行首有缩进的那一行另起一段', () => {
    assert.equal(paraAt(text, '第一段', 'indent'), `${I}第一段。`);
  });

  test('行首没缩进、紧跟在一行字后面的是上一段的续行', () => {
    assert.equal(paraAt(text, '续行', 'indent'), `${I}第二段前半，\n续行（Shift+Enter 打的）。`);
  });

  test('光标在段首的缩进里：仍是这一段', () => {
    assert.equal(paraAt(text, `${I}第三段`, 'indent', 1), `${I}第三段。`);
  });

  test('半角空格缩进也认', () => {
    const t = '  甲。\n  乙。';
    assert.equal(paraAt(t, '乙', 'indent'), '  乙。');
  });

  test('空行也隔开段落', () => {
    const t = `${I}甲。\n\n乙。`;
    assert.equal(paraAt(t, '乙', 'indent'), '乙。');
  });

  test('标题后面的第一段（有缩进）与标题分开', () => {
    const t = `# 第一章\n${I}正文。`;
    assert.equal(paraAt(t, '正文', 'indent'), `${I}正文。`);
  });

  test('文首那一行没缩进（章名）自成一段，下一行有缩进另起', () => {
    const t = `第一章 风起\n${I}正文。`;
    assert.deepEqual([paraAt(t, '风起', 'indent'), paraAt(t, '正文', 'indent')], ['第一章 风起', `${I}正文。`]);
  });
});

describe('段落聚焦：缩进加空行（both）', () => {
  test('空行隔开', () => {
    const t = `${I}甲。\n\n${I}乙。`;
    assert.equal(paraAt(t, '乙', 'both'), `${I}乙。`);
  });

  test('块里行首有缩进的那一行也另起一段', () => {
    const t = `${I}甲。\n${I}乙。\n\n${I}丙。`;
    assert.deepEqual([paraAt(t, '甲', 'both'), paraAt(t, '乙', 'both')], [`${I}甲。`, `${I}乙。`]);
  });

  test('块里行首没缩进的是续行', () => {
    const t = `${I}甲，\n接着甲。\n\n${I}乙。`;
    assert.equal(paraAt(t, '接着', 'both'), `${I}甲，\n接着甲。`);
  });

  test('同一份文字，空行分段把两行缩进当一段、两者都要分成两段', () => {
    const t = `${I}甲。\n${I}乙。`;
    assert.deepEqual([paraAt(t, '乙', 'blank'), paraAt(t, '乙', 'both')], [t, `${I}乙。`]);
  });
});

describe('打字机滚动：该滚到哪', () => {
  test('光标那一行的中线落在视口中间', () => {
    // 行顶 600、行高 30，视口 300：中线 615 - 150 = 465。
    assert.equal(typewriterScrollTop(600, 30, 300, 0), 465);
  });

  test('已经在中间（差不到 1px）：不动', () => {
    assert.equal(typewriterScrollTop(600, 30, 300, 465), undefined);
  });

  test('开头几行滚不到中间：夹到 0', () => {
    assert.equal(typewriterScrollTop(18, 30, 300, 120), 0);
  });

  test('已经在 0、光标在开头：不动', () => {
    assert.equal(typewriterScrollTop(18, 30, 300, 0), undefined);
  });

  test('取整像素', () => {
    assert.equal(typewriterScrollTop(100.4, 29.5, 300, 50), 0);
    assert.equal(typewriterScrollTop(400.4, 29.5, 300, 0), 265);
  });
});
