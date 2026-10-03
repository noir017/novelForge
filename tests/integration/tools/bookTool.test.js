/**
 * `book` 工具：拆书（导入原稿、从已写正文补齐、从参考书学写法）。
 *
 * 都是工程页那几颗按钮背后的同一个函数。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | import / learn 缺 path 当场报错、不弹框 | 不放它跑一趟空的 |
 * | path 只认工程里的 txt | 章节文件、隐藏目录、工程外的路径一律不认（`features/bookText.ts`） |
 * | 导入：作者取消就回「不要重试」、零调用 | 切分结果先给作者看，他说了算 |
 * | 补齐：作者在第一个框取消就零调用 | 动手前报调用次数（第 4 条） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CH1 = 'chapters/001-夜入青云.md';

let bundle;
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'book');
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
  h.confirms.length = 0;
  h.picks.length = 0;
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

  // 已写了第 1 章正文（还没摘要）：从已写正文补齐有活可干。
  t = await makeTempProject(bundle.project, { prefix: 'bookTool', title: '青云剑录' });
  t.write(CH1, '# 夜入青云\n\n雨下了三天。山门在雨里，林昭在门外。\n');
  t.project.invalidate();
  await t.project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('参数', () => {
  test('import / learn 要 path，缺了当场报错、不弹框', async () => {
    resetCtx();
    h.expect();
    for (const action of ['import', 'learn']) {
      const r = await run({ action });
      assert.ok(r.error?.startsWith(`${action} 需要参数：path。path：工程里那本 txt 的相对路径`), r.error);
    }
    assert.equal(h.confirms.length + h.picks.length, 0);
  });

  test('derive 不认 path，只有 import / learn 认', async () => {
    resetCtx();
    const r = await run({ action: 'derive', path: '原稿.txt' });
    assert.equal(r.error, 'derive 不认 path，只有 import / learn 认。');
    assert.equal(h.confirms.length, 0);
  });

  test('path 只认工程里的 txt：章节文件报错回给模型，不花钱', async () => {
    resetCtx();
    const r = await run({ action: 'import', path: CH1 });
    assert.match(r.error, /不是工程里能拆的 txt/, JSON.stringify(r));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('转发给工程页那几个函数', () => {
  test('导入：作者在确认框取消，回给模型「不要重试」、零调用', async () => {
    resetCtx();
    t.write('原稿.txt', '第一章 入宗\n林昭入宗。');
    t.project.invalidate();
    h.expect(undefined);
    const r = await run({ action: 'import', path: '原稿.txt' });
    assert.match(h.confirms[0].message, /^从《原稿》认出 1 章/);
    assert.match(r.text, /这一次没有导入/);
    assert.match(r.text, /不要重试同一个动作/);
    assert.equal(ctx.usage.calls, 0);
  });

  test('从已写正文补齐：作者在第一个框取消，零调用', async () => {
    resetCtx();
    h.expect(undefined);
    const r = await run({ action: 'derive' });
    assert.match(h.confirms[0].message, /^从已写正文补齐第 1–\d+ 章/);
    assert.match(r.text, /从已写正文补齐这一次没有调用模型/);
    assert.equal(fake.calls.length, 0);
  });
});

describe('工具定义本身', () => {
  test('参数只有 action 与 path', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'path']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['import', 'derive', 'learn']);
  });

  // 典型顺序写在描述里：先导入再补齐，模型才不会拿着原稿直接 derive。
  test('描述里写着先 import 再 derive', () => {
    assert.ok(tool().description.includes('import 导入原稿 → derive'), tool().description);
  });
});
