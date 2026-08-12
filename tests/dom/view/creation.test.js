/**
 * 创作页：流水线条与下一步、工作区卡、/ 命令面板、进章节、独立版壳。
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

  test('大纲阶段面包屑只有一级', () => {
    assert.deepEqual(crumbs(), ['全书大纲'], crumbs().join('|'));
  });

  test('大纲阶段收起四段进度', () => {
    assert.ok(ui.doc.getElementById('pipelineStages').classList.contains('hidden'));
  });

  // 全书大纲阶段没有「这一章的四段」，但一样有下一步（去写大纲）。
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

  // ---- 切到某一章的正文 ----
  test('面包屑补出章节这一级', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'manuscript', chapterRelPath: 'chapters/012-夜入青云.md' },
        stage: 'manuscript',
        capability: 'discuss',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        scenes: [sceneView(1, '踩点'), sceneView(2, '翻越侧峰', { status: 'draft', ready: false })],
        manuscript: { words: 1200, beatsStale: true },
        stage: 'manuscript',
        progress: { plan: 1, scene: 0.5, manuscript: 0.5, summary: 0 },
      }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青云》' }),
      next: {
        stage: 'manuscript',
        capability: 'rewrite',
        label: '重写正文',
        hint: '场景改过，现有正文可能已经与细节对不上。',
        target: { kind: 'manuscript', chapterRelPath: 'chapters/012-夜入青云.md' },
      },
    });
    assert.equal(crumbs().length, 2, crumbs().join('|'));
    assert.ok(crumbs()[1].includes('夜入青云'), crumbs().join('|'));
  });

  test('展开三段进度（细纲/场景/正文）', () => {
    assert.equal(stages().length, 3, String(stages().length));
  });

  // 章节状态徽章：与工程页那一列同一份文案。
  test('面包屑带章节状态徽章', () => {
    const badge = ui.doc.querySelector('#pipelineCrumb .cstage');
    assert.ok(badge, '没有徽章');
    assert.equal(badge.textContent, '待写正文', badge?.textContent);
  });

  // 上游变过的那一段挂 ⟳。这是整条流水线最有价值的一格信息。
  test('正文段标出上游已变更', () => {
    const manuscriptStage = stages().find((n) => n.textContent.includes('正文'));
    assert.ok(manuscriptStage.querySelector('.pstage-stale'));
  });

  test('细纲段没有变更标记', () => {
    assert.ok(!stages().find((n) => n.textContent.includes('细纲')).querySelector('.pstage-stale'));
  });

  // 正文阶段展开场景列表：写哪一场是这一层的核心选择。
  test('正文阶段列出场景', () => {
    assert.equal(scenes().length, 2, String(scenes().length));
  });

  test('没填必须发生的场景标成 draft', () => {
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

  // ---- 点击切目标 ----
  test('点细纲段发出 setTarget', () => {
    ui.clickEl(stages().find((n) => n.textContent.includes('细纲')));
    assert.equal(lastSetTarget()?.target.kind, 'plan', JSON.stringify(lastSetTarget()));
  });

  test('切层保留当前章节', () => {
    assert.equal(lastSetTarget()?.target.chapterRelPath, 'chapters/012-夜入青云.md');
  });

  test('点场景带上场号', () => {
    ui.clickEl(scenes()[1]);
    assert.equal(lastSetTarget()?.target.sceneNo, 2, JSON.stringify(lastSetTarget()));
  });

  test('点面包屑第一级回到大纲', () => {
    ui.clickEl(ui.doc.querySelectorAll('#pipelineCrumb .crumb')[0]);
    assert.equal(lastSetTarget()?.target.kind, 'outline');
  });

  // ---- 细纲阶段 ----
  // 场景列表在细纲阶段是噪声——这一层要决定的是整章怎么走。
  test('细纲阶段不展开场景列表', () => {
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plan', chapterRelPath: 'chapters/012-夜入青云.md' },
        stage: 'plan',
        capability: 'discuss',
      }),
    });
    assert.ok(ui.doc.getElementById('pipelineScenes').classList.contains('hidden'));
  });

  // ---- 全做完的章节不催 ----
  test('没有下一步时收起主按钮', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'done', progress: { plan: 1, scene: 1, manuscript: 1, summary: 1 } }),
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
        projectAction: 'summarizeChapter',
        label: '总结本章',
        hint: '正文齐了。',
        target: { kind: 'manuscript', chapterRelPath: 'chapters/012-夜入青云.md' },
        order: 12,
      },
    });
    beforeAct = ui.sent.filter((m) => m.type === 'send').length;
    ui.clickEl(goBtn());
    act = [...ui.sent].reverse().find((m) => m.type === 'projectAction');
    assert.equal(act?.action, 'summarizeChapter', JSON.stringify(act));
  });

  // 序号必须来自 next 而不是会话里的 targetOrder——后者可能还没同步，
  // 而 summarizeChapter 收到 undefined 会静默什么都不做。
  test('工程动作带上章号', () => {
    assert.equal(act?.order, 12, JSON.stringify(act));
  });

  test('工程动作不占对话', () => {
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, beforeAct);
  });

  // ---- 目标换章时，上一章的进度不能留着显示 ----
  test('换章后不再显示上一章的章名', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plan', chapterRelPath: 'chapters/013-另一章.md' },
        stage: 'plan',
        capability: 'discuss',
      }),
    });
    assert.ok(!crumbs().some((c) => c.includes('夜入青云')), crumbs().join('|'));
  });
});

describe('工作区卡', { skip: JSDOM_SKIP }, () => {
  let ui;
  const box = () => ui.doc.getElementById('workbench');
  const rows = () => [...box().querySelectorAll('.wb-row')].map((n) => n.textContent);

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
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({
        stage: 'scene',
        title: '场景 2 翻越侧峰 · 第 12 章《夜入青云》',
        relPath: '.novelforge/scenes/012-夜入青云/02-翻越侧峰.md',
        sections: [
          { key: '这一幕', text: '青云宗侧峰 · 子时，暴雨 · 林昭' },
          { key: '必须发生', text: '- 林昭决定翻墙\n- 差点被巡逻弟子发现' },
        ],
      }),
    });
  });

  test('工作区卡显示出来', () => {
    assert.ok(!box().classList.contains('hidden'));
  });

  test('卡片标题说清在改哪一层', () => {
    assert.ok(box().querySelector('.wb-title').textContent.includes('场景 2'),
      box().querySelector('.wb-title')?.textContent);
  });

  test('摊开产物的小节', () => {
    assert.equal(rows().length, 2, rows().join('|'));
  });

  test('「必须发生」逐条可见', () => {
    assert.ok(rows()[1].includes('林昭决定翻墙') && rows()[1].includes('差点被'), rows()[1]);
  });

  // 「打开」走的是既有的开文件通道（插件里是 openFile）。
  test('点打开发出开文件消息', () => {
    ui.clickEl(box().querySelector('.wb-open'));
    const opened = [...ui.sent].reverse().find((m) => m.type === 'openFile' || m.type === 'openEditor');
    assert.equal(opened?.path, '.novelforge/scenes/012-夜入青云/02-翻越侧峰.md', JSON.stringify(opened));
  });

  // 收起/展开由用户自己控制。
  test('可以收起', () => {
    ui.clickEl(box().querySelector('.wb-toggle'));
    assert.ok(box().classList.contains('collapsed'));
    assert.equal(rows().length, 0);
  });

  test('可以再展开', () => {
    ui.clickEl(box().querySelector('.wb-toggle'));
    assert.ok(!box().classList.contains('collapsed'));
    assert.equal(rows().length, 2);
  });

  // 上游变更在卡片上是一句人话，不只是流水线条上那个 ⟳。
  test('上游变更给一句人话', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'scene', warning: '本章细纲在这一场之后改过。' }),
    });
    assert.ok(box().querySelector('.wb-warning')?.textContent.includes('细纲在这一场之后改过'),
      box().querySelector('.wb-warning')?.textContent);
  });

  // 这一层还没有产物时说清缺什么，不要留一张空卡。
  test('没有产物时说明缺什么', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'plan', sections: [], empty: '这一章还没有细纲。' }),
    });
    assert.equal(box().querySelector('.wb-empty')?.textContent, '这一章还没有细纲。',
      box().querySelector('.wb-empty')?.textContent);
  });

  test('没有产物时不画小节', () => {
    assert.equal(rows().length, 0);
  });
});

describe('/ 命令面板', { skip: JSDOM_SKIP }, () => {
  let ui;
  let input;
  const key = (k) =>
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const panel = () => ui.doc.querySelector('.cmd-panel');
  const items = () => [...ui.doc.querySelectorAll('.cmd-item .cmd-label')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    input = ui.doc.getElementById('input');
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plan', chapterRelPath: 'chapters/012-夜入青云.md' },
        stage: 'plan',
        capability: 'discuss',
      }),
    });
  });

  test('默认不显示命令面板', () => {
    assert.ok(!panel());
  });

  // 输入框为空时按 / 唤出。
  test('空输入框按 / 唤出面板', () => {
    key('/');
    assert.ok(panel());
  });

  test('细纲阶段七个命令', () => {
    assert.equal(items().length, 7, items().join('|'));
  });

  // split 在细纲阶段拆的是场景，命令名上直说。
  test('细纲的拆分写成「拆成场景」', () => {
    assert.ok(items().includes('拆成场景'), items().join('|'));
  });

  // 会写文件的命令与「只是聊聊」必须分得开。
  test('写文件的命令单独标记', () => {
    const writes = [...ui.doc.querySelectorAll('.cmd-item')].filter((n) => n.classList.contains('cmd-writes'));
    assert.equal(writes.length, 3, String(writes.length));
  });

  // 键入过滤：ascii 别名与中文标签都认。
  test('按拼音首字母过滤', () => {
    key('c');
    key('f');
    assert.equal(items().length, 1, items().join('|'));
    assert.equal(items()[0], '拆成场景', items().join('|'));
  });

  test('退格恢复全部', () => {
    key('Backspace');
    key('Backspace');
    assert.equal(items().length, 7, items().join('|'));
  });

  // 选中 → 变成待执行 chip，不立刻发送。
  let beforePick;
  test('选中后收起面板', () => {
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

  // 输入框非空时 / 是普通字符（日期、比值、网址里都有）。
  test('输入框非空时 / 不唤出面板', () => {
    input.value = '子时 3/4 刻';
    key('/');
    assert.ok(!panel());
  });

  // Esc 收起。
  test('再次唤出', () => {
    input.value = '';
    key('/');
    assert.ok(panel());
  });

  test('Esc 收起面板', () => {
    key('Escape');
    assert.ok(!panel());
  });
});

describe('选中章节进入当前阶段', { skip: JSDOM_SKIP }, () => {
  let ui;
  let select;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'state',
      state: viewState({
        chapters: [{ order: 12, title: '夜入青云', wordCount: 0, relPath: 'chapters/012-夜入青云.md' }],
        nextOrder: 13,
      }),
    });
    select = ui.doc.getElementById('targetSelect');
  });

  // 下拉框选一章 = 进入那一章当前该做的那一步，由后端的状态机判定。
  // 旧版一律发 setTarget({kind:'manuscript'})，于是选中一个连细纲都没有的
  // 章节，界面直接把作者丢进正文层。
  test('选章节发 selectChapter', () => {
    select.value = '12';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const picked = [...ui.sent].reverse().find((m) => m.type === 'selectChapter');
    assert.equal(picked?.chapterRelPath, 'chapters/012-夜入青云.md', JSON.stringify(picked));
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

  // 工程页点章节名也是「进入这一章」，不是打开文件。
  test('工程页点章节名进入这一章', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const row = ui.doc.querySelector('#projectBody .row-chapter .row-label');
    ui.clickEl(row);
    const fromTree = [...ui.sent].reverse().find((m) => m.type === 'selectChapter');
    assert.equal(fromTree?.chapterRelPath, 'chapters/001-楔子.md', JSON.stringify(fromTree));
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
        target: { kind: 'plan', chapterRelPath: 'chapters/012-夜入青云.md' },
        stage: 'plan',
        capability: 'discuss',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView(),
      next: {
        stage: 'plan',
        capability: 'split',
        label: '拆成场景',
        hint: '把这一章拆成 3~6 个能独立开写的场景。',
        target: { kind: 'plan', chapterRelPath: 'chapters/012-夜入青云.md' },
      },
    });
  });

  test('独立版渲染工作区卡', () => {
    assert.ok(!ui.doc.getElementById('workbench').classList.contains('hidden'));
    assert.equal(ui.doc.querySelectorAll('#workbench .wb-row').length, 1);
  });

  test('独立版渲染主按钮', () => {
    assert.equal(ui.doc.getElementById('nextStepBtn').textContent, '拆成场景',
      ui.doc.getElementById('nextStepBtn').textContent);
  });

  test('独立版能唤出命令面板', () => {
    const input = ui.doc.getElementById('input');
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    assert.ok(ui.doc.querySelector('#nextStep .cmd-panel'));
  });

  test('独立版主按钮可发', () => {
    ui.clickEl(ui.doc.getElementById('nextStepBtn'));
    const sentStep = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sentStep?.payload.capability, 'split', JSON.stringify(sentStep));
  });
});
