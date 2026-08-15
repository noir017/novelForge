/**
 * 创作页：流水线条与下一步、当前产物浮窗、/ 命令面板、进入某一章、独立版壳。
 *
 * 迁自 scripts/smoke-view.js 的这几节：
 *   == 创作流水线条与下一步 ==（389） == 工作区卡 ==（544）
 *   == / 命令面板 ==（617）          == 选中章节进入当前阶段 ==（720）
 *   == 独立版壳上的创作页 ==（770）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  mount, JSDOM_SKIP,
  turn, emptySession, pipelineView, sceneView, workbenchView, viewState, sampleTree,
} = require('../../helpers/dom');

describe('创作流水线条与下一步', { skip: JSDOM_SKIP }, () => {
  let ui;
  let sentStep;
  let act;
  const crumbs = () => [...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].map((n) => n.textContent);
  const stages = () => [...ui.doc.querySelectorAll('#pipelineStages .pstage')];
  const scenes = () => [...ui.doc.querySelectorAll('#pipelineScenes .pscene')];
  const lastSetTarget = () => [...ui.sent].reverse().find((m) => m.type === 'setTarget');
  const goBtn = () => ui.doc.getElementById('nextStepBtn');
  const hint = () => ui.doc.getElementById('nextStepHint').textContent;

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

  // 全书大纲阶段没有「这一段的三层」，但一样有下一步（去写大纲）。
  test('大纲阶段也给下一步', () => {
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'outline', title: '全书大纲', sections: [], empty: '这部书还没有大纲。' }),
      next: { stage: 'outline', capability: 'generate', label: '生成大纲', hint: '先定下这个故事讲什么。', target: { kind: 'outline' } },
    });
    assert.equal(goBtn().textContent, '生成大纲', goBtn().textContent);
  });

  test('下一步给出理由', () => {
    assert.ok(hint().includes('先定下'), hint());
  });

  // ---- 切到某一段的正文 ----
  test('信息条只显示段名', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'manuscript',
        capability: 'discuss',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        scenes: [sceneView(1, '踩点'), sceneView(2, '翻越侧峰', { status: 'draft', ready: false })],
        manuscript: {
          relPath: '.novelforge/manuscripts/012-夜入青云.md', words: 1200, beatsStale: true,
        },
        stage: 'manuscript',
        progress: { plot: 1, scene: 0.5, manuscript: 0.5, summary: 0 },
      }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 段《夜入青云》' }),
      next: {
        stage: 'manuscript',
        capability: 'rewrite',
        label: '重写正文',
        hint: '场景改过，现有正文可能已经与细节对不上。',
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
      },
    });
    assert.equal(crumbs().length, 1, crumbs().join('|'));
    assert.ok(crumbs()[0].includes('夜入青云'), crumbs().join('|'));
  });

  test('信息条不是按钮', () => {
    assert.ok([...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].every((n) => n.tagName === 'SPAN'));
  });

  test('展开三层状态（剧情/细节/正文）', () => {
    assert.equal(stages().length, 3, String(stages().length));
  });

  // 这一章的状态徽章：与工程页那一列同一份文案。
  test('信息条带这一章的状态徽章', () => {
    const badge = ui.doc.querySelector('#pipelineCrumb .cstage');
    assert.ok(badge, '没有徽章');
    assert.equal(badge.textContent, '待写正文', badge?.textContent);
  });

  // 三态圆点：剧情完成、细节/正文进行中——不是百分比条。
  test('剧情标成已完成', () => {
    assert.ok(stages().find((n) => n.textContent.includes('剧情')).querySelector('.pstage-mark.done'));
  });

  test('细节标成进行中', () => {
    assert.ok(stages().find((n) => n.textContent.includes('细节')).querySelector('.pstage-mark.partial'));
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

  // 正文阶段展开场景列表：写哪一场是这一层的核心选择。
  test('正文阶段列出场景', () => {
    assert.equal(scenes().length, 2, String(scenes().length));
  });

  test('没有素材的场景标成 draft', () => {
    assert.ok(scenes()[1].classList.contains('draft'));
  });

  // ---- 主按钮：点了就跑，不必先输入 ----
  test('主按钮空输入也能发', () => {
    ui.doc.getElementById('input').value = '';
    const beforeSend = ui.sent.filter((m) => m.type === 'send').length;
    ui.clickEl(goBtn());
    sentStep = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, beforeSend + 1);
  });

  test('主按钮带上状态机给的能力', () => {
    assert.equal(sentStep.payload.stage, 'manuscript', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.capability, 'rewrite', JSON.stringify(sentStep.payload));
    ui.post({ type: 'busy', value: false });
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

  test('点场景带上场号', () => {
    ui.clickEl(scenes()[1]);
    assert.equal(lastSetTarget()?.target.sceneNo, 2, JSON.stringify(lastSetTarget()));
  });

  // ---- 剧情阶段 ----
  // 场景列表在剧情阶段是噪声——这一层要决定的是整段怎么走。
  test('剧情阶段不展开场景列表', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
    assert.ok(ui.doc.getElementById('pipelineScenes').classList.contains('hidden'));
  });

  // ---- 全做完的段不催 ----
  test('没有下一步时收起主按钮', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'done', progress: { plot: 1, scene: 1, manuscript: 1, summary: 1 } }),
      workbench: workbenchView(),
      next: undefined,
    });
    assert.ok(goBtn().classList.contains('hidden'));
  });

  test('没有下一步时说明为什么', () => {
    assert.ok(hint().includes('各层都齐了'), hint());
  });

  // ---- 审阅阶段的下一步是工程动作，不是一轮对话 ----
  let beforeAct;
  test('审阅走工程动作', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'review' }),
      workbench: workbenchView(),
      next: {
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'summarizePlot',
        label: '总结这一段',
        hint: '正文齐了。',
        target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        relPath: '.novelforge/plots/012-夜入青云.md',
      },
    });
    beforeAct = ui.sent.filter((m) => m.type === 'send').length;
    ui.clickEl(goBtn());
    act = [...ui.sent].reverse().find((m) => m.type === 'projectAction');
    assert.equal(act?.action, 'summarizePlot', JSON.stringify(act));
  });

  // 段路径必须来自 next 而不是会话里的目标——后者可能还没同步，
  // 而 summarizePlot 收到 undefined 会静默什么都不做。
  test('工程动作带上段路径', () => {
    assert.equal(act?.relPath, '.novelforge/plots/012-夜入青云.md', JSON.stringify(act));
  });

  test('工程动作不占对话', () => {
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, beforeAct);
  });

  // ---- 目标换段时，上一段的进度不能留着显示 ----
  test('换段后不再显示上一段的段名', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/013-另一段.md' },
        stage: 'plot',
        capability: 'discuss',
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
        capability: 'discuss',
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

describe('/ 命令面板', { skip: JSDOM_SKIP }, () => {
  let ui;
  let input;
  /** 键盘事件。导航键（↑↓/Enter/Esc）走这条，可打印字符走 type()。 */
  const key = (k) =>
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  /**
   * 打字：改输入框的值再发 input 事件。
   *
   * 面板是**输入框内容的函数**（真实浏览器里 keydown 之后浏览器自己落值、
   * 再发 input），所以测试也必须照这个顺序模拟——从前面板自己攒过滤串，
   * 于是测试只发 keydown 就够，那也正是输入法打的中文一个都收不到的原因。
   */
  const type = (text) => {
    input.value += text;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const backspace = () => {
    input.value = input.value.slice(0, -1);
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const setValue = (text) => {
    input.value = text;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const panel = () => ui.doc.querySelector('.cmd-panel');
  const items = () => [...ui.doc.querySelectorAll('.cmd-item .cmd-label')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    input = ui.doc.getElementById('input');
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
  });

  test('默认不显示命令面板', () => {
    assert.ok(!panel());
  });

  // 打 / 唤出。
  test('打 / 唤出面板', () => {
    type('/');
    assert.ok(panel());
  });

  // Cursor 那一套：命令的字**留在输入框里**，面板只是浮在上方的候选列表。
  // 从前 `/` 被 keydown 拦下来不落进输入框，过滤串自己攒在模块变量里。
  test('斜杠留在输入框里', () => {
    assert.equal(input.value, '/');
  });

  // 面板浮在输入框那一格上（bottom: 100%），不再挂在下一步条里。
  test('面板挂在输入框那一格上', () => {
    assert.ok(ui.doc.querySelector('#composerInput .cmd-panel'));
  });

  // 剧情层比另外三层多一条 `/落定剧情`——它是唯一「先跟人聊、聊出结论
  // 再落文件」的一层，所以是八条而不是七条。
  test('剧情阶段八个命令', () => {
    assert.equal(items().length, 8, items().join('|'));
  });

  test('剧情阶段有「落定剧情」', () => {
    assert.ok(items().includes('/落定剧情'), items().join('|'));
  });

  // 面板里的名字带斜杠：挑的和打的是同一样东西。
  test('命令名带斜杠', () => {
    assert.ok(items().every((s) => s.startsWith('/')), items().join('|'));
  });

  // split 在剧情阶段拆的是场景，命令名上直说。
  test('剧情的拆分写成「拆成场景」', () => {
    assert.ok(items().includes('/拆成场景'), items().join('|'));
  });

  // 会写文件的命令与「只是聊聊」必须分得开。
  // 剧情层四条产物型命令：落定 / 写剧情 / 拆成场景 / 重写剧情。
  test('写文件的命令单独标记', () => {
    const writes = [...ui.doc.querySelectorAll('.cmd-item')].filter((n) => n.classList.contains('cmd-writes'));
    assert.equal(writes.length, 4, String(writes.length));
  });

  test('写文件的命令挂「写文件」标签', () => {
    assert.equal(ui.doc.querySelectorAll('.cmd-item .cmd-tag').length, 4);
  });

  // 键入过滤：ascii 别名与中文标签都认。
  test('按拼音首字母过滤', () => {
    type('cf');
    assert.equal(items().length, 1, items().join('|'));
    assert.equal(items()[0], '/拆成场景', items().join('|'));
  });

  test('过滤串跟着输入框走', () => {
    assert.equal(input.value, '/cf');
  });

  test('退格恢复全部', () => {
    backspace();
    backspace();
    assert.equal(items().length, 8, items().join('|'));
  });

  // 退到 `/` 之前就不是在下命令了，面板该收。
  test('删掉斜杠收起面板', () => {
    backspace();
    assert.ok(!panel());
    assert.equal(input.value, '');
  });

  // 选中 → 变成待执行 chip，不立刻发送。
  let beforePick;
  test('选中后收起面板', () => {
    type('/');
    beforePick = ui.sent.length;
    ui.clickEl([...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes('挑刺')));
    assert.ok(!panel());
  });

  test('选中不立刻发送', () => {
    assert.equal(ui.sent.length, beforePick);
  });

  test('选中变成待执行 chip', () => {
    const chip = ui.doc.querySelector('#pendingCmd .cmd-chip');
    assert.ok(chip, '没有 chip');
    assert.ok(chip.textContent.includes('挑刺'), chip?.textContent);
  });

  // chip 长在输入框**里面**：发送时用的是它的能力，它就是输入内容的一部分。
  test('chip 在输入框那一格里', () => {
    assert.ok(ui.doc.querySelector('#composerInput #pendingCmd .cmd-chip'));
  });

  // 挑中之后那几个字是用来挑命令的，不该跟着发给模型。
  test('挑中后清掉输入框里的命令文字', () => {
    assert.equal(input.value, '');
  });

  // chip 在时发送用它，而不是会话当前的能力。
  test('发送用挑中的命令', () => {
    input.value = '这里冲突太弱';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    const sent = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sent.payload.capability, 'critique', JSON.stringify(sent.payload));
  });

  test('发完清掉 chip', () => {
    assert.ok(ui.doc.getElementById('pendingCmd').classList.contains('hidden'));
    ui.post({ type: 'busy', value: false });
  });

  // `/` 在中文正文里是普通字符（日期、比值、网址），只有「整个输入框就是一个
  // /词」才算在下命令。
  test('正文里的 / 不唤出面板', () => {
    setValue('子时 3/4 刻');
    assert.ok(!panel());
  });

  test('斜杠后带空格不算命令', () => {
    setValue('/ 这是一句话');
    assert.ok(!panel());
  });

  // 「/ 命令」按钮：与键盘走同一条路——输入框为空时顺手把 / 打进去。
  test('按钮唤出面板', () => {
    setValue('');
    ui.clickEl(ui.doc.getElementById('cmdBtn'));
    assert.ok(panel());
    assert.equal(input.value, '/');
  });

  test('按钮再点一次收起', () => {
    ui.clickEl(ui.doc.getElementById('cmdBtn'));
    assert.ok(!panel());
  });

  // Esc 收起，且不会因为输入框里那个 / 还在就立刻弹回来。
  test('Esc 收起面板', () => {
    setValue('');
    type('/');
    assert.ok(panel());
    key('Escape');
    assert.ok(!panel());
  });

  test('Esc 之后继续打字不再弹回来', () => {
    type('c');
    assert.ok(!panel());
  });

  // 生成中面板该收起：一个点不动的候选列表挂在那儿只会挡住消息流。
  test('生成中收起面板并禁用按钮', () => {
    setValue('');
    type('/');
    assert.ok(panel());
    ui.post({ type: 'busy', value: true });
    assert.ok(!panel());
    assert.ok(ui.doc.getElementById('cmdBtn').disabled);
    ui.post({ type: 'busy', value: false });
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

  // 工程页点章名是「进入这一章」——由后端的状态机决定落在哪一层。
  // 带的是**主路径**：已发布的章指成品，只有规划的章指细纲。
  test('工程页点已发布的章名进入这一章', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const row = ui.doc.querySelector('#projectBody .row-plot .row-label');
    ui.clickEl(row);
    const fromTree = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(fromTree?.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(fromTree));
  });

  test('工程页点只有规划的章名带细纲路径', () => {
    ui.sent.length = 0;
    const rows = [...ui.doc.querySelectorAll('#projectBody .row-plot .row-label')];
    ui.clickEl(rows.find((n) => n.textContent.includes('入镇')));
    const fromTree = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(fromTree?.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(fromTree));
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
        capability: 'discuss',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView(),
      next: {
        stage: 'plot',
        capability: 'split',
        label: '拆成场景',
        hint: '把这一段拆成 3~6 个能独立开写的场景。',
        target: { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' },
      },
    });
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

  test('独立版渲染主按钮', () => {
    assert.equal(ui.doc.getElementById('nextStepBtn').textContent, '拆成场景',
      ui.doc.getElementById('nextStepBtn').textContent);
  });

  test('独立版能唤出命令面板', () => {
    const input = ui.doc.getElementById('input');
    input.value = '/';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.ok(ui.doc.querySelector('#composerInput .cmd-panel'));
  });

  test('独立版主按钮可发', () => {
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('nextStepBtn'));
    const sentStep = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sentStep?.payload.capability, 'split', JSON.stringify(sentStep));
  });
});
