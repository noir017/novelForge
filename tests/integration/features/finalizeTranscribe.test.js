/**
 * 同步一章里除叙事线以外的几步改成转写（2026-10-25）：照正文更新细纲、角色当前状态、故事时间，干活的模型按格式写自然语言，
 * 「转写」那一档的模型照抄成原来那份 JSON（features/transcribe.ts）。叙事线那一步这里直接给 JSON（不转），它自己的断言在别处。
 *
 * 作者定的：所有要模型直接输出 JSON 的步骤都改成这种模式；转写用**固定的转写模型**（不跟对话页选的、也不跟确认框上为这一次挑的）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 同步一章 · 三步都照抄收下 | 写的是对话页那个模型、转写的是转写那一档；转写只带合同与原文；细纲（八节、出场人物别名、连续性事实证据、设定）、角色状态、时间线都落盘；次数 = 写 4 + 转写 3 |
 * | 转写改了字 | 不收，重转一次，说清哪几处不是原文里的字；第二次照抄的落盘 |
 * | 补推时间 · 一批两章 | 写一次、转一次；「看不出」转成推不出（+?）；确认框报「预计 2 次，最多 3 次」、单列转写那一档 |
 * | 转写模型调用失败 | 原来的失败走法：细纲按小节读原文照样落盘（出场人物从文字里认）；角色状态、故事时间挂黄 ❗，次数照算 |
 * | 角色状态没人变 | 「本章没有人的状态变了。」这种短短一句不转，算没人变 |
 * | 原文不像这一步的输出 | 「好的……」这种不花转写那一次，照原来报读不出来 |
 * | 提示词 | 三步都不再要 JSON；内容要求一条不少（字数、条数、照抄名字、证据用「」引原文） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
/** 按模型引用注入异常（fakeProvider 的 behavior）：建 provider 时现读。 */
const behavior = {};

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const CARD = '.novelforge/characters/林昭.md';
const TIMELINE = '.novelforge/threads/时间线.md';

const TEXT = [
  '次日清晨，林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '青鳞从暗处扑出来，他侧身躲开，血顺着左臂往下淌，他把袖子扎紧了。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  '两日后的夜里，林昭离开了青崖镇，往北去了。',
].join('\n\n');

const TRANSCRIBER = '格式转写员';
const SUMMARY_MARK = '建立可检索的章节档案';
const STATE_MARK = '依据本章正文更新角色的「当前状态」';
const TIME_MARK = '你是小说的时间校对员';
const FIND_MARK = '你是小说定稿事实审查员';

// ---------------------------------------------------------------- 写的那一次（按格式写的自然语言）

const SUMMARY_PROSE = [
  '## 梗概',
  '林昭在客栈遇袭负伤，两日后离开青崖镇北上。',
  '',
  '## 出场人物',
  '- 林昭（昭公子）',
  '- 沈氏',
  '',
  '## 时间地点',
  '青崖镇客栈，次日清晨到两日后的夜里。',
  '',
  '## 关键事件',
  '- 青鳞从暗处偷袭林昭。',
  '- 沈氏收起残令。',
  '- 林昭离开青崖镇往北去。',
  '',
  '## 看点',
  '- 章末林昭北上，吊着他要去哪里。',
  '',
  '## 状态变更',
  '林昭左臂受伤。',
  '',
  '## 连续性事实',
  '- 林昭左臂被青鳞划伤',
  '- 沈氏把残令收进袖中',
  '',
  '## 设定',
  '- 青崖镇〔地点〕',
].join('\n');

const STATE_PROSE = '## 林昭\n左臂带伤，离开青崖镇往北去了。';

/** 一章的时间：`days` 是「看不出」时不写依据、写理由。 */
const timeProse = (no, days = '1') =>
  [
    `## 第${no}章`,
    `- 开头晚几天：${days}`,
    '- 开头时段：清晨',
    days === '看不出' ? '- 开头的依据：无' : '- 开头的依据：「次日清晨，林昭推开客栈的门」',
    days === '看不出' ? '- 判断理由：场面接不上' : '- 判断理由：无',
    '- 章内往后跳：',
    '  - 2 天：「两日后的夜里」',
    '- 结尾时段：夜里',
    '- 整章回忆：无',
    '- 写明的日子：无',
    '- 季节：无',
  ].join('\n');

// ---------------------------------------------------------------- 转写那一次（照抄出来的 JSON）

const SUMMARY_COPY = {
  梗概: '林昭在客栈遇袭负伤，两日后离开青崖镇北上。',
  出场人物: [
    { name: '林昭', aliases: ['昭公子'] },
    { name: '沈氏', aliases: [] },
  ],
  时间地点: '青崖镇客栈，次日清晨到两日后的夜里。',
  关键事件: ['青鳞从暗处偷袭林昭。', '沈氏收起残令。', '林昭离开青崖镇往北去。'],
  看点: ['章末林昭北上，吊着他要去哪里。'],
  状态变更: '林昭左臂受伤。',
  连续性事实: ['林昭左臂被青鳞划伤', '沈氏把残令收进袖中'],
  设定: [{ name: '青崖镇', category: '地点', fact: '' }],
};
const STATE_COPY = { updates: [{ name: '林昭', 当前状态: '左臂带伤，离开青崖镇往北去了。' }] };
const timeCopy = (no, days = 1) => ({
  chapter: no,
  days,
  part: '清晨',
  evidence: days === null ? '无' : '次日清晨，林昭推开客栈的门',
  reason: days === null ? '场面接不上' : '无',
  jumps: [{ days: 2, evidence: '两日后的夜里' }],
  endPart: '夜里',
  flashback: '无',
  date: null,
  season: null,
});

/** 下一次细纲转写先答这几条（改了字的那种），用完回到照抄。 */
let summaryCopies = [];
/** 写细纲那一次答什么（缺省按格式写）。 */
let summaryProse = SUMMARY_PROSE;
/** 写角色状态那一次答什么。 */
let stateProse = STATE_PROSE;
/** 补推那一批里，这些章「看不出」晚几天。 */
let unknownDays = new Set();

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    if (user.includes('【章节档案 JSON 合同】')) {
      return JSON.stringify(summaryCopies.shift() ?? SUMMARY_COPY);
    }
    if (user.includes('【角色状态 JSON 合同】')) {
      return JSON.stringify(STATE_COPY);
    }
    if (user.includes('【故事时间 JSON 合同】')) {
      const nos = [...user.matchAll(/## 第(\d+)章/g)].map((m) => Number(m[1]));
      return JSON.stringify({ times: nos.map((no) => (unknownDays.has(no) ? timeCopy(no, null) : timeCopy(no))) });
    }
    return '（认不出这份合同）';
  }
  if (system.includes(SUMMARY_MARK)) {
    return summaryProse;
  }
  if (system.includes(STATE_MARK)) {
    return stateProse;
  }
  if (system.includes(FIND_MARK)) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (system.includes(TIME_MARK)) {
    const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
    return nos.map((no) => timeProse(no, unknownDays.has(no) ? '看不出' : '1')).join('\n\n');
  }
  return '（认不出这一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
/** 系统提示里带着 `mark` 的那几次调用的下标。 */
const callsWith = (mark) => fake.calls.map((m, i) => (m[0].content.includes(mark) ? i : -1)).filter((i) => i >= 0);
/** 转写那几次里，合同是 `contract` 的那几次的下标。 */
const transcribesOf = (contract) => callsWith(TRANSCRIBER).filter((i) => userOf(i).includes(contract));

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];
const timelineOf = () => bundle.timeline.parseTimelineFile(t.read(TIMELINE), TIMELINE);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    finalize: './src/core/features/finalize.ts',
    timeBackfill: './src/core/features/timelineBackfill.ts',
    timeline: './src/core/model/timelineFile.ts',
    stateModel: './src/core/model/characterState.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  // 对话页选的是 big；转写那一档（缺省快速档）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'finalize-transcribe', title: '青崖记' });
  project = t.project;
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
  const hash = bundle.stateModel.stateHashOf('在客栈');
  t.write(CARD, `---\nname: 林昭\nstateThrough: 1\nstateHash: ${hash}\n---\n\n# 林昭\n\n## 身份\n\n少年剑客\n\n## 当前状态\n\n在客栈\n`);
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('同步一章 · 细纲、角色状态、故事时间都按格式写，转写模型照抄', () => {
  let outcome;
  before(async () => {
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('写 4 次（细纲、角色状态、叙事线、故事时间）、转写 3 次（叙事线直接给了 JSON，不转）；账对得上', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(outcome.calls, 7);
    assert.equal(callsWith(TRANSCRIBER).length, 3);
    for (const contract of ['【章节档案 JSON 合同】', '【角色状态 JSON 合同】', '【故事时间 JSON 合同】']) {
      assert.equal(transcribesOf(contract).length, 1, contract);
    }
  });

  test('写的是对话页那个模型，转写的是转写那一档', () => {
    for (const i of callsWith(TRANSCRIBER)) {
      assert.equal(refOf(i), 'p/small');
    }
    for (const mark of [SUMMARY_MARK, STATE_MARK, TIME_MARK]) {
      assert.equal(refOf(callsWith(mark)[0]), 'p/big', mark);
    }
  });

  test('转写只带合同与原文：原文进了转写的消息，书的上下文、正文没进', () => {
    const [s] = transcribesOf('【章节档案 JSON 合同】');
    assert.ok(userOf(s).includes('【原文】') && userOf(s).includes('- 林昭（昭公子）'), userOf(s));
    assert.ok(!userOf(s).includes('血顺着左臂往下淌'), userOf(s));
    const [st] = transcribesOf('【角色状态 JSON 合同】');
    assert.ok(userOf(st).includes('## 林昭\n左臂带伤'), userOf(st));
    const [tm] = transcribesOf('【故事时间 JSON 合同】');
    assert.ok(userOf(tm).includes('- 开头的依据：「次日清晨，林昭推开客栈的门」'), userOf(tm));
  });

  test('写的那几次不要 JSON', () => {
    for (const mark of [SUMMARY_MARK, STATE_MARK, TIME_MARK]) {
      const i = callsWith(mark)[0];
      assert.ok(systemOf(i).includes('不写 JSON'), systemOf(i).slice(0, 400));
    }
    assert.ok(userOf(callsWith(STATE_MARK)[0]).endsWith('请按要求写。'));
    assert.ok(userOf(callsWith(TIME_MARK)[0]).includes('请给第 2 章各判一次时间，按要求的格式写。'));
  });

  test('细纲落盘：八节照抄，出场人物带别名，连续性事实挂上正文原句，设定一节在', async () => {
    const plot = t.read(PLOT(2));
    assert.ok(plot.includes('林昭在客栈遇袭负伤，两日后离开青崖镇北上。'), plot);
    assert.match(plot, /^cast: \[林昭\(昭公子\), 沈氏\]$/m);
    assert.ok(plot.includes('- 青鳞从暗处偷袭林昭。'), plot);
    assert.ok(plot.includes('林昭左臂被青鳞划伤') && plot.includes('血顺着左臂往下淌'), plot);
    assert.ok(/## 设定\s+- 青崖镇〔地点〕/.test(plot), plot);
    // 原文写「无」的那一节换成空的，不落一个「无」字进去（这里没有「无」：状态变更有内容）。
    assert.ok(plot.includes('林昭左臂受伤。'), plot);
    project.invalidate();
    assert.ok((await project.getPlot(2)).sourceHash);
  });

  test('角色卡的当前状态换成转写出来的那一段', () => {
    assert.match(t.read(CARD), /## 当前状态\s+左臂带伤，离开青崖镇往北去了。/);
    assert.deepEqual(outcome.states.updated, ['林昭']);
  });

  test('时间线写上这一章：晚 1 天，依据是正文原句，章内跳了 2 天，「无」的理由不留', () => {
    const e = timelineOf().entries.find((x) => x.chapter === 2);
    assert.ok(e, t.read(TIMELINE));
    assert.deepEqual(e.value, { kind: 'delta', days: 1 });
    assert.equal(e.span, 3);
    assert.equal(e.basis.kind, '依据');
    assert.ok(e.basis.text.includes('次日清晨'), JSON.stringify(e));
    assert.ok(!outcome.timeError && !outcome.stateError, JSON.stringify(outcome));
  });
});

describe('转写改了原文的字：不收，重转一次', () => {
  let outcome;
  before(async () => {
    summaryCopies = [{ ...SUMMARY_COPY, 关键事件: ['林昭夜探客栈，被青鳞所伤。'] }];
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('重转那一次说清哪几处不是原文里的字', () => {
    const [first, second] = transcribesOf('【章节档案 JSON 合同】');
    assert.ok(second !== undefined, JSON.stringify(callsWith(TRANSCRIBER)));
    assert.ok(!userOf(first).includes('【上次转写不合格】'));
    assert.ok(userOf(second).includes('【上次转写不合格】这几处不是原文里的字：「林昭夜探客栈，被青鳞所伤。」'), userOf(second).slice(0, 800));
  });

  test('多调的那一次记进账里', () => {
    assert.equal(fake.callCount(), 8);
    assert.equal(outcome.calls, 8);
  });

  test('落盘的是第二次照抄的那一份', () => {
    const plot = t.read(PLOT(2));
    assert.ok(plot.includes('- 青鳞从暗处偷袭林昭。') && !plot.includes('林昭夜探客栈'), plot);
  });
});

describe('补推时间 · 一批两章：写一次、转一次', () => {
  before(async () => {
    // 第 3、4 章同步过（细纲记着正文的指纹），时间线里还没有它们。
    for (const no of [3, 4]) {
      const hash = (await chapterNo(no)).contentHash;
      t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
    }
    unknownDays = new Set([3]);
    project.invalidate();
    fake.reset();
    h.expect('开始补推');
    await bundle.timeBackfill.backfillTimeline(project);
    unknownDays = new Set();
  });

  test('确认框报「预计 2 次，最多 3 次」，单列转写那一档', () => {
    const c = h.confirms.at(-1);
    assert.ok(c.message.includes('第 3–4 章') && c.message.includes('预计 2 次调用，最多 3 次'), c.message);
    assert.ok(c.call.fixed?.some((f) => f.startsWith('转写') && f.endsWith('（不跟这一次挑的模型）')), JSON.stringify(c.call));
  });

  test('一批写一次、转一次；转写的原文是两章各一节', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes(TIME_MARK) && systemOf(1).includes(TRANSCRIBER));
    assert.ok(userOf(1).includes('## 第3章') && userOf(1).includes('## 第4章'), userOf(1));
  });

  test('「看不出」转成推不出（+?），另一章晚 1 天', () => {
    const entries = timelineOf().entries;
    assert.equal(entries.find((e) => e.chapter === 3)?.value.kind, 'unknown', t.read(TIMELINE));
    assert.deepEqual(entries.find((e) => e.chapter === 4)?.value, { kind: 'delta', days: 1 });
  });
});

describe('转写模型调用失败：照这几步原来解析失败的走法', () => {
  let outcome;
  before(async () => {
    behavior['p/small'] = 'fail';
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(5));
    delete behavior['p/small'];
  });

  test('细纲照样落盘：按小节读原文，出场人物与别名从文字里认', async () => {
    const plot = t.read(PLOT(5));
    assert.ok(plot.includes('林昭在客栈遇袭负伤'), plot);
    assert.match(plot, /^cast: \[林昭\(昭公子\), 沈氏\]$/m);
    project.invalidate();
    assert.ok((await project.getPlot(5)).sourceHash);
  });

  test('角色状态、故事时间没成：黄 ❗ 挂在章节上，说清是转写没成', async () => {
    assert.match(outcome.stateError ?? '', /转写没成/);
    assert.match(outcome.timeError ?? '', /转写没成/);
    const marks = await failuresOf(CH(5));
    assert.deepEqual(marks.map((m) => m.op).sort(), ['cardState', 'timeline']);
    assert.ok(marks.every((m) => m.severity === 'warn'), JSON.stringify(marks));
    assert.ok(!timelineOf().entries.some((e) => e.chapter === 5));
  });

  test('发出去的转写也算钱：写 4 次 + 转写 3 次（都失败了）', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(outcome.calls, 7);
  });
});

describe('角色状态：没人变就只写一句，不花转写那一次', () => {
  let outcome;
  before(async () => {
    stateProse = '本章没有人的状态变了。';
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    stateProse = STATE_PROSE;
  });

  test('角色状态那一步只调了写的那一次，没有报错', () => {
    assert.equal(transcribesOf('【角色状态 JSON 合同】').length, 0);
    assert.equal(outcome.states.calls, 1);
    assert.ok(!outcome.stateError, outcome.stateError);
    assert.deepEqual(outcome.states.updated, []);
  });
});

describe('原文连这一步的样子都没有：不花转写那一次', () => {
  let error;
  before(async () => {
    summaryProse = '好的，这一章主要写了林昭在客栈遇袭然后离开，整体节奏紧凑。';
    fake.reset();
    try {
      await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    } catch (err) {
      error = err;
    }
    summaryProse = SUMMARY_PROSE;
  });

  test('照原来报读不出来、红 ❗，只调了写的那一次', async () => {
    assert.ok(error && /同步失败/.test(error.message), String(error));
    assert.equal(fake.callCount(), 1);
    const marks = await failuresOf(CH(1));
    assert.ok(marks.some((m) => m.severity === 'error' && /无法解析/.test(m.message)), JSON.stringify(marks));
  });
});

describe('提示词：不再要 JSON，内容要求一条不少', () => {
  const sp = loadModule('src/core/features/summarizePrompt.ts');
  const cp = loadModule('src/core/features/characterCardPrompt.ts');
  const tp = loadModule('src/core/features/timePrompt.ts');

  test('细纲：八个小标题，字数、条数、照抄名字、别名只收专属称呼都还在', () => {
    for (const head of ['## 梗概', '## 出场人物', '## 时间地点', '## 关键事件', '## 看点', '## 状态变更', '## 连续性事实', '## 设定']) {
      assert.ok(sp.SUMMARY_SYSTEM.includes(head), head);
    }
    assert.ok(!/输出一个 JSON|JSON 对象|aliases|"name"/.test(sp.SUMMARY_SYSTEM), sp.SUMMARY_SYSTEM);
    for (const rule of ['150 字以内', '40 字以内；最多 12 条', '已有角色卡」列表里有就照抄', '括号里只收专属称呼', '60 字以内', '1–3 条']) {
      assert.ok(sp.SUMMARY_SYSTEM.includes(rule), rule);
    }
    assert.ok(sp.SUMMARY_JSON_CONTRACT.includes('"出场人物":[{"name":"…","aliases":["…"]}]'));
  });

  test('角色状态：一人一节，100 字以内、只写变了的、名字与名单一致；没人变只写「无」', () => {
    assert.ok(!/JSON 对象|"updates"/.test(cp.STATE_SYSTEM), cp.STATE_SYSTEM);
    for (const rule of ['## 〈人物名〉', '100 字以内', '只写本章里状态确实变了的人', '只写一个字「无」', '与名单完全一致']) {
      assert.ok(cp.STATE_SYSTEM.includes(rule), rule);
    }
    assert.ok(cp.STATE_JSON_CONTRACT.includes('{"updates":[{"name":"…","当前状态":"…"}]}'));
  });

  test('故事时间：一章一节，依据用「」逐字引正文，不许自己算日期', () => {
    assert.ok(!/输出一个 JSON|JSON 对象|evidence|"times"/.test(tp.TIME_SYSTEM), tp.TIME_SYSTEM);
    for (const rule of ['## 第12章', '用「」把这一章正文里交代时间的那一小截原样引出来，逐字复制，40 字以内', '不要自己算日期', '写「看不出」', '「三年后」按一年 360 天写 1080']) {
      assert.ok(tp.TIME_SYSTEM.includes(rule), rule);
    }
    assert.ok(tp.TIME_JSON_CONTRACT.includes('写「看不出」或没写的给 null'));
  });
});
