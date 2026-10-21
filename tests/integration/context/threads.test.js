/**
 * 正文层的 `threads` 层（叙事线重做，设计稿「四」）：写正文时带没收束、和本章有关的线，一条线一行——现在走到哪、本章计划、
 * 没收的伏笔；审稿只带伏笔那一半。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 一条线一个条目，按要紧程度排：本章有计划 / 细纲提到 → 主线 → 收束章就在附近 → 最近动过的 | 设计稿的挑法 |
 * | 一行写现在走到哪（当前进度）、本章计划、没收的伏笔（该收的在前，没到回收章的「第 b 章前不要揭开」） | 设计稿：这一层存在的另一半理由 |
 * | 计划中、没到开始那一章、细纲没提的不带；收束的不带；还没到埋的伏笔不提 | 带进去等于提示模型提前写 |
 * | 「未归属的伏笔」有该收的单独一行 | 挂不上线的伏笔也要有人提醒 |
 * | 写到第 N 章时按那时算：当前进度写到这一章或更晚的不用，改用这一章之前的事件 | 不把后面的剧情透给前面 |
 * | 6 条以外的 dropped 写原因、取消勾选的不占名额 | 第 2 条：不静默截断 |
 * | 审稿只带没收的伏笔（换个标题）；续写、修稿不带 | 设计稿 ⚑5；它们各有各的配方 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const REVIEW = { stage: 'manuscript', capability: 'review' };

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
});

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

/** 一份还没定稿的细纲（计划）。 */
function plotText(no, events) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 出场人物',
    '',
    '林昭',
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 看点',
    '',
    '- 井底有人。',
    '',
  ].join('\n');
}

/** 叙事线：一条线一个文件。 */
const DIR = '.novelforge/threads';
const thread = (kind, plan, { intent = '', fore = [], events = [] } = {}) =>
  [
    '---',
    `kind: ${kind}`,
    `plan: ${plan}`,
    '---',
    '',
    '## 意图',
    intent,
    '',
    '## 伏笔',
    ...fore.map((f) => `- ${f}`),
    '',
    '## 进展',
    ...events.map((e) => `- ${e}`),
    '',
  ].join('\n');

let bundle;
let t;

/** 林昭与沈青：当前进度是机器写到第 4 章的；第 5 章计划推进；两条伏笔，一条第 5 章该收、一条第 18 章才收。 */
function pairFile() {
  return bundle.threadFile.patchProgress(
    thread('感情线', '2-30', {
      intent: '从互相猜忌到并肩。',
      fore: ['玉佩的来历：沈家旧物（计划第 2 章埋、第 18 章前收）', '沈青的旧伤（第 5 章前收）'],
      events: [
        '第 3 章 · 推进：初遇 〔证据：「她的剑停在他喉前三寸」〕',
        '第 3 章 · 埋〈玉佩的来历〉：玉佩露面 〔证据：「他摸了摸怀里的玉佩」〕',
        '第 5 章 · 计划 · 推进：沈青第一次替林昭挡刀',
      ],
    }),
    '两人已结盟，沈青仍瞒着身份。',
    4
  );
}

const THREADS = () => ({
  林昭与沈青: pairFile(),
  远方的来信: thread('支线', '10-12', { intent: '信是谁寄的。' }),
  青崖镇的大火: thread('主线', '1-40', { intent: '大火是谁放的。', events: ['第 1 章 · 推进：起火 〔证据：「火光冲天」〕'] }),
  后面才开的线: thread('支线', '9-20', { intent: '林昭的师父另有身份。' }),
  已经收了: thread('支线', '1-9', { events: ['第 2 章 · 收束：收了 〔证据：「x」〕'] }),
  断了的线: thread('人物线', '1-30', { intent: '林昭学会放下。', events: ['第 2 章 · 推进：林昭第一次犹豫 〔证据：「他犹豫了」〕'] }),
  快收束的线: thread('支线', '1-7', { intent: '镇上的怪事。', events: ['第 1 章 · 推进：怪事开头 〔证据：「井里有声音」〕'] }),
});
const UNFILED = '# 未归属的伏笔\n\n## 伏笔\n- 提灯人：院外提灯的人（第 4 章前收）\n- 断剑（计划第 9 章埋）\n\n## 进展\n- 第 2 章 · 埋〈提灯人〉：有人提灯走过 〔证据：「提着灯」〕\n';

/** 把叙事线目录换成这几条（再加 `extra` 条进行中的支线）。 */
function writeThreads(extra = 0) {
  t.remove(DIR);
  for (const [name, text] of Object.entries(THREADS())) {
    t.write(`${DIR}/${name}.md`, text);
  }
  t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
  for (let i = 0; i < extra; i++) {
    t.write(`${DIR}/区间内${i}.md`, thread('支线', '1-30', { events: [`第 4 章 · 推进：第${i}条 〔证据：「x」〕`] }));
  }
  t.project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    threadFile: './src/core/model/threadFile.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'threadsLayer', title: '叙事线测试' });
  for (let no = 1; no <= 4; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  // 第 5 章的细纲提到了「远方的来信」：它没到区间，但细纲提了就带，而且排在最前那一档。
  t.write(PLOT(5), plotText(5, '林昭收到了远方的来信，信上没有落款。'));
  t.write(PLOT(1), plotText(1, '林昭在雪夜里出逃。'));
  writeThreads();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(no, extra = {}) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(no) }, ask: '', targetWords: 1200, ...extra },
    config()
  );
}

const threadItems = (b) => b.items.filter((i) => i.kind === 'thread');
const userOf = (b) => b.messages[b.messages.length - 1].content;

describe('threads 层 · 第 5 章', () => {
  let b;
  before(async () => {
    b = await build(5);
  });

  test('有关的线一条一个条目，按要紧程度排：本章有计划 / 细纲提到 → 主线 → 收束章在附近、有伏笔该收 → 最近动过的', () => {
    assert.deepEqual(
      threadItems(b).map((i) => [i.label, i.status, i.note]),
      [
        ['叙事线 · 林昭与沈青', 'included', '进行中 · 本章有计划'],
        ['叙事线 · 远方的来信', 'included', '计划中 · 本章细纲提到了它'],
        ['叙事线 · 青崖镇的大火', 'included', '进行中 · 主线'],
        ['叙事线 · 快收束的线', 'included', '进行中 · 计划第 7 章收束，就在附近'],
        ['叙事线 · 未归属的伏笔', 'included', '未归属 · 有伏笔该收了、本章有计划或细纲提到了'],
        ['叙事线 · 断了的线', 'included', '进行中 · 最近第 2 章动过'],
      ]
    );
  });

  test('来源是那条线自己的文件，优先级 P1', () => {
    const [pair] = threadItems(b);
    assert.equal(pair.source, '.novelforge/threads/林昭与沈青.md');
    assert.equal(pair.priority, 1);
  });

  test('计划中、还没到开始那一章、细纲没提的不带；收束了的不带', () => {
    const labels = threadItems(b).map((i) => i.label).join('|');
    assert.ok(!labels.includes('后面才开的线'), labels);
    assert.ok(!labels.includes('已经收了'), labels);
  });

  test('一行：现在走到哪、本章计划、没收的伏笔（该收的在前，没到回收章的不要揭开）', () => {
    const [pair, letter, fire] = threadItems(b);
    assert.equal(
      pair.text,
      '- 林昭与沈青（感情线 · 进行中）现在：两人已结盟，沈青仍瞒着身份；本章计划：推进——沈青第一次替林昭挡刀；没收的伏笔：沈青的旧伤（本章计划收）、玉佩的来历（第 18 章前不要揭开）'
    );
    assert.equal(letter.text, '- 远方的来信（支线 · 计划中）意图：信是谁寄的');
    assert.equal(fire.text, '- 青崖镇的大火（主线 · 进行中）最近：第 1 章推进：起火');
  });

  test('「未归属的伏笔」一行：逾期的提，还没到埋的时候的不提', () => {
    const loose = threadItems(b).find((i) => i.label === '叙事线 · 未归属的伏笔');
    assert.equal(loose.text, '- 未归属的伏笔：提灯人（已过第 4 章，还没收）');
  });

  test('消息里一节：一条一行，说清没到回收章的伏笔不许提前揭开，排在前文正文与本章细纲之前', () => {
    const user = userOf(b);
    const at = user.indexOf('# 进行中的叙事线（只作提醒：以本章细纲为准，细纲没写到的线不要硬塞；没到回收章的伏笔不许提前揭开）');
    assert.ok(at > 0, user.slice(0, 2000));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.equal(section.trim().split('\n\n').length, 2, '标题之后一条一行，中间不空行');
    assert.ok(section.indexOf('林昭与沈青') < section.indexOf('远方的来信'), section);
    assert.ok(at < user.indexOf('# 前文正文'));
    assert.ok(at < user.indexOf('# 细纲'));
  });
});

// 复跑报告问题 5：主线这 4 个位置一直是同样 4 条，当章细纲里提到的「旧铜牌与铜钱的共鸣」「照骨镜的残片」没列出来，正文当章
// 就把它们揭开了。细纲或本章计划提到的伏笔一律列出、不占 4 条的名额；「最近」不取「埋」；没有回收章的不硬写「不要提前揭开」。
describe('threads 层 · 本章细纲提到的伏笔一律列出', () => {
  const MAIN = thread('主线', '1-40', {
    intent: '大火是谁放的。',
    fore: [
      '铜铃的来历：铃是沈家的（第 20 章前收）',
      '旧账本：账上少了一笔（第 21 章前收）',
      '井底的秘密：井底藏着东西（第 22 章前收）',
      '老井的回声：井里有回声',
      '师父的信：信里有名单（第 24 章前收）',
      '照骨镜的残片：残片能照出死人（第 25 章前收）',
      '无面鬼火的本质：鬼火是全镇的怨念（计划第 9 章埋、第 20 章前收）',
    ],
    events: [
      '第 1 章 · 推进：起火 〔证据：「火光冲天」〕',
      ...['铜铃的来历', '旧账本', '井底的秘密', '老井的回声', '师父的信', '照骨镜的残片'].map((n) => `第 1 章 · 埋〈${n}〉：露面 〔证据：「x」〕`),
    ],
  });
  const CLOSED = thread('支线', '1-9', {
    fore: ['沉船的秘密：船是被凿沉的（第 30 章前收）', '没提到的：不列（第 30 章前收）'],
    events: ['第 1 章 · 埋〈沉船的秘密〉：露面 〔证据：「x」〕', '第 1 章 · 埋〈没提到的〉：露面 〔证据：「x」〕', '第 2 章 · 收束：收了 〔证据：「x」〕'],
  });
  const setUp = () => {
    t.remove(DIR);
    t.write(`${DIR}/青崖镇的大火.md`, MAIN);
    t.write(`${DIR}/已经收了.md`, CLOSED);
    t.write(PLOT(6), plotText(6, '- 林昭在祠堂捡到照骨镜残片，想起师父的信\n- 远处的无面鬼火又浮了起来\n- 沉船的秘密有了眉目'));
    t.project.invalidate();
  };
  const tearDown = () => {
    t.remove(PLOT(6));
    writeThreads();
  };

  test('提到的排在同一档最前面、不占 4 条名额；还没到埋的被提到也列（第 b 章前不要揭开）；没有回收章的换个说法；「最近」不取「埋」', async () => {
    setUp();
    const items = threadItems(await build(6));
    const fire = items.find((i) => i.label === '叙事线 · 青崖镇的大火');
    assert.equal(
      fire.text,
      '- 青崖镇的大火（主线 · 进行中）最近：第 1 章推进：起火；没收的伏笔：无面鬼火的本质（第 20 章前不要揭开）、师父的信（第 24 章前不要揭开）、' +
        '照骨镜的残片（第 25 章前不要揭开）、铜铃的来历（第 20 章前不要揭开）、旧账本（第 21 章前不要揭开）、井底的秘密（第 22 章前不要揭开）、' +
        '老井的回声（还没定哪一章收，细纲没安排就别揭开）'
    );
    assert.equal(fire.note, '进行中 · 本章细纲提到了它上面的伏笔');
    // 收束了的线不带，它上面本章提到的伏笔照列（只列提到的那几条）。
    const closed = items.find((i) => i.label === '叙事线 · 已经收了');
    assert.equal(closed.text, '- 已经收了（支线 · 已收束）没收的伏笔：沉船的秘密（第 30 章前不要揭开）');
    tearDown();
  });

  test('仍受这一层的总字数管：整行放不下时，明细里点名说本章提到的那几条没带上', async () => {
    setUp();
    const b = await bundle.builder.buildContext(
      t.project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(6) }, ask: '', targetWords: 1200 },
      { ...config(), contextOverrides: { threadChars: 80 } }
    );
    const fire = threadItems(b).find((i) => i.label === '叙事线 · 青崖镇的大火');
    assert.equal(fire.status, 'dropped');
    assert.equal(
      fire.note,
      '叙事线一共只带 80 字，放不下这一条（其中有本章细纲或计划提到的伏笔：无面鬼火的本质、师父的信、照骨镜的残片，没带上）'
    );
    tearDown();
  });
});

describe('threads 层 · 名额与排除', () => {
  test('最多 6 条，排在后面的 dropped 并写原因', async () => {
    writeThreads(3);
    const items = threadItems(await build(5));
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    const dropped = items.filter((i) => i.status === 'dropped');
    assert.equal(dropped.length, 3);
    assert.ok(dropped.every((i) => i.note === '叙事线一次只带 6 条，排在后面的没带' && i.text === ''), JSON.stringify(dropped));
    writeThreads();
  });

  test('取消勾选的那条标 excluded，不占名额', async () => {
    writeThreads(3);
    const first = threadItems(await build(5))[0];
    const items = threadItems(await build(5, { excludedIds: [first.id] }));
    assert.equal(items.find((i) => i.id === first.id)?.status, 'excluded');
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    assert.equal(items.filter((i) => i.status === 'dropped').length, 2);
    writeThreads();
  });
});

describe('threads 层 · 写到第 N 章时按那时算', () => {
  // 重写第 1 章：后面几章才发生的事、写到第 4 章的当前进度都不算；林昭与沈青第 2 章才开、第 1 章没计划，不带。
  test('第 1 章：只带那时已经开了的线，没有「最近」与「现在」', async () => {
    const items = threadItems(await build(1));
    assert.deepEqual(items.map((i) => i.label), [
      '叙事线 · 青崖镇的大火',
      '叙事线 · 断了的线',
      '叙事线 · 快收束的线',
      '叙事线 · 已经收了',
    ]);
    assert.equal(items[0].text, '- 青崖镇的大火（主线 · 计划中）意图：大火是谁放的');
    assert.ok(items.every((i) => !i.text.includes('最近') && !i.text.includes('现在')), JSON.stringify(items.map((i) => i.text)));
  });
});

describe('threads 层 · 什么时候不带、审稿带什么', () => {
  test('没有叙事线：一条都不出', async () => {
    t.remove(DIR);
    t.project.invalidate();
    const b = await build(5);
    assert.deepEqual(threadItems(b), []);
    assert.ok(!userOf(b).includes('# 进行中的叙事线'));
    writeThreads();
  });

  test('续写那几轮不带', async () => {
    const b = await build(5, { step: { kind: 'continuation', tail: '已写的末尾', written: 600, remaining: 600, recovery: false } });
    assert.deepEqual(threadItems(b), []);
  });

  test('修稿不带', async () => {
    const revise = await build(5, { writeMode: 'revise', revision: { previousDraft: '第5章的正文。', feedback: '改一处' } });
    assert.deepEqual(threadItems(revise), []);
  });

  // 设计稿 ⚑5：审稿提示词里两条伏笔检查的材料从前是角色卡「未收伏笔」与细纲「新增伏笔」，都并进了叙事线。
  test('审稿只带没收的伏笔：该收的在前，没到回收章的「不该揭开」，换个标题', async () => {
    const review = await bundle.builder.buildContext(
      t.project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: PLOT(5) }, ask: '', reviewGoals: [] },
      config()
    );
    assert.deepEqual(
      threadItems(review).map((i) => i.text),
      [
        '- 提灯人（挂在「未归属的伏笔」· 已埋 · 已过第 4 章，还没收）是什么：院外提灯的人',
        '- 沈青的旧伤（挂在「林昭与沈青」· 计划 · 本章计划收）',
        '- 玉佩的来历（挂在「林昭与沈青」· 已埋 · 第 18 章前不该揭开）是什么：沈家旧物',
      ]
    );
    assert.ok(threadItems(review).every((i) => i.label.startsWith('伏笔 · ')));
    const user = userOf(review);
    assert.ok(user.includes('# 没收的伏笔（审稿对照：计划在本章收的写到没有；没到回收章的有没有提前揭开）'), user.slice(0, 1500));
    assert.ok(!user.includes('# 进行中的叙事线'));
  });
});

// 叙事线二期（设计稿「二」）：拆细纲的 `plot` 配方也带 threads 层，按区间挑——批次时 `plot` 是空的、`no` 只是第一章，
// 只看第一章会把这一批后面几章该收的伏笔漏掉。
describe('threads 层 · 拆细纲（按区间挑）', () => {
  const PLAN = { stage: 'plot', capability: 'generate' };
  const buildPlot = (range, extra = {}, cfg = {}) =>
    bundle.builder.buildContext(
      t.project,
      { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(range.from) }, ask: '', ...(range.to > range.from ? { range } : {}), ...extra },
      { ...config(), ...cfg }
    );

  test('批次第 5–9 章：线全带（收束的不带），这一批原来有计划的在前、还没到开始的在最后并写明', async () => {
    const b = await buildPlot({ from: 5, to: 9 });
    const lines = threadItems(b).filter((i) => i.label.startsWith('叙事线 · '));
    assert.deepEqual(lines.map((i) => [i.label, i.note]), [
      ['叙事线 · 林昭与沈青', '进行中 · 本批原来有计划'],
      ['叙事线 · 青崖镇的大火', '进行中 · 主线'],
      ['叙事线 · 断了的线', '进行中 · 最近第 2 章动过'],
      ['叙事线 · 快收束的线', '进行中 · 最近第 1 章动过'],
      ['叙事线 · 后面才开的线', '计划中 · 本批在它的计划区间里'],
      ['叙事线 · 远方的来信', '计划中 · 计划第 10 章起，本批还不到'],
    ]);
    assert.equal(
      lines[0].text,
      '- 林昭与沈青（感情线 · 进行中 · 计划第 2–30 章）意图：从互相猜忌到并肩；现在：两人已结盟，沈青仍瞒着身份；最近：第 3 章推进：初遇；第 3 章埋〈玉佩的来历〉：玉佩露面；本批原来的计划：第 5 章推进——沈青第一次替林昭挡刀'
    );
    assert.equal(lines[3].text, '- 快收束的线（支线 · 进行中 · 计划在第 7 章收束）意图：镇上的怪事；最近：第 1 章推进：怪事开头');
    assert.equal(lines[5].text, '- 远方的来信（支线 · 计划中 · 计划第 10–12 章）意图：信是谁寄的；本批还不到它开始的那一章，不要提前开');
    assert.ok(lines.every((i) => i.priority === 1 && i.source.startsWith('.novelforge/threads/')));
  });

  test('批次第 5–9 章：没收的伏笔一条一个，这一批要收的、逾期的在前；第 9 章才埋的这一批也带', async () => {
    const fores = threadItems(await buildPlot({ from: 5, to: 9 })).filter((i) => i.label.startsWith('伏笔 · '));
    assert.deepEqual(fores.map((i) => i.text), [
      '- 提灯人（挂在「未归属的伏笔」· 已埋 · 已过第 4 章，还没收）是什么：院外提灯的人',
      '- 沈青的旧伤（挂在「林昭与沈青」· 计划 · 本批要收，最晚第 5 章，还没埋，先埋再收）',
      '- 玉佩的来历（挂在「林昭与沈青」· 已埋 · 第 18 章前收，之前不要揭开）是什么：沈家旧物',
      '- 断剑（挂在「未归属的伏笔」· 计划 · 本批要埋，计划第 9 章）',
    ]);
    assert.equal(fores[0].id, 'thread:.novelforge/threads/未归属的伏笔.md#提灯人');
  });

  test('单章第 5 章：说「本章」，第 9 章才埋的不带，第 7 章收束的线不算落在这一章', async () => {
    const items = threadItems(await buildPlot({ from: 5, to: 5 }));
    const texts = items.map((i) => i.text).join('\n');
    assert.ok(texts.includes('沈青的旧伤（挂在「林昭与沈青」· 计划 · 本章要收，还没埋，先埋再收）'), texts);
    assert.ok(texts.includes('本章原来的计划：第 5 章推进'), texts);
    assert.ok(!texts.includes('断剑'), texts);
    assert.ok(texts.includes('- 快收束的线（支线 · 进行中 · 计划第 1–7 章）'), texts);
  });

  test('消息里一节：线在前、没收的伏笔另起一段，排在连续性事实之后、前序细纲一览与本章细纲之前', async () => {
    const user = userOf(await buildPlot({ from: 5, to: 9 }));
    const at = user.indexOf('# 叙事线（照着排：该推进的线推进、该收的伏笔安排在某一章收');
    assert.ok(at > 0, user.slice(0, 1500));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('- 林昭与沈青') < section.indexOf('\n\n没收的伏笔：\n- 提灯人'), section);
    assert.ok(!user.includes('# 进行中的叙事线'));
    const list = user.indexOf('# 前序细纲一览');
    assert.ok(list < 0 || at < list);
  });

  test('线、伏笔各按上下文详细度封顶，放不下的 dropped 写原因；取消勾选的不占名额', async () => {
    const cfg = { contextOverrides: { plotThreadCount: 2, plotForeshadowCount: 1 } };
    const items = threadItems(await buildPlot({ from: 5, to: 9 }, {}, cfg));
    const lines = items.filter((i) => i.label.startsWith('叙事线 · '));
    const fores = items.filter((i) => i.label.startsWith('伏笔 · '));
    assert.equal(lines.filter((i) => i.status === 'included').length, 2);
    assert.ok(lines.filter((i) => i.status === 'dropped').every((i) => i.note === '叙事线一次只带 2 条，排在后面的没带'));
    assert.deepEqual(fores.filter((i) => i.status === 'included').map((i) => i.label), ['伏笔 · 提灯人']);
    assert.ok(fores.filter((i) => i.status === 'dropped').every((i) => i.note === '伏笔一次只带 1 条，排在后面的没带'));
    const excluded = await buildPlot({ from: 5, to: 9 }, { excludedIds: [fores[0].id] }, cfg);
    const after = threadItems(excluded).filter((i) => i.label.startsWith('伏笔 · '));
    assert.equal(after.find((i) => i.id === fores[0].id).status, 'excluded');
    assert.deepEqual(after.filter((i) => i.status === 'included').map((i) => i.label), ['伏笔 · 沈青的旧伤']);
  });

  test('讨论细纲也带（同一张配方）；没有叙事线时一条都不出', async () => {
    const discuss = await bundle.builder.buildContext(
      t.project,
      { action: { stage: 'plot', capability: 'discuss' }, target: { kind: 'plot', plotRelPath: PLOT(5) }, ask: '这一章怎么排？' },
      config()
    );
    assert.ok(threadItems(discuss).some((i) => i.label === '叙事线 · 林昭与沈青'));
    t.remove(DIR);
    t.project.invalidate();
    const b = await buildPlot({ from: 5, to: 9 });
    assert.deepEqual(threadItems(b), []);
    assert.ok(!userOf(b).includes('# 叙事线（'));
    writeThreads();
  });
});
