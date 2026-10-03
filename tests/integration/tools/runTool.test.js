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
 * 按装配出的系统提示认是哪一层在问：批量拆细纲与批量写章在同一个用例文件里
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

  // 两章一批：一次调用出两份；拆完再排一次叙事线。
  test('两章一批，调了一次模型；拆完排一次叙事线', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
  });

  // ★ 实际调了几次，账上就记几次。
  test('调用次数报了出去', () => {
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
    h.expect('开始拆细纲');
    const again = await run({ action: 'batchPlots' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('没有调用模型'), again.text);
  });
});

/**
 * 批量的区间与模式（六期）：工程页两个弹窗能选的，agent 这条路也能给。确认框照弹，
 * 区间与模式写在框里——「批量写章」与「把第 1–2 章写完并定稿」是分量不一样的两件事。
 * 这里一律在确认框上取消：只看框里写了什么，不花钱。
 */
describe('批量写章：区间与模式写进确认框', () => {
  test('from / to / mode / review 都转给了批量写章', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'batchManuscripts', from: 1, to: 2, mode: 'finalize', review: true });
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('第 1–2 章：要写 2 章正文（写完即定稿、写完即审稿）'), message);
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.ok(r.text.includes('没有调用模型'), r.text);
  });

  // 只给起点：按批量写章的缺省（3 章）往后数，再由 feature 按磁盘收住（第 3 章起没有细纲）。
  test('只给 from 时按缺省章数往后数', async () => {
    resetCtx();
    h.expect();
    await run({ action: 'batchManuscripts', from: 2 });
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('第 2 章：要写 1 章正文（只写正文）'), message);
  });

  test('批量拆细纲也认区间', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'batchPlots', from: 2, to: 2 });
    // 第 2 章已经排过细纲：feature 自己说「都排过了」，不弹确认框、不花钱。
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.ok(r.text.includes('没有调用模型'), r.text);
  });
});

describe('区间与模式的参数不对就当场报错，不弹框、不花钱', () => {
  const cases = [
    ['from 大于 to', { action: 'batchPlots', from: 3, to: 1 }, '区间'],
    ['只给 to', { action: 'batchPlots', to: 3 }, 'from'],
    ['from 不是数', { action: 'batchManuscripts', from: '第三章' }, '章号'],
    ['不认区间的动作给了区间', { action: 'summarize', path: PLOT1, from: 1 }, '不认 from'],
    ['拆细纲给了模式', { action: 'batchPlots', mode: 'finalize' }, '不认 mode'],
    ['模式写错', { action: 'batchManuscripts', mode: 'all' }, 'mode 只能是'],
  ];
  for (const [name, args, word] of cases) {
    test(name, async () => {
      resetCtx();
      const before = h.confirms.length;
      const r = await run(args);
      assert.ok(r.error && r.error.includes(word), JSON.stringify(r));
      assert.equal(h.confirms.length, before, '不该弹确认框');
      assert.equal(fake.calls.length, 0, String(fake.calls.length));
      assert.equal(ctx.usage.calls, 0);
    });
  }
});

/**
 * 批量写正文是 `run` 存在的理由之一：正文落盘要在细纲上记 `writtenFrom`（第 18 条），
 * agent 拿着 write 自己拼就会漏掉这一步——那一章从此永远不会因为细纲改过而挂 ⟳。
 */
describe('批量写正文：正文直接落同号章节，并在细纲上记指纹', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('开始写章');
    r = await run({ action: 'batchManuscripts' });
  });

  // 四期：缺省是下一可写章起 3 章、只写正文；全书只有两章细纲，收在第 2 章。上限含自动续写。
  test('确认框写了区间与预计调用几次', () => {
    assert.equal(h.confirms[0].message, '第 1–2 章：要写 2 章正文（只写正文），预计 2–4 次调用，最多 20 次。现在写？');
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

// 补齐故事架构（六期）：工程页工具栏那颗按钮背后的同一个函数，确认框照弹。
describe('补齐故事架构：转发给工程页那个动作', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ action: 'completeSettings' });
  });

  // 小说配置写了核心梗概，算填过；缺的是另外三件。
  test('确认框写着缺哪几件、预计调用几次', () => {
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('要补齐故事前提、角色图谱、世界观，预计'), message);
  });

  test('作者取消：一次模型都不调，账上也不记', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
  });

  test('回给模型的话说的是架构，不是「没有待处理的章」', () => {
    assert.ok(r.text.includes('补齐故事架构这一次没有调用模型'), r.text);
    assert.ok(!r.text.includes('待处理的章'), r.text);
  });
});

// 排叙事线（七期）：工程页「从细纲排出」背后的同一个函数，确认框照弹。
describe('排叙事线：转发给工程页那个动作', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ action: 'generateThreads' });
  });

  test('确认框写着从哪几章的细纲排、预计调用几次', () => {
    const message = h.confirms[h.confirms.length - 1].message;
    assert.match(message, /^要从第 \d+–\d+ 章的细纲排出叙事线，预计 1 次调用/);
  });

  test('作者取消：一次模型都不调，账上也不记', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(r.text.includes('排叙事线这一次没有调用模型'), r.text);
  });
});

describe('拆书三个动作：转发给工程页那几个函数', () => {
  test('importManuscript / learnFromReference 要 path，缺了当场报错、不弹框', async () => {
    resetCtx();
    h.expect();
    for (const action of ['importManuscript', 'learnFromReference']) {
      const r = await run({ action });
      assert.match(r.error, new RegExp(`${action} 需要参数：path=`), r.error);
    }
    assert.equal(h.confirms.length + h.picks.length, 0);
  });

  test('path 只认工程里的 txt：章节文件报错回给模型，不花钱', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'importManuscript', path: CH1 });
    assert.match(r.error, /不是工程里能拆的 txt/, JSON.stringify(r));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  test('导入：作者在确认框取消，回给模型「不要重试」、零调用', async () => {
    resetCtx();
    t.write('原稿.txt', '第一章 入宗\n林昭入宗。');
    project.invalidate();
    h.expect(undefined);
    const r = await run({ action: 'importManuscript', path: '原稿.txt' });
    assert.match(h.confirms[0].message, /^从《原稿》认出 1 章/);
    assert.match(r.text, /这一次没有导入/);
    assert.match(r.text, /不要重试同一个动作/);
    assert.equal(ctx.usage.calls, 0);
  });

  test('从已写正文补齐：作者在第一个框取消，零调用', async () => {
    resetCtx();
    h.expect(undefined);
    const r = await run({ action: 'deriveFromText' });
    assert.match(h.confirms[0].message, /^从已写正文补齐第 1–\d+ 章/);
    assert.match(r.text, /从已写正文补齐这一次没有调用模型/);
    assert.equal(fake.calls.length, 0);
  });
});

// 工程页那几颗角色卡与全书摘要的按钮，在 run 里各有一个同名动作：转发给同一个 feature 函数，
// 确认框、提示条都在 feature 自己那里，run 只说「交出去了，去哪看结果」。
describe('角色卡维护与全书摘要', () => {
  const NEW_ACTIONS = [
    'rebuildGlobalSummary',
    'extractCharacters',
    'rebuildCard',
    'createAllCards',
    'updateAllCards',
    'rebuildAllCards',
    'cleanAliases',
    'mergeDuplicates',
    'reviewState',
  ];

  test('都在可选动作里，也都写进了描述', () => {
    const actions = tool().parameters.properties.action.enum;
    for (const a of NEW_ACTIONS) {
      assert.ok(actions.includes(a), a);
      assert.ok(tool().description.includes(`${a}=`), a);
    }
  });

  test('要角色卡路径的两个，缺了就当场报错、不花钱', async () => {
    for (const action of ['rebuildCard', 'reviewState']) {
      resetCtx();
      const r = await run({ action });
      assert.ok(r.error?.includes('path=那张角色卡的路径'), `${action}: ${r.error}`);
      assert.equal(fake.calls.length, 0);
    }
  });

  test('还没有角色卡时清理别名：feature 自己说明，不调模型、不报错', async () => {
    resetCtx();
    h.toasts.length = 0;
    const r = await run({ action: 'cleanAliases' });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('已交给 Novel Forge 执行'), r.text);
    assert.ok(h.toasts.some((m) => m.includes('还没有角色卡')), JSON.stringify(h.toasts));
    assert.equal(fake.calls.length, 0);
  });
});

describe('工具定义本身', () => {
  test('标了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('标了 costly（大多数动作会调模型）', () => {
    assert.equal(tool().costly, true);
  });

  test('参数是扁平的标量', () => {
    const props = tool().parameters.properties;
    // url / stage 是写作技能那几个动作的（inspectSkill / installSkill / bindSkill），见 runSkills.test.js。
    assert.deepEqual(Object.keys(props).sort(), ['action', 'from', 'mode', 'name', 'path', 'review', 'stage', 'to', 'url']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object' && p.type !== 'array'), JSON.stringify(props));
  });

  test('mode 是枚举：只写正文 / 写完即定稿', () => {
    assert.deepEqual(tool().parameters.properties.mode.enum, ['draft', 'finalize']);
  });

  // 确认框上看得出这一下要动哪几章、要不要定稿——那是作者决定点不点的依据。
  test('动手前那一问写着区间与模式', () => {
    const intent = tool().intent({ action: 'batchManuscripts', from: 5, to: 8, mode: 'finalize', review: true });
    assert.ok(intent.detail.includes('第 5–8 章，写完即定稿，写完即审稿'), intent.detail);
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

  // 四期：定稿 = 摘要（带连续性事实）+ 出场角色的当前状态；七期再记叙事线。
  test('summarize 的说法是「定稿」：摘要与连续性事实，再更新角色状态、记叙事线', () => {
    assert.ok(
      tool().description.includes('给某一章定稿（摘要与连续性事实，再更新出场角色的当前状态、记下本章推进了哪几条叙事线）'),
      tool().description
    );
  });
});
