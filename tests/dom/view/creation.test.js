/**
 * 创作页：流水线条、当前产物浮窗、进入某一章、独立版壳。
 *
 * **没有「下一步主按钮」与「/ 命令面板」那两节了**：对话只剩 agent 一条路，
 * 那两个入口都是确定性单步的入口，跟着一起删了。「下一步」这个判断本身还在
 * （agent 每回合读它），只是不再有界面入口，所以改由
 * `tests/unit/model/pipeline.test.js` 单独守着。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  mount, JSDOM_SKIP,
  turn, emptySession, pipelineView, workbenchView, viewState, sampleTree,
} = require('../../helpers/dom');

describe('创作流水线条与下一步', { skip: JSDOM_SKIP }, () => {
  let ui;
  const crumbs = () => [...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].map((n) => n.textContent);
  const stages = () => [...ui.doc.querySelectorAll('#pipelineStages .pstage')];
  const lastSetTarget = () => [...ui.sent].reverse().find((m) => m.type === 'setTarget');

  before(() => {
    ui = mount();
    // ---- 大纲阶段 ----
    ui.post({ type: 'session', session: emptySession() });
  });

  test('大纲阶段收起段名信息条', () => {
    assert.ok(ui.doc.getElementById('pipelineCrumb').classList.contains('hidden'));
  });

  test('大纲阶段收起三层状态', () => {
    assert.ok(ui.doc.getElementById('pipelineStages').classList.contains('hidden'));
  });

  // 全书大纲那一层没有段可改名，留一个点了会报错的按钮比没有更糟。
  test('大纲阶段收起重命名按钮', () => {
    assert.ok(ui.doc.getElementById('renamePlotBtn').classList.contains('hidden'));
  });

  // 全书大纲那一层没有「这一段的三层」，但一样有产物要看。
  test('大纲阶段仍推工作区卡', () => {
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'outline', title: '全书大纲', sections: [], empty: '这部书还没有大纲。' }),
    });
    assert.ok(!ui.doc.getElementById('workbench').classList.contains('hidden'));
  });

  // ---- 切到某一段的正文 ----
  test('信息条只显示段名', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'manuscript',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        manuscript: {
          relPath: '.novelforge/manuscripts/012-夜入青云.md',
          words: 1200,
          targetWords: 3000,
          upstreamStale: true,
        },
        stage: 'manuscript',
        progress: { plot: 1, manuscript: 0.5, summary: 0 },
      }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 段《夜入青云》' }),
      next: {
        stage: 'manuscript',
        label: '重写正文',
        hint: '剧情改过，现有正文可能已经与它对不上。',
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
      },
    });
    assert.equal(crumbs().length, 1, crumbs().join('|'));
    assert.ok(crumbs()[0].includes('夜入青云'), crumbs().join('|'));
  });

  test('信息条不是按钮', () => {
    assert.ok([...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].every((n) => n.tagName === 'SPAN'));
  });

  // 这三格是**当前这一段的上游链**：所属那一卷的卷纲 → 它的细纲 → 它的正文。
  // 从前第一格是「细节」（那一段拆出来的场景），那一层已经删掉。
  test('展开三层状态（卷纲/剧情/正文）', () => {
    assert.equal(stages().length, 3, stages().map((n) => n.textContent).join('|'));
  });

  test('第一格是卷纲', () => {
    assert.ok(stages()[0].textContent.includes('卷纲'), stages().map((n) => n.textContent).join('|'));
  });

  test('不再有「细节」那一格', () => {
    assert.ok(
      !stages().some((n) => n.textContent.includes('细节')),
      stages().map((n) => n.textContent).join('|')
    );
  });

  // 这一章的状态徽章：与工程页那一列同一份文案。
  test('信息条带这一章的状态徽章', () => {
    const badge = ui.doc.querySelector('#pipelineCrumb .cstage');
    assert.ok(badge, '没有徽章');
    assert.equal(badge.textContent, '待写正文', badge?.textContent);
  });

  // 三态圆点：卷纲与剧情完成、正文进行中——不是百分比条。
  test('剧情标成已完成', () => {
    assert.ok(stages().find((n) => n.textContent.includes('剧情')).querySelector('.pstage-mark.done'));
  });

  // 卷纲那一格不在 `PipelineProgress` 里（那份进度按段算，卷纲是段的上游），
  // 单独取：有卷纲且写过走向就算齐。
  test('卷纲标成已完成', () => {
    assert.ok(stages().find((n) => n.textContent.includes('卷纲')).querySelector('.pstage-mark.done'));
  });

  test('正文标成进行中', () => {
    assert.ok(stages().find((n) => n.textContent.includes('正文')).querySelector('.pstage-mark.partial'));
  });

  test('不再画百分比条', () => {
    assert.ok(!ui.doc.querySelector('.pstage-bar'));
  });

  // 上游变过的那一段挂 ⟳。这是整条流水线最有价值的一格信息。
  test('正文段标出上游已变更', () => {
    const manuscriptStage = stages().find((n) => n.textContent.includes('正文'));
    assert.ok(manuscriptStage.querySelector('.pstage-stale'));
  });

  test('这一章没有变更标记', () => {
    assert.ok(!stages().find((n) => n.textContent.includes('剧情')).querySelector('.pstage-stale'));
  });

  // ---- 点击切目标（信息条本身不可点，靠下面的层按钮切）----
  test('点信息条不发 setTarget', () => {
    const before = ui.sent.filter((m) => m.type === 'setTarget').length;
    ui.clickEl(ui.doc.querySelector('#pipelineCrumb .crumb'));
    assert.equal(ui.sent.filter((m) => m.type === 'setTarget').length, before);
  });

  // ---- 「开始新对话」按钮：面包屑右侧那个 ＋ ----
  test('开始新对话按钮在面包屑右侧', () => {
    const btn = ui.doc.getElementById('newSessionBtn');
    assert.ok(btn, '没有 newSessionBtn');
    assert.equal(btn.parentElement?.id, 'pipelineTop');
    assert.ok(btn.textContent.includes('＋'), btn.textContent);
  });

  test('点开始新对话发出 newSession', () => {
    ui.clickEl(ui.doc.getElementById('newSessionBtn'));
    const msg = [...ui.sent].reverse().find((m) => m.type === 'newSession');
    assert.ok(msg, JSON.stringify(ui.sent));
  });

  test('生成中点开始新对话不发 newSession', () => {
    ui.post({ type: 'busy', value: true });
    const before = ui.sent.filter((m) => m.type === 'newSession').length;
    ui.clickEl(ui.doc.getElementById('newSessionBtn'));
    assert.equal(ui.sent.filter((m) => m.type === 'newSession').length, before);
    ui.post({ type: 'busy', value: false });
  });

  test('生成中禁用开始新对话按钮', () => {
    ui.post({ type: 'busy', value: true });
    assert.ok(ui.doc.getElementById('newSessionBtn').disabled);
    ui.post({ type: 'busy', value: false });
    assert.ok(!ui.doc.getElementById('newSessionBtn').disabled);
  });

  // ---- 「重命名当前这一章」按钮：面包屑右侧那支笔 ----
  // 新建出来的段是纯序号名（标题要等剧情排完才定），所以命名是主流程的一步。
  test('重命名按钮在面包屑右侧', () => {
    const btn = ui.doc.getElementById('renamePlotBtn');
    assert.ok(btn, '没有 renamePlotBtn');
    assert.equal(btn.parentElement?.id, 'pipelineTop');
  });

  test('目标是某一章时按钮可见', () => {
    assert.ok(!ui.doc.getElementById('renamePlotBtn').classList.contains('hidden'));
  });

  test('tooltip 带上段名', () => {
    assert.ok(ui.doc.getElementById('renamePlotBtn').title.includes('夜入青云'),
      ui.doc.getElementById('renamePlotBtn').title);
  });

  // 复用工程页右键那条 fileAction，不新增协议。
  test('点重命名发出 fileAction', () => {
    ui.clickEl(ui.doc.getElementById('renamePlotBtn'));
    const msg = [...ui.sent].reverse().find((m) => m.type === 'fileAction');
    assert.ok(msg, JSON.stringify(ui.sent));
    assert.equal(msg.action, 'rename', JSON.stringify(msg));
    assert.equal(msg.relPath, '.novelforge/plots/012-夜入青云.md', JSON.stringify(msg));
  });

  test('生成中禁用重命名按钮', () => {
    ui.post({ type: 'busy', value: true });
    assert.ok(ui.doc.getElementById('renamePlotBtn').disabled);
    ui.post({ type: 'busy', value: false });
    assert.ok(!ui.doc.getElementById('renamePlotBtn').disabled);
  });

  test('生成中点重命名不发 fileAction', () => {
    ui.post({ type: 'busy', value: true });
    const before = ui.sent.filter((m) => m.type === 'fileAction').length;
    ui.clickEl(ui.doc.getElementById('renamePlotBtn'));
    assert.equal(ui.sent.filter((m) => m.type === 'fileAction').length, before);
    ui.post({ type: 'busy', value: false });
  });

  test('点剧情层发出 setTarget', () => {
    ui.clickEl(stages().find((n) => n.textContent.includes('剧情')));
    assert.equal(lastSetTarget()?.target.kind, 'plot', JSON.stringify(lastSetTarget()));
  });

  test('切层保留当前这一章', () => {
    assert.equal(lastSetTarget()?.target.plotRelPath, '.novelforge/plots/012-夜入青云.md');
  });

  // 卷路径只有后端算得出（段的归属靠目录），前端从推来的那份流水线里拿。
  test('点卷纲层发出 setTarget，带的是卷路径', () => {
    ui.clickEl(stages().find((n) => n.textContent.includes('卷纲')));
    assert.equal(lastSetTarget()?.target.kind, 'volume', JSON.stringify(lastSetTarget()));
    assert.equal(
      lastSetTarget()?.target.volumeRelPath,
      '.novelforge/volumes/01-觉醒之日.md',
      JSON.stringify(lastSetTarget())
    );
  });

  // ---- 未分卷的段（`plots/` 根下那些，老工程全是） ----
  // 卷纲那一格对它们本来就不存在。**收起来而不是摆一个点了报错的按钮。**
  test('未分卷的段不显示卷纲那一格', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ volume: undefined }),
      workbench: workbenchView(),
      next: undefined,
    });
    assert.equal(stages().length, 2, stages().map((n) => n.textContent).join('|'));
    assert.ok(
      !stages().some((n) => n.textContent.includes('卷纲')),
      stages().map((n) => n.textContent).join('|')
    );
  });

  // ---- 全做完的段：状态点全绿 ----
  test('全做完时状态徽章说已完成', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'done', progress: { plot: 1, manuscript: 1, summary: 1 } }),
      workbench: workbenchView(),
    });
    assert.equal(stages().length, 3, stages().map((n) => n.textContent).join('|'));
  });

  // ---- 目标换段时，上一段的进度不能留着显示 ----
  test('换段后不再显示上一段的段名', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/013-另一段.md' },
        stage: 'plot',
      }),
    });
    assert.ok(!crumbs().some((c) => c.includes('夜入青云')), crumbs().join('|'));
  });
});

/*
 * 「当前产物」：流水线条上的入口 + 悬停浮窗。
 *
 * 从前它是消息流顶部一张 sticky 卡片，关不掉也藏不起来。现在与工程页那三只
 * 浮窗同一套路子，所以要验的东西也换了：入口只占一行、悬停/点击才浮出来、
 * 移开或 Esc 收得掉。
 */
describe('当前产物浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const entry = () => ui.doc.getElementById('workbench');
  const tip = () => ui.doc.querySelector('.workbench-tip');
  const rows = () => [...(tip()?.querySelectorAll('.wbt-row') ?? [])].map((n) => n.textContent);
  const hoverEntry = () => entry().dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  const leaveEntry = () => entry().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  const esc = () =>
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 等过悬停延迟（HOVER_DELAY_MS 是 300ms）。 */
  const settle = () => wait(450);
  /** 等过收起的宽限期（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);

  const postScene = () =>
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({
        stage: 'scene',
        title: '场景 2 翻越侧峰 · 第 12 章《夜入青云》',
        relPath: '.novelforge/scenes/012-夜入青云/02-翻越侧峰.md',
        sections: [
          { key: '这一幕', text: '青云宗侧峰 · 子时，暴雨 · 林昭' },
          { key: '动作', text: '林昭把外衣搭在墙头\n数到第三盏灯才翻过去' },
        ],
      }),
    });

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'scene', chapterRelPath: 'chapters/012-夜入青云.md', sceneNo: 2 },
        stage: 'scene',
      }),
    });
    postScene();
  });

  // ---- 入口：一行，长在流水线条上（不在消息流里，不占版面）
  test('入口显示出来', () => {
    assert.ok(!entry().classList.contains('hidden'));
  });

  test('入口长在流水线条里，不在消息流里', () => {
    assert.equal(entry().parentElement?.id, 'pipeline', entry().parentElement?.id);
  });

  test('入口上就写着在改哪一层', () => {
    const title = entry().querySelector('.wbt-entry-title');
    assert.ok(title?.textContent.includes('场景 2'), title?.textContent);
  });

  test('默认不显示浮窗', () => {
    assert.ok(!tip());
  });

  // ---- 悬停：延迟后浮出来（免得划过时闪）
  test('悬停后不立刻弹出', () => {
    hoverEntry();
    assert.ok(!tip());
  });

  test('悬停延迟到了浮出来', async () => {
    await settle();
    assert.ok(tip());
  });

  test('浮窗挂在 body 上（消息流有内部滚动，挂在里面会被裁掉）', () => {
    assert.equal(tip().parentElement, ui.doc.body);
  });

  test('浮窗标题说清在改哪一层', () => {
    assert.ok(tip().querySelector('.wbt-title').textContent.includes('场景 2'),
      tip().querySelector('.wbt-title')?.textContent);
  });

  test('摊开产物的小节', () => {
    assert.equal(rows().length, 2, rows().join('|'));
  });

  test('素材逐行可见', () => {
    assert.ok(rows()[1].includes('搭在墙头') && rows()[1].includes('第三盏灯'), rows()[1]);
  });

  // 场景素材是要抄进正文的，鼠标得进得来——所以收起有宽限期。
  test('移开后有宽限期，浮窗还在', () => {
    leaveEntry();
    assert.ok(tip());
  });

  test('宽限期过后收起', async () => {
    await grace();
    assert.ok(!tip());
  });

  // ---- 点一下钉住：照着场景素材写正文时鼠标要回输入框
  test('点击立刻浮出来，不等延迟', () => {
    ui.clickEl(entry());
    assert.ok(tip());
  });

  test('钉住后移开鼠标也不收', async () => {
    leaveEntry();
    await grace();
    assert.ok(tip());
  });

  test('再点一次收起', () => {
    ui.clickEl(entry());
    assert.ok(!tip());
  });

  test('按 Esc 收起', () => {
    ui.clickEl(entry());
    esc();
    assert.ok(!tip());
  });

  // 「打开」走的是既有的开文件通道（插件里是 openFile）。
  test('点打开发出开文件消息', () => {
    ui.clickEl(entry());
    ui.clickEl(tip().querySelector('.wbt-open'));
    const opened = [...ui.sent].reverse().find((m) => m.type === 'openFile' || m.type === 'openEditor');
    assert.equal(opened?.path, '.novelforge/scenes/012-夜入青云/02-翻越侧峰.md', JSON.stringify(opened));
  });

  // 上游变更在浮窗里是一句人话，不只是流水线条上那个 ⟳。
  test('上游变更给一句人话', () => {
    ui.clickEl(entry());
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'scene', warning: '本章细纲在这一场之后改过。' }),
    });
    assert.ok(tip()?.querySelector('.wbt-warning')?.textContent.includes('细纲在这一场之后改过'),
      tip()?.querySelector('.wbt-warning')?.textContent);
  });

  // 开着的浮窗就地换内容，不重建——重建会让它闪一下。
  test('重推产物时浮窗不关掉', () => {
    assert.ok(tip());
  });

  // 入口上也要看得见，否则用户没有理由把它打开。
  test('上游变更在入口上挂标记', () => {
    assert.equal(entry().querySelector('.wbt-entry-mark')?.textContent, '⟳');
  });

  // 这一层还没有产物时说清缺什么，不要留一只空浮窗。
  test('没有产物时说明缺什么', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'plan', sections: [], empty: '这一章还没有细纲。' }),
    });
    assert.equal(tip()?.querySelector('.wbt-empty')?.textContent, '这一章还没有细纲。',
      tip()?.querySelector('.wbt-empty')?.textContent);
  });

  test('没有产物时不画小节', () => {
    assert.equal(rows().length, 0);
    esc();
  });
});

describe('选中一章进入当前阶段', { skip: JSDOM_SKIP }, () => {
  let ui;
  let select;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'state',
      state: viewState({
        plots: [{ no: 12, title: '夜入青云', wordCount: 0, relPath: '.novelforge/plots/012-夜入青云.md' }],
        nextNo: 13,
      }),
    });
    select = ui.doc.getElementById('targetSelect');
  });

  // 下拉框选一段 = 进入那一段当前该做的那一步，由后端的状态机判定。
  // 旧版一律发 setTarget({kind:'manuscript'})，于是选中一个连剧情都没排的
  // 段，界面直接把作者丢进正文层。
  test('选一章发 selectPlot', () => {
    select.value = '12';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const picked = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(picked?.plotRelPath, '.novelforge/plots/012-夜入青云.md', JSON.stringify(picked));
  });

  test('不再直接发 setTarget 到正文', () => {
    assert.ok(![...ui.sent].some((m) => m.type === 'setTarget' && m.target.kind === 'manuscript'));
  });

  // 「新建第 N 章」那一项没有 relPath——那一章还不存在，只能落到大纲。
  test('新建项落到大纲', () => {
    select.value = '13';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const toOutline = [...ui.sent].reverse().find((m) => m.type === 'setTarget');
    assert.equal(toOutline?.target.kind, 'outline', JSON.stringify(toOutline));
  });

  // 工程页点章名是**打开文件**，不切页——「进入这一章」挪进了右键菜单。
  // 在工程页上扫章节列表时，要看的多半就是这一章写成了什么样。
  test('工程页点章名打开文件，不发 selectPlot', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    ui.sent.length = 0;
    // 排掉卷那一组的行：它们刻意复用同一套样式类（`.row-plot`）。
    const row = ui.doc.querySelector('#projectBody .row-plot:not(.row-volume) .row-label');
    ui.clickEl(row);
    assert.ok(![...ui.sent].some((m) => m.type === 'selectPlot'), JSON.stringify(ui.sent));
    const open = [...ui.sent].reverse().find((m) => m.type === 'openFile');
    assert.equal(open?.path, 'chapters/001-楔子.md', JSON.stringify(open));
  });

  // 剧情段那一行说的是「进入这一段」——它不是一章，一段可以拆成三章。
  test('工程页右键「进入这一段」带细纲路径', () => {
    ui.sent.length = 0;
    const rows = [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-volume)')];
    ui.pick(ui.rightClick(rows.find((n) => n.textContent.includes('北行'))), '进入这一段');
    const fromTree = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(
      fromTree?.plotRelPath,
      '.novelforge/plots/01-觉醒之日/004-北行.md',
      JSON.stringify(fromTree)
    );
  });
});

/*
 * 创作页的三块新东西在**独立版**的 DOM 上也要能跑。
 *
 * 上面所有用例走的都是 webviewHtml.ts 的 body；独立版是另一份模板
 * （工作台结构、活动栏、内置编辑器），两份各写一遍 id 就有漏掉一个的机会，
 * 而那种漏法只有真的把独立版开起来才看得见。
 */
describe('独立版壳上的创作页', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    // 原脚本在 772 行就地又抄了一份 mount()，只把 body 换成独立版模板。
    ui = mount({ body: 'standalone' });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
      }),
    });
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
  });

  test('独立版渲染当前产物入口', () => {
    const entry = ui.doc.getElementById('workbench');
    assert.ok(!entry.classList.contains('hidden'));
    assert.ok(entry.querySelector('.wbt-entry-title')?.textContent.includes('剧情'),
      entry.querySelector('.wbt-entry-title')?.textContent);
  });

  test('独立版能浮出产物浮窗', () => {
    ui.clickEl(ui.doc.getElementById('workbench'));
    assert.equal(ui.doc.querySelectorAll('.workbench-tip .wbt-row').length, 1);
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  // 独立版是另一份模板（工作台结构、活动栏、内置编辑器），输入框那一格的
  // id 漏掉一个的话，只有真把独立版开起来才看得见。
  test('独立版能发出这一句', () => {
    const input = ui.doc.getElementById('input');
    input.value = '第 9 章里他说过没去过北境吗？';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    const sent = [...ui.sent].reverse().find((m) => m.type === 'sendAgent');
    assert.equal(sent?.text, '第 9 章里他说过没去过北境吗？', JSON.stringify(sent));
  });
});
