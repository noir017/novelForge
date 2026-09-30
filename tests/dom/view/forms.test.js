/**
 * 两个弹窗（W3 表单 · W4 一句话 · W5 拆细纲）与主按钮上的调用次数。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 一句话 · 主按钮 | 「生成小说配置」打开表单而不直接发送；默认值来自后端；提交发 send 带 setup、切到对话页 |
 * | 一句话 · 校验 | 脑洞空着不许提交；全书字数实时算；Esc 关掉什么都不发 |
 * | 拆细纲 | 缺省区间、实时说明（跳过几章、分几批、预计与最多几次）与后端同一个纯函数；提交带 confirmed |
 * | 拆细纲 · 越界 | 超出大纲覆盖时不许提交，并说清先续写大纲 |
 * | 调用次数 | 主按钮提示后面写「预计 1 次调用，最多 15 次」（第 4 条） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, workbenchView, sampleTree } = require('../../helpers/dom');

const modal = (ui) => ui.doc.getElementById('providerModal');
const isOpen = (ui) => !modal(ui).classList.contains('hidden');
const note = (ui) => ui.doc.querySelector('.nf-form .form-note')?.textContent ?? '';
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot button.primary');
function type(ui, key, value) {
  const input = field(ui, key);
  input.value = String(value);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
function key(ui, target, k, extra = {}) {
  target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
}

describe('一句话弹窗 · 从主按钮打开', { skip: JSDOM_SKIP }, () => {
  let ui;
  const goBtn = () => ui.doc.getElementById('nextStepBtn');
  const hint = () => ui.doc.getElementById('nextStepHint').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'setting', title: '架构 · 小说配置' }),
      next: {
        stage: 'setting',
        capability: 'generate',
        label: '生成小说配置',
        hint: '先把这个脑洞展开成一份小说配置。',
        target: { kind: 'setting', doc: 'config' },
        form: 'idea',
        calls: { low: 1, high: 1, max: 3 },
        formDefaults: { idea: '少年入宗', totalChapters: 60, wordsPerChapter: 2500, configHasContent: true },
      },
    });
  });

  test('主按钮写明要先填表，提示里带调用次数', () => {
    assert.equal(goBtn().textContent, '生成小说配置…');
    assert.ok(hint().includes('（预计 1 次调用，最多 3 次）'), hint());
  });

  test('点主按钮打开表单，不直接发送', () => {
    ui.sent.length = 0;
    ui.clickEl(goBtn());
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });

  test('默认值来自后端：一句话原文与规模', () => {
    assert.equal(field(ui, 'idea').value, '少年入宗');
    assert.equal(field(ui, 'totalChapters').value, '60');
    assert.equal(field(ui, 'wordsPerChapter').value, '2500');
  });

  // 后端就是这么合的：配置写过东西时保留原文、生成的追加在后。
  test('配置已有内容时明说「保留原文，追加生成」', () => {
    assert.ok(ui.doc.querySelector('.nf-form .form-lead').textContent.includes('保留原文'));
  });

  test('全书字数实时算', () => {
    assert.ok(note(ui).includes('全书约 15 万字'), note(ui));
    type(ui, 'totalChapters', 100);
    type(ui, 'wordsPerChapter', 3000);
    assert.ok(note(ui).includes('全书约 30 万字'), note(ui));
  });

  test('Ctrl+Enter 提交：切到对话页，发 send 带 setup', () => {
    ui.sent.length = 0;
    type(ui, 'idea', '一个从火里活下来的人回到起火的地方');
    key(ui, field(ui, 'idea'), 'Enter', { ctrlKey: true });
    const send = ui.last('send');
    assert.ok(send, JSON.stringify(ui.sent));
    assert.equal(send.payload.text, '一个从火里活下来的人回到起火的地方');
    assert.equal(send.payload.stage, 'setting');
    assert.equal(JSON.stringify(send.payload.target), JSON.stringify({ kind: 'setting', doc: 'config' }));
    assert.equal(JSON.stringify(send.payload.setup), JSON.stringify({ totalChapters: 100, wordsPerChapter: 3000 }));
    assert.equal(ui.last('switchTab')?.tab, 'chat');
    assert.ok(!isOpen(ui));
    ui.post({ type: 'busy', value: false });
  });
});

describe('一句话弹窗 · 校验与关闭', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'project', tree: sampleTree() });
    // 故事架构组右键「从一句话生成小说配置…」也能打开它。
    const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '故事架构');
    ui.pick(ui.rightClick(head), '从一句话生成小说配置…');
  });

  test('从工程页也能打开，默认值来自工程页快照', () => {
    assert.ok(isOpen(ui));
    assert.equal(field(ui, 'idea').value, '一个从火里活下来的人回到起火的地方。');
    assert.equal(field(ui, 'totalChapters').value, '30');
  });

  test('脑洞空着不许提交，并说清为什么', () => {
    type(ui, 'idea', '');
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('还空着'), note(ui));
  });

  test('规模越界不许提交', () => {
    type(ui, 'idea', '少年入宗');
    type(ui, 'totalChapters', 0);
    assert.ok(submitBtn(ui).disabled, note(ui));
    type(ui, 'totalChapters', 30);
    assert.ok(!submitBtn(ui).disabled, note(ui));
  });

  test('Esc 关掉，什么都不发', () => {
    ui.sent.length = 0;
    key(ui, ui.doc, 'Escape');
    assert.ok(!isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });
});

describe('拆细纲弹窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const toolbarBtn = () => ui.doc.querySelector('#projectToolbar [data-form="plotBatch"]');

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    ui.clickEl(toolbarBtn());
  });

  test('工具栏上有「补齐设定」「拆细纲…」', () => {
    assert.ok(toolbarBtn());
    assert.equal(ui.doc.querySelector('#projectToolbar [data-action="completeSettings"]')?.textContent, '补齐设定');
  });

  // 下一可写章是第 4 章，缺省拆 5 章，不越过大纲覆盖（20）与总章数（30）。
  test('缺省区间是下一可写章起 5 章', () => {
    assert.ok(isOpen(ui));
    assert.equal(field(ui, 'from').value, '4');
    assert.equal(field(ui, 'to').value, '8');
  });

  // 第 4 章排过细纲：跳过它，第 5–8 章一批。与后端 planPlotBatches 同一个算法。
  test('实时说明：拆几章、跳过几章、分几批、预计与最多', () => {
    assert.ok(note(ui).includes('要拆 4 章，分 1 批（每批最多 5 章），跳过已有细纲的 1 章'), note(ui));
    assert.ok(note(ui).includes('预计 1 次调用，最多 12 次'), note(ui));
  });

  test('改区间说明跟着变', () => {
    type(ui, 'from', 1);
    type(ui, 'to', 12);
    // 第 1、3、4 章排过：2 一批，5–9 一批，10–12 一批。
    assert.ok(note(ui).includes('要拆 9 章，分 3 批') && note(ui).includes('预计 3 次调用，最多 27 次'), note(ui));
  });

  test('超出大纲覆盖不许提交，说清先续写大纲', () => {
    type(ui, 'to', 25);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('只覆盖到第 20 章'), note(ui));
  });

  test('这一段都排过时不许提交', () => {
    type(ui, 'from', 3);
    type(ui, 'to', 4);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('都已经排过细纲了'), note(ui));
  });

  // 弹窗已经报过调用次数：带 confirmed，后端不再弹第二个确认框（不叠弹窗）。
  test('提交发 generatePlots，带区间与 confirmed', () => {
    type(ui, 'from', 5);
    type(ui, 'to', 9);
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.ok(msg, JSON.stringify(ui.sent));
    assert.equal(msg.action, 'generatePlots');
    assert.equal(JSON.stringify(msg.range), JSON.stringify({ from: 5, to: 9 }));
    assert.equal(msg.confirmed, true);
    assert.ok(!isOpen(ui));
  });

  test('章节组右键「批量拆细纲…」打开同一个弹窗', () => {
    const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章节');
    ui.sent.length = 0;
    ui.pick(ui.rightClick(head), '批量拆细纲…');
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
    key(ui, ui.doc, 'Escape');
  });

  test('「补齐设定」发 completeSettings（后端先问）', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('#projectToolbar [data-action="completeSettings"]'));
    assert.equal(ui.last('projectAction')?.action, 'completeSettings', JSON.stringify(ui.sent));
  });
});

describe('故事架构 · 第一件没填的是小说配置时', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    const tree = sampleTree();
    tree.architecture = tree.architecture.map((a) => ({ ...a, filled: a.key === 'outline' ? false : a.key !== 'config' && a.filled }));
    tree.book = { ...tree.book, configHasContent: false, idea: '' };
    ui.post({ type: 'project', tree });
  });

  // 配置要作者先给一句话：「去生成」直接打开一句话弹窗，不绕去对话页。
  test('「去生成」打开一句话弹窗', () => {
    const go = [...ui.doc.querySelectorAll('#projectBody .row-architecture .row-go')];
    assert.equal(go.length, 1);
    ui.sent.length = 0;
    ui.clickEl(go[0]);
    assert.ok(isOpen(ui));
    assert.ok(ui.doc.querySelector('.nf-form .form-lead').textContent.includes('写下你的脑洞'));
    assert.ok(!ui.sent.some((m) => m.type === 'setTarget' || m.type === 'send'), JSON.stringify(ui.sent));
  });
});

/**
 * 批量写章弹窗（四期，W9）：区间、模式、调用上限与后端同一个 `planWriteBatch`；
 * 「写完即定稿」要点两下（按钮文案两段式，不叠弹窗）。
 *
 * sampleTree：第 1–3 章有正文，第 1、3、4 章排过细纲，下一可写章是第 4 章。
 */
describe('批量写章弹窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const toolbarBtn = () => ui.doc.querySelector('#projectToolbar [data-form="writeBatch"]');
  function choose(value) {
    const sel = field(ui, 'mode');
    sel.value = value;
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  }

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    ui.clickEl(toolbarBtn());
  });

  test('工具栏上有「批量写章…」，点了打开弹窗', () => {
    assert.equal(toolbarBtn()?.textContent, '批量写章…');
    assert.ok(isOpen(ui));
  });

  test('缺省从下一可写章起 3 章、只写正文', () => {
    assert.equal(field(ui, 'from').value, '4');
    assert.equal(field(ui, 'to').value, '6');
    assert.equal(field(ui, 'mode').value, 'draft');
  });

  // 第 5 章没排细纲：写到第 4 章为止。上限含自动续写（一章最多 8 次）。
  test('实时说明：写几章、在哪收住、预计与最多', () => {
    assert.ok(note(ui).includes('要写 1 章（第 4 章）；第 5 章还没有细纲，写到它前面为止。'), note(ui));
    assert.ok(note(ui).includes('预计 1 次调用，最多 8 次'), note(ui));
  });

  test('一次最多 10 章', () => {
    type(ui, 'from', 1);
    type(ui, 'to', 11);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('一次最多写 10 章'), note(ui));
  });

  test('这一段都写过了不许提交', () => {
    type(ui, 'to', 3);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('都已经写过正文了'), note(ui));
  });

  test('写完即定稿：说明里加上定稿那几次', () => {
    type(ui, 'from', 4);
    type(ui, 'to', 6);
    choose('finalize');
    assert.ok(note(ui).includes('预计 2–3 次调用，最多 10 次'), note(ui));
    assert.ok(note(ui).includes('每写完一章就定稿'), note(ui));
  });

  test('写完即定稿要点两下：第一下只换字，不发', () => {
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    assert.ok(isOpen(ui));
    assert.equal(submitBtn(ui).textContent, '再点一下：写完即定稿 1 章');
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
  });

  test('改了任何一个值就退回第一段', () => {
    type(ui, 'to', 5);
    assert.equal(submitBtn(ui).textContent, '开始写章');
  });

  test('第二下才发：writeManuscripts，带区间、模式与 confirmed', () => {
    ui.clickEl(submitBtn(ui));
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'writeManuscripts', JSON.stringify(ui.sent));
    assert.equal(JSON.stringify(msg.range), JSON.stringify({ from: 4, to: 5 }));
    assert.equal(msg.mode, 'finalize');
    assert.equal(msg.confirmed, true);
    assert.ok(!isOpen(ui));
  });

  test('只写正文一下就发', () => {
    ui.clickEl(toolbarBtn());
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.mode, 'draft', JSON.stringify(ui.sent));
  });

  test('章节组右键「批量写章…」打开同一个弹窗', () => {
    const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章节');
    ui.sent.length = 0;
    ui.pick(ui.rightClick(head), '批量写章…');
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
    key(ui, ui.doc, 'Escape');
  });
});
