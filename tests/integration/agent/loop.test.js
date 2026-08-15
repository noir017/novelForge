/**
 * agent 循环：`runAgent`。
 *
 * 用一个**脚本化的假 provider**（按回合吐事件序列），因为这里要验的全是
 * 「串起来之后的行为」，而不是任何单个模块：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 不调工具直接回答 | 一个回合就结束，不空转 |
 * | 调 read 再回答 | tool 消息的形状（toolCallId / name / content） |
 * | 连续两次同工具同参数 | 收到 stalled 提示，**工具不再真跑** |
 * | 三次 | 循环停下，且给一句人话 |
 * | 预算触顶 | 最后一轮不带 tools，仍然出总结 |
 * | 取消 | 停在工具边界，已产出的 draft 保留 |
 * | 工具抛异常 | 变成 error 回给模型，循环继续 |
 * | 全程 | 日志里没有 prompt 全文、没有参数值 |
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
let settings;
/** debug 起全收——第 11 条的断言要看全部，不能只看 warn。 */
const logs = [];

/**
 * 脚本化的假 provider：第 i 个回合吐 `script[i]` 那一串事件。
 *
 * 记下每次收到的 messages 与 options，用来断言「最后一轮没带 tools」这类事。
 * 脚本是函数时能看到 `options`——「没给我工具我就只能说话」正是真模型的行为，
 * 用它来验收尾那一轮。
 */
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
        const events =
          typeof script === 'function'
            ? script(i, options)
            : (script[i] ?? [{ type: 'text', text: '（没词了）' }]);
        for (const ev of events) {
          yield ev;
        }
      },
    },
    calls,
  };
}

const say = (text) => [{ type: 'text', text }];
const useTool = (id, name, args, text = '') => [
  ...(text ? [{ type: 'text', text }] : []),
  { type: 'toolCall', call: { id, name, args, raw: JSON.stringify(args) } },
];

/** 收集所有 handler 的回调。 */
function recorder() {
  const r = { steps: [], deltas: [], toolCalls: [], toolResults: [], notes: [] };
  return {
    r,
    on: {
      onStep: (step, message) => r.steps.push(`${step}:${message}`),
      onDelta: (text) => r.deltas.push(text),
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
    ask: '第 9 章里主角说过他没去过北境吗？',
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
    registry: './src/core/agent/registry.ts',
    logger: './src/core/runtime/logger.ts',
    provider: './src/core/llm/provider.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = { contextWindow: 100000, maxOutputTokens: 2000, temperature: 0.8, requestTimeoutMs: 60000 };
  bundle.host.initHost(makeFakeHost({ settings: () => settings }).host);
  bundle.logger.addLogSink((e) => logs.push(`${e.level} ${e.message} ${e.detail ?? ''}`));

  t = await makeTempProject(bundle.project, { prefix: 'agentloop', title: '青云志' });
  project = t.project;
  t.write('chapters/009-北行.md', '# 北行\n\n「我从没去过北境。」他说。\n那年他十七。\n');
  t.write('chapters/012-入宗.md', '# 入宗\n\n他站在山门外。\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('模型直接回答，不调工具', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    fake = scriptedProvider([say('他在第 9 章说过没去过北境。')]);
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on });
  });

  test('只调了一次模型', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
  });

  test('一个回合就结束', () => {
    assert.equal(out.steps, 1, String(out.steps));
  });

  test('stopReason 是 done', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });

  test('回答带出来了', () => {
    assert.equal(out.text, '他在第 9 章说过没去过北境。');
  });

  test('文本流给了前端', () => {
    assert.ok(rec.r.deltas.join('').includes('第 9 章'), JSON.stringify(rec.r.deltas));
  });

  test('一个工具都没调', () => {
    assert.deepEqual(rec.r.toolCalls, []);
  });

  test('一次生成都没有，所以不花钱', () => {
    assert.equal(out.calls, 0);
  });
});

describe('系统提示里带着状态注入', () => {
  let fake;

  before(async () => {
    fake = scriptedProvider([say('好的。')]);
    await run({ provider: fake.provider });
  });

  test('第一条是 system', () => {
    assert.equal(fake.calls[0].messages[0].role, 'system');
  });

  // 第 20 条：agent 与界面主按钮读的是同一个 deriveNextStep，不可能分叉。
  test('system 里有状态机算出的下一步', () => {
    assert.ok(fake.calls[0].messages[0].content.includes('不要另做判断'), fake.calls[0].messages[0].content);
  });

  test('system 里有工程现状', () => {
    assert.ok(fake.calls[0].messages[0].content.includes('《青云志》'), fake.calls[0].messages[0].content);
  });

  // 领域知识在 prompts.ts 里，由 generate 内部那次调用自己带着。
  test('system 里不写领域知识', () => {
    const s = fake.calls[0].messages[0].content;
    assert.ok(!s.includes('天气'), s);
    assert.ok(!s.includes('台词'), s);
  });

  test('用户那句话原样进第二条', () => {
    assert.equal(fake.calls[0].messages[1].role, 'user');
    assert.ok(fake.calls[0].messages[1].content.includes('北境'), fake.calls[0].messages[1].content);
  });

  test('带上了工具清单', () => {
    const names = fake.calls[0].options.tools.map((s) => s.name);
    assert.deepEqual(names, ['list', 'read', 'search', 'generate']);
  });
});

describe('调 read 再回答', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    fake = scriptedProvider([
      useTool('c1', 'read', { path: 'chapters/009-北行.md' }, '我去看看第 9 章。'),
      say('是的，他在第 9 章第 3 行说「我从没去过北境」。'),
    ]);
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on });
  });

  test('两个回合', () => {
    assert.equal(out.steps, 2, String(out.steps));
  });

  test('第二轮的消息里有 assistant 那一条（带 toolCalls）', () => {
    const second = fake.calls[1].messages;
    const assistant = second.find((m) => m.role === 'assistant');
    assert.ok(assistant && assistant.toolCalls.length === 1, JSON.stringify(assistant));
  });

  test('tool 消息形状正确：role / toolCallId / name', () => {
    const tool = fake.calls[1].messages.find((m) => m.role === 'tool');
    assert.equal(tool.toolCallId, 'c1');
    assert.equal(tool.name, 'read');
  });

  test('tool 消息里是真的读到的内容', () => {
    const tool = fake.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(tool.content.includes('从没去过北境'), tool.content);
  });

  test('前端收到了工具调用与结果', () => {
    assert.equal(rec.r.toolCalls.length, 1);
    assert.equal(rec.r.toolResults.length, 1);
  });

  test('工具结果带耗时与成功标记', () => {
    assert.equal(rec.r.toolResults[0].ok, true, JSON.stringify(rec.r.toolResults[0]));
    assert.ok(typeof rec.r.toolResults[0].elapsedMs === 'number');
  });

  test('最终回答是第二轮那句', () => {
    assert.ok(out.text.includes('第 3 行'), out.text);
  });
});

describe('无进展：连续两次同工具同参数', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    fake = scriptedProvider([
      useTool('c1', 'read', { path: '不存在.md' }),
      useTool('c2', 'read', { path: '不存在.md' }),
      say('看来那个文件不在，换个说法：我没找到。'),
    ]);
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on });
  });

  test('第二次收到 stalled 提示而不是工具结果', () => {
    const tools = fake.calls[2].messages.filter((m) => m.role === 'tool');
    assert.ok(tools[1].content.includes('重复调用'), tools[1].content);
  });

  // 提示了就不该再真跑一次——那次调用的钱与时间都是白花的。
  test('第二次没有真的执行工具', () => {
    assert.equal(rec.r.toolResults.length, 1, JSON.stringify(rec.r.toolResults));
  });

  test('在气泡里提醒了作者', () => {
    assert.ok(rec.r.notes.some((n) => n.includes('重复')), JSON.stringify(rec.r.notes));
  });

  test('换了思路之后循环正常结束', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });
});

describe('无进展：三次就停', () => {
  let out;
  let fake;
  let rec;

  before(async () => {
    fake = scriptedProvider([
      useTool('c1', 'read', { path: '不存在.md' }),
      useTool('c2', 'read', { path: '不存在.md' }),
      useTool('c3', 'read', { path: '不存在.md' }),
      say('我找不到那份文件。'),
    ]);
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on });
  });

  test('循环停下，stopReason 是 stalled', () => {
    assert.equal(out.stopReason, 'stalled', `${out.stopReason}｜${out.message}`);
  });

  // 不静默停：作者要知道为什么突然没了下文。
  test('给出一句人话说明', () => {
    assert.ok(out.message.includes('重复'), out.message);
  });

  test('仍然给了最后一轮总结的机会', () => {
    assert.equal(fake.calls.length, 4, String(fake.calls.length));
    assert.ok(out.text.includes('找不到'), out.text);
  });

  test('最后那一轮不带 tools', () => {
    assert.equal(fake.calls[3].options.tools, undefined, JSON.stringify(fake.calls[3].options.tools));
  });
});

describe('预算触顶', () => {
  let out;
  let fake;
  let rec;

  before(async () => {
    // 一直调工具、永不主动收尾——只能靠 steps 上限拦。收尾那一轮拿不到 tools，
    // 只好说话，这正是真模型的行为。
    fake = scriptedProvider((i, options) =>
      options.tools ? useTool(`c${i}`, 'read', { path: `chapters/00${i % 9}-x.md` }) : say('我先说说做到哪了。')
    );
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on, limits: { steps: 3 } });
  });

  test('stopReason 是 steps', () => {
    assert.equal(out.stopReason, 'steps', `${out.stopReason}｜${out.message}`);
  });

  test('说清了跑了几步、上限多少', () => {
    assert.ok(out.message.includes('上限 3'), out.message);
  });

  // 直接掐断的话作者只看到一段没头没尾的输出，不知道该从哪接着做。
  test('最后一轮 toolChoice 是 none（干脆不带 tools）', () => {
    const last = fake.calls[fake.calls.length - 1].options;
    assert.equal(last.tools, undefined, JSON.stringify(last.tools));
    assert.equal(last.toolChoice, undefined, String(last.toolChoice));
  });

  test('有总结', () => {
    assert.ok(out.text.includes('做到哪了'), out.text);
  });

  test('在气泡里说了为什么停', () => {
    assert.ok(rec.r.notes.some((n) => n.includes('上限')), JSON.stringify(rec.r.notes));
  });

  test('生成次数上限同样拦得住', async () => {
    // 一个假的「花钱工具」：每次调用把 calls +1，与真 generate 一样。
    const fakeGenerate = {
      name: 'generate',
      description: '假生成',
      costly: true,
      parameters: bundle.registry.objectSchema({ target: bundle.registry.str('落点') }, ['target']),
      run: async (c) => {
        c.budget.calls += 1;
        return { text: '已生成，draftId: d1' };
      },
    };
    const f = scriptedProvider((i, options) =>
      options.tools ? useTool(`g${i}`, 'generate', { target: `.novelforge/plots/00${i}.md` }) : say('收尾')
    );
    const r = await run({ provider: f.provider, tools: [fakeGenerate], limits: { calls: 2, steps: 30 } });
    assert.equal(r.stopReason, 'calls', `${r.stopReason}｜${r.message}`);
    assert.equal(r.calls, 2, String(r.calls));
  });
});

describe('取消', () => {
  let out;
  let rec;
  let fake;
  let abort;
  let drafts;

  /** 一个假的生成工具：往 store 里放一份草稿，模拟「已经花过钱的产出」。 */
  const fakeGenerate = () => ({
    name: 'generate',
    description: '假生成',
    costly: true,
    parameters: bundle.registry.objectSchema({ target: bundle.registry.str('落点') }, ['target']),
    run: async (c) => {
      c.budget.calls += 1;
      c.drafts.put(
        { id: 'd-已经生成的', action: {}, target: {}, raw: '正文', words: 2, createdAt: '' },
        c.sessionId
      );
      return { text: '已生成：剧情 · 4/4 节\ndraftId: d-已经生成的' };
    },
  });

  before(async () => {
    drafts = new bundle.drafts.DraftStore();
    abort = new AbortController();
    fake = scriptedProvider((i) => {
      if (i === 0) {
        return useTool('c1', 'generate', { target: '.novelforge/plots/012.md' });
      }
      // 第二轮开始之前作者点了停止。
      abort.abort(new bundle.provider.CancelledError());
      return say('不该走到这里');
    });
    rec = recorder();
    out = await bundle.loop.runAgent({
      project,
      workspace: new bundle.ws.Workspace(project),
      drafts,
      sessionId: 's1',
      ask: 'x',
      signal: abort.signal,
      provider: fake.provider,
      tools: [fakeGenerate()],
      on: rec.on,
    });
  });

  test('stopReason 是 cancelled', () => {
    assert.equal(out.stopReason, 'cancelled', `${out.stopReason}｜${out.message}`);
  });

  // 取消的是「接着往下做」，不是「刚才做的作废」——那是花过钱的东西。
  test('明说已经产出的东西还在', () => {
    assert.ok(out.message.includes('仍然在') || out.message.includes('采纳'), out.message);
  });

  test('已经产出的 draft 保留在 store 里', () => {
    assert.deepEqual(drafts.bySession('s1').map((d) => d.id), ['d-已经生成的']);
  });

  test('outcome 里带出 draftId，采纳按钮才画得出来', () => {
    assert.deepEqual(out.draftIds, ['d-已经生成的'], JSON.stringify(out.draftIds));
  });

  test('停在工具边界：第一轮的工具跑完了', () => {
    assert.equal(rec.r.toolResults.length, 1, JSON.stringify(rec.r.toolResults));
  });

  test('signal 已经 aborted 时一次模型都不调', async () => {
    const dead = new AbortController();
    dead.abort(new bundle.provider.CancelledError());
    const f = scriptedProvider([say('不该被调用')]);
    const r = await bundle.loop.runAgent({
      project,
      workspace: new bundle.ws.Workspace(project),
      drafts: new bundle.drafts.DraftStore(),
      sessionId: 's1',
      ask: 'x',
      signal: dead.signal,
      provider: f.provider,
    });
    assert.equal(f.calls.length, 0, String(f.calls.length));
    assert.equal(r.stopReason, 'cancelled');
  });
});

describe('工具抛异常', () => {
  let out;
  let rec;
  let fake;

  before(async () => {
    const boom = {
      name: 'boom',
      description: '一定会炸',
      parameters: bundle.registry.objectSchema({ x: bundle.registry.str('随便') }),
      run: async () => {
        throw new Error('磁盘着火了');
      },
    };
    fake = scriptedProvider([useTool('c1', 'boom', { x: '1' }), say('那我换个办法。')]);
    rec = recorder();
    out = await run({ provider: fake.provider, on: rec.on, tools: [boom] });
  });

  // 一个工具炸掉不该带走整轮对话——作者会丢掉之前几步的成果。
  test('循环没有炸，正常走完', () => {
    assert.equal(out.stopReason, 'done', `${out.stopReason}｜${out.message}`);
  });

  test('异常变成 tool 消息回给模型', () => {
    const tool = fake.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(tool.content.includes('磁盘着火了'), tool.content);
  });

  test('前端那一条标了失败', () => {
    assert.equal(rec.r.toolResults[0].ok, false, JSON.stringify(rec.r.toolResults[0]));
  });

  test('模型调一个不存在的工具时也不炸', async () => {
    const f = scriptedProvider([useTool('c1', '并不存在的工具', {}), say('换一个。')]);
    const r = await run({ provider: f.provider });
    assert.equal(r.stopReason, 'done', `${r.stopReason}｜${r.message}`);
    const tool = f.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(tool.content.includes('list / read / search / generate'), tool.content);
  });
});

describe('日志（第 11 条）', () => {
  let fresh;

  before(async () => {
    const from = logs.length;
    const fake = scriptedProvider([
      useTool('c1', 'read', { path: 'chapters/009-北行.md' }),
      say('他说过。'),
    ]);
    await run({ provider: fake.provider });
    fresh = logs.slice(from);
  });

  test('记了工具名', () => {
    assert.ok(fresh.some((l) => l.includes('read')), JSON.stringify(fresh));
  });

  test('记了参数的键名', () => {
    assert.ok(fresh.some((l) => l.includes('path')), JSON.stringify(fresh));
  });

  // 值里可能是一整段正文。
  test('没有参数值', () => {
    assert.ok(!fresh.join('|').includes('chapters/009-北行.md'), JSON.stringify(fresh));
  });

  test('没有 prompt 全文', () => {
    assert.ok(!fresh.join('|').includes('不要另做判断'), JSON.stringify(fresh));
  });

  test('没有正文', () => {
    assert.ok(!fresh.join('|').includes('从没去过北境'), JSON.stringify(fresh));
  });

  test('记了开始与结束、步数与用量', () => {
    assert.ok(fresh.some((l) => l.includes('开始 agent 循环')), JSON.stringify(fresh));
    assert.ok(fresh.some((l) => l.includes('循环结束')), JSON.stringify(fresh));
  });
});

describe('用量记账', () => {
  test('provider 报的用量记进 tokens', async () => {
    const fake = scriptedProvider([
      [{ type: 'text', text: '好的。' }, { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } }],
    ]);
    const out = await run({ provider: fake.provider });
    assert.equal(out.tokens, 1500, String(out.tokens));
  });

  // 不记的话 token 上限形同虚设。
  test('provider 不报用量时按估算记一笔', async () => {
    const fake = scriptedProvider([say('好的。')]);
    const out = await run({ provider: fake.provider });
    assert.ok(out.tokens > 0, String(out.tokens));
  });
});

describe('每一次 tool_use 都配一条 tool_result', () => {
  // 少一条的话 Anthropic 与不少 OpenAI 兼容实现会直接 400，
  // 于是收尾那一轮连「我做到哪了」都说不出来。
  test('一轮里并行调三个工具，三条结果都在', async () => {
    const fake = scriptedProvider([
      [
        { type: 'toolCall', call: { id: 'p1', name: 'read', args: { path: 'chapters/009-北行.md' }, raw: '{}' } },
        { type: 'toolCall', call: { id: 'p2', name: 'read', args: { path: 'chapters/012-入宗.md' }, raw: '{}' } },
        { type: 'toolCall', call: { id: 'p3', name: 'list', args: { path: 'chapters' }, raw: '{}' } },
      ],
      say('看完了。'),
    ]);
    await run({ provider: fake.provider });
    const ids = fake.calls[1].messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    assert.deepEqual(ids, ['p1', 'p2', 'p3'], JSON.stringify(ids));
  });

  test('无进展停下时，剩下那几个调用也各回一条', async () => {
    const same = { path: '不存在.md' };
    const fake = scriptedProvider([
      useTool('s1', 'read', same),
      useTool('s2', 'read', same),
      [
        { type: 'toolCall', call: { id: 's3', name: 'read', args: same, raw: '{}' } },
        { type: 'toolCall', call: { id: 's4', name: 'read', args: same, raw: '{}' } },
      ],
      say('停了。'),
    ]);
    const out = await run({ provider: fake.provider });
    assert.equal(out.stopReason, 'stalled', `${out.stopReason}｜${out.message}`);
    const last = fake.calls[3].messages;
    const assistant = last.filter((m) => m.role === 'assistant').pop();
    const answered = last.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    for (const call of assistant.toolCalls) {
      assert.ok(answered.includes(call.id), `${call.id} 没有对应的 tool 消息：${JSON.stringify(answered)}`);
    }
  });
});
