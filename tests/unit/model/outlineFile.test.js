/**
 * 情节大纲按章号区间切片（model/outlineFile.ts）。
 *
 * 三处要用它：续写大纲时判「覆盖到第几章」、细纲按「覆盖本章的那一节」记上游指纹、
 * 写正文时只带本章所在的那一节。解析一律不抛（第 1 条）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let O;
before(() => {
  O = loadModule('src/core/model/outlineFile.ts');
});

const OUTLINE = [
  '# 情节大纲',
  '',
  '全书一句话：少年夜渡青河。',
  '',
  '## 第1–20章：第一幕 · 入局',
  '林昭入宗，初见沈青。',
  '',
  '### 第1-3章 黄金三章',
  '三章内立住金手指。',
  '',
  '## 第21 至 40 章：第二幕',
  '宗门大比。',
  '',
  '## 后续概览',
  '第三幕只写一行。',
].join('\n');

describe('parseOutlineRanges', () => {
  test('认出全部区间标题，按出现顺序', () => {
    const r = O.parseOutlineRanges(OUTLINE);
    assert.deepEqual(r.map((x) => [x.from, x.to]), [[1, 20], [1, 3], [21, 40]]);
  });

  test('标题取冒号后面那一段', () => {
    const r = O.parseOutlineRanges(OUTLINE);
    assert.equal(r[0].title, '第一幕 · 入局');
    assert.equal(r[1].title, '黄金三章');
  });

  test('一节到下一个同级或更高级标题为止；### 子节不截断 ## 那一节之外的内容', () => {
    const [first, sub, second] = O.parseOutlineRanges(OUTLINE);
    assert.equal(first.text, '林昭入宗，初见沈青。');
    assert.equal(sub.text, '三章内立住金手指。');
    // 「## 后续概览」是普通标题，结束第二幕那一节。
    assert.equal(second.text, '宗门大比。');
  });

  for (const [line, from, to] of [
    ['## 第7章：夜访', 7, 7],
    ['## 第 7 章', 7, 7],
    ['## 第1-20章', 1, 20],
    ['## 第1—20章：甲', 1, 20],
    ['## 第1~20章', 1, 20],
    ['## 第1～20章', 1, 20],
    ['## 第1到20章', 1, 20],
    ['## 第1章-第20章：甲', 1, 20],
    ['## 第1-第20章', 1, 20],
    ['## 第20–1章', 1, 20],
    ['### 第3章: 半角冒号', 3, 3],
  ]) {
    test(`写法：${line}`, () => {
      const r = O.parseOutlineRanges(`${line}\n内容`);
      assert.equal(r.length, 1, JSON.stringify(r));
      assert.deepEqual([r[0].from, r[0].to], [from, to]);
    });
  }

  for (const line of ['# 第1-20章', '## 第一章', '## 第 3 节', '## 1-20章', '第1-20章：没有井号']) {
    test(`不是区间标题：${line}`, () => {
      assert.equal(O.parseOutlineRanges(`${line}\n内容`).length, 0);
    });
  }

  test('空串、undefined、只有 BOM 都不抛', () => {
    assert.deepEqual(O.parseOutlineRanges(''), []);
    assert.deepEqual(O.parseOutlineRanges(undefined), []);
    assert.deepEqual(O.parseOutlineRanges('﻿'), []);
  });

  test('CRLF 也认', () => {
    const r = O.parseOutlineRanges('## 第1-5章：甲\r\n一\r\n## 第6-9章：乙\r\n二');
    assert.deepEqual(r.map((x) => [x.from, x.to, x.text]), [[1, 5, '一'], [6, 9, '二']]);
  });
});

describe('outlineCoverage', () => {
  test('取最大的 to', () => {
    assert.equal(O.outlineCoverage(OUTLINE), 40);
  });

  test('有内容但没有区间标题：Infinity（不拦老工程）', () => {
    assert.equal(O.outlineCoverage('# 大纲\n\n一个散文式的大纲。'), Infinity);
  });

  test('空：0', () => {
    assert.equal(O.outlineCoverage('  \n'), 0);
  });
});

describe('outlineSliceFor', () => {
  test('落在区间里的章拿到那一节；重叠时取先出现的', () => {
    assert.equal(O.outlineSliceFor(OUTLINE, 2).from, 1);
    assert.equal(O.outlineSliceFor(OUTLINE, 2).to, 20);
    assert.equal(O.outlineSliceFor(OUTLINE, 30).title, '第二幕');
  });

  test('区间之外：undefined', () => {
    assert.equal(O.outlineSliceFor(OUTLINE, 41), undefined);
  });
});
