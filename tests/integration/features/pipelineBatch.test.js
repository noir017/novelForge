/**
 * 工程页流水线批量动作：批量拆细纲、批量写正文（补齐设定在 settingsBatch.test.js）。
 *
 * - **批量拆细纲**（二期）：区间里还没有细纲的章，每批 5 章、严格串行地走生成链
 *   （generation/structured.ts）。每批写完就落盘，后一批读得到它；一批失败就停。
 * - **批量写章**：四期改成严格串行，用例在 writeBatch.test.js；这里只留「取消就一次都不调」。
 *
 * 这两条路的失败方式和单次生成完全不同——一次跑几十章，所以要钉住的是：
 * 1. **只补不改**：已经有产物的章一律跳过，不问、不覆盖（第 19 条的批量那一面）。
 * 2. **一批失败就停**：后一批要接着它往下排。
 * 3. **失败留在那一章上**：toast 五秒就没了（第 16 条）。
 * 4. **没有前置产物就不跑**：没有大纲还写细纲，等于让模型凭空编四十章。
 * 5. **动手前说清调几次模型**，并发不改变这个数（第 4 条）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

/** 模型交回的一章蓝图。标题故意和磁盘那份不一样。 */
const bp = (no, over = {}) => ({
  chapterNumber: no,
  title: '模型起的名',
  role: '铺垫',
  purpose: '进入宗门',
  keyEvents: '踩点、失手、翻墙；收在藏书阁门口。',
  characters: ['林昭', '沈青'],
  suspenseHook: '藏书阁里有人在等他',
  ...over,
});
/** 按契约里写的区间应答：「chapterNumber 必须覆盖第 3–5 章的每一章」。 */
function blueprintsFor(messages, over = {}) {
  const user = messages[messages.length - 1].content;
  const m = /chapterNumber 必须覆盖第 (\d+)(?:–(\d+))? 章的每一章/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const items = [];
  for (let no = from; no <= to; no++) {
    items.push(bp(no, typeof over === 'function' ? over(no) : over));
  }
  return JSON.stringify({ blueprints: items });
}
const OUTLINE = '# 大纲\n\n## 第1–20章：第一幕 · 入局\n\n- 林昭进入青云宗\n';
/** 总章数 3：缺省的那一批收在第 3 章，下面批量写正文那几组只面对这三章。 */
const CONFIG = '---\ntotalChapters: 3\n---\n\n# 小说配置\n\n## 核心梗概\n\n少年入宗。\n';

let bundle;
let h;
let fake;
let t;
let project;

/** `config.read()` 的返回值，configure() 每次整体换掉。 */
let settings = {};
/** 第 N 次调用该返回什么。 */
let replyFn = () => '';
/** warn / error 级日志。helper 没有这个能力，内联一个 sink。 */
const warns = [];

function configure(extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    ...extra,
  };
  fake.calls.length = 0;
  h.toasts.length = 0;
  h.confirms.length = 0;
  warns.length = 0;
  // 答案队列也清空：流程发现「没有可做的」时会在弹确认框之前就返回，
  // 留在队列里的那个答案会被下一个用例的确认框读到，串成一串假失败。
  h.answers.length = 0;
}

/** 建一章只有「本章目的」的骨架——还没排过（isPlotFilled 只看关键事件）。 */
async function skeleton(no, title, extra = {}) {
  return wsOf(project).writePlot({
    no,
    title,
    role: '',
    characters: [],
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: `第 ${no} 章要达成的事` },
    ...extra,
  });
}

/** 按号取这一章的流水线。 */
async function pipelineOf(no) {
  project.invalidate();
  return bundle.pipe.buildPlotPipeline(project, { no, plot: await project.getPlot(no) });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });
  wsMod = bundle.ws;

  // 假宿主没有 reviewReplace——批量路径本来就不该逐份弹 diff。
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      warns.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
  fake = installFakeProvider(bundle.registry, { reply: (messages, i) => replyFn(messages, i) });

  t = await makeTempProject(bundle.project, {
    prefix: 'batch',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
  // 作者给第 1、3 章定了字数：批量拆细纲不该把它们抹掉。
  for (const [no, title, extra] of [[1, '楔子', { targetWords: 5000 }], [2, '入镇'], [3, '夜访', { targetWords: 3000 }]]) {
    await skeleton(no, title, extra);
  }
  t.write('.novelforge/config.md', CONFIG);
  project.invalidate();
  await project.syncManifest();
});

after(() => {
  // 库开着的话 Windows 上删不掉临时目录。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批量拆细纲 · 前置检查', () => {
  let callCount;
  let toasts;

  before(async () => {
    configure();
    // 没有大纲就写细纲，等于让模型凭空编三章。
    fs.writeFileSync(t.rel('.novelforge/outline.md'), '');
    project.invalidate();
    h.answers.push('开始拆细纲');
    await bundle.batch.generatePlots(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  test('大纲为空时不调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('大纲为空时说明原因', () => {
    assert.ok(toasts.some((x) => x.includes('大纲')), toasts.join('|'));
  });

  test('大纲为空时一章的细纲都没写', async () => {
    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('批量拆细纲', () => {
  let callCount;
  let confirm;
  let sys;
  let users;
  let returned;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    fs.writeFileSync(t.rel('.novelforge/outline.md'), OUTLINE);
    configure();

    // 先给第 2 章一份手写细纲——它必须原样保留，而且把区间断开。
    await wsOf(project).writePlot({
      no: 2,
      title: '入镇',
      role: '',
      characters: [],
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        本章目的: '进镇',
        关键事件: '这是作者手写的',
      },
    });

    replyFn = (messages) => blueprintsFor(messages);
    h.answers.push('开始拆细纲');
    returned = await bundle.batch.generatePlots(project);

    callCount = fake.calls.length;
    confirm = h.confirms[0];
    // 装配走的是同一个装配器 → 细纲阶段的配方里有大纲、没有正文全文。
    sys = fake.calls[0].find((m) => m.role === 'system').content;
    users = fake.calls.map((c) => c.find((m) => m.role === 'user').content);

    // 再跑一次：全都有了，一次都不该调。
    configure();
    h.answers.push('开始拆细纲');
    await bundle.batch.generatePlots(project);
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  // 缺省区间是下一可写章起 5 章，收在总章数（3）。第 2 章排过，把区间断成两批：[1] 与 [3]。
  test('只为没排过细纲的章调模型，跳过的章把区间断开', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
    assert.ok(users[0].includes('请输出第 1 章的细纲') && users[1].includes('请输出第 3 章的细纲'), users.map((u) => u.slice(-200)).join('\n'));
  });

  // 第 4 条：动手前说清要调几次模型——有自动修复，所以报预计与上限。
  test('确认框里写明批数与调用次数', () => {
    assert.ok(confirm?.message.includes('要拆 2 章细纲，分 2 批，预计 2 次调用，最多 6 次'), JSON.stringify(confirm));
  });

  test('确认框说清排过的不会被改动', () => {
    assert.ok(confirm?.detail.includes('已经排过的第 2 章跳过，不会被改动'), JSON.stringify(confirm));
  });

  test('返回实际调用次数（agent 的预算记它）', () => {
    assert.equal(returned, 2);
  });

  test('第 1、3 章写出细纲', async () => {
    for (const no of [1, 3]) {
      const plot = await project.getPlot(no);
      assert.ok(bundle.plotFile.isPlotFilled(plot.sections), `${no}: ${JSON.stringify(plot.sections)}`);
    }
  });

  test('细纲内容来自模型：三个字段对到三节', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.sections.章末钩子, '藏书阁里有人在等他');
    assert.equal(plot.sections.本章目的, '进入宗门');
  });

  // 批量拆细纲改的是三个小节与规划字段，不该把作者起的名字、定的字数抹掉。
  test('标题沿用磁盘那份，文件名不变', () => {
    assert.ok(t.has('.novelforge/plots/001-楔子.md'));
    assert.ok(!t.has('.novelforge/plots/001-模型起的名.md'));
  });

  test('作者定的目标字数原样留着', async () => {
    assert.equal((await project.getPlot(1)).targetWords, 5000);
    assert.equal((await project.getPlot(3)).targetWords, 3000);
  });

  test('结构功能与计划出场收下', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.role, '铺垫');
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
  });

  // 只补不改：手写的那一份一个字都不能动。
  test('手写的细纲原样保留', () => {
    assert.ok(
      t.read('.novelforge/plots/002-入镇.md').includes('这是作者手写的'),
      t.read('.novelforge/plots/002-入镇.md').slice(0, 300)
    );
  });

  // 每批写完就落盘：第二批的装配读得到第一批刚写好的第 1 章。
  test('后一批读得到前一批刚写好的细纲', () => {
    assert.ok(users[1].includes('踩点、失手、翻墙'), users[1].slice(0, 2000));
  });

  // 上游是大纲里**覆盖本章那一节**，不是全书的指纹。
  test('细纲记下大纲里覆盖本章那一节的指纹', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.upstreamHash, bundle.outlineFile.outlineUpstreamHash(OUTLINE, 1));
  });

  test('系统提示是剧情编剧的身份', () => {
    assert.ok(sys.includes('剧情编剧'), sys.slice(0, 60));
  });

  test('装配带上了情节大纲', () => {
    assert.ok(users[0].includes('林昭进入青云宗'));
  });

  test('细纲阶段不带正文全文', () => {
    assert.ok(!users[0].includes('# 前文正文'), users[0].slice(0, 200));
  });

  // 契约是蓝图合同（purpose / keyEvents / suspenseHook 对到 D3 三节）；从前那条
  // 「不写画面台词」的禁令删掉了——关键事件可以写到具体场面。
  test('细纲契约是蓝图合同的三个正文字段', () => {
    for (const key of ['purpose', 'keyEvents', 'suspenseHook']) {
      assert.ok(users[0].includes(key), `契约里没有 ${key}：${users[0].slice(-600)}`);
    }
  });

  test('细纲契约不再要老四节', () => {
    assert.ok(!/"剧情脉络"|"冲突与转折"/.test(users[0]), users[0].slice(-600));
  });

  test('没有缺口时不调模型', () => {
    assert.equal(callCountAgain, 0, `调了 ${callCountAgain} 次`);
  });

  test('没有缺口时给出说明', () => {
    assert.ok(toastsAgain.some((x) => x.includes('都已经排过细纲了')), toastsAgain.join('|'));
  });
});

describe('批量拆细纲 · 一批失败就停', () => {
  let calls;
  let users;
  let toastsSnapshot;
  let failures;
  let plotsAfter;

  before(async () => {
    // 这一组要第 6 章以后的章：总章数临时放到 30。
    t.write('.novelforge/config.md', CONFIG.replace('totalChapters: 3', 'totalChapters: 30'));
    project.invalidate();
    configure();
    // 模型返回一段废话——严格解码认不出，绝不能写盘：界面上会显示「已规划」，
    // 而里面什么都没有。拆半、单章重建都救不回来。
    replyFn = () => '我不太确定这几章要写什么。';
    // 弹窗已经把切分与调用次数报过了：不再弹第二个确认框。
    await bundle.batch.generatePlots(project, { range: { from: 6, to: 12 }, confirmed: true });
    calls = fake.calls.length;
    users = fake.calls.map((c) => c.find((m) => m.role === 'user').content);
    toastsSnapshot = [...h.toasts];
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
    plotsAfter = (await project.listPlots()).map((p) => p.no);
    t.write('.novelforge/config.md', CONFIG);
    project.invalidate();
  });

  test('弹窗确认过的不再弹确认框', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  // 第 6–10 章一批：整批解不出 → 拆出第 6–7 章 → 拆出第 6 章 → 单章重建 → 仍不行，停。
  test('降级链走到头就停，只调了 4 次', () => {
    assert.equal(calls, 4, users.map((u) => u.slice(-120)).join('\n'));
  });

  // 后一批（第 11–12 章）要接着前一批往下排，前一批没成就不跑。
  test('后一批没有跑', () => {
    assert.ok(!users.some((u) => u.includes('第 11–12 章')), users.map((u) => u.slice(-200)).join('\n'));
  });

  test('一份细纲都没写', () => {
    assert.ok(!plotsAfter.some((no) => no >= 6), plotsAfter.join(','));
  });

  test('失败挂在那一批第一章的细纲上', () => {
    assert.ok(!!failures['.novelforge/plots/006.md'], JSON.stringify(Object.keys(failures)));
  });

  test('toast 说清停在哪', () => {
    assert.ok(toastsSnapshot.some((x) => x.includes('第 6–10 章的细纲没拆成') && x.includes('已停下')), toastsSnapshot.join('|'));
  });
});

// 批量写章（四期改成严格串行：续写链、写完即定稿、失败即停、章间停下）在 writeBatch.test.js。

describe('用户取消', () => {
  let callCount;
  let stillSkeleton;
  let writeCalls;

  before(async () => {
    configure();
    await skeleton(1, '楔子');
    // answers 空着 = 用户点了 ×。
    await bundle.batch.generatePlots(project);
    callCount = fake.calls.length;
    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    stillSkeleton = !bundle.plotFile.isPlotFilled(plot.sections);

    // 写正文那一条同样：取消 = 一次都不调。
    await wsOf(project).writePlot({
      no: 6, title: '雪夜', role: '', characters: [], upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 关键事件: '雪下了一夜。' },
    });
    configure();
    await bundle.batch.writeManuscripts(project);
    writeCalls = fake.calls.length;
  });

  test('取消后不调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('取消后不写盘', () => {
    assert.ok(stillSkeleton);
  });

  test('取消批量写正文也不调模型、不建章节', async () => {
    assert.equal(writeCalls, 0, `调了 ${writeCalls} 次`);
    assert.ok(!(await project.listChapters()).some((c) => c.order === 6));
  });
});
