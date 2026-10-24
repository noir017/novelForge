/**
 * 编辑区「时间线总览」的数据（`views/timeline.ts` 的 `buildTimelineMatrix`，2026-10-24，设计稿 docs/design/plans/2026-10-24-timeline-page.md）：
 * 竖着按故事日子排，一个日子一项、一章一张卡片。纯函数，输入是 `readThreads()` 读出来的整本（带时间线）与有细纲或正文的那几章。
 * 读盘那一半在 tests/integration/views/timelineOverview.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 一个日子一项，按故事日子从早到晚；同一天的几章按章号；往回跳的章排到它那一天（⚑1） | 时间线看的是故事里的先后，不是章号 |
 * | 轴上写不带年份的日子、小字第几天；月份与季节（填了起点才有）；没起点只写第几天 | 竖轴 + 月份分隔 |
 * | 卡片：时段（跨天的写到哪天、几天）、比上一章、依据；这一章在各条线上的实际事件（计划的不给），没有事件给梗概 | 作者定的第 2 条 |
 * | 线的颜色按种类与目录里的先后 8 色循环，「未归属的伏笔」灰（-1）；筛选下拉只列有实际事件的线 | ⚑4 |
 * | 回忆的章挂在阅读顺序上前一章那一天里；前面没有章的挂在第一天 | ⚑5 |
 * | 对账报了的章：卡片上一条一行（去掉「第 N 章：」），`problem`；推不出、认不出也算 problem | 「只看有问题的」 |
 * | 标题栏：历法、起点、推到哪；补推、重推、改起点要的数与工程页那一组同一份 | 文案只有一份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf, tl } = loadBundle({
  views: './src/core/views/timeline.ts',
  tf: './src/core/model/threadFile.ts',
  tl: './src/core/model/timelineFile.ts',
});

const DIR = '.novelforge/threads';
const REL = `${DIR}/时间线.md`;

const timeline = (lines, start = '三月初七') =>
  tl.parseTimelineFile(['---', 'calendar: 简单历', `start: ${start}`, '---', '', '# 时间线', '', ...lines, ''].join('\n'), REL);

function line(name, kind, events, index = 0) {
  const raw = ['---', `kind: ${kind}`, '---', '', `# ${name}`, '', '## 意图', '', '', '## 伏笔', '', '', '## 进展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseThreadFile(raw, `${DIR}/${name}.md`, index);
}

function unfiled(events = []) {
  const raw = ['# 未归属的伏笔', '', '## 伏笔', '', '', '## 进展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseUnfiledFile(raw, `${DIR}/未归属的伏笔.md`);
}

const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔证据：「原文${no}」〕`;
const plan = (no, type, what) => `第 ${no} 章 · 计划 · ${type}：${what}`;

/** 有细纲或正文的章：都同步过；第 3 章细纲写了梗概与时间地点。 */
function chapters(n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const no = i + 1;
    return {
      no,
      title: `章${no}`,
      chapterPath: `chapters/00${no}.txt`,
      plotPath: `.novelforge/summaries/00${no}.md`,
      synopsis: no === 3 ? '林昭夜探青崖镇，撞见黑衣人。' : '',
      timePlace: no === 3 ? '次日夜里，青崖镇' : '',
      finalized: true,
    };
  });
}

function book(lines, threads, unfiledEvents = []) {
  return { threads, unfiled: unfiled(unfiledEvents), timeline: timeline(lines) };
}

describe('时间线总览 · 轴', () => {
  const LINES = [
    '- 第 1 章：+0 天，傍晚 → 深夜〔依据：「连日大雨的第三天傍晚」〕',
    '- 第 2 章：+0 天，深夜〔依据：「当夜」〕',
    '- 第 3 章：+5 天，清晨 → 夜里，历时 3 天〔依据：「五日后的清晨」〕',
    '- 第 4 章：回忆，约二十年前〔依据：「二十年前」〕',
    '- 第 5 章：+1 天〔推测：赶路〕',
  ];

  test('一个日子一项：同一天的几章叠在一起；日子不带年份、小字第几天；月份与季节', () => {
    const m = views.buildTimelineMatrix(book(LINES, []), chapters(5));
    assert.deepEqual(
      m.days.map((d) => [d.day, d.label, d.sub, d.full, d.month, d.season, d.cards.map((c) => c.no)]),
      [
        [1, '三月初七', '第 1 天', '三月初七', '三月', '春', [1, 2]],
        // 第 4 章是回忆：挂在阅读顺序上前一章（第 3 章）那一天里，跟在它后面。
        [6, '三月十二', '第 6 天', '三月十二', '三月', '春', [3, 4]],
        // 第 3 章历时 3 天，到第 8 天；第 5 章 +1 天是第 9 天。
        [9, '三月十五', '第 9 天', '三月十五', '三月', '春', [5]],
      ]
    );
  });

  test('卡片：时段（跨天的写到哪天、几天）、比上一章、依据；回忆写多久以前、标 flashback', () => {
    const m = views.buildTimelineMatrix(book(LINES, []), chapters(5));
    const cards = new Map(m.days.flatMap((d) => d.cards).map((c) => [c.no, c]));
    assert.deepEqual([cards.get(1).when, cards.get(1).delta, cards.get(1).note, cards.get(1).state], ['傍晚 → 深夜', undefined, '依据「连日大雨的第三天傍晚」', 'evidence']);
    assert.deepEqual([cards.get(2).when, cards.get(2).delta], ['深夜', '同一天']);
    assert.deepEqual([cards.get(3).when, cards.get(3).delta], ['清晨 → 三月十四 夜里 · 3 天', '+5 天']);
    assert.deepEqual([cards.get(4).when, cards.get(4).flashback, cards.get(4).delta], ['回忆（约二十年前）', true, undefined]);
    assert.deepEqual([cards.get(5).when, cards.get(5).note, cards.get(5).state], ['', '推测：赶路', 'guess']);
    // 详情：全称、第几天、历时、依据；细纲的时间地点。
    assert.ok(cards.get(3).detail.includes('故事第 6 天，历时 3 天，到三月十四；比上一章：+5 天'), cards.get(3).detail.join('\n'));
    assert.ok(cards.get(3).detail.includes('细纲写的时间地点：次日夜里，青崖镇'), cards.get(3).detail.join('\n'));
    assert.equal(cards.get(1).chapterPath, 'chapters/001.txt');
    assert.equal(cards.get(1).plotPath, '.novelforge/summaries/001.md');
    assert.equal(cards.get(1).machine, true);
  });

  test('往回跳的章排到它那一天（⚑1），对账照旧报它：卡片上去掉「第 N 章：」，标 problem', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+4 天〔依据：「四日后」〕', '- 第 3 章：-3 天〔依据：「三日前」〕'], []), chapters(3));
    assert.deepEqual(m.days.map((d) => [d.day, d.cards.map((c) => c.no)]), [[1, [1]], [2, [3]], [5, [2]]]);
    const back = m.days[1].cards[0];
    assert.deepEqual(back.issues, ['比上一章往回跳了 3 天，又没标回忆']);
    assert.equal(back.problem, true);
    assert.equal(m.days[0].cards[0].problem, false);
  });

  test('没起点：轴上只写第几天，没有小字、月份与季节', () => {
    const bare = { threads: [], unfiled: unfiled(), timeline: timeline(LINES, '') };
    const m = views.buildTimelineMatrix(bare, chapters(5));
    assert.deepEqual(m.days.map((d) => [d.label, d.sub, d.month, d.season]), [
      ['第 1 天', undefined, undefined, undefined],
      ['第 6 天', undefined, undefined, undefined],
      ['第 9 天', undefined, undefined, undefined],
    ]);
    assert.equal(m.meta, '简单历 · 没填起点 · 推到第 5 章 · 故事第 9 天');
  });

  test('第 1 章就是回忆：挂在第一天，排在最前面；推不出、认不出的照推算的位置放、标 problem', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：回忆', '- 第 2 章：+0 天〔依据：「起」〕', '- 第 3 章：+?〔推不出：没交代〕', '- 第 4 章：过了好一阵'], []), chapters(4));
    assert.deepEqual(m.days.map((d) => [d.day, d.cards.map((c) => [c.no, c.state, c.problem])]), [
      [1, [[1, 'flashback', false], [2, 'evidence', false], [3, 'unknown', true], [4, 'bad', true]]],
    ]);
    assert.equal(m.days[0].cards[3].when, '那一行认不出');
  });

  test('整本只有回忆：给一个第 0 天，写「回忆」', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：回忆'], []), chapters(1));
    assert.deepEqual(m.days.map((d) => [d.day, d.label, d.cards.map((c) => c.no)]), [[0, '回忆', [1]]]);
  });
});

describe('时间线总览 · 卡片上的事件', () => {
  const LINES = ['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+1 天〔依据：「次日」〕', '- 第 3 章：+1 天〔依据：「又一日」〕'];
  const threads = () => [
    line('林昭与沈青', '感情线', [ev(1, '推进', '镇口初遇'), plan(2, '推进', '结盟'), ev(2, '埋', '玉佩露面', '玉佩的来历')], 1),
    line('名册之谜', '主线', [ev(2, '推进', '拿到名册')], 2),
    line('黑市', '支线', [plan(3, '推进', '进黑市')], 0),
  ];

  test('实际事件按线的先后（主线 → 支线 → 感情线 → 人物线，同种类按目录）、带颜色与证据；计划的不给；没事件的章给梗概', () => {
    const m = views.buildTimelineMatrix(book(LINES, threads(), [ev(2, '埋', '断剑', '断剑')]), chapters(3));
    const cards = m.days.flatMap((d) => d.cards);
    assert.deepEqual(cards[0].events, [{ thread: '林昭与沈青', color: 2, type: '推进', what: '镇口初遇', evidence: '原文1' }]);
    assert.deepEqual(
      cards[1].events.map((e) => [e.thread, e.color, e.type, e.foreshadowing, e.what]),
      [
        ['名册之谜', 0, '推进', undefined, '拿到名册'],
        ['林昭与沈青', 2, '埋', '玉佩的来历', '玉佩露面'],
        ['未归属的伏笔', -1, '埋', '断剑', '断剑'],
      ]
    );
    // 第 3 章只有计划：没有事件，给细纲的梗概。
    assert.deepEqual([cards[2].events, cards[2].synopsis], [[], '林昭夜探青崖镇，撞见黑衣人。']);
    assert.equal(cards[1].synopsis, undefined);
  });

  test('筛选下拉的线：只列有实际事件的，颜色同卡片；「未归属的伏笔」排最后', () => {
    const m = views.buildTimelineMatrix(book(LINES, threads(), [ev(2, '埋', '断剑', '断剑')]), chapters(3));
    assert.deepEqual(m.threads, [
      { name: '名册之谜', color: 0 },
      { name: '林昭与沈青', color: 2 },
      { name: '未归属的伏笔', color: -1 },
    ]);
    const quiet = views.buildTimelineMatrix(book(LINES, threads()), chapters(3));
    assert.ok(!quiet.threads.some((t) => t.name === '未归属的伏笔'));
  });
});

describe('时间线总览 · 标题栏与动作', () => {
  test('标题栏：历法、起点、推到哪；悬停是历法怎么算；补推、重推、起点建议与工程页那一组同一份', () => {
    const t = timeline(['- 第 1 章：+0 天〔依据：「起」〕', '- 第 2 章：+2 天〔依据：「两日后」〕〔文中：三月初七「三月初七」〕'], '');
    const m = views.buildTimelineMatrix({ threads: [], unfiled: unfiled(), timeline: t }, chapters(4));
    assert.equal(m.relPath, REL);
    assert.equal(m.exists, true);
    assert.equal(m.meta, '简单历 · 没填起点 · 推到第 2 章 · 故事第 3 天');
    assert.ok(m.tip.startsWith('简单历 · 没填起点，只显示第几天\n简单历：每月 30 天'), m.tip);
    assert.deepEqual(m.calendar, { name: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章写了「三月初七」' } });
    assert.deepEqual(m.issues.map((i) => i.text), ['没填起点：第 2 章写了「三月初七」，第 1 章是三月初五（右键填为起点）', '第 3–4 章还没推：同步过，点标题旁的「补推时间」补上']);
    assert.deepEqual(m.missing, { count: 2, text: '第 3–4 章还没推出来' });
    assert.equal(m.machine, 2);
    assert.equal(m.last, 4);
    // 还没推的章（时间线写到的最后一章之后）不上轴（⚑6）。
    assert.deepEqual(m.days.flatMap((d) => d.cards.map((c) => c.no)), [1, 2]);
  });

  test('没有时间线文件、也没有要补推的：exists 为 false，什么都没有', () => {
    const m = views.buildTimelineMatrix({ threads: [], unfiled: unfiled(), timeline: tl.emptyTimeline(REL) }, chapters(2).map((c) => ({ ...c, finalized: false })));
    assert.deepEqual([m.exists, m.days, m.issues, m.relPath], [false, [], [], REL]);
    // 手搭的整本没有时间线：一样。
    assert.equal(views.buildTimelineMatrix({ threads: [], unfiled: unfiled() }, []).exists, false);
  });
});
