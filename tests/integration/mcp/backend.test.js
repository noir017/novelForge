/**
 * MCP 执行端（`controller/mcp.ts`）：**外部 agent 的一次调用落到一个真的工程上。**
 *
 * 协议那一层在 `tests/unit/mcp/server.test.js`；这里绕过协议直接调 `createMcpBackend`，
 * 守的是第 19 / 25 条在 MCP 这条路上还成立：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 查询（read / list） | 不占生成位、不进对话页 |
 * | 查技能（skills list） | 带 action 的工具按动作报闸门：查询类同样不进对话页；绑技能（`always`）先问 |
 * | generate | 气泡标 MCP、正文流进工具条、**当场问写不写**；同意才落盘，结论接在返回后面；**返回里没有正文** |
 * | generate 不采纳 | 磁盘没动，返回说「不要重复生成」 |
 * | 连着两次调用 | 接在同一个气泡里；作者说过话就另起一个 |
 * | 生成位被占 | 当场回 isError，不排队 |
 * | edit（`always`） | 动手前先问；跳过就一字不改，返回说「不要重试」 |
 * | 参数不对 | 当场回 isError：不问、不占生成位、不进对话页 |
 * | 正文 writeMode=continue | 卡片写追加，落盘接在已有正文后面 |
 * | 简报 | 与状态机同一句「下一步」 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const fs = require('fs');

const PLOT_JSON = JSON.stringify({
  本章目的: '进入宗门',
  关键事件: '踩点、失手、翻墙；收在藏书阁门口。三拍推进。',
  章末钩子: '第三块令牌',
});

const P1 = '.novelforge/plots/001-夜入青云.md';
const P2 = '.novelforge/plots/002-藏书阁.md';

let bundle;
let home;
let h;
let t;
let project;
let controller;
let backend;
let posted = [];
let gates = [];
/** 卡片来了怎么答：返回 proceed / skip。 */
let onGate = async () => 'proceed';
let replyFn = () => PLOT_JSON;

const signal = () => new AbortController().signal;
const call = (name, args) => backend.call(name, args, signal());

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  // 「我的技能库」指到临时目录：skills list 会列出它，不能读到跑测试那台机器上装过的技能。
  home = makeTempDir('mcpSkillsHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  installFakeProvider(bundle.registry, {
    reply: () => replyFn(),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'mcp', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no, title, role: '', characters: [], upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: `第 ${no} 章要达成的事` },
    });
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
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
  backend = bundle.controller.createMcpBackend(controller);
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

function reset() {
  posted = [];
  gates = [];
}

const mcpTurns = () => controller.current.turns.filter((x) => x.mcp);

describe('查询', () => {
  let r;
  before(async () => {
    reset();
    r = await call('read', { path: P1 });
  });

  test('读得到', () => {
    assert.equal(r.isError, false);
    assert.ok(r.text.includes('第 1 章要达成的事'), r.text);
  });

  test('不进对话页、不占生成位', () => {
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone'].includes(m.type)), []);
    assert.equal(mcpTurns().length, 0);
  });
});

describe('generate → 当场问 → 同意才落盘', () => {
  let r;
  let diskWhenAsked;
  before(async () => {
    reset();
    onGate = async () => {
      diskWhenAsked = await project.readPlot(P1);
      return 'proceed';
    };
    r = await call('generate', { target: P1, capability: 'generate' });
  });

  test('气泡标 MCP，挂一条工具条', () => {
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    const seg = turns[0].segments;
    assert.equal(seg.length, 1);
    assert.equal(seg[0].kind, 'tool');
    assert.equal(seg[0].call.name, 'generate');
  });

  test('正文流进那一条工具条下的卡片', () => {
    const deltas = posted.filter((m) => m.type === 'toolDelta').map((m) => m.text).join('');
    assert.ok(deltas.includes('进入宗门'), deltas);
    assert.ok(mcpTurns()[0].segments[0].call.output.includes('进入宗门'));
  });

  test('问了这一句，卡片挂在这个气泡上', () => {
    assert.equal(gates.length, 1);
    assert.equal(gates[0].turnId, mcpTurns()[0].id);
    assert.ok(gates[0].title.startsWith('Agent 要'), gates[0].title);
  });

  test('还没答时磁盘上没动静', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(diskWhenAsked.sections));
  });

  test('答了才落盘', async () => {
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['本章目的'], '进入宗门');
  });

  test('返回里没有正文，只有形状与结论', () => {
    assert.equal(r.isError, false);
    assert.ok(!r.text.includes('踩点、失手'), r.text);
    assert.ok(r.text.includes('draftId'), r.text);
    assert.ok(r.text.includes('不要再写一遍'), r.text);
  });

  test('工具条上记着落盘结论', () => {
    assert.ok(mcpTurns()[0].segments[0].call.summary.includes('已写入'), mcpTurns()[0].segments[0].call.summary);
  });

  test('收尾放开生成位', () => {
    assert.equal(controller.busy, false);
    const busy = posted.filter((m) => m.type === 'busy').map((m) => m.value);
    assert.deepEqual(busy, [true, false]);
  });
});

describe('generate 不采纳', () => {
  let r;
  let before2;
  before(async () => {
    reset();
    before2 = await project.readPlot(P2);
    onGate = async () => 'skip';
    r = await call('generate', { target: P2, capability: 'generate' });
  });

  test('磁盘没动', async () => {
    const plot = await project.readPlot(P2);
    assert.deepEqual(plot.sections, before2.sections);
  });

  test('返回说不要重复生成', () => {
    assert.ok(r.text.includes('不要重复生成'), r.text);
  });

  test('接在上一次的同一个气泡里', () => {
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].segments.length, 2);
  });

  test('作者说了话之后另起一个气泡', async () => {
    controller.current.turns.push({ id: 'u-x', role: 'user', content: '先停一下', at: new Date().toISOString() });
    onGate = async () => 'skip';
    await call('generate', { target: P2, capability: 'generate' });
    assert.equal(mcpTurns().length, 2);
    assert.equal(controller.current.turns.at(-1).mcp, true);
  });
});

describe('生成位被占', () => {
  test('当场回 isError，不排队', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('generate', { target: P1, capability: 'generate' });
      assert.equal(r.isError, true);
      assert.ok(r.text.includes('另一个生成任务'), r.text);
    } finally {
      lease.release();
    }
  });
});

describe('edit：动手前先问', () => {
  test('跳过：一字不改，返回说不要重试', async () => {
    reset();
    onGate = async () => 'skip';
    const before3 = await project.readPlot(P1);
    const r = await call('edit', { path: P1, old: '进入宗门', new: '离开宗门' });
    assert.equal(gates.length, 1);
    assert.ok(gates[0].title.includes('改'), gates[0].title);
    assert.ok(r.text.includes('不要重试'), r.text);
    const after3 = await project.readPlot(P1);
    assert.deepEqual(after3.sections, before3.sections);
  });

  test('同意：改了', async () => {
    reset();
    onGate = async () => 'proceed';
    const r = await call('edit', { path: P1, old: '进入宗门', new: '离开宗门' });
    assert.equal(r.isError, false, r.text);
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['本章目的'], '离开宗门');
  });
});

// 参数本来就不对的调用：不该先在对话页弹一张「改「」里的一段文字」，再等作者答完才报错。
describe('参数不对：当场回话，不问、不占生成位', () => {
  const cases = [
    ['edit 什么都没给', 'edit', {}, 'path 是必填的'],
    ['edit 缺 new', 'edit', { path: P1, old: '进入宗门' }, 'new 是必填的'],
    ['skills bind 缺 stage', 'skills', { action: 'bind', id: 'builtin:long-form-continuity' }, 'bind 需要参数：stage'],
    ['pipeline 认不出的动作', 'pipeline', { action: 'explode' }, '认不出动作「explode」'],
    ['generate 类型不对', 'generate', { target: P1, capability: 'generate', targetWords: '三千' }, 'targetWords 应该是整数'],
  ];
  for (const [label, name, args, want] of cases) {
    test(label, async () => {
      reset();
      onGate = async () => assert.fail('不该问作者');
      const r = await call(name, args);
      assert.equal(r.isError, true);
      assert.ok(r.text.includes(want), r.text);
      assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    });
  }

  test('生成位被占时照样先说参数不对', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('edit', {});
      assert.ok(r.text.includes('path 是必填的'), r.text);
    } finally {
      lease.release();
    }
  });
});

describe('generate 正文接着写：落盘追加在已有正文后面', () => {
  const CH = 'chapters/001-夜入青云.md';
  let r;
  before(async () => {
    reset();
    t.write(CH, '# 夜入青云\n\n雨下了三天。\n');
    project.invalidate();
    replyFn = () => '林昭翻过了墙。';
    onGate = async () => 'proceed';
    r = await call('generate', { target: CH, capability: 'generate', writeMode: 'continue', targetWords: 10 });
  });

  test('卡片写的是追加', () => {
    assert.ok(gates[0].title.includes('追加'), gates[0].title);
  });

  test('原有的正文还在，新写的接在后面', async () => {
    const text = t.read(CH);
    assert.ok(text.indexOf('雨下了三天') >= 0 && text.indexOf('林昭翻过了墙') > text.indexOf('雨下了三天'), text);
    assert.equal(r.isError, false, r.text);
  });
});

// 动作工具的闸门按动作报：同一个 skills，list 是查询，bind 要先问作者。
describe('skills：按动作分闸门', () => {
  test('list 是查询：照样列得出，不进对话页、不占生成位', async () => {
    reset();
    const turnsBefore = mcpTurns().length;
    const r = await call('skills', { action: 'list' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes('builtin:long-form-continuity'), r.text);
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    assert.equal(mcpTurns().length, turnsBefore);
  });

  // 绑定改的是这个工程往后每一次生成的提示词，下游没有 diff 可看：动手前问，跳过就不写。
  test('bind 先在对话页问；作者跳过就不写 skills.json', async () => {
    reset();
    onGate = async () => 'skip';
    const r = await call('skills', { action: 'bind', id: 'builtin:long-form-continuity', stage: 'drafting' });
    assert.equal(gates.length, 1);
    assert.ok(gates[0].title.includes('绑到「写正文」阶段'), gates[0].title);
    assert.equal(r.isError, false, r.text);
    assert.equal(t.has('.novelforge/skills.json'), false);
  });
});

describe('简报', () => {
  test('说得出这本书走到哪、下一步是什么', async () => {
    const brief = await backend.brief();
    assert.ok(brief.startsWith('# 当前工程'), brief);
    assert.ok(brief.includes('《青云剑录》'), brief);
    assert.ok(brief.includes('下一步'), brief);
  });
});
