/**
 * 空状态写出下一步（W12）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 章节组 | 空分组、以及「下一章还没有细纲那一行」时写出全书的下一步（与主按钮同一句话）；按钮不直接花钱 |
 * | 角色组 | 全书下一步正是角色图谱时说它；老工程（已有正文）给「提取角色卡…」；否则只说清从哪来 |
 * | 设定组 | 不说「下一步」（设定是可选的）；「＋ 设定」不调模型；有正文时多一颗「从正文生成…」 |
 * | 对话页 · 还不是小说工程 | 消息区换成「下一步：初始化」那一块，按钮与工程页那颗同一个动作；页脚不再写 VS Code 命令名 |
 * | 历史页 | 空列表给「去对话页」 |
 *
 * 「按钮不直接花钱」是第 20 条的延伸：全书只推一个下一步，花钱的那一下在主按钮或写着调用次数的
 * 弹窗 / 确认框上。所以这里每一颗按钮都断言**没有发 `send`**。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, sampleTree, viewState } = require('../../helpers/dom');

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const hintIn = (ui, name) => groupOf(ui, name).querySelector('.row-empty');
const buttonsIn = (node) => [...node.querySelectorAll('button')].map((b) => b.textContent);
const buttonIn = (node, label) => [...node.querySelectorAll('button')].find((b) => b.textContent === label);
const formOpen = (ui) => !ui.doc.getElementById('providerModal').classList.contains('hidden');
const closeForm = (ui) =>
  ui.doc.querySelector('.nf-form')?.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** 全书那一档的下一步，形状同 `bookStepView` 的产出。 */
const STEPS = {
  config: {
    stage: 'setting',
    capability: 'generate',
    label: '生成小说配置',
    hint: '先把这个脑洞展开成一份小说配置。',
    target: { kind: 'setting', doc: 'config' },
    form: 'idea',
    calls: { low: 1, high: 1, max: 3 },
    formDefaults: { idea: '少年入宗', totalChapters: 60, wordsPerChapter: 2500, configHasContent: true },
  },
  premise: {
    stage: 'setting',
    capability: 'generate',
    label: '生成故事前提',
    hint: '',
    target: { kind: 'setting', doc: 'premise' },
    calls: { low: 1, high: 1, max: 1 },
  },
  characters: {
    stage: 'setting',
    capability: 'generate',
    label: '生成角色图谱',
    hint: '',
    target: { kind: 'setting', doc: 'characters' },
    calls: { low: 2, high: 4, max: 6 },
  },
  plots: {
    stage: 'plot',
    capability: 'generate',
    label: '拆细纲（第 1–5 章）',
    hint: '',
    range: { from: 1, to: 5 },
    target: { kind: 'plot', plotRelPath: '.novelforge/plots/001.md' },
    no: 1,
    calls: { low: 1, high: 1, max: 4 },
  },
};

/** 一棵空白的工程页快照：章节、角色、设定三组都空着。 */
const blankTree = (extra) => ({
  ...sampleTree(),
  plots: [],
  plotCount: 0,
  chapterCount: 0,
  totalWords: 0,
  characters: [],
  lore: [],
  cast: [],
  castByCard: {},
  ...extra,
});

describe('W12 · 章节组写出全书的下一步', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('空分组：「下一步：」后面就是主按钮那一句', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    assert.equal(hintIn(ui, '章节').querySelector('.row-hint-text').textContent, '下一步：生成故事前提');
  });

  test('架构那几件：「去生成」进入那一层，不发 send', () => {
    ui.sent.length = 0;
    ui.clickEl(buttonIn(hintIn(ui, '章节'), '去生成'));
    assert.deepEqual(ui.last('setTarget')?.target, { kind: 'setting', doc: 'premise' });
    assert.ok(!ui.last('send'), JSON.stringify(ui.sent));
  });

  test('小说配置：「去生成」打开一句话弹窗，默认值是后端给的', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.config }) });
    ui.sent.length = 0;
    ui.clickEl(buttonIn(hintIn(ui, '章节'), '去生成'));
    assert.ok(formOpen(ui));
    assert.equal(ui.doc.querySelector('.nf-form [data-key="idea"]').value, '少年入宗');
    assert.ok(!ui.last('send') && !ui.last('setTarget'), JSON.stringify(ui.sent));
    closeForm(ui);
  });

  test('拆细纲：「拆细纲…」打开拆细纲弹窗（调用次数写在弹窗上）', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.plots }) });
    ui.sent.length = 0;
    const row = hintIn(ui, '章节');
    assert.equal(row.querySelector('.row-hint-text').textContent, '下一步：拆细纲（第 1–5 章）');
    ui.clickEl(buttonIn(row, '拆细纲…'));
    assert.ok(formOpen(ui));
    assert.ok(!ui.last('send') && !ui.last('projectAction'), JSON.stringify(ui.sent));
    closeForm(ui);
  });

  // 没有 next（老快照、或者全书写完了）：退回原来那句，不画一个空的「下一步：」。
  test('没有下一步时退回原来的说明', () => {
    ui.post({ type: 'project', tree: blankTree() });
    const row = hintIn(ui, '章节');
    assert.ok(row.textContent.includes('故事架构') && !row.textContent.startsWith('下一步'), row.textContent);
    assert.deepEqual(buttonsIn(row), []);
  });

  // 章节不空，但下一章那一行还不存在（拆细纲那一档）：「去写这一章」挂不上，组末补一句。
  test('下一章还没有细纲那一行时，组末写出下一步', () => {
    const tree = sampleTree();
    const plots = tree.plots.filter((p) => p.no < tree.nextChapterNo);
    ui.post({
      type: 'project',
      tree: { ...tree, plots, next: { ...STEPS.plots, label: `拆细纲（第 ${tree.nextChapterNo}–8 章）` } },
    });
    const rows = [...groupOf(ui, '章节').querySelectorAll('.row-plot, .row-next-step')];
    assert.ok(rows[rows.length - 1].classList.contains('row-next-step'), rows.map((r) => r.className).join('|'));
    assert.ok(rows[rows.length - 1].textContent.startsWith(`下一步：拆细纲（第 ${tree.nextChapterNo}–8 章）`));
  });

  // 下一章那一行在：它自己带「去写这一章」，不再多说一句。
  test('下一章那一行在时不加「下一步」', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), next: STEPS.plots } });
    assert.equal(groupOf(ui, '章节').querySelector('.row-next-step'), null);
  });
});

describe('W12 · 角色组', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('全书下一步正是角色图谱：说它，「去生成」进入那一层', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.characters }) });
    const row = hintIn(ui, '角色');
    assert.equal(row.querySelector('.row-hint-text').textContent, '下一步：生成角色图谱');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '去生成'));
    assert.deepEqual(ui.last('setTarget')?.target, { kind: 'setting', doc: 'characters' });
    assert.ok(!ui.last('send'));
  });

  // 第 20 条：全书只推一个下一步。下一步是别的东西时，这里不另起一个「下一步」。
  test('下一步是别的时只说清角色卡从哪来，不给按钮', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    const row = hintIn(ui, '角色');
    assert.ok(!row.textContent.startsWith('下一步') && row.textContent.includes('角色图谱'), row.textContent);
    assert.deepEqual(buttonsIn(row), []);
  });

  test('已经写过正文（老工程）：「提取角色卡…」走自带确认框的工程动作', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.config, totalWords: 30000 }) });
    const row = hintIn(ui, '角色');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '提取角色卡…'));
    assert.equal(ui.last('projectAction')?.action, 'extractCharacters');
    assert.ok(!ui.last('send'));
  });
});

describe('W12 · 设定组', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  // 设定条目是可选的：不说「下一步」，说清它是什么、什么时候用得上。
  test('还没写正文：只有「＋ 设定」，不调模型', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    const row = hintIn(ui, '设定');
    assert.ok(!row.textContent.startsWith('下一步'), row.textContent);
    assert.deepEqual(buttonsIn(row), ['＋ 设定']);
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '＋ 设定'));
    assert.equal(ui.last('projectAction')?.action, 'newLore');
  });

  test('已经写过正文：多一颗「从正文生成…」', () => {
    ui.post({ type: 'project', tree: blankTree({ totalWords: 12000 }) });
    const row = hintIn(ui, '设定');
    assert.deepEqual(buttonsIn(row), ['＋ 设定', '从正文生成…']);
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '从正文生成…'));
    assert.equal(ui.last('projectAction')?.action, 'generateLore');
  });
});

describe('W12 · 对话页：还不是小说工程', { skip: JSDOM_SKIP }, () => {
  let ui;
  const messages = () => ui.doc.getElementById('messages');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'state', state: viewState({ initialized: false }) });
  });

  test('消息区换成「下一步：初始化」那一块', () => {
    assert.ok(messages().classList.contains('uninit'));
    const hint = ui.doc.getElementById('initHint');
    assert.ok(hint && messages().contains(hint));
    assert.ok(hint.textContent.includes('下一步：把这个文件夹初始化成小说工程'), hint.textContent);
  });

  // 从前写「先运行「Novel: 初始化小说工程」」——那是 VS Code 的命令名，独立版里找不到。
  test('页脚不再写 VS Code 的命令名', () => {
    const meta = ui.doc.getElementById('providerMeta').textContent;
    assert.ok(!meta.includes('Novel:'), meta);
  });

  test('按钮与工程页那颗「初始化小说工程」同一个动作', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.getElementById('initProjectBtn'));
    assert.equal(ui.last('projectAction')?.action, 'initProject');
  });

  // 重画会话（innerHTML 清空）之后那一块还在。
  test('换会话之后那一块仍在消息区里', () => {
    ui.post({ type: 'session', session: emptySession() });
    assert.ok(messages().contains(ui.doc.getElementById('initHint')));
  });

  test('初始化之后收起来', () => {
    ui.post({ type: 'state', state: viewState({ initialized: true }) });
    assert.ok(!messages().classList.contains('uninit'));
  });
});

describe('W12 · 历史页没有会话', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'sessions', list: [] });
  });

  test('说清会话从哪来，给「去对话页」', () => {
    const li = ui.doc.querySelector('#sessionList li.history-empty');
    assert.ok(li && li.textContent.includes('发出第一条消息后会自动保存'), li && li.textContent);
    assert.deepEqual(buttonsIn(li), ['去对话页']);
  });

  test('点了切到对话页', () => {
    ui.sent.length = 0;
    ui.clickEl(buttonIn(ui.doc.querySelector('#sessionList li.history-empty'), '去对话页'));
    assert.equal(ui.last('switchTab')?.tab, 'chat');
    assert.ok(ui.doc.getElementById('pane-chat').classList.contains('active'));
  });
});
