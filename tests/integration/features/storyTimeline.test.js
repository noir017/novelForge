/**
 * 故事时间（2026-10-24，docs/design/plans/2026-10-24-story-timeline.md；同日重做见 2026-10-24-story-timeline-rework.md）：同步时单独
 * 一次认时间、写进 `threads/时间线.md`；同步过、时间线里还没有的章「补推」；机器写的行「重推」。真临时工程 + 假模型。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 同步一章单独一次认时间：输入带历法与起点、前面几章的时间、上一章的结尾、细纲记的时间地点；认事件那一次不再带时间 | 重做「三」：推得不准的根因是看不到上一章停在哪 |
 * | 时间线按模板新建；章内几跳加成历时；正文写明的日子收进〔文中〕；完成提示说时间 | 重做「一」「三」；第 2 条 |
 * | 重新同步：机器写的行照新推的换，作者写的不动（完成提示说「你定的，没改」） | ⚑7；第 28 条 |
 * | 时间那一步没成：叙事线照样记下，黄 ❗ 挂在章节上（op timeline），次数照算；再成了清掉 | 第 16 条 |
 * | 从正文补记叙事线不再推时间 | 作者定的第 4 条 |
 * | 补推：同步过、正文没再改过、时间线里没有（或还推不出）的章，不要求叙事线判过；不连号的断开成两批；带上一章的结尾 | 作者定的第 4 条；第 4 条 |
 * | 补推：一批没成就停，失败挂在时间线文件上，再点一次接着推、清掉失败；模型漏了的说出来 | 第 2、16 条 |
 * | 重推：机器写的行（依据还在也换）照新推的换，作者写的不动；能只推一段；确认框说会换掉几行、几行不动 | 作者定的第 5 条；第 3、4 条 |
 * | 改时间：问一句（预填现在的值、认不出的不放行），写下的就是作者定的；清空删掉那一行；改起点先挑历法再问起点，「填为起点」不问 | 作者定的第 2 条；0 次 |
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
const text = (no) => `# 第${no}章\n\n第${no}章那天的清晨，林昭走进青崖镇。\n\n两日后的夜里，沈氏翻开名册。\n\n第${no}章的末尾，灯灭了。\n`;

const TIME_MARK = '你是小说的时间校对员';
const FIND_MARK = '你是小说定稿事实审查员';

/** 认时间那几次：送来了哪几章、用户消息。 */
const timeAsks = [];
/** 每一章答什么（缺席 = 同一天、有依据）。 */
let timeOf = () => undefined;
/** 这些章所在的那一次答坏。 */
let brokenTime = new Set();
/** 这些章模型漏掉不给。 */
let skipTime = new Set();
/** 认事件那几次的用户消息。 */
const findAsks = [];

function defaultTime(no) {
  return { chapter: no, days: 1, part: '清晨', evidence: `第${no}章那天的清晨，林昭走进青崖镇。`, jumps: [{ days: 2, evidence: '两日后的夜里' }], endPart: '夜里' };
}

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes(FIND_MARK)) {
    findAsks.push(user);
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (system.includes(TIME_MARK)) {
    const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
    timeAsks.push({ nos, user, system });
    if (nos.some((no) => brokenTime.has(no))) {
      return '今天不想判。';
    }
    return JSON.stringify({ times: nos.filter((no) => !skipTime.has(no)).map((no) => timeOf(no) ?? defaultTime(no)) });
  }
  if (system.includes('建立可检索的章节档案')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({ 梗概: `第 ${no} 章。`, 出场人物: [{ name: '林昭', aliases: [] }], 时间地点: '次日清晨，青崖镇。', 关键事件: ['进镇'], 状态变更: '', 连续性事实: [] });
  }
  return '（认不出这一步）';
}

/** 写好第 from–to 章，细纲记上 sourceHash（同步过）。 */
async function writeFinalized(from, to) {
  for (let no = from; no <= to; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = from; no <= to; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n\n## 时间地点\n第 ${no} 章的次日清晨。\n`);
  }
  project.invalidate();
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

const timelineOf = () => bundle.timeline.parseTimelineFile(t.read(TIMELINE), TIMELINE);
const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    finalize: './src/core/features/finalize.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    timeBackfill: './src/core/features/timelineBackfill.ts',
    timeEdit: './src/core/features/timelineEdit.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    timeline: './src/core/model/timelineFile.ts',
    threadsPrompt: './src/core/features/threadsPrompt.ts',
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
  for (let no = 1; no <= 3; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('同步一章：单独一次认时间', () => {
  let outcome;
  before(async () => {
    fake.reset();
    timeAsks.length = 0;
    findAsks.length = 0;
    await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('认事件那一次不再带时间：提示里没有「上一章的时间」，系统提示里没有 time', () => {
    assert.ok(findAsks.length >= 2);
    assert.ok(findAsks.every((u) => !u.includes('上一章的时间')), findAsks[1]);
    assert.ok(!bundle.threadsPrompt.THREAD_FIND_SYSTEM.includes('"time"'));
  });

  test('每章一次认时间；次数算在同步里（细纲 1 + 认事件 1 + 故事时间 1）', () => {
    assert.deepEqual(timeAsks.map((a) => a.nos), [[1], [2]]);
    assert.equal(outcome.calls, 3);
  });

  test('输入：历法与起点、前面几章的时间（带结尾时段）、上一章的结尾、细纲记的时间地点；第 1 章说 days 写 0', () => {
    assert.ok(timeAsks[0].user.includes('【历法与起点】\n简单历（每月 30 天、一年 12 个月）；没填起点，只按天数算。'), timeAsks[0].user);
    assert.ok(timeAsks[0].user.includes('【前面几章的时间】（程序按时间线推算的，帮你接上）\n这是第 1 章：days 写 0。'), timeAsks[0].user);
    const u = timeAsks[1].user;
    assert.ok(u.includes('第 1 章：第 1 天 清晨 → 第 3 天 夜里（故事第 1–3 天）'), u);
    assert.ok(u.includes('【第 1 章的结尾】（上一章最后一段：本章开头接着哪个时刻，看这里）\n'), u);
    assert.ok(u.includes('第1章的末尾，灯灭了。'), u);
    assert.ok(u.includes('（细纲记的时间地点，只当提示，不是正文：次日清晨，青崖镇。）'), u);
    assert.ok(u.includes('请给第 2 章各判一次时间'), u);
  });

  test('时间线按模板新建：章内一跳加成历时、开头与结尾时段；第一章的差值不算', () => {
    const raw = t.read(TIMELINE);
    assert.match(raw, /^---\ncalendar: 简单历\nstart: \n/);
    assert.ok(raw.includes('- 第 2 章：+1 天，清晨 → 夜里，历时 3 天〔依据：「第2章那天的清晨，林昭走进青崖镇。」〕'), raw);
    const days = bundle.timeline.computeTimeline(timelineOf()).days;
    assert.deepEqual(days.map((d) => [d.chapter, d.start, d.end]), [
      [1, 1, 3],
      [2, 4, 6],
    ]);
  });

  test('完成提示说时间', () => {
    assert.ok(bundle.finalize.describeFinalize(2, outcome).includes('时间：+1 天，历时 3 天（依据「第2章那天的清晨，林昭走进青崖镇。」）'), bundle.finalize.describeFinalize(2, outcome));
  });

  test('重新同步：机器写的行照新推的换（依据还在也换）；作者写的不动，完成提示说「你定的」', async () => {
    timeOf = (no) => (no === 2 ? { chapter: 2, days: 5, evidence: '两日后的夜里' } : undefined);
    await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    assert.ok(t.read(TIMELINE).includes('- 第 2 章：+5 天〔依据：「两日后的夜里」〕'), t.read(TIMELINE));
    t.write(TIMELINE, t.read(TIMELINE).replace('- 第 2 章：+5 天〔依据：「两日后的夜里」〕', '- 第 2 章：三月十四'));
    const before = t.read(TIMELINE);
    const again = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    assert.equal(t.read(TIMELINE), before);
    assert.ok(bundle.finalize.describeFinalize(2, again).includes('时间线里这一章是你定的，没改'), bundle.finalize.describeFinalize(2, again));
    timeOf = () => undefined;
  });

  test('正文写明的日子收进〔文中〕，证据里没写着的不收', async () => {
    timeOf = (no) =>
      no === 3
        ? { chapter: 3, days: 0, evidence: '第3章那天的清晨，林昭走进青崖镇。', date: { date: '三月初九', evidence: '第3章那天的清晨，林昭走进青崖镇。' } }
        : undefined;
    const o = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.equal(o.time.entry.dateMark, undefined);
    timeOf = () => undefined;
  });

  test('时间那一步没成：叙事线照样记下，黄 ❗ 挂在章节上（op timeline），次数照算；再成了清掉', async () => {
    brokenTime = new Set([3]);
    const failed = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.match(failed.timeError, /解析不出来/);
    assert.equal(failed.threadsError, undefined);
    assert.equal(failed.calls, 3);
    const [f] = await failuresOf(CH(3));
    assert.equal(f?.op, 'timeline');
    assert.equal(f.severity, 'warn');
    assert.ok(bundle.finalize.describeFinalize(3, failed).includes('故事时间没推成'));
    brokenTime = new Set();
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(CH(3)), []);
  });
});

describe('从正文补记叙事线不再推时间', () => {
  test('补记逐章认事件，一次认时间都不调', async () => {
    await writeFinalized(4, 5);
    timeAsks.length = 0;
    h.expect('开始补记');
    await bundle.backfill.backfillThreads(project);
    assert.equal(timeAsks.length, 0);
    assert.ok(!(h.toasts.at(-1) ?? '').includes('故事时间'), h.toasts.at(-1));
  });
});

describe('补推：同步过、时间线里没有（或还推不出）的章', () => {
  before(async () => {
    // 第 6–9 章同步过，叙事线一章都没判（补推不再要求判过）；第 8 章同步之后正文又改了；第 5 章是机器写的 +?。
    await writeFinalized(6, 9);
    t.write(CH(8), `${text(8)}\n又加了一段。\n`);
    const raw = t.read(TIMELINE).replace(/- 第 5 章：[^\n]*\n/u, '');
    t.write(TIMELINE, `${raw.trimEnd()}\n- 第 5 章：+?〔推不出：没说〕\n`);
    project.invalidate();
  });

  test('要推哪几章：没有的、机器写的 +?；改过的列出来；不连号的断开成两批', async () => {
    const plan = await bundle.timeBackfill.planTimeline(project, 'fill');
    // 第 4 章那一行补记时没推（补记不推时间了）。
    assert.deepEqual(plan.batches.map((b) => b.map((c) => c.order)), [[4, 5, 6, 7], [9]]);
    assert.deepEqual(plan.stale, [8]);
    assert.deepEqual(plan.calls, { low: 2, high: 2, max: 2 });
  });

  test('按字数切批：一批最多 5 章，合计超过上限另起一批', () => {
    const ch = (order, wordCount) => ({ order, wordCount, title: '', relPath: '', contentHash: '' });
    const batches = bundle.timeBackfill.batchTimeChapters([ch(1, 9000), ch(2, 9000), ch(3, 9000), ch(4, 100), ch(5, 100), ch(6, 100), ch(7, 100), ch(8, 100), ch(9, 100)]);
    assert.deepEqual(batches.map((b) => b.map((c) => c.order)), [[1, 2], [3, 4, 5, 6, 7], [8, 9]]);
  });

  test('一批没成：停下，失败挂在时间线文件上（红 ❗），这一批一行都没写', async () => {
    brokenTime = new Set([4]);
    h.expect('开始补推');
    await bundle.timeBackfill.backfillTimeline(project);
    const c = h.confirms.at(-1);
    assert.match(c.message, /^从正文补推故事时间：第 4–7、9 章同步过/);
    assert.ok(c.message.includes('预计 2 次调用'), c.message);
    assert.ok(c.detail.includes('第 8 章同步之后正文又改过'), c.detail);
    assert.ok(!('contextDetail' in c.call));
    const [f] = await failuresOf(TIMELINE);
    assert.equal(f?.severity, 'error');
    assert.equal(f.op, 'timelineBackfill');
    assert.ok(!t.read(TIMELINE).includes('第 4 章'));
  });

  test('再点一次：推完；第一批带上一章（第 3 章）的结尾；模型漏了的说出来；失败清掉', async () => {
    brokenTime = new Set();
    skipTime = new Set([7]);
    timeAsks.length = 0;
    h.expect('开始补推');
    await bundle.timeBackfill.backfillTimeline(project);
    assert.deepEqual(timeAsks.map((a) => a.nos), [[4, 5, 6, 7], [9]]);
    assert.ok(timeAsks[0].user.includes('【第 3 章的结尾】'), timeAsks[0].user);
    assert.ok(timeAsks[0].user.includes('请给第 4、5、6、7 章各判一次时间'), timeAsks[0].user);
    const tl = timelineOf();
    assert.deepEqual(tl.entries.map((e) => e.chapter).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 9]);
    assert.match(t.read(TIMELINE), /- 第 4 章：\+1 天[^\n]*\n- 第 5 章：\+1 天/);
    assert.deepEqual(await failuresOf(TIMELINE), []);
    const toast = h.toasts.at(-1);
    assert.ok(toast.includes('补推故事时间：推了 4 章（第 4–6、9 章）'), toast);
    assert.ok(toast.includes('模型漏了第 7 章'), toast);
    skipTime = new Set();
  });
});

describe('重推：机器写的行照新推的换', () => {
  test('只推一段：确认框说会换掉几行、你定的几行不动；作者写的不动，依据还在的机器行也换', async () => {
    timeOf = (no) => ({ chapter: no, days: 7, evidence: '两日后的夜里' });
    timeAsks.length = 0;
    h.expect('开始重推');
    await bundle.timeBackfill.refreshTimeline(project, { from: 1, to: 4 });
    const c = h.confirms.at(-1);
    assert.match(c.message, /^重推故事时间：第 1、3–4 章/);
    assert.ok(c.detail.includes('会换掉 3 行机器写的'), c.detail);
    assert.ok(c.detail.includes('第 2 章是你定的，一个字不动'), c.detail);
    const raw = t.read(TIMELINE);
    assert.ok(raw.includes('- 第 2 章：三月十四'), raw);
    for (const no of [3, 4]) {
      assert.ok(raw.includes(`- 第 ${no} 章：+7 天〔依据：「两日后的夜里」〕`), raw);
    }
    // 不连号（第 2 章是你定的）：第 1 章单独一批，第 3–4 章一批。
    assert.deepEqual(timeAsks.map((a) => a.nos), [[1], [3, 4]]);
    assert.ok(h.toasts.at(-1).includes('第 2 章是你定的，没动'), h.toasts.at(-1));
    timeOf = () => undefined;
  });

  test('一段里全是你定的：不调模型，说清为什么', async () => {
    fake.reset();
    await bundle.timeBackfill.refreshTimeline(project, { from: 2, to: 2 });
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.at(-1).includes('第 2 章没有可以重推时间的章：第 2 章是你定的（机器不动）'), h.toasts.at(-1));
  });
});

// 真实模型试跑之后补的（2026-10-24）：正文里写着「第二十二回」，模型照它填了 chapter 22。
describe('模型报的章号对不上：按先后认作送去的那一章', () => {
  test('单章同步：报成别的章号也写进这一章', async () => {
    timeOf = (no) => ({ ...defaultTime(no), chapter: 22, days: 4 });
    const o = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.equal(o.time.missing, undefined);
    assert.ok(t.read(TIMELINE).includes('- 第 1 章：+4 天'), t.read(TIMELINE));
    timeOf = () => undefined;
  });
});

describe('作者在界面上改：改时间、改历法与起点（0 次）', () => {
  test('改时间：预填现在的值、校验写法；写下的去掉行尾那一段，之后重推不动它', async () => {
    fake.reset();
    const before = timelineOf().entries.find((e) => e.chapter === 3);
    assert.ok(bundle.timeline.isMachineEntry(before));
    h.expect('+6 天，傍晚');
    await bundle.timeEdit.editTimelineEntry(project, 3);
    const ask = h.inputs.at(-1);
    assert.equal(ask.title, '第 3 章的时间');
    assert.equal(ask.value, bundle.timeline.renderTimeValue(before.value) + (before.part ? `，${before.part}` : ''));
    assert.match(ask.validate('过了好一阵'), /^认不出/);
    assert.equal(ask.validate('第 20 天'), undefined);
    const after = timelineOf().entries.find((e) => e.chapter === 3);
    assert.deepEqual(after.value, { kind: 'delta', days: 6 });
    assert.equal(after.part, '傍晚');
    assert.equal(after.basis, undefined);
    assert.ok(h.toasts.at(-1).includes('这一行是你定的'), h.toasts.at(-1));
    assert.equal(fake.callCount(), 0);
    // 重推第 3 章：你定的，不动。
    h.expect();
    await bundle.timeBackfill.refreshTimeline(project, { from: 3, to: 3 });
    assert.equal(fake.callCount(), 0);
    assert.deepEqual(timelineOf().entries.find((e) => e.chapter === 3).value, { kind: 'delta', days: 6 });
  });

  test('改时间：清空就是删掉那一行；取消（没答）什么都不动', async () => {
    const before = t.read(TIMELINE);
    h.expect(undefined);
    await bundle.timeEdit.editTimelineEntry(project, 3);
    assert.equal(t.read(TIMELINE), before);
    h.expect('');
    await bundle.timeEdit.editTimelineEntry(project, 3);
    assert.ok(!timelineOf().entries.some((e) => e.chapter === 3));
    assert.ok(h.toasts.at(-1).includes('删掉了'), h.toasts.at(-1));
  });

  test('改历法与起点：先挑历法、再问起点（校验写法）；「填为起点」直接填、不问', async () => {
    h.expect('公历', '2026-03-07');
    await bundle.timeEdit.setTimelineStart(project);
    assert.deepEqual(h.picks.at(-1).choices.map((c) => c.value), ['简单历', '公历']);
    assert.match(h.inputs.at(-1).validate('很久以前'), /^认不出/);
    let tl = timelineOf();
    assert.equal(tl.calendar, '公历');
    assert.equal(tl.startText, '2026-03-07');
    h.expect();
    await bundle.timeEdit.setTimelineStart(project, '2026-03-05');
    assert.equal(h.inputs.length + h.picks.length, 0);
    tl = timelineOf();
    assert.equal(tl.calendar, '公历');
    assert.equal(tl.startText, '2026-03-05');
  });
});
