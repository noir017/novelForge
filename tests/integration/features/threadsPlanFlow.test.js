/**
 * ★ 叙事线重做二期验收（设计稿「实施：逐期提交清单」二期第 5 个提交）。从排好情节大纲、还没有细纲也没有叙事线的工程起，
 * 全程经 controller 发出（与工程页那一颗按钮、对话页那一轮一样），假模型按脚本应答：
 *
 *   批量拆细纲第 1–5 章（一条线都没有 → 先排线）→ 计划写进各条线 → 对话页重拆第 3 章（写入卡片列出、整组换掉）→ 写前提醒
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 拆细纲的装配里有叙事线：这一批要收的伏笔标着「本批要收」，合同里有【叙事线】那一条 | 设计稿「二」：细纲照着线排，回收不再靠运气 |
 * | 模型把该收的安排在某一章收：计划事件写进了对的线（推进、埋、收），新伏笔登记在「未归属的伏笔」，认不出的线丢掉 | 计划记在叙事线里 |
 * | 细纲里没有任何关于线的小节（七节加「设定」一节） | 同一样东西只有一份 |
 * | 重拆第 3 章：卡片上先列出来，换掉的是第 3 章的计划，别的章一行不动 | 「随细纲走」；第 19 条的例外先列出来；第 3 条 |
 * | 写前提醒：第 3 章的计划不再收玉佩，写第 4 章时伏笔逾期出提醒（不拦）；名册第 4 章前要收、第 4 章计划里收了，不提 | 设计稿「四、写前检查」 |
 * | 一共 3 次调用（排线 1、拆细纲 1、重拆 1），没超过确认框报的上限 | 第 4 条：计划写进线里 +0 次 |
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
let project;
let controller;
let gates = [];

const THREADS = '.novelforge/threads';
const MAIN = `${THREADS}/青崖旧案.md`;
const LEDGER = `${THREADS}/名册之谜.md`;
const MASTER = `${THREADS}/师父的身份.md`;
const UNFILED = `${THREADS}/未归属的伏笔.md`;
const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const PLOT = (no) => `.novelforge/summaries/00${no}-${TITLES[no - 1]}.md`;

/** 拆细纲那一批、重拆第 3 章那一次各自的提示（用户消息）。 */
let batchPrompt = '';
let singlePrompt = '';

/** 第 1–5 章各自在叙事线上的计划：第 3 章收玉佩（这一批要收的那一条），第 4 章收名册那一页，第 5 章埋一条挂不上线的新伏笔。 */
const PLANS = {
  1: [
    { line: '青崖旧案', type: '推进', what: '林昭带着玉佩回镇' },
    { line: '青崖旧案', type: '埋', foreshadowing: '玉佩的来历', what: '玉佩第一次露面' },
  ],
  2: [
    { line: '名册之谜', type: '推进', what: '名册第一次出现' },
    { line: '', type: '埋', foreshadowing: '名册少的一页', what: '名册被人撕掉了一页' },
  ],
  3: [
    { line: '青崖旧案', type: '推进', what: '林昭查到火起那一夜' },
    { line: '', type: '收', foreshadowing: '玉佩的来历', what: '沈氏认出玉佩上的云纹' },
  ],
  4: [
    { line: '名册之谜', type: '关系', what: '林昭与沈氏结盟' },
    { line: '名册之谜', type: '收', foreshadowing: '名册少的一页', what: '那一页在沈氏手里' },
  ],
  5: [
    { line: '青崖旧案', type: '推进', what: '火起那一夜的人' },
    { line: '', type: '埋', foreshadowing: '断剑', what: '井底有一把断剑', resolve: 12 },
    { line: '瞎编的线', type: '推进', what: '认不出的线' },
  ],
};

function blueprint(no, threads) {
  return {
    chapterNumber: no,
    title: TITLES[no - 1],
    synopsis: `第 ${no} 章林昭接着查名册。`,
    characters: ['林昭', '沈氏'],
    timePlace: '青崖镇',
    keyEvents: [`第 ${no} 章林昭又往前查了一步。`],
    highlights: [`第 ${no} 章结尾：又一个人不见了。`],
    stateChange: '',
    threads,
  };
}

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
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
        { title: '名册之谜', kind: '支线', from: 2, to: 8, intent: '名册上少了一页。', foreshadowing: [{ title: '名册少的一页', what: '那一页在沈氏手里', plant: 2, resolve: 4 }] },
        { title: '师父的身份', kind: '支线', from: 10, to: 20, intent: '师父另有身份。' },
      ],
    });
  }
  if (user.includes('chapterNumber 必须覆盖第 1–5 章')) {
    batchPrompt = user;
    return JSON.stringify({ blueprints: [1, 2, 3, 4, 5].map((no) => blueprint(no, PLANS[no])) });
  }
  if (user.includes('chapterNumber 必须覆盖第 3 章的每一章')) {
    singlePrompt = user;
    // 重拆第 3 章：这一次没安排收玉佩，只推进主线。
    return JSON.stringify({ blueprints: [blueprint(3, [{ line: '青崖旧案', type: '推进', what: '重拆之后：林昭先去了井边' }])] });
  }
  return '（认不出这一步）';
}

const parse = (rel) => bundle.threadFile.parseThreadFile(t.read(rel), rel);
/** 一份文件里的计划事件：`[章, 类型, 伏笔, 一句话]`。 */
const plans = (rel, text = t.read(rel)) =>
  (rel === UNFILED ? bundle.threadFile.parseUnfiledFile(text, rel) : bundle.threadFile.parseThreadFile(text, rel)).events
    .filter((e) => e.planned)
    .map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.what]);

/** 拆完那一刻各份线文件的原文（重拆之后比对别的章有没有动）。 */
const before3 = {};
let batchConfirm;
let card;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    threadFile: './src/core/model/threadFile.ts',
    plotFile: './src/core/model/plotFile.ts',
    preflight: './src/core/features/preflight.ts',
    workbench: './src/core/views/workbench.ts',
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
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'threads-phase2', title: '青崖记' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n林昭回镇，必须找出放火的人。\n');
  t.write('.novelforge/outline.md', '# 情节大纲\n\n## 第1–20章：第一幕\n\n林昭进镇，一路查名册。\n');
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });

  // 工程页「批量拆细纲」第 1–5 章：一条叙事线都没有，确认框写明先排一次，作者点「开始拆细纲」。
  h.expect('开始拆细纲');
  await controller.handle({ type: 'projectAction', action: 'generatePlots', range: { from: 1, to: 5 } });
  batchConfirm = h.confirms[0];
  for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
    before3[rel] = t.read(rel);
  }

  // 对话页重拆第 3 章：生成一轮，写入卡片当场问，作者点「确认」。
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '第 3 章重排一下',
      stage: 'plot',
      capability: 'generate',
      target: { kind: 'plot', plotRelPath: PLOT(3) },
      targetNo: 3,
      attachments: [],
      excludedIds: [],
    },
  });
  card = gates.find((g) => g.name === 'artifact');
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('叙事线重做二期验收：拆细纲带线，计划写进线里，重拆换掉那一章的计划，写前提醒', () => {
  test('一条线都没有：先排了线（一条一个文件，伏笔写在线下），再拆第 1–5 章细纲', () => {
    assert.match(batchConfirm.detail, /还没有一条叙事线：开拆之前先从情节大纲排一次/);
    assert.deepEqual(parse(MAIN).foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['玉佩的来历', 1, 3]]);
    for (let no = 1; no <= 5; no++) {
      assert.ok(t.has(PLOT(no)), PLOT(no));
    }
  });

  test('拆细纲的装配里有叙事线：这一批要收的伏笔标着「本批要收」，合同里有【叙事线】那一条', () => {
    assert.ok(batchPrompt.includes('# 叙事线（照着排'), batchPrompt.slice(0, 2000));
    assert.ok(batchPrompt.includes('- 玉佩的来历（挂在「青崖旧案」· 计划 · 本批要收，最晚第 3 章，还没埋，先埋再收）是什么：玉佩是沈家旧物'), batchPrompt);
    assert.ok(batchPrompt.includes('- 名册少的一页（挂在「名册之谜」· 计划 · 本批要收，最晚第 4 章，还没埋，先埋再收）'), batchPrompt);
    assert.ok(batchPrompt.includes('- 师父的身份（支线 · 计划中 · 计划第 10–20 章）意图：师父另有身份；本批还不到它开始的那一章，不要提前开'), batchPrompt);
    assert.ok(batchPrompt.includes('标着「本批要收」或「已过第 N 章，还没收」的伏笔，必须安排在本批某一章「收」'), batchPrompt);
    assert.ok(!batchPrompt.includes('伏笔强制回收'));
  });

  test('计划事件写进了对的线：推进、埋、收按章排好；该收的伏笔安排在第 3、4 章收', () => {
    // 拆完那一刻（重拆第 3 章之前）的样子。
    assert.deepEqual(plans(MAIN, before3[MAIN]), [
      [1, '推进', '', '林昭带着玉佩回镇'],
      [1, '埋', '玉佩的来历', '玉佩第一次露面'],
      [3, '推进', '', '林昭查到火起那一夜'],
      [3, '收', '玉佩的来历', '沈氏认出玉佩上的云纹'],
      [5, '推进', '', '火起那一夜的人'],
    ]);
    // 伏笔的事件跟着伏笔走：第 2 章那一条 line 写空，也落在名册所在的这条线上。
    assert.deepEqual(plans(LEDGER), [
      [2, '推进', '', '名册第一次出现'],
      [2, '埋', '名册少的一页', '名册被人撕掉了一页'],
      [4, '关系', '', '林昭与沈氏结盟'],
      [4, '收', '名册少的一页', '那一页在沈氏手里'],
    ]);
    assert.deepEqual(plans(MASTER), []);
  });

  test('挂不上线的新伏笔进「未归属的伏笔」并登记计划第 5 章埋、第 12 章前收；认不出的线丢掉', () => {
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 断剑：井底有一把断剑（计划第 5 章埋、第 12 章前收）'), loose);
    assert.deepEqual(plans(UNFILED), [[5, '埋', '断剑', '井底有一把断剑']]);
    for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
      assert.ok(!t.read(rel).includes('认不出的线'), rel);
    }
  });

  test('细纲里没有任何关于线的小节：七节加「设定」一节', () => {
    const plot = bundle.plotFile.parsePlotFile(t.read(PLOT(1)), PLOT(1));
    assert.deepEqual(Object.keys(plot.sections), [...bundle.plotFile.PLOT_SECTION_KEYS]);
    assert.ok(!/新增伏笔|玉佩第一次露面/.test(t.read(PLOT(1))), t.read(PLOT(1)));
  });

  test('重拆第 3 章：装配里说「本章要收」，写入卡片上先列出会写什么、换掉原来的几条', () => {
    assert.ok(singlePrompt.includes('- 玉佩的来历（挂在「青崖旧案」· 计划 · 本章要收）'), singlePrompt);
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.ok(card.detail.includes('叙事线计划：青崖旧案 推进（原来的 2 条整组换掉）'), card.detail);
  });

  test('重拆换掉的是第 3 章的计划，别的章一行不动', () => {
    const main = t.read(MAIN);
    assert.ok(main.includes('- 第 3 章 · 计划 · 推进：重拆之后：林昭先去了井边'), main);
    assert.ok(!main.includes('第 3 章 · 计划 · 收〈玉佩的来历〉') && !main.includes('林昭查到火起那一夜'), main);
    const others = (text) => text.split('\n').filter((l) => !l.includes('第 3 章 · 计划'));
    for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
      assert.deepEqual(others(t.read(rel)), others(before3[rel]), rel);
    }
  });

  // 复跑之后加了第三类：名册计划第 2 章埋，第 1–3 章没定稿、叙事线里还没有实际的「埋」，写第 4 章时照提（说明里注了可能不准）。
  test('写前提醒：玉佩第 3 章前要收、计划里不再收它，写第 4 章时提醒（不拦）；名册第 4 章计划里收了，不提逾期，提还没埋', async () => {
    const pre = await bundle.preflight.preflightChapter(project, 4);
    assert.deepEqual(pre.threads, [
      { kind: 'overdue', name: '玉佩的来历', resolve: 3, at: 4 },
      { kind: 'unplanted', name: '名册少的一页', plant: 2, at: 4 },
    ]);
    const wb = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(4) });
    assert.ok(
      wb.notice.includes(
        '叙事线提醒：伏笔〈玉佩的来历〉计划第 3 章前收，还没收，本章计划里也没安排收；伏笔〈名册少的一页〉计划第 2 章埋，还没埋，本章计划里也没安排埋（第 1–3 章还没定稿，叙事线还没记上，提醒可能不准）。只是提醒，照写不拦。'
      ),
      wb.notice
    );
  });

  test('一共 3 次调用（排线 1、拆细纲 1、重拆 1），没超过确认框报的上限；计划写进线里不多调', () => {
    assert.equal(fake.calls.length, 3);
    const max = Number(/最多 (\d+) 次/.exec(batchConfirm.message)?.[1]);
    assert.ok(max >= 2, batchConfirm.message);
  });
});
