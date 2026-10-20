/**
 * 工程页黄条上的「立即同步」（`syncSummaries`）：把待定稿的章逐章定稿，三步与单章定稿同一套。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 确认框写明三步与次数（每章 1–3 次） | 第 4 条：动手之前写明预计调用次数 |
 * | 三章的细纲都记上 `sourceHash` | 第一步照旧：照正文更新细纲、算写完 |
 * | 角色状态与叙事线每章各走一次，按章号 1、2、3 的顺序 | 从前同步只做第一步，章算定稿了、角色状态与叙事线却停在原地；这两步要一章一章往后推，并发会抢写同一张卡、同一条线 |
 * | 角色卡的「当前状态」推到最后一章，叙事线记上事件 | 同步过的章与逐章定稿的章是同一个结果 |
 * | 返回实际调用次数 | MCP 的 `summary sync` 拿它记账 |
 * | 第一步没成的章不走后两步，红 ❗ 挂在那一章 | 细纲没更新，角色状态与叙事线没有可依据的出场人物 |
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

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/00${no}-第${no}章.md`;
const CARD = '.novelforge/characters/林昭.md';
const THREADS = '.novelforge/threads/玉佩的来历.md';
const textOf = (no) => `林昭在第${no}章摸了摸怀里的玉佩。\n\n沈氏在第${no}章翻开名册。`;

/** 给了章号就让那一章的定稿答坏（第一步失败那一节）。 */
let brokenNo;

const STATE_MARK = '依据本章正文更新角色的「当前状态」';
const THREAD_MARK = '你是小说定稿事实审查员';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可检索的章节档案')) {
    if (no === brokenNo) {
      return '这不是 JSON';
    }
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }],
      时间地点: '青崖镇。',
      关键事件: [`第 ${no} 章的事`],
      新增伏笔: [],
      状态变更: '',
      连续性事实: [`沈氏在第${no}章翻开名册`],
    });
  }
  if (system.includes(STATE_MARK)) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: `第 ${no} 章之后，玉佩还在怀里` }] });
  }
  if (system.includes(THREAD_MARK)) {
    return JSON.stringify({
      events: [{ thread: '玉佩的来历', type: '推进', evidence: `林昭在第${no}章摸了摸怀里的玉佩`, reason: '玉佩又露面' }],
    });
  }
  return '（认不出这一步）';
}

/** 角色状态、叙事线这两种调用各是第几章，按发出去的先后排。 */
function stepOrder(mark) {
  return fake.calls
    .filter((messages) => (messages[0]?.content ?? '').includes(mark))
    .map((messages) => Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0));
}

async function writeChapters(nos) {
  for (const no of nos) {
    t.write(CH(no), `# 第${no}章\n\n${textOf(no)}\n`);
  }
  project.invalidate();
  await project.syncManifest();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    summarize: './src/core/features/summarize.ts',
    plotFile: './src/core/model/plotFile.ts',
    threadFile: './src/core/model/threadFile.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  // 并发 2 路：第一步照样并发，后两步也得按章号排好。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 2,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'syncSummaries', title: '同步测试' });
  project = t.project;
  // 林昭的卡从没盖过章、当前状态空着：归机器写。
  t.write(CARD, '---\nname: 林昭\n---\n\n# 林昭\n\n## 身份\n\n回镇的人\n\n## 当前状态\n\n');
  t.write(
    THREADS,
    bundle.threadFile.renderThreadFile({ name: '玉佩的来历', kind: '支线', origin: '计划', from: 1, to: 9, intent: '玉佩是沈家旧物。', foreshadowing: [] })
  );
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('同步：三章逐章定稿，角色状态与叙事线按章号走', () => {
  let used;

  before(async () => {
    await writeChapters([1, 2, 3]);
    fake.reset();
    h.expect('开始同步');
    used = await bundle.summarize.syncSummaries(project);
  });

  test('确认框写明三步与次数', () => {
    const { message, detail } = h.confirms.at(-1);
    assert.ok(message.startsWith('有 3 章写了正文还没定稿'), message);
    assert.ok(message.includes('更新出场角色的当前状态、记下推进了哪几条叙事线'), message);
    assert.ok(message.includes('预计 3–9 次调用'), message);
    assert.ok(detail.includes('角色状态与叙事线按章号逐章串行'), detail);
  });

  test('三章的细纲都记上了正文的指纹', async () => {
    project.invalidate();
    for (const chapter of await project.listChapters()) {
      const plot = await project.readPlot(PLOT(chapter.order));
      assert.equal(plot.sourceHash, chapter.contentHash, `第 ${chapter.order} 章`);
    }
  });

  test('角色状态与叙事线每章各一次，按章号顺序', () => {
    assert.deepEqual(stepOrder(STATE_MARK), [1, 2, 3]);
    assert.deepEqual(stepOrder(THREAD_MARK), [1, 2, 3]);
  });

  test('角色卡的当前状态推到了第 3 章', () => {
    const text = t.read(CARD);
    assert.ok(text.includes('第 3 章之后，玉佩还在怀里'), text);
    assert.ok(/stateThrough: 3/.test(text), text);
  });

  test('那条线按章记上了三条事件', () => {
    const thread = bundle.threadFile.parseThreadFile(t.read(THREADS), THREADS);
    assert.deepEqual(thread.events.map((e) => e.chapter), [1, 2, 3]);
  });

  test('返回实际调用次数：3 章 × 3 步', () => {
    assert.equal(used, 9);
    assert.equal(fake.calls.length, 9);
  });
});

describe('同步：第一步没成的章不走后两步', () => {
  let used;

  before(async () => {
    // 改了第 4、5 章的正文：这两章待定稿，前三章已经对得上。
    await writeChapters([4, 5]);
    brokenNo = 4;
    fake.reset();
    h.expect('开始同步');
    used = await bundle.summarize.syncSummaries(project);
    brokenNo = undefined;
  });

  test('只有第 5 章走了角色状态与叙事线', () => {
    assert.deepEqual(stepOrder(STATE_MARK), [5]);
    assert.deepEqual(stepOrder(THREAD_MARK), [5]);
  });

  test('第 4 章挂红 ❗，细纲没记指纹', async () => {
    const failures = (await bundle.errorLog.listActiveFailures(project))[CH(4)] ?? [];
    assert.ok(failures.some((f) => f.severity === 'error' && f.op === 'summarize'), JSON.stringify(failures));
    assert.ok(!(await project.readPlot(PLOT(4)))?.sourceHash);
  });

  test('失败的那一次也算钱：2 次更新细纲 + 第 5 章的 2 次', () => {
    assert.equal(used, 4);
  });

  test('收尾提示说出哪一章细纲没更新成', () => {
    assert.ok(h.toasts.some((m) => String(m.message ?? m).includes('第 4 章细纲没更新成')), JSON.stringify(h.toasts));
  });
});
