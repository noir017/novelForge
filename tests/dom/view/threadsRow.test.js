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
 * | 右键「标为收束…」「标为放弃…」发 closeThread / abandonThread（带线的文件）：进行中两样都有，计划中只有放弃，收束了的都没有 | 同步漏报了收束的线由作者补一笔（2026-10-24）；后端先问 |
 * | 当前进度作者改过的黄 ❗ 挂在那一行；排线失败的红 ❗ 挂在标题旁 | 失败留在出错的东西身上（第 16 条） |
 * | 标题旁「从大纲排出 / 从大纲补充」发 generateThreads、不折叠这一组；没有情节大纲不给 | 按钮不直接花钱，后端先弹确认框 |
 * | 一条线都没有时说清先做什么 | 空页签不该只剩一个标题 |
 * | 叙事线落后于定稿（四期）：最上面一句「⚠ 第 a–b 章还没判」；标题旁与右键「从正文补记」发 backfillThreads，补记在跑时不给 | 拆进来的书、补记停在半路的书一眼看出差多少、从哪补 |
 * | 时间线单独一组排在叙事线前面：对账、按月分段（最后一段展开）、一章一行；右键改时间与重推；标题旁补推、重推 | 2026-10-24 重做：作者要它独立成组，能改能重推 |
 * | 时间线组没有「历法与起点」那一行：在组标题的悬停里，改走右键（起点建议那条 ⚠ 右键「填为起点」）；插件形态点一章、点 ⚠ 打开时间线文件，不开正文 | 同日时间线总览：作者嫌点了就弹设置、点章开正文反人类（独立版打开时间线总览，见 tests/dom/standalone/timelineOverview.test.js） |
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

  test('右键「标为收束…」「标为放弃…」：进行中两样都有，计划中只有放弃，收束了的都没有', () => {
    const itemsOf = (name) => {
      const items = ui.itemsOf(ui.rightClick(rowOf(name)));
      ui.closeMenu();
      return items.filter((x) => x.startsWith('标为'));
    };
    assert.deepEqual(itemsOf('青崖旧案'), ['标为收束…', '标为放弃…']);
    assert.deepEqual(itemsOf('李叔的旧账'), ['标为放弃…']);
    assert.deepEqual(itemsOf('守卫的选择'), []);
    assert.deepEqual(itemsOf('未归属的伏笔'), []);
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('青崖旧案')), '标为收束…');
    assert.deepEqual(
      { action: ui.last('projectAction')?.action, relPath: ui.last('projectAction')?.relPath },
      { action: 'closeThread', relPath: '.novelforge/threads/青崖旧案.md' }
    );
    ui.pick(ui.rightClick(rowOf('李叔的旧账')), '标为放弃…');
    assert.equal(ui.last('projectAction')?.action, 'abandonThread');
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

  // 故事时间（2026-10-24；同日重做成叙事线页签里单独一组，设计稿 2026-10-24-story-timeline-rework.md「五」；同日时间线总览，
  // docs/design/plans/2026-10-24-timeline-page.md「二」）。这里是插件形态（只有 view.js，没有时间线总览）。
  describe('时间线一组', () => {
    const TL = '.novelforge/threads/时间线.md';
    const chapter = (no, patch = {}) => ({
      no,
      title: `第${no}章`,
      chapterPath: `chapters/0${no}.md`,
      state: 'evidence',
      when: `三月十${no} 清晨`,
      delta: '+1 天',
      note: '依据「次日」',
      tip: `第 ${no} 章 · 三月十${no} 清晨`,
      value: '+1 天',
      machine: true,
      ...patch,
    });
    const withTimeline = (patch = {}) => {
      const tree = sampleTree();
      return {
        ...tree,
        threads: {
          ...tree.threads,
          timeline: {
            relPath: TL,
            exists: true,
            label: '推到第 5 章 · 故事第 12 天（三月十八 夜里）',
            calendar: { text: '简单历 · 起点 三月初七（第 1 章那一天）', tip: '右键改历法与起点。', calendarName: '简单历', start: '三月初七' },
            issues: [{ text: '第 4 章：前面推下来是三月十一，正文写三月十四（差 3 天），已按正文对齐', chapter: 4 }],
            segments: [
              { key: 'timeline:二月', label: '二月', detail: '第 1–2 章 · 2 天', chapters: [chapter(1), chapter(2)] },
              { key: 'timeline:三月', label: '三月', detail: '第 3–5 章 · 4 天', chapters: [chapter(3), chapter(4, { state: 'dated', note: '正文写明三月十四', issue: true }), chapter(5, { state: 'unknown', machine: true })] },
            ],
            missing: { count: 2, text: '第 6–7 章还没推出来' },
            machine: 4,
            last: 7,
            ...patch,
          },
        },
      };
    };
    const groups = () => [...panel().querySelectorAll('.group')];
    const tlGroup = () => groups().find((g) => g.querySelector('.group-name')?.textContent === '时间线');
    const tlRows = () => [...tlGroup().querySelectorAll('.row, .timeline-issue')];
    const chapterRow = (no) => tlGroup().querySelector(`.row-time-chapter[data-chapter="${no}"]`);
    const headBtn = (cls) => tlGroup().querySelector(`.group-head .threads-head .${cls}`);

    test('单独一组，排在叙事线组前面；叙事线组里没有时间线那一行；组标题后面是推到哪、故事第几天', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.deepEqual(groups().map((g) => g.querySelector('.group-name').textContent), ['时间线', '叙事线']);
      assert.ok(!labels().includes('时间线'));
      assert.match(tlGroup().querySelector('.group-head').textContent, /推到第 5 章 · 故事第 12 天（三月十八 夜里）/);
    });

    test('没有「历法与起点」那一行：在组标题的悬停里；组标题右键「改历法与起点…」；起点建议那条 ⚠ 右键「填为起点」带上那一天', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(tlGroup().querySelector('.row-timeline-calendar'), null);
      assert.ok(!tlRows().some((r) => r.textContent.includes('第 1 章那一天')));
      assert.equal(tlGroup().querySelector('.group-toggle').title, '简单历 · 起点 三月初七（第 1 章那一天）\n右键改历法与起点。');
      ui.sent.length = 0;
      ui.pick(ui.rightClick(tlGroup().querySelector('.group-head')), '改历法与起点…');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['setTimelineStart', undefined]);
      const tree = withTimeline({
        calendar: { text: '简单历 · 没填起点，只显示第几天', tip: '', calendarName: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章写了「三月初七」' } },
        issues: [{ text: '没填起点：第 2 章写了「三月初七」，第 1 章是三月初五（右键填为起点）', start: true }],
      });
      ui.post({ type: 'project', tree });
      ui.sent.length = 0;
      const issue = tlGroup().querySelector('.timeline-issue');
      ui.pick(ui.rightClick(issue), '填为起点「三月初五」（第 2 章写了「三月初七」）');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['setTimelineStart', '三月初五']);
      // 组标题右键也有。
      const items = ui.itemsOf(ui.rightClick(tlGroup().querySelector('.group-head')));
      assert.ok(items.includes('填为起点「三月初五」（第 2 章写了「三月初七」）'), JSON.stringify(items));
      ui.closeMenu();
    });

    test('对账一条一行（⚠），点了打开时间线文件（插件形态没有时间线总览）；章行上对账报了的另挂一格 ⚠', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const issue = tlGroup().querySelector('.timeline-issue');
      assert.equal(issue.textContent, '⚠ 第 4 章：前面推下来是三月十一，正文写三月十四（差 3 天），已按正文对齐');
      ui.sent.length = 0;
      ui.clickEl(issue);
      assert.equal(ui.last('openFile')?.path, TL);
      assert.deepEqual(warningsOf(chapterRow(4)), ['⚠ 对不上']);
    });

    test('按段画：最后一段默认展开、其余收起；点段头折起、展开', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const heads = () => [...tlGroup().querySelectorAll('.row-timeline-segment')];
      assert.deepEqual(heads().map((h) => h.textContent), ['▸二月第 1–2 章 · 2 天', '▾三月第 3–5 章 · 4 天']);
      assert.equal(chapterRow(1), null);
      assert.ok(chapterRow(3));
      ui.clickEl(heads()[0]);
      assert.ok(chapterRow(1));
      ui.clickEl(heads()[1]);
      assert.equal(chapterRow(3), null);
      // 重推树不把作者的折叠换掉。
      ui.post({ type: 'project', tree: withTimeline() });
      assert.ok(chapterRow(1));
      assert.equal(chapterRow(3), null);
      ui.clickEl(heads()[0]);
      ui.clickEl(heads()[1]);
    });

    test('一章一行：状态点、章号章名、那一天 · 比上一章 · 依据；点了打开时间线文件，不开正文（打开正文在右键）', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const row = chapterRow(4);
      assert.equal(row.querySelector('.dot').textContent, '◆');
      assert.equal(chapterRow(5).querySelector('.dot').textContent, '?');
      assert.equal(row.querySelector('.row-label').textContent, '第 4 章 第4章');
      assert.equal(row.querySelector('.row-detail').textContent, '三月十4 清晨 · +1 天 · 正文写明三月十四');
      ui.sent.length = 0;
      ui.clickEl(row.querySelector('.row-label'));
      assert.equal(ui.last('openFile')?.path, TL);
      ui.pick(ui.rightClick(row), '打开这一章');
      assert.equal(ui.last('openFile')?.path, 'chapters/04.md');
    });

    test('右键一章：改时间（带章号）、重推这一章、从这一章起重推（到最后一章）', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      ui.sent.length = 0;
      ui.pick(ui.rightClick(chapterRow(4)), '改时间…');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['editTimeline', '4']);
      ui.pick(ui.rightClick(chapterRow(4)), '重推这一章');
      assert.deepEqual({ ...ui.last('projectAction')?.range }, { from: 4, to: 4 });
      ui.pick(ui.rightClick(chapterRow(4)), '从这一章起重推（到第 7 章）');
      assert.deepEqual([ui.last('projectAction')?.action, { ...ui.last('projectAction')?.range }], ['refreshTimeline', { from: 4, to: 7 }]);
      // 你定的那一行：不给「重推这一章」（机器不动它）。
      ui.post({ type: 'project', tree: withTimeline({ segments: [{ key: 'timeline:三月', label: '三月', detail: '', chapters: [chapter(3, { state: 'anchor', machine: false })] }] }) });
      const items = ui.itemsOf(ui.rightClick(chapterRow(3)));
      assert.ok(items.includes('改时间…') && !items.includes('重推这一章'), JSON.stringify(items));
      ui.closeMenu();
    });

    test('标题旁「补推时间」「重推」：发 backfillTimeline / refreshTimeline（全部）、不折叠这一组；有一样在跑时两样都不给', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(headBtn('threads-time-btn')?.textContent, '补推时间');
      assert.equal(headBtn('threads-refresh-btn')?.textContent, '重推');
      ui.sent.length = 0;
      ui.clickEl(headBtn('threads-time-btn'));
      assert.equal(ui.last('projectAction')?.action, 'backfillTimeline', JSON.stringify(ui.sent));
      ui.clickEl(headBtn('threads-refresh-btn'));
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.range], ['refreshTimeline', undefined]);
      assert.ok(chapterRow(3), '点按钮把组折起来了');
      ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '重推故事时间', message: '第 1–5 章', current: 0, total: 2, elapsedMs: 0 }] });
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(headBtn('threads-time-btn'), null);
      assert.equal(headBtn('threads-refresh-btn'), null);
      ui.post({ type: 'tasks', tasks: [] });
    });

    test('没有要补推、没有机器写的行：两颗都不给；补推失败的红 ❗ 挂在组标题旁', () => {
      const tree = withTimeline({ missing: undefined, machine: 0 });
      tree.failures = { [TL]: [{ at: '2026-10-24T00:00:00Z', severity: 'error', op: 'timelineBackfill', message: '补推停在第 6 章' }] };
      ui.post({ type: 'project', tree });
      assert.equal(headBtn('threads-time-btn'), null);
      assert.equal(headBtn('threads-refresh-btn'), null);
      assert.ok(tlGroup().querySelector('.group-head .row-failure.is-error'));
    });

    test('没有时间线：整组不画', () => {
      ui.post({ type: 'project', tree: sampleTree() });
      assert.equal(tlGroup(), undefined);
    });
  });

  test('「故事架构」组标题仍是 x/6', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const head = [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '故事架构');
    assert.match(head.querySelector('.group-head').textContent, /5\/6/);
  });
});
