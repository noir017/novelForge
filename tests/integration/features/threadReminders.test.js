/**
 * 写前检查的叙事线提醒（叙事线二期，设计稿「四、写前检查」）：伏笔逾期、线断了。零调用、**不拦人**——照「设定还只有一句话」
 * （`thinLoreFor`）那套做，不进 `risks`，显示在四处：对话页（预检卡片的说明、写章卡片的说明）、批量写章的确认框、章节工作台
 * （前端批量弹窗在 tests/dom/view/forms.test.js）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 写第 N 章按第 N − 1 章算：过了计划回收章没收、本章计划里也没收的伏笔提；进行中的线断了 K 章（主线 5、其余 15）、本章计划里也没推进的提 | 设计稿 ⚑9 |
 * | 本章计划里安排了收、推进的不提；收了的伏笔、没开始的线不提 | 提醒的是「没安排」 |
 * | 叙事线只记到定稿的那一章，中间没定稿的章注一句「提醒可能不准」 | 实际事件都是定稿写进来的 |
 * | 不进 risks：细纲排了死人照样亮卡，提醒写在卡片说明里；没有风险不亮卡，提醒进写章卡片的说明 | 不拦人 |
 * | 工作台正文目标上一句（还没写的章才提）；批量写章确认框多一行（区间里安排过的都算） | 四处显示 |
 * | 一次模型都不调 | 第 4 条：写前检查零调用 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let fake;
let project;
let controller;
let gates = [];
let gateAnswer = 'proceed';
let script = [];

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const DIR = '.novelforge/threads';

/** 一份细纲：`sourceHash` 给了就是定稿过的。 */
function plotText(no, { cast = '林昭', sourceHash } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 800',
    ...(sourceHash ? [`sourceHash: ${sourceHash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    `第 ${no} 章的梗概`,
    '',
    '## 出场人物',
    '',
    cast,
    '',
    '## 关键事件',
    '',
    `- 第 ${no} 章的事`,
    '',
  ].join('\n');
}

const MAIN = [
  '---',
  'kind: 主线',
  'plan: 1-40',
  '---',
  '',
  '## 意图',
  '查清那场火。',
  '',
  '## 进展',
  '- 第 1 章 · 推进：起火 〔证据：「火光」〕',
  '',
].join('\n');
const PAIR = [
  '---',
  'kind: 感情线',
  'plan: 2-30',
  '---',
  '',
  '## 伏笔',
  '- 玉佩的来历：沈家旧物（计划第 2 章埋、第 5 章前收）',
  '- 旧伤（第 6 章前收）',
  '',
  '## 进展',
  '- 第 2 章 · 推进：初遇 〔证据：「初遇」〕',
  '- 第 2 章 · 埋〈玉佩的来历〉：玉佩露面 〔证据：「玉佩」〕',
  '- 第 7 章 · 计划 · 推进：挡刀',
  '- 第 7 章 · 计划 · 收〈旧伤〉：旧伤复发',
  '',
].join('\n');
const UNFILED = '# 未归属的伏笔\n\n## 伏笔\n- 提灯人（第 3 章前收）\n\n## 进展\n- 第 2 章 · 埋〈提灯人〉：x 〔证据：「x」〕\n- 第 3 章 · 收〈提灯人〉：y 〔证据：「y」〕\n';

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      if (m.type === 'gate') {
        gates.push(m);
        const verdict = typeof gateAnswer === 'function' ? gateAnswer(m) : gateAnswer;
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
      }
    },
    reveal() {},
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    preflight: './src/core/features/preflight.ts',
    batch: './src/core/features/pipelineBatch.ts',
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
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'threadReminders', title: '写前提醒' });
  project = t.project;
  // 第 1–5 章有正文，第 1–4 章定稿过（第 5 章写了没定稿）；第 6–8 章只排了细纲，第 7 章排了已经死了的沈秋。
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。${filler(200, no)}\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= 8; no++) {
    const hash = no <= 4 ? chapters.find((c) => c.order === no).contentHash : undefined;
    t.write(PLOT(no), plotText(no, { sourceHash: hash, ...(no === 7 ? { cast: '林昭、沈秋' } : {}) }));
  }
  t.write(
    '.novelforge/characters/沈秋.md',
    ['---', 'name: 沈秋', 'stateThrough: 4', '---', '', '# 沈秋', '', '## 当前状态', '', '已死亡（第 4 章被刺杀）', ''].join('\n')
  );
  t.write(`${DIR}/青崖旧案.md`, MAIN);
  t.write(`${DIR}/林昭与沈青.md`, PAIR);
  t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
  // 第 1–4 章定稿时叙事线判过了：水位记在 project.json（四期）。「还没记上」的那几章按它注。
  await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 4 });
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('预检：叙事线的两类提醒（不进 risks）', () => {
  test('第 8 章：玉佩、旧伤过了回收章没收（旧伤第 7 章的计划不算本章），主线断了 6 章；叙事线记到第 4 章', async () => {
    const r = await bundle.preflight.preflightChapter(project, 8);
    assert.deepEqual(r.risks, []);
    assert.deepEqual(r.threads, [
      { kind: 'overdue', name: '玉佩的来历', resolve: 5, at: 8 },
      // 旧伤那一行写第 6 章前收，计划排到了第 7 章：按晚的算（2026-10-24 推迟算数），第 8 章照样过了。
      { kind: 'overdue', name: '旧伤', resolve: 7, at: 8 },
      { kind: 'stalled', name: '青崖旧案', lineKind: '主线', gap: 6, at: 8 },
    ]);
    assert.equal(r.threadsThrough, 4);
  });

  test('第 7 章：本章计划里收了旧伤、推进了感情线，不提；收了的伏笔不提；细纲排了死人照样是风险', async () => {
    const r = await bundle.preflight.preflightChapter(project, 7);
    assert.deepEqual(r.risks.map((x) => x.name), ['沈秋']);
    assert.deepEqual(r.threads.map((x) => x.name), ['玉佩的来历', '青崖旧案']);
  });

  test('说法：注一句中间没定稿的章', async () => {
    const r = await bundle.preflight.preflightChapter(project, 6);
    assert.equal(
      bundle.preflight.describeThreadNotes('本章', r.threads, r.threadsThrough, 6),
      '叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，还没收，本章计划里也没安排收（第 5 章还没同步或还没补记，叙事线还没记上，提醒可能不准）。只是提醒，照写不拦。'
    );
  });
});

describe('章节工作台：还没写的章上一句', () => {
  const wb = (no) => bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(no) });

  test('第 6 章还没写：正文目标上一句叙事线提醒', async () => {
    const card = await wb(6);
    assert.equal(
      card.notice,
      '叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，还没收，本章计划里也没安排收（第 5 章还没同步或还没补记，叙事线还没记上，提醒可能不准）。只是提醒，照写不拦。'
    );
  });

  test('已经写了字的章不提', async () => {
    assert.equal((await wb(5)).notice, undefined);
  });
});

describe('批量写章的确认框多一行（不拦）', () => {
  test('区间第 6–8 章：旧伤第 7 章安排了收，不提；玉佩写到第 6 章就过了，主线写到第 7 章就断了', async () => {
    h.expect('仅本次忽略，照写', undefined);
    const n = await bundle.batch.writeManuscripts(project, { range: { from: 6, to: 8 } });
    assert.equal(n, 0);
    // 先过一致性预检那一问（第 7 章排了死人），再是批量写章那一问。
    const c = h.confirms.find((x) => x.actions.includes('开始写章'));
    assert.ok(c, JSON.stringify(h.confirms.map((x) => x.message)));
    assert.ok(
      c.detail.includes(
        '叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，写到第 6 章还没收，区间里也没安排收；〈青崖旧案〉（主线）写到第 7 章就断了 5 章，区间里也没安排推进（第 5 章还没同步或还没补记，叙事线还没记上，提醒可能不准）。只是提醒，不拦。'
      ),
      c.detail
    );
    assert.deepEqual(c.actions, ['开始写章']);
  });
});

describe('对话页：预检卡片与写章卡片的说明', () => {
  test('有风险：预检卡片的说明里带叙事线提醒；「先不写」一次模型都不调', async () => {
    gates = [];
    script = ['不该被调用'];
    gateAnswer = 'skip';
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(7), action: 'write' });
    gateAnswer = 'proceed';
    assert.equal(gates.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.match(gates[0].detail, /叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，还没收，本章计划里也没安排收；〈青崖旧案〉（主线）已经 5 章没有进展/);
    assert.equal(fake.calls.length, 0);
  });

  test('没有风险：不亮预检卡，提醒进写章卡片的说明（照写）', async () => {
    gates = [];
    script = [{ text: filler(700, 80), stop: 'end' }];
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(8), action: 'write' });
    assert.ok(gates.every((g) => g.name !== 'preflight'), JSON.stringify(gates.map((g) => g.name)));
    const card = gates.find((g) => g.name === 'artifact');
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.match(card.detail, /· 叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，还没收，本章计划里也没安排收；伏笔〈旧伤〉计划第 7 章前收/);
    assert.equal(fake.calls.length, 1, '写正文 1 次，提醒零调用');
  });
});

// 复跑报告问题 9：「阿婆的真实身份」计划第 5 章埋，到第 15 章还是「计划」，两类提醒都不管。第三类：计划埋了却一直没埋，
// 照现有两类的做法——不拦人，预检、工作台、批量写章的确认框、对话页都显示（前端批量弹窗在 tests/dom/view/forms.test.js）。
describe('第三类：计划埋了却一直没埋', () => {
  const UNPLANTED = UNFILED.replace('- 提灯人（第 3 章前收）', '- 提灯人（第 3 章前收）\n- 阿婆的身份：阿婆当年在场（计划第 3 章埋）\n- 井底的回声（计划第 7 章埋）');
  before(() => {
    t.write(`${DIR}/未归属的伏笔.md`, UNPLANTED);
    project.invalidate();
  });
  after(() => {
    t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
    project.invalidate();
  });

  test('预检：计划第 3 章埋、写第 6 章还没埋的提；计划第 7 章才埋的不提', async () => {
    const r = await bundle.preflight.preflightChapter(project, 6);
    assert.deepEqual(r.threads, [
      { kind: 'overdue', name: '玉佩的来历', resolve: 5, at: 6 },
      { kind: 'unplanted', name: '阿婆的身份', plant: 3, at: 6 },
    ]);
  });

  test('工作台与批量写章的确认框同一句（不拦）', async () => {
    const card = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(6) });
    assert.match(card.notice, /伏笔〈阿婆的身份〉计划第 3 章埋，还没埋，本章计划里也没安排埋/);
    h.expect('仅本次忽略，照写', undefined);
    assert.equal(await bundle.batch.writeManuscripts(project, { range: { from: 6, to: 8 } }), 0);
    const c = h.confirms.find((x) => x.actions.includes('开始写章'));
    // 第 8 章前面已经写过了（跳过），区间是第 6–7 章：井底的回声计划第 7 章埋，写第 7 章时还不算过。
    assert.match(c.detail, /伏笔〈阿婆的身份〉计划第 3 章埋，写到第 6 章还没埋，区间里也没安排埋；〈青崖旧案〉/);
    assert.doesNotMatch(c.detail, /井底的回声/);
  });

  test('对话页：没风险时进写章卡片的说明（照写）', async () => {
    gates = [];
    script = [{ text: filler(700, 81), stop: 'end' }];
    const before = fake.calls.length;
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(6), action: 'write' });
    const card = gates.find((g) => g.name === 'artifact');
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.match(card.detail, /伏笔〈阿婆的身份〉计划第 3 章埋，还没埋，本章计划里也没安排埋/);
    assert.equal(fake.calls.length - before, 1, '提醒零调用');
  });
});
