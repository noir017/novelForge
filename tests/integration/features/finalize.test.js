/**
 * 定稿：照正文反向更新这一章的细纲（带连续性事实与证据），再用一次调用更新本章出场角色的当前状态；叙事线那一步
 * （认事件每次都跑，叙事线重做）这里一条线都没有、什么都认不出，只算 1 次——它自己的断言在 features/threads.test.js。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 连续性事实每条带一句正文原句，找不到依据的丢掉 | D18：证据确定性地找，不调模型 |
 * | 有细纲时拿它与正文对照着改（`REFINE_SYSTEM`，先给当前细纲再给正文） | 作者定案 3：这是修改，不是重写 |
 * | 当前细纲里的旧连续性事实不给模型 | 证据要回原文逐字校验，旧句子照抄只会抄到对不上的 |
 * | 没有细纲、或七节全空时照正文从头整理（`SUMMARY_SYSTEM`） | 拆书导入、作者手写的正文也能直接定稿 |
 * | 定稿保留 targetWords / upstreamHash / title，记 sourceHash、cast，刷新 writtenFrom | 计划那一侧的账定稿不该动；不刷 writtenFrom 正文会立刻挂 ⟳ |
 * | 旧版细纲先复制进 `.trash/` | 七节整体替换，作者要能找回原来的计划 |
 * | 带着细纲也不多调：更新细纲仍是 1 次 | 调用次数和从前写摘要那一次一样（`FINALIZE_CALLS` 不变） |
 * | 机器的卡换上新状态、只动那一节 | D15；整卡重渲染会抹掉作者自加的小节 |
 * | 作者改过的卡不写、挂黄 ❗，对比后能采用或放弃 | 第 3 条：不静默覆盖 |
 * | 出场的人都没卡时只有细纲与认叙事线那 2 次 | 第 4 条：预计 2–5 次，不白调 |
 * | 不回退到更早的章 | 重新定稿早前的章不该把状态倒回去 |
 * | 角色状态失败时细纲照样在，黄 ❗ 挂在章节上 | 第 16 条：部分完成 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const TEXT = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '青鳞从暗处扑出来，他侧身躲开，血顺着左臂往下淌，他把袖子扎紧了。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  '天亮时，林昭离开了青崖镇，往北去了。',
].join('\n\n');

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const CARD = (name) => `.novelforge/characters/${name}.md`;
/** 「更新细纲」那条规则只在 REFINE_SYSTEM 里有：拿它认出这一次是不是照着当前细纲改。 */
const REFINE_RULE = '关于「当前细纲」';

/** 模型这一次该答什么：细纲（定稿）一种、角色状态一种。`state` 可以换掉（失败那一节）。 */
let stateReply;
/** 给了就拿它当定稿那一次的回答（解析失败那一节）。 */
let summaryReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  // SUMMARY_SYSTEM 与 REFINE_SYSTEM 开头同一句：两种定稿都走这一支。
  if (system.includes('建立可检索的章节档案')) {
    if (summaryReply) {
      return summaryReply;
    }
    return JSON.stringify({
      梗概: '林昭夜里在客栈遇袭，天亮后离开。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }, { name: '李叔', aliases: [] }],
      时间地点: '青崖镇，夜。',
      关键事件: ['遇袭', '离镇'],
      状态变更: '林昭受了伤。',
      连续性事实: ['林昭左臂被青鳞划伤，血流不止', '沈氏把残令收进袖中', '城主暗中投靠了魔教'],
    });
  }
  if (system.includes('依据本章正文更新角色的「当前状态」')) {
    return stateReply(messages);
  }
  // 叙事线认事件：一条线都没有，什么都认不出。
  if (system.includes('你是小说定稿事实审查员')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  return '（认不出这一步）';
}

function card(name, fm, 当前状态, extra = '') {
  t.write(
    CARD(name),
    `---\nname: ${name}\n${fm}---\n\n# ${name}\n\n## 身份\n\n${name}的身份\n\n## 当前状态\n\n${当前状态}\n${extra}`
  );
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

async function failuresOf(key) {
  return (await bundle.errorLog.listActiveFailures(project))[key] ?? [];
}

/** 定稿那一次（第一次调用）发给模型的 system 与 user。 */
function finalizeCall() {
  const [system, user] = fake.calls[0];
  return { system: system.content, user: user.content };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    finalize: './src/core/features/finalize.ts',
    characterState: './src/core/features/characterState.ts',
    stateModel: './src/core/model/characterState.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipeline: './src/core/model/pipeline.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: makeSettings({ contextWindow: 16000, maxOutputTokens: 1000 }) });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'finalize', title: '定稿测试' });
  project = t.project;
  for (const no of [1, 2, 3]) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('定稿：没有细纲时照正文整理一份，带连续性事实', () => {
  let outcome;
  let plotText;

  before(async () => {
    const hash = bundle.stateModel.stateHashOf('在客栈');
    card('林昭', `stateThrough: 1\nstateHash: ${hash}\n`, '在客栈', '\n## 我的笔记\n\n作者自己加的一节\n');
    // 沈氏：有内容、从没盖过章——作者的。
    card('沈氏', '', '守着客栈，不问来客');
    stateReply = () =>
      JSON.stringify({
        updates: [
          { name: '林昭', 当前状态: '左臂带伤，离开青崖镇往北' },
          { name: '沈氏', 当前状态: '收起了残令' },
          { name: '王五', 当前状态: '名单外的人' },
        ],
      });
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    plotText = t.read('.novelforge/summaries/002-第2章.md');
  });

  test('一共 3 次：细纲一次、角色状态一次、认叙事线一次', () => {
    assert.equal(fake.callCount(), 3);
  });

  test('outcome 记的调用次数与实际一致', () => {
    assert.equal(outcome.calls, 3);
  });

  test('没有细纲：用 SUMMARY_SYSTEM，不带「当前细纲」那段规则', () => {
    assert.ok(!finalizeCall().system.includes(REFINE_RULE));
  });

  test('没有细纲：user 消息请模型照正文整理细纲', () => {
    assert.match(finalizeCall().user, /请为下面这一章整理细纲。\n\n【第2章 第2章】\n\n/);
  });

  test('每条事实都带一句正文原句', () => {
    assert.match(plotText, /## 连续性事实\n\n- 林昭左臂被青鳞划伤，血流不止 〔证据：「[^」]*左臂[^」]*」〕/);
    assert.match(plotText, /- 沈氏把残令收进袖中 〔证据：「她把那块残令收进了袖中。」〕/);
  });

  test('找不到依据的事实丢掉，并报出来', () => {
    assert.doesNotMatch(plotText, /城主/);
    assert.deepEqual(outcome.summary.dropped, ['城主暗中投靠了魔教']);
    assert.match(bundle.finalize.describeFinalize(2, outcome), /1 条在正文里找不到依据/);
  });

  test('原来没有细纲：没有东西进回收站，完成提示说「整理了一份」', () => {
    assert.equal(outcome.summary.trashed, undefined);
    assert.match(bundle.finalize.describeFinalize(2, outcome), /^第 2 章已定稿：细纲照正文整理了一份，2 条连续性事实/);
  });

  test('读回来：细纲的「连续性事实」一节带着证据', async () => {
    project.invalidate();
    const plot = await project.getPlot(2);
    assert.match(plot.sections.连续性事实, /证据/);
  });

  test('读回来：这一章算定稿过（sourceHash 对得上正文）', async () => {
    const chapter = await chapterNo(2);
    assert.ok(await project.finalizedPlotOf(chapter));
  });
});

describe('定稿：角色状态', () => {
  test('机器的卡换上新状态、盖到第 2 章，作者自加的小节还在', () => {
    const text = t.read(CARD('林昭'));
    assert.match(text, /## 当前状态\n\n左臂带伤，离开青崖镇往北\n/);
    assert.match(text, /stateThrough: 2/);
    assert.match(text, /## 我的笔记\n\n作者自己加的一节/);
  });

  test('读回来归机器：下一次定稿照样能写', async () => {
    project.invalidate();
    const lin = (await project.listCharacters()).find((c) => c.name === '林昭');
    assert.equal(lin.stateThrough, 2);
    assert.ok(bundle.stateModel.stateOwnedByMachine(lin));
  });

  test('作者的卡一个字没动，挂黄 ❗，说明里带着机器那一版', async () => {
    assert.match(t.read(CARD('沈氏')), /守着客栈，不问来客/);
    const [f] = await failuresOf(CARD('沈氏'));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /你改过/);
    assert.deepEqual(bundle.characterState.proposalOf(f.detail), { no: 2, state: '收起了残令' });
  });

  test('对比后采用：换上那一版、盖章、清 ❗', async () => {
    h.setReviewVerdict('apply');
    await bundle.characterState.reviewCharacterState(project, CARD('沈氏'));
    assert.match(t.read(CARD('沈氏')), /## 当前状态\n\n收起了残令\n/);
    assert.deepEqual(await failuresOf(CARD('沈氏')), []);
    project.invalidate();
    const shen = (await project.listCharacters()).find((c) => c.name === '沈氏');
    assert.ok(bundle.stateModel.stateOwnedByMachine(shen));
  });

  test('名单外的名字忽略', async () => {
    assert.deepEqual((await project.listCharacters()).map((c) => c.name).sort(), ['林昭', '沈氏'].sort());
  });
});

describe('定稿：作者改过、对比后放弃', () => {
  before(async () => {
    card('沈氏', 'stateThrough: 2\nstateHash: stale\n', '其实她早就认出了林昭');
    stateReply = () => JSON.stringify({ updates: [{ name: '沈氏', 当前状态: '收起了残令' }] });
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    h.setReviewVerdict('discard');
    await bundle.characterState.reviewCharacterState(project, CARD('沈氏'));
  });

  test('不写、清 ❗；这一节仍然归作者', async () => {
    assert.match(t.read(CARD('沈氏')), /其实她早就认出了林昭/);
    assert.deepEqual(await failuresOf(CARD('沈氏')), []);
    project.invalidate();
    const shen = (await project.listCharacters()).find((c) => c.name === '沈氏');
    assert.ok(!bundle.stateModel.stateOwnedByMachine(shen));
  });

  test('出场了、状态没变的机器的卡：写到第几章推到这一章', () => {
    assert.match(t.read(CARD('林昭')), /stateThrough: 3/);
    assert.match(t.read(CARD('林昭')), /左臂带伤，离开青崖镇往北/);
  });
});

describe('定稿：不回退、没卡、失败', () => {
  test('卡上已经是更晚那一章的状态：重新定稿第 1 章不回退', async () => {
    stateReply = () => JSON.stringify({ updates: [{ name: '林昭', 当前状态: '刚进青崖镇' }] });
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.deepEqual(outcome.states.newer, ['林昭']);
    assert.match(t.read(CARD('林昭')), /左臂带伤/);
  });

  test('出场的人都没建卡：只有更新细纲与认叙事线那两次', async () => {
    t.remove('.novelforge/characters');
    fake.reset();
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.equal(outcome.calls, 2);
    assert.equal(fake.callCount(), 2);
    assert.match(bundle.finalize.describeFinalize(1, outcome), /出场的人都还没有角色卡/);
  });

  test('角色状态解析不出来：细纲照样在，黄 ❗ 挂在章节上，调用照样记账', async () => {
    card('林昭', '', '');
    stateReply = () => '模型答非所问';
    t.remove('.novelforge/summaries/003-第3章.md');
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.equal(outcome.calls, 3);
    assert.ok(outcome.stateError);
    assert.ok(t.has('.novelforge/summaries/003-第3章.md'));
    const [f] = await failuresOf(CH(3));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /细纲已照正文更新，但角色状态没更新成/);
  });

  test('再定稿成功，章节上那一条黄 ❗ 收掉', async () => {
    stateReply = () => JSON.stringify({ updates: [] });
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(CH(3)), []);
  });
});

describe('定稿：有细纲时照正文反向更新它', () => {
  const PLAN_REL = '.novelforge/summaries/004-夜雨.md';
  const PLAN = [
    '---',
    'no: 4',
    'title: 夜雨',
    'targetWords: 2400',
    'upstreamHash: 0a1b2c3d4e5f6789',
    'writtenFrom: 1111111111111111',
    'factCheckOk: true',
    'generatedBy: novel-forge',
    '---',
    '',
    '# 第4章 夜雨',
    '',
    '## 梗概',
    '',
    '林昭冒雨投宿客栈，夜里遭青鳞伏击，天亮前独自离镇。',
    '',
    '## 出场人物',
    '',
    '林昭、沈氏',
    '',
    '## 时间地点',
    '',
    '青崖镇客栈，雨夜。',
    '',
    '## 关键事件',
    '',
    '林昭投宿；青鳞夜袭，林昭负伤；沈氏收起残令；天亮离镇。',
    '',
    '## 看点',
    '',
    '- 青鳞从暗处扑出来的那一下。',
    '',
    '## 状态变更',
    '',
    '（待补充）',
    '',
    '## 连续性事实',
    '',
    '- 林昭在客栈留下了佩剑 〔证据：「他把佩剑留在了柜台上」〕',
    '',
  ].join('\n');

  let outcome;
  let chapter;
  let plot;

  before(async () => {
    t.write('chapters/004-夜雨.md', `# 夜雨\n\n${TEXT}\n`);
    t.write(PLAN_REL, PLAN);
    // 林昭有卡：角色状态那一步照常调一次，好看出反向更新本身没有多调。
    card('林昭', '', '');
    stateReply = () => JSON.stringify({ updates: [] });
    fake.reset();
    chapter = await chapterNo(4);
    outcome = await bundle.finalize.finalizeChapter(project, chapter);
    project.invalidate();
    plot = await project.getPlot(4);
  });

  test('用 REFINE_SYSTEM：带着「当前细纲」那段规则', () => {
    assert.ok(finalizeCall().system.includes(REFINE_RULE));
  });

  test('REFINE_SYSTEM 是在 SUMMARY_SYSTEM 后面接一段：字段与规则一字不差', () => {
    assert.ok(finalizeCall().system.startsWith('你是小说编辑，负责为长篇小说建立可检索的章节档案。'));
  });

  test('user 消息先给当前细纲：标题是【第4章 夜雨 · 当前细纲】，后面接着它的小节', () => {
    assert.match(
      finalizeCall().user,
      /请照下面这一章的正文，把它的当前细纲改成正文实际写成的样子。\n\n【第4章 夜雨 · 当前细纲】\n\n## 梗概\n林昭冒雨投宿客栈，夜里遭青鳞伏击，天亮前独自离镇。\n\n## 出场人物\n林昭、沈氏\n/
    );
  });

  test('当前细纲之后才是正文：【第4章 夜雨 · 正文】', () => {
    const { user } = finalizeCall();
    const planAt = user.indexOf('【第4章 夜雨 · 当前细纲】');
    const proseAt = user.indexOf('【第4章 夜雨 · 正文】\n\n雨下了一整夜。');
    assert.ok(planAt >= 0 && proseAt > planAt, user);
  });

  test('当前细纲只给填了的小节：占位的「状态变更」不给', () => {
    assert.doesNotMatch(finalizeCall().user, /## 状态变更/);
  });

  test('旧的连续性事实不给模型：它要照正文重新摘、证据重新校验', () => {
    assert.doesNotMatch(finalizeCall().user, /佩剑/);
  });

  test('细纲落回原来那份文件，不另起一份', () => {
    assert.equal(outcome.summary.relPath, PLAN_REL);
  });

  test('七节整体换成模型那一版：原来的梗概不在了', () => {
    assert.equal(plot.sections.梗概, '林昭夜里在客栈遇袭，天亮后离开。');
  });

  test('保留计划那一侧的账：标题、目标字数、大纲指纹', () => {
    assert.deepEqual(
      { title: plot.title, targetWords: plot.targetWords, upstreamHash: plot.upstreamHash },
      { title: '夜雨', targetWords: 2400, upstreamHash: '0a1b2c3d4e5f6789' }
    );
  });

  test('写前冲突检查的放行（factCheckOk）原样留着', () => {
    assert.equal(plot.factCheckOk, true);
  });

  test('sourceHash 记的是正文的 contentHash：这一章算定稿过', () => {
    assert.equal(plot.sourceHash, chapter.contentHash);
  });

  test('writtenFrom 刷成更新之后的内容指纹：正文不会因为定稿立刻挂 ⟳', () => {
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  test('writtenFrom 不再是原来那一版的', () => {
    assert.notEqual(plot.writtenFrom, '1111111111111111');
  });

  test('cast 记下实际出场：frontmatter 里一项一人', () => {
    assert.match(t.read(PLAN_REL), /^cast: \[林昭, 沈氏, 李叔\]$/m);
  });

  test('读回来的出场人物取 cast（定稿过的是实际出场）', () => {
    assert.deepEqual(plot.characters, ['林昭', '沈氏', '李叔']);
  });

  test('旧版先复制一份进 .novelforge/.trash/，原样一个字节不差', () => {
    assert.equal(t.read(`.novelforge/.trash/${PLAN_REL}`), PLAN);
  });

  test('outcome 报出旧版在回收站里的位置', () => {
    assert.equal(outcome.summary.trashed, `.novelforge/.trash/${PLAN_REL}`);
  });

  test('完成提示说「旧版已放进回收站」', () => {
    assert.match(
      bundle.finalize.describeFinalize(4, outcome),
      /^第 4 章已定稿：细纲照正文更新（旧版已放进回收站），2 条连续性事实/
    );
  });

  test('带着细纲也不多调：更新细纲 1 次、角色状态 1 次、认叙事线 1 次，一共 3 次', () => {
    assert.equal(fake.callCount(), 3);
  });

  test('outcome 记的调用次数与实际一致', () => {
    assert.equal(outcome.calls, 3);
  });

  test('定稿的次数估算：2–5 次（叙事线重做：认事件每次都跑）', () => {
    const { low, high, max } = bundle.pipeline.FINALIZE_CALLS;
    assert.deepEqual({ low, high, max }, { low: 2, high: 5, max: 5 });
  });

  test('再定稿一次：回收站里同名的旧版不被覆盖，新的一份加 -2', async () => {
    fake.reset();
    const again = await bundle.finalize.finalizeChapter(project, chapter);
    assert.equal(again.summary.trashed, '.novelforge/.trash/.novelforge/summaries/004-夜雨-2.md');
  });
});

describe('定稿：细纲只起了个头（七节全空）时照正文从头整理', () => {
  const SHELL_REL = '.novelforge/summaries/005-空壳.md';

  before(async () => {
    t.write('chapters/005-空壳.md', `# 空壳\n\n${TEXT}\n`);
    t.write(
      SHELL_REL,
      '---\nno: 5\ntitle: 空壳\ntargetWords: 1800\ngeneratedBy: novel-forge\n---\n\n# 第5章 空壳\n\n' +
        ['梗概', '出场人物', '时间地点', '关键事件', '看点', '状态变更', '连续性事实']
          .map((k) => `## ${k}\n\n（待补充）`)
          .join('\n\n') +
        '\n'
    );
    stateReply = () => JSON.stringify({ updates: [] });
    fake.reset();
    await bundle.finalize.finalizeChapter(project, await chapterNo(5));
  });

  test('用 SUMMARY_SYSTEM：空壳不算「当前细纲」', () => {
    assert.ok(!finalizeCall().system.includes(REFINE_RULE));
  });

  test('user 消息请模型照正文整理细纲，不带「当前细纲」那一块', () => {
    assert.match(finalizeCall().user, /^请为下面这一章整理细纲。\n\n【第5章 空壳】\n\n雨下了一整夜。/m);
  });

  test('照样落回那份空壳，目标字数留着', async () => {
    project.invalidate();
    const plot = await project.getPlot(5);
    assert.deepEqual({ relPath: plot.relPath, targetWords: plot.targetWords }, { relPath: SHELL_REL, targetWords: 1800 });
  });
});

// 真实模型试跑里撞上的：定稿那次回答没解析开时，从前把整段原文塞进「梗概」、其余七节写成占位，
// 还记上 sourceHash——细纲被毁、这一章却显示已定稿。现在解析不了就报失败，细纲一个字不动。
describe('定稿：模型返回解析不了', () => {
  const PLAN_REL = '.novelforge/summaries/006-雾巷.md';
  const PLAN =
    '---\nno: 6\ntitle: 雾巷\ntargetWords: 2000\nupstreamHash: 0a1b2c3d4e5f6789\ngeneratedBy: novel-forge\n---\n\n# 第6章 雾巷\n\n' +
    '## 梗概\n\n林昭在雾巷里甩掉跟踪的人。\n\n## 关键事件\n\n- 林昭发现有人跟踪\n- 他钻进雾巷甩掉对方\n';
  let error;

  before(async () => {
    t.write('chapters/006-雾巷.md', `# 雾巷\n\n${TEXT}\n`);
    t.write(PLAN_REL, PLAN);
    summaryReply = '好的，这一章主要写了林昭在客栈遇袭然后离开，整体节奏紧凑。';
    fake.reset();
    try {
      await bundle.finalize.finalizeChapter(project, await chapterNo(6));
    } catch (err) {
      error = err;
    }
    summaryReply = undefined;
  });

  test('报失败，不当成定稿完成', () => {
    assert.ok(error && /定稿失败/.test(error.message), String(error));
  });

  test('细纲一个字都没动', () => {
    assert.equal(t.read(PLAN_REL), PLAN);
  });

  test('这一章不算定稿过：细纲上没有 sourceHash', async () => {
    project.invalidate();
    assert.ok(!(await project.getPlot(6)).sourceHash);
  });

  test('失败挂在章节上，说明细纲没有改动', async () => {
    const marks = await failuresOf('chapters/006-雾巷.md');
    assert.ok(marks.some((m) => /无法解析/.test(m.message) && /细纲没有改动/.test(m.detail ?? '')), JSON.stringify(marks));
  });
});
