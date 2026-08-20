/**
 * `run` 工具：工程动作的白名单口子。
 *
 * 四件事：
 *
 * 1. **白名单之外一律拒绝**，删除/改名/移动单独回一句「这是有意的」。
 * 2. **确认框照弹**——作者不同意就一次模型都不调，且回给模型的话要说清
 *    「不要重试同一个动作」。
 * 3. **预计次数报给调用方记账**：弹窗写着 N 次、账上记 1 次，正是第 4 条要防的。
 * 4. **split 走既有流程**：中转站正文进回收站、后面的细纲顺延。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let h;
let fake;
let ctx;
let reports;
let settings;

const PLOT1 = '.novelforge/plots/001-夜入青云.md';
const PLOT2 = '.novelforge/plots/002-藏书阁.md';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'run');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  reports = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: () => {},
  };
  if (fake) {
    fake.calls.length = 0;
  }
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });

  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () =>
      JSON.stringify({
        目标: '进入宗门',
        剧情脉络: '踩点、失手、翻墙。',
        冲突与转折: '三拍',
        伏笔与回收: '令牌',
      }),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agentrun', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.write(
    project.relPath(project.outlinePath),
    { text: '# 大纲\n\n林昭入宗。\n' },
    { mode: 'overwrite' }
  );
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no,
      title,
      arc: '',
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '进入宗门' },
    });
  }
  // 第 1 章有中转站正文，且里面有一行 ---：拆分能拆出两章。
  await ws.appendToManuscript(PLOT1, '雨下了三天。');
  await ws.appendToManuscript(PLOT1, '第二段在这里。');
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('白名单之外一律拒绝', () => {
  for (const bad of ['delete', 'remove', 'rename', 'move', 'initProject', 'newChapter']) {
    test(`${bad} 给 error`, async () => {
      resetCtx();
      const r = await run({ action: bad, path: PLOT2 });
      assert.ok(r.error, JSON.stringify(r));
    });
  }

  // 「没有这个动作」与「这是有意不给的」是两句话：后者能让模型停下来，
  // 前者会让它换十个名字继续试。
  test('删除类动作的 error 说清了这是有意的', async () => {
    resetCtx();
    const r = await run({ action: 'delete', path: PLOT2 });
    assert.ok(r.error.includes('有意'), r.error);
  });

  test('认不出的 action 在 error 里列出可用动作', async () => {
    resetCtx();
    const r = await run({ action: '把书写完' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('batchPlots'), r.error);
    assert.ok(r.error.includes('split'), r.error);
  });

  test('action 必填', async () => {
    resetCtx();
    const r = await run({});
    assert.ok(r.error && r.error.includes('action'), JSON.stringify(r));
  });

  test('要参数的动作缺参数时报错', async () => {
    resetCtx();
    const r = await run({ action: 'split' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('拒绝的动作一次模型都不调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });
});

describe('批量动作：作者不同意就什么都不做', () => {
  let r;

  before(async () => {
    resetCtx();
    // 队列为空 = 确认框返回 undefined = 用户取消。
    h.expect();
    r = await run({ action: 'batchPlots' });
  });

  test('确认框弹过了', () => {
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
  });

  // 第 4 条：动手前必须写明预计调用次数。
  test('确认框里写了预计调用几次', () => {
    assert.ok(/调用 \d+ 次模型/.test(h.confirms[0].message), h.confirms[0].message);
  });

  test('一次模型都没调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('没有报调用次数', () => {
    assert.equal(ctx.usage.calls, 0);
  });

  test('回给模型的话说清了没调模型', () => {
    assert.ok(r.text.includes('没有调用模型'), r.text);
  });

  // 不说清楚它会原地再发一遍——那是最常见的烧钱方式。
  test('还明说了不要重试同一个动作', () => {
    assert.ok(r.text.includes('不要重试'), r.text);
  });

  test('磁盘上一章剧情都没多', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => !bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.no)));
  });
});

describe('批量动作：作者同意', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('开始生成');
    r = await run({ action: 'batchPlots' });
  });

  test('两章都排了剧情', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.sections)));
  });

  test('调了两次模型', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
  });

  // ★ 弹窗写着 2 次，账上就得记 2 次。
  test('预计次数报了出去', () => {
    assert.equal(ctx.usage.calls, 2);
  });

  test('用量在气泡里说出来了', () => {
    assert.ok(reports.some((m) => m.includes('2')), JSON.stringify(reports));
  });

  test('返回文本里有次数', () => {
    assert.ok(r.text.includes('2 次'), r.text);
  });

  test('没事可做时再调一次不花钱', async () => {
    resetCtx();
    h.expect('开始生成');
    const again = await run({ action: 'batchPlots' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('没有调用模型'), again.text);
  });
});

describe('split 走既有流程', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('拆分');
    r = await run({ action: 'split', path: PLOT1 });
  });

  test('确认框弹过了', () => {
    assert.ok(h.confirms.length >= 1, JSON.stringify(h.confirms));
  });

  test('拆成了两章', () => {
    assert.ok(r.text.includes('2 章'), `${r.text}｜${r.error ?? ''}`);
  });

  test('章节文件真的建出来了', async () => {
    const chapters = await project.listChapters();
    assert.equal(chapters.length, 2, JSON.stringify(chapters.map((c) => c.relPath)));
  });

  test('中转站那份不在了（进了回收站，不真删）', () => {
    assert.ok(!t.has('.novelforge/manuscripts/001-夜入青云.md'));
    assert.ok(t.has('.novelforge/.trash/.novelforge/manuscripts/001-夜入青云.md'));
  });

  test('一次模型都没调（拆分是零模型调用的）', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('一次调用都不报', () => {
    assert.equal(ctx.usage.calls, 0);
  });

  test('认不出属于哪一章的路径给 error', async () => {
    resetCtx();
    const bad = await run({ action: 'split', path: '随手写的.txt' });
    assert.ok(bad.error, JSON.stringify(bad));
  });

  test('越界路径给 error', async () => {
    resetCtx();
    const bad = await run({ action: 'split', path: '../../etc/passwd' });
    assert.ok(bad.error, JSON.stringify(bad));
  });
});

describe('newPlot 不花钱', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'newPlot' });
  });

  test('建出了一份细纲', () => {
    assert.ok(r.text.includes('.novelforge/plots/'), `${r.text}｜${r.error ?? ''}`);
  });

  test('一次模型都没调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  // 段号跨 `plots/` 与 `chapters/` 取最大号 +1：它只是 `plots/` 里的排序键，
  // 但仍把已发布的章算进来，好让新建的段在文件名上排在最后。
  test('新建的段号接在最大号之后', async () => {
    const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);
    const max = Math.max(0, ...plots.map((p) => p.no), ...chapters.map((c) => c.order));
    assert.ok(
      plots.some((p) => p.no === max),
      JSON.stringify(plots.map((p) => p.no))
    );
  });
});

describe('工具定义本身', () => {
  test('标了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('标了 costly（大多数动作会调模型）', () => {
    assert.equal(tool().costly, true);
  });

  test('参数是扁平的三个标量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['action', 'name', 'path']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });

  test('action 是枚举，删除类不在里面', () => {
    const values = tool().parameters.properties.action.enum;
    assert.ok(Array.isArray(values), JSON.stringify(values));
    for (const bad of ['delete', 'remove', 'rename', 'move', 'initProject', 'newChapter']) {
      assert.ok(!values.includes(bad), `${bad} 不该在白名单里：${values.join(',')}`);
    }
  });

  // 第 5 条端到端验收点的提示词落点：连续多章该走批量动作而不是循环 generate。
  test('描述里引导「连续多章走批量动作」', () => {
    assert.ok(tool().description.includes('连续多章'), tool().description);
  });

  test('描述里说清了会先弹确认框告诉作者调几次', () => {
    assert.ok(tool().description.includes('确认框'), tool().description);
  });
});
