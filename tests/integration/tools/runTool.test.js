/**
 * `run` 工具：工程动作的白名单口子。
 *
 * 五件事：
 *
 * 1. **白名单之外一律拒绝**，删除/改名/移动单独回一句「这是有意的」。`split`（拆章）
 *    随中转站一起删掉了：老提示词拿着它来试时，要被当成「有意不给」拦下，而不是
 *    「认不出」——后者会让模型换十个名字继续试。
 * 2. **确认框照弹**——作者不同意就一次模型都不调，且回给模型的话要说清
 *    「不要重试同一个动作」。
 * 3. **预计次数报给调用方记账**：弹窗写着 N 次、账上记 1 次，正是第 4 条要防的。
 * 4. **批量写正文走既有流程**：正文直接落同号的 `chapters/NNN-标题.md`（一章一纲，
 *    没有中转站），并在细纲上记 `writtenFrom`——这正是「不要自己用 write 拼」的理由。
 * 5. **定稿按章号认**：给细纲路径也认得到同号那一章；还没有正文就不花钱。
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
const CH1 = 'chapters/001-夜入青云.md';
const CH2 = 'chapters/002-藏书阁.md';

/** 细纲层的应答：按契约里写的区间给一批蓝图（「chapterNumber 必须覆盖第 1–2 章的每一章」）。 */
function plotReply(messages) {
  const user = messages[messages.length - 1].content;
  const m = /chapterNumber 必须覆盖第 (\d+)(?:–(\d+))? 章的每一章/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const blueprints = [];
  for (let no = from; no <= to; no++) {
    blueprints.push({
      chapterNumber: no,
      title: '模型起的名',
      role: '开篇',
      purpose: '进入宗门',
      keyEvents: '踩点、失手、翻墙；收在藏书阁门口。',
      characters: ['林昭'],
      suspenseHook: '墙内有人在等他。',
    });
  }
  return JSON.stringify({ blueprints });
}
const MANUSCRIPT_TEXT = '雨下了三天。山门在雨里，林昭在门外。';
const SUMMARY_JSON = JSON.stringify({
  梗概: '林昭夜入青云宗。',
  出场人物: ['林昭'],
  时间地点: '雨夜，山门外。',
  关键事件: ['翻墙入宗'],
  新增伏笔: [],
  状态变更: '林昭进了宗门。',
});

/**
 * 按装配出的系统提示认是哪一层在问：批量写细纲与批量写正文在同一个用例文件里
 * 跑，各自要拿到自己那一层该有的形状。
 */
function replyFor(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('摘要')) return SUMMARY_JSON;
  if (system.includes('中文长篇小说作者，正在为')) return MANUSCRIPT_TEXT;
  return plotReply(messages);
}

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
    viewsPipeline: './src/core/views/pipeline.ts',
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
    reply: (messages) => replyFor(messages),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agentrun', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.write(
    project.relPath(project.outlinePath),
    { text: '# 大纲\n\n## 第1–20章：入宗\n\n林昭入宗。\n' },
    { mode: 'overwrite' }
  );
  // 全书两章：批量拆细纲的缺省区间（下一可写章起 5 章）收在第 2 章，一批就完。
  await ws.write(
    project.relPath(project.configPath),
    { text: '---\ntotalChapters: 2\n---\n\n# 小说配置\n\n## 核心梗概\n\n少年入宗。\n' },
    { mode: 'overwrite', review: false }
  );
  // 两章细纲都只起了个头（「关键事件」空着）：批量拆细纲有活可干。
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no,
      title,
      role: '',
      characters: [],
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '进入宗门' },
    });
  }
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('白名单之外一律拒绝', () => {
  for (const bad of ['delete', 'remove', 'rename', 'move', 'initProject', 'newChapter', 'split']) {
    test(`${bad} 给 error`, async () => {
      resetCtx();
      const r = await run({ action: bad, path: PLOT2 });
      assert.ok(r.error, JSON.stringify(r));
    });
  }

  // 「没有这个动作」与「这是有意的」是两句话：后者能让模型停下来，
  // 前者会让它换十个名字继续试。
  test('删除类动作的 error 说清了这是有意的', async () => {
    resetCtx();
    const r = await run({ action: 'delete', path: PLOT2 });
    assert.ok(r.error.includes('有意'), r.error);
  });

  // 拆章随中转站一起删了。拿着老提示词来的 agent 要听到「这是有意不给的」，
  // 而不是「认不出」。
  test('split 被当成有意不给的动作拦下', async () => {
    resetCtx();
    const r = await run({ action: 'split', path: PLOT1 });
    assert.ok(r.error && r.error.includes('有意'), JSON.stringify(r));
  });

  test('认不出的 action 在 error 里列出可用动作', async () => {
    resetCtx();
    const r = await run({ action: '把书写完' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('batchPlots') && r.error.includes('batchManuscripts'), r.error);
  });

  // 可用动作里不该再有已经删掉的那一个，否则模型会照着列表去点它。
  test('可用动作清单里没有 split', async () => {
    resetCtx();
    const r = await run({ action: '把书写完' });
    assert.ok(!r.error.includes('split'), r.error);
  });

  test('action 必填', async () => {
    resetCtx();
    const r = await run({});
    assert.ok(r.error && r.error.includes('action'), JSON.stringify(r));
  });

  test('要参数的动作缺参数时报错', async () => {
    resetCtx();
    const r = await run({ action: 'summarize' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('拒绝的动作一次模型都不调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });
});

describe('定稿：还没有正文就不花钱', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'summarize', path: PLOT1 });
  });

  // 摘要描述的是写出来的那一章。没有正文时调一次模型，得到的只能是对细纲的复述。
  test('给 error，说清这一章还没有正文', () => {
    assert.ok(r.error && r.error.includes('还没有正文'), JSON.stringify(r));
  });

  test('一次模型都没调', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('一次调用都不报', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('批量拆细纲：作者不同意就什么都不做', () => {
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

  // 第 4 条：动手前必须写明预计调用次数（有自动修复，所以还有上限）。
  test('确认框里写了预计调用几次', () => {
    assert.ok(/预计 \d+ 次调用，最多 \d+ 次/.test(h.confirms[0].message), h.confirms[0].message);
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

  test('磁盘上一章细纲都没多', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => !bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.no)));
  });
});

describe('批量拆细纲：作者同意', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('开始拆细纲');
    r = await run({ action: 'batchPlots' });
  });

  test('两章都排了细纲', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.sections)));
  });

  // 批量拆细纲改的是三个小节与规划字段：作者起的标题不该被抹掉。
  test('标题沿用磁盘那份', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.equal(plot.title, '夜入青云');
  });

  test('规划字段（计划出场的人）随产物落盘', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.deepEqual(plot.characters, ['林昭']);
  });

  // 两章一批：一次调用出两份。
  test('两章一批，调了一次模型', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
  });

  // ★ 实际调了几次，账上就记几次。
  test('调用次数报了出去', () => {
    assert.equal(ctx.usage.calls, 1);
  });

  test('用量在气泡里说出来了', () => {
    assert.ok(reports.some((m) => m.includes('1')), JSON.stringify(reports));
  });

  test('返回文本里有次数', () => {
    assert.ok(r.text.includes('1 次'), r.text);
  });

  test('没事可做时再调一次不花钱', async () => {
    resetCtx();
    h.expect('开始拆细纲');
    const again = await run({ action: 'batchPlots' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('没有调用模型'), again.text);
  });
});

/**
 * 批量写正文是 `run` 存在的理由之一：正文落盘要在细纲上记 `writtenFrom`（第 18 条），
 * agent 拿着 write 自己拼就会漏掉这一步——那一章从此永远不会因为细纲改过而挂 ⟳。
 */
describe('批量写正文：正文直接落同号章节，并在细纲上记指纹', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('开始写作');
    r = await run({ action: 'batchManuscripts' });
  });

  test('确认框写了预计调用几次', () => {
    assert.ok(/调用 2 次模型/.test(h.confirms[0].message), h.confirms[0].message);
  });

  // 一章一纲：没有中转站，正文就落在 chapters/ 里那个同号的文件上。
  test('两章正文都落进了 chapters/', async () => {
    const chapters = await project.listChapters();
    assert.deepEqual(chapters.map((c) => c.relPath), [CH1, CH2]);
  });

  test('正文内容就是模型写的那一段', () => {
    assert.ok(t.read(CH1).includes('山门在雨里'), t.read(CH1));
  });

  test('不再建中转站目录', () => {
    assert.ok(!t.has('.novelforge/manuscripts/001-夜入青云.md'));
  });

  // ★ 少了这一步，细纲后来改过也不会让这一章挂 ⟳。
  test('细纲上记了 writtenFrom，且等于细纲当前内容的指纹', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.equal(plot.writtenFrom, bundle.viewsPipeline.plotContentHash(plot));
  });

  test('调了两次模型，账上也记两次', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 2);
  });

  test('返回文本里有次数', () => {
    assert.ok(r.text.includes('2 次'), r.text);
  });

  // 只补空白：已经写过的章不再动，也不再花钱。
  test('再调一次没事可做，不花钱', async () => {
    resetCtx();
    h.expect('开始写作');
    const again = await run({ action: 'batchManuscripts' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('没有调用模型'), again.text);
  });
});

describe('定稿：按章号认，给细纲路径也行', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'summarize', path: PLOT1 });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('报的是那一章的章号', () => {
    assert.ok(r.text.includes('第 1 章'), r.text);
  });

  test('摘要落在同号章节的镜像位置', () => {
    assert.ok(t.has('.novelforge/summaries/001-夜入青云.md'));
  });

  test('调了一次、记了一次', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 1);
  });

  test('越界路径给 error，且不调模型', async () => {
    resetCtx();
    const bad = await run({ action: 'summarize', path: '../../etc/passwd' });
    assert.ok(bad.error, JSON.stringify(bad));
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
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

  // 细纲号 = 章号：第 1、2 章已经有细纲和正文，新建的那一份就是第 3 章的。
  test('新建的是第 3 章的细纲，平铺在 plots/ 根下', async () => {
    const plots = await project.listPlots();
    assert.deepEqual(plots.map((p) => p.no), [1, 2, 3]);
    assert.ok(plots[2].relPath.startsWith('.novelforge/plots/003'), plots[2].relPath);
    assert.ok(!plots[2].relPath.slice('.novelforge/plots/'.length).includes('/'), plots[2].relPath);
  });

  test('新建的细纲是空骨架（不算排过）', async () => {
    const plots = await project.listPlots();
    assert.ok(!bundle.plotFile.isPlotFilled(plots[2].sections), JSON.stringify(plots[2].sections));
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

  test('action 是枚举，删除类与 split 不在里面', () => {
    const values = tool().parameters.properties.action.enum;
    assert.ok(Array.isArray(values), JSON.stringify(values));
    for (const bad of ['delete', 'remove', 'rename', 'move', 'initProject', 'newChapter', 'split']) {
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

  // 四期：定稿 = 摘要（带连续性事实）+ 出场角色的当前状态。
  test('summarize 的说法是「定稿」：摘要与连续性事实，再更新角色状态', () => {
    assert.ok(
      tool().description.includes('给某一章定稿（摘要与连续性事实，再更新出场角色的当前状态）'),
      tool().description
    );
  });
});
