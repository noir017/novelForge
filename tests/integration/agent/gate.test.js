/**
 * 闸门在循环里的落点：`policy.ts` 的判定 → 宿主那个二选一的框 → 循环怎么走。
 *
 * 纯判定由 `tests/unit/agent/policy.test.js` 守着，这里验的是串起来之后：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 默认模式 + write | 弹框，且框上写清了写到哪 |
 * | 作者选「跳过」 | **工具不执行**，磁盘没变，循环接着跑别的 |
 * | 作者关掉对话框 | 当停止处理（循环停下，仍然给最后一轮总结），不替他答「继续」 |
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
  const { tools, ...rest } = extra ?? {};
  return bundle.loop.runAgent({
    project,
    // 工具在这里绑环境：循环手上只有一个 `ToolInvoker`。
    tools: bundle.tools.createNovelTools(
      {
        project,
        workspace: new bundle.ws.Workspace(project),
        drafts: new bundle.drafts.DraftStore(),
        sessionId: 's1',
      },
      tools
    ),
    ask: '把门派那条设定改一下',
    signal: new AbortController().signal,
    ...rest,
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    drafts: './src/core/generation/drafts.ts',
    loop: './src/core/agent/loop.ts',
    tools: './src/core/tools/novel/index.ts',
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
    h.expect('确认');
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

  // 叫停整轮不在这一问里：它与「这一个文件要不要动」是两件事，摆在闸门里
  // 只会被误当成「跳过」，而两者的后果差着一整轮。
  test('两个选项：确认 / 跳过', () => {
    assert.deepEqual(h.confirms[0].actions, ['确认', '跳过']);
  });

  test('同意之后真的写了', () => {
    assert.ok(t.has(NEW_REL));
  });

  test('循环正常收尾', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });
});

describe('作者选「跳过」', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    t.remove(NEW_REL);
    project.invalidate();
    h.expect('跳过');
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

// 卡片上没有「停止 agent」那一颗，所以「停下」只有这一条来路：他被问「要不要
// 动你的磁盘」而没有回答（Esc / 点外面 / 这一轮被取消）。不替他答「继续」。
describe('作者关掉对话框（没有回答）', () => {
  let out;
  let fake;

  before(async () => {
    // 队列为空 = confirm 返回 undefined = 用户 Esc 掉了。
    h.expect();
    fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: 'x' }),
      say('做到这里，第 12 章的细纲还没写。'),
    ]);
    out = await run({ provider: fake.provider, policy: 'default' });
  });

  test('当停止处理，stopReason 是 declined', () => {
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

// 为一个根本不存在的动作弹框，作者只会莫名其妙——而且他答「继续」也没有用。
describe('模型瞎编一个工具名', () => {
  let rec;

  before(async () => {
    h.expect();
    rec = recorder();
    const fake = scriptedProvider([useTool('c1', '删除全部章节', { path: NOTE_REL }), say('那我换个办法。')]);
    await run({ provider: fake.provider, policy: 'careful', on: rec.on });
  });

  test('不弹框', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  test('回给模型的是「没有这个工具」，附可用名单', () => {
    const summary = rec.r.toolResults[0].summary;
    assert.ok(summary.includes('没有叫'), summary);
    assert.ok(summary.includes('read'), summary);
  });
});

/**
 * 问在哪儿由调用方定：面板那条路把这一句画成对话里的一张卡片
 * （`controller/gate.ts`），循环手上只有一个 `onGate` 回调。
 *
 * 没有它才退回宿主那个全局框——命令行式的宿主与上面那一堆用例走的都是那条路。
 */
describe('有 onGate 时不弹宿主的框', () => {
  let asked;
  let out;

  before(async () => {
    t.remove(NEW_REL);
    project.invalidate();
    // 队列里放一个「写入」：真要是走了宿主那条路，文件会被建出来，
    // 下面那条「什么都没写」就红——这比只数弹框次数更难糊弄过去。
    h.expect('写入');
    asked = [];
    const fake = scriptedProvider([
      useTool('c1', 'write', { path: NEW_REL, content: '# 新条目\n\n北境有雪。\n' }),
      say('那我不写了。'),
    ]);
    out = await run({
      provider: fake.provider,
      policy: 'default',
      on: {
        onGate: async (req) => {
          asked.push(req);
          return 'skip';
        },
      },
    });
  });

  test('宿主的确认框一次都没弹', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  test('问到了调用方手上，而且说清了做什么、动哪个文件', () => {
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.ok(asked[0].title.includes('设定'), asked[0].title);
    assert.ok(asked[0].detail.includes(NEW_REL), asked[0].detail);
  });

  // 按钮上的字也从这一问里带过去：前端写死一份的话，改了文案两边就对不上。
  test('带上了按钮上的字与这一次的参数', () => {
    assert.equal(asked[0].proceed, '确认');
    assert.equal(asked[0].callId, 'c1');
    assert.equal(asked[0].name, 'write');
    assert.equal(asked[0].args.path, NEW_REL);
  });

  test('调用方回「跳过」就真的没写', () => {
    assert.ok(!t.has(NEW_REL));
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });
});

/**
 * **产物落盘前那一句**（第 19 条）：`generate` 一产出就问，与策略无关。
 *
 * 从前它是气泡末尾那颗「采纳写入」——可以拖到第二天再点，而 agent 早就
 * 接着往下做了。现在循环停在这里等：答了才继续，答什么也照实回给模型
 * （不说的话它下一步多半是再生成一遍，一整轮上下文的钱）。
 *
 * 这里用一个**假工具**产出 draftId：真 `generate` 会去调创作模型，那是
 * `tests/integration/tools/generateTool.test.js` 的活。
 */
describe('产出之后当场问一句', () => {
  /** 一个只负责「产出一份草稿」的假工具。 */
  const fakeGenerate = {
    name: 'generate',
    costly: true,
    intent: () => ({ gate: 'costly', title: '调一次创作模型' }),
    description: '假的 generate',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return { text: '已生成：剧情 · 4/4 节', draftIds: ['d1'], display: { title: 'generate 剧情' } };
    },
  };

  function runWithArtifact(onArtifact, policy = 'default') {
    const fake = scriptedProvider([useTool('c1', 'generate', {}), say('好了。')]);
    return {
      fake,
      out: run({
        provider: fake.provider,
        policy,
        tools: [fakeGenerate],
        on: { onArtifact },
      }),
    };
  }

  test('产出了就问，问的是那一次调用', async () => {
    h.expect();
    const asked = [];
    const { out } = runWithArtifact(async (req) => {
      asked.push(req);
      return { note: '已写入 .novelforge/plots/012-夜入青云.md。' };
    });
    await out;
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.equal(asked[0].callId, 'c1');
    assert.deepEqual(asked[0].draftIds, ['d1']);
  });

  // ★ 三种模式一样：这是产品承诺，不是偏好设置。
  for (const policy of ['careful', 'default', 'bold']) {
    test(`${policy} 模式下照样问`, async () => {
      h.expect('确认');
      let asked = 0;
      const { out } = runWithArtifact(async () => {
        asked += 1;
        return { note: '已写入。' };
      }, policy);
      await out;
      assert.equal(asked, 1, `问了 ${asked} 次`);
    });
  }

  // 不说的话它不知道那份产物到底落没落盘，下一步多半是再生成一遍。
  test('结论回给了模型', async () => {
    h.expect();
    const { fake, out } = runWithArtifact(async () => ({
      note: '作者没有采纳这份产物，磁盘上什么都没变。',
    }));
    await out;
    const toolMsg = fake.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('已生成'), toolMsg.content);
    assert.ok(toolMsg.content.includes('没有采纳'), toolMsg.content);
  });

  test('落盘那一问没人答（换了会话 / 取消）就停下，且仍给最后一轮总结', async () => {
    h.expect();
    const { fake, out } = runWithArtifact(async () => ({ note: '作者选择停止。', stop: true }));
    const outcome = await out;
    assert.equal(outcome.stopReason, 'declined', `${outcome.stopReason}｜${outcome.message}`);
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
    assert.equal(fake.calls[1].options.tools, undefined);
  });

  // 没有这个回调的调用方（无人值守）照常往下跑，不卡在一个没人答的问题上。
  test('没实现 onArtifact 就不问，循环照常', async () => {
    h.expect();
    const fake = scriptedProvider([useTool('c1', 'generate', {}), say('好了。')]);
    const outcome = await run({ provider: fake.provider, policy: 'bold', tools: [fakeGenerate] });
    assert.equal(outcome.stopReason, 'done', `${outcome.stopReason}｜${outcome.message}`);
  });
});
