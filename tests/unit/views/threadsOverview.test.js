/**
 * 编辑区「叙事线总览」的矩阵（`views/threads.ts` 的 `buildThreadsMatrix`，叙事线重做三期）：章 × 线。纯函数，输入是
 * `readThreads()` 读出来的整本、有细纲或正文的那几章、「现在」（定稿到的最后一章）。读盘那一半在
 * tests/integration/views/threadsOverview.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 列：第 1 章到计划或已写的最后一章（事件、伏笔的埋与收、线的计划区间都算），中间没文件的补 `none`、卷名沿用前一章 | 设计稿「八」：横轴是章 |
 * | 提得太远的截在上限、说原本到第几章；有文件的章永远画全 | 不静默截断 |
 * | 行：按种类分组（主线 → 支线 → 感情线 → 人物线）、组里的先后同工程页；一行的说法与工程页那一行一字不差 | 文案只有一份 |
 * | 线的格子：线自己的事件，计划与实际分开；伏笔的事件不在这里 | ○ / ● / ◉ |
 * | 偏差：计划了、那一章定稿了却一条实际的都没有；没定稿的章不算 | 红圈 |
 * | 伏笔的格子：埋 / 收 / 弃；计划埋、计划收没发生的是偏差，提前了的不是 | 红圈 |
 * | 伏笔连线：收了的实线、埋了没收的虚线延到回收章（推迟了取晚的；逾期延到现在）、还没埋的按计划淡虚线 | 设计稿「八」与二期留的问题 |
 * | 「未归属的伏笔」：一条都没有不给 | 同工程页 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf } = loadBundle({ views: './src/core/views/threads.ts', tf: './src/core/model/threadFile.ts' });

const DIR = '.novelforge/threads';

/** 一条线：frontmatter + 伏笔 + 进展，经真解析器读出来（与 `readThreads` 同一条路）。 */
function line(name, { kind = '支线', plan, intent = '', fores = [], events = [] } = {}, index = 0) {
  const raw = [
    '---',
    `kind: ${kind}`,
    ...(plan ? [`plan: ${plan}`] : []),
    '---',
    '',
    `# ${name}`,
    '',
    '## 意图',
    '',
    intent,
    '',
    '## 伏笔',
    '',
    ...fores.map((f) => `- ${f}`),
    '',
    '## 进展',
    '',
    ...events.map((e) => `- ${e}`),
    '',
  ].join('\n');
  return tf.parseThreadFile(raw, `${DIR}/${name}.md`, index);
}

function unfiled(fores = [], events = []) {
  const raw = ['# 未归属的伏笔', '', '## 伏笔', '', ...fores.map((f) => `- ${f}`), '', '## 进展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseUnfiledFile(raw, `${DIR}/未归属的伏笔.md`);
}

/** 实际事件（带证据）与计划事件。 */
const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔证据：「原文${no}」〕`;
const plan = (no, type, what, fore) => `第 ${no} 章 · 计划 · ${type}${fore ? `〈${fore}〉` : ''}：${what}`;

/** 有细纲或正文的章：第 1–4 章定稿了，第 5 章写了没定稿，第 6 章只有细纲；第 3、4 章在第一卷里。 */
function chapters() {
  const c = (no, state, volume = '') => ({
    no,
    title: `第${no}章标题`,
    volume,
    state,
    ...(state !== 'planned' ? { chapterPath: `chapters/${volume ? `${volume}/` : ''}00${no}.md` } : {}),
    plotPath: `.novelforge/summaries/${volume ? `${volume}/` : ''}00${no}.md`,
  });
  return [c(1, 'finalized'), c(2, 'finalized'), c(3, 'finalized', '第一卷'), c(4, 'finalized', '第一卷'), c(5, 'written', '第一卷'), c(6, 'planned', '第一卷')];
}

function book() {
  const threads = [
    line(
      '林昭与沈青',
      {
        kind: '感情线',
        plan: '2-12',
        intent: '从互相猜忌到并肩',
        fores: ['玉佩的来历：林昭的玉佩是沈家旧物（计划第 2 章埋、第 4 章前收）', '沈青的旧伤：左臂的刀疤（计划第 3 章埋、第 9 章前收）', '旧信（计划第 7 章埋、第 10 章前收）'],
        events: [
          plan(2, '推进', '初遇'),
          ev(2, '推进', '镇口初遇'),
          plan(2, '埋', '玉佩露面', '玉佩的来历'),
          ev(2, '埋', '玉佩第一次露面', '玉佩的来历'),
          plan(3, '推进', '结盟'),
          plan(3, '埋', '旧伤', '沈青的旧伤'),
          ev(4, '关系', '猜忌 → 结盟'),
          plan(4, '收', '认出云纹', '玉佩的来历'),
          ev(4, '收', '认出云纹', '玉佩的来历'),
          plan(5, '推进', '同行'),
          plan(6, '推进', '北上'),
          // 推迟了：伏笔那一行写第 9 章前收，排细纲时推到第 10 章（二期 ⚑6：那一行不跟着改）。
          plan(10, '收', '揭开旧伤', '沈青的旧伤'),
        ],
      },
      0
    ),
    line('青崖旧案', { kind: '主线', plan: '1-', events: [ev(1, '推进', '回到青崖'), plan(3, '推进', '找到令牌'), ev(3, '推进', '找到令牌'), ev(3, '埋', '令牌背面的字', '令牌')] }, 1),
    line('守卫的选择', { kind: '人物线', events: [ev(1, '推进', '放走林昭'), ev(2, '收束', '交出令牌')] }, 2),
    line('黑市', { kind: '支线', plan: '7-9' }, 3),
  ];
  return {
    threads,
    unfiled: unfiled(['断剑：剑上刻着青崖二字（第 3 章前收）', '火折子'], [ev(1, '埋', '断剑出土', '断剑'), ev(2, '弃', '扔进河里', '火折子')]),
  };
}

const lineOf = (m, name) => m.groups.flatMap((g) => g.lines).find((l) => l.name === name);
const foreOf = (l, name) => l.foreshadowing.find((f) => f.name === name);
const cellAt = (row, no) => row.cells.find((c) => c.chapter === no);

describe('叙事线总览 · 列', () => {
  test('第 1 章到计划或已写的最后一章，一章不缺；没文件的章补 none、卷名沿用前一章', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    // 伏笔「旧信」计划第 10 章前收、线「林昭与沈青」计划第 12 章收束：都是计划，列画到第 12 章。
    assert.deepEqual(m.chapters.map((c) => c.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(m.chapters.map((c) => c.state), ['finalized', 'finalized', 'finalized', 'finalized', 'written', 'planned', 'none', 'none', 'none', 'none', 'none', 'none']);
    assert.equal(m.chapters[2].volume, '第一卷');
    assert.equal(m.chapters[0].volume, '');
    assert.equal(m.chapters[9].volume, '第一卷', '没文件的章沿用前一章的卷');
    assert.equal(m.chapters[6].title, '');
    assert.equal(m.chapters[0].chapterPath, 'chapters/001.md');
    assert.equal(m.chapters[5].chapterPath, undefined);
    assert.equal(m.volumes, true);
    assert.equal(m.current, 4);
    assert.equal(m.clippedFrom, undefined);
  });

  test('没有分卷：volumes 是 false；一条线、一章都没有：空的', () => {
    const flat = chapters().map((c) => ({ ...c, volume: '' }));
    assert.equal(views.buildThreadsMatrix(book(), flat, 4).volumes, false);
    const empty = views.buildThreadsMatrix({ threads: [], unfiled: unfiled() }, [], 0);
    assert.deepEqual(empty, { chapters: [], current: 0, through: 0, volumes: false, groups: [] });
  });

  test('计划里提得太远（手误）：截在上限、说原本到第几章；有文件的章照样画全', () => {
    const b = { threads: [line('黑市', { plan: '2-30000' })], unfiled: unfiled() };
    const m = views.buildThreadsMatrix(b, chapters(), 4, { limit: 50 });
    assert.equal(m.chapters.length, 50);
    assert.equal(m.clippedFrom, 30000);
    const many = Array.from({ length: 60 }, (_, i) => ({ no: i + 1, title: '', volume: '', state: 'planned', plotPath: `p/${i + 1}.md` }));
    assert.equal(views.buildThreadsMatrix(b, many, 0, { limit: 50 }).chapters.length, 60, '有细纲的章不截');
  });
});

describe('叙事线总览 · 行', () => {
  test('按种类分组：主线 → 支线 → 感情线 → 人物线；组里的先后、一行的说法与工程页一样', () => {
    const b = book();
    const m = views.buildThreadsMatrix(b, chapters(), 4);
    assert.deepEqual(m.groups.map((g) => g.kind), ['主线', '支线', '感情线', '人物线']);
    assert.deepEqual(m.groups.map((g) => g.lines.map((l) => l.name)), [['青崖旧案'], ['黑市'], ['林昭与沈青'], ['守卫的选择']]);
    const pane = views.buildThreadsView(b, 4);
    for (const l of pane.lines) {
      const row = lineOf(m, l.name);
      assert.equal(row.detail, l.detail);
      assert.deepEqual(row.warnings, l.warnings);
      assert.equal(row.tip, l.tip);
      assert.equal(row.status, l.status);
      assert.equal(row.relPath, l.relPath);
    }
    assert.equal(lineOf(m, '林昭与沈青').from, 2);
    assert.equal(lineOf(m, '林昭与沈青').to, 12);
    assert.equal(lineOf(m, '青崖旧案').to, undefined);
  });

  test('每条线下面是它的伏笔：「伏笔」一节写了的在前，只在事件里出现过的跟在后面', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    assert.deepEqual(lineOf(m, '林昭与沈青').foreshadowing.map((f) => f.name), ['玉佩的来历', '沈青的旧伤', '旧信']);
    assert.deepEqual(lineOf(m, '青崖旧案').foreshadowing.map((f) => f.name), ['令牌']);
    assert.deepEqual(lineOf(m, '黑市').foreshadowing, []);
  });

  test('「未归属的伏笔」在最后；一条都没有不给', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    assert.equal(m.unfiled.relPath, `${DIR}/未归属的伏笔.md`);
    assert.deepEqual(m.unfiled.foreshadowing.map((f) => f.name), ['断剑', '火折子']);
    const b = book();
    b.unfiled = unfiled();
    assert.equal(views.buildThreadsMatrix(b, chapters(), 4).unfiled, undefined);
  });
});

describe('叙事线总览 · 线的格子', () => {
  test('只给有事件的章；计划与实际分开；伏笔的事件不在线这一行', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭与沈青');
    assert.deepEqual(pair.cells.map((c) => c.chapter), [2, 3, 4, 5, 6]);
    const two = cellAt(pair, 2);
    assert.deepEqual(two.planned, [{ type: '推进', what: '初遇' }]);
    assert.deepEqual(two.actual, [{ type: '推进', what: '镇口初遇', evidence: '原文2' }]);
    // 第 2 章的埋〈玉佩的来历〉在伏笔那一行。
    assert.ok(pair.cells.every((c) => [...c.planned, ...c.actual].every((e) => !e.foreshadowing)));
  });

  test('四种：只有计划 / 只有实际 / 计划也发生了 / 计划了、定稿了却没发生（偏差）', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭与沈青');
    // 第 2 章：计划推进、也推进了。
    assert.equal(cellAt(pair, 2).deviation, false);
    // 第 3 章：计划结盟，第 3 章定稿了却一条实际的都没有——偏差。
    assert.deepEqual(cellAt(pair, 3).actual, []);
    assert.equal(cellAt(pair, 3).deviation, true);
    // 第 4 章：只有实际（关系）。
    assert.deepEqual(cellAt(pair, 4).planned, []);
    assert.equal(cellAt(pair, 4).deviation, false);
    // 第 5 章写了没定稿、第 6 章只有细纲：只有计划，不是偏差。
    assert.equal(cellAt(pair, 5).deviation, false);
    assert.equal(cellAt(pair, 6).deviation, false);
  });

  test('偏差比的是「那一章定稿了没有」，不是「现在」：现在挪到第 6 章，没定稿的第 5 章照样不算', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 6), '林昭与沈青');
    assert.equal(cellAt(pair, 5).deviation, false);
  });

  // 四期：定稿到第 4 章、叙事线只判到第 2 章——第 3、4 章定稿了还没判，列头另标，上面的计划不算偏差；状态按第 2 章算。
  test('叙事线落后于定稿：还没判的列标 unjudged、计划不算偏差；判到第几章另给；逾期按判到的那一章算', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4, { mark: { through: 2, judged: [] } });
    assert.equal(m.current, 4);
    assert.equal(m.through, 2);
    assert.deepEqual(
      m.chapters.slice(0, 5).map((c) => [c.no, c.state, !!c.unjudged]),
      [[1, 'finalized', false], [2, 'finalized', false], [3, 'finalized', true], [4, 'finalized', true], [5, 'written', false]]
    );
    const pair = lineOf(m, '林昭与沈青');
    assert.equal(cellAt(pair, 3).deviation, false, '第 3 章还没判，计划结盟不算偏差');
    assert.equal(cellAt(foreOf(pair, '沈青的旧伤'), 3).deviation, false);
    // 「断剑」第 3 章前收：按定稿到（第 4 章）算是逾期，按判到（第 2 章）算还没到。
    assert.equal(foreOf(m.unfiled, '断剑').overdue, false);
    assert.equal(foreOf(views.buildThreadsMatrix(book(), chapters(), 4).unfiled, '断剑').overdue, true);
    // 水位之后另外判过的那一章照算偏差、不标还没判。
    const sparse = views.buildThreadsMatrix(book(), chapters(), 4, { mark: { through: 1, judged: [3] } });
    assert.equal(sparse.chapters[2].unjudged, undefined);
    assert.equal(cellAt(lineOf(sparse, '林昭与沈青'), 3).deviation, true);
    assert.equal(sparse.chapters[1].unjudged, true);
  });
});

describe('叙事线总览 · 伏笔的格子与连线', () => {
  test('收了的：埋 ● 到收 ◆ 实线；计划埋、计划收都发生了，不是偏差', () => {
    const jade = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭与沈青'), '玉佩的来历');
    assert.equal(jade.status, '已收');
    assert.equal(jade.plantedAt, 2);
    assert.equal(jade.closedAt, 4);
    assert.deepEqual(jade.span, { from: 2, to: 4, kind: 'done' });
    assert.deepEqual(jade.cells.map((c) => c.chapter), [2, 4]);
    assert.deepEqual(cellAt(jade, 4).actual, [{ type: '收', foreshadowing: '玉佩的来历', what: '认出云纹', evidence: '原文4' }]);
    assert.ok(jade.cells.every((c) => !c.deviation));
    assert.equal(jade.overdue, false);
    assert.match(jade.tip, /林昭的玉佩是沈家旧物/);
    assert.match(jade.tip, /计划第 2 章埋、第 4 章前收/);
    assert.match(jade.tip, /第 4 章收了/);
  });

  test('计划第 3 章埋、第 3 章定稿了却没埋：偏差；还没埋，按计划画淡虚线到回收章（推迟的收更晚，取晚的）', () => {
    const scar = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭与沈青'), '沈青的旧伤');
    assert.equal(scar.status, '计划');
    assert.equal(cellAt(scar, 3).deviation, true);
    assert.deepEqual(cellAt(scar, 3).planned, [{ type: '埋', foreshadowing: '沈青的旧伤', what: '旧伤' }]);
    // 计划第 10 章收（还没到，第 10 章也没定稿）：不是偏差。
    assert.equal(cellAt(scar, 10).deviation, false);
    // 伏笔那一行写第 9 章前收，计划里推到第 10 章收：取晚的第 10 章。
    assert.deepEqual(scar.span, { from: 3, to: 10, kind: 'planned' });
    assert.match(scar.tip, /还没埋/);
  });

  test('埋了没收：虚线从埋的那一章延到回收章；没写回收章的延到现在', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    // 「断剑」第 1 章埋、第 3 章前收、现在第 4 章：逾期，虚线延到现在。
    const sword = foreOf(m.unfiled, '断剑');
    assert.equal(sword.overdue, true);
    assert.deepEqual(sword.span, { from: 1, to: 4, kind: 'open' });
    assert.match(sword.tip, /过了第 3 章（逾期）/);
    // 「令牌」第 3 章埋、什么都没写：延到现在第 4 章。
    const token = foreOf(lineOf(m, '青崖旧案'), '令牌');
    assert.deepEqual(token.span, { from: 3, to: 4, kind: 'open' });
    assert.equal(token.overdue, false);
  });

  test('弃了的：只有弃那一格、没埋过不连线', () => {
    const fire = foreOf(views.buildThreadsMatrix(book(), chapters(), 4).unfiled, '火折子');
    assert.equal(fire.status, '已弃');
    assert.equal(fire.closedAt, 2);
    assert.equal(fire.span, undefined);
    assert.deepEqual(cellAt(fire, 2).actual.map((e) => e.type), ['弃']);
  });

  test('只写了计划（伏笔那一行），一条事件都没有：没有格子，有淡虚线', () => {
    const letter = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭与沈青'), '旧信');
    assert.deepEqual(letter.cells, []);
    assert.deepEqual(letter.span, { from: 7, to: 10, kind: 'planned' });
  });

  test('提前埋了的不算偏差；计划收、到那一章还没收的才算', () => {
    const b = {
      threads: [
        line('支线甲', {
          fores: ['密信'],
          events: [ev(1, '埋', '密信露面', '密信'), plan(2, '埋', '再提密信', '密信'), plan(3, '收', '拆开密信', '密信')],
        }),
      ],
      unfiled: unfiled(),
    };
    const row = foreOf(lineOf(views.buildThreadsMatrix(b, chapters(), 4), '支线甲'), '密信');
    assert.equal(cellAt(row, 2).deviation, false, '第 1 章已经埋了');
    assert.equal(cellAt(row, 3).deviation, true, '第 3 章该收没收');
  });
});

// 故事时间（2026-10-24）：一列一格、月份带、伏笔埋了多少天。
describe('总览 · 故事时间', () => {
  const tl = loadBundle({ tl: './src/core/model/timelineFile.ts' }).tl;
  const timeline = (lines, start = '三月初七') =>
    tl.parseTimelineFile(['---', 'calendar: 简单历', `start: ${start}`, '---', '', '# 时间线', '', ...lines, ''].join('\n'), `${DIR}/时间线.md`);
  const LINES = [
    '- 第 1 章：+0 天，傍晚〔依据：「起」〕',
    '- 第 2 章：+2 天〔推测：赶路〕',
    '- 第 3 章：+1 天〔依据：「次日」〕',
    '- 第 4 章：+5 天，历时 2 天',
  ];

  test('一列一格：几号、全称、悬停；同一天不写字；月份带的名字；有时间线才给 timeline', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline([...LINES, '- 第 5 章：+0 天〔依据：「当天」〕']) }, chapters(), 4);
    assert.deepEqual(m.timeline, { relPath: `${DIR}/时间线.md`, months: true });
    const t = m.chapters.slice(0, 6).map((c) => c.time && [c.time.state, c.time.short, c.time.label, c.time.month ?? '']);
    // 第 5 章 +0 天：接在第 4 章的结尾（历时 2 天，到十六）那一天，和第 4 章开头不是同一天，照写几号。
    assert.deepEqual(t, [
      ['evidence', '初七', '三月初七 傍晚', '三月'],
      ['guess', '初九', '三月初九', '三月'],
      ['evidence', '初十', '三月初十', '三月'],
      ['anchor', '十五', '三月十五', '三月'],
      ['evidence', '十六', '三月十六', '三月'],
      undefined,
    ]);
    // 同一天（开头一样）的格子不写字。
    const same = views.buildThreadsMatrix({ ...book(), timeline: timeline(['- 第 1 章：+0 天', '- 第 2 章：+0 天']) }, chapters(), 4);
    assert.deepEqual(same.chapters.slice(0, 2).map((c) => c.time.short), ['初七', '']);
    const tip = m.chapters[3].time.tip;
    assert.ok(tip.includes('故事第 9 天，历时 2 天，到三月十六；比上一章：+5 天'), tip);
    assert.ok(tip.includes('你定的'), tip);
    assert.ok(m.chapters[1].time.tip.includes('推测：赶路'), m.chapters[1].time.tip);
    // 没有时间线：没有这一项，列上也没有 time。
    const plain = views.buildThreadsMatrix(book(), chapters(), 4);
    assert.equal(plain.timeline, undefined);
    assert.ok(plain.chapters.every((c) => !c.time));
  });

  test('没有起点：格子写第几天，没有月份带', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline(LINES, '') }, chapters(), 4);
    assert.deepEqual(m.timeline.months, false);
    assert.deepEqual(m.chapters.slice(0, 4).map((c) => c.time.short), ['1', '3', '4', '9']);
  });

  test('时间线写到更后面的章：列跟着画到那一章', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline([...LINES, '- 第 14 章：+1 天']) }, chapters(), 4);
    assert.equal(m.chapters.length, 14);
    assert.equal(m.chapters[13].time.state, 'anchor');
  });

  test('埋了没收的伏笔：悬停说故事里过了几天（埋的那一章开头到叙事线判到的那一章结尾）', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline(LINES) }, chapters(), 4);
    const token = foreOf(lineOf(m, '青崖旧案'), '令牌');
    assert.ok(token.tip.includes('第 3 章埋下，还没收（故事里已经过了 6 天）'), token.tip);
  });
});
