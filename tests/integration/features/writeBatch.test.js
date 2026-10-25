/**
 * 批量写章（四期，D10）：严格串行地一章一章写，续写链与对话页同一份。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 确认框报区间、模式与上限，弹窗确认过的不再问 | 第 4 条；W9 不叠弹窗 |
 * | 已有正文的跳过，第一章没细纲的在它前面收住 | 第 19 条批量那一面；后一章要接着前一章写 |
 * | 写完即定稿：写一章、定稿一章（拿细纲与正文对照，把细纲改成正文写成的样子），再写下一章 | D17：自动定稿只在这里 |
 * | 一章写不出来就停，后面的不写 | 失败即停：后面的章接不上 |
 * | 重演、没写够：写进去然后停，挂黄 ❗ | 钱已经花了（D6），但不能踩着有问题的结尾往下写 |
 * | 后面几章才登场的人提前写进来：同上 | 五期补遗 §1.2：下一章要从他第一次露面写起 |
 * | 写完这一章就停 / 停止 | 只在章与章之间停；停止时正在写的那一章不落盘 |
 * | 一章之内续写那几轮不换模型 | 一章写到一半换人，文风断在段落中间 |
 * | 完成提示带「打开第 N 章」 | D24 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let settings;
/** 这一次该答什么。按用例换。 */
let replyFn;
const finished = [];

const pad3 = (n) => String(n).padStart(3, '0');
const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;

/**
 * 按执行卡里重列的必需事件认是第几章在写（续写那几轮另有契约）。每章的关键事件都以
 * 「第 N 章」开头（{@link planSections} 与拆细纲的假应答），执行卡只剩这一项能认章。
 */
function chapterOf(messages) {
  const user = messages[messages.length - 1].content;
  if (user.includes('请无缝续写当前章节正文')) {
    return { continuation: true };
  }
  const m = /- 必需事件：第 (\d+) 章/.exec(user);
  return m ? { no: Number(m[1]) } : {};
}

/**
 * 写正文之前排好的一份细纲（计划）：梗概、计划出场、关键事件、看点（章末钩子并进了看点）；
 * 连续性事实是空的——定稿时才从正文里摘。
 */
function planSections(no, { cast = '林昭', events = `第 ${no} 章林昭查到一点东西。` } = {}) {
  return {
    ...bundle.plotFile.emptyPlotSections(),
    梗概: `第 ${no} 章的目的`,
    出场人物: cast,
    关键事件: events,
    看点: `第 ${no} 章结尾：又一个人不见了。`,
  };
}

/** 磁盘上第 N 章的细纲。有 `sourceHash` = 定稿过（细纲照正文反向更新过）。 */
function plotOf(t, no) {
  return bundle.plotFile.parsePlotFile(t.read(PLOT(no)), PLOT(no));
}

/** 定稿那一次（照正文更新细纲）。有细纲时系统提示是 REFINE_SYSTEM，它以 SUMMARY_SYSTEM 开头，同一句都认得出。 */
function isSummary(messages) {
  return (messages[0]?.content ?? '').includes('建立可检索的章节档案');
}
function isState(messages) {
  return (messages[0]?.content ?? '').includes('依据本章正文更新角色的「当前状态」');
}
function isReview(messages) {
  return (messages[0]?.content ?? '').includes('严谨的小说审稿编辑');
}
/** 定稿第三步认叙事线（叙事线重做：每次定稿都跑，线是空的也跑）。 */
function isFind(messages) {
  return (messages[0]?.content ?? '').includes('你是小说定稿事实审查员');
}
const NOTHING_FOUND = JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
/** 定稿最后一步认故事时间（2026-10-24 重做：单独一次）。 */
function isTime(messages) {
  return (messages[0]?.content ?? '').includes(TIME_MARK);
}

/** 缺省的应答：正文一次写够，定稿（照正文更新细纲）与状态各给一份，叙事线什么都认不出。 */
function defaultReply(messages) {
  if (isFind(messages)) {
    return NOTHING_FOUND;
  }
  if (isTime(messages)) {
    return timeReply(messages);
  }
  if (isSummary(messages)) {
    const no = Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
    return JSON.stringify({
      梗概: `第 ${no} 章的事。`,
      出场人物: [{ name: '林昭', aliases: [] }],
      关键事件: [],
      连续性事实: [],
    });
  }
  if (isState(messages)) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '往北去了' }] });
  }
  const { no, continuation } = chapterOf(messages);
  if (continuation) {
    return { text: filler(400, 900), stop: 'end' };
  }
  return { text: filler(700, no * 100), stop: 'end' };
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    summarize: './src/core/features/summarize.ts',
    plotFile: './src/core/model/plotFile.ts',
    progress: './src/core/runtime/progress.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    behavior: { 'p/broken': 'fail' },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  bundle.progress.onTaskFinished((t) => finished.push(t));
});

/** 一个排好前 5 章细纲的新工程。`written` 里的章先写好正文，`blank` 里的章只有骨架。 */
async function fresh(prefix, { written = [], blank = [] } = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'broken', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 4,
  };
  const t = await makeTempProject(bundle.project, { prefix, title: '批量写章' });
  t.write('.novelforge/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  const ws = new bundle.ws.Workspace(t.project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: blank.includes(no) ? bundle.plotFile.emptyPlotSections() : planSections(no),
    });
  }
  for (const no of written) {
    t.write(CH(no), `# ${TITLES[no - 1]}\n\n作者自己写的第 ${no} 章。\n`);
  }
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿\n\n## 当前状态\n\n（待补充）\n');
  t.project.invalidate();
  fake.reset();
  h.toasts.length = 0;
  h.confirms.length = 0;
  h.answers.length = 0;
  finished.length = 0;
  replyFn = defaultReply;
  return t;
}

async function failuresOf(t, key) {
  return (await bundle.errorLog.listActiveFailures(t.project))[key] ?? [];
}

describe('只写正文：下一可写章起 3 章', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-draft');
    h.expect('开始写章');
    calls = await bundle.batch.writeManuscripts(t.project);
  });
  after(() => cleanup(t.dir, bundle.db));

  // 写前比对 2026-10-25 起多一次转写：比对 1 次、转写 1 次、重转 1 次。
  test('确认框报区间、模式与上限（一章最多 9 次，写前比对最多 3 次）', () => {
    const c = h.confirms[0];
    assert.equal(c.message, '第 1–3 章：要写 3 章正文（只写正文），预计 3–12 次调用，最多 36 次。现在写？');
    assert.match(c.detail, /一章一章串行写/);
  });

  // 写前比对要转写：没有要拆的细纲、没开审稿也单列转写交给谁（不跟这一次挑的模型）。
  test('确认框单列转写交给谁', () => {
    const c = h.confirms[0];
    assert.ok(c.call.fixed?.some((x) => x.startsWith('转写') && x.includes('不跟这一次挑的模型')), JSON.stringify(c.call));
  });

  test('写了 3 章，一章一次，不看并发设置', () => {
    assert.equal(calls, 3);
    assert.deepEqual(fake.calls.map((m) => chapterOf(m).no), [1, 2, 3]);
    // 正文是 .txt（2026-10-24）：纯文本，不写标题行。
    for (const no of [1, 2, 3]) {
      assert.ok(t.has(CH(no)) && !t.read(CH(no)).startsWith('#'), CH(no));
    }
    assert.ok(!t.has(CH(4)));
  });

  // 后一章接着前一章写：第 2 章装配的时候，第 1 章已经落盘了。
  test('后一章的装配里有前一章的结尾', () => {
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(user.includes('上一章结尾原文') || user.includes('前文正文'), user.slice(0, 300));
    assert.ok(user.includes(filler(700, 100).slice(-40)));
  });

  test('细纲上记了 writtenFrom', () => {
    assert.ok(plotOf(t, 1).writtenFrom);
  });

  // 细纲与定稿是同一份文件：没定稿 = 文件还在、只是没有 sourceHash。
  test('只写正文不定稿：细纲上没有 sourceHash', () => {
    assert.equal(plotOf(t, 1).sourceHash, '');
  });

  test('完成提示带「打开第 3 章」', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.equal(f.message, '第 1–3 章已写好（调用 3 次）。');
    assert.deepEqual(f.open, { plotRelPath: PLOT(3), label: '打开第 3 章' });
  });
});

describe('写完即定稿；已有正文的跳过；弹窗确认过的不再问', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-finalize', { written: [2] });
    calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('不弹确认框', () => {
    assert.equal(h.confirms.length, 0);
  });

  test('写一章、定稿一章（更新细纲 + 角色状态 + 认叙事线 + 故事时间），再写下一章；第 2 章跳过', () => {
    const order = fake.calls.map((m) => (isSummary(m) ? 'summary' : isState(m) ? 'state' : isFind(m) ? 'threads' : isTime(m) ? 'time' : `write:${chapterOf(m).no}`));
    assert.deepEqual(order, ['write:1', 'summary', 'state', 'threads', 'time', 'write:3', 'summary', 'state', 'threads', 'time']);
    assert.equal(calls, 10);
  });

  test('作者写的第 2 章一个字没动', () => {
    assert.equal(t.read(CH(2)), '# 令牌\n\n作者自己写的第 2 章。\n');
  });

  // 手上有细纲（写之前排的计划）：定稿是拿它和正文对照着改，不是照正文从头整理。
  test('定稿带上当前细纲：系统提示是 REFINE_SYSTEM', () => {
    assert.ok(fake.calls.filter(isSummary).every((m) => m[0].content.includes('关于「当前细纲」')));
  });

  // 定稿是把细纲照正文反向更新：sourceHash 记的是正文那时的指纹。
  test('两章都定了稿：细纲的 sourceHash 对得上正文', async () => {
    t.project.invalidate();
    for (const no of [1, 3]) {
      assert.equal(plotOf(t, no).sourceHash, (await t.project.getChapter(no)).contentHash, `第 ${no} 章`);
    }
  });

  test('角色状态更新到第 3 章', () => {
    assert.match(t.read('.novelforge/characters/林昭.md'), /stateThrough: 3/);
  });

  test('完成提示说定稿了几章', () => {
    assert.match(finished.find((x) => x.title === '批量写章').message, /同步 2 章/);
  });
});

describe('第一章没细纲的在它前面收住', () => {
  let t;
  before(async () => {
    // 第 3–5 章是空骨架、连梗概都没有：情节大纲（各章细纲梗概的汇总）只覆盖到第 2 章。
    t = await fresh('wb-noplot', { blank: [3, 4, 5] });
    h.expect('开始写章');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 5 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('没有情节大纲：写到第 2 章为止，确认框里说了为什么', () => {
    assert.match(h.confirms[0].message, /^第 1–2 章：要写 2 章正文/);
    assert.match(h.confirms[0].detail, /第 3 章还没有细纲、情节大纲也没覆盖到它，写到它前面为止/);
    assert.ok(t.has(CH(2)) && !t.has(CH(3)) && !t.has(CH(4)));
  });
});

describe('一章写不出来就停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-fail');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        throw new Error('假装服务商 500');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写好了，第 2、3 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)) && !t.has(CH(3)));
  });

  test('红 ❗ 挂在第 2 章的细纲上', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'error');
    assert.match(f.message, /假装服务商 500/);
  });

  test('提示说清停在哪、后面还有几章', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.equal(f.level, 'error');
    assert.match(f.message, /第 1 章已写好。第 2 章没写成（假装服务商 500），批量停在这里。后面的第 3 章没写。/);
  });
});

describe('重演：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-replay');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const ch1 = t.read(CH(1)).trim();
        return { text: `${ch1.slice(-200)}\n\n${filler(700, 555)}`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章写进去了、没定稿；第 3 章没写', () => {
    assert.ok(t.has(CH(2)));
    assert.equal(plotOf(t, 2).sourceHash, '');
    assert.ok(!t.has(CH(3)));
  });

  test('黄 ❗ 挂在第 2 章上，写明原因', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /开头与上一章结尾大段重合/);
  });

  test('提示的按钮打开的是停下的那一章', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /第 2 章写进去了，但开头与上一章结尾大段重合/);
    assert.deepEqual(f.open, { plotRelPath: PLOT(2), label: '打开第 2 章' });
  });
});

describe('后面几章才登场的人提前写了进来：写进去，然后停（五期补遗 §1.2）', () => {
  let t;
  before(async () => {
    t = await fresh('wb-early');
    // 第 3 章才排沈秋；第 2 章的结尾把他写了出来。
    const ws = new bundle.ws.Workspace(t.project);
    await ws.writePlot({
      no: 3,
      title: TITLES[2],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: planSections(3, { cast: '林昭、沈秋', events: '第 3 章林昭遇见沈秋。' }),
    });
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        return { text: `${filler(700, 556)}\n\n巷口站着一个人，是沈秋。`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章写进去了、没定稿；第 3 章没写', () => {
    assert.ok(t.has(CH(2)));
    assert.equal(plotOf(t, 2).sourceHash, '');
    assert.ok(!t.has(CH(3)));
  });

  test('黄 ❗ 挂在第 2 章上，写明是谁', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /第 3 章才登场的沈秋提前写进了这一章/);
  });

  test('写第 2 章时执行卡后面就点了名', () => {
    const asked = fake.calls.map((c) => c[c.length - 1].content).find((u) => /- 必需事件：第 2 章/.test(u));
    assert.match(asked, /本章不出场：沈秋（第 3 章才登场）/);
  });
});

describe('续写到最后仍不到八成：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-short');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      return { text: filler(100, chapterOf(messages).continuation ? 7 : 8), stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写了（续写过一轮），第 2 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.equal(fake.callCount(), 2);
  });

  test('黄 ❗：不到目标的八成', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /不到目标的八成/);
  });
});

describe('结尾停在半句上、续写也没接完：写进去，然后停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-half');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      // 第一次字数够了、停在半句上；续写那两轮都只多几个字。
      return chapterOf(messages).continuation ? { text: '的骨头', stop: 'end' } : { text: `${filler(700, 9).slice(0, -1)}，全身`, stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章写了、没定稿，第 2 章没写', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.equal(plotOf(t, 1).sourceHash, '');
  });

  test('黄 ❗：结尾停在半句上', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /结尾停在半句上/);
  });
});

// ---------------------------------------------------------------- 边写边拆细纲、写前冲突检查（百章实验复盘）

const OUTLINE = outlineOf(10, { text: { 1: '林昭回镇查案。' } });

/** 按契约里写的区间应答一批细纲（新合同：七节里除连续性事实之外的字段）。 */
function blueprintsFor(messages) {
  const user = messages[messages.length - 1].content;
  const m = /写第 (\d+)(?:–(\d+))? 章的细纲：/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const blueprints = [];
  for (let no = from; no <= to; no++) {
    blueprints.push({
      chapterNumber: no,
      title: TITLES[no - 1] ?? `第${no}章`,
      synopsis: `第 ${no} 章的目的`,
      characters: ['林昭'],
      timePlace: '',
      keyEvents: [`第 ${no} 章林昭又查到一点东西。`],
      highlights: [`第 ${no} 章结尾：又一个人不见了。`],
      foreshadowing: [],
      stateChange: '',
    });
  }
  return JSON.stringify({ blueprints });
}
const isBlueprint = (messages) => /写第 \d+(?:–\d+)? 章的细纲：/.test(messages[messages.length - 1].content);
const isPlotCheck = (messages) => (messages[0]?.content ?? '').includes('你是长篇小说的连续性编辑');
const isEvents = isFind;
const isThreads = (messages) => (messages[0]?.content ?? '').includes('只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线');

/** 每章正文带一句可查证的事实；定稿把它记成细纲里的连续性事实。 */
function factfulReply(conflicts = () => []) {
  return (messages) => {
    if (isBlueprint(messages)) {
      return blueprintsFor(messages);
    }
    if (isPlotCheck(messages)) {
      return JSON.stringify({ conflicts: conflicts(messages) });
    }
    if (isEvents(messages)) {
      return NOTHING_FOUND;
    }
    if (isTime(messages)) {
      return timeReply(messages);
    }
    if (isSummary(messages)) {
      const no = Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
      return JSON.stringify({ 梗概: '事。', 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [], 连续性事实: [`林昭在第${no}章丢了第${no}块玉佩`] });
    }
    const { no, continuation } = chapterOf(messages);
    if (!isState(messages) && !continuation && no) {
      return { text: `林昭在第${no}章丢了第${no}块玉佩。\n\n${filler(700, no * 100)}`, stop: 'end' };
    }
    return defaultReply(messages);
  };
}

describe('边写边拆细纲：大纲覆盖之内没细纲的章，写到时先拆这一批', () => {
  let t;
  let order;
  let blueprintPrompt;
  before(async () => {
    t = await fresh('wb-rolling', { blank: [3, 4, 5] });
    writeOutline(t, OUTLINE);
    t.project.invalidate();
    replyFn = factfulReply();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 4 }, mode: 'finalize', call: {} });
    order = fake.calls.map((m) =>
      isBlueprint(m) ? 'plots' : isThreads(m) ? 'threads' : isEvents(m) ? 'events' : isTime(m) ? 'time' : isPlotCheck(m) ? 'check' : isSummary(m) ? 'summary' : isState(m) ? 'state' : `write:${chapterOf(m).no}`
    );
    blueprintPrompt = fake.calls.find(isBlueprint)?.at(-1).content ?? '';
  });
  after(() => cleanup(t.dir, bundle.db));

  // 叙事线重做：拆完不再排线（计划随细纲写进线里）；定稿每次都认一遍叙事线（线是空的也认）、推一次故事时间。
  test('写完第 2 章、定稿之后才拆第 3–4 章（只拆这次要写的），拆完不排叙事线；第 1 章前面没定稿的章，不比对', () => {
    assert.deepEqual(order, [
      'write:1', 'summary', 'state', 'events', 'time',
      'check', 'write:2', 'summary', 'state', 'events', 'time',
      'plots', 'check', 'write:3', 'summary', 'state', 'events', 'time',
      'check', 'write:4', 'summary', 'state', 'events', 'time',
    ]);
    // 一条线都没排：叙事线目录里只有同步时推出来的时间线。
    assert.ok(!t.has('.novelforge/threads/未归属的伏笔.md'));
    assert.ok(t.has('.novelforge/threads/时间线.md'));
  });

  test('拆细纲的时候看得见前面定稿的连续性事实', () => {
    assert.ok(blueprintPrompt.includes('林昭在第2章丢了第2块玉佩'), blueprintPrompt.slice(0, 1500));
    assert.ok(blueprintPrompt.includes('既成历史'));
  });

  test('第 3、4 章的正文写了；区间外的第 5 章没写', () => {
    assert.ok(t.has(CH(3)) && t.has(CH(4)) && !t.has(CH(5)));
  });

  // 第 4 章写完即定稿，细纲已经照正文反向更新过了；拆出来的那一版要在写它的那次调用里找。
  test('第 4 章照刚拆出来的细纲写：执行卡重列的是拆出来的关键事件', () => {
    const users = fake.calls.map((c) => c[c.length - 1].content);
    assert.ok(users.some((u) => u.includes('- 必需事件：第 4 章林昭又查到一点东西。')));
  });

  test('区间外的第 5 章细纲不动：仍是空的', () => {
    assert.equal(plotOf(t, 5).sections.关键事件, '');
  });
});

// 百章实验里全文大纲从没生成过：它只有「重建」一个入口。批量定稿每落后 10 章增量更新一次。
describe('全文大纲增量更新', () => {
  let t;
  const users = [];
  const runner = {
    primaryBudget: { contextWindow: 100000, maxOutputTokens: 2000 },
    run: (_what, fn) =>
      fn({
        stream: async function* (messages) {
          users.push(messages[messages.length - 1].content);
          yield { type: 'text', text: `## 主线进展\n\n第 ${users.length} 版：林昭一路丢玉佩。` };
        },
      }),
  };
  before(async () => {
    t = await fresh('wb-global');
    replyFn = factfulReply();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  // 全文大纲的输入是定稿过的细纲（单章摘要那一份已经并进细纲了）。
  test('还没有全文大纲：从第 1 章起汇总定稿过的细纲，through 记到最后一章', async () => {
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 2 });
    assert.match(users[0], /第 1–2 章定稿过的逐章细纲/);
    assert.match(t.read('.novelforge/summaries/global.md'), /through: 2[\s\S]*第 1 版：林昭一路丢玉佩/);
  });

  test('之后只并入新定稿的章，旧的全文大纲一起带上；没有新章就零调用', async () => {
    t.project.invalidate();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 }, mode: 'finalize', call: {} });
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 3 });
    assert.match(users[1], /截至第 2 章/);
    assert.match(users[1], /第 1 版：林昭一路丢玉佩/);
    assert.match(users[1], /【第3章/);
    assert.doesNotMatch(users[1], /【第2章/);
    const again = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.equal(again.calls, 0);
  });

  // 全文大纲（原全书摘要）只剩「主线进展」：老文件里另外三节当认不出的小节，留在文件里、不交给模型，下一版只写主线。
  test('老格式（全书摘要四节）：另外三节不读、不交给模型，文件里还在', async () => {
    const old = t.read('.novelforge/summaries/global.md').replace(
      /\n*$/,
      '\n\n## 已收伏笔\n\n- 玉佩之谜（第 1 章）\n\n## 未收伏笔\n\n- 断剑之谜\n\n## 人物关系变动\n\n- 林昭与沈青结盟\n'
    );
    t.write('.novelforge/summaries/global.md', old);
    t.project.invalidate();
    const read = await t.project.readGlobalSummary();
    assert.match(read, /## 主线进展[\s\S]*第 2 版：林昭一路丢玉佩/);
    assert.doesNotMatch(read, /已收伏笔|断剑之谜|人物关系变动|林昭与沈青结盟/);
    assert.match(t.read('.novelforge/summaries/global.md'), /## 未收伏笔\n\n- 断剑之谜/);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 4, to: 4 }, mode: 'finalize', call: {} });
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 4 });
    assert.match(users[2], /第 2 版：林昭一路丢玉佩/);
    assert.doesNotMatch(users[2], /断剑之谜|林昭与沈青结盟/);
  });

  test('模板与写回的文件：H1 是「全文大纲」，只有「主线进展」一节', () => {
    const text = t.read('.novelforge/summaries/global.md');
    assert.match(text, /\n# 全文大纲\n\n## 主线进展\n/);
    assert.doesNotMatch(text, /未收伏笔|人物关系变动/);
  });
});

describe('写前冲突检查：细纲与前面定稿的事实对不上，停在那一章前面', () => {
  test('对得上原文的冲突：停下、挂黄 ❗，说清是哪两句', async () => {
    const t = await fresh('wb-plotcheck');
    replyFn = factfulReply(() => [
      { plot: '第 2 章林昭查到一点东西', fact: '林昭在第1章丢了第1块玉佩', chapter: 1, why: '玉佩已经丢了' },
      { plot: '细纲里没有这句', fact: '林昭在第1章丢了第1块玉佩', chapter: 1, why: '编的' },
    ]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const f = finished.find((x) => x.title === '批量写章');
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(f.message, /第 2 章的细纲与前面同步下来的事实有 1 处对不上/, f.message);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(
      fails.some((x) => x.op === 'plotCheck' && /细纲「第 2 章林昭查到一点东西」与第 1 章同步下来的事实「林昭在第1章丢了第1块玉佩」矛盾：玉佩已经丢了/.test(x.message)),
      JSON.stringify(fails)
    );
    assert.match(fails[0].detail, /factCheckOk: true/);
    cleanup(t.dir, bundle.db);
  });

  test('细纲上记了 factCheckOk：不比对，照写', async () => {
    const t = await fresh('wb-plotcheck-ok');
    t.write(PLOT(2), t.read(PLOT(2)).replace('targetWords: 600', 'targetWords: 600\nfactCheckOk: true'));
    t.project.invalidate();
    replyFn = factfulReply(() => [{ plot: '第 2 章林昭查到一点东西', fact: '林昭在第1章丢了第1块玉佩', chapter: 1, why: '玉佩已经丢了' }]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(t.has(CH(2)));
    assert.ok(!fake.calls.some(isPlotCheck));
    cleanup(t.dir, bundle.db);
  });
});

// 2026-10-25 起改成转写：比对的模型按格式写（两句原句用「」括起来），转写模型照抄成 JSON；只写「无矛盾」的不转。
const isTranscribe = (messages) => (messages[0]?.content ?? '').includes('格式转写员');

describe('写前冲突检查 · 按格式写，转写模型照抄成 JSON', () => {
  const PROSE = ['### 矛盾 1', '细纲：「第 2 章林昭查到一点东西」', '事实：「林昭在第1章丢了第1块玉佩」（第 1 章）', '为什么：玉佩已经丢了'].join('\n');
  const conflict = (plot) => JSON.stringify({ conflicts: [{ plot, fact: '林昭在第1章丢了第1块玉佩', chapter: 1, why: '玉佩已经丢了' }] });
  const COPIED = conflict('第 2 章林昭查到一点东西');

  /** 比对的那一次答 `check`，转写那几次按顺序答 `copies`（答完了再来就是测试写错了）。 */
  function proseReply(check, copies = []) {
    const base = factfulReply();
    const queue = [...copies];
    return (messages) => {
      if (isTranscribe(messages)) return queue.shift() ?? '（转写不该再被调用）';
      if (isPlotCheck(messages)) return check;
      return base(messages);
    };
  }

  test('有矛盾：比对写一段、转写照抄一次（只带合同与原文）；停在第 2 章前面，挂黄 ❗', async () => {
    const t = await fresh('wb-check-prose');
    replyFn = proseReply(PROSE, [COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const check = fake.calls.find(isPlotCheck);
    assert.match(check[0].content, /不写 JSON/);
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 1);
    const user = copies[0].at(-1).content;
    assert.ok(user.includes('【写前冲突检查 JSON 合同】') && user.includes(`【原文】\n${PROSE}`), user);
    assert.ok(!user.includes('# 前面各章定稿的连续性事实'), user);
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(
      fails.some((x) => x.op === 'plotCheck' && /细纲「第 2 章林昭查到一点东西」与第 1 章同步下来的事实「林昭在第1章丢了第1块玉佩」矛盾：玉佩已经丢了/.test(x.message)),
      JSON.stringify(fails)
    );
    cleanup(t.dir, bundle.db);
  });

  test('只写了「无矛盾」：不转写，照写', async () => {
    const t = await fresh('wb-check-none');
    replyFn = proseReply('无矛盾');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(t.has(CH(2)));
    assert.ok(fake.calls.some(isPlotCheck));
    assert.ok(!fake.calls.some(isTranscribe));
    cleanup(t.dir, bundle.db);
  });

  test('转写改了原句：重转一次，说清哪一处不是原文里的字', async () => {
    const t = await fresh('wb-check-reword');
    replyFn = proseReply(PROSE, [conflict('第 2 章林昭又查到了东西'), COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 2);
    assert.ok(copies[1].at(-1).content.includes('【上次转写不合格】这几处不是原文里的字：「第 2 章林昭又查到了东西」'), copies[1].at(-1).content.slice(0, 800));
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    cleanup(t.dir, bundle.db);
  });

  // 原来解析失败的走法：这一步没做成，记一句、照写（检查是额外的一道）。
  test('转写调用失败：这一步没做成，照写', async () => {
    const t = await fresh('wb-check-transcribe-fail');
    settings.tierModels = { quality: ['p/broken'] };
    settings.taskTiers = { transcribe: 'quality' };
    replyFn = proseReply(PROSE, [COPIED, COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(fake.calls.some((c) => isTranscribe(c) && c.ref === 'p/broken'));
    assert.ok(t.has(CH(2)));
    assert.ok(!(await failuresOf(t, PLOT(2))).some((x) => x.op === 'plotCheck'));
    cleanup(t.dir, bundle.db);
  });
});

describe('写完这一章就停；停止', () => {
  test('点了「写完这一章就停」：这一章写完、落盘，然后收', async () => {
    const t = await fresh('wb-pause');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 1) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批量写章');
        assert.equal(task.pausable, true);
        assert.ok(bundle.progress.requestStop(task.id));
        assert.equal(bundle.progress.activeTasks().find((x) => x.id === task.id).stopping, true);
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(finished.find((x) => x.title === '批量写章').message, /写完第 1 章停下了。后面的第 2–3 章没写。/);
    cleanup(t.dir, bundle.db);
  });

  test('点了「停止」：正在写的那一章不落盘', async () => {
    const t = await fresh('wb-cancel');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批量写章');
        bundle.progress.cancelTask(task.id);
        throw new bundle.provider.CancelledError();
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.deepEqual(await failuresOf(t, PLOT(2)), []);
    cleanup(t.dir, bundle.db);
  });
});

describe('一章之内续写那几轮不换模型', () => {
  let t;
  let answered = 0;
  before(async () => {
    t = await fresh('wb-pin');
    // 首选坏了：第一次调用换到同档的第二个；之后续写那几轮直接用它，不再先去碰坏的那个。
    settings.models = ['p/broken', 'p/m'];
    settings.fallbackAttempts = 1;
    // 坏的那个在应答之前就抛了：走到这里的每一次都是好的那个在答。
    replyFn = (messages) => {
      answered++;
      const { continuation } = chapterOf(messages);
      return continuation ? { text: filler(400, 3), stop: 'end' } : { text: filler(200, 4), stop: 'maxTokens' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 1 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('坏的那个只碰了一次：续写那几轮直接用第一次成功的那个', () => {
    assert.ok(answered >= 2, `答了 ${answered} 次`);
    assert.equal(fake.callCount(), answered + 1);
    assert.ok(t.has(CH(1)));
  });
});

describe('没有可写的', () => {
  test('都写过了：不问、不调', async () => {
    const t = await fresh('wb-none', { written: [1, 2, 3] });
    assert.equal(await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 } }), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('都已经写过正文了')), h.toasts.join('|'));
    cleanup(t.dir, bundle.db);
  });
});

// ---------------------------------------------------------------- 一致性预检（五期）

/** 第 2 章的细纲改成排着沈秋（计划出场写在「出场人物」一节）；沈秋的卡上「当前状态」写着 `state`。 */
function scheduleShenQiu(t, state, through = 0) {
  t.write(
    PLOT(2),
    [
      '---', 'no: 2', `title: ${TITLES[1]}`, 'targetWords: 600', '---', '',
      `# 第2章 ${TITLES[1]}`, '', '## 梗概', '', '第 2 章的目的', '', '## 出场人物', '', '林昭、沈秋', '',
      '## 关键事件', '', '第 2 章林昭查到一点东西。', '', '## 看点', '', '第 2 章结尾：又一个人不见了。', '',
    ].join('\n')
  );
  t.write('.novelforge/characters/沈秋.md', `---\nname: 沈秋\nstateThrough: ${through}\n---\n\n# 沈秋\n\n## 当前状态\n\n${state}\n`);
  t.project.invalidate();
}

describe('一致性预检：开跑之前查一遍，有问题先问', () => {
  test('作者说「仅本次忽略」：照写，跑的中途不再为它停', async () => {
    const t = await fresh('wb-preflight-ignore');
    scheduleShenQiu(t, '已死亡');
    h.expect('仅本次忽略，照写');
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0].message, /^一致性预检：第 1–3 章里有 1 处要留意（这一步没有调用模型）/);
    assert.match(h.confirms[0].detail, /第 2 章：沈秋的当前状态（开篇状态）写着「已死亡」/);
    assert.equal(calls, 3);
    assert.ok(t.has(CH(3)));
    cleanup(t.dir, bundle.db);
  });

  test('作者没答应：一次模型都不调', async () => {
    const t = await fresh('wb-preflight-cancel');
    scheduleShenQiu(t, '已死亡');
    h.expect(undefined);
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.equal(calls, 0);
    assert.equal(fake.calls.length, 0);
    cleanup(t.dir, bundle.db);
  });

  // 前面刚定稿的一章把某人写死了，后面一章还排着他：批量没有人看着，停在那一章前面。
  test('中途新冒出来的：停在那一章前面，挂黄 ❗', async () => {
    const t = await fresh('wb-preflight-midway');
    scheduleShenQiu(t, '（待补充）');
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '第 1 章的事。', 出场人物: [{ name: '林昭', aliases: [] }, { name: '沈秋', aliases: [] }], 关键事件: [], 连续性事实: [] });
      }
      if (isState(messages)) {
        return JSON.stringify({ updates: [{ name: '沈秋', 当前状态: '已死亡，尸体留在渡口' }] });
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    assert.equal(h.confirms.length, 0, '开跑时还没有问题');
    assert.ok(t.has(CH(1)));
    assert.ok(!t.has(CH(2)), '第 2 章没写');
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /第 2 章的一致性预检发现 1 处问题（沈秋已经死了，细纲仍排着），批量停在这里/);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(fails.some((x) => x.severity === 'warn' && /一致性预检/.test(x.message)), JSON.stringify(fails));
    cleanup(t.dir, bundle.db);
  });

  // 百章实验：钱执事第 10 章定稿时已记下「尸骨无存」，第 26 章细纲照排——他没有卡，预检没拦。
  test('没有卡的人：靠前面定稿的连续性事实认出来，停在那一章前面', async () => {
    const t = await fresh('wb-preflight-fact');
    scheduleShenQiu(t, '');
    t.remove('.novelforge/characters/沈秋.md');
    // 第 1 章也排着沈秋：他死在这一章（不算提前登场）。
    t.write(PLOT(1), t.read(PLOT(1)).replace('## 出场人物\n\n林昭\n', '## 出场人物\n\n林昭、沈秋\n'));
    t.project.invalidate();
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '第 1 章的事。', 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [], 连续性事实: ['沈秋被刺死在渡口，尸骨无存'] });
      }
      const { no, continuation } = chapterOf(messages);
      if (!isState(messages) && !continuation && no === 1) {
        return { text: `沈秋被刺死在渡口，尸骨无存。\n\n${filler(700, 100)}`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const f = finished.find((x) => x.title === '批量写章');
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(f.message, /第 2 章的一致性预检发现 1 处问题（沈秋已经死了/);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(fails.some((x) => /沈秋在第 1 章同步下来的事实里写着「沈秋被刺死在渡口」/.test(x.message)), JSON.stringify(fails));
    cleanup(t.dir, bundle.db);
  });
});

describe('开写之前补建角色卡：定稿过的细纲里出场两章以上、还没有卡的人', () => {
  let t;
  before(async () => {
    t = await fresh('wb-cast-cards');
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '事。', 出场人物: [{ name: '林昭', aliases: [] }, { name: '老周', aliases: [] }], 关键事件: [], 连续性事实: [] });
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    fake.reset();
    h.confirms.length = 0;
    h.expect('开始写章');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('确认框里说了给谁建卡、几次调用，并算进总数', () => {
    const c = h.confirms[0];
    assert.match(c.message, /预计 2–5 次调用/);
    assert.match(c.detail, /开写之前先给老周建角色卡（同步过的章里已经出场 2 章以上、还没有卡；1 次调用/);
  });

  test('先建卡再写：老周有了卡，第 3 章写了', () => {
    assert.ok(t.has('.novelforge/characters/老周.md'));
    assert.ok(t.has(CH(3)));
  });
});

// 五期补遗 §4：写完即审稿。写 → 审 → 定稿；报告进一个新会话；审出问题、审稿失败都不停。
describe('写完即审稿', () => {
  let t;
  const order = [];
  before(async () => {
    t = await fresh('wb-review');
    replyFn = (messages) => {
      if (isReview(messages)) {
        const user = messages[messages.length - 1].content;
        // 审稿冻结的目标只剩关键事件：「第 N 章林昭查到一点东西」。
        const no = Number(/第 (\d+) 章林昭查到/.exec(user)?.[1] ?? 0);
        order.push(`审${no}`);
        if (no === 2) {
          return { text: '这不是 JSON', stop: 'end' };
        }
        const quote = /# 待审正文\n\n([\s\S]{20})/.exec(user)?.[1] ?? '';
        return {
          text: JSON.stringify({
            summary: `第 ${no} 章还行`,
            items: [{ category: '剧情合理性', severity: 'error', quote, description: '这一句有问题' }],
            goalReviews: [],
          }),
          stop: 'end',
        };
      }
      if (isSummary(messages)) {
        order.push('定稿');
      } else if (!isState(messages) && !isFind(messages) && !isTime(messages)) {
        order.push('写');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', review: true, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('三章都写了；每章是写 → 审 → 定稿', () => {
    assert.ok([1, 2, 3].every((no) => t.has(CH(no))));
    assert.deepEqual(order.filter((x) => x !== '审2'), ['写', '审1', '定稿', '写', '定稿', '写', '审3', '定稿']);
  });

  test('第 2 章审稿两次都不合格：不停，后面照写', () => {
    assert.deepEqual(order.filter((x) => x === '审2'), ['审2', '审2']);
    assert.ok(t.has(CH(3)));
  });

  test('报告进了一个新会话：标题、一章一轮、报告卡与报错', () => {
    const dir = t.project.sessionsDir;
    const files = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const s = JSON.parse(require('fs').readFileSync(require('path').join(dir, files[0]), 'utf8'));
    assert.equal(s.title, '批量审稿 · 第 1–3 章');
    assert.deepEqual(s.turns.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(s.turns[0].command, '审稿');
    assert.equal(s.turns[1].review.report.chapterNo, 1);
    assert.equal(s.turns[1].review.report.issues.length, 1);
    assert.match(s.turns[3].error, /^审稿失败：/);
    assert.equal(s.turns[5].review.report.chapterNo, 3);
    assert.equal(s.target.kind, 'manuscript');
  });

  test('完成提示：每章审出什么，按钮打开那个会话', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.match(f.message, /审稿：第 1 章 1 严重 · 0 建议；第 2 章审稿失败；第 3 章 1 严重 · 0 建议。报告在会话「批量审稿 · 第 1–3 章」里/);
    assert.equal(f.open.label, '打开审稿报告');
    assert.ok(f.open.sessionId);
  });

  test('没确认过的走确认框：说清写完即审稿与审稿用哪一档', async () => {
    const t2 = await fresh('wb-review-ask');
    h.answers.push(undefined);
    await bundle.batch.writeManuscripts(t2.project, { range: { from: 1, to: 2 }, review: true });
    const c = h.confirms.at(-1);
    assert.match(c.message, /只写正文、写完即审稿/);
    assert.match(c.detail, /每写完一章先审一遍/);
    assert.match(c.detail, /批量审稿/);
    cleanup(t2.dir, bundle.db);
  });
});

// 2026-10-25 起改成转写：审稿按小标题写（引文用「」括出来），转写模型照抄成 JSON，之后照旧拿正文核引文。
describe('写完即审稿 · 按格式写，转写模型照抄成 JSON', () => {
  let t;
  let quote = '';
  let session;
  const prose = () =>
    ['### 总评', '第 1 章还行', '### 问题', `- 剧情合理性（严重）：这一句有问题。原文：「${quote}」`, '### 目标核对', `- g1（已完成）：查到了。证据：「${quote}」`].join('\n');
  before(async () => {
    t = await fresh('wb-review-prose');
    replyFn = (messages) => {
      if (isTranscribe(messages)) {
        return JSON.stringify({
          summary: '第 1 章还行',
          items: [{ category: '剧情合理性', severity: 'error', quote, description: '这一句有问题。' }],
          goalReviews: [{ id: 'g1', status: 'completed', description: '查到了。', evidence: [quote] }],
        });
      }
      if (isReview(messages)) {
        quote = /# 待审正文\n\n([\s\S]{20})/.exec(messages[messages.length - 1].content)?.[1] ?? '';
        return { text: prose(), stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 1 }, review: true, call: {} });
    const dir = t.project.sessionsDir;
    const [file] = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json'));
    session = JSON.parse(require('fs').readFileSync(require('path').join(dir, file), 'utf8'));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('审的那一次不要 JSON；转写那一次只带合同与审稿原文', () => {
    const review = fake.calls.find(isReview);
    assert.match(review.at(-1).content, /不写 JSON/);
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 1);
    const user = copies[0].at(-1).content;
    assert.ok(user.includes('【审稿报告 JSON 合同】') && user.includes(`【原文】\n${prose()}`), user.slice(0, 1500));
    assert.ok(!user.includes('# 待审正文'), user.slice(0, 1500));
  });

  test('报告卡进了「批量审稿」会话：引文核过正文，目标照转写的结论；调用 2 次', () => {
    const turn = session.turns[1];
    assert.equal(turn.review.report.summary, '第 1 章还行');
    assert.deepEqual(turn.review.report.issues.map((i) => [i.severity, i.quote]), [['error', quote]]);
    assert.deepEqual(turn.review.report.goals.map((g) => g.status), ['completed']);
    assert.equal(turn.review.calls, 2);
    assert.match(turn.content, /^# 第 1 章《停舟》审稿/);
  });
});
