/**
 * 闸门在循环里的落点：`policy.ts` 的判定 → 宿主那个三选一的框 → 循环怎么走。
 *
 * 纯判定由 `tests/unit/agent/policy.test.js` 守着，这里验的是串起来之后：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 默认模式 + write | 弹框，且框上写清了写到哪 |
 * | 作者选「跳过这一步」 | **工具不执行**，磁盘没变，循环接着跑别的 |
 * | 作者选「停止 agent」 | 循环停下，仍然给最后一轮总结（不静默掐断） |
 * | 作者关掉对话框 | 当停止处理，不替他答「继续」 |
 * | 放手模式 + write 新建 | 不弹框 |
 * | 任何模式 + read | 不弹框 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let h;

const NOTE_REL = '.novelforge/lore/门派.md';
const NEW_REL = '.novelforge/lore/新条目.md';

function scriptedProvider(script) {
  const calls = [];
  return {
    provider: {
      id: 'vscode-lm',
      label: '假模型',
      maxInputTokens: async () => undefined,
      stream: async function* (messages, options) {
        const i = calls.length;
        calls.push({ messages, options });
        for (const ev of script[i] ?? [{ type: 'text', text: '（没词了）' }]) {
          yield ev;
        }
      },
    },
    calls,
  };
}

const say = (text) => [{ type: 'text', text }];
const useTool = (id, name, args) => [
  { type: 'toolCall', call: { id, name, args, raw: JSON.stringify(args) } },
];

function recorder() {
  const r = { toolCalls: [], toolResults: [], notes: [] };
  return {
    r,
    on: {
      onToolCall: (c) => r.toolCalls.push(c),
      onToolResult: (x) => r.toolResults.push(x),
      onNote: (m) => r.notes.push(m),
    },
  };
}

function run(extra) {
  return bundle.loop.runAgent({
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: new bundle.drafts.DraftStore(),
    sessionId: 's1',
    ask: '把门派那条设定改一下',
    signal: new AbortController().signal,
    ...extra,
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    drafts: './src/core/generation/drafts.ts',
    loop: './src/core/agent/loop.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ settings: () => ({ contextWindow: 100000, maxOutputTokens: 2000 }) });
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'agentgate', title: '青云志' });
  project = t.project;
  await new bundle.ws.Workspace(project).write(NOTE_REL, { text: '# 门派\n\n青云宗在北境。\n' }, { mode: 'create' });
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('默认模式：新建一份文件要先问一句', () => {
  let out;
  let rec;

  before(async () => {
    h.expect('写入');
    rec = recorder();
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: '# 新条目\n\n北境有雪。\n' }),
      say('写好了。'),
    ]);
    out = await run({ provider: fake.provider, on: rec.on, policy: 'default' });
  });

  test('弹了框', () => {
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
  });

  // 「Agent 想调用 write，允许吗」作者答不上来——他不知道会写到哪。
  test('框上说清了要写什么、写到哪', () => {
    assert.ok(h.confirms[0].message.includes('设定'), h.confirms[0].message);
    assert.ok(h.confirms[0].detail.includes(NEW_REL), h.confirms[0].detail);
  });

  test('三个选项，不是两个', () => {
    assert.deepEqual(h.confirms[0].actions, ['写入', '跳过这一步', '停止 agent']);
  });

  test('同意之后真的写了', () => {
    assert.ok(t.has(NEW_REL));
  });

  test('循环正常收尾', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });
});

describe('作者选「跳过这一步」', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    t.remove(NEW_REL);
    project.invalidate();
    h.expect('跳过这一步');
    rec = recorder();
    fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: '不该落盘的内容' }),
      say('那我不写了。'),
    ]);
    out = await run({ provider: fake.provider, on: rec.on, policy: 'default' });
  });

  test('文件没建出来', () => {
    assert.ok(!t.has(NEW_REL));
  });

  test('循环继续跑（不是整轮掐断）', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
  });

  // ★ 不说清楚它会原地把同一个动作再发一遍，每次都是一整轮上下文的钱。
  test('回给模型的话说清了作者跳过了，且不要重试', () => {
    const toolMsg = fake.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, JSON.stringify(fake.calls[1].messages.map((m) => m.role)));
    assert.ok(toolMsg.content.includes('跳过'), toolMsg.content);
    assert.ok(toolMsg.content.includes('不要重试'), toolMsg.content);
  });

  test('工具流里这一步标成失败并保留', () => {
    const failed = rec.r.toolResults.filter((x) => !x.ok);
    assert.equal(failed.length, 1, JSON.stringify(rec.r.toolResults));
    assert.ok(failed[0].summary.includes('跳过'), failed[0].summary);
  });
});

describe('作者选「停止 agent」', () => {
  let out;
  let fake;

  before(async () => {
    h.expect('停止 agent');
    fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: 'x' }),
      say('做到这里，第 12 章的细纲还没写。'),
    ]);
    out = await run({ provider: fake.provider, policy: 'default' });
  });

  test('stopReason 是 declined', () => {
    assert.equal(out.stopReason, 'declined', `${out.stopReason}｜${out.message}`);
  });

  test('文件没建出来', () => {
    assert.ok(!t.has(NEW_REL));
  });

  // 直接掐断的话作者只看到一段没头没尾的输出，不知道该从哪接着做。
  test('仍然给了最后一轮总结', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
    assert.equal(out.text, '做到这里，第 12 章的细纲还没写。');
  });

  test('最后一轮不带工具', () => {
    assert.equal(fake.calls[1].options.tools, undefined);
  });

  test('给了一句人话说明为什么停', () => {
    assert.ok(out.message.includes('停'), out.message);
  });
});

describe('作者关掉对话框', () => {
  let out;

  before(async () => {
    // 队列为空 = confirm 返回 undefined = 用户 Esc 掉了。
    h.expect();
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: 'x' }),
      say('好的。'),
    ]);
    out = await run({ provider: fake.provider, policy: 'default' });
  });

  // 他被问「要不要动你的磁盘」而没有回答，不该替他答「继续」。
  test('当停止处理', () => {
    assert.equal(out.stopReason, 'declined', `${out.stopReason}｜${out.message}`);
  });

  test('什么都没写', () => {
    assert.ok(!t.has(NEW_REL));
  });
});

describe('放手模式', () => {
  before(async () => {
    t.remove(NEW_REL);
    project.invalidate();
    h.expect();
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: '# 新条目\n\n直接写。\n' }),
      say('写好了。'),
    ]);
    await run({ provider: fake.provider, policy: 'bold' });
  });

  test('新建不弹框', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  test('直接写进去了', () => {
    assert.ok(t.has(NEW_REL));
  });
});

// ★ 产品承诺：三种模式完全一样，关不掉。
describe('覆盖已有内容：放手模式下照样要作者过目', () => {
  before(async () => {
    h.expect();
    h.setReviewVerdict('discard');
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NOTE_REL, content: '# 门派\n\n改成南岭了。\n', mode: 'overwrite' }),
      say('作者没同意。'),
    ]);
    await run({ provider: fake.provider, policy: 'bold' });
  });

  test('走的是覆盖审阅（不是确认框）', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
  });

  test('拒绝之后磁盘一字未改', () => {
    assert.ok(t.read(NOTE_REL).includes('北境'), t.read(NOTE_REL));
  });

  test('同意之后才改', async () => {
    h.expect();
    h.setReviewVerdict('apply');
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NOTE_REL, content: '# 门派\n\n改成南岭了。\n', mode: 'overwrite' }),
      say('改好了。'),
    ]);
    await run({ provider: fake.provider, policy: 'bold' });
    assert.ok(t.read(NOTE_REL).includes('南岭'), t.read(NOTE_REL));
  });
});

describe('读工具在任何模式下都不打断', () => {
  for (const policy of ['careful', 'default', 'bold']) {
    test(`${policy} 下 read 不弹框`, async () => {
      h.expect();
      const fake = scriptedProvider([useTool('c1', 'read', { path: NOTE_REL }), say('看过了。')]);
      await run({ provider: fake.provider, policy });
      assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
    });
  }
});
