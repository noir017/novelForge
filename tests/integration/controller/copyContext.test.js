/**
 * 「复制完整上下文」的后端一半：发给模型的那份消息留在回复那一轮上、随会话落盘，
 * 前端点了再经 `copyContext` 要。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 会话文件里那份与模型实际收到的一字不差 | 拿去核对「当时发了什么」，差一个字就不可信 |
 * | `turnDone` 只带 `fullContext` 标记，不带消息 | 一轮几万字，不随每次推会话来回搬 |
 * | 回复带回同一个 `requestId` | 回复是广播，两个视图都收得到，前端靠它认是不是自己点的 |
 * | 拼出来的文字里每条消息原样都在 | 复制出去的就是那份 |
 * | 老回复、找不到的轮次回一句为什么 | 不回空串冒充复制成功 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let controller;
let fake;
let posted = [];

async function discuss(text, reply) {
  fake.push(reply);
  await controller.handle({
    type: 'send',
    payload: {
      text,
      stage: 'outline',
      capability: 'discuss',
      target: { kind: 'outline' },
      targetNo: 0,
      attachments: [],
      excludedIds: [],
    },
  });
}

async function copy(turnId, requestId) {
  posted = [];
  await controller.handle({ type: 'copyContext', turnId, requestId });
  return posted.filter((m) => m.type === 'contextText');
}

const sessionFile = () =>
  JSON.parse(fs.readFileSync(path.join(t.project.sessionsDir, `${controller.current.id}.json`), 'utf8'));
const assistants = (turns) => turns.filter((x) => x.role === 'assistant');

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  const h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry);

  t = await makeTempProject(bundle.project, { prefix: 'copy-context', title: '青云剑录' });
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });

  await discuss('主角的金手指要不要换？', '可以换成一把会说话的剑。');
  posted = [];
  await discuss('那第一卷怎么收？', '收在剑认主那一刻。');
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('发出去的那份留在回复那一轮上', () => {
  test('会话文件里两轮回复各留一份，与模型实际收到的一字不差', () => {
    const turns = assistants(sessionFile().turns);
    assert.equal(turns.length, 2);
    assert.equal(fake.calls.length, 2);
    for (let i = 0; i < 2; i++) {
      const sent = fake.calls[i].map(({ role, content }) => ({ role, content }));
      assert.deepEqual(turns[i].contextMessages, sent);
    }
  });

  test('第二轮那份带着第一轮的讨论（历史就是这样发出去的）', () => {
    const second = assistants(sessionFile().turns)[1].contextMessages;
    assert.ok(second.some((m) => m.role === 'assistant' && m.content.includes('会说话的剑')));
  });

  test('turnDone 只带 fullContext 标记，消息不跟着推', () => {
    const done = posted.filter((m) => m.type === 'turnDone' && m.turn.role === 'assistant').at(-1).turn;
    assert.equal(done.fullContext, true);
    assert.equal(done.contextMessages, undefined);
    const system = fake.calls[1].find((m) => m.role === 'system').content;
    assert.ok(posted.every((m) => !JSON.stringify(m).includes(system)), '系统提示全文不该出现在推给前端的任何一条消息里');
  });
});

describe('copyContext', () => {
  test('回同一个 requestId，文字里每条消息原样都在', async () => {
    const id = assistants(controller.current.turns)[1].id;
    const replies = await copy(id, 'r1');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].requestId, 'r1');
    assert.equal(replies[0].error, undefined);
    for (const m of fake.calls[1]) {
      assert.ok(replies[0].text.includes(m.content), `少了一条 ${m.role}`);
    }
    assert.match(replies[0].text, /^【完整上下文】估算 \d+ \/ \d+ token · 详细度：详细 · \d+ 条消息\n/);
  });

  test('功能加上之前的回复：说没留下', async () => {
    const turn = assistants(controller.current.turns)[0];
    const kept = turn.contextMessages;
    delete turn.contextMessages;
    try {
      const [reply] = await copy(turn.id, 'r2');
      assert.equal(reply.text, undefined);
      assert.match(reply.error, /没有留下完整上下文/);
    } finally {
      turn.contextMessages = kept;
    }
  });

  test('找不到这一轮：说找不到', async () => {
    const [reply] = await copy('并不存在', 'r3');
    assert.equal(reply.requestId, 'r3');
    assert.match(reply.error, /找不到这一轮/);
  });
});
