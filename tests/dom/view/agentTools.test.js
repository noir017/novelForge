/**
 * 工具流 UI 的四条约束（对应计划 Task 6）：
 *
 * 1. **每一步都看得见**——工具条默认就在气泡里，不藏在折叠框后面。
 * 2. **花销要显示**（第 4 条）——末尾那一行，而且要**留得住**：回放会话时
 *    还在，不是只在跑的时候闪一下。
 * 3. **停止按钮全程可用**——忙的时候就是它顶在发送位上。
 * 4. **失败的步骤标红并保留**——不因为后面成功了就把失败那步藏掉。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const runRow = (ui, id) => ui.bubble(id).querySelector('.agent-run');
const rows = (ui, id) => [...ui.bubble(id).querySelectorAll('.tool-row')];

describe('花销那一行（实时）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '把第 12 章排一下', { command: 'Agent' }) });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'delta', turnId: 'a1', text: '排好了。' });
  });

  test('还没结束时没有这一行', () => {
    assert.equal(runRow(ui, 'a1'), null);
  });

  test('agentDone 到了就画出来', () => {
    ui.post({
      type: 'agentDone',
      turnId: 'a1',
      stopReason: 'done',
      message: '',
      steps: 5,
      calls: 1,
      tokens: 18000,
    });
    assert.ok(runRow(ui, 'a1'), ui.bubble('a1').innerHTML);
  });

  test('写清了几步、几次生成、多少 token', () => {
    const text = runRow(ui, 'a1').textContent;
    assert.ok(text.includes('5 步'), text);
    assert.ok(text.includes('1 次生成'), text);
    assert.ok(text.includes('1.8 万'), text);
  });

  test('正常结束时不写「为什么停」', () => {
    assert.equal(runRow(ui, 'a1').querySelector('.agent-run-why'), null);
  });

  test('正文没被冲掉（就地插入，不重建气泡）', () => {
    assert.equal(ui.bodyOf('a1').textContent, '排好了。');
  });

  test('再来一条 agentDone 不会画出两行', () => {
    ui.post({
      type: 'agentDone',
      turnId: 'a1',
      stopReason: 'done',
      message: '',
      steps: 6,
      calls: 1,
      tokens: 19000,
    });
    assert.equal(ui.bubble('a1').querySelectorAll('.agent-run').length, 1);
  });

  test('认不出的 turnId 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({ type: 'agentDone', turnId: '并不存在', stopReason: 'done', message: '', steps: 1, calls: 0, tokens: 0 })
    );
  });
});

describe('非正常结束：为什么停要写在同一行', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '做到第 3 章。') });
    ui.post({
      type: 'agentDone',
      turnId: 'a1',
      stopReason: 'calls',
      message: '已经生成了 10 次（上限 10），到此为止。',
      steps: 12,
      calls: 10,
      tokens: 90000,
    });
  });

  // toast 五秒就没了，这一行留得住。
  test('原因写在那一行上', () => {
    assert.ok(runRow(ui, 'a1').textContent.includes('上限 10'), runRow(ui, 'a1').textContent);
  });

  test('那一行标成「停下了」', () => {
    assert.ok(runRow(ui, 'a1').classList.contains('agent-run-stopped'), runRow(ui, 'a1').className);
  });
});

describe('花销留得住（重开面板时回放）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '排一下第 12 章', { command: 'Agent' }),
          turn('a1', 'assistant', '排好了。', {
            toolCalls: [
              { callId: 'c1', name: 'read', title: 'read .novelforge/plots/012.md', ok: true, summary: '20 行', elapsedMs: 30 },
              { callId: 'c2', name: 'write', title: 'write .novelforge/plots/012.md', ok: false, summary: '作者跳过了这一步', elapsedMs: 0 },
            ],
            agentRun: { steps: 4, calls: 1, tokens: 12000, stopReason: 'done' },
          }),
          turn('a2', 'assistant', '普通回答'),
        ],
      }),
    });
  });

  test('花销那一行画回来了', () => {
    assert.ok(runRow(ui, 'a1'), ui.bubble('a1').innerHTML);
    assert.ok(runRow(ui, 'a1').textContent.includes('4 步'), runRow(ui, 'a1').textContent);
  });

  test('排在回答下面（它是账单，不是话）', () => {
    const kids = [...ui.bubble('a1').children].map((c) => c.className);
    assert.ok(kids.indexOf('msg-body') < kids.indexOf('agent-run'), JSON.stringify(kids));
  });

  // 不因为后面成功了就把失败那步藏掉。
  test('失败的那一步保留并标红', () => {
    assert.equal(rows(ui, 'a1').length, 2);
    const failed = ui.bubble('a1').querySelector('.tool-row[data-call="c2"]');
    assert.ok(failed.classList.contains('tool-failed'), failed.className);
    assert.ok(failed.textContent.includes('跳过'), failed.textContent);
  });

  test('不是 agent 的那一轮不长出这一行', () => {
    assert.equal(runRow(ui, 'a2'), null);
  });
});

describe('停止按钮全程可用', { skip: JSDOM_SKIP }, () => {
  let ui;
  const stop = () => ui.doc.getElementById('stopBtn');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
  });

  test('页面上有这颗按钮', () => {
    assert.ok(stop(), '缺少 #stopBtn');
  });

  test('忙起来之后点得到', () => {
    ui.post({ type: 'busy', value: true });
    assert.equal(stop().hidden, false, stop().outerHTML);
  });

  test('点它发的是 stop', () => {
    ui.clickEl(stop());
    assert.ok(ui.sent.some((m) => m.type === 'stop'), JSON.stringify(ui.sent.map((m) => m.type)));
  });
});
