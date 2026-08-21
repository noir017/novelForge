/**
 * agent 那一轮在气泡里长什么样：工具调用的折叠条 + 「直接发送就是 agent」。
 *
 * 两条路都要验：
 *
 * 1. **实时**——`toolCall` 先挂一条「进行中…」，`toolResult` 到了就地换成
 *    带耗时的最终形态。**就地追加而不是重建气泡**：重建会把正在流的正文冲掉。
 * 2. **回放**——重开面板时靠 `turn.segments` 把那一串重新画出来。
 *
 * 还有一条最要紧的：**气泡里只画摘要，不画工具的完整返回值**。
 * 交替本身（说的话与做的事按发生顺序排）另有一份：`agentSegments.test.js`。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

const rows = (ui, id) => [...ui.bubble(id).querySelectorAll('.tool-row')];
const textsOf = (row) => ({
  title: row.querySelector('.tool-title').textContent,
  summary: row.querySelector('.tool-summary').textContent,
  elapsed: row.querySelector('.tool-elapsed').textContent,
});

describe('工具调用流（实时）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '第 9 章里他说过没去过北境吗？', { command: 'Agent' }) });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('toolCall 到了就挂一条', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c1', name: 'search', title: 'search「北境」' });
    assert.equal(rows(ui, 'a1').length, 1);
  });

  test('还没有结果时标「进行中」', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).summary, '进行中…');
  });

  test('还没有结果时不显示耗时', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).elapsed, '');
  });

  test('toolResult 到了就地换成最终形态', () => {
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c1',
      name: 'search',
      ok: true,
      summary: '2 处命中',
      elapsedMs: 320,
    });
    assert.equal(rows(ui, 'a1').length, 1, '不该多出一行');
    assert.equal(textsOf(rows(ui, 'a1')[0]).summary, '2 处命中');
  });

  // 与日志的 formatDuration 同一套口径：一秒以内报毫秒，更看得出快慢。
  test('耗时按毫秒显示', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).elapsed, '320ms');
  });

  test('标题留着（结果消息里没有它）', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).title, 'search「北境」');
  });

  test('第二个工具排在后面，顺序就是执行顺序', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c2', name: 'read', title: 'read chapters/009-北行.md' });
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c2',
      name: 'read',
      ok: true,
      summary: '4 行',
      elapsedMs: 40,
    });
    assert.deepEqual(rows(ui, 'a1').map((r) => textsOf(r).title), [
      'search「北境」',
      'read chapters/009-北行.md',
    ]);
  });

  test('毫秒级的耗时不显示成 0.0s', () => {
    assert.equal(textsOf(rows(ui, 'a1')[1]).elapsed, '40ms');
  });

  // 就地追加而不是重建气泡：重建会把正在流的内容冲掉（文字块是纯文本节点）。
  // **中间插了一次工具调用，后面那句话就是新的一块**——那正是交替。
  test('工具调用打断之后，两句话各自成块', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '他在第 9 章说过。' });
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c3', name: 'read', title: 'read x' });
    ui.post({ type: 'delta', turnId: 'a1', text: '依据在第 3 行。' });
    assert.deepEqual(
      [...ui.bubble('a1').querySelectorAll('.msg-body')].map((b) => b.textContent),
      ['他在第 9 章说过。', '依据在第 3 行。']
    );
  });

  test('顺序就是发生的顺序（先说、再查、再说）', () => {
    const kinds = [...ui.bubble('a1').children]
      .map((c) => c.className)
      .filter((cn) => cn === 'tools' || cn === 'msg-body');
    // 前面那几次调用在第一串里；delta 之后那次 read 另起一串。
    assert.deepEqual(kinds, ['tools', 'msg-body', 'tools', 'msg-body']);
  });

  test('失败的工具带标记', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c9', name: 'read', title: 'read 不存在.md' });
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c9',
      name: 'read',
      ok: false,
      summary: '文件不存在：不存在.md',
      elapsedMs: 5,
    });
    const row = ui.bubble('a1').querySelector('.tool-row[data-call="c9"]');
    assert.ok(row.classList.contains('tool-failed'), row.className);
  });

  test('认不出的 turnId 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({ type: 'toolCall', turnId: '并不存在', callId: 'x', name: 'read', title: 'read x' })
    );
  });

  test('没有对应 toolCall 的 toolResult 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({
        type: 'toolResult',
        turnId: 'a1',
        callId: '没挂过的',
        name: 'read',
        ok: true,
        summary: 'x',
        elapsedMs: 1,
      })
    );
  });
});

describe('工具调用流（重开面板时回放）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '排一下第 12 章', { command: 'Agent' }),
          turn('a1', 'assistant', '排好了，收在藏书阁门口。', {
            segments: [
              toolSeg({ callId: 'c1', name: 'read', title: 'read .novelforge/plots/012.md', ok: true, summary: '20 行', elapsedMs: 30 }),
              toolSeg({
                callId: 'c2',
                name: 'generate',
                title: 'generate 剧情·生成',
                ok: true,
                summary: '剧情 · 4/4 节 · 620 字',
                elapsedMs: 12400,
                output: '第一节 藏书阁门口\n他在门口站了很久。',
              }),
              textSeg('排好了，收在藏书阁门口。'),
            ],
          }),
        ],
      }),
    });
  });

  test('工具那一条画回来了', () => {
    assert.equal(rows(ui, 'a1').length, 1);
    assert.deepEqual(textsOf(rows(ui, 'a1')[0]), {
      title: 'read .novelforge/plots/012.md',
      summary: '20 行',
      elapsed: '30ms',
    });
  });

  // 花钱那一下产出的是**产物本身**，不是它查资料的过程：画成一张卡，
  // 连正文一起留住（从前那几千字刷新之后整份消失）。
  test('generate 画成一张卡，不是一行流水账', () => {
    const card = ui.bubble('a1').querySelector('.gen[data-call="c2"]');
    assert.ok(card, ui.bubble('a1').innerHTML);
    assert.equal(card.querySelector('.gen-title').textContent, 'generate 剧情·生成');
    assert.equal(card.querySelector('.gen-elapsed').textContent, '12.4s');
    assert.equal(card.querySelector('.gen-state-text').textContent, '剧情 · 4/4 节 · 620 字');
    assert.ok(card.querySelector('.gen-body').textContent.includes('藏书阁门口'));
  });

  test('卡默认是展开的（那份产物就是要读的东西）', () => {
    assert.equal(ui.bubble('a1').querySelector('.gen[data-call="c2"]').open, true);
  });

  // 一章正文几千字，摊在气泡里会把作者真正要看的那段回答挤到屏幕外。
  test('气泡里没有工具的完整返回值', () => {
    assert.ok(!ui.bubble('a1').textContent.includes('.novelforge/plots/012.md\n'), ui.bubble('a1').textContent);
  });

  test('回答本身照常显示', () => {
    assert.equal(ui.bodyOf('a1').textContent, '排好了，收在藏书阁门口。');
  });

  test('没有段的普通轮次不长出空的工具条', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通回答') });
    assert.equal(ui.bubble('a2').querySelector('.tools'), null);
  });
});

describe('直接发送就是 agent', { skip: JSDOM_SKIP }, () => {
  let ui;
  const input = () => ui.doc.getElementById('input');
  const sendBtn = () => ui.doc.getElementById('sendBtn');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
  });

  // 从前这里是输入框旁一个「Agent」开关，缺省关着。现在 agent 就是默认的那条
  // 路：不挑命令直接说话，走的就是它。
  test('页面上没有 Agent 开关了', () => {
    assert.equal(ui.doc.getElementById('agentToggle'), null);
  });

  test('没挑命令时发的是 sendAgent', () => {
    input().value = '第 9 章里他说过没去过北境吗？';
    ui.clickEl(sendBtn());
    assert.equal(ui.last('sendAgent').text, '第 9 章里他说过没去过北境吗？');
  });

  // agent 没有 stage/capability 的概念——「下一步该做什么」由后端每回合注入的
  // 状态机结论说了算。前端捎一份过去，两处迟早分叉。
  test('sendAgent 不带 stage / capability', () => {
    assert.deepEqual(Object.keys(ui.last('sendAgent')).sort(), ['text', 'type']);
  });

  test('空输入不发送', () => {
    ui.post({ type: 'busy', value: false });
    const before = ui.sent.filter((m) => m.type === 'sendAgent').length;
    input().value = '   ';
    ui.clickEl(sendBtn());
    assert.equal(ui.sent.filter((m) => m.type === 'sendAgent').length, before);
  });

  test('发送后清空输入框', () => {
    ui.post({ type: 'busy', value: false });
    input().value = '再问一句';
    ui.clickEl(sendBtn());
    assert.equal(input().value, '');
  });

  // 挑了 `/命令`（拆成卷、生成大纲…）才回到确定性的单步。
  //
  // 挑的命令必须**属于当前会话那一层**：面板读的是 `commandsFor(session.stage)`，
  // 而这个会话停在大纲层（`emptySession` 的缺省）。挑一条别的层的命令，
  // `find` 会返回 undefined，用例炸在 clickEl 上而不是在断言上——从前这里
  // 挑的正是剧情层的命令，所以它一直是红的。
  test('挑了命令时发的还是 send', () => {
    ui.post({ type: 'busy', value: false });
    input().value = '/';
    input().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    const pick = [...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes('拆成卷'));
    assert.ok(pick, [...ui.doc.querySelectorAll('.cmd-item')].map((n) => n.textContent).join('|'));
    ui.clickEl(pick);
    input().value = '切成三卷';
    ui.clickEl(sendBtn());
    assert.equal(ui.last('send').payload.capability, 'split', JSON.stringify(ui.last('send').payload));
  });
});
