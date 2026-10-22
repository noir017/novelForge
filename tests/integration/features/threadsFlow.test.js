/**
 * ★ 叙事线重做一期验收（设计稿「实施：逐期提交清单」一期第 11 个提交；七期那一份验收并进来了）。从排好前 5 章细纲的工程起，
 * 工程页「从大纲排出」叙事线，作者改一条线的「当前进度」，再「批量写章」第 1–3 章、写完即定稿：
 *
 *   排线 → 写第 1 章 → 定稿（细纲 + 认事件 + 当前进度）→ 写第 2 章 → 定稿（+ 归并）→ 写第 3 章 → 定稿
 *
 * 经 controller 发出去（与工程页那一颗按钮、弹窗提交的消息一样），假模型按脚本应答。写正文那一次靠执行卡里的
 * 「必需事件」认出是哪一章。没有角色卡：角色状态那一步不调，次数好数。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 叙事线目录里有排出的线（一条一个文件，伏笔写在线下） | 排线从情节大纲排 |
 * | 线文件里有带证据的实际事件（推进、埋、收）；伪造证据的那条没记 | 定稿第三步 a，证据逐字校验是那道闸 |
 * | 机器维护的「当前进度」写到最后动过的那一章、盖了章 | 定稿第三步 b，作者一眼看出走到哪 |
 * | 正文里新长出来的线建了新文件（来源：正文）、挂不上线的伏笔进「未归属的伏笔」 | 线从计划与正文两头来（作者定的第 2 条） |
 * | 作者手改过的「当前进度」没被覆盖、那条线上挂了黄 ❗；作者改的那一行原样还在 | 第 19 条的例外：作者改过就不写；第 3 条 |
 * | **第 3 章写正文那一次的装配里**有线：现在走到哪、作者写的进度照用、该收的伏笔；没开始的那条不在 | 后一章读得到前面的线 |
 * | 工程页「叙事线」页签：一条线一行，主线在前，新认出的线也在，最后是「未归属的伏笔」 | 设计稿「七、工程页」 |
 * | 实际调用次数 ≤ 两个确认框报的上限之和 | 第 4 条 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;

const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const THREADS = '.novelforge/threads';
const MAIN = `${THREADS}/青崖旧案.md`;
const LEDGER = `${THREADS}/名册之谜.md`;
const GROWN = `${THREADS}/沈氏的来意.md`;
const UNFILED = `${THREADS}/未归属的伏笔.md`;
const AUTHOR_PROGRESS = '作者写的：名册在沈氏手里，林昭还不知道。';
const AUTHOR_INTENT = '作者改过的：名册上少了的那一页在沈氏手里。';

function chapterText(no) {
  return [
    filler(260, no * 10 + 1),
    `林昭在第${no}章摸了摸怀里的玉佩。`,
    `沈氏在第${no}章翻开名册，手指停在第${no}行。`,
    `沈氏在第${no}章敲了七下桌面。`,
    filler(260, no * 10 + 2),
  ].join('\n\n');
}

let ch3Prompt = '';
/** 每一章认事件那一次答什么。第 1 章有一条伪造的证据；第 2 章从正文里长出一条线、一条挂不上线的伏笔。 */
const FINDS = {
  1: {
    events: [
      { line: '青崖旧案', type: '推进', evidence: '林昭在第1章摸了摸怀里的玉佩。', what: '林昭带着玉佩回镇' },
      { line: '青崖旧案', type: '埋', foreshadowing: '玉佩的来历', evidence: '林昭在第1章摸了摸怀里的玉佩', what: '玉佩第一次露面' },
      { line: '名册之谜', type: '推进', evidence: '名册上被人撕掉了一页', what: '正文里没有这一句' },
    ],
  },
  2: {
    events: [{ line: '名册之谜', type: '推进', evidence: '沈氏在第2章翻开名册', what: '名册第一次出现' }],
    newThreads: [{ title: '沈氏的来意', kind: '人物线', intent: '沈氏为何盯上林昭。', evidence: '沈氏在第2章翻开名册，手指停在第2行。' }],
    newForeshadowing: [{ title: '敲桌七下', what: '沈氏敲桌是暗号', evidence: '沈氏在第2章敲了七下桌面。' }],
  },
  3: {
    events: [
      { line: '青崖旧案', type: '推进', evidence: '林昭在第3章摸了摸怀里的玉佩', what: '林昭查到火起的那一夜' },
      { line: '青崖旧案', type: '收', foreshadowing: '玉佩的来历', evidence: '林昭在第3章摸了摸怀里的玉佩。', what: '玉佩是沈家旧物' },
      { line: '沈氏的来意', type: '推进', evidence: '沈氏在第3章翻开名册', what: '沈氏又翻名册' },
    ],
  },
};

/** 当前进度那一次送来了哪几条线（作者改过的那条不该在里面）。 */
const progressAsked = [];

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('你是长篇小说的连续性编辑')) {
    return JSON.stringify({ conflicts: [] });
  }
  if (system.includes('只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线')) {
    return JSON.stringify({
      threads: [
        {
          title: '青崖旧案',
          kind: '主线',
          from: 1,
          to: 30,
          intent: '查清七年前那场火。',
          foreshadowing: [{ title: '玉佩的来历', what: '玉佩是沈家旧物', plant: 1, resolve: 3 }],
        },
        { title: '名册之谜', kind: '支线', from: 2, to: 5, intent: '名册上少了一页。' },
        { title: '师父的身份', kind: '支线', from: 10, to: 20, intent: '师父另有身份。' },
      ],
    });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖镇。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [`沈氏在第${no}章翻开了名册`],
    });
  }
  if (system.includes('你是小说定稿事实审查员')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [], ...FINDS[no] });
  }
  if (system.includes('判断它们是不是已有的某一条换了个说法')) {
    return JSON.stringify({ merges: [] });
  }
  if (system.includes('给每一条写一两句「当前进度」')) {
    // 线名照真模型的样子带着种类回（试跑：gemini-3-flash-lite 10 次里 9 次回「名字（种类）」）：钉住「认不出就整条丢」的回归。
    const lines = [...user.matchAll(/^【线】(.+)\n种类：(.+)$/gm)].map((m) => ({ line: m[1], kind: m[2] }));
    progressAsked.push(...lines.map(({ line }) => `${no}:${line}`));
    return JSON.stringify({ progress: lines.map(({ line, kind }) => ({ line: `${line}（${kind}）`, text: `第 ${no} 章：${line}走到了这里。` })) });
  }
  const card = /- 必需事件：第 (\d+) 章/.exec(user);
  if (card) {
    const n = Number(card[1]);
    if (n === 3) {
      ch3Prompt = user;
    }
    return { text: chapterText(n), stop: 'end' };
  }
  return '（认不出这一步）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    threadFile: './src/core/model/threadFile.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
    config: './src/core/config.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  // 近章全文 0 章、其余照缺省那一级：没有哪一级是这个组合，只能单项覆盖（作者那边只有级别可选）。
  bundle.config.setContextLimitsOverride({ fullTextChapters: 0 });
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'threads-phase1', title: '青崖记' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n林昭回镇，必须找出放火的人。\n\n## 悬念骨架\n\n玉佩与名册。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n名册决定谁算镇上的人。\n');
  writeOutline(t, outlineOf(20, { text: { 1: '林昭进镇，一路查名册。' } }));
  const ws = new bundle.ws.Workspace(project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: {
        梗概: `第 ${no} 章林昭接着查名册。`,
        出场人物: '林昭、沈氏',
        时间地点: '',
        关键事件: `第 ${no} 章林昭又往前查了一步。`,
        看点: `- 第 ${no} 章结尾：又一个人不见了。`,
        状态变更: '',
        连续性事实: '',
      },
    });
  }
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  // 工程页「从大纲排出」：后端弹确认框，作者点「开始排」。
  h.expect('开始排');
  await controller.handle({ type: 'projectAction', action: 'generateThreads' });
  // 作者看了一眼：改了一条线的意图，又自己写了它的「当前进度」。
  t.write(
    LEDGER,
    t
      .read(LEDGER)
      .replace('名册上少了一页。', AUTHOR_INTENT)
      .replace(/## 当前进度\n\n[^\n]*\n/, `## 当前进度\n\n${AUTHOR_PROGRESS}\n`)
  );
  project.invalidate();
  // 与工程页弹窗提交的那一条一样：弹窗已经报过调用次数，带 call（作者在弹窗上没改模型与详细度）。
  await controller.handle({
    type: 'projectAction',
    action: 'writeManuscripts',
    range: { from: 1, to: 3 },
    mode: 'finalize',
    call: {},
  });
});

after(() => {
  controller?.dispose();
  bundle?.config.setContextLimitsOverride(undefined);
  if (t) cleanup(t.dir, bundle?.db);
});

describe('叙事线重做一期验收：排线，再批量写章第 1–3 章、写完即定稿', () => {
  const parse = (rel) => bundle.threadFile.parseThreadFile(t.read(rel), rel);
  const actual = (rel) => parse(rel).events.filter((e) => !e.planned).map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence ?? '']);

  test('叙事线目录里有排出的三条线（一条一个文件，伏笔写在线下），三章都写了', () => {
    for (const rel of [MAIN, LEDGER, `${THREADS}/师父的身份.md`]) {
      assert.ok(t.has(rel), rel);
    }
    assert.equal(parse(MAIN).kind, '主线');
    assert.deepEqual(parse(MAIN).foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['玉佩的来历', 1, 3]]);
    assert.ok(t.has(CH(3)) && !t.has(CH(4)));
  });

  test('线文件里有带证据的实际事件：推进、埋、收；伪造证据的那条没记', () => {
    assert.deepEqual(actual(MAIN), [
      [1, '推进', '', '林昭在第1章摸了摸怀里的玉佩。'],
      [1, '埋', '玉佩的来历', '林昭在第1章摸了摸怀里的玉佩'],
      [3, '推进', '', '林昭在第3章摸了摸怀里的玉佩'],
      [3, '收', '玉佩的来历', '林昭在第3章摸了摸怀里的玉佩。'],
    ]);
    assert.deepEqual(actual(LEDGER), [[2, '推进', '', '沈氏在第2章翻开名册']]);
    assert.ok(!t.read(LEDGER).includes('名册上被人撕掉了一页'));
    assert.deepEqual(actual(`${THREADS}/师父的身份.md`), []);
  });

  test('机器维护的当前进度写到最后动过的那一章、盖了章', () => {
    const main = parse(MAIN);
    assert.equal(main.progress, '第 3 章：青崖旧案走到了这里。');
    assert.equal(main.progressThrough, 3);
    assert.ok(bundle.threadFile.progressOwnedByMachine(main));
  });

  test('正文里新长出来的线建了新文件（来源：正文），挂不上线的伏笔进「未归属的伏笔」', () => {
    const grown = parse(GROWN);
    assert.equal(grown.kind, '人物线');
    assert.equal(grown.origin, '正文');
    assert.deepEqual(actual(GROWN).map(([no, type]) => [no, type]), [[2, '推进'], [3, '推进']]);
    assert.equal(grown.progressThrough, 3);
    const unfiled = bundle.threadFile.parseUnfiledFile(t.read(UNFILED), UNFILED);
    assert.deepEqual(unfiled.foreshadowing.map((f) => f.name), ['敲桌七下']);
    assert.deepEqual(unfiled.events.map((e) => [e.chapter, e.type, e.foreshadowing]), [[2, '埋', '敲桌七下']]);
  });

  test('作者手改过的当前进度没被覆盖、没送去写，那条线上挂了黄 ❗；作者改的意图原样还在', async () => {
    const ledger = parse(LEDGER);
    assert.equal(ledger.progress, AUTHOR_PROGRESS);
    assert.ok(t.read(LEDGER).includes(AUTHOR_INTENT));
    assert.ok(!progressAsked.some((x) => x.endsWith(':名册之谜')), progressAsked.join('、'));
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    const marks = tree.failures[LEDGER] ?? [];
    assert.ok(marks.some((f) => f.severity === 'warn' && f.op === 'threadProgress' && f.message.includes('第 2 章')), JSON.stringify(marks));
    assert.equal(tree.failures[MAIN], undefined);
  });

  test('第 3 章写正文时：装配里有线——现在走到哪、作者写的进度照用、该收的伏笔；没开始的那条不在', () => {
    const at = ch3Prompt.indexOf('# 进行中的叙事线');
    assert.ok(at > 0, ch3Prompt.slice(0, 2000));
    const section = ch3Prompt.slice(at, ch3Prompt.indexOf('\n---\n', at));
    assert.match(section, /- 青崖旧案（主线 · 进行中[^）]*）现在：第 1 章：青崖旧案走到了这里/);
    assert.match(section, /玉佩的来历/);
    assert.ok(section.includes(`- 名册之谜（支线 · 进行中`) && section.includes(AUTHOR_PROGRESS.replace(/。$/, '')), section);
    assert.ok(section.includes('沈氏的来意'), section);
    assert.ok(!section.includes('师父的身份'), section);
  });

  test('工程页「叙事线」页签：一条线一行，主线在前、新认出的线也在，最后是「未归属的伏笔」', async () => {
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.equal(tree.threads.current, 3);
    // 写完即定稿每判完一章就推水位（四期）：叙事线判到第 3 章，不落后。
    assert.equal(tree.threads.through, 3);
    assert.equal(tree.threads.lag, undefined);
    assert.equal((await project.readManifest()).threadsThrough, 3);
    assert.deepEqual(
      tree.threads.lines.map((l) => [l.name, l.detail]),
      [
        ['青崖旧案', '主线 · 进行中 · 最近第 3 章'],
        ['名册之谜', '支线 · 进行中 · 最近第 2 章'],
        ['师父的身份', '支线 · 计划中 · 计划第 10–20 章'],
        ['沈氏的来意', '人物线 · 进行中 · 最近第 3 章'],
      ]
    );
    assert.equal(tree.threads.lines[0].relPath, MAIN);
    assert.deepEqual(tree.threads.unfiled, { relPath: UNFILED, total: 1, detail: '1 条', warnings: [] });
  });

  test('实际调用次数没超过两个确认框报的上限（排线 1 次 + 批量写章的最多几次）', () => {
    const plan = bundle.pipelineModel.planWriteBatch({ from: 1, to: 3, mode: 'finalize', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5] });
    assert.ok(fake.callCount() <= 1 + plan.calls.max, `${fake.callCount()} > 1 + ${plan.calls.max}`);
    // 排线 1；一章写一次、定稿更新细纲一次、认叙事线一次、当前进度一次（每章都有线动过）；第 2 章认出新东西多一次归并；
    // 第 2、3 章写前各比对一次。
    assert.equal(fake.callCount(), 1 + 3 * 4 + 1 + 2);
  });
});
