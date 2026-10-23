/**
 * 工程页「叙事线」页签（叙事线重做第 8 个提交）：一条线一行，最后一行是「未归属的伏笔」。一行的说法由后端给
 * （`views/threads.ts`，后端那一半在 tests/unit/views/threads.test.js），这里钉前端怎么摆、怎么点。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 第五个页签，排在「设定」后面；「文风与摘要」里那一行计数没了 | 章节、角色、设定各占一页，叙事线同一个思路 |
 * | 一条线一行，照后端排好的顺序；名字 · 种类 · 状态 · 最近第 N 章 · 几条伏笔没收，⚠ 另起一格 | 一眼看出各条线走到哪、哪条要管 |
 * | 最后一行是「未归属的伏笔 · N 条」；没有就不画 | 挂不上线的伏笔有个地方看 |
 * | 点一行打开那条线的文件，右键「打开」，没有删除 / 改名 | 一条线就是一份 Markdown，作者直接改 |
 * | 当前进度作者改过的黄 ❗ 挂在那一行；排线失败的红 ❗ 挂在标题旁 | 失败留在出错的东西身上（第 16 条） |
 * | 标题旁「从大纲排出 / 从大纲补充」发 generateThreads、不折叠这一组；没有情节大纲不给 | 按钮不直接花钱，后端先弹确认框 |
 * | 一条线都没有时说清先做什么 | 空页签不该只剩一个标题 |
 * | 叙事线落后于定稿（四期）：最上面一句「⚠ 第 a–b 章还没判」；标题旁与右键「从正文补记」发 backfillThreads，补记在跑时不给 | 拆进来的书、补记停在半路的书一眼看出差多少、从哪补 |
 * | 「故事架构」组仍是 x/6 | 叙事线是可选的，不挡路 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('工程页 · 叙事线页签', { skip: JSDOM_SKIP }, () => {
  let ui;
  const panel = () => ui.doc.querySelector('#projectBody [data-project-panel="threads"]');
  const group = () => panel().querySelector('.group');
  const rows = () => [...panel().querySelectorAll('.row')];
  const rowOf = (name) => rows().find((n) => n.querySelector('.row-label')?.textContent === name);
  const labels = () => rows().map((n) => n.querySelector('.row-label').textContent);
  const headBtn = () => group().querySelector('.group-head .threads-head button');
  const warningsOf = (row) => [...row.querySelectorAll('.thread-warn')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('第五个页签「叙事线」，排在「设定」后面；页里只有「叙事线」一组', () => {
    const tabs = [...ui.doc.querySelectorAll('#projectTabs [data-project-tab]')].map((b) => b.textContent);
    assert.deepEqual(tabs, ['概览', '章节', '角色', '设定', '叙事线']);
    assert.deepEqual([...panel().querySelectorAll('.group-name')].map((n) => n.textContent), ['叙事线']);
  });

  test('「文风与摘要」里不再有叙事线那一行', () => {
    const overview = ui.doc.querySelector('#projectBody [data-project-panel="overview"]');
    const meta = [...overview.querySelectorAll('.group')].find((g) => g.querySelector('.group-name')?.textContent === '文风与摘要');
    assert.ok(![...meta.querySelectorAll('.row-label')].some((n) => n.textContent === '叙事线'));
  });

  test('一条线一行，照后端排好的顺序；最后一行是「未归属的伏笔」', () => {
    assert.deepEqual(labels(), ['青崖旧案', '林昭与沈氏', '李叔的旧账', '守卫的选择', '未归属的伏笔']);
  });

  test('一行：种类 · 状态 · 最近第 N 章 · 几条伏笔没收', () => {
    const row = rowOf('青崖旧案');
    assert.equal(row.querySelector('.row-detail').textContent, '主线 · 进行中 · 最近第 3 章 · 1 条伏笔没收');
    assert.deepEqual(warningsOf(row), []);
    assert.equal(row.querySelector('.dot').textContent, '●');
  });

  test('有问题的另起几格 ⚠', () => {
    assert.deepEqual(warningsOf(rowOf('林昭与沈氏')), ['⚠ 1 条伏笔逾期', '⚠ 过了计划收束的第 2 章']);
  });

  test('还没推进过的写计划区间、空心点；收束了的打勾、压暗', () => {
    assert.equal(rowOf('李叔的旧账').querySelector('.row-detail').textContent, '支线 · 计划中 · 计划第 6–12 章');
    assert.equal(rowOf('李叔的旧账').querySelector('.dot').textContent, '○');
    assert.equal(rowOf('守卫的选择').querySelector('.dot').textContent, '✓');
    assert.ok(rowOf('守卫的选择').classList.contains('row-thread-closed'));
    assert.ok(!rowOf('青崖旧案').classList.contains('row-thread-closed'));
  });

  test('「未归属的伏笔 · 2 条」', () => {
    assert.equal(rowOf('未归属的伏笔').querySelector('.row-detail').textContent, '2 条');
  });

  test('悬停名字看意图与当前进度', () => {
    const title = rowOf('青崖旧案').querySelector('.row-label').title;
    assert.ok(title.includes('意图：查清七年前那场火') && title.includes('.novelforge/threads/青崖旧案.md'), title);
  });

  test('点一行打开那条线的文件', () => {
    ui.sent.length = 0;
    ui.clickEl(rowOf('林昭与沈氏').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/林昭与沈氏.md', JSON.stringify(ui.sent));
    ui.clickEl(rowOf('未归属的伏笔').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/未归属的伏笔.md', JSON.stringify(ui.sent));
  });

  test('右键「打开」，没有删除 / 改名 / 移动', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('青崖旧案')));
    assert.ok(items.includes('打开'), JSON.stringify(items));
    assert.ok(!items.some((x) => /删除|重命名|移动/.test(x)), JSON.stringify(items));
    ui.closeMenu();
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('青崖旧案')), '打开');
    assert.equal(ui.last('openFile')?.path, '.novelforge/threads/青崖旧案.md', JSON.stringify(ui.sent));
  });

  test('组标题：几条 · 几条进行中', () => {
    assert.equal(group().querySelector('.group-head .meta').textContent, '4 条 · 2 条进行中');
  });

  test('标题旁「从大纲补充」发 generateThreads，不折叠这一组', () => {
    assert.equal(headBtn()?.textContent, '从大纲补充');
    ui.sent.length = 0;
    ui.clickEl(headBtn());
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    assert.equal(labels().length, 5, '点按钮把组折起来了');
  });

  test('标题与页里空白处右键「从大纲补充叙事线」', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(group().querySelector('.group-head')), '从大纲补充叙事线');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    ui.sent.length = 0;
    ui.pick(ui.rightClick(panel()), '从大纲补充叙事线');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
  });

  test('当前进度作者改过的黄 ❗ 挂在那一行；排线失败的红 ❗ 挂在标题旁', () => {
    const tree = sampleTree();
    tree.failures = {
      '.novelforge/threads/林昭与沈氏.md': [
        { at: '2026-10-20T00:00:00Z', severity: 'warn', op: 'threadProgress', message: '第 3 章给出了新的「当前进度」，这一节你改过，没有覆盖' },
      ],
      '.novelforge/threads': [{ at: '2026-10-20T00:00:00Z', severity: 'error', op: 'threads', message: '排叙事线失败：超时' }],
    };
    ui.post({ type: 'project', tree });
    assert.ok(rowOf('林昭与沈氏').querySelector('.row-failure.is-warn'));
    assert.equal(rowOf('青崖旧案').querySelector('.row-failure'), null);
    const mark = group().querySelector('.group-head .threads-head .row-failure.is-error');
    assert.ok(mark, group().querySelector('.group-head').outerHTML);
    assert.equal(mark.dataset.failureKey, '.novelforge/threads');
  });

  test('一条线都没有：「从大纲排出」，空行说清点哪里；没有「未归属的伏笔」就不画', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), threads: { lines: [], current: 0 } } });
    assert.equal(headBtn()?.textContent, '从大纲排出');
    assert.equal(group().querySelector('.group-head .meta').textContent, '还没有');
    assert.deepEqual(labels(), []);
    assert.match(panel().querySelector('.row-empty').textContent, /点标题旁的「从大纲排出」/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(items.includes('从大纲排出叙事线'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('还没有情节大纲：不给按钮，空行说清先排大纲；右键也没有排线', () => {
    const tree = sampleTree();
    ui.post({
      type: 'project',
      tree: {
        ...tree,
        architecture: tree.architecture.map((a) => (a.key === 'outline' ? { ...a, filled: false } : a)),
        threads: { lines: [], current: 0 },
      },
    });
    assert.equal(headBtn(), null);
    assert.match(panel().querySelector('.row-empty').textContent, /先排出情节大纲/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(!items.some((x) => x.includes('叙事线')), JSON.stringify(items));
    ui.closeMenu();
  });

  // 四期：定稿了、叙事线还没判的章。
  describe('叙事线落后于定稿', () => {
    const lagged = () => {
      const tree = sampleTree();
      return { ...tree, threads: { ...tree.threads, current: 60, through: 30, lag: { count: 30, text: '第 31–60 章还没判' } } };
    };
    const backfillBtn = () => group().querySelector('.group-head .threads-head .threads-backfill-btn');

    test('页里最上面一句「⚠ 第 31–60 章还没判」，说清状态按判到的那一章算；线照样一条一行', () => {
      ui.post({ type: 'project', tree: lagged() });
      const lag = panel().querySelector('.threads-lag');
      assert.ok(lag, panel().innerHTML.slice(0, 500));
      assert.match(lag.textContent, /^⚠ 第 31–60 章还没判：这几章同步了，叙事线还没记上。线断了几章、伏笔逾期都按判到的第 30 章算/);
      assert.ok(lag.textContent.includes('「从正文补记」'), lag.textContent);
      assert.equal(panel().querySelector('.group-body').firstElementChild, lag);
      assert.equal(labels().length, 5);
    });

    test('标题旁「从正文补记」发 backfillThreads，排在「从大纲补充」前面、不折叠这一组；右键标题与空白处也有', () => {
      ui.post({ type: 'project', tree: lagged() });
      assert.equal(backfillBtn()?.textContent, '从正文补记');
      assert.equal(headBtn(), backfillBtn());
      ui.sent.length = 0;
      ui.clickEl(backfillBtn());
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
      assert.equal(labels().length, 5, '点按钮把组折起来了');
      ui.sent.length = 0;
      ui.pick(ui.rightClick(group().querySelector('.group-head')), '从已写正文补记叙事线');
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
      ui.sent.length = 0;
      ui.pick(ui.rightClick(panel()), '从已写正文补记叙事线');
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
    });

    test('补记在跑：不给按钮（点第二次只会撞上已有任务）', () => {
      ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '从已写正文补记叙事线', message: '第 31 章', current: 0, total: 30, elapsedMs: 0 }] });
      ui.post({ type: 'project', tree: lagged() });
      assert.equal(backfillBtn(), null);
      ui.post({ type: 'tasks', tasks: [] });
    });

    test('不落后：没有那一句，也没有「从正文补记」', () => {
      ui.post({ type: 'project', tree: sampleTree() });
      assert.equal(panel().querySelector('.threads-lag'), null);
      assert.equal(backfillBtn(), null);
      const items = ui.itemsOf(ui.rightClick(panel()));
      assert.ok(!items.includes('从已写正文补记叙事线'), JSON.stringify(items));
      ui.closeMenu();
    });
  });

  // 故事时间（2026-10-24）：「时间线」一行排在各条线前面。
  describe('时间线', () => {
    const TL = '.novelforge/threads/时间线.md';
    const withTimeline = (patch = {}) => {
      const tree = sampleTree();
      return {
        ...tree,
        threads: {
          ...tree.threads,
          timeline: {
            relPath: TL,
            exists: true,
            detail: '推到第 30 章 · 现在：三月十四 傍晚 · 过了 46 天',
            warnings: ['2 章推不出', '第 31–40 章还没推'],
            tip: '历法：简单历\n起点：三月初七（第 1 天）',
            missing: { count: 10, text: '第 31–40 章还没推' },
            ...patch,
          },
        },
      };
    };
    const timeBtn = () => group().querySelector('.group-head .threads-head .threads-time-btn');

    test('排在各条线前面：推到第几章、现在是哪天、过了多久，⚠ 另起几格', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.deepEqual(labels(), ['时间线', '青崖旧案', '林昭与沈氏', '李叔的旧账', '守卫的选择', '未归属的伏笔']);
      const row = rowOf('时间线');
      assert.equal(row.querySelector('.dot').textContent, '◷');
      assert.equal(row.querySelector('.row-detail').textContent, '推到第 30 章 · 现在：三月十四 傍晚 · 过了 46 天');
      assert.deepEqual(warningsOf(row), ['⚠ 2 章推不出', '⚠ 第 31–40 章还没推']);
      assert.ok(row.querySelector('.row-label').title.includes('起点：三月初七'), row.querySelector('.row-label').title);
    });

    test('点名字打开时间线文件；右键：打开、补推', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      ui.sent.length = 0;
      ui.clickEl(rowOf('时间线').querySelector('.row-label'));
      assert.equal(ui.last('openFile')?.path, TL, JSON.stringify(ui.sent));
      const items = ui.itemsOf(ui.rightClick(rowOf('时间线')));
      assert.ok(items.includes('打开') && items.includes('从正文补推故事时间'), JSON.stringify(items));
      ui.closeMenu();
      ui.sent.length = 0;
      ui.pick(ui.rightClick(rowOf('时间线')), '从正文补推故事时间');
      assert.equal(ui.last('projectAction')?.action, 'backfillTimeline', JSON.stringify(ui.sent));
    });

    test('标题旁「补推时间」发 backfillTimeline、不折叠这一组；标题右键也有；补推在跑时不给', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(timeBtn()?.textContent, '补推时间');
      ui.sent.length = 0;
      ui.clickEl(timeBtn());
      assert.equal(ui.last('projectAction')?.action, 'backfillTimeline', JSON.stringify(ui.sent));
      assert.equal(labels().length, 6, '点按钮把组折起来了');
      ui.sent.length = 0;
      ui.pick(ui.rightClick(group().querySelector('.group-head')), '从正文补推故事时间');
      assert.equal(ui.last('projectAction')?.action, 'backfillTimeline', JSON.stringify(ui.sent));
      ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '从正文补推故事时间', message: '第 31 章', current: 0, total: 2, elapsedMs: 0 }] });
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(timeBtn(), null);
      ui.post({ type: 'tasks', tasks: [] });
    });

    test('没有要补推的：不给「补推时间」；补推失败的红 ❗ 挂在这一行', () => {
      const tree = withTimeline({ missing: undefined, warnings: [] });
      tree.failures = { [TL]: [{ at: '2026-10-24T00:00:00Z', severity: 'error', op: 'timelineBackfill', message: '补推停在第 31 章' }] };
      ui.post({ type: 'project', tree });
      assert.equal(timeBtn(), null);
      assert.ok(rowOf('时间线').querySelector('.row-failure.is-error'));
      const items = ui.itemsOf(ui.rightClick(rowOf('时间线')));
      assert.ok(!items.includes('从正文补推故事时间'), JSON.stringify(items));
      ui.closeMenu();
    });

    test('还没有时间线文件（只有要补推的）：点名字不打开，右键没有「打开」', () => {
      ui.post({ type: 'project', tree: withTimeline({ exists: false, detail: '还没有一章' }) });
      ui.sent.length = 0;
      ui.clickEl(rowOf('时间线').querySelector('.row-label'));
      assert.equal(ui.last('openFile'), undefined);
      const items = ui.itemsOf(ui.rightClick(rowOf('时间线')));
      assert.ok(!items.includes('打开') && items.includes('从正文补推故事时间'), JSON.stringify(items));
      ui.closeMenu();
    });
  });

  test('「故事架构」组标题仍是 x/6', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const head = [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '故事架构');
    assert.match(head.querySelector('.group-head').textContent, /5\/6/);
  });
});
