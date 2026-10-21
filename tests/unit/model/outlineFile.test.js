/**
 * 情节大纲一章一条（model/outlineFile.ts，docs/design/plans/2026-10-21-outline-per-chapter.md）。
 *
 * 几处要用它：续写大纲时判「覆盖到第几章」、细纲按「这一章那一条」记上游指纹、装配时按远近带
 * （最近 10 章整条，更早的只带第一行）、续写的那一段落盘时按章号合并。区间标题（旧格式）不认。
 * 解析一律不抛（第 1 条）。
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
  '## 第1章：雪夜',
  '林昭出逃，在渡口被沈青拦下。',
  '沈青放他过河，要他欠一个人情。',
  '',
  '### 第2章 入宗',
  '林昭拿半枚令牌入宗。',
  '',
  '## 第3章',
  '',
  '## 后续概览',
  '第二幕只写一行。',
].join('\n');

/** 第 1–n 章，一章一条，第一行「第N章的事。」，第二行「第N章的后果。」 */
function entries(n, from = 1) {
  const out = [];
  for (let no = from; no <= n; no++) {
    out.push(`## 第${no}章：标题${no}`, `第${no}章的事。`, `第${no}章的后果。`, '');
  }
  return out.join('\n');
}

describe('parseOutline', () => {
  test('认出全部章标题，按出现顺序；标题取冒号后面那一段（冒号可有可无）', () => {
    assert.deepEqual(
      O.parseOutline(OUTLINE).map((e) => [e.no, e.title]),
      [
        [1, '雪夜'],
        [2, '入宗'],
        [3, ''],
      ]
    );
  });

  test('一条到下一个同级或更高级标题为止；「## 后续概览」不算进第 3 章', () => {
    const [first, , third] = O.parseOutline(OUTLINE);
    assert.equal(first.text, '林昭出逃，在渡口被沈青拦下。\n沈青放他过河，要他欠一个人情。');
    assert.equal(third.text, '');
  });

  for (const line of ['## 第12章：标题', '## 第 12 章 标题', '### 第12章:标题', '##第12章']) {
    test(`写法：${line}`, () => {
      assert.deepEqual(O.parseOutline(`${line}\n正文`).map((e) => e.no), [12]);
    });
  }

  for (const line of ['## 第1–20章：第一幕', '## 第1章-第4章：区间', '## 第21 至 40 章', '## 第一章：中文数字', '# 第12章：一级标题', '## 第3节']) {
    test(`不认：${line}`, () => {
      assert.deepEqual(O.parseOutline(`${line}\n正文`), []);
    });
  }

  test('区间标题结束上一条，自己那一节被忽略', () => {
    const text = '## 第1章：甲\n甲的事。\n\n## 第2–4章：旧格式\n旧的事。\n\n## 第5章：乙\n乙的事。';
    assert.deepEqual(
      O.parseOutline(text).map((e) => [e.no, e.text]),
      [
        [1, '甲的事。'],
        [5, '乙的事。'],
      ]
    );
    assert.equal(O.outlineRangeHeadings(text), 1);
  });

  test('空串、undefined、只有 BOM 都不抛', () => {
    assert.deepEqual(O.parseOutline(''), []);
    assert.deepEqual(O.parseOutline(undefined), []);
    assert.deepEqual(O.parseOutline('﻿'), []);
  });

  test('CRLF 也认', () => {
    assert.deepEqual(O.parseOutline('## 第1章：甲\r\n甲的事。\r\n').map((e) => [e.no, e.text]), [[1, '甲的事。']]);
  });
});

describe('outlineCoverage / isOutlineFilled / hasOutlineContent', () => {
  test('覆盖到最大的章号', () => {
    assert.equal(O.outlineCoverage(OUTLINE), 3);
    assert.equal(O.outlineCoverage(entries(20)), 20);
  });

  test('旧格式（只有区间标题）：没写过、覆盖 0，但有内容', () => {
    const old = '## 第1–20章：第一幕\n林昭入宗。';
    assert.equal(O.isOutlineFilled(old), false);
    assert.equal(O.outlineCoverage(old), 0);
    assert.equal(O.hasOutlineContent(old), true);
  });

  test('散文式（一个章标题都没有）：没写过、覆盖 0，但有内容', () => {
    assert.equal(O.isOutlineFilled('林昭入宗，后来下山。'), false);
    assert.equal(O.outlineCoverage('林昭入宗，后来下山。'), 0);
    assert.equal(O.hasOutlineContent('林昭入宗，后来下山。'), true);
  });

  test('模板脚手架（> 说明、括号提示、空的 1. 与 -）：没写过，也没有内容', () => {
    const scaffold = '# 情节大纲\n\n> 一章一条。\n\n（写一句话概括全书。）\n\n1.\n-\n';
    assert.equal(O.isOutlineFilled(scaffold), false);
    assert.equal(O.hasOutlineContent(scaffold), false);
    assert.equal(O.outlineCoverage(scaffold), 0);
  });

  test('认得出一章就算写过（只有标题也算）', () => {
    assert.equal(O.isOutlineFilled('## 第3章：甲'), true);
  });
});

describe('outlineEntryFor / outlineOverlaps', () => {
  test('第 N 章那一条；出现两次取先出现的；没有就 undefined', () => {
    const text = '## 第2章：先\n先的事。\n\n## 第2章：后\n后的事。';
    assert.equal(O.outlineEntryFor(text, 2).title, '先');
    assert.equal(O.outlineEntryFor(text, 3), undefined);
  });

  test('区间里有没有条目', () => {
    assert.equal(O.outlineOverlaps(entries(20), { from: 18, to: 25 }), true);
    assert.equal(O.outlineOverlaps(entries(20), { from: 21, to: 40 }), false);
  });
});

describe('outlineBrief', () => {
  test('只取第一行，去掉列表记号；标题跟在章号后面', () => {
    assert.equal(O.outlineBrief({ no: 3, title: '火折', text: '- 沈默逼退沈怀山。\n第二句。' }), '第3章 火折：沈默逼退沈怀山。');
  });

  test('没有正文只剩章号与标题；太长截到 100 字', () => {
    assert.equal(O.outlineBrief({ no: 3, title: '', text: '' }), '第3章');
    const long = O.outlineBrief({ no: 1, title: '', text: '字'.repeat(150) });
    assert.equal(long, `第1章：${'字'.repeat(100)}…`);
  });
});

describe('outlineWindow · 按远近带', () => {
  test('一条都认不出：undefined', () => {
    assert.equal(O.outlineWindow('## 第1–20章：旧\n旧的事。', { range: { from: 21, to: 40 } }), undefined);
  });

  test('续写第 31–40 章：第 21–30 章整条，第 1–20 章只带第一行', () => {
    const w = O.outlineWindow(entries(30), { range: { from: 31, to: 40 }, after: true });
    assert.deepEqual(w.full, Array.from({ length: 10 }, (_, i) => 21 + i));
    assert.deepEqual(w.brief, Array.from({ length: 20 }, (_, i) => 1 + i));
    assert.ok(w.text.includes('- 第1章 标题1：第1章的事。'), w.text);
    assert.ok(!w.text.includes('第1章的后果。'), '更早的不带第二行');
    assert.ok(w.text.includes('## 第21章：标题21\n第21章的事。\n第21章的后果。'), '最近 10 章整条');
    assert.ok(w.text.indexOf('第20章') < w.text.indexOf('## 第21章'), '只带第一行的排在前面');
  });

  test('拆第 41–45 章细纲：本批与前 10 章整条，本批之后的不带', () => {
    const w = O.outlineWindow(entries(60), { range: { from: 41, to: 45 } });
    assert.deepEqual(w.full, Array.from({ length: 15 }, (_, i) => 31 + i));
    assert.equal(w.brief.length, 30);
    assert.ok(!w.text.includes('第46章'), w.text.slice(-200));
  });

  test('重写第 21–40 章（after）：之后已有的只带第一行，接在最后', () => {
    const w = O.outlineWindow(entries(60), { range: { from: 21, to: 40 }, after: true });
    assert.deepEqual(w.full, Array.from({ length: 30 }, (_, i) => 11 + i));
    assert.deepEqual(w.brief, [...Array.from({ length: 10 }, (_, i) => 1 + i), ...Array.from({ length: 20 }, (_, i) => 41 + i)]);
    assert.ok(w.text.includes('后面已经排好的（只列第一行）：\n- 第41章 标题41：第41章的事。'), w.text.slice(-300));
  });

  test('没给区间：最后 10 条整条，更早的只带第一行', () => {
    const w = O.outlineWindow(entries(25));
    assert.deepEqual(w.full, Array.from({ length: 10 }, (_, i) => 16 + i));
    assert.equal(w.brief.length, 15);
  });

  test('同一章出现两次只带先出现的；按章号升序', () => {
    const w = O.outlineWindow('## 第2章：乙\n乙。\n\n## 第1章：甲\n甲。\n\n## 第2章：重复\n重复。');
    assert.equal(w.text, '## 第1章：甲\n甲。\n\n## 第2章：乙\n乙。');
  });

  test('outlineBriefs：整份每章一行', () => {
    assert.equal(O.outlineBriefs(entries(2)), '- 第1章 标题1：第1章的事。\n- 第2章 标题2：第2章的事。');
  });
});

describe('mergeOutline · 按章号合并', () => {
  const EXISTING = ['# 情节大纲', '', '前言。', '', entries(3).trim(), '', '## 附注', '作者自己的附注。'].join('\n');

  test('旧大纲一条都认不出（没写过、旧格式）：直接用新的', () => {
    assert.equal(O.mergeOutline('# 情节大纲\n\n> 说明\n', '## 第1章：甲\n甲。', { from: 1, to: 1 }), '## 第1章：甲\n甲。\n');
    assert.equal(O.mergeOutline('## 第1–20章：旧\n旧的事。', '## 第1章：甲\n甲。', { from: 1, to: 20 }), '## 第1章：甲\n甲。\n');
  });

  test('替换落在区间里的条目；前言、别的条目与附注原样保留；新产出的 # 标题丢掉', () => {
    const next = O.mergeOutline(EXISTING, '# 情节大纲\n\n## 第2章：新二\n新的事。', { from: 2, to: 2 });
    assert.deepEqual(O.parseOutline(next).map((e) => [e.no, e.title]), [
      [1, '标题1'],
      [2, '新二'],
      [3, '标题3'],
    ]);
    assert.ok(next.includes('前言。') && next.includes('作者自己的附注。'));
    assert.equal(next.split('# 情节大纲').length, 2, '开头只有一个标题');
  });

  test('续写：接在最后一条之后、附注之前', () => {
    const next = O.mergeOutline(EXISTING, '## 第4章：四\n四。\n\n## 第5章：五\n五。', { from: 4, to: 5 });
    assert.deepEqual(O.parseOutline(next).map((e) => e.no), [1, 2, 3, 4, 5]);
    assert.ok(next.indexOf('## 第5章') < next.indexOf('## 附注'));
  });

  test('插在前后两条之间', () => {
    const next = O.mergeOutline('## 第1章：甲\n甲。\n\n## 第5章：戊\n戊。', '## 第3章：丙\n丙。', { from: 2, to: 4 });
    assert.deepEqual(O.parseOutline(next).map((e) => e.no), [1, 3, 5]);
  });

  test('新产出写过了界、旧大纲已有的那一章不并进来（不静默换掉）', () => {
    const next = O.mergeOutline(entries(5), '## 第4章：新四\n新。\n\n## 第5章：新五\n新。', { from: 4, to: 4 });
    assert.equal(O.outlineEntryFor(next, 4).title, '新四');
    assert.equal(O.outlineEntryFor(next, 5).title, '标题5');
    assert.equal(O.parseOutline(next).filter((e) => e.no === 5).length, 1);
  });
});

describe('上游指纹', () => {
  test('第 N 章的指纹只看第 N 章那一条：改了别的章不变', () => {
    const before = entries(5);
    const after = before.replace('第4章的事。', '第4章改过的事。');
    assert.equal(O.outlineUpstreamHash(before, 3), O.outlineUpstreamHash(after, 3));
    assert.notEqual(O.outlineUpstreamHash(before, 4), O.outlineUpstreamHash(after, 4));
  });

  test('改了标题也算改了上游', () => {
    assert.notEqual(O.outlineUpstreamHash(entries(3), 2), O.outlineUpstreamHash(entries(3).replace('标题2', '新标题'), 2));
  });

  test('大纲里没有这一条、章号取不到、大纲是空的：空串', () => {
    assert.equal(O.outlineUpstreamHash(entries(3), 9), '');
    assert.equal(O.outlineUpstreamHash(entries(3), undefined), '');
    assert.equal(O.outlineUpstreamHash('', 1), '');
    assert.equal(O.outlineUpstreamHash('## 第1–20章：旧\n旧。', 1), '');
  });

  test('判脏：记过、大纲里还有这一条、对不上才算；没记过或这一条没了都不标', () => {
    const h = O.outlineUpstreamHash(entries(3), 2);
    assert.equal(O.isOutlineUpstreamStale(h, entries(3), 2), false);
    assert.equal(O.isOutlineUpstreamStale(h, entries(3).replace('第2章的事。', '改了。'), 2), true);
    assert.equal(O.isOutlineUpstreamStale('', entries(3), 2), false);
    assert.equal(O.isOutlineUpstreamStale(undefined, entries(3), 2), false);
    assert.equal(O.isOutlineUpstreamStale(h, '## 第1–20章：旧\n旧。', 2), false);
  });
});
