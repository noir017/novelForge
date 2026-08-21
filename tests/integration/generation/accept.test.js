/**
 * 产物落盘走的是**当场问的那张卡片**：从生成到落盘的一整趟。
 *
 * 这一组从前叫「采纳」：气泡末尾一颗「采纳写入」按钮，可以拖到第二天再点。
 * 现在它和 agent 动手前那一问长一个样——`generate` 一产出就问，答了才落盘
 * （AGENTS 第 19 条：产物落盘前必须过一遍人。**当场过**，不是留一颗按钮）。
 *
 * 三条老约束原样还在，只是触发它们的那一下从「点按钮」变成了「点卡片」：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 生成一轮 | 卡片当场就来，说得出写到哪、是什么形状；**还没答时磁盘没动静** |
 * | 答之前切了一章 | 落点从 draft 取，**不看当下选中的那一章**（从前会写错地方） |
 * | 先改再点写入 | 落盘的是气泡里当下那份（经 `editTurn`），不是模型原样那份 |
 * | 答「不采纳」 | 一个字都不写，气泡上留一行「未采纳」 |
 * | 讨论型回复 | 没有产物，也就没有卡片 |
 * | 刷新网页 | 没答的那张卡随全量状态重推，答了照样落盘 |
 * | 面板销毁 | 卡片作废，产物记成「未采纳」——不留一个永远悬着的等待 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
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
let fake;
let t;
let project;
let controller;
let posted;

let settings = {};
let replyFn = () => PLOT_JSON;

/**
 * 落盘卡片来了怎么答。
 *
 * 返回 verdict（`proceed` / `skip` / `stop`），或 undefined 表示**不答**
 * ——那时 `send()` 会一直等着，用例得自己去把它收掉（换会话 / 销毁面板）。
 * 答之前想干点别的（切章、改气泡里的文本）就在这个函数里干：真实的次序
 * 也是这样——那些动作都发生在作者点下按钮之前。
 */
let onGate = async () => 'proceed';
/** 收到过的卡片，按顺序。 */
let gates = [];

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

/** 发一轮「写剧情」，回收这一轮推给前端的消息（含落盘那一问的往返）。 */
async function send(target, extra = {}) {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '排一下',
      stage: 'plot',
      capability: 'generate',
      target,
      targetNo: 0,
      targetWords: 0,
      attachments: [],
      excludedIds: [],
      ...extra,
    },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    turns,
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    gate: gates[0],
    toasts: posted.filter((m) => m.type === 'toast'),
  };
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
  };
  // 覆盖审阅一律放行：这一组测的是「写到哪」，不是「问不问」。
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'accept', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no, title, arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: `第 ${no} 章要达成的事` },
    });
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
    replyFn = () => PLOT_JSON;
    onGate = async () => {
      // ★ 答之前磁盘上不该有任何动静：写在「同意」之后，不在生成之后。
      diskWhenAsked = await project.readPlot(P1);
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('产出了回复', () => {
    assert.ok(r.assistant, JSON.stringify(r.turns.map((x) => x.role)));
  });

  test('问了这一句', () => {
    assert.ok(r.gate, JSON.stringify(posted.map((m) => m.type)));
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
    assert.ok(!bundle.plotFile.isPlotFilled(diskWhenAsked.sections), JSON.stringify(diskWhenAsked.sections));
  });

  test('答了才写进去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('气泡上记下写到哪了', () => {
    assert.equal(r.assistant.acceptedTo, P1, JSON.stringify(r.assistant));
  });

  // 展示快照仍在：翻回来看得出这一轮产出过什么。
  test('展示快照还在', () => {
    assert.equal(r.assistant.artifact.summary, '剧情 · 4/4 节', JSON.stringify(r.assistant.artifact));
  });
});

describe('落点从 draft 里取，不看当下选中的那一章', () => {
  let r;

  before(async () => {
    t.remove(P2);
    await new bundle.ws.Workspace(project).writePlot({
      no: 2, title: '藏书阁', arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '第 2 章要达成的事' },
    });
    project.invalidate();
    replyFn = () => PLOT_JSON;
    h.answers.push('覆盖');
    onGate = async () => {
      // 生成完、还没点写入之前**切到另一章**——这正是从前会写错地方的那一下。
      await controller.handle({ type: 'setTarget', target: { kind: 'plot', plotRelPath: P2 } });
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('写成功了', () => {
    assert.ok(!r.toasts.some((x) => x.level === 'error'), JSON.stringify(r.toasts));
  });

  test('写进了生成时那一章', () => {
    assert.ok(t.read('.novelforge/plots/001-夜入青云.md').includes('三拍推进'));
  });

  // 关键：切过去的那一章一个字都不该被写。
  test('没有写到当下选中的那一章', async () => {
    const other = await project.readPlot(P2);
    assert.ok(!bundle.plotFile.isPlotFilled(other.sections), JSON.stringify(other.sections));
  });
});

describe('落盘的是气泡里当下那份', () => {
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    h.answers.push('覆盖');
    onGate = async (msg) => {
      // 作者在气泡里改了两个字再点写入：真实次序也是这样——contenteditable
      // 失焦时先发 `editTurn`，然后那一下点击才发出去。
      await controller.handle({
        type: 'editTurn',
        turnId: msg.turnId,
        text: JSON.stringify({
          目标: '进入宗门',
          剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
          冲突与转折: '我自己改成了两拍',
          伏笔与回收: '第三块令牌',
        }),
      });
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P2 });
  });

  test('写成功了', () => {
    assert.ok(!r.toasts.some((x) => x.level === 'error'), JSON.stringify(r.toasts));
  });

  // 用 draft.raw 的话，作者改的那两个字就没了——而他改完才点的写入。
  test('落盘的是改过的那一版', () => {
    assert.ok(t.read('.novelforge/plots/002-藏书阁.md').includes('我自己改成了两拍'));
  });

  test('模型原样输出的那一版没写进去', () => {
    assert.ok(!t.read('.novelforge/plots/002-藏书阁.md').includes('三拍推进'));
  });
});

describe('答「不采纳」', () => {
  let r;

  before(async () => {
    t.remove(P1);
    await new bundle.ws.Workspace(project).writePlot({
      no: 1, title: '夜入青云', arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '第 1 章要达成的事' },
    });
    project.invalidate();
    replyFn = () => PLOT_JSON;
    onGate = async () => 'skip';
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('一个字都没写', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  // 翻回来要看得出「这一轮产出过一份剧情，我没要」。
  test('气泡上留了一行「未采纳」', () => {
    assert.equal(r.assistant.artifact.declined, true, JSON.stringify(r.assistant.artifact));
    assert.equal(r.assistant.acceptedTo, undefined, r.assistant.acceptedTo);
  });
});

describe('讨论型回复没有产物，也就没有卡片', () => {
  let r;

  before(async () => {
    replyFn = () => '我觉得这一章的冲突可以提前。';
    onGate = async () => 'proceed';
    r = await send({ kind: 'plot', plotRelPath: P1 }, { capability: 'discuss' });
  });

  test('没问', () => {
    assert.equal(r.gate, undefined, JSON.stringify(r.gate));
  });

  test('也没有展示快照', () => {
    assert.equal(r.assistant.artifact, undefined, JSON.stringify(r.assistant.artifact));
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
    t.remove(P2);
    await new bundle.ws.Workspace(project).writePlot({
      no: 2, title: '藏书阁', arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '第 2 章要达成的事' },
    });
    project.invalidate();
    replyFn = () => PLOT_JSON;
    onGate = async (msg) => {
      requestId = msg.requestId;
      return undefined; // 先不答：模拟作者还没点，网页就刷新了
    };
    pending = send({ kind: 'plot', plotRelPath: P2 });
    // 等这一问发出来。
    while (!requestId) {
      await new Promise((r) => setTimeout(r, 5));
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
    assert.ok(t.read('.novelforge/plots/002-藏书阁.md').includes('三拍推进'));
  });
});

/**
 * 面板销毁（关掉整个窗口）时那张卡没人答得了：**按「没采纳」结算**，
 * 不留一个永远悬着的等待。产物不落盘，作者重新生成一次即可。
 */
describe('面板销毁：卡片作废，产物不落盘', () => {
  let r;

  before(async () => {
    t.remove(P1);
    await new bundle.ws.Workspace(project).writePlot({
      no: 1, title: '夜入青云', arc: '', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '第 1 章要达成的事' },
    });
    project.invalidate();
    replyFn = () => PLOT_JSON;
    let asked = false;
    onGate = async () => {
      asked = true;
      return undefined;
    };
    const pending = send({ kind: 'plot', plotRelPath: P1 });
    while (!asked) {
      await new Promise((x) => setTimeout(x, 5));
    }
    controller.dispose();
    r = await pending;

    // 后面的用例还要用 controller：换一个新的接着跑。
    controller = new bundle.controller.ChatController(project);
    attach();
  });

  test('没写进去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('记成「未采纳」', () => {
    assert.equal(r.assistant.artifact.declined, true, JSON.stringify(r.assistant.artifact));
  });
});

describe('并发控制搬到 controller 之后', () => {
  let concurrent;
  let callsTotal;

  before(async () => {
    replyFn = () => PLOT_JSON;
    onGate = async () => 'skip';
    fake.reset();
    // 不 await 第一条：`send` 第一行就占住生成位（早于它自己的
    // `await persist`），所以此刻第二条一定撞得上。
    //
    // 从前占位在 runTurn 里，而 send 要先 `await persist(c)` 才走到那儿——
    // 第一条在落盘处让出事件循环时 currentAbort 还没设，第二条照样过检，
    // 两条一起烧 token。本机磁盘快，第一条常常一路同步跑完，所以那个竞态
    // 只在 CI 上现形。
    const first = send({ kind: 'plot', plotRelPath: P1 });
    concurrent = await send({ kind: 'plot', plotRelPath: P1 });
    await first;
    callsTotal = fake.calls.length;
  });

  // 这句话与它的行为是搬家前后必须一字不差的那一条。
  test('第二条被拒，说「已有一个生成任务在进行中」', () => {
    assert.ok(
      concurrent.toasts.some((m) => m.level === 'error' && m.message.includes('已有一个生成任务在进行中')),
      JSON.stringify(concurrent.toasts)
    );
  });

  // 两条请求只该烧一次 token。
  test('被拒的那条没有调模型', () => {
    assert.equal(callsTotal, 1, `调了 ${callsTotal} 次`);
  });

  test('第一条跑完之后又能发了', async () => {
    const again = await send({ kind: 'plot', plotRelPath: P1 });
    assert.ok(again.assistant?.artifact, JSON.stringify(again.toasts));
  });

  // 上面那两条依赖「第二次 send 恰好撞在第一次让出事件循环的窗口里」，
  // 磁盘一快就可能整条同步跑完、根本没撞上，于是竞态回归了也照样绿。
  // 这一条不靠时序：直接查占位发生在 send 的第一个 await **之前**。
  test('占位早于 send 里任何一次 await（竞态窗口为零）', () => {
    const src = fs.readFileSync('src/core/controller/chat.ts', 'utf8');
    const from = src.indexOf('export async function send');
    const to = src.indexOf('/** 重来一轮', from);
    assert.ok(from >= 0 && to > from, '找不到 send 的函数体');
    // 注释里也有「await」二字，按行剔掉注释再找。
    const code = src
      .slice(from, to)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const lease = code.indexOf('c.beginGeneration()');
    const firstAwait = code.indexOf('await ');
    assert.ok(lease >= 0, 'send 里没有占位');
    assert.ok(
      lease < firstAwait,
      `占位在第一个 await 之后（占位 ${lease} / await ${firstAwait}）：` +
        '两条并发请求会双双过检、各烧一份 token'
    );
  });
});
