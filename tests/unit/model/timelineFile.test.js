/**
 * 叙事线里的故事时间（2026-10-24，docs/design/plans/2026-10-24-story-timeline.md）：`threads/时间线.md` 一章一行，日期现算。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 汉字数字两种写法都认、读法写得对 | 「大衍三年三月十四」「二〇二六年」「廿一」「初七」 |
 * | 起点几种写法都认，输出照起点的样子写；简单历每月 30 天，公历按真实月份 | 作者定的历法 |
 * | 几种值都认（+N 天 / 个月 / 年、同日、次日、+?、回忆、第 N 天、日期），认不出的行不崩、当「没推」 | 第 1 条 |
 * | 推算：没推、推不出按紧接上一章；锚点之后的章跟着顺延；回忆不推进；第一章的差值不算 | 设计稿「推算」 |
 * | 只填空：没有才写、按章号插；作者的行、依据还在的行不动；`+?`〔推不出〕与依据没了的才换 | 第 28 条：作者写的字机器不动 |
 * | BOM、CRLF、项目符号原样 | 第 3 条 |
 * | 模型的输出：证据逐字校验、找不到改推测，days 为 null 记推不出，离谱的不收 | 设计稿「一、同步时推」 |
 * | 「时间线」是保留名，排线不许用它当线名 | 同「未归属的伏笔」 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/timelineFile.ts');
const th = loadModule('src/core/model/threadFile.ts');

const REL = '.novelforge/threads/时间线.md';

function file(start, lines, calendar = '简单历') {
  return ['---', `calendar: ${calendar}`, `start: ${start}`, 'generatedBy: novel-forge', '---', '', '# 时间线', '', ...lines, ''].join('\n');
}

describe('数字', () => {
  test('汉字读法、逐位写法、农历日子都认', () => {
    assert.equal(t.parseNumber('十四'), 14);
    assert.equal(t.parseNumber('廿一'), 21);
    assert.equal(t.parseNumber('初七'), 7);
    assert.equal(t.parseNumber('三十'), 30);
    assert.equal(t.parseNumber('一百零五'), 105);
    assert.equal(t.parseNumber('二〇二六'), 2026);
    assert.equal(t.parseNumber('两万三千'), 23000);
    assert.equal(t.parseNumber('１２'), 12);
    assert.equal(t.parseNumber('元'), 1);
    assert.equal(t.parseNumber('三天'), undefined);
  });

  test('读法写得对', () => {
    assert.equal(t.cnNumber(1), '一');
    assert.equal(t.cnNumber(10), '十');
    assert.equal(t.cnNumber(14), '十四');
    assert.equal(t.cnNumber(20), '二十');
    assert.equal(t.cnNumber(105), '一百零五');
    assert.equal(t.cnNumber(1010), '一千零一十');
    assert.equal(t.cnNumber(23000), '二万三千');
  });
});

describe('历法', () => {
  const simple = (start) => t.parseTimelineFile(file(start, []), REL);

  test('简单历：年号、汉字年月、农历日子，照起点的写法输出', () => {
    const tl = simple('大衍三年三月初七');
    assert.deepEqual(t.dayLabel(tl, 1), { full: '大衍三年三月初七', short: '初七', month: '大衍三年三月' });
    assert.equal(t.dayLabel(tl, 8).full, '大衍三年三月十四');
    // 每月 30 天：三月初七往后 24 天是四月初一。
    assert.equal(t.dayLabel(tl, 25).full, '大衍三年四月初一');
    // 一年 360 天：跨年，年份往上加。
    assert.equal(t.dayLabel(tl, 361).full, '大衍四年三月初七');
  });

  test('简单历：起点没写年份时跨年写「次年」「第三年」', () => {
    const tl = simple('三月初七');
    assert.equal(t.dayLabel(tl, 1).full, '三月初七');
    assert.equal(t.dayLabel(tl, 361).full, '次年三月初七');
    assert.equal(t.dayLabel(tl, 721).full, '第三年三月初七');
  });

  test('简单历：阿拉伯数字的起点输出阿拉伯数字；正月、腊月照写', () => {
    assert.equal(t.dayLabel(simple('3月7日'), 8).full, '3月14日');
    const trad = simple('腊月廿八');
    // 每月 30 天：廿八、廿九、三十，第 4 天是次年正月初一。
    assert.equal(t.dayLabel(trad, 4).full, '次年正月初一');
  });

  test('公历：真实的月份长短与闰年，照起点的写法', () => {
    const iso = t.parseTimelineFile(file('2024-02-28', [], '公历'), REL);
    assert.equal(iso.calendar, '公历');
    assert.equal(t.dayLabel(iso, 2).full, '2024-02-29');
    assert.equal(t.dayLabel(iso, 3).full, '2024-03-01');
    assert.equal(t.dayLabel(iso, 3).month, '2024-03');
    const cn = t.parseTimelineFile(file('2026年3月7日', [], '公历'), REL);
    assert.equal(t.dayLabel(cn, 26).full, '2026年4月1日');
  });

  test('没填起点、起点认不出：只写第几天', () => {
    assert.deepEqual(t.dayLabel(simple(''), 46), { full: '第 46 天', short: '46' });
    const bad = simple('很久很久以前');
    assert.equal(bad.start, undefined);
    assert.equal(bad.startText, '很久很久以前');
    assert.equal(t.dayLabel(bad, 3).full, '第 3 天');
    // 简单历没有三月三十一。
    assert.equal(simple('三月三十一').start, undefined);
  });
});

describe('解析', () => {
  test('几种值都认，时段、历时、依据各归各的', () => {
    const tl = t.parseTimelineFile(
      file('三月初七', [
        '- 第 1 章：+0 天，傍晚〔依据：「连日大雨的第三天傍晚」〕',
        '- 第 2 章：同日，夜里',
        '- 第 3 章：次日',
        '- 第 4 章：+1 天，清晨，历时 2 天 [依据：「次日清晨，雨停了」]',
        '* 第 5 章：+3 个月',
        '- 第 6 章：+半年',
        '- 第 7 章：回忆，约二十年前〔依据：「那是二十年前的冬天」〕',
        '- 第 8 章：+?〔推不出：正文没交代过了多久〕',
        '- 第 9 章：+0 天，上午〔推测：紧接上一章的审讯〕',
        '- 第 10 章：八月十五，傍晚',
        '- 第 11 章：第 200 天',
        '- 第 12 章：-2 天',
      ]),
      REL
    );
    const by = new Map(tl.entries.map((e) => [e.chapter, e]));
    assert.deepEqual(by.get(1), {
      chapter: 1,
      value: { kind: 'delta', days: 0 },
      part: '傍晚',
      span: 1,
      basis: { kind: '依据', text: '连日大雨的第三天傍晚' },
    });
    assert.deepEqual(by.get(2).value, { kind: 'delta', days: 0 });
    assert.equal(by.get(2).part, '夜里');
    assert.deepEqual(by.get(3).value, { kind: 'delta', days: 1 });
    assert.equal(by.get(4).span, 2);
    assert.equal(by.get(4).basis.text, '次日清晨，雨停了');
    assert.deepEqual(by.get(5).value, { kind: 'delta', days: 90 });
    assert.deepEqual(by.get(6).value, { kind: 'delta', days: 180 });
    assert.deepEqual(by.get(7).value, { kind: 'flashback', ago: '约二十年前' });
    assert.deepEqual(by.get(8).value, { kind: 'unknown' });
    assert.equal(by.get(8).basis.kind, '推不出');
    assert.equal(by.get(9).basis.kind, '推测');
    assert.deepEqual(by.get(10).value, { kind: 'date', text: '八月十五' });
    assert.deepEqual(by.get(11).value, { kind: 'day', day: 200 });
    assert.deepEqual(by.get(12).value, { kind: 'delta', days: -2 });
    assert.deepEqual(tl.bad, []);
  });

  test('认不出的行不崩：值认不出的记一笔，不是「第 N 章」开头的跳过；同一章两行认第一行', () => {
    const tl = t.parseTimelineFile(
      file('', ['> 说明文字', '- 第 1 章：+0 天', '- 第 2 章：过了好一阵子', '- 随手记一句', '- 第 1 章：+5 天', '## 别的小节']),
      REL
    );
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1]);
    assert.deepEqual(tl.entries[0].value, { kind: 'delta', days: 0 });
    assert.deepEqual(tl.bad, [2]);
  });

  test('没有文件：exists 为 false、简单历、没有起点', () => {
    const tl = t.parseTimelineFile('', REL);
    assert.equal(tl.exists, false);
    assert.equal(tl.calendar, '简单历');
    assert.deepEqual(tl.entries, []);
  });

  test('「时间线」是保留名：排线排出来叫这个名字的线不收', () => {
    assert.equal(th.isReservedThreadName('时间线'), true);
    assert.equal(th.isReservedThreadName('未归属的伏笔'), true);
    assert.equal(th.isReservedThreadName('林昭与沈青'), false);
    const v = th.verifyThreadPlans([{ title: '时间线', kind: '支线', intent: '…' }], { threads: [], foreshadowing: [] });
    assert.equal(v.plans.length, 0);
    assert.match(v.dropped[0].why, /保留名/);
  });
});

describe('推算', () => {
  const calc = (lines, start = '三月初七', upTo) => {
    const tl = t.parseTimelineFile(file(start, lines), REL);
    return { tl, r: t.computeTimeline(tl, upTo) };
  };

  test('相对量累加；没推、推不出按紧接上一章；历时推后结尾', () => {
    const { r } = calc([
      '- 第 1 章：+3 天〔依据：「第三天」〕',
      '- 第 2 章：+1 天，历时 3 天〔依据：「次日」〕',
      '- 第 4 章：+?〔推不出：没交代〕',
      '- 第 5 章：+2 天〔推测：赶路〕',
    ]);
    // 第一章的差值不算：开头就是第 1 天。
    assert.deepEqual(
      r.days.map((d) => [d.chapter, d.state, d.start, d.end]),
      [
        [1, 'evidence', 1, 1],
        [2, 'evidence', 2, 4],
        [3, 'missing', 4, 4],
        [4, 'unknown', 4, 4],
        [5, 'guess', 6, 6],
      ]
    );
    assert.equal(r.days[1].delta, 1);
    assert.equal(r.elapsed, 6);
    assert.equal(r.last, 5);
  });

  test('锚点：作者定的那一天，后面机器推的跟着顺延；没写年份取上一章结尾当天或之后最近的那一个', () => {
    const lines = ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+1 天〔依据：「次」〕', '- 第 3 章：八月十五', '- 第 4 章：+2 天〔依据：「两日后」〕'];
    const { tl, r } = calc(lines);
    // 三月初七是第 1 天；八月十五 = 第 1 + (5 个月 × 30 + 8) = 第 159 天。
    assert.equal(r.days[2].state, 'anchor');
    assert.equal(r.days[2].start, 159);
    assert.equal(r.days[3].start, 161);
    assert.equal(t.dayLabel(tl, r.days[3].start).full, '八月十七');
    // 锚点在上一章之前（三月初一）：取下一年的那一天。
    const back = calc(['- 第 1 章：+0 天', '- 第 2 章：+10 天', '- 第 3 章：三月初一']).r;
    assert.equal(back.days[2].start, 355);
    assert.equal(t.dayLabel(calc([], '三月初七').tl, 355).full, '次年三月初一');
  });

  test('第 N 天的锚点不要起点；日期锚点没有起点算不出，当认不出', () => {
    const { r } = calc(['- 第 1 章：+0 天', '- 第 2 章：第 30 天', '- 第 3 章：八月十五', '- 第 4 章：+1 天'], '');
    assert.equal(r.days[1].start, 30);
    assert.equal(r.days[2].state, 'bad');
    assert.equal(r.days[2].start, 30);
    assert.equal(r.days[3].start, 31);
  });

  test('回忆不推进时间；第一个不是回忆的章当第 1 天', () => {
    const { r } = calc(['- 第 1 章：回忆，约二十年前', '- 第 2 章：+5 天', '- 第 3 章：回忆', '- 第 4 章：+1 天']);
    assert.equal(r.days[0].state, 'flashback');
    assert.equal(r.days[0].start, undefined);
    assert.equal(r.days[0].ago, '约二十年前');
    assert.equal(r.days[1].start, 1);
    assert.equal(r.days[3].start, 2);
  });

  test('upTo：写第 N 章时只看第 N 章之前的行', () => {
    const lines = ['- 第 1 章：+0 天', '- 第 2 章：+1 天', '- 第 3 章：+1 天'];
    const { tl, r } = calc(lines, '三月初七', 2);
    assert.equal(r.days.length, 2);
    assert.equal(r.elapsed, 2);
    const last = t.lastKnownBefore(tl, 3);
    assert.equal(last.day.chapter, 2);
    assert.equal(last.gap, 0);
    assert.equal(t.describeDaySpan(tl, last.day), '三月初八（故事第 2 天）');
    assert.equal(t.lastKnownBefore(tl, 1), undefined);
  });

  test('作者手写的相对量（没有那一段、或者改了值还挂着〔推不出〕）算作者定的', () => {
    const { r } = calc(['- 第 1 章：+0 天', '- 第 2 章：+3 个月', '- 第 3 章：+4 天〔推不出：没交代〕']);
    assert.equal(r.days[1].state, 'anchor');
    assert.equal(r.days[2].state, 'anchor');
    assert.equal(r.days[2].start, 1 + 90 + 4);
  });
});

describe('写入：只填空', () => {
  const entry = (chapter, days, basis) => ({ chapter, value: { kind: 'delta', days }, span: 1, ...(basis ? { basis } : {}) });

  test('还没有文件：按模板新建，写下第一行', () => {
    const { text, action } = t.upsertTimelineEntry('', entry(1, 0, { kind: '依据', text: '那天傍晚' }), '那天傍晚，雨停了。');
    assert.equal(action, 'added');
    assert.match(text, /^---\ncalendar: 简单历\nstart: \n/);
    assert.match(text, /\n- 第 1 章：\+0 天〔依据：「那天傍晚」〕\n$/);
    const tl = t.parseTimelineFile(text, REL);
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1]);
  });

  test('按章号插到对的位置，项目符号沿用已有的写法', () => {
    const raw = file('', ['* 第 1 章：+0 天', '* 第 5 章：+1 天']);
    const { text, action } = t.upsertTimelineEntry(raw, entry(3, 2, { kind: '推测', text: '赶路' }), '');
    assert.equal(action, 'added');
    assert.match(text, /\* 第 1 章：\+0 天\n\* 第 3 章：\+2 天〔推测：赶路〕\n\* 第 5 章/);
    const before = t.upsertTimelineEntry(raw, entry(9, 1), '').text;
    assert.match(before, /\* 第 5 章：\+1 天\n\* 第 9 章：\+1 天\n$/);
  });

  test('作者写的、依据还在正文里的、推测的行不动', () => {
    const raw = file('', [
      '- 第 1 章：八月十五',
      '- 第 2 章：+2 天〔依据：「两日后的清晨」〕',
      '- 第 3 章：+0 天〔推测：紧接上一章〕',
      '- 第 4 章：过了好一阵子',
    ]);
    for (const [no, text] of [
      [1, ''],
      [2, '两日后的清晨，他们到了渡口。'],
      [3, ''],
      [4, ''],
    ]) {
      const r = t.upsertTimelineEntry(raw, entry(no, 9), text);
      assert.equal(r.action, 'kept', `第 ${no} 章`);
      assert.equal(r.text, raw);
    }
  });

  test('`+?`〔推不出〕与依据已经不在正文里的行换掉，只换那一行', () => {
    const raw = file('', ['- 第 1 章：+?〔推不出：没交代〕', '- 第 2 章：+2 天〔依据：「两日后的清晨」〕']);
    const a = t.upsertTimelineEntry(raw, entry(1, 0, { kind: '依据', text: '当晚' }), '');
    assert.equal(a.action, 'replaced');
    assert.match(a.text, /- 第 1 章：\+0 天〔依据：「当晚」〕\n- 第 2 章：\+2 天/);
    const b = t.upsertTimelineEntry(raw, entry(2, 5, { kind: '依据', text: '五日后' }), '五日后，他们到了渡口。');
    assert.equal(b.action, 'replaced');
    assert.match(b.text, /- 第 2 章：\+5 天〔依据：「五日后」〕/);
    // 作者把 +? 填成了别的值、却留着〔推不出〕：算作者的，不换。
    const filled = file('', ['- 第 1 章：+3 天〔推不出：没交代〕']);
    assert.equal(t.upsertTimelineEntry(filled, entry(1, 0), '').action, 'kept');
  });

  test('BOM、CRLF 原样', () => {
    const raw = `﻿${file('', ['- 第 1 章：+0 天']).replace(/\n/g, '\r\n')}`;
    const { text } = t.upsertTimelineEntry(raw, entry(2, 1), '');
    assert.ok(text.startsWith('﻿---\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
    assert.match(text, /- 第 1 章：\+0 天\r\n- 第 2 章：\+1 天\r\n/);
  });

  test('写回的一行再读得出同样的东西', () => {
    const e = { chapter: 4, value: { kind: 'flashback', ago: '约二十年前' }, span: 1, basis: { kind: '依据', text: '那年冬天' } };
    assert.equal(t.renderTimelineLine(e), '第 4 章：回忆，约二十年前〔依据：「那年冬天」〕');
    assert.deepEqual(t.parseTimelineLine(t.renderTimelineLine(e)).entry, e);
    const d = { chapter: 2, value: { kind: 'delta', days: -3 }, part: '清晨', span: 2, basis: { kind: '推测', text: '倒回去写' } };
    assert.deepEqual(t.parseTimelineLine(t.renderTimelineLine(d)).entry, d);
  });
});

describe('模型的输出', () => {
  const text = '次日清晨，雨停了。林昭推开窗，镇口已经有人在等。';

  test('证据逐字找得到：记依据；时段、跨度照收', () => {
    const v = t.verifyTime({ days: 1, span: 2, part: '清晨', evidence: '次日清晨，雨停了' }, { chapter: 4, text });
    assert.deepEqual(v.entry, {
      chapter: 4,
      value: { kind: 'delta', days: 1 },
      part: '清晨',
      span: 2,
      basis: { kind: '依据', text: '次日清晨，雨停了' },
    });
    assert.deepEqual(v.notes, []);
  });

  test('证据找不到：换成最接近的原句；还找不到改记推测', () => {
    const near = t.verifyTime({ days: 1, evidence: '林昭推开窗户，镇口有人在等' }, { chapter: 4, text });
    assert.equal(near.entry.basis.kind, '依据');
    assert.equal(near.entry.basis.text, '林昭推开窗，镇口已经有人在等。');
    assert.equal(near.notes.length, 1);
    const lost = t.verifyTime({ days: 1, evidence: '三个月之后的一个黄昏' }, { chapter: 4, text });
    assert.deepEqual(lost.entry.basis, { kind: '推测', text: '依据在正文里找不到' });
  });

  test('没给证据：推测（有理由写理由，没有写紧接上一章）', () => {
    assert.deepEqual(t.verifyTime({ days: 0, reason: '接着上一章的打斗' }, { chapter: 4, text }).entry.basis, {
      kind: '推测',
      text: '接着上一章的打斗',
    });
    assert.deepEqual(t.verifyTime({ days: '0' }, { chapter: 4, text }).entry.basis, { kind: '推测', text: '紧接上一章' });
  });

  test('days 为 null、离谱：推不出；整章回忆：不推进；不是对象：不写', () => {
    const unknown = t.verifyTime({ days: null, reason: '没交代' }, { chapter: 4, text });
    assert.deepEqual(unknown.entry.value, { kind: 'unknown' });
    assert.deepEqual(unknown.entry.basis, { kind: '推不出', text: '没交代' });
    const wild = t.verifyTime({ days: 9e9 }, { chapter: 4, text });
    assert.deepEqual(wild.entry.value, { kind: 'unknown' });
    assert.equal(wild.notes.length, 1);
    const back = t.verifyTime({ days: 3, flashback: '约二十年前' }, { chapter: 4, text });
    assert.deepEqual(back.entry.value, { kind: 'flashback', ago: '约二十年前' });
    assert.equal(t.verifyTime(undefined, { chapter: 4, text }), undefined);
    assert.equal(t.verifyTime([1], { chapter: 4, text }), undefined);
  });

  test('完成提示里那一句', () => {
    assert.equal(
      t.describeTimeEntry({ chapter: 4, value: { kind: 'delta', days: 2 }, span: 1, basis: { kind: '依据', text: '两日后' } }),
      '时间：+2 天（依据「两日后」）'
    );
    assert.match(t.describeTimeEntry({ chapter: 4, value: { kind: 'unknown' }, span: 1 }), /推不出/);
  });
});
