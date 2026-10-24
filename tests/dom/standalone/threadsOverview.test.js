/**
 * 编辑区「叙事线总览」标签（`media/src/editor/threadsOverview.ts`，叙事线重做三期）与它的两个入口（工程页「叙事线」页签标题旁
 * 的「总览」、行右键「在总览里看」）。矩阵由后端推来（`threadsOverview`），这里按消息造；后端怎么算在
 * tests/unit/views/threadsOverview.test.js 与 tests/integration/views/threadsOverview.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 能力探测 | 插件的 webview 只有 view.js：「总览」「在总览里看」「打开叙事线总览」都不画；独立版有；一条线都没有不给 |
 * | 标签 | 标签条上一个不对应文件的特殊标签（排在文件前面）；切到文件就藏起覆盖层、切回来再露出来；× / Ctrl+W 关掉回到原来那份文件；「▾」里也有它 |
 * | 矩阵 | 列头的章号、卷名、定稿状态，「定稿到第 N 章」那条竖线；按种类分组、线下面是伏笔、最后是「未归属的伏笔」 |
 * | 叙事线判到哪（四期） | 落后于定稿时头上说判到第几章、另一条虚竖线；定稿了还没判的列头另标，悬停说这一章的计划不算偏差 |
 * | 四种格子 | ○ 只有计划、● 只有实际、◉ 计划也发生了、红圈偏差；计划区间一条淡底 |
 * | 伏笔连线 | 收了的实线、埋了没收的虚线（逾期标红）、还没埋的淡虚线；回收章一道竖线；埋 ● 收 ◆ 弃 ✕，计划的空心 |
 * | 点击 | 点格子 / 列头发 `openChapter`（有正文给正文路径，只有细纲给细纲路径，都没有说一句不发）；点线名、伏笔名、「未归属的伏笔」发 `openEditor` |
 * | 悬停 | 那一格的计划与实际事件、证据、偏差说一句 |
 * | 定位 | 右键「在总览里看」打开并标出那一行 |
 * | 数据 | 按需要（requestId）；别人的 requestId 不认；显示着收到 `state` 停一下再要；藏着时不要，切回来再要 |
 * | 刷新恢复 | 记着、恢复时先开总览，陆续回来的文件不把它换下去；记坏了的不认、不崩；没在显示的恢复成背景标签 |
 * | 换工程 | 标签关掉 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState, sampleTree } = require('../../helpers/dom');

const T = (name) => `.novelforge/threads/${name}.md`;
const UNFILED = T('未归属的伏笔');
const STORE_KEY = 'novelforge.editor.v1';

const ev = (type, what, evidence, foreshadowing) => ({
  type,
  ...(foreshadowing ? { foreshadowing } : {}),
  what,
  ...(evidence ? { evidence } : {}),
});
const cell = (chapter, planned, actual, deviation = false) => ({ chapter, planned, actual, deviation });

/**
 * 一份矩阵：第 1–3 章定稿了（根下）、第 4 章写了没定稿、第 5 章只有细纲、第 6 章什么都没有（第二卷）；「现在」第 3 章。
 * 主线一条（四种格子各一格）、感情线一条（两条伏笔：收了的、计划埋却没埋的）；「未归属的伏笔」两条（逾期的、弃了的）。
 */
function overview(extra = {}) {
  const ch = (no, state, title, volume, paths) => ({ no, title, volume, state, ...paths });
  return {
    initialized: true,
    current: 3,
    through: 3,
    volumes: true,
    chapters: [
      ch(1, 'finalized', '楔子', '', { chapterPath: 'chapters/001-楔子.md', plotPath: '.novelforge/summaries/001-楔子.md' }),
      ch(2, 'finalized', '入镇', '', { chapterPath: 'chapters/002-入镇.md', plotPath: '.novelforge/summaries/002-入镇.md' }),
      ch(3, 'finalized', '夜访', '', { chapterPath: 'chapters/003-夜访.md', plotPath: '.novelforge/summaries/003-夜访.md' }),
      ch(4, 'written', '北行', '第二卷', { chapterPath: 'chapters/第二卷/004-北行.md' }),
      ch(5, 'planned', '赤星', '第二卷', { plotPath: '.novelforge/summaries/第二卷/005-赤星.md' }),
      ch(6, 'none', '', '第二卷', {}),
    ],
    groups: [
      {
        kind: '主线',
        lines: [
          {
            name: '青崖旧案',
            relPath: T('青崖旧案'),
            kind: '主线',
            status: '进行中',
            from: 1,
            to: 6,
            detail: '主线 · 进行中 · 最近第 3 章',
            warnings: [],
            tip: '意图：查清七年前那场火',
            cells: [
              cell(1, [], [ev('推进', '回到青崖', '雨下了三天')]),
              cell(2, [ev('推进', '打听名册')], [], true),
              cell(3, [ev('推进', '找到空匣')], [ev('推进', '夜访旧宅，找到空匣', '匣子是空的')]),
              cell(5, [ev('推进', '北上')], []),
            ],
            foreshadowing: [],
          },
        ],
      },
      {
        kind: '感情线',
        lines: [
          {
            name: '林昭与沈氏',
            relPath: T('林昭与沈氏'),
            kind: '感情线',
            status: '进行中',
            detail: '感情线 · 进行中 · 最近第 3 章 · 1 条伏笔没收',
            warnings: ['1 条伏笔逾期'],
            tip: '',
            cells: [cell(2, [], [ev('关系', '猜忌 → 结盟', '你的仇就是我的仇')])],
            foreshadowing: [
              {
                name: '玉佩的来历',
                what: '林昭的玉佩是沈家旧物',
                status: '已收',
                plant: 1,
                resolve: 3,
                plantedAt: 1,
                closedAt: 3,
                overdue: false,
                span: { from: 1, to: 3, kind: 'done' },
                tip: '林昭的玉佩是沈家旧物\n计划第 1 章埋、第 3 章前收\n第 3 章收了',
                cells: [
                  cell(1, [], [ev('埋', '玉佩露面', '他摸了摸怀里的玉佩', '玉佩的来历')]),
                  cell(3, [ev('收', '认出云纹', undefined, '玉佩的来历')], [ev('收', '认出云纹', '这是沈家的云纹', '玉佩的来历')]),
                ],
              },
              {
                name: '沈氏的旧伤',
                what: '左臂的刀疤',
                status: '计划',
                plant: 2,
                resolve: 6,
                overdue: false,
                span: { from: 2, to: 6, kind: 'planned' },
                tip: '左臂的刀疤\n计划第 2 章埋、第 6 章前收\n还没埋',
                cells: [cell(2, [ev('埋', '换药时露出刀疤', undefined, '沈氏的旧伤')], [], true)],
              },
            ],
          },
        ],
      },
    ],
    unfiled: {
      relPath: UNFILED,
      foreshadowing: [
        {
          name: '断剑',
          what: '剑上刻着青崖二字',
          status: '已埋',
          resolve: 2,
          plantedAt: 1,
          overdue: true,
          span: { from: 1, to: 3, kind: 'open' },
          tip: '剑上刻着青崖二字\n第 2 章前收\n第 1 章埋下，还没收，过了第 2 章（逾期）',
          cells: [cell(1, [], [ev('埋', '断剑出土', '半截断剑', '断剑')])],
        },
        {
          name: '火折子',
          what: '',
          status: '已弃',
          closedAt: 2,
          overdue: false,
          tip: '第 2 章弃了',
          cells: [cell(2, [], [ev('弃', '扔进河里', '扑通一声', '火折子')])],
        },
      ],
    },
    ...extra,
  };
}

/** 独立版：view.js + editor.js，推一条 state 与工程树。 */
function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['scrollIntoView', 'clipboard', ...(opts.shims ?? [])], ...opts });
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
    threadsPanel: () => doc.querySelector('#projectBody [data-project-panel="threads"]'),
    overviewBtn: () => doc.querySelector('#projectBody .threads-overview-btn'),
    projectRow: (name) => [...doc.querySelectorAll('#projectBody .row-thread')].find((r) => r.querySelector('.row-label')?.textContent === name),
    specialTab: () => doc.querySelector('#edTabs .ed-tab-special'),
    tabs: () => [...doc.querySelectorAll('#edTabs .ed-tab')].map((t) => t.querySelector('.ed-tab-name').textContent),
    activeTab: () => doc.querySelector('#edTabs .ed-tab.active .ed-tab-name')?.textContent,
    tov: () => doc.querySelector('.wb-editor .ed-stage .tov'),
    shown: () => !!h.tov() && !h.tov().classList.contains('hidden'),
    note: () => {
      const n = doc.querySelector('.tov .tov-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    row: (path) => doc.querySelector(`.tov-row[data-path="${path}"]`),
    foreRow: (name) => [...doc.querySelectorAll('.tov-row-fore')].find((r) => r.querySelector('.tov-link')?.textContent === name),
    cellOf: (row, no) => row.querySelector(`.tov-cell[data-ch="${no}"]`),
    open() {
      ui.clickEl(h.overviewBtn());
    },
    respond(o = overview()) {
      const req = ui.last('requestThreadsOverview');
      assert.ok(req, '没发 requestThreadsOverview');
      ui.post({ type: 'threadsOverview', requestId: req.requestId, overview: o });
    },
    openFile(path) {
      ui.post({ type: 'editorOpen', file: file(path, `${path} 的内容`) });
    },
    count: (type) => ui.sent.filter((m) => m.type === type).length,
    sentAfter: (n) => JSON.parse(JSON.stringify(ui.sent.slice(n))),
  };
  return h;
}

describe('叙事线总览 · 能力探测（VS Code 插件没有内置编辑器）', { skip: JSDOM_SKIP }, () => {
  test('插件的 webview（只有 view.js）：标题旁没有「总览」，右键没有「在总览里看」「打开叙事线总览」', () => {
    const ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    const panel = ui.doc.querySelector('#projectBody [data-project-panel="threads"]');
    assert.ok(panel.querySelector('.threads-head'), '标题旁那一截还在（「从大纲补充」）');
    assert.equal(panel.querySelector('.threads-overview-btn'), null);
    assert.ok(![...panel.querySelectorAll('.threads-head button')].some((b) => b.textContent === '总览'));
    const row = [...panel.querySelectorAll('.row-thread')].find((r) => r.textContent.includes('青崖旧案'));
    const items = ui.itemsOf(ui.rightClick(row));
    assert.ok(items.includes('打开') && !items.includes('在总览里看'), JSON.stringify(items));
    ui.closeMenu();
    const groupItems = ui.itemsOf(ui.rightClick(panel.querySelector('.group-head')));
    assert.ok(!groupItems.includes('打开叙事线总览'), JSON.stringify(groupItems));
    ui.closeMenu();
  });

  test('独立版：标题旁有「总览」，行右键有「在总览里看」，组标题右键有「打开叙事线总览」', () => {
    const h = harness();
    assert.equal(h.overviewBtn()?.textContent, '总览');
    const items = h.ui.itemsOf(h.ui.rightClick(h.projectRow('青崖旧案')));
    assert.deepEqual(items.slice(0, 2), ['打开', '在总览里看']);
    h.ui.closeMenu();
    const unfiled = h.ui.itemsOf(h.ui.rightClick(h.projectRow('未归属的伏笔')));
    assert.ok(unfiled.includes('在总览里看'), JSON.stringify(unfiled));
    h.ui.closeMenu();
    const group = h.ui.itemsOf(h.ui.rightClick(h.threadsPanel().querySelector('.group-head')));
    assert.ok(group.includes('打开叙事线总览'), JSON.stringify(group));
    h.ui.closeMenu();
  });

  test('一条线、一条未归属的伏笔都没有：不给「总览」（打开了也是空的）', () => {
    const h = harness({ tree: { ...sampleTree(), threads: { lines: [], current: 0, watch: { lines: [], foreshadowing: [] } } } });
    assert.equal(h.overviewBtn(), null);
    assert.ok(h.threadsPanel().querySelector('.threads-head'), '「从大纲排出」还在');
  });
});

describe('叙事线总览 · 特殊标签', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('点「总览」：主区标签条上多一个不对应文件的「叙事线总览」，覆盖层挂在 .ed-stage 上；要数据、先说在读', () => {
    const before = h.count('requestThreadsOverview');
    h.open();
    assert.ok(h.specialTab(), '没有特殊标签');
    assert.equal(h.specialTab().dataset.special, 'threads-overview');
    assert.ok(h.specialTab().classList.contains('active'));
    assert.deepEqual(h.tabs(), ['叙事线总览']);
    assert.equal(h.specialTab().querySelector('.ed-tab-dirty'), null, '没有脏标记');
    assert.ok(h.tov().closest('.wb-editor') === h.doc.getElementById('wbEditor'), '在主区');
    assert.ok(h.shown());
    assert.ok(h.doc.getElementById('edWelcome').classList.contains('hidden'), '欢迎页藏起来');
    assert.equal(h.count('requestThreadsOverview'), before + 1);
    assert.match(h.ui.last('requestThreadsOverview').requestId, /^threads-/);
    assert.match(h.note(), /正在读取/);
    // 不对应文件：工具栏藏着、没有「当前文件」。
    assert.ok(h.doc.getElementById('edToolbar').classList.contains('hidden'));
  });

  test('已经开着再点「总览」：不开第二个，切过去并再要一次', () => {
    h.open();
    h.respond();
    h.openFile('chapters/001-楔子.md');
    const before = h.count('requestThreadsOverview');
    h.open();
    assert.equal(h.doc.querySelectorAll('.ed-tab-special').length, 1);
    assert.deepEqual(h.tabs(), ['叙事线总览', '001-楔子.md']);
    assert.equal(h.activeTab(), '叙事线总览');
    assert.ok(h.shown());
    assert.equal(h.count('requestThreadsOverview'), before + 1);
  });

  test('切到一份文件：覆盖层藏起来；点特殊标签再露出来；文件标签排在它后面', () => {
    h.open();
    h.respond();
    h.openFile('chapters/001-楔子.md');
    assert.equal(h.activeTab(), '001-楔子.md');
    assert.equal(h.shown(), false);
    assert.equal(h.doc.getElementById('edArea').classList.contains('hidden'), false);
    h.ui.clickEl(h.specialTab());
    assert.equal(h.activeTab(), '叙事线总览');
    assert.ok(h.shown());
    assert.ok(h.doc.getElementById('edArea').classList.contains('hidden'), '正文区藏着');
    // 点文件标签切回去。
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'chapters/001-楔子.md'));
    assert.equal(h.shown(), false);
  });

  test('× 关掉：回到切过去之前的那份文件；没有文件时回到欢迎页', () => {
    h.openFile('a.md');
    h.openFile('b.md');
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    h.open();
    h.respond();
    h.ui.clickEl(h.specialTab().querySelector('.ed-tab-close'));
    assert.equal(h.specialTab(), null);
    assert.equal(h.activeTab(), 'a.md', '回到切过去之前的 a.md，不是最后一份');
    assert.equal(h.shown(), false);

    const g = harness();
    g.open();
    g.ui.clickEl(g.specialTab().querySelector('.ed-tab-close'));
    assert.equal(g.specialTab(), null);
    assert.equal(g.doc.getElementById('edWelcome').classList.contains('hidden'), false);
    assert.equal(g.doc.getElementById('edTabs').classList.contains('hidden'), true);
  });

  test('Ctrl+W 关掉正显示着的特殊标签；标签右键「关闭」「刷新」', () => {
    h.open();
    h.respond();
    const menu = h.ui.itemsOf(h.ui.rightClick(h.specialTab()));
    assert.deepEqual(menu, ['关闭', '刷新']);
    const before = h.count('requestThreadsOverview');
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '刷新');
    assert.equal(h.count('requestThreadsOverview'), before + 1);
    const e = new h.window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });
    h.doc.body.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.specialTab(), null);
  });

  test('「▾」列表里也有它，点了切过去', () => {
    h.open();
    h.respond();
    h.openFile('a.md');
    h.ui.clickEl(h.doc.querySelector('#edTabs .ed-tabs-more'));
    const items = [...h.doc.querySelectorAll('.ctx-menu button')].map((b) => b.textContent.trim());
    assert.ok(items.some((x) => x.endsWith('叙事线总览')), JSON.stringify(items));
    [...h.doc.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.trim().endsWith('叙事线总览')).click();
    assert.equal(h.activeTab(), '叙事线总览');
    assert.ok(h.shown());
  });
});

describe('叙事线总览 · 矩阵', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('头上一行：定稿到第几章、几条线、几条伏笔；图例', () => {
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 2 条线 · 4 条伏笔');
    const legend = h.doc.querySelector('.tov-legend').textContent;
    for (const word of ['只有计划', '只有实际', '计划也发生了', '计划了、同步了却没发生', '埋', '收', '弃']) {
      assert.ok(legend.includes(word), legend);
    }
    assert.equal(h.note(), '');
  });

  test('列头：一章一列、章号、定稿状态；分卷的书多一行卷名', () => {
    const cols = [...h.doc.querySelectorAll('.tov-nums .tov-col')];
    assert.deepEqual(cols.map((c) => c.textContent), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(
      cols.map((c) => ['finalized', 'written', 'planned', 'none'].find((s) => c.classList.contains(`tov-col-${s}`))),
      ['finalized', 'finalized', 'finalized', 'written', 'planned', 'none']
    );
    assert.ok(cols[2].classList.contains('tov-col-now'));
    assert.equal(cols[3].style.left, '72px');
    assert.match(cols[0].title, /第 1 章《楔子》 · 已同步/);
    assert.match(cols[3].title, /写了，还没同步/);
    assert.match(cols[5].title, /还没有细纲/);
    const vols = [...h.doc.querySelectorAll('.tov-vols .tov-vol')];
    assert.deepEqual(vols.map((v) => [v.textContent, v.style.left, v.style.width]), [
      ['', '0px', '72px'],
      ['第二卷', '72px', '72px'],
    ]);
  });

  test('「定稿到第 3 章」：一条竖线画在第 3 章右边；叙事线跟上了定稿，不另画', () => {
    const now = h.doc.querySelector('.tov-grid .tov-now');
    assert.ok(now);
    assert.equal(now.style.left, `${220 + 3 * 24}px`);
    assert.equal(now.title, '同步到第 3 章');
    assert.equal(h.doc.querySelector('.tov-grid .tov-judged'), null);
  });

  // 四期：定稿到第 3 章、叙事线只判到第 1 章——第 2、3 章定稿了还没判。
  test('叙事线落后于定稿：头上说判到第几章；另一条虚竖线画在第 1 章右边；还没判的列头另标、悬停说计划不算偏差', () => {
    const o = overview({ through: 1 });
    o.chapters = o.chapters.map((c) => (c.no === 2 || c.no === 3 ? { ...c, unjudged: true } : c));
    // 点「总览」总是再要一次。
    h.open();
    h.respond(o);
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 叙事线判到第 1 章 · 2 条线 · 4 条伏笔');
    const judged = h.doc.querySelector('.tov-grid .tov-judged');
    assert.ok(judged);
    assert.equal(judged.style.left, `${220 + 1 * 24}px`);
    assert.match(judged.title, /^叙事线判到第 1 章/);
    assert.equal(h.doc.querySelector('.tov-grid .tov-now').style.left, `${220 + 3 * 24}px`);
    const cols = [...h.doc.querySelectorAll('.tov-nums .tov-col')];
    assert.deepEqual(cols.map((c) => c.classList.contains('tov-col-unjudged')), [false, true, true, false, false, false]);
    assert.match(cols[1].title, /已同步，叙事线还没判（这一章的计划不算偏差）/);
    assert.match(h.doc.querySelector('.tov-corner').title, /虚线：叙事线判到第 1 章/);
  });

  test('一章都没判过：头上说「叙事线还没判过」，不画虚线', () => {
    const o = overview({ through: 0 });
    h.open();
    h.respond(o);
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 叙事线还没判过 · 2 条线 · 4 条伏笔');
    assert.equal(h.doc.querySelector('.tov-grid .tov-judged'), null);
  });

  test('行：按种类分组，每条线下面是它的伏笔，最后是「未归属的伏笔」', () => {
    const rows = [...h.doc.querySelectorAll('.tov-grid .tov-row')].map((r) => {
      const kind = ['group', 'line', 'fore'].find((k) => r.classList.contains(`tov-row-${k}`));
      return `${kind}:${r.querySelector('.tov-name').firstElementChild.textContent === '●' ? r.querySelector('.tov-link').textContent : r.querySelector('.tov-name').textContent}`;
    });
    assert.deepEqual(rows, [
      'group:主线1 条',
      'line:青崖旧案',
      'group:感情线1 条',
      'line:林昭与沈氏',
      'fore:玉佩的来历',
      'fore:沈氏的旧伤',
      'group:未归属的伏笔2 条',
      'fore:断剑⚠',
      'fore:火折子',
    ]);
    // 线名悬停看说法、⚠、意图；有 ⚠ 的挂一个 ⚠。
    const line = h.row(T('林昭与沈氏'));
    assert.match(line.querySelector('.tov-link').title, /感情线 · 进行中[\s\S]*⚠ 1 条伏笔逾期/);
    assert.ok(line.querySelector('.tov-warn'));
    assert.match(h.row(T('青崖旧案')).querySelector('.tov-link').title, /意图：查清七年前那场火/);
  });

  test('还在读、不是小说工程、一条线都没有、列被截了：各说一句', () => {
    const g = harness();
    g.open();
    assert.match(g.note(), /正在读取/);
    g.respond(overview({ initialized: false, chapters: [], groups: [], unfiled: undefined, current: 0 }));
    assert.match(g.note(), /还不是小说工程/);
    g.ui.clickEl(g.overviewBtn());
    g.respond(overview({ groups: [], unfiled: undefined }));
    assert.match(g.note(), /还没有叙事线/);
    assert.equal(g.doc.querySelector('.tov-grid'), null);
    g.ui.clickEl(g.overviewBtn());
    g.respond(overview({ clippedFrom: 30000 }));
    assert.match(g.note(), /第 30000 章，太远了，只画到第 6 章/);
    assert.ok(g.doc.querySelector('.tov-grid'));
  });
});

describe('叙事线总览 · 线的四种格子', { skip: JSDOM_SKIP }, () => {
  test('○ 只有计划、● 只有实际、◉ 计划也发生了、红圈偏差；只画有事件的章', () => {
    const h = harness();
    h.open();
    h.respond();
    const row = h.row(T('青崖旧案'));
    const kind = (no) => ['plan', 'actual', 'both', 'dev'].find((k) => h.cellOf(row, no).querySelector(`.tov-mark-${k}`));
    assert.equal(kind(1), 'actual');
    assert.equal(kind(2), 'dev');
    assert.equal(kind(3), 'both');
    assert.equal(kind(5), 'plan');
    assert.equal(h.cellOf(row, 4), null);
    assert.equal(h.cellOf(row, 6), null);
    // 圆点借流水线条的 pstage-mark：实际的实心（done），计划的空心。
    assert.ok(h.cellOf(row, 1).querySelector('.pstage-mark.done'));
    assert.ok(h.cellOf(row, 3).querySelector('.pstage-mark.done'));
    assert.ok(!h.cellOf(row, 5).querySelector('.pstage-mark').classList.contains('done'));
    assert.ok(h.cellOf(row, 2).classList.contains('tov-cell-dev'));
    assert.equal(h.cellOf(row, 3).style.left, '48px');
  });

  test('计划区间一条淡底', () => {
    const h = harness();
    h.open();
    h.respond();
    const band = h.row(T('青崖旧案')).querySelector('.tov-band');
    assert.deepEqual([band.style.left, band.style.width, band.title], ['0px', '144px', '计划第 1–6 章']);
    assert.equal(h.row(T('林昭与沈氏')).querySelector('.tov-band'), null);
  });
});

describe('叙事线总览 · 伏笔连线', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('收了的：埋 ● 到收 ◆ 一条实线', () => {
    const row = h.foreRow('玉佩的来历');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-done'));
    assert.deepEqual([span.style.left, span.style.width], ['12px', '48px']);
    assert.ok(h.cellOf(row, 1).querySelector('.tov-fmark-plant.done'));
    const resolve = h.cellOf(row, 3).querySelector('.tov-fmark-resolve');
    assert.ok(resolve && !resolve.classList.contains('tov-fmark-plan'), '实际收了画实心 ◆');
    assert.equal(row.querySelector('.tov-due'), null, '收了的不画回收章');
    assert.ok(row.classList.contains('tov-row-closed'));
  });

  test('埋了没收、逾期：虚线标红，回收章那一格一道红竖线，名字标红挂 ⚠', () => {
    const row = h.foreRow('断剑');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-open') && span.classList.contains('tov-overdue'));
    assert.deepEqual([span.style.left, span.style.width], ['12px', '48px']);
    const due = row.querySelector('.tov-due');
    assert.ok(due.classList.contains('tov-overdue'));
    assert.equal(due.style.left, `${24 + 12}px`);
    assert.match(due.title, /计划第 2 章前收——叙事线判到第 3 章，逾期/);
    assert.ok(row.classList.contains('tov-row-overdue'));
    assert.ok(row.querySelector('.tov-warn'));
  });

  test('还没埋：按计划画淡虚线到回收章；计划埋的那一章定稿了却没埋，空心记号标红', () => {
    const row = h.foreRow('沈氏的旧伤');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-planned'));
    assert.ok(!span.classList.contains('tov-overdue'));
    assert.equal(row.querySelector('.tov-due').style.left, `${5 * 24 + 12}px`);
    const mark = h.cellOf(row, 2).querySelector('.tov-fmark-plant');
    assert.ok(mark.classList.contains('tov-fmark-plan') && mark.classList.contains('tov-mark-dev'));
    assert.ok(!mark.classList.contains('done'));
  });

  test('弃了的画 ✕，没有连线', () => {
    const row = h.foreRow('火折子');
    assert.equal(h.cellOf(row, 2).querySelector('.tov-fmark-drop').textContent, '✕');
    assert.equal(row.querySelector('.tov-span'), null);
  });
});

describe('叙事线总览 · 点击', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('点格子打开那一章（openChapter：正文进主区、细纲并排）', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.row(T('青崖旧案')), 1).querySelector('.tov-mark'));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/001-楔子.md' }]);
    const m = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.foreRow('沈氏的旧伤'), 2));
    assert.deepEqual(h.sentAfter(m), [{ type: 'openChapter', plotRelPath: 'chapters/002-入镇.md' }]);
  });

  test('还没写的打开细纲；细纲正文都没有的说一句、不发', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.row(T('青崖旧案')), 5));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: '.novelforge/summaries/第二卷/005-赤星.md' }]);
    const m = h.ui.sent.length;
    h.ui.clickEl(h.doc.querySelector('.tov-nums .tov-col[data-ch="6"]'));
    assert.deepEqual(h.sentAfter(m), []);
    assert.match(h.toasts.at(-1), /第 6 章还没有细纲，也没有正文/);
  });

  test('点列头打开那一章', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.doc.querySelector('.tov-nums .tov-col[data-ch="4"]'));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/第二卷/004-北行.md' }]);
  });

  test('点线名打开那条线的文件；点伏笔名打开它所在的文件；点「未归属的伏笔」打开那份文件——开在总览所在的这一块', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.row(T('林昭与沈氏')).querySelector('.tov-link'));
    h.ui.clickEl(h.foreRow('玉佩的来历').querySelector('.tov-link'));
    h.ui.clickEl(h.row(UNFILED).querySelector('.tov-link'));
    h.ui.clickEl(h.foreRow('断剑').querySelector('.tov-link'));
    assert.deepEqual(h.sentAfter(n), [
      { type: 'openEditor', path: T('林昭与沈氏'), pane: 'main' },
      { type: 'openEditor', path: T('林昭与沈氏'), pane: 'main' },
      { type: 'openEditor', path: UNFILED, pane: 'main' },
      { type: 'openEditor', path: UNFILED, pane: 'main' },
    ]);
  });

  test('打开的那一章到了：它成了当前标签，总览藏起来、标签还在', () => {
    h.ui.clickEl(h.cellOf(h.row(T('青崖旧案')), 1));
    h.openFile('chapters/001-楔子.md');
    assert.equal(h.activeTab(), '001-楔子.md');
    assert.equal(h.shown(), false);
    assert.ok(h.specialTab());
  });
});

describe('叙事线总览 · 悬停', { skip: JSDOM_SKIP }, () => {
  test('悬停一格：第几章、哪一行、计划与实际的事件与证据；偏差说一句；移开就收', () => {
    const h = harness();
    h.open();
    h.respond();
    const tip = () => h.doc.querySelector('.tov .tov-tip');
    const over = (node) => node.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
    const out = (node) => node.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: h.doc.body }));

    const dev = h.cellOf(h.row(T('青崖旧案')), 2);
    over(dev.querySelector('.tov-mark'));
    assert.equal(tip().classList.contains('hidden'), false);
    assert.equal(tip().querySelector('.tov-tip-head').textContent, '第 2 章《入镇》 · 已同步');
    assert.equal(tip().querySelector('.tov-tip-row-name').textContent, '青崖旧案');
    assert.deepEqual([...tip().querySelectorAll('.tov-tip-ev')].map((n) => n.textContent), ['计划 · 推进：打听名册']);
    assert.match(tip().querySelector('.tov-tip-dev').textContent, /计划了，这一章也同步了，却没有发生/);
    out(dev);
    assert.equal(tip().classList.contains('hidden'), true);

    over(h.cellOf(h.row(T('青崖旧案')), 3));
    assert.deepEqual([...tip().querySelectorAll('.tov-tip-ev')].map((n) => n.textContent), [
      '计划 · 推进：找到空匣',
      '推进：夜访旧宅，找到空匣「匣子是空的」',
    ]);
    assert.equal(tip().querySelector('.tov-tip-evidence').textContent, '「匣子是空的」');
    assert.equal(tip().querySelector('.tov-tip-dev'), null);

    over(h.cellOf(h.foreRow('玉佩的来历'), 1));
    assert.equal(tip().querySelector('.tov-tip-ev').textContent, '埋〈玉佩的来历〉：玉佩露面「他摸了摸怀里的玉佩」');
    // 用户内容一律 textContent：证据里的尖括号原样是字。
    h.doc.querySelector('.tov').dispatchEvent(new h.window.Event('scroll'));
  });
});

describe('叙事线总览 · 在总览里看', { skip: JSDOM_SKIP }, () => {
  test('工程页行右键「在总览里看」：打开总览，数据到了标出那一行', () => {
    const h = harness();
    h.ui.pick(h.ui.rightClick(h.projectRow('林昭与沈氏')), '在总览里看');
    assert.ok(h.shown());
    h.respond();
    assert.ok(h.row(T('林昭与沈氏')).classList.contains('tov-focus'));
    assert.equal(h.row(T('青崖旧案')).classList.contains('tov-focus'), false);
    // 换一行定位：标记跟着走；已经有数据时当场标出来。
    h.ui.pick(h.ui.rightClick(h.projectRow('未归属的伏笔')), '在总览里看');
    assert.ok(h.row(UNFILED).classList.contains('tov-focus'));
    assert.equal(h.row(T('林昭与沈氏')).classList.contains('tov-focus'), false);
    // 新数据到了重画，标记还在。
    h.respond();
    assert.ok(h.row(UNFILED).classList.contains('tov-focus'));
  });
});

describe('叙事线总览 · 数据', { skip: JSDOM_SKIP }, () => {
  test('别的页面的 requestId 不认', () => {
    const h = harness();
    h.open();
    h.ui.post({ type: 'threadsOverview', requestId: 'threads-别人的', overview: overview() });
    assert.equal(h.doc.querySelector('.tov-grid'), null);
    assert.match(h.note(), /正在读取/);
    h.respond();
    assert.ok(h.doc.querySelector('.tov-grid'));
  });

  test('显示着收到 state（磁盘上变过）：停一下再要一次；藏着时不要，切回来再要', () => {
    const h = harness({ shims: ['fakeTimers'] });
    h.open();
    h.respond();
    const n = h.count('requestThreadsOverview');
    h.ui.post({ type: 'state', state: viewState() });
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.count('requestThreadsOverview'), n, '还在等');
    h.window.__clock.tick(700);
    assert.equal(h.count('requestThreadsOverview'), n + 1, '连着两条只要一次');
    h.respond();

    h.openFile('a.md');
    h.ui.post({ type: 'state', state: viewState() });
    h.window.__clock.tick(700);
    assert.equal(h.count('requestThreadsOverview'), n + 1, '藏着时不要');
    h.ui.clickEl(h.specialTab());
    assert.equal(h.count('requestThreadsOverview'), n + 2, '切回来再要');
    // 没变过：切走再切回来不再要。
    h.respond();
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    h.ui.clickEl(h.specialTab());
    assert.equal(h.count('requestThreadsOverview'), n + 2);
  });
});

describe('叙事线总览 · 刷新恢复', { skip: JSDOM_SKIP }, () => {
  const SHIMS = ['scrollIntoView', 'clipboard'];

  test('记着：刷新之后先开总览，陆续回来的文件不把它换下去；关掉它回到存下来的那一份', () => {
    const first = harness({ storage: {} });
    first.openFile('a.md');
    first.openFile('b.md');
    first.ui.clickEl([...first.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    first.open();
    first.respond();
    const saved = first.window.localStorage.getItem(STORE_KEY);
    const data = JSON.parse(saved);
    assert.deepEqual(data.panes.main.specials, ['threads-overview']);
    assert.equal(data.panes.main.special, 'threads-overview');
    assert.equal(data.panes.main.active, 'a.md', '记的是切过去之前的那一份');

    const second = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: saved } });
    const tab = () => second.doc.querySelector('#edTabs .ed-tab-special');
    const shown = () => !second.doc.querySelector('.tov').classList.contains('hidden');
    assert.ok(tab()?.classList.contains('active'), '总览先开、正显示着');
    assert.ok(second.last('requestThreadsOverview'), '要了数据');
    assert.deepEqual(second.sent.filter((m) => m.type === 'openEditor').map((m) => m.path), ['a.md', 'b.md']);
    second.post({ type: 'editorOpen', file: file('a.md', 'a') });
    second.post({ type: 'editorOpen', file: file('b.md', 'b') });
    assert.ok(tab().classList.contains('active'), '回来的文件没把它换下去');
    assert.ok(shown());
    second.clickEl(tab().querySelector('.ed-tab-close'));
    assert.equal(second.doc.querySelector('#edTabs .ed-tab.active').dataset.path, 'a.md');
  });

  test('没在显示的总览：恢复成标签条上的一个标签，当前的还是那份文件', () => {
    const first = harness({ storage: {} });
    first.open();
    first.respond();
    first.openFile('a.md');
    const saved = first.window.localStorage.getItem(STORE_KEY);
    assert.equal(JSON.parse(saved).panes.main.special, undefined);

    const second = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: saved } });
    second.post({ type: 'editorOpen', file: file('a.md', 'a') });
    const tabs = [...second.doc.querySelectorAll('#edTabs .ed-tab')];
    assert.deepEqual(tabs.map((t) => t.dataset.special ?? t.dataset.path), ['threads-overview', 'a.md']);
    assert.ok(tabs[1].classList.contains('active'));
    assert.equal(second.doc.querySelector('.tov'), null, '没显示就不画');
    assert.equal(second.last('requestThreadsOverview'), undefined, '没显示就不要数据');
  });

  test('只开着总览、没有文件也恢复；记坏了的（认不出的标签、形状不对）不认、不崩，文件照样回来', () => {
    const onlyOverview = JSON.stringify({ v: 2, panes: { main: { open: [], active: null, specials: ['threads-overview'], special: 'threads-overview' } }, activePane: 'main' });
    const a = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: onlyOverview } });
    assert.ok(a.doc.querySelector('#edTabs .ed-tab-special.active'));

    const broken = JSON.stringify({
      v: 2,
      panes: {
        main: { open: [{ path: 'a.md', hash: 'h-a.md' }], active: 'a.md', specials: ['不认得的', 3, null], special: '不认得的' },
        draft: { open: [], specials: 'threads-overview' },
      },
      activePane: 'main',
    });
    const b = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: broken } });
    assert.equal(b.doc.querySelector('.ed-tab-special'), null);
    assert.deepEqual(b.sent.filter((m) => m.type === 'openEditor').map((m) => m.path), ['a.md']);
    b.post({ type: 'editorOpen', file: file('a.md', 'a') });
    assert.equal(b.doc.querySelector('#edTabs .ed-tab.active').dataset.path, 'a.md');
  });
});

describe('叙事线总览 · 换工程', { skip: JSDOM_SKIP }, () => {
  test('换工程：标签关掉，覆盖层藏起来', () => {
    const h = harness();
    h.open();
    h.respond();
    h.window.dispatchEvent(new h.window.Event('nf-workspace-reset'));
    assert.equal(h.specialTab(), null);
    assert.equal(h.shown(), false);
  });
});

// 故事时间（2026-10-24）：表头的月份带、线上面一行「故事时间」，点它打开时间线文件；同日重做：那一行单独成一组「时间线」，排在主线组前面。
describe('叙事线总览 · 故事时间', { skip: JSDOM_SKIP }, () => {
  const TL = T('时间线');
  const time = (state, short, label, month, tip = `${label}\n点击打开时间线（在那里改）`) => ({ state, short, label, tip, ...(month ? { month } : {}) });
  /** 第 1–2 章三月，第 3 章四月；第 2 章与第 1 章同一天；第 4 章推不出；第 5 章回忆；第 6 章没有时间。 */
  function withTime() {
    const o = overview();
    const times = [
      time('evidence', '初七', '大衍三年三月初七 傍晚', '大衍三年三月'),
      time('guess', '', '大衍三年三月初七 夜里', '大衍三年三月'),
      time('anchor', '初一', '大衍三年四月初一', '大衍三年四月'),
      time('unknown', '?', '大衍三年四月初一', '大衍三年四月'),
      time('flashback', '忆', '回忆（约二十年前）'),
    ];
    o.chapters = o.chapters.map((c, i) => (times[i] ? { ...c, time: times[i] } : c));
    o.chapters[3] = { ...o.chapters[3], time: { ...o.chapters[3].time, issue: true } };
    return { ...o, timeline: { relPath: TL, months: true, label: '故事第 26 天' } };
  }
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond(withTime());
  });

  test('表头多一条月份带：连着几章同一个月并成一段，没有时间的章断开；和卷名那一行叠在一起', () => {
    const months = [...h.doc.querySelectorAll('.tov-months .tov-month')];
    assert.deepEqual(months.map((m) => [m.textContent, m.style.left, m.style.width]), [
      ['大衍三年三月', '0px', '48px'],
      ['大衍三年四月', '48px', '48px'],
    ]);
    const head = h.doc.querySelector('.tov-header');
    assert.ok(head.classList.contains('tov-header-months') && head.classList.contains('tov-header-vols'));
  });

  test('「时间线」一组排在表头之后、主线组之前，组名后写故事第几天；下面一行「故事时间」：几号、同一天画点、推不出 ?、回忆「忆」；对账报了的标红', () => {
    const row = h.doc.querySelector('.tov-row-time');
    assert.equal(row.dataset.path, TL);
    const head = row.previousElementSibling;
    assert.ok(head.classList.contains('tov-row-group'));
    assert.equal(head.textContent, '时间线故事第 26 天');
    assert.ok(head.previousElementSibling.classList.contains('tov-header'));
    const cells = [...row.querySelectorAll('.tov-time')];
    assert.deepEqual(cells.map((c) => c.textContent), ['初七', '·', '初一', '?', '忆']);
    assert.deepEqual(
      cells.map((c) => c.className.replace('tov-time tov-time-', '')),
      ['evidence', 'guess', 'anchor', 'unknown is-issue', 'flashback']
    );
    assert.equal(cells[2].style.left, '48px');
    assert.match(cells[0].title, /大衍三年三月初七 傍晚/);
  });

  test('点「故事时间」名字、点格子：打开时间线文件（这一行是拿来改时间的），开在总览所在的这一块', () => {
    const n = h.ui.sent.length;
    const row = h.doc.querySelector('.tov-row-time');
    h.ui.clickEl(row.querySelector('.tov-link'));
    h.ui.clickEl(row.querySelectorAll('.tov-time')[3]);
    assert.deepEqual(h.sentAfter(n), [
      { type: 'openEditor', path: TL, pane: 'main' },
      { type: 'openEditor', path: TL, pane: 'main' },
    ]);
  });

  test('列头与线格子的悬停带上那一章的日期', () => {
    const col = h.doc.querySelector('.tov-nums .tov-col');
    assert.match(col.title, /^第 1 章《楔子》 · 大衍三年三月初七 傍晚 · 已同步/);
    const node = h.cellOf(h.row(T('青崖旧案')), 1);
    node.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(h.doc.querySelector('.tov-tip .tov-tip-head').textContent, /大衍三年三月初七 傍晚/);
  });

  test('没有时间线：没有这一行，也没有月份带', () => {
    const plain = harness();
    plain.open();
    plain.respond(overview());
    assert.equal(plain.doc.querySelector('.tov-row-time'), null);
    assert.equal(plain.doc.querySelector('.tov-months'), null);
  });
});
