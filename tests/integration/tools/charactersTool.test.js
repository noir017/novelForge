/**
 * `characters` 工具：角色卡（提取、建卡、增量更新 / 重写、清理别名、合并重复、对比「当前状态」）。
 *
 * 每个动作都是工程页角色卡那几颗按钮背后的同一个函数，确认框、提示条都在 feature 自己那里；
 * 这几个 feature 不报调用次数，回给模型的只有一句「交出去了，去哪看结果」，账上记 0。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 十个动作都在枚举里、都写进了描述 | 模型照着描述找动作 |
 * | 要角色卡路径 / 人名的动作缺了当场报错、不花钱 | 不放它跑一趟空的 |
 * | 给错参数（建卡给 path）当场报错，说清谁认 | 模型以为传了、其实被忽略，比多一次往返更糟 |
 * | 还没有角色卡时清理别名：feature 自己说明，不报错 | 转发，不是重写 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const ACTIONS = [
  'extract',
  'create',
  'createAll',
  'update',
  'rebuild',
  'updateAll',
  'rebuildAll',
  'cleanAliases',
  'mergeDuplicates',
  'reviewState',
];

let bundle;
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'characters');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
  fake.calls.length = 0;
  h.toasts.length = 0;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () => '{}',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  // makeTempProject 会删掉模板里的示例角色卡：这是一个一张卡都没有的工程。
  t = await makeTempProject(bundle.project, { prefix: 'charactersTool', title: '青云剑录' });
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('动作清单', () => {
  test('十个动作都在可选动作里，也都写进了描述', () => {
    assert.deepEqual(tool().parameters.properties.action.enum, ACTIONS);
    for (const a of ACTIONS) {
      assert.ok(tool().description.includes(`${a}=`), a);
    }
  });

  // 清理别名、合并重复、对比当前状态不调模型，其余都调：描述里各自写明。
  test('描述里写明哪几个调模型', () => {
    const d = tool().description;
    assert.ok(d.includes('cleanAliases=清理角色卡别名里的泛称与别人的名字（只改 aliases，正文不动）（不调模型）'), d);
    assert.ok(d.includes('（调模型，要 name）'), d);
    assert.ok(d.includes('（不调模型，要 path）'), d);
  });

  test('参数只有 action、path、name', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'name', 'path']);
  });

  test('costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });
});

describe('参数不对就当场报错，不花钱', () => {
  for (const action of ['update', 'rebuild', 'reviewState']) {
    test(`${action} 缺角色卡路径`, async () => {
      resetCtx();
      const r = await run({ action });
      assert.ok(r.error?.startsWith(`${action} 需要参数：path。path：那张角色卡的工程内相对路径`), `${action}: ${r.error}`);
      assert.equal(fake.calls.length, 0);
    });
  }

  test('create 缺人名，说明里要求与摘要写法一致', async () => {
    resetCtx();
    const r = await run({ action: 'create' });
    assert.ok(r.error?.startsWith('create 需要参数：name。name：出场人物的名字，与摘要里的写法一致'), r.error);
  });

  // 空白字符串算没给：不放它拿一个空名字去建卡。
  test('只给空白的 name 也算缺', async () => {
    resetCtx();
    const r = await run({ action: 'create', name: '   ' });
    assert.ok(r.error?.includes('需要参数：name'), r.error);
  });

  test('create 给了 path：说清只有哪几个认', async () => {
    resetCtx();
    const r = await run({ action: 'create', name: '林昭', path: '.novelforge/characters/林昭.md' });
    assert.equal(r.error, 'create 不认 path，只有 update / rebuild / reviewState 认。');
  });

  test('批量动作给了 name 当场报错', async () => {
    resetCtx();
    const r = await run({ action: 'updateAll', name: '林昭' });
    assert.equal(r.error, 'updateAll 不认 name，只有 create 认。');
    assert.equal(fake.calls.length, 0);
  });
});

describe('转发给工程页那几个函数', () => {
  test('还没有角色卡时清理别名：feature 自己说明，不调模型、不报错', async () => {
    resetCtx();
    const r = await run({ action: 'cleanAliases' });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('别名清理已交给 Novel Forge 执行'), r.text);
    assert.ok(h.toasts.some((m) => m.includes('还没有角色卡')), JSON.stringify(h.toasts));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  // 次数只在确认框里：回话里不猜一个数，display 也写「未调模型」。
  test('交出去的动作账上记 0，display 写「未调模型」', async () => {
    resetCtx();
    const r = await run({ action: 'mergeDuplicates' });
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.display, { title: 'characters mergeDuplicates', detail: '未调模型' });
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('动手前那一问', () => {
  test('标题是动作的说法，框里写着那个人', () => {
    const intent = tool().intent({ action: 'create', name: '林昭' });
    assert.equal(intent.gate, 'mutating');
    assert.equal(intent.title, '给一位还没有卡的出场人物建卡');
    assert.ok(intent.detail.startsWith('林昭'), intent.detail);
  });
});
