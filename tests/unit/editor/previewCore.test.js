/**
 * Markdown 预览的纯函数（`media/src/editor/previewCore.ts`，零 DOM）：切块时每一块记下的源行号（标题、段落、列表、代码块、
 * frontmatter、分隔线、引用），以及切预览 / 切回编辑时两边滚到同一处的换算——编辑区里「纵向位置 ↔ 第几行（带小数）」
 * 与预览里「第几行 ↔ 纵向位置」。按标签记住、真的滚到哪在 tests/dom/standalone/preview.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { previewBlocks, sourceToPreviewY, previewYToSource, lineAtY, yOfLine, lineStarts, lineOfOffset } = loadModule(
  'media/src/editor/previewCore.ts'
);

/** 每一块：种类与 [start, end)（列表另列每一项）。 */
const spans = (text) =>
  previewBlocks(text).map((b) =>
    b.kind === 'list' ? [b.kind, b.start, b.end, b.items.map((i) => [i.start, i.end, i.text])] : [b.kind, b.start, b.end]
  );

describe('previewBlocks：每一块是源文件的第几行到第几行', () => {
  test('frontmatter 是开头那一段连同两条 ---；标题一行一块（h4 以下当 h3）', () => {
    const text = '---\ntitle: 夜访\nno: 3\n---\n# 第三章\n\n#### 小节\n';
    assert.deepEqual(spans(text), [
      ['frontmatter', 0, 4],
      ['heading', 4, 5],
      ['heading', 6, 7],
    ]);
    const blocks = previewBlocks(text);
    assert.equal(blocks[0].text, 'title: 夜访\nno: 3');
    assert.deepEqual([blocks[1].level, blocks[2].level], [1, 3]);
  });

  test('没有收尾的 --- 不算 frontmatter（第一行当分隔线）', () => {
    assert.deepEqual(spans('---\n正文第一行'), [
      ['hr', 0, 1],
      ['paragraph', 1, 2],
    ]);
  });

  test('段落：连着的几行是一段，空行断开；段首缩进的正文没有空行，整段连成一块', () => {
    assert.deepEqual(spans('雨下了三天。\n\n林昭推门进来，\n带进一身湿气。\n\n'), [
      ['paragraph', 0, 1],
      ['paragraph', 2, 4],
    ]);
    assert.deepEqual(spans('　　第一段。\n　　第二段。\n　　第三段。'), [['paragraph', 0, 3]]);
  });

  test('代码块从开头那条 ``` 到收尾那条；没收尾就到文末', () => {
    assert.deepEqual(spans('前\n```\na\nb\n```\n后'), [
      ['paragraph', 0, 1],
      ['code', 1, 5],
      ['paragraph', 5, 6],
    ]);
    assert.equal(previewBlocks('```\na\nb\n```').at(0).text, 'a\nb');
    assert.deepEqual(spans('前\n```\na\nb'), [
      ['paragraph', 0, 1],
      ['code', 1, 4],
    ]);
  });

  test('列表：连着的同一种列表项是一张表，每一项一行；换一种另起一张，空行结束', () => {
    assert.deepEqual(spans('- 甲\n- 乙\n1. 一\n2) 二\n\n* 丙'), [
      ['list', 0, 2, [[0, 1, '甲'], [1, 2, '乙']]],
      ['list', 2, 4, [[2, 3, '一'], [3, 4, '二']]],
      ['list', 5, 6, [[5, 6, '丙']]],
    ]);
  });

  test('引用一行一块；分隔线一行一块；段落碰到它们就断开', () => {
    assert.deepEqual(spans('一段\n> 引一\n> 引二\n***\n又一段'), [
      ['paragraph', 0, 1],
      ['quote', 1, 2],
      ['quote', 2, 3],
      ['hr', 3, 4],
      ['paragraph', 4, 5],
    ]);
  });

  test('\\r\\n 与 \\n 切出来的行号一样（textarea 里是 \\n）', () => {
    const lf = '---\na: 1\n---\n# 题\n\n正文\n- 项';
    assert.deepEqual(spans(lf.replace(/\n/g, '\r\n')), spans(lf));
  });

  test('各块（列表按项）互不重叠、按行号排好', () => {
    const text = '---\na: 1\n---\n# 题\n\n一段\n两行\n\n- 甲\n- 乙\n\n```\ncode\n```\n> 引\n---\n尾';
    const leaves = previewBlocks(text).flatMap((b) => (b.kind === 'list' ? b.items : [b]));
    for (let i = 1; i < leaves.length; i++) {
      assert.ok(leaves[i].start >= leaves[i - 1].end, JSON.stringify([leaves[i - 1], leaves[i]]));
    }
  });
});

describe('预览里：第几行 ↔ 纵向位置', () => {
  // 第 2–3 行一块（高 100，顶 40），第 6 行一块（高 30，顶 200），第 7–9 行一块（高 90，顶 250）。
  const boxes = [
    { start: 2, end: 4, top: 40, height: 100 },
    { start: 6, end: 7, top: 200, height: 30 },
    { start: 7, end: 10, top: 250, height: 90 },
  ];

  test('落在一块里：按它占这一块几行的比例摆', () => {
    assert.equal(sourceToPreviewY(boxes, 2), 40);
    assert.equal(sourceToPreviewY(boxes, 3), 90);
    assert.equal(sourceToPreviewY(boxes, 8.5), 295);
  });

  test('落在两块之间的空行上：在上一块的底与下一块的顶之间按比例摆', () => {
    assert.equal(sourceToPreviewY(boxes, 4), 140);
    assert.equal(sourceToPreviewY(boxes, 5), 170);
  });

  test('第一块之前从 0 摆到它的顶；最后一块之后是它的底；一块都没有是 0', () => {
    assert.equal(sourceToPreviewY(boxes, 0), 0);
    assert.equal(sourceToPreviewY(boxes, 1), 20);
    assert.equal(sourceToPreviewY(boxes, 12), 340);
    assert.equal(sourceToPreviewY([], 5), 0);
  });

  test('反过来：纵向位置 → 第几行', () => {
    assert.equal(previewYToSource(boxes, 0), 0);
    assert.equal(previewYToSource(boxes, 20), 1);
    assert.equal(previewYToSource(boxes, 90), 3);
    assert.equal(previewYToSource(boxes, 170), 5);
    assert.equal(previewYToSource(boxes, 999), 10);
    assert.equal(previewYToSource([], 50), 0);
  });

  test('来回换一遍回到原处（块里、空行上都是）', () => {
    for (const pos of [0, 0.5, 2, 2.25, 3.9, 4.5, 6, 7.75, 9.5]) {
      assert.ok(Math.abs(previewYToSource(boxes, sourceToPreviewY(boxes, pos)) - pos) < 1e-9, String(pos));
    }
  });

  test('高为 0 的块（量不出高）不除以 0', () => {
    const flat = [{ start: 0, end: 2, top: 0, height: 0 }, { start: 3, end: 4, top: 0, height: 0 }];
    assert.equal(Number.isFinite(sourceToPreviewY(flat, 1)), true);
    assert.equal(Number.isFinite(previewYToSource(flat, 0)), true);
  });
});

describe('编辑区里：纵向位置 ↔ 第几行（带小数）', () => {
  // 五行：第 2 行折成三行（高 90），其余一行 30。
  const heights = [30, 30, 90, 30, 30];
  const tops = heights.reduce((acc, h) => [...acc, acc[acc.length - 1] + h], [0]);
  let measured = 0;
  const topOf = (i) => {
    measured++;
    return tops[i];
  };

  test('落在哪一行、往下几成：第 2 行一半是 2.5', () => {
    assert.equal(lineAtY(5, topOf, 0), 0);
    assert.equal(lineAtY(5, topOf, 45), 1.5);
    assert.equal(lineAtY(5, topOf, 105), 2.5);
    assert.equal(lineAtY(5, topOf, 150), 3);
    assert.equal(lineAtY(5, topOf, 9999), 5);
  });

  test('反过来：第几行 → 纵向位置；越界夹住', () => {
    assert.equal(yOfLine(5, topOf, 2.5), 105);
    assert.equal(yOfLine(5, topOf, 0), 0);
    assert.equal(yOfLine(5, topOf, 7), 210);
    assert.equal(yOfLine(5, topOf, -1), 0);
  });

  test('二分：一千行只量十来次', () => {
    measured = 0;
    lineAtY(1000, (i) => {
      measured++;
      return i * 30;
    }, 12345);
    assert.ok(measured <= 14, `量了 ${measured} 次`);
  });

  test('没有行时是 0', () => {
    assert.equal(lineAtY(0, topOf, 50), 0);
    assert.equal(yOfLine(0, topOf, 3), 0);
  });
});

describe('行首与行号', () => {
  test('lineStarts：每一行开头的下标；lineOfOffset：下标落在第几行', () => {
    const starts = lineStarts('ab\n\ncd\n');
    assert.deepEqual(starts, [0, 3, 4, 7]);
    assert.deepEqual([0, 2, 3, 4, 6, 7].map((o) => lineOfOffset(starts, o)), [0, 0, 1, 2, 2, 3]);
  });
});
