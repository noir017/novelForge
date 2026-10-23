/**
 * 叙事线里的故事时间（2026-10-24，docs/design/plans/2026-10-24-story-timeline.md）：同步时并进认事件那一次推时间、只填空写进
 * `threads/时间线.md`；叙事线判过、时间线里还没有的章「从正文补推」。真临时工程 + 假模型。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 认事件那一次的提示里带「上一章的时间」，次数不变 | 设计稿：+0 次 |
 * | 时间线按模板新建，一章一行、证据逐字；days 为 null 记 `+?`；模型没给不写 | 设计稿「一」 |
 * | 作者改过的行、依据还在的行，重新判时不动 | 第 28 条：作者写的字机器不动 |
 * | 补记的完成提示说推了几章的时间 | 第 2 条 |
 * | 补推：只推叙事线判过、时间线里没有、正文没再改过的章；几章一批；确认框写明章数与次数 | 设计稿「二」；第 4 条 |
 * | 补推：模型漏了的说出来；一批没成就停，失败挂在时间线文件上，再点一次接着推、清掉失败 | 第 2、16 条 |
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

const TIMELINE = '.novelforge/threads/时间线.md';
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const text = (no) => `# 第${no}章\n\n第${no}章那天的清晨，林昭走进青崖镇。\n\n沈氏翻开名册。\n`;

/** 认事件那一次各章报的时间（缺席 = 不给 time 字段）。 */
const TIMES = {
  1: { days: 0, part: '清晨', evidence: '第1章那天的清晨，林昭走进青崖镇。' },
  2: { days: 2, evidence: '第2章那天的清晨，林昭走进青崖镇。' },
  3: { days: null, reason: '正文没交代' },
};
/** 认事件那一次的提示（按先后）。 */
const findPrompts = [];
/** 补推那几次：送来了哪几章；`broken` 里的章那一批答坏。 */
const batchAsks = [];
let brokenBatch = new Set();
/** 补推时模型漏掉的章。 */
let skipInBatch = new Set();

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('你是小说定稿事实审查员')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    findPrompts.push({ no, user });
    return JSON.stringify({
      events: [],
      newThreads: [],
      newForeshadowing: [],
      ...(TIMES[no] ? { time: TIMES[no] } : {}),
    });
  }
  if (system.includes('你是小说的时间校对员')) {
    const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
    batchAsks.push({ nos, user });
    if (nos.some((no) => brokenBatch.has(no))) {
      return '今天不想判。';
    }
    return JSON.stringify({
      times: nos.filter((no) => !skipInBatch.has(no)).map((no) => ({ chapter: no, days: 1, evidence: `第${no}章那天的清晨，林昭走进青崖镇。` })),
    });
  }
  return '（认不出这一步）';
}

async function writeFinalized(from, to) {
  for (let no = from; no <= to; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = from; no <= to; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
  }
  project.invalidate();
}

const timelineOf = () => bundle.timeline.parseTimelineFile(t.read(TIMELINE), TIMELINE);
const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    timeBackfill: './src/core/features/timelineBackfill.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    timeline: './src/core/model/timelineFile.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'story-timeline', title: '青崖记' });
  project = t.project;
  await writeFinalized(1, 4);
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('同步时推（走补记那一条：同一个认事件）', () => {
  before(async () => {
    fake.calls.length = 0;
    h.expect('开始补记');
    await bundle.backfill.backfillThreads(project);
  });

  test('次数不变：每章只有认事件那 1 次（没有线动过、没有新东西）', () => {
    // 有情节大纲（各章梗概）、一条线都没有：补记先排一次线（这里答不出来，没排成），再逐章认事件。
    assert.equal(findPrompts.length, 4);
    assert.equal(fake.calls.length, 1 + 4);
  });

  test('提示里带「上一章的时间」：第 1 章说 days 写 0，第 2 章是第 1 章那一天', () => {
    assert.ok(findPrompts[0].user.includes('【上一章的时间】\n这是第 1 章：days 写 0。'), findPrompts[0].user);
    assert.ok(findPrompts[1].user.includes('【上一章的时间】\n第 1 章：第 1 天 清晨（故事第 1 天）〔依据：「第1章那天的清晨'), findPrompts[1].user);
  });

  test('时间线按模板新建，一章一行：有依据的、推不出的；模型没给的那一章空着', () => {
    const raw = t.read(TIMELINE);
    assert.match(raw, /^---\ncalendar: 简单历\nstart: \n/);
    assert.ok(raw.includes('- 第 1 章：+0 天，清晨〔依据：「第1章那天的清晨，林昭走进青崖镇。」〕'), raw);
    assert.ok(raw.includes('- 第 2 章：+2 天〔依据：「第2章那天的清晨，林昭走进青崖镇。」〕'), raw);
    assert.ok(raw.includes('- 第 3 章：+?〔推不出：正文没交代〕'), raw);
    const tl = timelineOf();
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1, 2, 3]);
    const days = bundle.timeline.computeTimeline(tl).days;
    assert.deepEqual(days.map((d) => [d.chapter, d.start, d.state]), [
      [1, 1, 'evidence'],
      [2, 3, 'evidence'],
      [3, 3, 'unknown'],
    ]);
  });

  test('完成提示说推了几章的时间', () => {
    assert.ok(h.toasts.at(-1).includes('推了 3 章的故事时间'), h.toasts.at(-1));
  });

  test('重新判（重新同步）时：作者改过的行、依据还在正文里的行不动；作者填了的 +? 也不动', async () => {
    t.write(TIMELINE, t.read(TIMELINE).replace('- 第 3 章：+?〔推不出：正文没交代〕', '- 第 3 章：+5 天〔推不出：正文没交代〕'));
    const before = t.read(TIMELINE);
    const threads = loadBundle({ threads: './src/core/features/threads.ts' }).threads;
    for (const no of [2, 3]) {
      const out = {};
      await threads.recordTime(project, no, { days: 9, evidence: `第${no}章那天的清晨，林昭走进青崖镇。` }, text(no), out);
      assert.equal(out.time.action, 'kept', `第 ${no} 章`);
    }
    assert.equal(t.read(TIMELINE), before);
  });
});

describe('从正文补推（叙事线判过、时间线里没有的章）', () => {
  before(async () => {
    // 第 5–9 章同步过、叙事线也判过（水位推到第 9 章），时间线里没有；第 8 章同步之后正文又改了；第 10 章同步了、叙事线还没判。
    await writeFinalized(5, 10);
    await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 9 });
    t.write(CH(8), `${text(8)}\n又加了一段。\n`);
    project.invalidate();
  });

  test('要推哪几章：判过、没有那一行、正文没改过的（第 4、5、6、7、9 章）；改过的、还没判的各列出来', async () => {
    const plan = await bundle.timeBackfill.planTimelineBackfill(project);
    assert.deepEqual(plan.batches.map((b) => b.map((c) => c.order)), [[4, 5, 6, 7, 9]]);
    assert.deepEqual(plan.stale, [8]);
    assert.deepEqual(plan.unjudged, [10]);
    assert.deepEqual(plan.calls, { low: 1, high: 1, max: 1 });
  });

  test('按字数切批：一批最多 5 章，合计超过上限另起一批', () => {
    const ch = (order, wordCount) => ({ order, wordCount, title: '', relPath: '', contentHash: '' });
    const batches = bundle.timeBackfill.batchTimeChapters([ch(1, 9000), ch(2, 9000), ch(3, 9000), ch(4, 100), ch(5, 100), ch(6, 100), ch(7, 100), ch(8, 100), ch(9, 100)]);
    assert.deepEqual(batches.map((b) => b.map((c) => c.order)), [[1, 2], [3, 4, 5, 6, 7], [8, 9]]);
  });

  test('一批没成：停下，失败挂在时间线文件上（红 ❗），一行都没写', async () => {
    brokenBatch = new Set([4]);
    h.expect('开始补推');
    await bundle.timeBackfill.backfillTimeline(project);
    const c = h.confirms.at(-1);
    assert.match(c.message, /^从正文补推故事时间：第 4–7、9 章同步过、叙事线也判过/);
    assert.ok(c.message.includes('预计 1 次调用'), c.message);
    assert.ok(c.detail.includes('第 8 章同步之后正文又改过'), c.detail);
    assert.ok(c.detail.includes('第 10 章叙事线还没判'), c.detail);
    assert.ok(!('contextDetail' in c.call));
    const [f] = await failuresOf(TIMELINE);
    assert.equal(f?.severity, 'error');
    assert.equal(f.op, 'timelineBackfill');
    assert.ok(h.toasts.at(-1).startsWith('error: '), h.toasts.at(-1));
    assert.ok(!t.read(TIMELINE).includes('第 4 章'));
  });

  test('再点一次：一批推完；送去时带「这一批之前那一章的时间」；模型漏了的说出来；失败清掉', async () => {
    brokenBatch = new Set();
    skipInBatch = new Set([7]);
    batchAsks.length = 0;
    h.expect('开始补推');
    await bundle.timeBackfill.backfillTimeline(project);
    assert.deepEqual(batchAsks.map((a) => a.nos), [[4, 5, 6, 7, 9]]);
    assert.ok(batchAsks[0].user.includes('【这一批之前那一章的时间】\n第 3 章：'), batchAsks[0].user);
    const tl = timelineOf();
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1, 2, 3, 4, 5, 6, 9]);
    // 按章号插在对的位置。
    assert.match(t.read(TIMELINE), /第 3 章：[^\n]*\n- 第 4 章：\+1 天[^\n]*\n- 第 5 章/);
    assert.deepEqual(await failuresOf(TIMELINE), []);
    const toast = h.toasts.at(-1);
    assert.ok(toast.includes('补推故事时间：推了 4 章（第 4–6、9 章）'), toast);
    assert.ok(toast.includes('模型漏了第 7 章'), toast);
    assert.ok(toast.includes('第 10 章叙事线还没判'), toast);
  });
});
