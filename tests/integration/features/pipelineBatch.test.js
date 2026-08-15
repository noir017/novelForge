/**
 * 工程页流水线批量动作：批量写剧情、批量拆分场景、批量写正文。
 *
 * 这三条路的失败方式和单次生成完全不同——一次跑几十段，所以要钉住的是：
 * 1. **只补不改**：已经有产物的段一律跳过，不问、不覆盖。
 * 2. **部分失败不影响其余**：第 12 章拆不出场景，另外 63 章照样跑完。
 * 3. **失败留在那一段上**：toast 五秒就没了。
 * 4. **没有前置产物就不跑**：没有大纲还写剧情，等于让模型凭空编四十段。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const PLOT_JSON = JSON.stringify({
  目标: '进入宗门',
  剧情脉络: '踩点、失手、翻墙；收在藏书阁门口。',
  冲突与转折: '三拍推进',
  伏笔与回收: '第三块令牌',
});
const SCENES_JSON = JSON.stringify({
  scenes: [
    { title: '踩点', place: '山门外', time: '戌时', characters: ['林昭'], goal: '摸清换岗' },
    { title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], goal: '进入宗门' },
  ],
});

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
  warns.length = 0;
  // 答案队列也清空：流程发现「没有可做的」时会在弹确认框之前就返回，
  // 留在队列里的那个答案会被下一个用例的确认框读到，串成一串假失败。
  h.answers.length = 0;
}

/** 建一段只有「目标」的骨架——正是大纲 split 产出的形状。 */
async function skeleton(no, title) {
  return project.writePlot({
    no,
    title,
    arc: '',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 目标: `第 ${no} 章要达成的事` },
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    plotFile: './src/core/model/plotFile.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });

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
  for (const [no, title] of [[1, '楔子'], [2, '入镇'], [3, '夜访']]) {
    await skeleton(no, title);
  }
  await project.syncManifest();
});

after(() => {
  // 库开着的话 Windows 上删不掉临时目录。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批量写剧情 · 前置检查', () => {
  let callCount;
  let toasts;

  before(async () => {
    configure();
    // 大纲还是初始化模板（有内容但没写实质剧情）——这里要验的是**空大纲**，
    // 所以清空它。没有大纲就写剧情，等于让模型凭空编三段。
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

  test('大纲为空时一章的剧情都没写', async () => {
    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('批量写剧情', () => {
  let callCount;
  let sys;
  let user;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    fs.writeFileSync(t.rel('.novelforge/outline.md'), '# 大纲\n\n## 第一幕\n\n- 林昭进入青云宗\n');
    configure();

    // 先给第 2 段一份手写剧情——它必须原样保留。
    await project.writePlot({
      no: 2,
      title: '入镇',
      arc: '',
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        目标: '进镇',
        剧情脉络: '这是作者手写的',
      },
    });

    replyFn = () => PLOT_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);

    callCount = fake.calls.length;
    // 装配走的是同一个装配器 → 剧情阶段的配方里有大纲、没有正文全文。
    sys = fake.calls[0].find((m) => m.role === 'system').content;
    user = fake.calls[0].find((m) => m.role === 'user').content;

    // 再跑一次：全都有了，一次都不该调。
    configure();
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  // 三段里第 2 段已排过剧情 → 只该调两次。
  test('只为没排过剧情的段调模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  test('第 1 段写出剧情', async () => {
    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('第 3 段写出剧情', async () => {
    const plot = await project.readPlot('.novelforge/plots/003-夜访.md');
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('剧情内容来自模型', () => {
    assert.ok(t.read('.novelforge/plots/001-楔子.md').includes('三拍推进'));
  });

  // 只补不改：手写的那一份一个字都不能动。
  test('手写的剧情原样保留', () => {
    assert.ok(
      t.read('.novelforge/plots/002-入镇.md').includes('这是作者手写的'),
      t.read('.novelforge/plots/002-入镇.md').slice(0, 300)
    );
  });

  test('新剧情记下大纲指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(t.read('.novelforge/plots/001-楔子.md')));
  });

  test('系统提示是剧情编剧的身份', () => {
    assert.ok(sys.includes('剧情编剧'), sys.slice(0, 60));
  });

  test('装配带上了全书大纲', () => {
    assert.ok(user.includes('林昭进入青云宗'));
  });

  test('剧情阶段不带正文全文', () => {
    assert.ok(!user.includes('# 前文正文'), user.slice(0, 200));
  });

  // 这一段是整次重构的落点：细纲不再规定这一段从哪句话开头、到哪句话结尾。
  test('剧情契约明说不写画面台词', () => {
    assert.ok(user.includes('画面'), user.slice(-600));
  });

  test('剧情契约不要求开头结尾', () => {
    assert.ok(!/"开头"|"结尾"/.test(user), user.slice(-600));
  });

  test('没有缺口时不调模型', () => {
    assert.equal(callCountAgain, 0, `调了 ${callCountAgain} 次`);
  });

  test('没有缺口时给出说明', () => {
    assert.ok(toastsAgain.some((x) => x.includes('排过剧情')), toastsAgain.join('|'));
  });
});

describe('批量写剧情 · 部分失败', () => {
  let stillSkeleton;
  let warnsSnapshot;
  let toastsSnapshot;
  let failures;

  before(async () => {
    // 把第 1 段打回骨架重来，验证「解析不出就不写盘」。
    await skeleton(1, '楔子');
    configure();
    // 模型返回一段废话——严格解析认不出，绝不能写盘：
    // 界面上会显示「已规划」，而里面什么都没有。
    replyFn = () => '我不太确定这一段要写什么。';
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);

    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    stillSkeleton = !bundle.plotFile.isPlotFilled(plot.sections);
    warnsSnapshot = [...warns];
    toastsSnapshot = [...h.toasts];

    // 失败挂在那一段上，第二天回来还看得见。
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
});

describe('批量拆分场景', () => {
  let callCount;
  let first;
  let user;

  before(async () => {
    // 补回第 1 章的剧情，三章齐活。
    configure();
    replyFn = () => PLOT_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlots(project);

    configure();
    // 先给第 3 段手工拆一场——它必须原样保留。
    await project.writeScene('.novelforge/plots/003-夜访.md', {
      plotRelPath: '.novelforge/plots/003-夜访.md',
      no: 1,
      title: '作者手拆的',
      place: '',
      time: '',
      characters: [],
      upstreamHash: '',
      status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '手写的骨架' },
    });

    replyFn = () => SCENES_JSON;
    h.answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);

    callCount = fake.calls.length;
    first = t.read('.novelforge/scenes/001-楔子/01-踩点.md');
    // 拆场景用的是 plot·split 的契约。
    user = fake.calls[0].find((m) => m.role === 'user').content;
  });

  test('只为没拆过的段调模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  test('第 1 段拆出两场', () => {
    assert.ok(
      t.has('.novelforge/scenes/001-楔子/01-踩点.md') &&
        t.has('.novelforge/scenes/001-楔子/02-翻越侧峰.md')
    );
  });

  test('第 2 段也拆了', () => {
    assert.ok(t.has('.novelforge/scenes/002-入镇/01-踩点.md'));
  });

  // 只补不改：作者花时间攒的场景素材被一次批量拆分抹掉，
  // 是这条路上最贵的错误。
  test('手工拆的场景原样保留', () => {
    assert.ok(t.read('.novelforge/scenes/003-夜访/01-作者手拆的.md').includes('手写的骨架'));
  });

  test('没有往第 3 段里塞新场景', () => {
    assert.ok(!t.has('.novelforge/scenes/003-夜访/02-翻越侧峰.md'));
  });

  test('新拆的场景是 draft', () => {
    assert.ok(first.includes('status: draft'));
  });

  test('场景带上地点时间', () => {
    assert.ok(first.includes('place: 山门外') && first.includes('time: 戌时'));
  });

  test('场景记下剧情指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(first));
  });

  test('拆场景要求输出 scenes JSON', () => {
    assert.ok(user.includes('"scenes"'), user.slice(-300));
  });
});

describe('批量拆分场景 · 没排剧情就不拆', () => {
  let callCount;
  let toasts;

  before(async () => {
    // 新加一段骨架，只有目标没有剧情脉络。
    await skeleton(4, '追兵');
    await project.syncManifest();
    configure();
    h.answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  // 三段都拆过了，第 4 段没排剧情 → 没有可拆的，一次都不调。
  test('没排剧情的段不拆', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('说明还有几段没排剧情', () => {
    assert.ok(toasts.some((x) => x.includes('没排剧情')), toasts.join('|'));
  });

  test('没有凭空造出场景目录', () => {
    assert.ok(!t.has('.novelforge/scenes/004-追兵'));
  });
});

/**
 * 批量写正文：三个批量动作里最贵的一个。
 *
 * 它比另外两个多两件事——**一段内部逐场串行**（第 2 场要接着第 1 场的结尾写），
 * 以及确认框里报出预计总字数（比「40 次调用」更能让人意识到这一下花多少钱）。
 */
describe('批量写正文', () => {
  let callCount;
  let detail;
  let text;
  let manuscript;
  let scenes;
  let chapterCount;

  before(async () => {
    configure();
    // 场景得先备好素材才写得出正文。给第 1 段的两场都填上。
    for (const no of [1, 2]) {
      const scene = await project.readScene('.novelforge/plots/001-楔子.md', no);
      await project.writeScene('.novelforge/plots/001-楔子.md', {
        ...scene,
        plotRelPath: '.novelforge/plots/001-楔子.md',
        status: 'ready',
        sections: { ...scene.sections, 动作: `第 ${no} 场的动作`, 环境: '雨' },
      });
    }
    // 第 2 段的场景保持 draft 且没素材 → 这次该被跳过。

    let i = 0;
    replyFn = () => `这是第 ${++i} 次生成的正文。`;
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);

    callCount = fake.calls.length;
    detail = h.confirms?.length ? h.confirms[h.confirms.length - 1] : undefined;
    text = t.read('.novelforge/manuscripts/001-楔子.md');
    manuscript = await project.readManuscript('.novelforge/plots/001-楔子.md');
    scenes = await project.listScenes('.novelforge/plots/001-楔子.md');
    chapterCount = (await project.listChapters()).length;
  });

  // 一场一次调用（不是一段一次）：正文按场景分批生成。
  // 第 1 段两场 + 第 3 段那一场手拆的（status: ready）= 3 次；
  // 第 2 段的场景是 draft 且没素材，这次跳过。
  test('每一场各调一次模型', () => {
    assert.equal(callCount, 3, `调了 ${callCount} 次`);
  });

  test('正文落在 manuscripts/', () => {
    assert.ok(t.has('.novelforge/manuscripts/001-楔子.md'));
  });

  // 一段内部逐场串行，两场的正文顺序拼起来才是完整的一段。
  test('两场的正文都在，且按顺序拼接', () => {
    const a = text.indexOf('第 1 次生成的正文');
    const b = text.indexOf('第 2 次生成的正文');
    assert.ok(a > 0 && b > a, text);
  });

  test('写完的场景标 written', () => {
    assert.ok(scenes.every((s) => s.status === 'written'), scenes.map((s) => s.status).join(','));
  });

  test('正文记下 beatsHash', () => {
    assert.ok(!!manuscript.beatsHash, JSON.stringify(manuscript.beatsHash));
  });

  test('刚写完的正文不标脏', async () => {
    const beats = await project.beatsHashFor('.novelforge/plots/001-楔子.md');
    assert.equal(manuscript.beatsHash, beats);
  });

  // 切成发布章节是作者的活，批量写正文一个字都不往 chapters/ 里写。
  test('不往 chapters/ 里写任何东西', () => {
    assert.equal(chapterCount, 0, String(chapterCount));
  });

  test('场景没备好素材的段被跳过', () => {
    assert.ok(!t.has('.novelforge/manuscripts/002-入镇.md'));
  });
});

describe('批量写正文 · 只补空白', () => {
  let callCount;
  let toasts;
  let textBefore;
  let textAfter;

  before(async () => {
    configure();
    textBefore = t.read('.novelforge/manuscripts/001-楔子.md');
    h.answers.push('开始写作');
    await bundle.batch.writeManuscripts(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
    textAfter = t.read('.novelforge/manuscripts/001-楔子.md');
  });

  test('已有正文的段不再调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('已有的正文一个字没动', () => {
    assert.equal(textAfter, textBefore);
  });

  test('说清为什么没得写', () => {
    assert.ok(toasts.some((x) => x.includes('没备好') || x.includes('写过正文')), toasts.join('|'));
  });
});

describe('用户取消', () => {
  let callCount;
  let stillSkeleton;

  before(async () => {
    configure();
    await skeleton(1, '楔子');
    // answers 空着 = 用户点了 ×。
    await bundle.batch.generatePlots(project);
    callCount = fake.calls.length;
    const plot = await project.readPlot('.novelforge/plots/001-楔子.md');
    stillSkeleton = !bundle.plotFile.isPlotFilled(plot.sections);
  });

  test('取消后不调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('取消后不写盘', () => {
    assert.ok(stillSkeleton);
  });
});
