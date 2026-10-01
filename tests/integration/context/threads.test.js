/**
 * 正文层的 `threads` 层（七期）：写正文时带最多 6 条和本章有关、还没收的叙事线。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 一条线一个条目，按要紧程度排，note 写状态与为什么带 | 第 2 条：明细里看得出带了什么、为什么 |
 * | 计划中、没到埋下那一章、细纲没提的不带；收了的不带 | 带进去等于提示模型提前埋 |
 * | 6 条以外的 dropped 并写原因 | 第 2 条：不静默截断 |
 * | 取消勾选的不占名额 | 作者排除一条，后面的补上来 |
 * | 消息里一节，带「没到回收章不许提前揭开」 | 这一层存在的另一半理由 |
 * | 第 1 章也带 | 计划在第 1 章埋下的线，写第 1 章的人得知道（上游不带） |
 * | 续写、审稿、修稿不带 | 它们各有各的配方 |
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
  recentChaptersFullText: 2,
  prevChapterTailChars: 1500,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
});

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/plots/${pad3(no)}-第${no}章.md`;

function plotText(no, events) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'characters: [林昭]',
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 本章目的',
    '',
    '往下查。',
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 章末钩子',
    '',
    '井底有人。',
    '',
  ].join('\n');
}

const THREADS = [
  '# 叙事线',
  '',
  '## 玉佩的来历',
  '- 类型：伏笔',
  '- 计划：第 2–8 章',
  '- 意图：玉佩是沈家旧物。',
  '- 事件：',
  '  - 第 3 章 · 埋下：「他摸了摸怀里的玉佩」——第一次露面',
  '',
  '## 远方的来信',
  '- 类型：悬念',
  '- 计划：第 10–12 章',
  '- 意图：信是谁寄的。',
  '',
  '## 青崖镇的大火',
  '- 类型：悬念',
  '- 计划：第 1–3 章',
  '- 意图：大火是谁放的。',
  '- 第 1 章 · 埋下：「火光冲天」',
  '',
  '## 后面才埋的线',
  '- 类型：伏笔',
  '- 计划：第 9–20 章',
  '- 意图：林昭的师父另有身份。',
  '',
  '## 已经收了',
  '- 计划：第 1–9 章',
  '- 第 2 章 · 回收：「x」',
  '',
].join('\n');

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'threadsLayer', title: '叙事线测试' });
  for (let no = 1; no <= 4; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  // 第 5 章的细纲提到了「远方的来信」：它没到区间，但细纲提了就带，而且排在最前。
  t.write(PLOT(5), plotText(5, '林昭收到了远方的来信，信上没有落款。'));
  t.write(PLOT(1), plotText(1, '林昭在雪夜里出逃。'));
  t.write('.novelforge/threads.md', THREADS);
  t.project.invalidate();
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

  test('有关的线一条一个条目，按要紧程度排', () => {
    assert.deepEqual(
      threadItems(b).map((i) => [i.label, i.status]),
      [
        ['叙事线 · 远方的来信', 'included'],
        ['叙事线 · 玉佩的来历', 'included'],
        ['叙事线 · 青崖镇的大火', 'included'],
      ]
    );
  });

  test('note 写状态与为什么带它，来源是 threads.md', () => {
    const [letter, jade, fire] = threadItems(b);
    assert.equal(letter.note, '计划中 · 本章细纲提到了它');
    assert.equal(jade.note, '已埋下 · 本章在它的计划区间里');
    assert.equal(fire.note, '已埋下 · 已过计划回收的第 3 章，还没收');
    assert.equal(jade.source, '.novelforge/threads.md');
    assert.equal(jade.priority, 1);
  });

  test('计划中、还没到埋下那一章、细纲没提的不带；收了的不带', () => {
    const labels = threadItems(b).map((i) => i.label).join('|');
    assert.ok(!labels.includes('后面才埋的线'), labels);
    assert.ok(!labels.includes('已经收了'), labels);
  });

  test('消息里一节：一条一行，带不许提前揭开，排在前文正文与本章细纲之前', () => {
    const user = userOf(b);
    const at = user.indexOf('# 进行中的叙事线（只作提醒：以本章细纲为准，细纲没写到的线不要硬塞；没到回收章的线不许提前揭开）');
    assert.ok(at > 0, user.slice(0, 2000));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(
      section.includes(
        '- 玉佩的来历（伏笔 · 已埋下 · 第 2 章埋、第 8 章前收；第 8 章之前不要揭开）意图：玉佩是沈家旧物。；最近：第 3 章「他摸了摸怀里的玉佩」'
      ),
      section
    );
    assert.ok(section.indexOf('远方的来信') < section.indexOf('玉佩的来历'), section);
    assert.equal(section.trim().split('\n\n').length, 2, '标题之后一条一行，中间不空行');
    assert.ok(at < user.indexOf('# 前文正文'));
    assert.ok(at < user.indexOf('# 细纲'));
  });
});

describe('threads 层 · 名额与排除', () => {
  test('最多 6 条，排在后面的 dropped 并写原因', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => `## 区间内${i}\n- 计划：第 1–9 章\n- 意图：第${i}条。\n`).join('\n');
    t.write('.novelforge/threads.md', `${THREADS}\n${extra}`);
    t.project.invalidate();
    const b = await build(5);
    const items = threadItems(b);
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    const dropped = items.filter((i) => i.status === 'dropped');
    assert.equal(dropped.length, 3);
    assert.ok(dropped.every((i) => i.note === '叙事线一次只带 6 条，排在后面的没带' && i.text === ''), JSON.stringify(dropped));
    t.write('.novelforge/threads.md', THREADS);
    t.project.invalidate();
  });

  test('取消勾选的那条标 excluded，不占名额', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => `## 区间内${i}\n- 计划：第 1–9 章\n- 意图：第${i}条。\n`).join('\n');
    t.write('.novelforge/threads.md', `${THREADS}\n${extra}`);
    t.project.invalidate();
    const first = threadItems(await build(5))[0];
    const b = await build(5, { excludedIds: [first.id] });
    const items = threadItems(b);
    assert.equal(items.find((i) => i.id === first.id)?.status, 'excluded');
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    assert.equal(items.filter((i) => i.status === 'dropped').length, 2);
    t.write('.novelforge/threads.md', THREADS);
    t.project.invalidate();
  });
});

describe('threads 层 · 什么时候不带', () => {
  // 状态按「写到这一章时」算：重写第 1 章时，玉佩那条（第 3 章才埋下）还是计划中、没到区间，
  // 不带；「已经收了」那条第 2 章才回收，在第 1 章看来还开着——后面的事不透给前面。
  test('第 1 章也带：计划从第 1 章起的线；后面几章才发生的事不算', async () => {
    const b = await build(1);
    const items = threadItems(b);
    assert.deepEqual(items.map((i) => i.label), ['叙事线 · 青崖镇的大火', '叙事线 · 已经收了']);
    assert.equal(items[0].note, '计划中 · 本章在它的计划区间里');
    assert.ok(items.every((i) => !i.text.includes('最近')), JSON.stringify(items.map((i) => i.text)));
  });

  test('没有 threads.md：一条都不出', async () => {
    t.remove('.novelforge/threads.md');
    t.project.invalidate();
    const b = await build(5);
    assert.deepEqual(threadItems(b), []);
    assert.ok(!userOf(b).includes('# 进行中的叙事线'));
    t.write('.novelforge/threads.md', THREADS);
    t.project.invalidate();
  });

  test('续写那几轮不带', async () => {
    const b = await build(5, { step: { kind: 'continuation', tail: '已写的末尾', written: 600, remaining: 600, recovery: false } });
    assert.deepEqual(threadItems(b), []);
  });

  test('审稿、修稿不带', async () => {
    const review = await bundle.builder.buildContext(
      t.project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: PLOT(5) }, ask: '', reviewGoals: [] },
      config()
    );
    assert.deepEqual(threadItems(review), []);
    const revise = await build(5, { writeMode: 'revise', revision: { previousDraft: '第5章的正文。', feedback: '改一处' } });
    assert.deepEqual(threadItems(revise), []);
  });
});
