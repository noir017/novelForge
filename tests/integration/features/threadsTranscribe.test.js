/**
 * 叙事线改成转写（2026-10-25，细纲试点之后推到全部结构化产物）：排线、认事件、归并、当前进度四次都不再要模型直接出 JSON，
 * 按格式写自然语言，由「转写」那一档的模型照抄成原来那份 JSON（features/transcribe.ts 的 `transcribeJson`），解码与校验一行没改。
 * 假模型两个：干活的是 big（剧情细纲档、定稿档都没配，沿用默认模型），转写的是 small（快速档）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 排线 · 照抄收下 | 排 1 次、转写 1 次；转写只带合同与原文、不带书的上下文；落盘的线与伏笔（章号按对应关系填）；确认框报 2 次、转写单列 |
 * | 排线 · 改了字 | 转写改了原文的字不收，重转一次、说清哪几处 |
 * | 排线 · 转写调用失败 | 照原来排线失败的走法：挂红 ❗、文件不动；调用照实记账 |
 * | 补记一章 · 三段都转写 | 认事件、当前进度各写 1 次、转写 1 次；归并写的「无」（换了说法的「无需归并」也算）不转写；证据照抄、对正文核过才记；新线、新伏笔、当前进度落盘 |
 * | 补记一章 · 认事件转写两次不合格 | 照原来认事件没成的走法：停在这一章、失败挂在章节上、水位不动；写 1 次 + 转写 2 次照实记账 |
 * | 补记一章 · 什么都没认出 | 三节都写「无」不转写，1 次；这一章照样算判过，上一次的失败清掉 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
/** 按模型引用注入异常（fakeProvider 的 behavior）：建 provider 时现读。 */
const behavior = {};

const THREADS = '.novelforge/threads';
const file = (name) => `${THREADS}/${name}.md`;
const names = () => (t.has(THREADS) ? require('fs').readdirSync(t.rel(THREADS)).sort() : []);
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

const TRANSCRIBER = '格式转写员';
const PLAN_MARK = '只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线';
const FIND_MARK = '你是小说定稿事实审查员';
const MERGE_MARK = '判断它们是不是已有的某一条换了个说法';
const PROGRESS_MARK = '给每一条写一两句「当前进度」';

/** 干活的那几次各写什么（字符串，或吃 messages 的函数）。 */
let writer = {};
/** 转写那几次依次答什么（同上）。 */
let copies = [];

const answer = (x, messages) => (typeof x === 'function' ? x(messages) : (x ?? '（没有准备这一步）'));

function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    return answer(copies.shift(), messages);
  }
  if (system.includes(PLAN_MARK)) return answer(writer.plan, messages);
  if (system.includes(FIND_MARK)) return answer(writer.find, messages);
  if (system.includes(MERGE_MARK)) return answer(writer.merge, messages);
  if (system.includes(PROGRESS_MARK)) return answer(writer.progress, messages);
  return '（认不出这一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
const lastUser = (messages) => messages[messages.length - 1].content;

/** 当前进度：写的那一次给送来的每条线写一段；转写那一次照原文一段一项搬。 */
const writeProgress = (messages) =>
  [...lastUser(messages).matchAll(/^【线】(.+)$/gm)].map((m) => `【线】${m[1]}\n当前进度：${m[1]}走到了这里。`).join('\n\n');
const copyProgress = (messages) => {
  const source = lastUser(messages).split('【原文】')[1] ?? '';
  return JSON.stringify({ progress: [...source.matchAll(/【线】(.+)\n当前进度：(.+)/g)].map((m) => ({ line: m[1].trim(), text: m[2].trim() })) });
};

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    threads: './src/core/features/threads.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    threadFile: './src/core/model/threadFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  // 剧情细纲档、定稿档都没配：沿用默认模型 big；转写那一档（快速档）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    taskTiers: { plotSummary: 'balanced' },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'threads-transcribe', title: '青云剑录' });
  project = t.project;
  t.write(
    '.novelforge/config.md',
    '---\ngenre: 玄幻\ntotalChapters: 20\nwordsPerChapter: 3000\n---\n# 设定\n\n## 一句话\n\n少年背着旧案入宗。\n'
  );
  writeOutline(t, outlineOf(20, { text: { 1: '林昭背着旧案入宗，与沈青从猜忌到并肩，查出当年放火的人。' } }));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

// ---------------------------------------------------------------- 排线

/** 排线的模型按格式写出来的两条线。 */
const PLAN_PROSE = [
  '## 林昭与沈青',
  '种类：感情线',
  '章节：第 3 章—第 18 章',
  '意图：从互相猜忌到并肩。',
  '伏笔：',
  '- 玉佩的来历：林昭的玉佩是沈家旧物（第 3 章埋，第 18 章前收）',
  '',
  '## 沈家旧案',
  '种类：主线',
  '章节：不定',
  '意图：查清十年前那把火是谁放的。',
  '伏笔：无',
].join('\n');

/** 转写模型照抄出来的那一份。 */
const planCopy = (over = {}) =>
  JSON.stringify({
    threads: [
      {
        title: '林昭与沈青',
        kind: '感情线',
        from: 3,
        to: 18,
        intent: '从互相猜忌到并肩。',
        foreshadowing: [{ title: '玉佩的来历', what: '林昭的玉佩是沈家旧物', plant: 3, resolve: 18 }],
        ...over,
      },
      { title: '沈家旧案', kind: '主线', intent: '查清十年前那把火是谁放的。', foreshadowing: [] },
    ],
  });

describe('排线 · 按格式写，转写模型照抄成 JSON', () => {
  let returned;
  let confirm;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [planCopy()];
    fake.reset();
    h.expect('开始排');
    returned = await bundle.threads.generateThreads(project);
    confirm = h.confirms.at(-1);
  });

  test('排 1 次、转写 1 次：排的是剧情细纲档（默认模型），转写的是转写那一档', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(returned, 2);
    assert.ok(systemOf(0).includes(PLAN_MARK) && !systemOf(0).includes('只输出一个 JSON 对象'), systemOf(0).slice(0, 300));
    assert.ok(userOf(0).endsWith('请按上面的格式写。'), userOf(0).slice(-80));
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
  });

  test('转写只带合同与原文，不带书的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【叙事线 JSON 合同】') && userOf(1).includes('【原文】\n## 林昭与沈青\n种类：感情线'), userOf(1));
    assert.ok(!userOf(1).includes('少年背着旧案入宗'), userOf(1));
  });

  test('照抄的落了盘：种类、章号按对应关系填，伏笔挂在线下', async () => {
    assert.deepEqual(names(), ['林昭与沈青.md', '沈家旧案.md']);
    const { threads } = await project.readThreads();
    const by = Object.fromEntries(threads.map((x) => [x.name, x]));
    assert.deepEqual([by['林昭与沈青'].kind, by['林昭与沈青'].from, by['林昭与沈青'].to, by['林昭与沈青'].intent], ['感情线', 3, 18, '从互相猜忌到并肩。']);
    assert.deepEqual(by['林昭与沈青'].foreshadowing, [{ name: '玉佩的来历', what: '林昭的玉佩是沈家旧物', plant: 3, resolve: 18 }]);
    assert.deepEqual([by['沈家旧案'].kind, by['沈家旧案'].foreshadowing], ['主线', []]);
  });

  test('确认框报排 1 次、转写 1 次，最多 3 次；转写单列一行、不跟这一次挑的模型', () => {
    assert.ok(confirm.message.includes('预计 2 次调用，最多 3 次'), confirm.message);
    assert.equal(confirm.call.fixed?.length, 1, JSON.stringify(confirm.call));
    assert.ok(confirm.call.fixed[0].includes('不跟这一次挑的模型'), confirm.call.fixed[0]);
  });
});

describe('排线 · 转写改了原文的字', () => {
  let returned;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [planCopy({ intent: '从猜忌走到并肩。' }), planCopy()];
    fake.reset();
    h.expect('开始排');
    returned = await bundle.threads.generateThreads(project);
  });

  test('不收，重转一次、说清哪几处不是原文里的字；重转照抄的收下', () => {
    assert.equal(fake.callCount(), 3);
    assert.equal(returned, 3);
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「从猜忌走到并肩。」'), userOf(2).slice(0, 1200));
    assert.deepEqual(names(), ['林昭与沈青.md', '沈家旧案.md']);
  });
});

describe('排线 · 转写调用失败', () => {
  let returned;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [];
    behavior['p/small'] = 'fail';
    fake.reset();
    h.expect('开始排');
    returned = await bundle.threads.generateThreads(project);
    delete behavior['p/small'];
  });

  test('照原来排线失败的走法：挂红 ❗、文件不动；排的那一次与转写那一次都记账', async () => {
    assert.equal(returned, 2);
    assert.deepEqual(names(), []);
    const [f] = (await bundle.errorLog.listActiveFailures(project))[THREADS] ?? [];
    assert.equal(f?.severity, 'error');
    assert.match(f.message, /^排叙事线失败：叙事线转写没成（转写调用失败/);
    assert.ok(h.toasts.at(-1).includes('叙事线没排成（叙事线转写没成'), h.toasts.at(-1));
  });
});

// ---------------------------------------------------------------- 补记（定稿第三步：认事件、归并、当前进度）

/** 已有的一条线：玉佩那条伏笔还没埋。 */
const PAIR = [
  '---',
  'kind: 感情线',
  'plan: 1-18',
  '---',
  '',
  '# 林昭与沈青',
  '',
  '## 意图',
  '从互相猜忌到并肩。',
  '',
  '## 伏笔',
  '- 玉佩的来历：林昭的玉佩是沈家旧物（计划第 1 章埋、第 18 章前收）',
  '',
].join('\n');

const TEXT = {
  1: [
    '# 第1章',
    '',
    '夜里，沈青坐在廊下，把那块玉佩翻过来，背面刻着一个小小的沈字。',
    '',
    '林昭看着她，忽然明白那块玉佩原来是沈家的旧物。',
    '',
    '院外有人提着灯走过，脚步很轻。',
    '',
  ].join('\n'),
  2: '# 第2章\n\n林昭追到后院，只看见一盏灯。\n\n灯下没有人。\n',
};

/** 第 `no` 章：正文 + 同步过的细纲（sourceHash 对得上正文）。 */
async function finalized(no) {
  t.write(CH(no), TEXT[no]);
  project.invalidate();
  const hash = (await project.listChapters()).find((c) => c.order === no).contentHash;
  t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
  project.invalidate();
}

/** 认事件的模型按三节写出来的第 1 章：证据用「」引出正文原句。 */
const FIND_PROSE = [
  '## 事件',
  '- 推进｜林昭与沈青：两人夜谈，林昭认出玉佩。证据：「林昭看着她，忽然明白那块玉佩原来是沈家的旧物。」',
  '- 埋〈玉佩的来历〉｜林昭与沈青：玉佩背面刻着沈字。证据：「把那块玉佩翻过来，背面刻着一个小小的沈字」',
  '## 新线',
  '- 沈家旧案｜支线：沈家当年出了什么事。证据：「背面刻着一个小小的沈字」',
  '## 新伏笔',
  '- 提灯人｜沈家旧案：院外提灯的人是谁。证据：「院外有人提着灯走过，脚步很轻。」',
].join('\n');

const FIND_COPY = JSON.stringify({
  events: [
    { line: '林昭与沈青', type: '推进', what: '两人夜谈，林昭认出玉佩。', evidence: '林昭看着她，忽然明白那块玉佩原来是沈家的旧物。' },
    { line: '林昭与沈青', type: '埋', foreshadowing: '玉佩的来历', what: '玉佩背面刻着沈字。', evidence: '把那块玉佩翻过来，背面刻着一个小小的沈字' },
  ],
  newThreads: [{ title: '沈家旧案', kind: '支线', intent: '沈家当年出了什么事。', evidence: '背面刻着一个小小的沈字' }],
  newForeshadowing: [{ title: '提灯人', line: '沈家旧案', what: '院外提灯的人是谁。', evidence: '院外有人提着灯走过，脚步很轻。' }],
});

describe('补记一章 · 认事件、归并、当前进度都按格式写，转写照抄', () => {
  let n;
  let confirm;

  before(async () => {
    t.remove(THREADS);
    t.write(file('林昭与沈青'), PAIR);
    await finalized(1);
    // 一条都不并：模型没照「无」写、换了个说法，也认得出来、不转写。
    writer = { find: FIND_PROSE, merge: '无需归并。', progress: writeProgress };
    copies = [FIND_COPY, copyProgress];
    fake.reset();
    h.expect('开始补记');
    n = await bundle.backfill.backfillThreads(project);
    confirm = h.confirms.at(-1);
  });

  test('确认框：每章 2–6 次（含转写），转写单列一行', () => {
    assert.ok(confirm.message.includes('（每章 2–6 次）') && confirm.message.includes('预计 2–6 次调用，最多 9 次'), confirm.message);
    assert.ok(confirm.detail.includes('每写一次转写模型照抄成 JSON 1 次'), confirm.detail);
    assert.equal(confirm.call.fixed?.length, 1, JSON.stringify(confirm.call));
  });

  test('认事件写 1 次、转写 1 次；归并写的「无需归并」不转写；当前进度写 1 次、转写 1 次', () => {
    assert.equal(fake.callCount(), 5);
    assert.equal(n, 5);
    const steps = fake.calls.map((c) => c[0].content).map((s) =>
      s.includes(TRANSCRIBER) ? '转写' : s.includes(FIND_MARK) ? '认事件' : s.includes(MERGE_MARK) ? '归并' : s.includes(PROGRESS_MARK) ? '当前进度' : '?'
    );
    assert.deepEqual(steps, ['认事件', '转写', '归并', '当前进度', '转写']);
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/big', 'p/small', 'p/big', 'p/big', 'p/small']);
  });

  test('写的那几次不要 JSON；转写只带合同与那一次的原文', () => {
    assert.ok(userOf(0).endsWith('请按上面的格式写。') && userOf(2).endsWith('请按上面的格式写。') && userOf(3).endsWith('请按上面的格式写。'));
    assert.ok(userOf(1).includes('【叙事线事件 JSON 合同】') && userOf(1).includes(`【原文】\n${FIND_PROSE}`), userOf(1));
    // 原文里只有引出来的那几句正文：整章正文不进转写。
    assert.ok(!userOf(1).includes('【第1章'), userOf(1).slice(0, 600));
    assert.ok(userOf(4).includes('【当前进度 JSON 合同】') && userOf(4).includes('【线】林昭与沈青\n当前进度：林昭与沈青走到了这里。'), userOf(4));
  });

  test('照抄的证据对正文核过才记；新线、新伏笔、当前进度落了盘；水位推到第 1 章', async () => {
    const pair = bundle.threadFile.parseThreadFile(t.read(file('林昭与沈青')), file('林昭与沈青'));
    assert.deepEqual(
      pair.events.map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence]),
      [
        [1, '推进', '', '林昭看着她，忽然明白那块玉佩原来是沈家的旧物。'],
        [1, '埋', '玉佩的来历', '把那块玉佩翻过来，背面刻着一个小小的沈字'],
      ]
    );
    assert.equal(pair.progress, '林昭与沈青走到了这里。');
    const grown = bundle.threadFile.parseThreadFile(t.read(file('沈家旧案')), file('沈家旧案'));
    assert.deepEqual([grown.kind, grown.origin, grown.intent], ['支线', '正文', '沈家当年出了什么事。']);
    assert.deepEqual(grown.foreshadowing.map((f) => f.name), ['提灯人']);
    assert.deepEqual(await project.readThreadsMark(), { through: 1, judged: [] });
  });
});

describe('补记一章 · 认事件转写两次都改了证据', () => {
  let n;

  before(async () => {
    await finalized(2);
    const bad = JSON.stringify({
      events: [{ line: '林昭与沈青', type: '推进', what: '林昭追到后院。', evidence: '林昭追到了后院，只看见一盏灯。' }],
      newThreads: [],
      newForeshadowing: [],
    });
    writer = { find: ['## 事件', '- 推进｜林昭与沈青：林昭追到后院。证据：「林昭追到后院，只看见一盏灯。」', '## 新线', '无', '## 新伏笔', '无'].join('\n') };
    copies = [bad, bad];
    fake.reset();
    h.expect('开始补记');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('写 1 次、转写 2 次（重转那一次说清哪几处），照实记账', () => {
    assert.equal(fake.callCount(), 3);
    assert.equal(n, 3);
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「林昭追到了后院，只看见一盏灯。」'), userOf(2).slice(0, 1200));
  });

  test('照原来认事件没成的走法：停在这一章、失败挂在章节上，叙事线不动、水位不动', async () => {
    const [f] = (await bundle.errorLog.listActiveFailures(project))[CH(2)] ?? [];
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /^从已写正文补记叙事线没成：叙事线事件转写不合格（这几处不是原文里的字：「林昭追到了后院/);
    const pair = bundle.threadFile.parseThreadFile(t.read(file('林昭与沈青')), file('林昭与沈青'));
    assert.ok(pair.events.every((e) => e.chapter === 1), JSON.stringify(pair.events));
    assert.deepEqual(await project.readThreadsMark(), { through: 1, judged: [] });
    assert.ok(h.toasts.at(-1).includes('第 2 章没判成（叙事线事件转写不合格'), h.toasts.at(-1));
  });
});

describe('补记一章 · 三节都写「无」', () => {
  let n;

  before(async () => {
    writer = { find: '## 事件\n无\n\n## 新线\n无\n\n## 新伏笔\n无' };
    copies = [];
    fake.reset();
    h.expect('开始补记');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('不转写：1 次；这一章照样算判过，上一次挂的失败清掉', async () => {
    assert.equal(fake.callCount(), 1);
    assert.equal(n, 1);
    assert.deepEqual(await project.readThreadsMark(), { through: 2, judged: [] });
    assert.deepEqual((await bundle.errorLog.listActiveFailures(project))[CH(2)] ?? [], []);
  });
});
