/**
 * 叙事线（2026-10-20 重做）：工程页「从大纲排出」（排线）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 没有情节大纲时不调模型 | 第 4 条：没有东西可排就不花钱 |
 * | 确认框报 1 次调用与档位，说清已有的不动、主线已有就不再排 | 第 4 条：动手之前写明 |
 * | 一条线一个新文件，伏笔写在线下；已有的、作者写的一个字不动 | 第 3 条、第 19 条的批量路径 |
 * | 同名跳过；种类不是四种之一、主线重复、区间越界的不收，提示里分开说 | 设计稿：种类定死四种、主线全书一条；第 2 条 |
 * | 伏笔与全书已有的重名跳过，章号不合理的只去掉章号 | 同一样东西只有一份 |
 * | 提示里有配置、前提、角色图谱（含暗设，老卡的「未收伏笔」不读）、情节大纲与已有的线和伏笔，**不读细纲** | 线在大纲这一层排，细纲反过来照着线排 |
 * | 解析不出来挂红 ❗、文件不动；成了清掉 | 第 16 条 |
 *
 * 定稿第三步（认事件 / 归并 / 当前进度）：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 认事件每次都跑（线是空的也跑），归并、当前进度按需 0–1 次 | 设计稿 ⚑6：正文里长出来的线只能在这里认出来；第 4 条 |
 * | 提示里有本章计划（只读各条线里这一章的计划事件；老细纲里的「新增伏笔」不读）、没收束的线（带现在走到哪）、没收的伏笔 | 设计稿「三、a」；二期细纲删了「新增伏笔」 |
 * | 证据逐字找得到的才记，按章号插在那条线下；作者的行、计划事件不动 | 没有原文撑着的事件多半是编的；第 3 条 |
 * | 新线一条一个新文件（来源：正文），挂不上线的新伏笔进「未归属的伏笔」 | 线从正文里长出来；能挂就挂 |
 * | 当前进度：机器的换写并盖章，作者改过的不覆盖、线上挂黄 ❗ | 照角色卡「当前状态」；第 19 条的例外 |
 * | 收了的线不送、模型提了也不记；重新定稿不重复记，证据已经不在正文里的这一章旧事件清掉 | 设计稿 ⚑7 |
 * | 归并：新认出的其实是已有的那一条，不另建 | 同一样东西只有一份 |
 * | 认事件失败整步没成，当前进度没成只算部分完成；都挂黄 ❗ 在章节上 | 第 16 条 |
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
/** 排线那一次答什么。 */
let planReply;

/** 叙事线目录：一条线一个文件。 */
const THREADS = '.novelforge/threads';
const file = (name) => `${THREADS}/${name}.md`;
/** 目录里有哪几条线（文件名）。 */
const names = () => (t.has(THREADS) ? require('fs').readdirSync(t.rel(THREADS)).sort() : []);

/** 写一份还没定稿的细纲（计划）：七节里只填几节，钩子写在「看点」里。 */
function plot(no, title, events, highlight) {
  t.write(
    `.novelforge/summaries/00${no}-${title}.md`,
    `---\nno: ${no}\ntitle: ${title}\ntargetWords: 3000\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n第${no}章的梗概\n\n## 关键事件\n\n${events}\n\n## 看点\n\n- ${highlight}\n`
  );
}

/** 排线的系统提示里认得出的那一句。 */
const PLAN_MARK = '只从作者给的小说配置、故事前提、角色图谱与情节大纲里排出这本书的叙事线';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(PLAN_MARK)) {
    return planReply(messages);
  }
  return '（认不出这一步）';
}

async function failuresOf(key) {
  return (await bundle.errorLog.listActiveFailures(project))[key] ?? [];
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    threads: './src/core/features/threads.ts',
    finalize: './src/core/features/finalize.ts',
    threadFile: './src/core/model/threadFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    logger: './src/core/runtime/logger.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'threads', title: '青云剑录' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('排叙事线 · 还没有情节大纲', () => {
  // 情节大纲是各章细纲梗概的汇总：细纲排了、梗概却空着，大纲里就没有这一章。
  test('不调模型、不弹确认框，说清先排大纲（细纲排了、梗概空着也不算）', async () => {
    t.write('.novelforge/summaries/001-雪夜.md', '---\nno: 1\ntitle: 雪夜\n---\n\n# 第1章 雪夜\n\n## 关键事件\n\n林昭在雪夜里被人追杀。\n');
    project.invalidate();
    h.expect('开始排');
    fake.reset();
    assert.equal(await bundle.threads.generateThreads(project), 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('先排出情节大纲')), h.toasts.join('|'));
  });
});

/** 作者手写的一条主线：带一条伏笔。 */
const HAND = [
  '---',
  'kind: 主线',
  'plan: 1-20',
  '---',
  '',
  '# 青云旧案',
  '',
  '## 意图',
  '十年前那把火是谁放的。',
  '',
  '## 伏笔',
  '- 火折子：现场留下的火折子',
  '',
  '## 进展',
  '- 作者自己加的备注',
  '',
].join('\n');

const OUTLINE = outlineOf(20, { titles: { 1: '入宗' }, text: { 1: '林昭背着旧案入宗，与沈青从猜忌到并肩，查出当年放火的人。' } });

describe('排叙事线', () => {
  let returned;
  let confirm;
  let user;
  let system;

  before(async () => {
    t.write(
      '.novelforge/config.md',
      '---\ngenre: 玄幻\ntotalChapters: 20\nwordsPerChapter: 3000\n---\n# 设定\n\n## 一句话\n\n少年背着旧案入宗。\n'
    );
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 悬念骨架\n\n谁放的那把火。\n');
    writeOutline(t, OUTLINE);
    t.write(
      '.novelforge/characters/沈青.md',
      '---\nname: 沈青\n---\n\n# 沈青\n\n## 身份\n\n青云宗外门弟子\n\n## 人物关系\n\n与林昭互相猜忌\n\n## 暗设\n\n她是沈家遗孤\n'
    );
    // 老卡（叙事线重做第 10 个提交之前）：「未收伏笔」是认不出的小节，排线不读。
    t.write(
      '.novelforge/characters/李叔.md',
      '---\nname: 李叔\n---\n\n# 李叔\n\n## 身份\n\n镇口守卫\n\n## 未收伏笔\n\n他认得那块令牌\n'
    );
    plot(2, '入宗', '林昭拜入青云宗。', '有人认出了他');
    t.write(file('青云旧案'), HAND);
    project.invalidate();
    planReply = () =>
      '```json\n' +
      JSON.stringify({
        threads: [
          { title: '青云 旧案', kind: '主线', intent: '换个说法再提一遍' },
          {
            title: '林昭与沈青',
            kind: '感情线',
            from: 3,
            to: 18,
            intent: '从互相猜忌到并肩。',
            foreshadowing: [
              { title: '玉佩的来历', what: '林昭的玉佩是沈家旧物', plant: 3, resolve: 18 },
              { title: '火 折子', what: '与已有的重名' },
              { title: '沈青的旧伤', what: '旧伤', plant: 25 },
            ],
          },
          { title: '执法堂', kind: '支线', from: 2, to: 30, intent: '超出全书章数' },
          { title: '宗门大比', kind: '主线', intent: '主线已经有了' },
          { title: '断剑之谜', kind: '悬念', intent: '种类不对' },
          { title: '林昭的成长', kind: '人物线', intent: '从复仇到放下。' },
        ],
      }) +
      '\n```';
    fake.reset();
    h.expect('开始排');
    returned = await bundle.threads.generateThreads(project);
    confirm = h.confirms[0];
    const call = fake.calls[0];
    system = call[0].content;
    user = call[call.length - 1].content;
  });

  test('确认框报 1 次调用、哪一档，已有的不动、主线已有就不再排', () => {
    assert.ok(confirm.message.includes('要从情节大纲排出叙事线，预计 1 次调用'), confirm.message);
    assert.ok(confirm.call.tiers.join('\n').includes('剧情细纲'), confirm.call.tiers.join('\n'));
    assert.ok(confirm.detail.includes('已有的 1 条不会改动') && confirm.detail.includes('主线已经有了'), confirm.detail);
    assert.equal(returned, 1);
    assert.equal(fake.callCount(), 1);
  });

  test('提示里有配置、前提、角色图谱（含暗设，老卡的「未收伏笔」不读）、情节大纲、已有的线与伏笔；不读细纲', () => {
    assert.ok(system.includes('1..20 范围内的整数'), system);
    assert.ok(system.includes('已经有了，这一次不要再排主线'), system);
    for (const s of ['少年背着旧案入宗', '谁放的那把火', '与沈青从猜忌到并肩', '- 沈青（青云宗外门弟子）', '与林昭互相猜忌', '暗设（读者还不知道）：她是沈家遗孤']) {
      assert.ok(user.includes(s), s);
    }
    assert.ok(user.includes('- 李叔（镇口守卫）') && !user.includes('他认得那块令牌') && !user.includes('未收伏笔'), user);
    assert.ok(user.includes('【已有的叙事线（不要重复）】\n- 青云旧案（主线 · 计划第 1–20 章）意图：十年前那把火是谁放的。'), user);
    assert.ok(user.includes('【已有的伏笔（不要重复）】\n火折子'), user);
    assert.ok(!user.includes('有人认出了他') && !user.includes('拜入青云宗'), '细纲不读');
  });

  test('一条线一个新文件，伏笔写在线下；作者写的那条一个字不动', async () => {
    assert.equal(t.read(file('青云旧案')), HAND);
    assert.deepEqual(names(), ['林昭与沈青.md', '林昭的成长.md', '青云旧案.md'].sort());
    const { threads: list } = await project.readThreads();
    const by = Object.fromEntries(list.map((x) => [x.name, x]));
    const pair = by['林昭与沈青'];
    assert.deepEqual([pair.kind, pair.origin, pair.from, pair.to, pair.intent], ['感情线', '计划', 3, 18, '从互相猜忌到并肩。']);
    assert.deepEqual(pair.foreshadowing, [
      { name: '玉佩的来历', what: '林昭的玉佩是沈家旧物', plant: 3, resolve: 18 },
      { name: '沈青的旧伤', what: '旧伤' },
    ]);
    assert.deepEqual([by['林昭的成长'].kind, by['林昭的成长'].from, by['林昭的成长'].to], ['人物线', undefined, undefined]);
  });

  test('提示里说清排出几条线、几条伏笔，跳过与不合格分开说，并打开第一条', () => {
    const done = h.toasts.find((x) => x.includes('排出 2 条叙事线、2 条伏笔'));
    assert.ok(done, h.toasts.join('|'));
    assert.ok(done.includes('同名跳过 1 条') && done.includes('3 条不合格没收'), done);
    assert.deepEqual(h.opened, [file('林昭与沈青')]);
  });
});

describe('排叙事线 · 失败与取消', () => {
  test('作者取消：不调模型', async () => {
    fake.reset();
    h.expect('算了');
    assert.equal(await bundle.threads.generateThreads(project), 0);
    assert.equal(fake.callCount(), 0);
  });

  test('解析不出来：挂红 ❗、文件不动；再排一次成了就清掉', async () => {
    const before = names();
    planReply = () => '我觉得可以写几条伏笔。';
    fake.reset();
    h.expect('开始排');
    assert.equal(await bundle.threads.generateThreads(project), 1);
    assert.deepEqual(names(), before);
    const [f] = await failuresOf(THREADS);
    assert.equal(f?.severity, 'error');
    assert.match(f.message, /排叙事线失败/);
    assert.ok(h.erred());

    planReply = () => JSON.stringify({ threads: [{ title: '新的一条', kind: '支线', from: 4, to: 6, intent: '意图' }] });
    fake.reset();
    h.expect('开始排');
    await bundle.threads.generateThreads(project);
    assert.deepEqual(await failuresOf(THREADS), []);
    assert.deepEqual(names(), [...before, '新的一条.md'].sort());
  });

  test('一条都不合格也算失败，不写文件', async () => {
    const before = names();
    planReply = () => JSON.stringify({ threads: [{ title: '林昭的成长', kind: '人物线', intent: '重名' }] });
    fake.reset();
    h.expect('开始排');
    await bundle.threads.generateThreads(project);
    assert.deepEqual(names(), before);
    assert.match((await failuresOf(THREADS))[0]?.message ?? '', /都不合格/);
  });
});

// ---------------------------------------------------------------- 定稿第三步

const CH4 = 'chapters/004-夜谈.md';
const CH4_TEXT = [
  '夜里，沈青坐在廊下，把那块玉佩翻过来，背面刻着一个小小的沈字。',
  '林昭看着她，忽然明白那块玉佩原来是沈家的旧物。',
  '从今往后，他不再疑她。',
  '院外有人提着灯走过，脚步很轻。',
].join('\n\n');

/** 认事件、归并、当前进度那三次各答什么。 */
let findReply;
let mergeReply;
let progressReply;

const FIND_MARK = '你是小说定稿事实审查员';
const MERGE_MARK = '判断它们是不是已有的某一条换了个说法';
const PROGRESS_MARK = '给每一条写一两句「当前进度」';

/** 定稿那几步的应答：更新细纲（有计划时是 REFINE_SYSTEM，它包着 SUMMARY_SYSTEM）、叙事线三段，其余照排线。 */
function finalizeReply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: '沈青与林昭夜谈，玉佩的来历揭开。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈青', aliases: [] }],
      时间地点: '青云宗，夜。',
      关键事件: ['夜谈'],
      状态变更: '',
      连续性事实: ['玉佩背面刻着沈字'],
    });
  }
  if (system.includes(FIND_MARK)) {
    return findReply(messages);
  }
  if (system.includes(MERGE_MARK)) {
    return mergeReply(messages);
  }
  if (system.includes(PROGRESS_MARK)) {
    return progressReply(messages);
  }
  return reply(messages);
}

async function chapter4() {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === 4);
}

/** 最近那一次带这句系统提示的调用的用户消息。 */
const userOf = (mark) => {
  const call = fake.calls.findLast((c) => c[0].content.includes(mark));
  return call ? call[call.length - 1].content : '';
};

/** 一条感情线：当前进度是机器写的（指纹对得上），玉佩那条伏笔第 1 章埋下、计划第 4 章收。 */
function pairFile() {
  return bundle.threadFile.patchProgress(
    [
      '---',
      'kind: 感情线',
      'plan: 3-18',
      '---',
      '',
      '# 林昭与沈青',
      '',
      '## 意图',
      '从互相猜忌到并肩。',
      '',
      '## 当前进度',
      '',
      '## 伏笔',
      '- 玉佩的来历：林昭的玉佩是沈家旧物（计划第 1 章埋、第 4 章前收）',
      '',
      '## 进展',
      '- 第 1 章 · 埋〈玉佩的来历〉：玉佩露面 〔证据：「怀里揣着一块玉佩」〕',
      '- 第 4 章 · 计划 · 收〈玉佩的来历〉：揭开玉佩的来历',
      '- 作者自己加的备注',
      '',
    ].join('\n'),
    '两人刚结识，互相提防。',
    3
  );
}

function writeThreads() {
  t.remove(THREADS);
  t.write(file('林昭与沈青'), pairFile());
  // 作者自己写的当前进度（没有指纹）：机器不覆盖。
  t.write(file('断剑之谜'), '---\nkind: 支线\nplan: 3-9\n---\n\n# 断剑之谜\n\n## 意图\n断剑里的字是谁刻的。\n\n## 当前进度\n作者写的进度。\n');
  t.write(file('已经收了'), '---\nplan: 1-2\n---\n\n# 已经收了\n\n## 进展\n- 第 2 章 · 收束：收了 〔证据：「x」〕\n');
  project.invalidate();
}

describe('定稿 · 叙事线：认事件、归并、当前进度', () => {
  let outcome;
  let findUser;

  before(async () => {
    plot(4, '夜谈', '沈青与林昭夜谈，玉佩的来历揭开。', '院外有人');
    // 二期细纲删了「新增伏笔」：老细纲里留着的那一节当认不出的小节，定稿时不读、不当本章计划。
    t.write(
      '.novelforge/summaries/004-夜谈.md',
      t.read('.novelforge/summaries/004-夜谈.md').replace('## 看点', '## 新增伏笔\n\n- 院外的提灯人\n\n## 看点')
    );
    t.write(CH4, `# 第4章 夜谈\n\n${CH4_TEXT}\n`);
    // 出场的人都没有卡：角色状态那一步不调，次数好数。
    t.remove('.novelforge/characters');
    writeThreads();
    findReply = () =>
      JSON.stringify({
        events: [
          { line: '林昭与沈青', type: '推进', what: '两人夜谈', evidence: '沈青坐在廊下' },
          { line: '林昭与沈青', type: '收', foreshadowing: '玉佩的来历', what: '玉佩是沈家旧物', evidence: '那块玉佩原来是沈家的旧物' },
          { line: '林昭与沈青', type: '关系', what: '林昭—沈青，猜忌 → 信任', evidence: '从今往后，他不再疑她' },
          { line: '断剑之谜', type: '推进', what: '编的', evidence: '断剑上刻着一行小字' },
          { line: '已经收了', type: '推进', what: '收了的线', evidence: '院外有人提着灯走过' },
          { line: '断剑之谜', type: '推进', what: '院外有人', evidence: '院外有人提着灯走过' },
        ],
        newThreads: [{ title: '沈家旧案', kind: '支线', intent: '沈家当年出了什么事。', evidence: '背面刻着一个小小的沈字' }],
        newForeshadowing: [{ title: '提灯人', what: '院外提灯的人是谁', evidence: '脚步很轻' }],
      });
    mergeReply = () => JSON.stringify({ merges: [] });
    // 线名带着种类回来（试跑里真模型就是这么回的）：照样认得出。
    progressReply = () =>
      JSON.stringify({
        progress: [
          { line: '林昭与沈青（感情线）', text: '夜谈之后两人互相信任，玉佩的来历已经揭开。' },
          { line: '「沈家旧案」', text: '玉佩上的沈字露了面。' },
          { line: '断剑之谜', text: '不该写的那一条。' },
        ],
      });
    fake = installFakeProvider(bundle.registry, { reply: finalizeReply });
    outcome = await bundle.finalize.finalizeChapter(project, await chapter4());
    findUser = userOf(FIND_MARK);
  });

  test('次数：更新细纲 1 + 认事件 1 + 归并 1 + 当前进度 1', () => {
    assert.equal(outcome.calls, 4);
    assert.equal(outcome.threads.calls, 3);
  });

  test('判过一章就记进 project.json（四期）：前三章还没判，第 4 章记在水位之后，水位不动', async () => {
    const m = await project.readManifest();
    assert.equal(m.threadsThrough ?? 0, 0);
    assert.deepEqual(m.threadsJudged, [4]);
    assert.deepEqual(await project.readThreadsMark(), { through: 0, judged: [4] });
  });

  test('认事件的提示：本章计划（只读线里的计划事件，老细纲的新增伏笔不读）、没收束的线（带现在走到哪）、没收的伏笔；收了的线不送', () => {
    assert.ok(findUser.includes('- 林昭与沈青：收〈玉佩的来历〉——揭开玉佩的来历'), findUser);
    assert.ok(!findUser.includes('新增伏笔') && !findUser.includes('院外的提灯人'), findUser);
    assert.ok(findUser.includes('- 林昭与沈青（感情线 · 进行中 · 计划第 3–18 章）意图：从互相猜忌到并肩。；现在：两人刚结识，互相提防。'), findUser);
    assert.ok(findUser.includes('- 玉佩的来历（挂在「林昭与沈青」· 已埋 · 计划第 4 章前收）'), findUser);
    assert.ok(findUser.includes('- 断剑之谜（支线 · 计划中 · 计划第 3–9 章）'), findUser);
    assert.ok(!findUser.includes('已经收了'), findUser);
    assert.ok(findUser.includes('林昭看着她'), findUser);
  });

  test('证据逐字找得到的追加到对的线下（按章号插），作者的行与计划事件不动', () => {
    const text = t.read(file('林昭与沈青'));
    assert.ok(text.includes('- 第 4 章 · 计划 · 收〈玉佩的来历〉：揭开玉佩的来历\n- 作者自己加的备注\n- 第 4 章 · 推进：两人夜谈 〔证据：「沈青坐在廊下」〕'), text);
    assert.ok(text.includes('- 第 4 章 · 收〈玉佩的来历〉：玉佩是沈家旧物 〔证据：「那块玉佩原来是沈家的旧物」〕'), text);
    assert.ok(text.includes('- 第 4 章 · 关系：林昭—沈青，猜忌 → 信任 〔证据：「从今往后，他不再疑她」〕'), text);
    const state = bundle.threadFile.foreshadowingOf(bundle.threadFile.parseThreadFile(text, file('林昭与沈青')), 4);
    assert.deepEqual(state.map((f) => [f.name, f.status]), [['玉佩的来历', '已收']]);
  });

  test('正文里认出的新线：一条一个新文件，来源是正文，认出它的那一句记成第一条事件', async () => {
    const { threads } = await project.readThreads();
    const fresh = threads.find((x) => x.name === '沈家旧案');
    assert.deepEqual([fresh.kind, fresh.origin, fresh.intent], ['支线', '正文', '沈家当年出了什么事。']);
    assert.deepEqual(fresh.events.map((e) => [e.chapter, e.type, e.evidence]), [[4, '推进', '背面刻着一个小小的沈字']]);
  });

  test('挂不上线的新伏笔进「未归属的伏笔」，记一条埋', () => {
    const u = bundle.threadFile.parseUnfiledFile(t.read(file('未归属的伏笔')), file('未归属的伏笔'));
    assert.deepEqual(u.foreshadowing, [{ name: '提灯人', what: '院外提灯的人是谁' }]);
    assert.deepEqual(u.events.map((e) => [e.type, e.foreshadowing, e.evidence]), [['埋', '提灯人', '脚步很轻']]);
  });

  test('当前进度：机器的那几条换成这一章的、盖章；作者写的不覆盖、线上挂黄 ❗', async () => {
    const { threads } = await project.readThreads();
    const by = Object.fromEntries(threads.map((x) => [x.name, x]));
    assert.equal(by['林昭与沈青'].progress, '夜谈之后两人互相信任，玉佩的来历已经揭开。');
    assert.equal(by['林昭与沈青'].progressThrough, 4);
    assert.ok(bundle.threadFile.progressOwnedByMachine(by['林昭与沈青']));
    assert.equal(by['沈家旧案'].progress, '玉佩上的沈字露了面。');
    assert.equal(by['断剑之谜'].progress, '作者写的进度。');
    assert.deepEqual(outcome.threads.guarded, ['断剑之谜']);
    const [f] = await failuresOf(file('断剑之谜'));
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threadProgress');
    const progressUser = userOf(PROGRESS_MARK);
    assert.ok(progressUser.includes('【线】林昭与沈青\n种类：感情线\n意图：从互相猜忌到并肩。\n原来的当前进度：两人刚结识，互相提防。'), progressUser);
    assert.ok(!progressUser.includes('林昭与沈青（'), '线名不和种类粘在一起');
    assert.ok(!progressUser.includes('断剑之谜'), progressUser);
    assert.deepEqual(outcome.threads.unwritten, []);
  });

  test('编的证据、收了的线不记；完成提示里一定说叙事线', () => {
    assert.deepEqual(
      outcome.threads.dropped.map((d) => [d.what, d.why]),
      [
        ['断剑之谜', '证据在正文里找不到'],
        ['已经收了', '这条线已经收束，或这一次没送去认'],
      ]
    );
    const said = bundle.finalize.describeFinalize(4, outcome);
    for (const s of ['林昭与沈青推进、关系', '断剑之谜推进', '收〈玉佩的来历〉', '埋〈提灯人〉', '新认出 1 条线〈沈家旧案〉（支线）', '断剑之谜的当前进度你改过', '另有 2 条叙事线的记录没有收']) {
      assert.ok(said.includes(s), `${s}｜${said}`);
    }
  });

  test('重新定稿：同一句不重复记；证据已经不在正文里的这一章旧事件清掉（旧版存进历史）', async () => {
    // 作者删了「从今往后」那一句；模型这一次只给了同一句推进。
    t.write(CH4, `# 第4章 夜谈\n\n${CH4_TEXT.replace('从今往后，他不再疑她。', '他仍旧看着她。')}\n`);
    findReply = () =>
      JSON.stringify({ events: [{ line: '林昭与沈青', type: '推进', what: '换个说法', evidence: '沈青坐在廊下。' }], newThreads: [], newForeshadowing: [] });
    progressReply = () => JSON.stringify({ progress: [] });
    const again = await bundle.finalize.finalizeChapter(project, await chapter4());
    const text = t.read(file('林昭与沈青'));
    assert.equal(again.threads.pruned, 1);
    assert.ok(!text.includes('从今往后'), text);
    assert.equal((text.match(/沈青坐在廊下/g) ?? []).length, 1, text);
    assert.ok(text.includes('收〈玉佩的来历〉'), '证据还在的不动');
    assert.ok(t.has('.novelforge/history/.novelforge/threads/林昭与沈青.md'), '改之前存了一版历史');
    assert.ok(bundle.finalize.describeFinalize(4, again).includes('清掉 1 条证据已经不在正文里的旧记录'));
  });

  test('归并：新认出的其实是已有的那一条，不另建，事件挂到已有的那条上', async () => {
    findReply = () =>
      JSON.stringify({
        events: [],
        newThreads: [{ title: '沈家的旧案', kind: '支线', intent: '换个说法', evidence: '背面刻着一个小小的沈字' }],
        newForeshadowing: [],
      });
    mergeReply = () => JSON.stringify({ merges: [{ new: '沈家的旧案', into: '沈家旧案', reason: '同一桩旧案换了个说法' }] });
    const merged = await bundle.finalize.finalizeChapter(project, await chapter4());
    // 新线这一章没带来任何事件：并进去了，但如实说没记什么（不替它编一条推进）。
    assert.deepEqual(merged.threads.merged, [{ kind: 'thread', from: '沈家的旧案', into: '沈家旧案', reason: '同一桩旧案换了个说法', note: '这一章没有另记事件' }]);
    assert.ok(!t.has(file('沈家的旧案')));
    assert.ok(userOf(MERGE_MARK).includes('- 沈家的旧案（支线）换个说法'));
    assert.ok(bundle.finalize.describeFinalize(4, merged).includes('〈沈家的旧案〉并进了〈沈家旧案〉（这一章没有另记事件）'));
  });

  // 试跑报告问题 2：新伏笔只写在 newForeshadowing 里、并进已有的以后，这一章的「埋」整条没了，提示却照样说「并进了」。
  test('新伏笔并进已有的：还没埋的那条记一条「埋」；已经埋过的不再记，完成提示照实说；新伏笔都不另登记', async () => {
    t.write(
      file('断剑之谜'),
      '---\nkind: 支线\nplan: 3-9\n---\n\n# 断剑之谜\n\n## 意图\n断剑里的字是谁刻的。\n\n## 当前进度\n作者写的进度。\n\n## 伏笔\n- 断剑的刻字：断剑上的字是谁刻的（计划第 4 章埋）\n'
    );
    const before = t.read(file('林昭与沈青'));
    findReply = () =>
      JSON.stringify({
        events: [],
        newThreads: [],
        newForeshadowing: [
          { title: '沈字的来历', what: '玉佩背面刻着沈字', line: '林昭与沈青', evidence: '背面刻着一个小小的沈字' },
          { title: '廊下的断剑', what: '林昭想起断剑上的字', line: '断剑之谜', evidence: '林昭看着她，忽然明白' },
        ],
      });
    mergeReply = () =>
      JSON.stringify({
        merges: [
          { new: '沈字的来历', into: '玉佩的来历', reason: '玉佩的来历就是沈家' },
          { new: '廊下的断剑', into: '断剑的刻字', reason: '断剑上的字是谁刻的' },
        ],
      });
    const merged = await bundle.finalize.finalizeChapter(project, await chapter4());
    // 归并的提示：两边都给「是什么」与挂在哪条线（试跑：已有的只给了名字，约一半并错）；已有的只给还没收的。
    const mergeUser = userOf(MERGE_MARK);
    for (const s of [
      '【新认出的伏笔】\n- 沈字的来历（挂在「林昭与沈青」）是什么：玉佩背面刻着沈字',
      '- 玉佩的来历（挂在「林昭与沈青」· 已埋）是什么：林昭的玉佩是沈家旧物',
      '- 断剑的刻字（挂在「断剑之谜」· 计划）是什么：断剑上的字是谁刻的',
    ]) {
      assert.ok(mergeUser.includes(s), `${s}｜${mergeUser}`);
    }
    const sword = t.read(file('断剑之谜'));
    assert.ok(sword.includes('- 第 4 章 · 埋〈断剑的刻字〉：林昭想起断剑上的字 〔证据：「林昭看着她，忽然明白」〕'), sword);
    assert.equal(t.read(file('林昭与沈青')), before, '玉佩的来历第 1 章已经埋下，不再记第二条「埋」');
    for (const name of ['沈字的来历', '廊下的断剑']) {
      assert.ok(!sword.includes(name) && !before.includes(name), name);
    }
    const said = bundle.finalize.describeFinalize(4, merged);
    for (const s of ['埋〈断剑的刻字〉', '〈廊下的断剑〉并进了〈断剑的刻字〉；', '〈沈字的来历〉并进了〈玉佩的来历〉（〈玉佩的来历〉第 1 章已经埋下，这一章不再记「埋」）']) {
      assert.ok(said.includes(s), `${s}｜${said}`);
    }
  });

  test('当前进度那一次没成：认出来的照样记下，黄 ❗ 挂在章节上说清是哪一段', async () => {
    t.write(CH4, `# 第4章 夜谈\n\n${CH4_TEXT}\n`);
    findReply = () =>
      JSON.stringify({ events: [{ line: '林昭与沈青', type: '关系', what: '又信任了', evidence: '从今往后，他不再疑她' }], newThreads: [], newForeshadowing: [] });
    progressReply = () => '写不出来。';
    const half = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.match(half.threads.progressError, /解析不出来/);
    assert.equal(half.threadsError, undefined);
    assert.ok(t.read(file('林昭与沈青')).includes('又信任了'));
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /叙事线记下了，但当前进度没更新成/);
  });

  test('送去写当前进度、模型没写上的线：日志、完成提示里说出来，黄 ❗ 挂在章节上（不静默丢）', async () => {
    findReply = () =>
      JSON.stringify({
        events: [
          { line: '林昭与沈青', type: '推进', what: '林昭想明白了', evidence: '林昭看着她，忽然明白' },
          { line: '沈家旧案', type: '推进', what: '院外有人', evidence: '院外有人提着灯走过' },
        ],
        newThreads: [],
        newForeshadowing: [],
      });
    progressReply = () => JSON.stringify({ progress: [{ line: '林昭与沈青（感情线）', text: '林昭想明白了玉佩的来历。' }] });
    bundle.logger.clearLogs();
    const some = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.deepEqual(some.threads.progressed, ['林昭与沈青']);
    assert.deepEqual(some.threads.unwritten, ['沈家旧案']);
    assert.ok(bundle.finalize.describeFinalize(4, some).includes('1 条线的当前进度没写上（沈家旧案'), bundle.finalize.describeFinalize(4, some));
    const logs = bundle.logger.recentLogs();
    assert.ok(logs.some((l) => l.message.includes('1 条线的当前进度没写上') && l.detail.includes('模型回的线名：林昭与沈青（感情线）')), JSON.stringify(logs));
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /1 条线的当前进度没写上（沈家旧案）/);
  });

  test('认事件失败：细纲照样更新了，黄 ❗ 挂在章节上，叙事线不动；再成了就清掉', async () => {
    const before = t.read(file('林昭与沈青'));
    findReply = () => '这一章没什么好说的。';
    const failed = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.ok(failed.summary);
    assert.match(failed.threadsError, /解析不出来/);
    assert.equal(failed.calls, 2);
    assert.equal(t.read(file('林昭与沈青')), before);
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threads');
    assert.ok(bundle.finalize.describeFinalize(4, failed).includes('叙事线没认成'));

    findReply = () => JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
    const ok = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(ok.threadsError, undefined);
    assert.deepEqual(await failuresOf(CH4), []);
    assert.ok(bundle.finalize.describeFinalize(4, ok).includes('叙事线没有新进展'));
  });

  test('一条线都没有也认（正文里长出来的线只能在这里认出来）：定稿最少 2 次', async () => {
    t.remove(THREADS);
    project.invalidate();
    fake.reset();
    findReply = () => JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
    const none = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(none.calls, 2);
    assert.equal(none.threads.calls, 1);
    assert.ok(userOf(FIND_MARK).includes('【还没收束的叙事线】\n（还没有）'));
    assert.ok(bundle.finalize.describeFinalize(4, none).includes('叙事线没有新进展'));
    assert.ok(!t.has(THREADS), '什么都没认出，不建目录');
  });
});
