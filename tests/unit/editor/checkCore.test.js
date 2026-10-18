/**
 * 写作体检的口径（`media/src/editor/checkCore.ts`，零 DOM）。状态栏、面板、高亮镜像层那一整条链路在
 * tests/dom/standalone/check.test.js，这里钉口径：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 四类 | 敏感词 / 禁用词 / 超出上限的比喻词 / 英文缩写各自认出来、各自的 class |
 * | 叠在一起 | 同一段字落在两类里两类都算、都画；同一个词出现几次就几处 |
 * | 英文大小写 | 敏感词不分大小写（全角当半角），禁用词区分（与生成链的 `countBanned` 一样） |
 * | 比喻词 | 没超上限不算、不画；超了算超出的那几个，每一处都画 |
 * | 与生成链同一口径 | 禁用词每个词的次数等于 `countBanned`、比喻词合计等于 `countSimiles`、缩写去重等于 `latinAcronyms` |
 * | 跳转与替换 | 下一处（选区正好是第 k 处就去 k+1、到底绕回）、全部替换只改第一处到最后一处那一段 |
 * | 跟着改动挪 | 平移规则与 `highlight.ts` 一样；前后文字差（撤销、组字中途用） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('media/src/editor/checkCore.ts');
const mc = loadModule('src/core/model/manuscriptCheck.ts');
const plain = (x) => JSON.parse(JSON.stringify(x));

const VOCAB = {
  banned: ['能量', '神经'],
  sensitive: [{ term: '赌博', replacement: '博戏' }, { term: 'sb' }, { term: '能量' }],
};

describe('写作体检：四类', () => {
  const text = '他赌博输了，能量耗尽。PTSD 又犯了。';
  const r = c.runCheck(text, VOCAB);

  test('敏感词带着替换词', () => {
    const e = r.entries.find((x) => x.category === 'sensitive' && x.term === '赌博');
    assert.deepEqual(plain(e), { category: 'sensitive', term: '赌博', offsets: [1], length: 2, replacement: '博戏' });
  });

  test('禁用词、英文缩写各自认出来', () => {
    assert.deepEqual(
      r.entries.filter((x) => x.category !== 'sensitive').map((x) => [x.category, x.term, x.offsets]),
      [
        ['banned', '能量', [6]],
        ['acronym', 'PTSD', [11]],
      ]
    );
  });

  test('一共几个问题：每一处算一个', () => {
    assert.deepEqual(plain(r.counts), { sensitive: 2, banned: 1, simile: 0, acronym: 1 });
    assert.equal(r.total, 4);
  });

  test('画到图层上的段：每一处一段、各类各自的 class、按起点排', () => {
    assert.deepEqual(plain(c.checkRanges(r)), [
      { start: 1, end: 3, cls: 'ed-hl-chk-sensitive' },
      { start: 6, end: 8, cls: 'ed-hl-chk-banned' },
      { start: 6, end: 8, cls: 'ed-hl-chk-sensitive' },
      { start: 11, end: 15, cls: 'ed-hl-chk-acronym' },
    ]);
  });

  test('面板里的顺序：敏感词 → 禁用词 → 比喻词 → 英文缩写，同一类里次数多的在前', () => {
    const r2 = c.runCheck('能量，神经，神经。sb SB', VOCAB);
    assert.deepEqual(r2.entries.map((e) => `${e.category}:${e.term}`), [
      'sensitive:sb',
      'sensitive:能量',
      'banned:神经',
      'banned:能量',
      'acronym:SB',
    ]);
  });

  test('词表还没到（空的）：比喻词与缩写照查', () => {
    const r3 = c.runCheck('CPU 烧了。', c.EMPTY_VOCAB);
    assert.deepEqual(r3.entries.map((e) => e.term), ['CPU']);
  });
});

describe('写作体检：叠在一起、出现几次', () => {
  test('同一段字落在两类里：两类都算、都画', () => {
    const r = c.runCheck('能量', VOCAB);
    assert.deepEqual(r.entries.map((e) => e.category), ['sensitive', 'banned']);
    assert.equal(r.total, 2);
    assert.equal(c.checkRanges(r).length, 2);
  });

  test('同一个词出现三次就是三处', () => {
    const r = c.runCheck('赌博、赌博，又是赌博', VOCAB);
    assert.deepEqual(r.entries[0].offsets, [0, 3, 8]);
    assert.equal(r.counts.sensitive, 3);
  });

  test('两个词叠在同一段字上（「数据」与「数据库」）各算各的', () => {
    const r = c.runCheck('数据库', { banned: ['数据', '数据库'], sensitive: [] });
    assert.deepEqual(r.entries.map((e) => [e.term, e.offsets]), [
      ['数据', [0]],
      ['数据库', [0]],
    ]);
  });
});

describe('写作体检：英文大小写', () => {
  test('敏感词不分大小写，全角字母当半角；位置与长度是原文的', () => {
    const r = c.runCheck('SB、Sb、ｓｂ、sb', VOCAB);
    const e = r.entries.find((x) => x.term === 'sb');
    assert.deepEqual(e.offsets, [0, 3, 6, 9]);
    assert.equal(e.length, 2);
  });

  test('禁用词区分大小写（与写完一章之后的 countBanned 一样）', () => {
    const r = c.runCheck('Qi 与 qi', { banned: ['qi'], sensitive: [] });
    assert.deepEqual(r.entries.map((e) => e.offsets), [[5]]);
  });
});

describe('写作体检：比喻词只在超过上限时才算', () => {
  test(`没超（${3} 次以内）：不算问题、不画，合计照记`, () => {
    const r = c.runCheck('仿佛、犹如、宛如', c.EMPTY_VOCAB);
    assert.deepEqual(plain(r.similes), { total: 3, limit: 3, over: 0 });
    assert.equal(r.counts.simile, 0);
    assert.deepEqual(c.checkRanges(r), []);
  });

  test('超了：算超出的那几个，每一处都画', () => {
    const r = c.runCheck('仿佛、犹如、宛如、仿佛、如同', c.EMPTY_VOCAB);
    assert.deepEqual(plain(r.similes), { total: 5, limit: 3, over: 2 });
    assert.equal(r.counts.simile, 2);
    assert.equal(r.total, 2);
    assert.equal(c.checkRanges(r).filter((x) => x.cls === 'ed-hl-chk-simile').length, 5);
    assert.deepEqual(r.entries[0].term, '仿佛');
  });

  test('上限与比喻词表就是生成链那一份', () => {
    assert.equal(c.runCheck('', c.EMPTY_VOCAB).similes.limit, mc.SIMILE_LIMIT);
  });
});

describe('写作体检：与生成链同一口径（对拍）', () => {
  const samples = [
    '能量涌动，仿佛潮水；能量退去，犹如梦醒，仿佛未醒，宛如新生，如同隔世。他的神经绷紧，PTSD、CPU、PTSD。',
    '没有问题的一段。',
    '能量能量能量神经\n\n仿佛仿佛仿佛仿佛 ＤＮＡ',
  ];
  for (const text of samples) {
    test(`禁用词次数等于 countBanned、比喻词合计等于 countSimiles、缩写等于 latinAcronyms：${text.slice(0, 8)}…`, () => {
      const terms = mc.bannedTerms({ styleBanList: '- 「能量」\n- 「神经」', genre: '仙侠' });
      const r = c.runCheck(text, { banned: terms, sensitive: [] });
      const mine = r.entries
        .filter((e) => e.category === 'banned')
        .map((e) => ({ term: e.term, count: e.offsets.length }))
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
      const theirs = mc.countBanned(text, terms).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
      assert.deepEqual(plain(mine), plain(theirs));
      assert.equal(r.similes.total, mc.countSimiles(text));
      assert.deepEqual(
        [...new Set(r.entries.filter((e) => e.category === 'acronym').map((e) => e.term))],
        mc.latinAcronyms(text)
      );
    });
  }
});

describe('写作体检：跳转与替换', () => {
  const entry = { offsets: [2, 10, 20], length: 2 };

  test('选区正好是第 k 处：下一下去 k+1；到底了绕回第一处', () => {
    assert.equal(c.nextOccurrence(entry, 2, 4), 1);
    assert.equal(c.nextOccurrence(entry, 20, 22), 0);
  });

  test('别的选区或光标：光标处及之后的第一处；都在前面就绕回', () => {
    assert.equal(c.nextOccurrence(entry, 0, 0), 0);
    assert.equal(c.nextOccurrence(entry, 10, 10), 1);
    assert.equal(c.nextOccurrence(entry, 11, 11), 2);
    assert.equal(c.nextOccurrence(entry, 25, 25), 0);
    assert.equal(c.nextOccurrence({ offsets: [], length: 2 }, 0, 0), -1);
  });

  test('occurrenceAt 只认选区正好盖住某一处', () => {
    assert.equal(c.occurrenceAt(entry, 10, 12), 1);
    assert.equal(c.occurrenceAt(entry, 10, 11), -1);
    assert.equal(c.occurrenceAt(entry, 9, 11), -1);
  });

  test('全部替换：只改第一处到最后一处那一段，各处之间的字原样', () => {
    const text = '前面赌博中间赌博后面';
    const e = c.runCheck(text, VOCAB).entries.find((x) => x.term === '赌博');
    const edit = c.replaceAllEdit(text, e, '博戏');
    assert.deepEqual(plain(edit), { start: 2, end: 8, text: '博戏中间博戏', count: 2 });
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '前面博戏中间博戏后面');
  });

  test('全部替换：大小写不同的几处一起换', () => {
    const text = 'SB, sb';
    const e = c.runCheck(text, { banned: [], sensitive: [{ term: 'sb', replacement: '某人' }] }).entries[0];
    const edit = c.replaceAllEdit(text, e, '某人');
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '某人, 某人');
  });

  test('一处都没有时 undefined', () => {
    assert.equal(c.replaceAllEdit('x', { offsets: [], length: 1 }, 'y'), undefined);
  });
});

describe('写作体检：跟着改动挪', () => {
  const ranges = [
    { start: 0, end: 2, cls: 'a' },
    { start: 5, end: 7, cls: 'b' },
    { start: 10, end: 12, cls: 'c' },
  ];

  test('改动之前的不动、之后的平移、压在改动上的丢掉（与 highlight.ts 同一条规则）', () => {
    assert.deepEqual(plain(c.shiftRanges(ranges, { at: 6, removed: '', inserted: '字' })), [
      { start: 0, end: 2, cls: 'a' },
      { start: 11, end: 13, cls: 'c' },
    ]);
    assert.deepEqual(plain(c.shiftRanges(ranges, { at: 3, removed: 'xx', inserted: '' })), [
      { start: 0, end: 2, cls: 'a' },
      { start: 3, end: 5, cls: 'b' },
      { start: 8, end: 10, cls: 'c' },
    ]);
  });

  test('前后文字差：公共前缀与后缀之外的那一段', () => {
    assert.deepEqual(plain(c.diffChange('他赌博了', '他nihao赌博了')), { at: 1, removed: '', inserted: 'nihao' });
    assert.deepEqual(plain(c.diffChange('aXb', 'aYYb')), { at: 1, removed: 'X', inserted: 'YY' });
    assert.equal(c.diffChange('一样', '一样'), undefined);
    assert.deepEqual(plain(c.diffChange('aaa', 'aa')), { at: 2, removed: 'a', inserted: '' });
  });

  test('sameRanges', () => {
    assert.equal(c.sameRanges(ranges, ranges.map((r) => ({ ...r }))), true);
    assert.equal(c.sameRanges(ranges, ranges.slice(1)), false);
  });

  test('describeCounts：各类几个，比喻词说超出几个', () => {
    const r = c.runCheck('赌博 PTSD 仿佛仿佛仿佛仿佛', VOCAB);
    assert.equal(c.describeCounts(r), '敏感词 1 处 · 比喻词超出 1 个 · 英文缩写 1 处');
  });
});

describe('写作体检：大正文不卡', () => {
  test('十万字、一千个敏感词：一趟查完（< 1.5 秒，宽裕的上限只防退化成「词数 × 全文」）', () => {
    const words = Array.from({ length: 1000 }, (_, i) => ({ term: `词${i}号` }));
    const text = '他走进巷子，雨下得很大。'.repeat(8500) + '词999号';
    const t0 = Date.now();
    const r = c.runCheck(text, { banned: ['能量'], sensitive: words });
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
    assert.deepEqual(r.entries.map((e) => e.term), ['词999号']);
  });
});
