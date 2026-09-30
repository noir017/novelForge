/**
 * 工程页流水线批量动作：批量写细纲、批量写正文。
 *
 * 一章一纲之后两条都是**一章一次调用**：批量写细纲给「文件在、关键事件还空着」的章补，
 * 批量写正文把排好细纲的章直接写进同号的 `chapters/` 章节（没有中转站、也没有拆章）。
 *
 * 这两条路的失败方式和单次生成完全不同——一次跑几十章，所以要钉住的是：
 * 1. **只补不改**：已经有产物的章一律跳过，不问、不覆盖（第 19 条的批量那一面）。
 * 2. **部分失败不影响其余**：第 12 章写不出正文，另外 63 章照样跑完。
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

/** 模型交回的一章细纲（D3 三节 + 规划字段）。标题与字数故意和磁盘那份不一样。 */
const PLOT_JSON = JSON.stringify({
  title: '模型起的名',
  role: '铺垫',
  characters: ['林昭', '沈青'],
  targetWords: 5000,
  本章目的: '进入宗门',
  关键事件: '踩点、失手、翻墙；收在藏书阁门口。',
  章末钩子: '藏书阁里有人在等他',
});
const OUTLINE = '# 大纲\n\n## 第1–20章：第一幕 · 入局\n\n- 林昭进入青云宗\n';

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
  // 第 3 章的作者已经定了 3000 字：批量写细纲不该拿模型给的 5000 顶掉它。
  for (const [no, title, extra] of [[1, '楔子'], [2, '入镇'], [3, '夜访', { targetWords: 3000 }]]) {
    await skeleton(no, title, extra);
  }
  await project.syncManifest();
});

after(() => {
  // 库开着的话 Windows 上删不掉临时目录。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批量写细纲 · 前置检查', () => {
  let callCount;
  let toasts;

  before(async () => {
    configure();
    // 没有大纲就写细纲，等于让模型凭空编三章。
    fs.writeFileSync(t.rel('.novelforge/outline.md'), '');
    h.answers.push('开始生成');
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

describe('批量写细纲', () => {
  let callCount;
  let confirm;
  let sys;
  let user;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    fs.writeFileSync(t.rel('.novelforge/outline.md'), OUTLINE);
    configure();

    // 先给第 2 章一份手写细纲——它必须原样保留。
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

    replyFn = () => PLOT_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);

    callCount = fake.calls.length;
    confirm = h.confirms[0];
    // 装配走的是同一个装配器 → 细纲阶段的配方里有大纲、没有正文全文。
    sys = fake.calls[0].find((m) => m.role === 'system').content;
    user = fake.calls[0].find((m) => m.role === 'user').content;

    // 再跑一次：全都有了，一次都不该调。
    configure();
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  // 三章里第 2 章已排过 → 只该调两次。
  test('只为没排过细纲的章调模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  // 第 4 条：动手前说清要调几次模型。
  test('确认框里写明调用次数', () => {
    assert.ok(confirm?.message.includes('调用 2 次模型'), JSON.stringify(confirm));
  });

  test('确认框说清排过的不会被改动', () => {
    assert.ok(confirm?.detail.includes('不会被改动'), JSON.stringify(confirm));
  });

  test('第 1 章写出细纲', async () => {
    const plot = await project.getPlot(1);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('第 3 章写出细纲', async () => {
    const plot = await project.getPlot(3);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('细纲内容来自模型', () => {
    assert.ok(t.read('.novelforge/plots/001-楔子.md').includes('藏书阁里有人在等他'));
  });

  // 批量写细纲改的是三个小节与规划字段，不该把作者起的名字、定的字数抹掉。
  test('标题沿用磁盘那份，文件名不变', () => {
    assert.ok(t.has('.novelforge/plots/001-楔子.md'));
    assert.ok(!t.has('.novelforge/plots/001-模型起的名.md'));
  });

  test('作者定的目标字数不被模型给的顶掉', async () => {
    assert.equal((await project.getPlot(3)).targetWords, 3000);
  });

  test('没定字数的章收下模型给的', async () => {
    assert.equal((await project.getPlot(1)).targetWords, 5000);
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

  // 上游是大纲里**覆盖本章那一节**，不是全书的指纹。
  test('新细纲记下大纲里覆盖本章那一节的指纹', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.upstreamHash, bundle.outlineFile.outlineUpstreamHash(OUTLINE, 1));
  });

  test('系统提示是剧情编剧的身份', () => {
    assert.ok(sys.includes('剧情编剧'), sys.slice(0, 60));
  });

  test('装配带上了情节大纲', () => {
    assert.ok(user.includes('林昭进入青云宗'));
  });

  test('细纲阶段不带正文全文', () => {
    assert.ok(!user.includes('# 前文正文'), user.slice(0, 200));
  });

  // 契约是蓝图合同（purpose / keyEvents / suspenseHook 对到 D3 三节）；从前那条
  // 「不写画面台词」的禁令删掉了——关键事件可以写到具体场面。
  test('细纲契约是蓝图合同的三个正文字段', () => {
    for (const key of ['purpose', 'keyEvents', 'suspenseHook']) {
      assert.ok(user.includes(key), `契约里没有 ${key}：${user.slice(-600)}`);
    }
  });

  test('细纲契约不再要老四节', () => {
    assert.ok(!/"剧情脉络"|"冲突与转折"/.test(user), user.slice(-600));
  });

  test('没有缺口时不调模型', () => {
    assert.equal(callCountAgain, 0, `调了 ${callCountAgain} 次`);
  });

  test('没有缺口时给出说明', () => {
    assert.ok(toastsAgain.some((x) => x.includes('排过细纲')), toastsAgain.join('|'));
  });
});

describe('批量写细纲 · 部分失败', () => {
  let stillSkeleton;
  let warnsSnapshot;
  let toastsSnapshot;
  let failures;

  before(async () => {
    // 把第 1 章打回骨架重来，验证「解析不出就不写盘」。
    await skeleton(1, '楔子');
    configure();
    // 模型返回一段废话——严格解析认不出，绝不能写盘：
    // 界面上会显示「已规划」，而里面什么都没有。
    replyFn = () => '我不太确定这一章要写什么。';
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);

    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    stillSkeleton = !bundle.plotFile.isPlotFilled(plot.sections);
    warnsSnapshot = [...warns];
    toastsSnapshot = [...h.toasts];

    // 失败挂在那一章上，第二天回来还看得见。
    // recordFailure 是 fire-and-forget，所以这里让出一轮事件循环再查。
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('解析不出内容时不写盘', () => {
    assert.ok(stillSkeleton);
  });

  test('失败进日志', () => {
    assert.ok(warnsSnapshot.some((w) => w.includes('第 1 章')), warnsSnapshot.join('|'));
  });

  test('失败也给出汇总 toast', () => {
    assert.ok(toastsSnapshot.some((x) => x.includes('失败')), toastsSnapshot.join('|'));
  });

  test('失败记录挂在细纲上', () => {
    assert.ok(!!failures['.novelforge/plots/001-楔子.md'], JSON.stringify(Object.keys(failures)));
  });

  // 只有「本章目的」的 JSON 也是解析得出来的——但它不算排过，批量写正文会照着
  // 一个空壳写出一整章。所以批量路径把它也当失败。
  test('只有本章目的、没有关键事件的回复也不写盘', async () => {
    configure();
    replyFn = () => JSON.stringify({ 本章目的: '进宗门' });
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);
    const plot = await project.getPlot(1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('批量写细纲 · 补齐三章', () => {
  let failures;

  before(async () => {
    // 补回第 1 章的细纲，三章齐活——下面的批量写正文要用。
    configure();
    replyFn = () => PLOT_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('三章都排过细纲了', async () => {
    const plots = await project.listPlots();
    assert.ok(
      plots.every((p) => bundle.plotFile.isPlotFilled(p.sections)),
      plots.map((p) => `${p.no}:${bundle.plotFile.isPlotFilled(p.sections)}`).join('|')
    );
  });

  // 修好了还挂着标记，用户会学会无视它。
  test('成功之后那一章的失败标记清掉了', () => {
    assert.ok(!failures['.novelforge/plots/001-楔子.md'], JSON.stringify(Object.keys(failures)));
  });

  // 场景那一层删掉之后这条路只剩两个动作。留一条断言钉住它——
  // 忘记删导出的话，工程页那个菜单项还在，点了会炸。
  test('不再导出批量拆场景', () => {
    assert.equal(bundle.batch.breakdownScenes, undefined);
  });
});

/**
 * 批量写正文：两个批量动作里贵得多的一个。
 *
 * 它比写细纲多一件事：确认框里报出预计总字数（比「40 次调用」更能让人意识到
 * 这一下花多少钱）。正文直接落同号的章节，并在细纲上记 `writtenFrom`。
 */
describe('批量写正文', () => {
  const HANDWRITTEN = 'chapters/003-夜访.md';
  let callCount;
  let confirm;
  let text;
  let manifest;
  let p1;
  let p3;

  before(async () => {
    // 第 3 章作者已经自己写了正文——它必须原样保留。
    t.write(HANDWRITTEN, '# 夜访\n\n作者自己写的正文。\n');
    project.invalidate();
    // 并发 2 路：并发改变的只是完成顺序，不改变调用次数（第 4 条）。
    configure({ concurrency: 2 });

    let i = 0;
    replyFn = () => `这是第 ${++i} 次生成的正文。`;
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);

    callCount = fake.calls.length;
    confirm = h.confirms[h.confirms.length - 1];
    text = t.read('chapters/001-楔子.md');
    manifest = await project.readManifest();
    p1 = await pipelineOf(1);
    p3 = await pipelineOf(3);
  });

  // 一章一次调用。第 1、2 章各一次；第 3 章已经有正文，跳过。
  test('每一章各调一次模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  test('确认框里写明调用次数', () => {
    assert.ok(confirm?.message.includes('调用 2 次模型'), JSON.stringify(confirm));
  });

  test('确认框报出并发路数', () => {
    assert.ok(confirm?.detail.includes('并发 2 章'), JSON.stringify(confirm));
  });

  // 第 1 章的细纲写了 5000 字、第 2 章没写（配置也没写）按 3000 估：约 8 千字。
  test('确认框报出预计字数', () => {
    assert.ok(confirm?.detail.includes('预计产出约 8 千字'), JSON.stringify(confirm));
  });

  test('正文落在同号的章节上', () => {
    assert.ok(t.has('chapters/001-楔子.md'));
    assert.ok(t.has('chapters/002-入镇.md'));
  });

  test('正文内容来自模型', () => {
    assert.ok(text.includes('次生成的正文'), text);
  });

  test('新章节带标题行', () => {
    assert.ok(text.startsWith('# 楔子'), text.slice(0, 20));
  });

  test('新章节进了 manifest', () => {
    const files = manifest.chapters.map((c) => c.file);
    assert.ok(files.includes('chapters/001-楔子.md') && files.includes('chapters/002-入镇.md'), files.join('|'));
  });

  // 只补不改：作者自己写的正文被一次批量抹掉，是这条路上最贵的错误。
  test('手写的正文原样保留', () => {
    assert.equal(t.read(HANDWRITTEN), '# 夜访\n\n作者自己写的正文。\n');
  });

  test('细纲上记下 writtenFrom', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.writtenFrom, bundle.pipe.plotContentHash(plot));
  });

  test('刚写完的正文不标脏', () => {
    assert.equal(p1.chapter.upstreamStale, false);
  });

  // 那一章没经过这条链：不给它补一笔账，它才永远不会被凭空标脏（第 18a 条）。
  test('跳过的那一章不记 writtenFrom', async () => {
    assert.equal((await project.getPlot(3)).writtenFrom, '');
    assert.equal(p3.chapter.upstreamStale, false);
  });

  // 批量路径一次一章，写不够长是可能的：留在「待写正文」，作者去创作页点「接着写」。
  test('没写够目标字数的章留在待写正文', () => {
    assert.equal(p1.stage, 'manuscript', p1.stage);
  });
});

describe('批量写正文 · 同号章节是空文件时写进它，不另建', () => {
  let callCount;
  let text;
  let extra;

  before(async () => {
    // 作者先建了一个 0 字的空章节占位，细纲也排好了。
    await wsOf(project).writePlot({
      no: 5, title: '追兵', role: '', characters: [], upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 关键事件: '追兵到了镇口。' },
    });
    t.write('chapters/005.md', '');
    project.invalidate();
    configure();
    replyFn = () => '马蹄声从镇口传来。';
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);
    callCount = fake.calls.length;
    text = t.read('chapters/005.md');
    extra = (await project.listChapters()).filter((c) => c.order === 5).map((c) => c.relPath);
  });

  test('空章节算空白，照样写', () => {
    assert.equal(callCount, 1, `调了 ${callCount} 次`);
  });

  test('写进那个空文件', () => {
    assert.ok(text.includes('马蹄声'), JSON.stringify(text));
  });

  test('不另建一个同号章节', () => {
    assert.deepEqual(extra, ['chapters/005.md']);
  });
});

describe('批量写正文 · 没排细纲就不写', () => {
  let callCount;
  let toasts;

  before(async () => {
    // 新加一章骨架，只有本章目的没有关键事件。
    await skeleton(4, '追兵');
    await project.syncManifest();
    configure();
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  // 其余几章都写过正文了，第 4 章没排细纲 → 没有可写的，一次都不调。
  // 没排细纲就写正文，模型只能照着标题瞎编，那种正文作者一章都留不下。
  test('没排细纲的章不写', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('说明还有几章没排细纲', () => {
    assert.ok(toasts.some((x) => x.includes('1 章没排细纲')), toasts.join('|'));
  });

  test('没有凭空造出正文', async () => {
    assert.ok(!(await project.listChapters()).some((c) => c.order === 4));
  });
});

describe('批量写正文 · 只补空白', () => {
  let callCount;
  let toasts;
  let textBefore;
  let textAfter;

  before(async () => {
    // 第 4 章的细纲补上，让「没得写」只剩「都写过了」这一个原因。
    await wsOf(project).writePlot({
      no: 4, title: '追兵', role: '', characters: [], upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 关键事件: '追兵。' },
    });
    t.write('chapters/004-追兵.md', '# 追兵\n\n作者写的。\n');
    // 第 1 章的细纲改过：正文标脏了，但批量路径**只补空白**——哪怕上游变了。
    await wsOf(project).edit('.novelforge/plots/001-楔子.md', [{ old: '踩点、失手、翻墙', new: '踩点、翻墙' }]);
    project.invalidate();
    configure();
    textBefore = t.read('chapters/001-楔子.md');
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
    textAfter = t.read('chapters/001-楔子.md');
  });

  test('前提：第 1 章的正文此刻是脏的', async () => {
    assert.equal((await pipelineOf(1)).chapter.upstreamStale, true);
  });

  test('已有正文的章不再调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  // 批量路径上没有「逐个审阅」的余地——唯一安全的做法是只处理空白的那些。
  // 要重写某一章，去创作页单独重写。
  test('标脏的正文也一个字没动', () => {
    assert.equal(textAfter, textBefore);
  });

  test('说清为什么没得写', () => {
    assert.ok(toasts.some((x) => x.includes('写过正文')), toasts.join('|'));
  });
});

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
