/**
 * `agent/context.ts` 的**消息压缩**那一半（状态注入要读盘，在
 * `tests/integration/agent/stateBrief.test.js`）。
 *
 * agent 自己的历史会涨：工具结果一条条累积，十几步之后 system 之外全是
 * `read` 的回显。这里钉四条：
 *
 * 1. 装得下就一个字不动；
 * 2. system 与最后 K 轮永不压缩；
 * 3. 更早的工具结果只留第一行 + 一句「已省略」，且**打一条 warn**（第 2 条）；
 * 4. 压到底仍然超预算时给出停下的信号，**不丢用户最初那句要求**。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let bundle;
let ctx;
/** warn / error 级日志。 */
const warns = [];

before(() => {
  bundle = loadBundle({
    context: './src/core/agent/context.ts',
    logger: './src/core/runtime/logger.ts',
  });
  ctx = bundle.context;
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      warns.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
});

/** 造 N 轮「assistant 调工具 → tool 回结果」。工具结果刻意很长。 */
function rounds(n, bodyChars = 2000) {
  const out = [{ role: 'user', content: '第 9 章里主角说过他没去过北境吗？' }];
  for (let i = 1; i <= n; i++) {
    out.push({
      role: 'assistant',
      content: `我去看看第 ${i} 处。`,
      toolCalls: [{ id: `c${i}`, name: 'read', args: {}, raw: '{}' }],
    });
    out.push({
      role: 'tool',
      toolCallId: `c${i}`,
      name: 'read',
      content: `chapters/00${i}.md\n${'正文一行。'.repeat(bodyChars / 5)}`,
    });
  }
  return out;
}

const toolMessages = (msgs) => msgs.filter((m) => m.role === 'tool');
const omitted = (m) => m.content.includes('已省略');

describe('装得下就不动', () => {
  const r = ctx.buildAgentMessages('系统提示', rounds(2, 20), 100000);

  test('第一条是 system', () => {
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[0].content, '系统提示');
  });

  test('原样带上全部轮次', () => {
    assert.equal(r.messages.length, 1 + rounds(2, 20).length);
  });

  test('一条都没省略', () => {
    assert.equal(r.droppedCount, 0);
    assert.ok(!toolMessages(r.messages).some(omitted));
  });

  test('不算超预算', () => {
    assert.equal(r.overBudget, false);
  });

  test('报出估算的 token 数', () => {
    assert.ok(r.tokens > 0, String(r.tokens));
  });
});

describe('超预算时压缩', () => {
  let r;
  let before0;

  before(() => {
    before0 = warns.length;
    // 12 轮、每条工具结果 2000 字，预算给 3000 token：必须压。
    r = ctx.buildAgentMessages('系统提示', rounds(12), 3000);
  });

  test('system 一个字都没动', () => {
    assert.equal(r.messages[0].content, '系统提示');
  });

  // 刚发生的事必须完整——模型正要据此决定下一步。
  test('最后 6 轮的工具结果完整保留', () => {
    const tools = toolMessages(r.messages);
    const recent = tools.slice(-6);
    assert.deepEqual(recent.map(omitted), new Array(6).fill(false), JSON.stringify(recent.map((m) => m.content.length)));
  });

  test('更早的工具结果被省略了', () => {
    const tools = toolMessages(r.messages);
    assert.ok(tools.slice(0, -6).every(omitted), JSON.stringify(tools.slice(0, -6).map((m) => m.content.slice(0, 40))));
  });

  test('省略时留着第一行（模型据此知道自己看过什么）', () => {
    const first = toolMessages(r.messages)[0];
    assert.ok(first.content.startsWith('chapters/001.md'), JSON.stringify(first.content.slice(0, 60)));
  });

  test('省略的那句话告诉模型可以重新调用', () => {
    const first = toolMessages(r.messages)[0];
    assert.ok(first.content.includes('重新调用'), first.content);
  });

  test('报出省略了几条', () => {
    assert.ok(r.droppedCount > 0, String(r.droppedCount));
  });

  // 用户最初那句要求是整轮循环的锚。丢了它，agent 会开始回答一个谁也没问过的问题。
  test('用户最初那句要求还在', () => {
    assert.ok(
      r.messages.some((m) => m.role === 'user' && m.content.includes('北境')),
      JSON.stringify(r.messages.map((m) => m.role))
    );
  });

  test('assistant 的回复一条都没动', () => {
    const said = r.messages.filter((m) => m.role === 'assistant');
    assert.ok(said.every((m) => !omitted(m)), JSON.stringify(said.map((m) => m.content)));
  });

  // 第 2 条：不静默截断。
  test('打了一条 warn', () => {
    const fresh = warns.slice(before0);
    assert.ok(fresh.some((w) => w.includes('省略')), JSON.stringify(fresh));
  });

  test('warn 里说清了省略几条与上限', () => {
    const fresh = warns.slice(before0);
    assert.ok(fresh.some((w) => /省略了 \d+ 条/.test(w) && w.includes('上限')), JSON.stringify(fresh));
  });
});

describe('压不下去', () => {
  let r;
  let before0;

  before(() => {
    before0 = warns.length;
    // 最后 6 轮本身就装不下：保护窗口不压，所以压到底也超。
    r = ctx.buildAgentMessages('系统提示', rounds(8, 8000), 500);
  });

  test('给出让循环停下的信号', () => {
    assert.equal(r.overBudget, true);
  });

  // 停下来说清楚，好过默默丢掉一半上下文然后给一个看起来正常的答案。
  test('仍然把消息交出来（用于最后一轮总结）', () => {
    assert.ok(r.messages.length > 1, String(r.messages.length));
  });

  test('用户最初那句要求还在', () => {
    assert.ok(r.messages.some((m) => m.role === 'user' && m.content.includes('北境')));
  });

  test('打了一条 warn 说明压不下去', () => {
    const fresh = warns.slice(before0);
    assert.ok(fresh.some((w) => w.includes('压到底')), JSON.stringify(fresh));
  });
});

describe('边界', () => {
  test('空历史也能拼出 system', () => {
    const r = ctx.buildAgentMessages('系统提示', [], 100);
    assert.deepEqual(r.messages, [{ role: 'system', content: '系统提示' }]);
  });

  test('本来就只有一行的工具结果不压（压了反而更长）', () => {
    // 短结果排在最前面，落在保护窗口**之外**——不这么放的话这条分支根本跑不到。
    const turns = [
      { role: 'assistant', content: 'x', toolCalls: [] },
      { role: 'tool', toolCallId: 'z', name: 'list', content: '（空目录）' },
      ...rounds(10),
    ];
    const r = ctx.buildAgentMessages('系统提示', turns, 3000);
    assert.equal(toolMessages(r.messages)[0].content, '（空目录）');
  });

  test('轮数不足 K 时全部保留', () => {
    const r = ctx.buildAgentMessages('系统提示', rounds(3), 10);
    assert.equal(r.droppedCount, 0, String(r.droppedCount));
  });
});
