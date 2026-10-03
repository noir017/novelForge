/**
 * 工具条那一行的几条约束（外部 agent 经 MCP 调工具时，对话页上只看得见这些）：
 *
 * 1. **认得出是谁做的**——MCP 留下的那一轮头上写「外部 Agent」并挂一个 `MCP` 标签，
 *    不冒充模型的回复。
 * 2. **停止按钮全程可用**——忙的时候就是它顶在发送位上。
 * 3. **失败的步骤标红并保留**——不因为后面成功了就把失败那步藏掉。
 * 4. **详情查得到**——那一行仍只画摘要，参数与返回收在折叠里，点开才有。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

const rows = (ui, id) => [...ui.bubble(id).querySelectorAll('.tool-row')];

describe('MCP 留下的那一轮（重开面板时回放）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const head = (id) => ui.bubble(id).querySelector('.msg-head');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('a1', 'assistant', '', {
            mcp: true,
            segments: [
              toolSeg({ callId: 'c1', name: 'read', title: 'read .novelforge/plots/012.md', ok: true, summary: '20 行', elapsedMs: 30 }),
              toolSeg({ callId: 'c2', name: 'write', title: 'write .novelforge/plots/012.md', ok: false, summary: '作者跳过了这一步', elapsedMs: 0 }),
            ],
          }),
          turn('a2', 'assistant', '普通回答'),
        ],
      }),
    });
  });

  test('头上写的是「外部 Agent」', () => {
    assert.equal(head('a1').querySelector('.msg-role').textContent, '外部 Agent');
  });

  test('挂着一个 MCP 标签', () => {
    const tag = head('a1').querySelector('.msg-tag');
    assert.ok(tag, head('a1').innerHTML);
    assert.equal(tag.textContent, 'MCP');
  });

  // 不因为后面成功了就把失败那步藏掉。
  test('失败的那一步保留并标红', () => {
    assert.equal(rows(ui, 'a1').length, 2);
    const failed = ui.bubble('a1').querySelector('.tool-row[data-call="c2"]');
    assert.ok(failed.classList.contains('tool-failed'), failed.className);
    assert.ok(failed.textContent.includes('跳过'), failed.textContent);
  });

  test('普通回复还是「模型」，没有 MCP 标签', () => {
    assert.equal(head('a2').querySelector('.msg-role').textContent, '模型');
    assert.equal(head('a2').querySelector('.msg-tag'), null);
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

describe('工具调用详情（点开那一条）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rowOf = (id, call) => ui.bubble(id).querySelector(`.tool-row[data-call="${call}"]`);

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('a1', 'assistant', '第 9 章里没提过北境。', {
            segments: [
              toolSeg({
                callId: 'c1',
                name: 'read',
                title: 'read',
                ok: true,
                summary: '19 行',
                elapsedMs: 1,
                argsText: '{\n  "path": "chapters/009-北风.md"\n}',
                resultText: '第九章 北风\n他从没去过那边。',
              }),
              // 老会话里存的那些：只有摘要，没有明细。
              toolSeg({ callId: 'c2', name: 'list', title: 'list', ok: true, summary: '2 项', elapsedMs: 4 }),
              textSeg('第 9 章里没提过北境。'),
            ],
          }),
        ],
      }),
    });
  });

  test('那一行上仍然只有摘要（正文不摊在气泡里）', () => {
    const line = rowOf('a1', 'c1').querySelector('.tool-line');
    assert.ok(line.textContent.includes('19 行'), line.textContent);
    assert.ok(!line.textContent.includes('北风'), line.textContent);
  });

  test('默认是收起的', () => {
    assert.equal(rowOf('a1', 'c1').open, false);
  });

  test('点开看得到参数与返回', () => {
    const row = rowOf('a1', 'c1');
    row.open = true;
    const parts = [...row.querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].includes('chapters/009-北风.md'), parts[0]);
    assert.ok(parts[1].includes('他从没去过那边'), parts[1]);
  });

  // 点开之后空空如也比不给展开更让人火大。
  test('没有明细的老记录不长出折叠三角', () => {
    const row = rowOf('a1', 'c2');
    assert.equal(row.tagName, 'DIV');
    assert.equal(row.querySelector('.tool-detail'), null);
    assert.ok(row.textContent.includes('2 项'), row.textContent);
  });
});

describe('详情在实时那条路上（进行中 → 有结果）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const row = () => ui.bubble('a1').querySelector('.tool-row[data-call="c1"]');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({
      type: 'toolCall',
      turnId: 'a1',
      callId: 'c1',
      name: 'read',
      title: 'read',
      argsText: '{ "path": "chapters/009-北风.md" }',
    });
  });

  // 「它现在卡在哪一步」最先要看的就是这一步动的是哪个路径。
  test('还没有结果时参数就查得到', () => {
    row().open = true;
    const parts = [...row().querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].includes('009-北风'), parts[0]);
  });

  test('结果到了：展开状态跟着过去，返回文本补上', () => {
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c1',
      name: 'read',
      ok: true,
      summary: '19 行',
      elapsedMs: 1,
      argsText: '{ "path": "chapters/009-北风.md" }',
      resultText: '第九章 北风',
    });
    assert.equal(row().open, true, row().outerHTML);
    const parts = [...row().querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 2);
    assert.ok(parts[1].includes('第九章 北风'), parts[1]);
    assert.ok(row().querySelector('.tool-elapsed').textContent.includes('1ms'));
  });
});
