/**
 * 定稿（四期）：摘要带连续性事实与证据，再用一次调用更新本章出场角色的当前状态。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 连续性事实每条带一句正文原句，找不到依据的丢掉 | D18：证据确定性地找，不调模型 |
 * | 机器的卡换上新状态、只动那一节 | D15；整卡重渲染会抹掉作者自加的小节 |
 * | 作者改过的卡不写、挂黄 ❗，对比后能采用或放弃 | 第 3 条：不静默覆盖 |
 * | 出场的人都没卡时只调 1 次 | 第 4 条：预计 1–2 次，不白调 |
 * | 不回退到更早的章 | 重新定稿早前的章不该把状态倒回去 |
 * | 角色状态失败时摘要照样在，黄 ❗ 挂在章节上 | 第 16 条：部分完成 |
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

/** 模型这一次该答什么：摘要一种、角色状态一种。`state` 可以换掉（失败那一节）。 */
let stateReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: '林昭夜里在客栈遇袭，天亮后离开。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }, { name: '李叔', aliases: [] }],
      时间地点: '青崖镇，夜。',
      关键事件: ['遇袭', '离镇'],
      新增伏笔: [],
      状态变更: '林昭受了伤。',
      连续性事实: ['林昭左臂被青鳞划伤，血流不止', '沈氏把残令收进袖中', '城主暗中投靠了魔教'],
    });
  }
  if (system.includes('依据本章正文更新角色的「当前状态」')) {
    return stateReply(messages);
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

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    finalize: './src/core/features/finalize.ts',
    characterState: './src/core/features/characterState.ts',
    stateModel: './src/core/model/characterState.ts',
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

describe('定稿：摘要与连续性事实', () => {
  let outcome;
  let summary;

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
    summary = t.read('.novelforge/summaries/002-第2章.md');
  });

  test('一共 2 次：摘要一次、角色状态一次', () => {
    assert.equal(outcome.calls, 2);
    assert.equal(fake.callCount(), 2);
  });

  test('每条事实都带一句正文原句', () => {
    assert.match(summary, /## 连续性事实\n\n- 林昭左臂被青鳞划伤，血流不止 〔证据：「[^」]*左臂[^」]*」〕/);
    assert.match(summary, /- 沈氏把残令收进袖中 〔证据：「她把那块残令收进了袖中。」〕/);
  });

  test('找不到依据的事实丢掉，并报出来', () => {
    assert.doesNotMatch(summary, /城主/);
    assert.deepEqual(outcome.summary.dropped, ['城主暗中投靠了魔教']);
    assert.match(bundle.finalize.describeFinalize(2, outcome), /1 条在正文里找不到依据/);
  });

  test('读回来：摘要的小节里有这一节', async () => {
    const s = await project.readSummary(CH(2));
    assert.match(s.sections.连续性事实, /证据/);
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

  test('出场的人都没建卡：只有摘要那一次', async () => {
    t.remove('.novelforge/characters');
    fake.reset();
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.equal(outcome.calls, 1);
    assert.equal(fake.callCount(), 1);
    assert.match(bundle.finalize.describeFinalize(1, outcome), /出场的人都还没有角色卡/);
  });

  test('角色状态解析不出来：摘要照样在，黄 ❗ 挂在章节上，调用照样记账', async () => {
    card('林昭', '', '');
    stateReply = () => '模型答非所问';
    t.remove('.novelforge/summaries/003-第3章.md');
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.equal(outcome.calls, 2);
    assert.ok(outcome.stateError);
    assert.ok(t.has('.novelforge/summaries/003-第3章.md'));
    const [f] = await failuresOf(CH(3));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /摘要已写好/);
  });

  test('再定稿成功，章节上那一条黄 ❗ 收掉', async () => {
    stateReply = () => JSON.stringify({ updates: [] });
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(CH(3)), []);
  });
});
