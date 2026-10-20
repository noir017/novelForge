/**
 * 调模型之前的确认框（`features/askCall.ts`）：两个下拉框的选项与缺省，以及作者挑了之后这一次真的照着跑
 * （docs/design/plans/2026-10-20-call-choice.md）。拿「从大纲排出叙事线」当载体：一次调用，提示里情节大纲
 * 带多少字随上下文详细度（第 3 级 8000 字、第 1 级 4000 字），看得出详细度换没换。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 模型清单与对话页同一份；缺省按分档；「按分档」那几行一项活一行 | 作者看得见不指定时谁干活 |
 * | 看详细度的框才给详细度下拉框，缺省是设置那一级 | 作者定案 #3：不起作用就不显示 |
 * | 挑了模型：调的就是它；挑了级别：提示照那一级装；设置不变 | 选择只管这一次 |
 * | 嵌套的那一问缺省跟着外面那一次，「按分档」那几行仍照分档说 | 拆完展开、补建角色卡再问一次时不用重挑 |
 * | `preset`：表单上的选择当缺省 | 批量写章表单问过、补建角色卡还要再问时 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;

/** 情节大纲第 5000 字之后的那一截：第 3 级（8000 字）带得到，第 1 级（4000 字）带不到。 */
const TAIL = '尾声里埋下的那枚铜钱';
const LONG_OUTLINE = `# 情节大纲\n\n## 第1–20章：入镇\n\n${'林昭在雨夜里追着黑衣人穿过三条巷子，'.repeat(280)}${TAIL}\n`;

const SETTINGS = {
  providers: [
    {
      id: 'p',
      kind: 'vscode-lm',
      models: [
        { name: 'a', contextWindow: 100000 },
        { name: 'b', contextWindow: 100000 },
      ],
    },
  ],
  models: ['p/a'],
  tierModels: { balanced: ['p/a'] },
  contextDetail: 3,
  concurrency: 1,
};

/** 排叙事线那一次的 user 消息。 */
const userOf = (call) => call[call.length - 1].content;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    config: './src/core/config.ts',
    threads: './src/core/features/threads.ts',
    askCall: './src/core/features/askCall.ts',
    scope: './src/core/runtime/callScope.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => SETTINGS });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: () => '```json\n{"threads":[]}\n```' });
  t = await makeTempProject(bundle.project, { prefix: 'callChoice', title: '青云剑录' });
  t.write('.novelforge/outline.md', LONG_OUTLINE);
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('确认框上的两个下拉框：照缺省点「开始排」', () => {
  let call;

  before(async () => {
    fake.reset();
    h.expect('开始排');
    await bundle.threads.generateThreads(t.project);
    call = h.confirms[0].call;
  });

  test('模型清单与对话页同一份，缺省按分档', () => {
    assert.deepEqual(call.models.map((m) => m.ref), ['p/a', 'p/b']);
    assert.equal(call.model, '');
  });

  test('「按分档」下面一项活一行：剧情细纲交给均衡档', () => {
    assert.deepEqual(call.tiers, ['剧情细纲 → 均衡档：p/a']);
  });

  test('排叙事线看详细度：给了那个下拉框，缺省是设置那一级', () => {
    assert.equal(call.contextDetail, 3);
  });

  test('照分档调 p/a，第 3 级带得到情节大纲的尾巴', () => {
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/a']);
    assert.ok(userOf(fake.calls[0]).includes(TAIL), userOf(fake.calls[0]));
  });
});

describe('作者另挑了模型与级别', () => {
  before(async () => {
    fake.reset();
    h.expect({ action: '开始排', choice: { model: 'p/b', contextDetail: 1 } });
    await bundle.threads.generateThreads(t.project);
  });

  test('调的是挑的那个模型', () => {
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/b']);
  });

  test('提示照第 1 级装：情节大纲只带 4000 字，尾巴没了', () => {
    assert.ok(!userOf(fake.calls[0]).includes(TAIL), userOf(fake.calls[0]));
  });

  test('设置没变', () => {
    assert.equal(bundle.config.readConfig().contextDetail, 3);
    assert.equal(bundle.config.readConfig().pinnedModel, undefined);
  });
});

describe('askCall 的缺省', () => {
  const ask = (extra = {}) =>
    bundle.askCall.askCall({ message: '现在开始？', actions: ['开始'], tasks: ['plotOutline', 'plotOutline'], contextDetail: true, ...extra });

  test('嵌套的那一问跟着外面那一次；「按分档」那几行仍照分档说、同一项活只列一行', async () => {
    h.expect('开始');
    const answer = await bundle.scope.withCallChoice({ model: 'p/b', contextDetail: 2 }, () => ask());
    const { call } = h.confirms[0];
    assert.equal(call.model, 'p/b');
    assert.equal(call.contextDetail, 2);
    assert.deepEqual(call.tiers, ['剧情细纲 → 均衡档：p/a']);
    assert.equal(JSON.stringify(answer), JSON.stringify({ action: '开始', choice: { model: 'p/b', contextDetail: 2 } }));
  });

  test('preset：表单上的选择当缺省，没给的那一项取设置', async () => {
    h.expect('开始');
    await ask({ preset: { model: 'p/b' } });
    const { call } = h.confirms[0];
    assert.equal(call.model, 'p/b');
    assert.equal(call.contextDetail, 3);
  });

  test('不看详细度的框：没有详细度下拉框', async () => {
    h.expect('开始');
    await ask({ contextDetail: false });
    assert.equal(h.confirms[0].call.contextDetail, undefined);
  });

  test('取消：undefined', async () => {
    h.expect();
    assert.equal(await ask(), undefined);
  });
});
