/**
 * 工程页「叙事线」页签的数据（`views/threads.ts`，叙事线重做第 8 个提交）：一条线一行怎么写、怎么排，「未归属的伏笔」
 * 那一行。纯函数，输入是 `readThreads()` 读出来的整本与「现在」（定稿到的最后一章）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 主线 → 支线 → 感情线 → 人物线；同种类最近推进的在前，没推进过的排最后、按计划开始的章 | 设计稿「七、工程页」 |
 * | 一行写种类 · 状态 · 最近第 N 章 · 几条伏笔没收；没推进过写计划区间 | 一眼看出走到哪 |
 * | ⚠ 断了几章（主线 5 章 / 其余 15 章）、几条伏笔逾期、过了计划收束的第几章 | 哪条要管一管 |
 * | 收束了的线不报断、不报过了收束章 | 走完了的线不是问题 |
 * | 状态按「现在」算：现在往前挪，⚠ 跟着变 | 状态不落盘（第 18 条） |
 * | 「未归属的伏笔」一条都没有不给这一行 | 点进去也是空的 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf } = loadBundle({ views: './src/core/views/threads.ts', tf: './src/core/model/threadFile.ts' });

const DIR = '.novelforge/threads';

/** 一条线：frontmatter + 伏笔 + 进展，经真解析器读出来（与 `readThreads` 同一条路）。 */
function line(name, { kind = '支线', plan, intent = '', progress = '', fores = [], events = [] } = {}, index = 0) {
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
    '## 当前进度',
    '',
    progress,
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

const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔证据：「原文${no}」〕`;

function book() {
  const threads = [
    line('林昭与沈青', {
      kind: '感情线',
      plan: '3-20',
      intent: '从互相猜忌到并肩',
      progress: '两人在青崖镇结盟',
      fores: ['玉佩的来历：林昭的玉佩是沈家旧物（计划第 3 章埋、第 8 章前收）', '沈青的旧伤'],
      events: [ev(3, '推进', '初遇'), ev(3, '埋', '玉佩露面', '玉佩的来历'), ev(5, '关系', '结盟')],
    }, 0),
    line('李叔的旧账', { kind: '支线', plan: '12-30' }, 1),
    line('青崖旧案', { kind: '主线', plan: '1-60', events: [ev(1, '推进', '回到青崖'), ev(4, '推进', '找到令牌')] }, 2),
    line('守卫的选择', { kind: '人物线', plan: '2-6', events: [ev(2, '推进', '放走林昭'), ev(6, '收束', '交出令牌')] }, 3),
    line('黑市', { kind: '支线', events: [ev(9, '推进', '开市')] }, 4),
    line('沈家血书', { kind: '支线', plan: '5-' }, 5),
  ];
  return { threads, unfiled: unfiled(['断剑：剑上刻着青崖二字（第 6 章前收）', '火折子'], [ev(2, '埋', '断剑出土', '断剑')]) };
}

describe('叙事线页签 · 一条线一行', () => {
  test('主线 → 支线 → 感情线 → 人物线；同种类最近推进的在前，没推进过的按计划开始的章排在最后', () => {
    const v = views.buildThreadsView(book(), 10);
    assert.deepEqual(
      v.lines.map((l) => l.name),
      ['青崖旧案', '黑市', '沈家血书', '李叔的旧账', '林昭与沈青', '守卫的选择']
    );
    assert.equal(v.current, 10);
  });

  test('一行：种类 · 状态 · 最近第 N 章 · 几条伏笔没收', () => {
    const v = views.buildThreadsView(book(), 10);
    const pair = v.lines.find((l) => l.name === '林昭与沈青');
    assert.equal(pair.detail, '感情线 · 进行中 · 最近第 5 章 · 2 条伏笔没收');
    assert.equal(pair.relPath, `${DIR}/林昭与沈青.md`);
    assert.equal(pair.kind, '感情线');
    assert.equal(pair.status, '进行中');
    assert.equal(pair.lastActive, 5);
    assert.ok(pair.tip.includes('意图：从互相猜忌到并肩') && pair.tip.includes('当前进度：两人在青崖镇结盟'), pair.tip);
  });

  test('还没推进过的写计划区间：两头都有、只写开头、都没写', () => {
    const v = views.buildThreadsView(book(), 10);
    const detail = (name) => v.lines.find((l) => l.name === name).detail;
    assert.equal(detail('李叔的旧账'), '支线 · 计划中 · 计划第 12–30 章');
    assert.equal(detail('沈家血书'), '支线 · 计划中 · 计划第 5 章起');
  });

  test('⚠：断了几章、几条伏笔逾期、过了计划收束的第几章', () => {
    const v = views.buildThreadsView(book(), 22);
    const warn = (name) => v.lines.find((l) => l.name === name).warnings;
    // 感情线 15 章没动算断；玉佩第 8 章前该收、还没收；计划第 20 章收束、现在第 22 章。
    assert.deepEqual(warn('林昭与沈青'), ['断了 17 章', '1 条伏笔逾期', '过了计划收束的第 20 章']);
    // 主线 5 章没动就算断。
    assert.deepEqual(warn('青崖旧案'), ['断了 18 章']);
    // 计划中的线不算断；计划第 30 章收，还没到。
    assert.deepEqual(warn('李叔的旧账'), []);
  });

  test('收束了的线不报断、不报过了收束章，打「已收束」', () => {
    const v = views.buildThreadsView(book(), 40);
    const done = v.lines.find((l) => l.name === '守卫的选择');
    assert.equal(done.status, '已收束');
    assert.equal(done.detail, '人物线 · 已收束 · 最近第 6 章');
    assert.deepEqual(done.warnings, []);
  });

  test('状态按「现在」算：现在往前挪，⚠ 跟着变', () => {
    const early = views.buildThreadsView(book(), 6);
    assert.deepEqual(early.lines.find((l) => l.name === '林昭与沈青').warnings, []);
    assert.deepEqual(early.lines.find((l) => l.name === '青崖旧案').warnings, []);
    const later = views.buildThreadsView(book(), 9);
    assert.deepEqual(later.lines.find((l) => l.name === '青崖旧案').warnings, ['断了 5 章']);
    assert.deepEqual(later.lines.find((l) => l.name === '林昭与沈青').warnings, ['1 条伏笔逾期']);
  });

  // 四期：定稿到第 9 章、叙事线只判到第 6 章（第 7–9 章定稿了还没判，第 8 章另外判过）——状态按判到的那一章算，另说哪几章还没判。
  test('叙事线落后于定稿：状态按判到的那一章算，⚠ 不跟着定稿到走；另说「第 a–b 章还没判」', () => {
    const v = views.buildThreadsView(book(), 9, { mark: { through: 6, judged: [8] }, finalized: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(v.current, 9);
    assert.equal(v.through, 6);
    assert.deepEqual(v.lag, { count: 2, text: '第 7、9 章还没判' });
    assert.deepEqual(v.lines.find((l) => l.name === '青崖旧案').warnings, [], '按第 6 章算没断');
    assert.deepEqual(v.lines.find((l) => l.name === '林昭与沈青').warnings, [], '按第 6 章算没逾期');
    // 水位比定稿到还靠后（定稿之后又删了几章）：判到不超过定稿到；没有落后就不给 lag。
    const ahead = views.buildThreadsView(book(), 9, { mark: { through: 12, judged: [] }, finalized: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(ahead.through, 9);
    assert.equal(ahead.lag, undefined);
    assert.deepEqual(ahead.lines.find((l) => l.name === '青崖旧案').warnings, ['断了 5 章']);
  });

  test('一条线都没有：空列表', () => {
    const v = views.buildThreadsView({ threads: [], unfiled: unfiled() }, 3);
    assert.deepEqual(v, { lines: [], current: 3, through: 3, watch: { lines: [], foreshadowing: [], unplanted: [] } });
  });

  // 叙事线二期：写前检查要的数也从这里出（前端批量写章弹窗拿它算提醒），按现在的样子算。
  test('写前检查要的数：进行中的线与没收、写了回收章的伏笔', () => {
    const v = views.buildThreadsView(book(), 9);
    assert.ok(v.watch.lines.some((l) => l.name === '青崖旧案' && l.kind === '主线' && l.stall === 5), JSON.stringify(v.watch));
    assert.ok(v.watch.foreshadowing.every((f) => Number.isInteger(f.resolve)), JSON.stringify(v.watch));
  });
});

describe('叙事线页签 · 未归属的伏笔', () => {
  test('「N 条」，有收了的另写几条没收；逾期的报 ⚠', () => {
    const b = book();
    b.unfiled = unfiled(['断剑：剑上刻着青崖二字（第 6 章前收）', '火折子', '旧信'], [ev(2, '埋', '断剑出土', '断剑'), ev(4, '收', '烧了', '旧信')]);
    const v = views.buildThreadsView(b, 10);
    assert.deepEqual(v.unfiled, {
      relPath: `${DIR}/未归属的伏笔.md`,
      total: 3,
      detail: '3 条 · 2 条没收',
      warnings: ['1 条伏笔逾期'],
    });
  });

  test('只在事件里出现过名字的也算一条', () => {
    const v = views.buildThreadsView({ threads: [], unfiled: unfiled([], [ev(2, '埋', '有人跟踪', '黑衣人')]) }, 3);
    assert.equal(v.unfiled.total, 1);
    assert.equal(v.unfiled.detail, '1 条');
  });

  test('一条都没有（没有这份文件、或都挪走了）不给这一行', () => {
    assert.equal(views.buildThreadsView({ threads: [], unfiled: unfiled() }, 3).unfiled, undefined);
    assert.equal(views.buildThreadsView({ threads: [], unfiled: tf.parseUnfiledFile('', `${DIR}/未归属的伏笔.md`) }, 3).unfiled, undefined);
  });
});

// 故事时间（2026-10-24）：「时间线」一行。
describe('叙事线页签 · 时间线一行', () => {
  const tl = loadBundle({ tl: './src/core/model/timelineFile.ts' }).tl;
  const REL = '.novelforge/threads/时间线.md';
  const timeline = (lines, start = '三月初七') =>
    tl.parseTimelineFile(['---', 'calendar: 简单历', `start: ${start}`, '---', '', '# 时间线', '', ...lines, ''].join('\n'), REL);
  const progress = (through, finalized) => ({ mark: { through, judged: [] }, finalized });

  test('推到第几章、现在是哪天、过了多久；推不出、认不出、你定的、叙事线判过却还没推的', () => {
    const t = timeline([
      '- 第 1 章：+0 天，傍晚〔依据：「起」〕',
      '- 第 2 章：+?〔推不出：没交代〕',
      '- 第 3 章：过了好一阵',
      '- 第 4 章：八月十五',
      '- 第 5 章：+3 天，历时 2 天〔依据：「三日后」〕',
    ]);
    const v = views.buildThreadsView({ threads: [], unfiled: { name: '未归属的伏笔', relPath: '', foreshadowing: [], events: [] }, timeline: t }, 8, progress(7, [1, 2, 3, 4, 5, 6, 7, 8]));
    const row = v.timeline;
    assert.equal(row.relPath, REL);
    assert.equal(row.exists, true);
    // 八月十五是第 159 天；第 5 章 +3 天、历时 2 天：第 162–163 天，八月十八到十九。
    assert.equal(row.detail, '推到第 5 章 · 现在：八月十九 · 故事里过了 163 天');
    assert.deepEqual(row.warnings, ['1 章推不出', '1 行认不出', '第 6–7 章还没推']);
    assert.deepEqual(row.missing, { count: 2, text: '第 6–7 章还没推' });
    assert.ok(row.tip.includes('你定的：第 4 章'), row.tip);
    assert.ok(row.tip.includes('起点：三月初七（第 1 天）'), row.tip);
  });

  test('没有文件、也没有要补推的：不画；没有文件、有要补推的：画，exists 为 false', () => {
    const empty = tl.emptyTimeline(REL);
    const base = { threads: [], unfiled: { name: '未归属的伏笔', relPath: '', foreshadowing: [], events: [] }, timeline: empty };
    assert.equal(views.buildThreadsView(base, 3, progress(0, [1, 2, 3])).timeline, undefined);
    const row = views.buildThreadsView(base, 3, progress(3, [1, 2, 3])).timeline;
    assert.equal(row.exists, false);
    assert.equal(row.detail, '还没有一章');
    assert.deepEqual(row.missing, { count: 3, text: '第 1–3 章还没推' });
  });

  test('起点认不出：⚠ 一句，只显示第几天', () => {
    const v = views.buildThreadsView(
      { threads: [], unfiled: { name: '未归属的伏笔', relPath: '', foreshadowing: [], events: [] }, timeline: timeline(['- 第 1 章：+0 天', '- 第 2 章：+4 天'], '很久以前') },
      2,
      progress(2, [1, 2])
    );
    assert.deepEqual(v.timeline.warnings, ['起点认不出']);
    assert.equal(v.timeline.detail, '推到第 2 章 · 现在：第 5 天 · 故事里过了 5 天');
  });
});

