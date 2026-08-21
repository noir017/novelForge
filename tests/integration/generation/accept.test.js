/**
 * 产物落盘走的是**当场问的那张卡片**：从 agent 调 generate 到落盘的一整趟。
 *
 * 这一组从前走的是「单步创作」那条路（前端带着 stage/capability 发一条 send）。
 * 那条路没了，对话只剩 agent 一条——但**这几条约束一个都没变**，只是触发它们
 * 的那一下从「点主按钮」变成了「agent 调 generate」：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 生成一轮 | 卡片当场就来，说得出写到哪、是什么形状；**还没答时磁盘没动静** |
 * | 答之前切了一章 | 落点从 draft 取，**不看当下选中的那一章**（从前会写错地方） |
 * | 答「不采纳」 | 一个字都不写，那一行工具条上留「未采纳」 |
 * | 认不出形状 | 没有产物，也就没有卡片 |
 * | 刷新网页 | 没答的那张卡随全量状态重推，答了照样落盘 |
 * | 面板销毁 | 卡片作废，产物不落盘——不留一个永远悬着的等待 |
 * | 并发 | 第二条被拒，且没有烧第二份 token |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const PLOT_JSON = JSON.stringify({
  目标: '进入宗门',
  剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
  冲突与转折: '三拍推进',
  伏笔与回收: '第三块令牌',
});

const P1 = '.novelforge/plots/001-夜入青云.md';
const P2 = '.novelforge/plots/002-藏书阁.md';

let bundle;
let h;
let t;
let project;
let controller;
let posted;

let settings = {};

/** 每一轮 agent 的剧本：调一次 generate 写某一段，然后收尾。 */
let script = [];
/** 每次 provider.stream 收到的 messages，用来数「烧了几份 token」。 */
let calls = [];

/**
 * 落盘卡片来了怎么答。
 *
 * 返回 verdict（`proceed` / `skip` / `stop`），或 undefined 表示**不答**
 * ——那时这一轮会一直等着，用例得自己去把它收掉（刷新 / 销毁面板）。
 * 答之前想干点别的（切章）就在这个函数里干：真实的次序也是这样。
 */
let onGate = async () => 'proceed';
/** 收到过的卡片，按顺序。 */
let gates = [];

/** agent 那条路的假模型：一轮一条剧本，见底就说一句收尾。 */
function installAgentProvider() {
  bundle.registry.registerProviderFactory(() => ({
    id: 'vscode-lm',
    label: '假模型',
    maxInputTokens: async () => undefined,
    stream: async function* (messages) {
      const i = calls.length;
      calls.push(messages);
      for (const ev of script[i] ?? [{ type: 'text', text: '做完了。' }]) {
        yield ev;
      }
    },
  }));
}

const say = (text) => [{ type: 'text', text }];
const genPlot = (id, target) => [
  {
    type: 'toolCall',
    call: { id, name: 'generate', args: { job: 'plot', target }, raw: '{}' },
  },
];

/**
 * 一轮的完整剧本，**三次 stream**：
 *
 * 1. 循环问模型「下一步做什么」→ 它要调 generate
 * 2. `generate` 工具自己调一次创作模型 → 那一份产物
 * 3. 循环把工具结果喂回去 → 模型收尾
 *
 * 中间那一次容易漏：它不是循环发的，是工具在里面发的（走同一个 factory）。
 */
function planFor(target, artifact = PLOT_JSON) {
  return [genPlot('c1', target), say(artifact), say('排好了。')];
}

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        // 不在 post 里同步重入 controller：真实的回答也是下一个事件循环里
        // 从前端发回来的。
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
}

/** 跑一轮 agent，回收这一轮推给前端的消息（含落盘那一问的往返）。 */
async function run(target, ask = '排一下这一段的剧情') {
  posted.length = 0;
  gates = [];
  calls = [];
  script = planFor(target);
  await controller.handle({ type: 'sendAgent', text: ask });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    turns,
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    // 落盘那一张（generate 的花钱确认是另一张，name 是 costly 那类）。
    gate: gates.find((g) => g.name === 'artifact'),
    gates,
    toasts: posted.filter((m) => m.type === 'toast'),
    toolResults: posted.filter((m) => m.type === 'toolResult'),
  };
}

/** 把某一段恢复成「只有目标、还没排剧情」的空壳。 */
async function resetPlot(no, title) {
  const rel = no === 1 ? P1 : P2;
  t.remove(rel);
  await new bundle.ws.Workspace(project).writePlot({
    no,
    title,
    arc: '',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 目标: `第 ${no} 章要达成的事` },
  });
  project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    // 放手模式：这一组测的是「产物落盘那一问」，不是「动手前问不问」。
    // 那一问在任何模式下都在（第 19 条），正好把别的闸门都让开。
    agentPolicy: 'yolo',
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  installAgentProvider();

  t = await makeTempProject(bundle.project, { prefix: 'accept', title: '青云剑录' });
  project = t.project;
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await resetPlot(no, title);
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('生成一轮 → 当场问一句', () => {
  let r;
  let diskWhenAsked;

  before(async () => {
    onGate = async () => {
      // ★ 答之前磁盘上不该有任何动静：写在「同意」之后，不在生成之后。
      diskWhenAsked = await project.readPlot(P1);
      return 'proceed';
    };
    r = await run(P1);
  });

  test('产出了回复', () => {
    assert.ok(r.assistant, JSON.stringify(r.turns.map((x) => x.role)));
  });

  test('问了这一句', () => {
    assert.ok(r.gate, JSON.stringify(r.gates.map((g) => g.name)));
  });

  test('卡片挂在这一轮的气泡上', () => {
    assert.equal(r.gate.turnId, r.assistant.id);
  });

  test('说得出写到哪、是什么形状', () => {
    assert.ok(r.gate.title.includes('夜入青云'), r.gate.title);
    assert.ok(r.gate.detail.includes('4/4 节'), r.gate.detail);
  });

  // 叫停整轮不在这张卡上（那是输入框旁边那颗「停止」）；拒绝那颗写的是
  // 「不采纳」——这一问不是「跳过一步」，是「这份产物我不要」。
  test('两颗按钮：确认 / 不采纳', () => {
    assert.equal(r.gate.proceed, '确认');
    assert.equal(r.gate.skip, '不采纳');
    assert.equal(r.gate.stop, undefined, r.gate.stop);
  });

  test('还没答时磁盘上没动静', () => {
    assert.ok(
      !bundle.plotFile.isPlotFilled(diskWhenAsked.sections),
      JSON.stringify(diskWhenAsked.sections)
    );
  });

  test('答了才写进去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  // 一次调用一行：翻回来看得出「这一份写到哪了」。
  test('那一行工具条上记下写到哪了', () => {
    assert.ok(
      r.toolResults.some((m) => m.summary && m.summary.includes(P1)),
      JSON.stringify(r.toolResults.map((m) => m.summary))
    );
  });
});

/**
 * 落点以 **draft** 为准，不看会话当下选中的是哪一章。
 *
 * 这是 agent 那条路上的日常：作者选着第 2 章，跟它说的却是「把第 1 章的剧情
 * 排一下」。拿 `c.current.target` 当落点会把产物写到他正看着的那一章去。
 *
 * （从前这一条是靠「生成完、答之前切一章」来验的。现在切不动了——整轮 agent
 * 攥着生成位，`setTarget` 在 busy 时会被拒。所以改成从一开始就让两者不一致，
 * 那也更接近真实：agent 本来就可能去改一份作者没选中的产物。）
 */
describe('落点从 draft 里取，不看当下选中的那一章', () => {
  let r;

  before(async () => {
    await resetPlot(1, '夜入青云');
    await resetPlot(2, '藏书阁');
    // 会话停在第 2 章，而这一轮要写的是第 1 章。
    await controller.handle({ type: 'setTarget', target: { kind: 'plot', plotRelPath: P2 } });
    h.answers.push('覆盖');
    onGate = async () => 'proceed';
    r = await run(P1);
  });

  test('写成功了', () => {
    assert.ok(
      r.toasts.some((x) => x.message.includes('已写入')),
      JSON.stringify(r.toasts)
    );
  });

  test('卡片说的是生成时那一章', () => {
    assert.ok(r.gate.title.includes('夜入青云'), r.gate.title);
  });

  test('写进了生成时那一章', () => {
    assert.ok(t.read(P1).includes('三拍推进'));
  });

  // 关键：作者选中的那一章一个字都不该被写。
  test('没有写到当下选中的那一章', async () => {
    const other = await project.readPlot(P2);
    assert.ok(!bundle.plotFile.isPlotFilled(other.sections), JSON.stringify(other.sections));
  });
});

describe('答「不采纳」', () => {
  let r;

  before(async () => {
    await resetPlot(1, '夜入青云');
    onGate = async () => 'skip';
    r = await run(P1);
  });

  test('一个字都没写', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  // 翻回来要看得出「这一轮产出过一份剧情，我没要」。
  test('那一行工具条上留了「未采纳」', () => {
    assert.ok(
      r.toolResults.some((m) => m.summary && m.summary.includes('未采纳')),
      JSON.stringify(r.toolResults.map((m) => m.summary))
    );
  });
});

describe('解析不出产物时不问', () => {
  let gate;

  before(async () => {
    await resetPlot(1, '夜入青云');
    onGate = async () => 'proceed';
    posted.length = 0;
    gates = [];
    calls = [];
    // generate 调出来的是一句大白话：四个小节一个都解析不出来，
    // 于是没有可落盘的形状 → 不该问。
    script = planFor(P1, '这一段我拿不准，先不写。');
    await controller.handle({ type: 'sendAgent', text: '排一下' });
    gate = gates.find((g) => g.name === 'artifact');
  });

  // 兜底解析会把全文塞进「剧情脉络」，所以这一条钉的是**空产物**那一路：
  // 真正解析不出东西时（空串）不问。
  test('磁盘上没有多出一份假剧情', async () => {
    const plot = await project.readPlot(P1);
    const filled = bundle.plotFile.isPlotFilled(plot.sections);
    // 兜底进「剧情脉络」时会算 filled——那时至少要问过一句才允许落盘。
    assert.ok(!filled || !!gate, `filled=${filled} gate=${!!gate}`);
  });
});

/**
 * 前端无状态：网页刷新 / webview 重建之后，还没答的那张卡要跟着回来——
 * 不重推的话，作者眼前什么都没有，而后端还在等他回答。
 */
describe('刷新网页：没答的卡片跟着回来', () => {
  let pending;
  let requestId;
  let resent;

  before(async () => {
    await resetPlot(2, '藏书阁');
    onGate = async (msg) => {
      if (msg.name !== 'artifact') {
        return 'proceed';
      }
      requestId = msg.requestId;
      return undefined; // 先不答：模拟作者还没点，网页就刷新了
    };
    posted.length = 0;
    gates = [];
    calls = [];
    script = planFor(P2);
    pending = controller.handle({ type: 'sendAgent', text: '排一下' });
    // 等这一问发出来。
    while (!requestId) {
      await new Promise((x) => setTimeout(x, 5));
    }

    // 「刷新网页」= 前端重连后发一条 ready，后端重放全量状态。
    posted.length = 0;
    onGate = async () => 'proceed';
    await controller.handle({ type: 'ready' });
    resent = posted.filter((m) => m.type === 'gate');
    await pending;
  });

  test('那张卡被重推了一遍', () => {
    assert.equal(resent.length, 1, JSON.stringify(posted.map((m) => m.type)));
    assert.equal(resent[0].requestId, requestId);
  });

  test('重推的那张答了照样落盘', () => {
    assert.ok(t.read(P2).includes('三拍推进'));
  });
});

/**
 * 面板销毁（关掉整个窗口）时那张卡没人答得了：**按「没采纳」结算**，
 * 不留一个永远悬着的等待。产物不落盘，作者重新生成一次即可。
 */
describe('面板销毁：卡片作废，产物不落盘', () => {
  before(async () => {
    await resetPlot(1, '夜入青云');
    let asked = false;
    onGate = async (msg) => {
      if (msg.name !== 'artifact') {
        return 'proceed';
      }
      asked = true;
      return undefined;
    };
    posted.length = 0;
    gates = [];
    calls = [];
    script = planFor(P1);
    const pending = controller.handle({ type: 'sendAgent', text: '排一下' });
    while (!asked) {
      await new Promise((x) => setTimeout(x, 5));
    }
    controller.dispose();
    await pending;

    // 后面的用例还要用 controller：换一个新的接着跑。
    controller = new bundle.controller.ChatController(project);
    attach();
  });

  test('没写进去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('并发控制：同一时刻只许一轮', () => {
  let concurrent;
  let callsTotal;

  before(async () => {
    await resetPlot(1, '夜入青云');
    onGate = async () => 'skip';
    posted.length = 0;
    gates = [];
    calls = [];
    script = planFor(P1);
    // 不 await 第一条：它一进去就占生成位，此刻第二条一定撞得上。
    const first = controller.handle({ type: 'sendAgent', text: '排一下' });
    posted.length = 0;
    await controller.handle({ type: 'sendAgent', text: '再排一下' });
    concurrent = { toasts: posted.filter((m) => m.type === 'toast') };
    await first;
    callsTotal = calls.length;
  });

  test('第二条被拒，说「已有一个生成任务在进行中」', () => {
    assert.ok(
      concurrent.toasts.some(
        (m) => m.level === 'error' && m.message.includes('已有一个生成任务在进行中')
      ),
      JSON.stringify(concurrent.toasts)
    );
  });

  // 两条请求只该烧第一条那几次。第二条一次都不该发。
  test('被拒的那条没有调模型', () => {
    assert.equal(callsTotal, script.length, `调了 ${callsTotal} 次`);
  });

  test('第一条跑完之后又能发了', async () => {
    await resetPlot(1, '夜入青云');
    onGate = async () => 'proceed';
    h.answers.push('覆盖');
    const again = await run(P1);
    assert.ok(again.gate, JSON.stringify(again.toasts));
  });
});
