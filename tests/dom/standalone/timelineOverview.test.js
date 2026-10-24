/**
 * 编辑区「时间线总览」标签（`media/src/editor/timelineOverview.ts`，2026-10-24，设计稿 docs/design/plans/2026-10-24-timeline-page.md）。
 * 数据由后端推来（`timelineOverview`），这里按消息造；后端怎么算在 tests/unit/views/timeline.test.js 与
 * tests/integration/views/timelineOverview.test.js。工程页「时间线」组的入口在 tests/dom/view/threadsRow.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 能力探测 | 独立版有人回答 `nf-timeline-query`；插件的 webview（只有 view.js）没有 |
 * | 标签 | 一个不对应文件的特殊标签「时间线总览」；要数据、先说在读；和「叙事线总览」各开各的 |
 * | 竖轴 | 月份分隔（带季节）、一个日子一行（大字日子、小字第几天）、空了 2 天以上插「N 天后」（照上一行最晚的结尾算） |
 * | 卡片 | 状态点、章号章名、时段与比上一章、依据；事件收着最多 3 条（线名小标签带色块）；没事件给梗概；对账红字；回忆虚线 |
 * | 展开 | 单击展开详情与全部事件（带原文），再点收起；选中 |
 * | 右键 | 卡片：改时间、重推、打开正文 / 细纲 / 时间线文件；标题栏：改历法与起点、补推、重推、打开文件、刷新（设置都在右键） |
 * | 对账 | 一条一行；带章号的点了展开那一章 |
 * | 筛选 | 只看有问题的、只看某条线；「N 天后」照留下的重算；定位过来的章被筛掉时放开筛选 |
 * | 定位 | `nf-timeline-command` 带章号：展开、选中 |
 * | 数据 | 别人的 requestId 不认；显示着收到 `state` 停一下再要；还不是工程、还没有一章各说一句 |
 * | 工程页入口 | 「时间线」组标题旁「总览」、点一章、点带章号的 ⚠ 打开时间线总览（展开那一章），不开正文、不开叙事线总览；叙事线组的「总览」不再因为有时间线才给 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, viewState, sampleTree } = require('../../helpers/dom');

const TL = '.novelforge/threads/时间线.md';

const ev = (thread, color, type, what, evidence, foreshadowing) => ({
  thread,
  color,
  type,
  ...(foreshadowing ? { foreshadowing } : {}),
  what,
  ...(evidence ? { evidence } : {}),
});

function card(no, extra = {}) {
  return {
    no,
    title: `章${no}`,
    state: 'evidence',
    when: '',
    note: '',
    events: [],
    issues: [],
    detail: [`第 ${no} 章 · 详情`],
    problem: false,
    chapterPath: `chapters/00${no}.txt`,
    plotPath: `.novelforge/summaries/00${no}.md`,
    machine: true,
    ...extra,
  };
}

/**
 * 四个日子：第 1 天（第 1、2 章）、第 6 天（第 3 章跨到第 8 天、第 4 章回忆）、第 9 天（第 5 章推不出）、第 40 天（第 6 章，下一个月）。
 * 第 3 章对账报了；第 7–8 章同步过还没推。
 */
function overview(extra = {}) {
  return {
    initialized: true,
    relPath: TL,
    exists: true,
    meta: '简单历 · 起点 大衍三年三月初七 · 推到第 6 章 · 故事第 40 天',
    tip: '简单历 · 起点 大衍三年三月初七（第 1 章那一天）\n右键改历法与起点。',
    calendar: { name: '简单历', start: '大衍三年三月初七' },
    issues: [
      { text: '第 3 章：前面推下来是三月初八，正文写三月十二（差 4 天），已按正文对齐', chapter: 3 },
      { text: '第 7–8 章还没推：同步过，点标题旁的「补推时间」补上' },
    ],
    threads: [
      { name: '青崖旧案', color: 0 },
      { name: '黑市', color: 1 },
      { name: '林昭与沈青', color: 2 },
      { name: '未归属的伏笔', color: -1 },
    ],
    days: [
      {
        day: 1,
        label: '三月初七',
        sub: '第 1 天',
        full: '大衍三年三月初七',
        month: '大衍三年三月',
        season: '春',
        cards: [
          card(1, {
            when: '傍晚 → 深夜',
            note: '依据「连日大雨的第三天傍晚」',
            end: 1,
            events: [
              ev('青崖旧案', 0, '推进', '回到青崖', '雨下了三天'),
              ev('林昭与沈青', 2, '关系', '初遇', '剑停在喉前三寸'),
              ev('林昭与沈青', 2, '埋', '玉佩露面', '他摸了摸玉佩', '玉佩的来历'),
              ev('未归属的伏笔', -1, '埋', '断剑出土', '半截断剑', '断剑'),
            ],
          }),
          card(2, { state: 'guess', when: '深夜', delta: '同一天', note: '推测：紧接着', end: 1, synopsis: '客栈里来了个女人。' }),
        ],
      },
      {
        day: 6,
        label: '三月十二',
        sub: '第 6 天',
        full: '大衍三年三月十二',
        month: '大衍三年三月',
        season: '春',
        cards: [
          card(3, { state: 'dated', when: '清晨 → 三月十四 夜里 · 3 天', delta: '+5 天', note: '正文写明三月十二', end: 8, issues: ['前面推下来是三月初八，正文写三月十二（差 4 天），已按正文对齐'], problem: true }),
          card(4, { state: 'flashback', when: '回忆（约二十年前）', flashback: true }),
        ],
      },
      {
        day: 9,
        label: '三月十五',
        sub: '第 9 天',
        full: '大衍三年三月十五',
        month: '大衍三年三月',
        season: '春',
        cards: [card(5, { state: 'unknown', note: '推不出：没交代', delta: '同一天', end: 9, problem: true })],
      },
      {
        day: 40,
        label: '四月十六',
        sub: '第 40 天',
        full: '大衍三年四月十六',
        month: '大衍三年四月',
        season: '夏',
        cards: [card(6, { state: 'anchor', note: '你定的', delta: '+31 天', end: 40, machine: false, events: [ev('黑市', 1, '推进', '进黑市')] })],
      },
    ],
    missing: { count: 2, text: '第 7–8 章还没推出来' },
    machine: 4,
    last: 8,
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['scrollIntoView', 'clipboard', ...(opts.shims ?? [])] });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  ui.post({ type: 'project', tree: opts.tree ?? sampleTree() });
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    window,
    toasts,
    specialTab: () => doc.querySelector('#edTabs .ed-tab-special[data-special="timeline-overview"]'),
    tlp: () => doc.querySelector('.wb-editor .ed-stage .tlp'),
    shown: () => !!h.tlp() && !h.tlp().classList.contains('hidden'),
    note: () => {
      const n = doc.querySelector('.tlp .tlp-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    card: (no) => doc.querySelector(`.tlp-card[data-no="${no}"]`),
    cards: () => [...doc.querySelectorAll('.tlp-card')].map((c) => Number(c.dataset.no)),
    /** 竖轴上一行一项：月份、「N 天后」、日子（日子写大字与卡片章号）。 */
    axis: () =>
      [...doc.querySelectorAll('.tlp-axis > *')].map((n) =>
        n.classList.contains('tlp-day')
          ? `${n.querySelector('.tlp-date').textContent}[${[...n.querySelectorAll('.tlp-card')].map((c) => c.dataset.no).join(',')}]`
          : n.textContent
      ),
    open(chapter) {
      window.dispatchEvent(new window.CustomEvent('nf-timeline-command', { detail: { name: 'open', ...(chapter !== undefined ? { chapter } : {}) } }));
    },
    respond(o = overview()) {
      const req = ui.last('requestTimelineOverview');
      assert.ok(req, '没发 requestTimelineOverview');
      ui.post({ type: 'timelineOverview', requestId: req.requestId, overview: o });
    },
    count: (type) => ui.sent.filter((m) => m.type === type).length,
    sentAfter: (n) => JSON.parse(JSON.stringify(ui.sent.slice(n))),
  };
  return h;
}

describe('时间线总览 · 能力探测与标签', { skip: JSDOM_SKIP }, () => {
  test('独立版有人回答 nf-timeline-query；插件的 webview（只有 view.js）没有', () => {
    const ask = (win) => {
      const detail = { available: false };
      win.dispatchEvent(new win.CustomEvent('nf-timeline-query', { detail }));
      return detail.available;
    };
    assert.equal(ask(harness().window), true);
    assert.equal(ask(mount().window), false);
  });

  test('打开：主区一个不对应文件的「时间线总览」标签；要数据、先说在读；回来了画出来', () => {
    const h = harness();
    h.open();
    assert.equal(h.specialTab()?.querySelector('.ed-tab-name').textContent, '时间线总览');
    assert.ok(h.shown());
    assert.match(h.ui.last('requestTimelineOverview').requestId, /^timeline-/);
    assert.match(h.note(), /正在读取时间线/);
    h.respond();
    assert.equal(h.note(), '');
    assert.equal(h.doc.querySelector('.tlp-meta').textContent, '简单历 · 起点 大衍三年三月初七 · 推到第 6 章 · 故事第 40 天');
    assert.match(h.doc.querySelector('.tlp-meta').title, /右键改历法与起点/);
  });

  test('和「叙事线总览」各开各的：两个特殊标签', () => {
    const h = harness();
    h.open();
    h.respond();
    h.ui.clickEl(h.doc.querySelector('#projectBody .threads-overview-btn'));
    assert.deepEqual(
      [...h.doc.querySelectorAll('#edTabs .ed-tab-special')].map((t) => t.dataset.special),
      ['timeline-overview', 'threads-overview']
    );
    assert.equal(h.shown(), false, '切到叙事线总览，时间线总览藏起来');
    h.ui.clickEl(h.specialTab());
    assert.ok(h.shown());
  });
});

describe('时间线总览 · 竖轴与卡片', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('月份分隔带季节；一个日子一行；空了 2 天以上插「N 天后」（照上一行最晚的结尾：第 3 章到第 8 天，第 9 天不插）', () => {
    assert.deepEqual(h.axis(), [
      '大衍三年三月 · 春',
      '三月初七[1,2]',
      '5 天后',
      '三月十二[3,4]',
      '三月十五[5]',
      '31 天后',
      '大衍三年四月 · 夏',
      '四月十六[6]',
    ]);
    const day = h.doc.querySelector('.tlp-day');
    assert.equal(day.querySelector('.tlp-sub').textContent, '第 1 天');
    assert.equal(day.querySelector('.tlp-when').title, '大衍三年三月初七');
  });

  test('卡片：状态点、章号章名、时段与比上一章、依据；事件收着最多 3 条，线名小标签带色块；还有几条', () => {
    const c1 = h.card(1);
    assert.equal(c1.querySelector('.tlp-dot').textContent, '●');
    assert.equal(c1.querySelector('.tlp-card-title').textContent, '第 1 章 章1');
    assert.equal(c1.querySelector('.tlp-card-time').textContent, '傍晚 → 深夜');
    assert.equal(c1.querySelector('.tlp-card-note').textContent, '依据「连日大雨的第三天傍晚」');
    const events = [...c1.querySelectorAll('.tlp-event')];
    assert.deepEqual(
      events.map((e) => [e.querySelector('.tlp-chip').className, e.querySelector('.tlp-chip-name').textContent, e.querySelector('.tlp-event-what').textContent]),
      [
        ['tlp-chip tlp-c0', '青崖旧案', '回到青崖'],
        ['tlp-chip tlp-c2', '林昭与沈青', '关系：初遇'],
        ['tlp-chip tlp-c2', '林昭与沈青', '埋〈玉佩的来历〉：玉佩露面'],
      ]
    );
    assert.equal(c1.querySelector('.tlp-more').textContent, '还有 1 条，点开看');
    assert.equal(c1.querySelector('.tlp-quote'), null, '收着时不带原文');
    assert.equal(c1.querySelector('.tlp-detail'), null);
    // 第 2 章：推测、同一天；没事件给梗概。
    const c2 = h.card(2);
    assert.equal(c2.querySelector('.tlp-dot').textContent, '○');
    assert.equal(c2.querySelector('.tlp-card-time').textContent, '深夜 · 同一天');
    assert.equal(c2.querySelector('.tlp-synopsis').textContent, '客栈里来了个女人。');
  });

  test('对账报了：红边与红字；回忆：虚线框；推不出：状态点 ?', () => {
    const c3 = h.card(3);
    assert.ok(c3.classList.contains('has-issue'));
    assert.equal(c3.querySelector('.tlp-card-issue').textContent, '⚠ 前面推下来是三月初八，正文写三月十二（差 4 天），已按正文对齐');
    assert.ok(h.card(4).classList.contains('tlp-flashback'));
    assert.equal(h.card(4).querySelector('.tlp-dot').textContent, '↺');
    assert.equal(h.card(5).querySelector('.tlp-dot').textContent, '?');
  });

  test('单击卡片：展开详情与全部事件（带原文），选中；再点收起', () => {
    h.ui.clickEl(h.card(1).querySelector('.tlp-card-title'));
    const c1 = h.card(1);
    assert.ok(c1.classList.contains('is-open') && c1.classList.contains('is-selected'));
    assert.equal(c1.querySelectorAll('.tlp-event').length, 4);
    assert.equal(c1.querySelector('.tlp-more'), null);
    assert.deepEqual([...c1.querySelectorAll('.tlp-quote')].map((e) => e.textContent), ['「雨下了三天」', '「剑停在喉前三寸」', '「他摸了摸玉佩」', '「半截断剑」']);
    assert.equal(c1.querySelector('.tlp-detail').textContent, '第 1 章 · 详情');
    // 点另一张：它选中，第 1 张还展开着、不再选中。
    h.ui.clickEl(h.card(2));
    assert.ok(h.card(2).classList.contains('is-selected'));
    assert.ok(!h.card(1).classList.contains('is-selected') && h.card(1).classList.contains('is-open'));
    h.ui.clickEl(h.card(1));
    assert.ok(!h.card(1).classList.contains('is-open'));
  });

  test('右键卡片：改时间、重推这一章、从这一章起重推、打开正文 / 细纲 / 时间线文件；发的是工程页同一个动作', () => {
    const items = h.ui.itemsOf(h.ui.rightClick(h.card(3)));
    assert.deepEqual(items, ['改时间…', '重推这一章', '从这一章起重推（到第 8 章）', '打开这一章', '打开细纲', '打开时间线文件']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '改时间…');
    h.ui.pick(h.ui.rightClick(h.card(3)), '从这一章起重推（到第 8 章）');
    h.ui.pick(h.ui.rightClick(h.card(3)), '打开这一章');
    h.ui.pick(h.ui.rightClick(h.card(3)), '打开细纲');
    assert.deepEqual(h.sentAfter(n), [
      { type: 'projectAction', action: 'editTimeline', name: '3' },
      { type: 'projectAction', action: 'refreshTimeline', range: { from: 3, to: 8 } },
      { type: 'openChapter', plotRelPath: 'chapters/003.txt' },
      { type: 'openEditor', path: '.novelforge/summaries/003.md', pane: 'main' },
    ]);
    // 你定的那一行（不是机器写的）不给「重推这一章」。
    const mine = h.ui.itemsOf(h.ui.rightClick(h.card(6)));
    assert.ok(!mine.includes('重推这一章'), JSON.stringify(mine));
    h.ui.closeMenu();
  });

  test('右键标题栏：改历法与起点、补推、重推、打开时间线文件、刷新（设置都在这里，标题栏上没有按钮）', () => {
    const items = h.ui.itemsOf(h.ui.rightClick(h.doc.querySelector('.tlp-head')));
    assert.deepEqual(items, ['改历法与起点…', '从正文补推故事时间', '重推机器写的 4 行…', '打开时间线文件', '刷新']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '改历法与起点…');
    h.ui.pick(h.ui.rightClick(h.doc.querySelector('.tlp-scroll')), '从正文补推故事时间');
    assert.deepEqual(h.sentAfter(n), [
      { type: 'projectAction', action: 'setTimelineStart' },
      { type: 'projectAction', action: 'backfillTimeline' },
    ]);
    assert.deepEqual([...h.doc.querySelectorAll('.tlp-head button')].map((b) => b.textContent), ['刷新']);
  });

  test('没填起点有建议：那条 ⚠ 右键有「改历法与起点」「填为起点」', () => {
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(
      overview({
        calendar: { name: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章写了「三月初七」' } },
        issues: [{ text: '没填起点：第 2 章写了「三月初七」，第 1 章是三月初五（右键填为起点）', start: true }],
      })
    );
    const issue = h.doc.querySelector('.tlp-issue');
    const items = h.ui.itemsOf(h.ui.rightClick(issue));
    assert.deepEqual(items.slice(0, 2), ['改历法与起点…', '填为起点「三月初五」（第 2 章写了「三月初七」）']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '填为起点「三月初五」（第 2 章写了「三月初七」）');
    assert.deepEqual(h.sentAfter(n), [{ type: 'projectAction', action: 'setTimelineStart', name: '三月初五' }]);
  });

  test('对账一条一行；带章号的点了展开、选中那一章，不带的点了不动', () => {
    const rows = [...h.doc.querySelectorAll('.tlp-issue')];
    assert.deepEqual(rows.map((r) => r.textContent), [
      '⚠ 第 3 章：前面推下来是三月初八，正文写三月十二（差 4 天），已按正文对齐',
      '⚠ 第 7–8 章还没推：同步过，点标题旁的「补推时间」补上',
    ]);
    h.ui.clickEl(rows[0]);
    assert.ok(h.card(3).classList.contains('is-open') && h.card(3).classList.contains('is-selected'));
    assert.ok(!rows[1].classList.contains('is-link'));
  });
});

describe('时间线总览 · 筛选与定位', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  const setProblems = (on) => {
    const box = h.doc.querySelector('.tlp-filter input');
    box.checked = on;
    box.dispatchEvent(new h.window.Event('change'));
  };
  const setThread = (name) => {
    const select = h.doc.querySelector('.tlp-thread');
    select.value = name;
    select.dispatchEvent(new h.window.Event('change'));
  };

  test('「线」下拉：全部线 + 有事件的线', () => {
    assert.deepEqual([...h.doc.querySelectorAll('.tlp-thread option')].map((o) => o.textContent), ['全部线', '青崖旧案', '黑市', '林昭与沈青', '未归属的伏笔']);
  });

  test('只看有问题的：只留对账报了与推不出的章；「N 天后」照留下的重算', () => {
    setProblems(true);
    assert.deepEqual(h.cards(), [3, 5]);
    assert.deepEqual(h.axis(), ['大衍三年三月 · 春', '三月十二[3]', '三月十五[5]']);
    setProblems(false);
    assert.deepEqual(h.cards(), [1, 2, 3, 4, 5, 6]);
  });

  test('只看某条线：只留在那条线上有事的章；什么都不剩说一句', () => {
    setThread('黑市');
    assert.deepEqual(h.cards(), [6]);
    assert.deepEqual(h.axis(), ['大衍三年四月 · 夏', '四月十六[6]']);
    setProblems(true);
    assert.deepEqual(h.cards(), []);
    assert.equal(h.note(), '没有符合筛选的章。');
  });

  test('从工程页定位过来（带章号）：展开、选中；被筛选藏起来的放开筛选', () => {
    setThread('黑市');
    h.open(2);
    assert.deepEqual(h.cards(), [1, 2, 3, 4, 5, 6]);
    assert.equal(h.doc.querySelector('.tlp-thread').value, '');
    assert.ok(h.card(2).classList.contains('is-open') && h.card(2).classList.contains('is-selected'));
  });
});

describe('时间线总览 · 数据', { skip: JSDOM_SKIP }, () => {
  test('别人的 requestId 不认', () => {
    const h = harness();
    h.open();
    h.ui.post({ type: 'timelineOverview', requestId: 'timeline-not-mine', overview: overview() });
    assert.match(h.note(), /正在读取/);
  });

  test('显示着收到 state：停一下再要一次（连着两条只要一次）', () => {
    const h = harness({ shims: ['fakeTimers'] });
    h.open();
    h.respond();
    const n = h.count('requestTimelineOverview');
    h.ui.post({ type: 'state', state: viewState() });
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.count('requestTimelineOverview'), n);
    h.window.__clock.tick(700);
    assert.equal(h.count('requestTimelineOverview'), n + 1);
  });

  test('还不是小说工程、还没有一章（有要补推的说怎么补）各说一句', () => {
    const h = harness();
    h.open();
    h.respond({ ...overview(), initialized: false });
    assert.match(h.note(), /还不是小说工程/);
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(overview({ days: [], issues: [] }));
    assert.match(h.note(), /^时间线里还没有一章。第 7–8 章还没推出来：右键这里「从正文补推故事时间」/);
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(overview({ days: [], issues: [], missing: undefined, exists: false }));
    assert.equal(h.note(), '时间线里还没有一章。同步一章就会推它的故事时间。');
  });

  test('换工程：标签关掉', () => {
    const h = harness();
    h.open();
    h.respond();
    h.window.dispatchEvent(new h.window.Event('nf-workspace-reset'));
    assert.equal(h.specialTab(), null);
  });
});

describe('时间线总览 · 工程页入口', { skip: JSDOM_SKIP }, () => {
  const chapter = (no) => ({ no, title: `章${no}`, chapterPath: `chapters/00${no}.txt`, state: 'evidence', when: '三月初七', note: '', tip: '', value: '+0 天', machine: true });
  const withTimeline = (threads = {}) => {
    const tree = sampleTree();
    return {
      ...tree,
      threads: {
        ...tree.threads,
        ...threads,
        timeline: {
          relPath: TL,
          exists: true,
          label: '推到第 3 章 · 故事第 2 天',
          calendar: { text: '简单历 · 起点 三月初七（第 1 章那一天）', tip: '右键改历法与起点。', calendarName: '简单历', start: '三月初七' },
          issues: [{ text: '第 3 章：往回跳了', chapter: 3 }],
          segments: [{ key: 'timeline:三月', label: '三月', detail: '', chapters: [chapter(1), chapter(2), chapter(3)] }],
          machine: 3,
          last: 3,
        },
      },
    };
  };
  const tlGroup = (h) => h.doc.querySelector('#projectBody [data-group="timeline"]');
  const chapterLabel = (h, no) => tlGroup(h).querySelector(`.row-time-chapter[data-chapter="${no}"] .row-label`);

  test('「时间线」组标题旁「总览」打开时间线总览（不是叙事线总览）；组标题右键有「打开时间线总览」', () => {
    const h = harness({ tree: withTimeline() });
    const btn = tlGroup(h).querySelector('.timeline-overview-btn');
    assert.equal(btn?.textContent, '总览');
    h.ui.clickEl(btn);
    assert.ok(h.specialTab() && h.shown());
    assert.equal(h.doc.querySelector('#edTabs .ed-tab-special[data-special="threads-overview"]'), null);
    const items = h.ui.itemsOf(h.ui.rightClick(tlGroup(h).querySelector('.group-head')));
    assert.ok(items.includes('打开时间线总览'), JSON.stringify(items));
    h.ui.closeMenu();
  });

  test('点一章：打开时间线总览、展开选中那一章；不发 openFile（不开正文）', () => {
    const h = harness({ tree: withTimeline() });
    const n = h.ui.sent.length;
    h.ui.clickEl(chapterLabel(h, 2));
    assert.ok(!h.sentAfter(n).some((m) => m.type === 'openFile' || m.type === 'openEditor'), JSON.stringify(h.sentAfter(n)));
    assert.ok(h.shown());
    h.respond();
    assert.ok(h.card(2).classList.contains('is-open') && h.card(2).classList.contains('is-selected'));
  });

  test('点带章号的 ⚠：打开时间线总览、展开那一章', () => {
    const h = harness({ tree: withTimeline() });
    h.ui.clickEl(tlGroup(h).querySelector('.timeline-issue'));
    h.respond();
    assert.ok(h.card(3).classList.contains('is-open'));
  });

  test('叙事线组的「总览」只看有没有线与未归属的伏笔，不再因为有时间线才给', () => {
    const h = harness({ tree: withTimeline({ lines: [], unfiled: undefined }) });
    const threadsGroup = h.doc.querySelector('#projectBody [data-group="threads"]');
    assert.equal(threadsGroup.querySelector('.threads-overview-btn'), null);
    assert.ok(tlGroup(h).querySelector('.timeline-overview-btn'));
  });
});
