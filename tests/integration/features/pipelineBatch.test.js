/**
 * 工程页流水线批量动作：批量生成细纲、批量拆分场景。
 * 迁自 scripts/smoke-pipeline-batch.js（32 条断言）。
 *
 * 这两条路的失败方式和单次生成完全不同——一次跑几十章，所以要钉住的是：
 * 1. **只补不改**：已经有产物的章节一律跳过，不问、不覆盖。
 * 2. **部分失败不影响其余**：第 12 章拆不出场景，另外 63 章照样跑完。
 * 3. **失败留在那一章上**：toast 五秒就没了。
 * 4. **没有前置产物就不跑**：没有大纲还生成细纲，等于让模型凭空编四十章。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const PLAN_JSON = JSON.stringify({
  本章目标: '进入宗门',
  开头: '雨里的山门',
  结尾: '藏书阁前',
  冲突与节奏: '三拍推进',
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
/** 第 N 次调用该返回什么。原脚本是一个反复重赋值的 `let reply`。 */
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

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    errorLog: './src/core/errorLog.ts',
    db: './src/core/db.ts',
    logger: './src/core/logger.ts',
  });

  // 原脚本的假宿主没有 reviewReplace——批量路径本来就不该逐份弹 diff。
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
  for (const [order, title] of [[1, '楔子'], [2, '入镇'], [3, '夜访']]) {
    await project.createChapter(order, title, '正文若干。');
  }
  await project.syncManifest();
});

after(() => {
  // 库开着的话 Windows 上删不掉临时目录。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批量生成细纲 · 前置检查', () => {
  let callCount;
  let toasts;

  before(async () => {
    configure();
    // 大纲还是初始化模板（有内容但没写实质剧情）——这里要验的是**空大纲**，
    // 所以清空它。没有大纲就生成细纲，等于让模型凭空编三章。
    fs.writeFileSync(t.rel('.novelforge/outline.md'), '');
    h.answers.push('开始生成');
    await bundle.batch.generatePlans(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  test('大纲为空时不调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('大纲为空时说明原因', () => {
    assert.ok(toasts.some((x) => x.includes('大纲')), toasts.join('|'));
  });

  test('大纲为空时一份细纲都没写', () => {
    assert.ok(!t.has('.novelforge/plans/001-楔子.md'));
  });
});

describe('批量生成细纲', () => {
  let callCount;
  let sys;
  let user;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    fs.writeFileSync(t.rel('.novelforge/outline.md'), '# 大纲\n\n## 第一幕\n\n- 林昭进入青云宗\n');
    configure();

    // 先给第 2 章一份手写细纲——它必须原样保留。
    await project.writePlan('chapters/002-入镇.md', {
      chapterRelPath: 'chapters/002-入镇.md',
      order: 2,
      title: '入镇',
      arc: '',
      upstreamHash: '',
      done: false,
      sections: { 本章目标: '这是作者手写的', 开头: '', 结尾: '', 冲突与节奏: '', 伏笔与回收: '' },
    });

    replyFn = () => PLAN_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    callCount = fake.calls.length;
    // 装配走的是同一个装配器 → 细纲阶段的配方里有大纲、没有整章正文。
    sys = fake.calls[0].find((m) => m.role === 'system').content;
    user = fake.calls[0].find((m) => m.role === 'user').content;

    // 再跑一次：全都有了，一次都不该调。
    configure();
    h.answers.push('开始生成');
    await bundle.batch.generatePlans(project);
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  // 三章里第 2 章已有细纲 → 只该调两次。
  test('只为缺细纲的章节调模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  test('第 1 章写出细纲', () => {
    assert.ok(t.has('.novelforge/plans/001-楔子.md'));
  });

  test('第 3 章写出细纲', () => {
    assert.ok(t.has('.novelforge/plans/003-夜访.md'));
  });

  test('细纲内容来自模型', () => {
    assert.ok(t.read('.novelforge/plans/001-楔子.md').includes('三拍推进'));
  });

  // 只补不改：手写的那一份一个字都不能动。
  test('手写的细纲原样保留', () => {
    assert.ok(
      t.read('.novelforge/plans/002-入镇.md').includes('这是作者手写的'),
      t.read('.novelforge/plans/002-入镇.md').slice(0, 200)
    );
  });

  test('新细纲记下大纲指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(t.read('.novelforge/plans/001-楔子.md')));
  });

  test('系统提示是剧情导演的身份', () => {
    assert.ok(sys.includes('剧情导演'), sys.slice(0, 60));
  });

  test('装配带上了全书大纲', () => {
    assert.ok(user.includes('林昭进入青云宗'));
  });

  test('细纲阶段不带整章正文', () => {
    assert.ok(!user.includes('# 最近章节正文'), user.slice(0, 200));
  });

  test('没有缺口时不调模型', () => {
    assert.equal(callCountAgain, 0, `调了 ${callCountAgain} 次`);
  });

  test('没有缺口时给出说明', () => {
    assert.ok(toastsAgain.some((x) => x.includes('已经有细纲')), toastsAgain.join('|'));
  });
});

describe('批量生成细纲 · 部分失败', () => {
  let noPlan;
  let warnsSnapshot;
  let toastsSnapshot;
  let failures;

  before(async () => {
    // 把第 1 章的细纲清空重来，验证「解析不出就不写盘」。
    fs.rmSync(t.rel('.novelforge/plans/001-楔子.md'));
    configure();
    // 模型返回一段废话——解析出的细纲是空的，绝不能写盘：
    // 界面上会显示「已规划」，而里面什么都没有。
    replyFn = () => '我不太确定这一章要写什么。';
    h.answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    noPlan = !t.has('.novelforge/plans/001-楔子.md');
    warnsSnapshot = [...warns];
    toastsSnapshot = [...h.toasts];

    // 失败挂在那一章上，第二天回来还看得见。
    // recordFailure 是 fire-and-forget（失败路径上再抛异常会把「更新失败」
    // 变成「更新崩溃」），所以这里让出一轮事件循环再查。
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('解析不出内容时不写盘', () => {
    assert.ok(noPlan);
  });

  test('失败进日志', () => {
    assert.ok(warnsSnapshot.some((w) => w.includes('第 1 章')), warnsSnapshot.join('|'));
  });

  test('失败也给出汇总 toast', () => {
    assert.ok(toastsSnapshot.some((x) => x.includes('失败')), toastsSnapshot.join('|'));
  });

  test('失败记录挂在章节上', () => {
    assert.ok(!!failures['chapters/001-楔子.md'], JSON.stringify(Object.keys(failures)));
  });
});

describe('批量拆分场景', () => {
  let callCount;
  let first;
  let user;

  before(async () => {
    // 补回第 1 章的细纲，三章齐活。
    configure();
    replyFn = () => PLAN_JSON;
    h.answers.push('开始生成');
    await bundle.batch.generatePlans(project);

    configure();
    // 先给第 3 章手工拆一场——它必须原样保留。
    await project.writeScene('chapters/003-夜访.md', {
      chapterRelPath: 'chapters/003-夜访.md',
      no: 1,
      title: '作者手拆的',
      place: '',
      time: '',
      characters: [],
      upstreamHash: '',
      status: 'ready',
      sections: { 目的: '', 前置: '', 必须发生: '- 手写的骨架', 不能发生: '', 情绪曲线: '', 人物状态: '', 伏笔: '' },
    });

    replyFn = () => SCENES_JSON;
    h.answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);

    callCount = fake.calls.length;
    first = t.read('.novelforge/scenes/001-楔子/01-踩点.md');
    // 拆场景用的是 plan·split 的契约。
    user = fake.calls[0].find((m) => m.role === 'user').content;
  });

  test('只为没拆过的章节调模型', () => {
    assert.equal(callCount, 2, `调了 ${callCount} 次`);
  });

  test('第 1 章拆出两场', () => {
    assert.ok(
      t.has('.novelforge/scenes/001-楔子/01-踩点.md') &&
        t.has('.novelforge/scenes/001-楔子/02-翻越侧峰.md')
    );
  });

  test('第 2 章也拆了', () => {
    assert.ok(t.has('.novelforge/scenes/002-入镇/01-踩点.md'));
  });

  // 只补不改：作者花时间填过的「必须发生」被一次批量拆分抹掉，
  // 是这条路上最贵的错误。
  test('手工拆的场景原样保留', () => {
    assert.ok(t.read('.novelforge/scenes/003-夜访/01-作者手拆的.md').includes('手写的骨架'));
  });

  test('没有往第 3 章里塞新场景', () => {
    assert.ok(!t.has('.novelforge/scenes/003-夜访/02-翻越侧峰.md'));
  });

  test('新拆的场景是 draft', () => {
    assert.ok(first.includes('status: draft'));
  });

  test('场景带上地点时间', () => {
    assert.ok(first.includes('place: 山门外') && first.includes('time: 戌时'));
  });

  test('场景记下细纲指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(first));
  });

  test('拆场景要求输出 scenes JSON', () => {
    assert.ok(user.includes('"scenes"'), user.slice(-300));
  });
});

describe('批量拆分场景 · 没细纲就不拆', () => {
  let callCount;
  let toasts;

  before(async () => {
    // 新加一章，只有正文没有细纲。
    await project.createChapter(4, '追兵', '正文若干。');
    await project.syncManifest();
    configure();
    h.answers.push('开始拆分');
    await bundle.batch.breakdownScenes(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  // 三章都拆过了，第 4 章没细纲 → 没有可拆的，一次都不调。
  test('没细纲的章节不拆', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('说明还有几章没写细纲', () => {
    assert.ok(toasts.some((x) => x.includes('没写细纲')), toasts.join('|'));
  });

  test('没有凭空造出场景目录', () => {
    assert.ok(!t.has('.novelforge/scenes/004-追兵'));
  });
});

describe('用户取消', () => {
  let callCount;

  before(async () => {
    configure();
    fs.rmSync(t.rel('.novelforge/plans/001-楔子.md'));
    // answers 空着 = 用户点了 ×。
    await bundle.batch.generatePlans(project);
    callCount = fake.calls.length;
  });

  test('取消后不调模型', () => {
    assert.equal(callCount, 0, `调了 ${callCount} 次`);
  });

  test('取消后不写盘', () => {
    assert.ok(!t.has('.novelforge/plans/001-楔子.md'));
  });
});
