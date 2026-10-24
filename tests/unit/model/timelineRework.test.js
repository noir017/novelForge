/**
 * 故事时间重做（2026-10-24，docs/design/plans/2026-10-24-story-timeline-rework.md）：一行多了结尾时段、〔文中〕〔季节〕；推算时按正文写明的
 * 日子对齐；对账；起点建议；同步、重推时机器写的行照新推的换；认时间的新输出。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 结尾时段、〔文中〕〔季节〕几种写法都认，几段先后不限；写回再读得出同样的东西；老写法照认 | 设计稿「一」；第 1 条 |
 * | 有起点时按〔文中〕对齐、后面顺延；取离推算最近的那一个；`+?` 遇上它记「正文写明」；作者锚点与第 1 章不对齐 | 设计稿「二」，⚑1、⚑2 |
 * | 节日按历法换日子：简单历按农历口径，公历只认公历节日 | ⚑4 |
 * | 对账：偏差 ≥ 2 天、你定的对不上、季节对不上、往回跳、连着推不出 | 设计稿「二 · 对账」 |
 * | 起点建议：没起点时按第一次正文写明的日子倒推 | 设计稿「二」 |
 * | 机器写的行：refresh 换、fill 只填空；作者的行两种都不动 | ⚑7；第 28 条 |
 * | 认时间的新输出：jumps 相加成历时、证据找不到的一跳不算；〔文中〕证据里要写着这一天；〔季节〕证据要在正文里 | 设计稿「三 · 校验」 |
 * | 「前面几章的时间」带结尾时段 | 设计稿「三 · 输入」 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/timelineFile.ts');

const REL = '.novelforge/threads/时间线.md';

function file(start, lines, calendar = '简单历') {
  return ['---', `calendar: ${calendar}`, `start: ${start}`, 'generatedBy: novel-forge', '---', '', '# 时间线', '', ...lines, ''].join('\n');
}
const tlOf = (start, lines, calendar) => t.parseTimelineFile(file(start, lines, calendar), REL);
const entry = (line, cal) => t.parseTimelineLine(line, cal).entry;

describe('一行的新写法', () => {
  test('开头 → 结尾时段；只知道结尾；历时与时段各归各的', () => {
    const e = entry('第 4 章：+1 天，清晨 → 夜里，历时 3 天〔依据：「次日清晨」〕');
    assert.equal(e.part, '清晨');
    assert.equal(e.endPart, '夜里');
    assert.equal(e.span, 3);
    assert.deepEqual(e.basis, { kind: '依据', text: '次日清晨' });
    const only = entry('第 5 章：+0 天，→ 深夜〔推测：紧接上一章〕');
    assert.equal(only.part, undefined);
    assert.equal(only.endPart, '深夜');
    assert.equal(entry('第 6 章：同日，傍晚->三更').endPart, '三更');
  });

  test('〔文中〕：日期、节日、开头后几天、原文；只写节日也认；认不出的当没写', () => {
    const e = entry('第 4 章：+1 天〔依据：「次日」〕〔文中：八月十五（中秋），开头后 2 天「今夜便是中秋」〕');
    assert.deepEqual(e.dateMark, { date: '八月十五', festival: '中秋', offset: 2, quote: '今夜便是中秋' });
    assert.deepEqual(e.basis, { kind: '依据', text: '次日' });
    assert.deepEqual(entry('第 4 章：+?〔文中：除夕「守岁」〕').dateMark, { festival: '除夕', offset: 0, quote: '守岁' });
    assert.deepEqual(entry('第 4 章：+1 天〔文中：三月初七，本章第 3 天〕').dateMark, { date: '三月初七', offset: 2 });
    // 认不出的〔文中〕：当没写，这一行照样认得出。
    const odd = entry('第 4 章：+1 天〔文中：某个好日子〕');
    assert.equal(odd.dateMark, undefined);
    assert.deepEqual(odd.value, { kind: 'delta', days: 1 });
  });

  test('〔季节〕；几段先后不限；括号写成【】也认', () => {
    const e = entry('第 9 章：+30 天〔季节：冬「北风卷着碎雪」〕〔依据：「一月后」〕');
    assert.deepEqual(e.seasonMark, { season: '冬', quote: '北风卷着碎雪' });
    assert.deepEqual(e.basis, { kind: '依据', text: '一月后' });
    assert.deepEqual(entry('第 9 章：+30 天【季节：冬天】').seasonMark, { season: '冬' });
  });

  test('理由里带括号的不当成一段；回忆后面的「多久以前」照旧', () => {
    const e = entry('第 7 章：+0 天〔推测：紧接上一章（打斗没完）〕');
    assert.deepEqual(e.basis, { kind: '推测', text: '紧接上一章（打斗没完）' });
    const back = entry('第 7 章：回忆，约二十年前〔推测：整章是回忆〕');
    assert.deepEqual(back.value, { kind: 'flashback', ago: '约二十年前' });
  });

  test('写回再读得出同样的东西（新的三样都在）', () => {
    const e = {
      chapter: 12,
      value: { kind: 'delta', days: 1 },
      part: '清晨',
      endPart: '夜里',
      span: 3,
      basis: { kind: '依据', text: '次日清晨' },
      dateMark: { date: '八月十五', festival: '中秋', offset: 2, quote: '今夜便是中秋' },
      seasonMark: { season: '秋', quote: '桂花开了' },
    };
    const line = t.renderTimelineLine(e);
    assert.equal(line, '第 12 章：+1 天，清晨 → 夜里，历时 3 天〔依据：「次日清晨」〕〔文中：八月十五（中秋），开头后 2 天「今夜便是中秋」〕〔季节：秋「桂花开了」〕');
    assert.deepEqual(entry(line), e);
    assert.equal(t.renderTimelineLine({ chapter: 3, value: { kind: 'unknown' }, endPart: '深夜', span: 1 }), '第 3 章：+?，→ 深夜');
  });
});

describe('节日与季节', () => {
  test('简单历按农历口径；公历只认公历节日；「节」「夜」去掉再认', () => {
    assert.deepEqual(t.festivalDate('简单历', '中秋节'), { m: 8, d: 15 });
    assert.deepEqual(t.festivalDate('简单历', '除夕夜'), { m: 12, d: 30 });
    assert.deepEqual(t.festivalDate('简单历', '元旦'), { m: 1, d: 1 });
    assert.equal(t.festivalDate('公历', '中秋'), undefined);
    assert.deepEqual(t.festivalDate('公历', '圣诞节'), { m: 12, d: 25 });
    assert.equal(t.festivalDate('简单历', '清明'), undefined);
  });

  test('季节前后各宽一个月；简单历正月到三月是春，公历 3–5 月是春', () => {
    assert.equal(t.monthFitsSeason('简单历', 1, '春'), true);
    assert.equal(t.monthFitsSeason('简单历', 12, '春'), true);
    assert.equal(t.monthFitsSeason('简单历', 5, '春'), false);
    assert.equal(t.monthFitsSeason('简单历', 5, '冬'), false);
    assert.equal(t.monthFitsSeason('公历', 1, '冬'), true);
    assert.equal(t.monthFitsSeason('公历', 7, '冬'), false);
    assert.equal(t.monthFitsSeason('公历', 3, '冬'), true);
    assert.equal(t.parseSeason('冬季'), '冬');
    assert.equal(t.parseSeason('初冬'), undefined);
  });
});

describe('推算：按正文写明的日子对齐', () => {
  test('有起点：按〔文中〕对齐，后面的章跟着顺延；偏差记下来', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依据：「起」〕',
      '- 第 2 章：+3 天〔依据：「三日后」〕',
      // 前面推下来是三月十四（第 14 天），正文写三月十七：按正文对齐，差 3 天。
      '- 第 3 章：+10 天〔依据：「十日后」〕〔文中：三月十七「三月十七这天」〕',
      '- 第 4 章：+1 天〔依据：「次日」〕',
    ]);
    const { days } = t.computeTimeline(tl);
    assert.equal(days[2].state, 'dated');
    assert.equal(days[2].start, 17);
    assert.deepEqual(days[2].aligned, { estimate: 14, drift: 3 });
    assert.equal(days[2].delta, 13);
    assert.equal(days[3].start, 18);
    assert.equal(t.dayLabel(tl, days[3].start).full, '三月十八');
  });

  test('没写年份的取离推算最近的那一个（推多了几天不跳到明年）；开头后几天算进去', () => {
    const tl = tlOf('八月初一', [
      '- 第 1 章：+0 天〔依据：「起」〕',
      // 推下来是八月二十（第 20 天），正文说开头后 1 天是中秋：中秋是第 15 天，这一章开头是第 14 天（往回挪 6 天，不是挪到明年）。
      '- 第 2 章：+19 天，历时 2 天〔依据：「十九日后」〕〔文中：中秋，开头后 1 天「中秋」〕',
    ]);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.start, 14);
    assert.deepEqual(d.aligned, { estimate: 20, drift: -6 });
  });

  test('正文写明的就是推出来的那一天：记「正文写明」，没有偏差', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+2 天〔依据：「两日后」〕〔文中：三月初三「三月初三」〕']);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'dated');
    assert.equal(d.aligned, undefined);
  });

  test('`+?` 遇上〔文中〕：记「正文写明」，偏差标成预料之中', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+?〔推不出：没说〕〔文中：三月二十「三月二十」〕']);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'dated');
    assert.equal(d.start, 20);
    assert.deepEqual(d.aligned, { estimate: 1, drift: 19, unknown: true });
  });

  test('作者的锚点、第 1 章（就是起点）不对齐，对不上只记下来；没有起点不对齐', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依据：「起」〕〔文中：三月初三「三月初三」〕',
      '- 第 2 章：三月初十〔文中：三月十二「三月十二」〕',
    ]);
    const { days } = t.computeTimeline(tl);
    assert.equal(days[0].start, 1);
    assert.deepEqual(days[0].conflict, { day: 3, why: 'start' });
    assert.equal(days[1].state, 'anchor');
    assert.equal(days[1].start, 10);
    assert.deepEqual(days[1].conflict, { day: 12, why: 'anchor' });
    const none = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+2 天〔依据：「两日后」〕〔文中：三月二十「三月二十」〕']);
    const d = t.computeTimeline(none).days[1];
    assert.equal(d.state, 'evidence');
    assert.equal(d.start, 3);
  });

  test('公历里农历节日换不出日子：不对齐', () => {
    const tl = tlOf('2026-09-01', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+3 天〔依据：「三日后」〕〔文中：中秋「中秋」〕'], '公历');
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'evidence');
    assert.equal(d.start, 4);
  });
});

describe('对账', () => {
  const issues = (tl) => t.timelineIssues(tl, t.computeTimeline(tl));

  test('偏差 ≥ 2 天才报（差 1 天不报）；推不出遇上〔文中〕不报', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依据：「起」〕',
      '- 第 2 章：+1 天〔依据：「次日」〕〔文中：三月初三「三月初三」〕',
      '- 第 3 章：+10 天〔依据：「十日后」〕〔文中：三月十七「三月十七」〕',
      '- 第 4 章：+?〔推不出：没说〕〔文中：三月二十五「三月二十五」〕',
    ]);
    const list = issues(tl);
    assert.deepEqual(
      list.map((i) => [i.kind, i.chapter]),
      [['drift', 3]]
    );
    assert.equal(list[0].text, '第 3 章：前面推下来是三月十三，正文写三月十七（差 4 天），已按正文对齐');
  });

  test('你定的、起点和正文对不上', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依据：「起」〕〔文中：三月初三「三月初三」〕', '- 第 2 章：三月初十〔文中：三月十二「三月十二」〕']);
    assert.deepEqual(
      issues(tl).map((i) => i.text),
      ['第 1 章：起点是三月初一，正文写三月初三', '第 2 章：你定的是三月初十，正文写三月十二']
    );
  });

  test('季节对不上（前后宽一个月）；往回跳又没标回忆；连着三章推不出', () => {
    const tl = tlOf('五月初一', [
      '- 第 1 章：+0 天〔依据：「起」〕〔季节：冬「大雪」〕',
      '- 第 2 章：+1 天〔依据：「次日」〕〔季节：夏「蝉鸣」〕',
      '- 第 3 章：-3 天〔依据：「三日前」〕',
      '- 第 4 章：+?〔推不出：没说〕',
      '- 第 5 章：+?〔推不出：没说〕',
      '- 第 6 章：回忆〔推测：整章是回忆〕',
      '- 第 7 章：+?〔推不出：没说〕',
      '- 第 8 章：+1 天〔依据：「次日」〕',
    ]);
    assert.deepEqual(
      issues(tl).map((i) => [i.kind, i.chapter, i.text]),
      [
        ['season', 1, '第 1 章：推出来是五月，正文说是冬天（「大雪」）'],
        ['backward', 3, '第 3 章：比上一章往回跳了 3 天，又没标回忆'],
        // 回忆夹在中间不断开连着推不出的那一段。
        ['unknownRun', 4, '第 4–7 章连着推不出（都按紧接上一章算）'],
      ]
    );
  });

  test('没起点：日期、季节两类不查', () => {
    const tl = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕〔季节：冬「大雪」〕']);
    assert.deepEqual(issues(tl), []);
  });
});

describe('起点建议', () => {
  test('没起点：按第一次正文写明的日子倒推第 1 章是哪天，照那个日期的写法', () => {
    const tl = tlOf('', [
      '- 第 1 章：+0 天〔依据：「起」〕',
      '- 第 2 章：+2 天〔依据：「两日后」〕',
      '- 第 3 章：+0 天，历时 3 天〔依据：「当晚」〕〔文中：三月初七，开头后 1 天「三月初七」〕',
    ]);
    // 第 3 章开头是第 3 天，开头后 1 天（第 4 天）是三月初七 → 第 1 天是三月初四。
    assert.deepEqual(t.suggestStart(tl, t.computeTimeline(tl)), { text: '三月初四', chapter: 3, mark: '三月初七' });
    const festival = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+3 天〔依据：「三日后」〕〔文中：中秋「中秋」〕']);
    assert.equal(t.suggestStart(festival, t.computeTimeline(festival)).text, '八月十二');
    const iso = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕〔文中：2026-03-07「3月7日」〕'], '公历');
    assert.equal(t.suggestStart(iso, t.computeTimeline(iso)).text, '2026-03-07');
  });

  test('有起点、没有〔文中〕：不建议', () => {
    const has = tlOf('三月初一', ['- 第 1 章：+0 天〔文中：三月初三「三月初三」〕']);
    assert.equal(t.suggestStart(has, t.computeTimeline(has)), undefined);
    const none = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕']);
    assert.equal(t.suggestStart(none, t.computeTimeline(none)), undefined);
  });
});

describe('写入：机器写的行', () => {
  const chapter = '第4章正文。次日清晨，雨停了。';
  const fresh = { chapter: 4, value: { kind: 'delta', days: 2 }, span: 1, basis: { kind: '依据', text: '次日清晨，雨停了' } };

  test('认得出谁写的：带〔依据〕〔推测〕的相对量与回忆、带〔推不出〕的 +? 是机器的；其余是作者的', () => {
    const is = (line) => t.isMachineEntry(entry(line));
    assert.equal(is('第 4 章：+1 天〔依据：「次日」〕'), true);
    assert.equal(is('第 4 章：+1 天〔推测：紧接上一章〕'), true);
    assert.equal(is('第 4 章：回忆〔推测：整章是回忆〕'), true);
    assert.equal(is('第 4 章：+?〔推不出：没说〕'), true);
    assert.equal(is('第 4 章：+3 天'), false);
    assert.equal(is('第 4 章：+3 天〔推不出：没说〕'), false);
    assert.equal(is('第 4 章：八月十五〔依据：「中秋」〕'), false);
    assert.equal(is('第 4 章：第 20 天'), false);
    assert.equal(is('第 4 章：回忆'), false);
  });

  test('refresh：机器写的行照新推的换（依据还在也换）；作者的行、认不出的行不动；一样的不算换', () => {
    const raw = file('', ['- 第 3 章：+1 天', '- 第 4 章：+1 天〔依据：「次日清晨，雨停了」〕', '- 第 5 章：怎么也认不出']);
    const out = t.upsertTimelineEntry(raw, fresh, chapter, 'refresh');
    assert.equal(out.action, 'replaced');
    assert.ok(out.text.includes('- 第 4 章：+2 天〔依据：「次日清晨，雨停了」〕'), out.text);
    assert.ok(out.text.includes('- 第 3 章：+1 天\n'));
    assert.equal(t.upsertTimelineEntry(out.text, fresh, chapter, 'refresh').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, { ...fresh, chapter: 3 }, chapter, 'refresh').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, { ...fresh, chapter: 5 }, chapter, 'refresh').action, 'kept');
  });

  test('fill：依据还在的机器行不动（只填空，同上一稿）', () => {
    const raw = file('', ['- 第 4 章：+1 天〔依据：「次日清晨，雨停了」〕']);
    assert.equal(t.upsertTimelineEntry(raw, fresh, chapter, 'fill').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, fresh, chapter).action, 'kept');
  });
});

describe('认时间的新输出', () => {
  const text = '次日清晨，雨停了。\n\n两日后的夜里，林昭出了城。\n\n满院桂花开了，今夜便是中秋。';
  const ctx = { chapter: 12, text };

  test('jumps 相加成历时；证据找不到的一跳不算、记一笔；结尾时段照收', () => {
    const v = t.verifyTime(
      {
        days: 1,
        part: '清晨',
        evidence: '次日清晨，雨停了。',
        jumps: [{ days: 2, evidence: '两日后的夜里' }, { days: 5, evidence: '五日后' }, { days: -1, evidence: '两日后的夜里' }],
        endPart: '夜里',
      },
      ctx
    );
    assert.equal(v.entry.span, 3);
    assert.equal(v.entry.endPart, '夜里');
    assert.equal(v.entry.part, '清晨');
    assert.equal(v.notes.length, 2);
    assert.ok(v.notes.some((n) => n.includes('五日后')));
  });

  test('没给 jumps 认老的 span', () => {
    assert.equal(t.verifyTime({ days: 1, span: 4, evidence: '次日清晨' }, ctx).entry.span, 4);
  });

  test('〔文中〕：证据在正文里、里面写着这个节日或日期才收；offset 夹在历时之内', () => {
    const ok = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', festival: '中秋', offset: 9, evidence: '今夜便是中秋' } }, ctx);
    assert.deepEqual(ok.entry.dateMark, { date: '八月十五', festival: '中秋', offset: 0, quote: '今夜便是中秋' });
    // 证据里没写这一天（编的）：不收。
    const made = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', evidence: '两日后的夜里' } }, ctx);
    assert.equal(made.entry.dateMark, undefined);
    assert.ok(made.notes.some((n) => n.includes('没写着')));
    // 证据不在正文里：不收。
    assert.equal(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '中秋月圆，宾客满堂' } }, ctx).entry.dateMark, undefined);
    // 只给节日：简单历里收；公历里换不出日子，不收。
    assert.deepEqual(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '今夜便是中秋' } }, ctx).entry.dateMark, { festival: '中秋', offset: 0, quote: '今夜便是中秋' });
    assert.equal(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '今夜便是中秋' } }, { ...ctx, calendar: '公历' }).entry.dateMark, undefined);
  });

  test('〔季节〕：春夏秋冬之一、证据在正文里才收；回忆不收〔文中〕', () => {
    assert.deepEqual(t.verifyTime({ days: 0, season: { season: '秋天', evidence: '满院桂花开了' } }, ctx).entry.seasonMark, { season: '秋', quote: '满院桂花开了' });
    assert.equal(t.verifyTime({ days: 0, season: { season: '秋', evidence: '落叶满地' } }, ctx).entry.seasonMark, undefined);
    const back = t.verifyTime({ flashback: '约二十年前', date: { festival: '中秋', evidence: '今夜便是中秋' } }, ctx);
    assert.equal(back.entry.dateMark, undefined);
    // 机器写的回忆一定带行尾那一段：好认出是机器写的。
    assert.deepEqual(back.entry.basis, { kind: '推测', text: '整章是回忆' });
    assert.equal(t.isMachineEntry(back.entry), true);
  });

  test('完成提示说正文写明的日子', () => {
    const v = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', festival: '中秋', evidence: '今夜便是中秋' } }, ctx);
    assert.equal(t.describeTimeEntry(v.entry), '时间：+1 天（依据「次日清晨」）；正文写明八月十五（中秋），按它对齐');
  });
});

describe('前面几章的时间', () => {
  test('最近几章一章一行：带结尾时段、比上一章晚多少；没记、推不出、回忆各说一句', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天，清晨 → 夜里〔依据：「起」〕',
      '- 第 3 章：+?〔推不出：没说〕',
      '- 第 4 章：回忆〔推测：整章是回忆〕',
      '- 第 5 章：+2 天，傍晚，历时 2 天〔依据：「两日后」〕',
    ]);
    assert.equal(
      t.recentTimeNote(tl, 6),
      [
        '第 1 章：三月初一 清晨 → 夜里（故事第 1 天）',
        '第 2 章：还没记（按紧接上一章算）',
        '第 3 章：三月初一（故事第 1 天，比上一章 同一天，推不出、按紧接上一章算）',
        '第 4 章：整章是回忆，不推进时间',
        '第 5 章：三月初三 傍晚 → 三月初四（故事第 3–4 天，比上一章 +2 天）',
      ].join('\n')
    );
    assert.equal(t.recentTimeNote(tl, 1), '这是第 1 章：days 写 0。');
    assert.ok(t.recentTimeNote(tlOf('', []), 4).startsWith('前面的章还没记时间'));
  });
});

// 真实模型试跑之后补的（2026-10-24，设计稿「实施状态」）。
describe('试跑之后：依据要写着时间、只写日的日子、同一个时段不写两遍', () => {
  test('依据那一句没写时间（本章第一句充数）：改记推测；章内一跳的依据没写时间：这一跳不算', () => {
    assert.equal(t.mentionsTime('夜色在浓重的雾气里被一点点击碎'), true);
    assert.equal(t.mentionsTime('至二十一日，就賈母內院中搭了家常小巧戲台'), true);
    assert.equal(t.mentionsTime('次日便先送過衣服玩物禮去'), true);
    assert.equal(t.mentionsTime('过了三天，他才回来'), true);
    assert.equal(t.mentionsTime('浓雾压在青羊镇的残垣断壁上，散发着一股化不开的焦臭。'), false);
    assert.equal(t.mentionsTime('山道尽头，浓雾如被泼了陈年墨汁，粘稠得化不开。'), false);
    const text = '浓雾压在青羊镇的残垣断壁上。\n\n他喘了口气，又往前走。';
    const v = t.verifyTime({ days: 0, evidence: '浓雾压在青羊镇的残垣断壁上', jumps: [{ days: 2, evidence: '他喘了口气，又往前走' }] }, { chapter: 2, text });
    assert.deepEqual(v.entry.basis, { kind: '推测', text: '依据那一句没写时间' });
    assert.equal(v.entry.span, 1);
  });

  test('开头、结尾同一个时段（同一天里）：只写开头', () => {
    const text = '夜里，林昭出了城。';
    assert.equal(t.verifyTime({ days: 0, part: '夜里', endPart: '夜里', evidence: '夜里，林昭出了城' }, { chapter: 2, text }).entry.endPart, undefined);
    assert.equal(t.verifyTime({ days: 0, part: '夜里', endPart: '清晨', evidence: '夜里，林昭出了城' }, { chapter: 2, text }).entry.endPart, '清晨');
  });

  test('只写了日的〔文中〕：认、写回；不对齐、只对账（月份可能差出去）；证据里要写着这一天，原文写着月日的照原文；不拿来建议起点', () => {
    assert.deepEqual(entry('第 3 章：+1 天〔文中：二十一日「至二十一日」〕').dateMark, { date: '二十一日', offset: 0, quote: '至二十一日' });
    assert.deepEqual(t.parseMarkDate('二十一日'), { m: 0, d: 21, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } });
    // 推下来是正月十八（第 18 天），正文写「二十一日」：不对齐，对账说一句（离推算最近的是正月二十一，第 21 天）。
    const tl = tlOf('正月初一', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+17 天〔依据：「十七日后」〕〔文中：二十一日「至二十一日」〕']);
    const calc = t.computeTimeline(tl);
    const d = calc.days[1];
    assert.equal(d.start, 18);
    assert.equal(d.state, 'evidence');
    assert.deepEqual(d.conflict, { day: 21, why: 'dayOnly' });
    assert.deepEqual(t.timelineIssues(tl, calc).map((i) => i.text), ['第 2 章：推出来是正月十八，正文写二十一日（只写了日，没按它对齐）']);
    const text = '次日便先送過衣服玩物禮去。至二十一日，就賈母內院中搭了家常小巧戲台。';
    const v = t.verifyTime({ days: 0, evidence: '次日便先送過衣服玩物禮去', date: { date: '二十一日', evidence: '至二十一日，就賈母內院中搭了家常小巧戲台' } }, { chapter: 1, text });
    assert.equal(v.entry.dateMark.date, '二十一日');
    assert.equal(t.verifyTime({ days: 0, date: { date: '二十二日', evidence: '至二十一日，就賈母內院中搭了家常小巧戲台' } }, { chapter: 1, text }).entry.dateMark, undefined);
    // 原文写着「四月二十六日」，模型只报了「二十六日」：照原文收。
    const full = t.verifyTime({ days: 1, date: { date: '二十六日', evidence: '至次日乃是四月二十六日' } }, { chapter: 6, text: '至次日乃是四月二十六日，原來這日未時交芒种節。' });
    assert.equal(full.entry.dateMark.date, '四月二十六日');
    const none = tlOf('', ['- 第 1 章：+0 天〔依据：「起」〕〔文中：二十一日「至二十一日」〕']);
    assert.equal(t.suggestStart(none, t.computeTimeline(none)), undefined);
  });
});

describe('试跑之后：依据抄的是细纲', () => {
  test('送去的「细纲记的时间地点」被当成依据抄回来：记推测，说清是照细纲', () => {
    const v = t.verifyTime({ days: 0, evidence: '夜色初降，青羊镇废墟' }, { chapter: 1, text: '浓雾压在镇上。', hint: '夜色初降，青羊镇废墟，沈家老宅断壁后。' });
    assert.deepEqual(v.entry.basis, { kind: '推测', text: '照细纲：夜色初降，青羊镇废墟，沈家老宅断壁后。' });
  });
});

describe('试跑之后：写法与繁体', () => {
  test('「初三日」按农历的样子写（不写成「一日」）；繁体的时间线索也认；往回对齐不把「过了几天」拉成负数', () => {
    const tl = tlOf('五月初三日', ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+28 天〔依据：「二十八日后」〕']);
    assert.equal(t.dayLabel(tl, 29).full, '六月初一');
    assert.equal(t.mentionsTime('我怎么就忘了你兩三個月'), true);
    assert.equal(t.mentionsTime('至次日天明，方才起來'), true);
    const back = tlOf('三月初一', ['- 第 1 章：+0 天，历时 5 天〔依据：「起」〕', '- 第 2 章：+0 天〔依据：「当天」〕〔文中：二月二十五「二月二十五」〕']);
    const calc = t.computeTimeline(back);
    assert.equal(calc.days[1].start, -5);
    assert.equal(calc.elapsed, 5);
  });
});

describe('作者在界面上改（「改时间…」「改历法与起点」）', () => {
  const raw = file('三月初七', [
    '- 第 1 章：+0 天，傍晚 → 深夜〔依据：「起」〕',
    '- 第 2 章：+1 天，历时 2 天〔依据：「次日」〕〔文中：三月初九「三月初九」〕',
    '- 第 4 章：怎么也认不出',
  ]);

  test('认得的写法、清空都放行；认不出的、没起点写日期的说清', () => {
    const tl = t.parseTimelineFile(raw, REL);
    assert.equal(t.checkTimeInput('八月十五，傍晚', tl), undefined);
    assert.equal(t.checkTimeInput('第 20 天', tl), undefined);
    assert.equal(t.checkTimeInput('+3 天', tl), undefined);
    assert.equal(t.checkTimeInput('', tl), undefined);
    assert.match(t.checkTimeInput('过了好一阵', tl), /^认不出「过了好一阵」/);
    assert.match(t.checkTimeInput('八月十五', { calendar: '简单历' }), /^还没填起点/);
  });

  test('改一行：值换成作者写的、行尾的依据去掉（就是作者定的），时段、历时、〔文中〕照留；作者写了时段的照作者的', () => {
    const out = t.setTimelineValue(raw, 2, '+3 天');
    assert.equal(out.action, 'replaced');
    assert.ok(out.text.includes('- 第 2 章：+3 天，历时 2 天〔文中：三月初九「三月初九」〕\n'), out.text);
    const e = t.parseTimelineFile(out.text, REL).entries.find((x) => x.chapter === 2);
    assert.equal(t.isMachineEntry(e), false);
    const withPart = t.setTimelineValue(raw, 1, '八月十五，清晨');
    assert.ok(withPart.text.includes('- 第 1 章：八月十五，清晨 → 深夜\n'), withPart.text);
    // 别的行一个字不动。
    assert.ok(withPart.text.includes('- 第 4 章：怎么也认不出'));
    assert.ok(withPart.text.startsWith('---\ncalendar: 简单历\nstart: 三月初七\n'));
  });

  test('认不出的那一行也能改；没有这一行按章号插进去；清空就是删掉；认不出的字不写', () => {
    assert.ok(t.setTimelineValue(raw, 4, '同日').text.includes('- 第 4 章：+0 天\n'));
    const added = t.setTimelineValue(raw, 3, '第 9 天');
    assert.equal(added.action, 'added');
    assert.match(added.text, /- 第 2 章：[^\n]*\n- 第 3 章：第 9 天\n- 第 4 章/);
    const removed = t.setTimelineValue(raw, 1, '');
    assert.equal(removed.action, 'removed');
    assert.ok(!removed.text.includes('第 1 章'));
    assert.equal(t.setTimelineValue(raw, 9, '').action, 'kept');
    assert.equal(t.setTimelineValue(raw, 2, '过了好一阵'), undefined);
    // 还没有这份文件：按模板新建。
    assert.ok(t.setTimelineValue('', 1, '三月初七').text.includes('# 时间线'));
  });

  test('改历法与起点：只换那两个键；没有就加；还没有文件按模板新建', () => {
    const out = t.setTimelineHead(raw, { calendar: '公历', start: '2026-03-07' });
    assert.ok(out.startsWith('---\ncalendar: 公历\nstart: 2026-03-07\ngeneratedBy: novel-forge\n---\n'), out);
    assert.ok(out.includes('- 第 4 章：怎么也认不出'));
    const bare = t.setTimelineHead('---\ngeneratedBy: x\n---\n\n# 时间线\n', { start: '三月初五' });
    assert.ok(bare.startsWith('---\ngeneratedBy: x\nstart: 三月初五\n---\n'), bare);
    assert.match(t.setTimelineHead('', { start: '三月初五' }), /^---\ncalendar: 简单历\nstart: 三月初五\n/);
    assert.equal(t.parseTimelineFile(t.setTimelineHead(raw, { start: '' }), REL).startText, '');
  });
});
