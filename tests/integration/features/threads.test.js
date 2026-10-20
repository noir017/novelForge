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
 * | 提示里有配置、前提、角色图谱（含此人暗藏的秘密）、情节大纲与已有的线和伏笔，**不读细纲** | 线在大纲这一层排，细纲反过来照着线排 |
 * | 解析不出来挂红 ❗、文件不动；成了清掉 | 第 16 条 |
 *
 * 定稿第三步（判本章推进了哪几条线）：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 有还没收的线时多 1 次，没有就不判 | 第 4 条：预计 1–3 次，不白调 |
 * | 证据逐字找得到的才记，追加在那条线下 | 没有原文撑着的事件多半是编的；第 3 条 |
 * | 收了的线不送去判、模型提了也不记 | 收了就是收了 |
 * | 重新定稿不重复记 | 同一章、同一句只记一次 |
 * | 这一步失败细纲照样更新了，黄 ❗ 挂在章节上 | 第 16 条：部分完成 |
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
/** 排线那一次答什么。 */
let planReply;

/** 叙事线目录：一条线一个文件。 */
const THREADS = '.novelforge/threads';
const file = (name) => `${THREADS}/${name}.md`;
/** 目录里有哪几条线（文件名）。 */
const names = () => (t.has(THREADS) ? require('fs').readdirSync(t.rel(THREADS)).sort() : []);

/** 写一份还没定稿的细纲（计划）：八节里只填几节，钩子写在「看点」里。 */
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
  test('不调模型、不弹确认框，说清先排大纲（细纲有了也不算）', async () => {
    plot(1, '雪夜', '林昭在雪夜里被人追杀。', '追兵举起了火把');
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

const OUTLINE = '# 情节大纲\n\n## 第1–20章：入宗\n\n林昭背着旧案入宗，与沈青从猜忌到并肩，查出当年放火的人。\n';

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
    t.write('.novelforge/outline.md', OUTLINE);
    t.write(
      '.novelforge/characters/沈青.md',
      '---\nname: 沈青\n---\n\n# 沈青\n\n## 身份\n\n青云宗外门弟子\n\n## 人物关系\n\n与林昭互相猜忌\n\n## 未收伏笔\n\n她是沈家遗孤\n'
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

  test('提示里有配置、前提、角色图谱（含此人暗藏的秘密）、情节大纲、已有的线与伏笔；不读细纲', () => {
    assert.ok(system.includes('1..20 范围内的整数'), system);
    assert.ok(system.includes('已经有了，这一次不要再排主线'), system);
    for (const s of ['少年背着旧案入宗', '谁放的那把火', '与沈青从猜忌到并肩', '- 沈青（青云宗外门弟子）', '与林昭互相猜忌', '她是沈家遗孤']) {
      assert.ok(user.includes(s), s);
    }
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
  '夜里，沈青坐在廊下，把那块玉佩翻过来，背面刻着一个小小的「沈」字。',
  '林昭看着她，忽然明白那块玉佩原来是沈家的旧物。',
  '院外有人提着灯走过，脚步很轻。',
].join('\n\n');

/** 叙事线那一次答什么。 */
let eventReply;

/** 定稿那几步的应答：更新细纲（有计划时是 REFINE_SYSTEM，它包着 SUMMARY_SYSTEM）、判叙事线，其余照排线。 */
function finalizeReply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: '沈青与林昭夜谈，玉佩的来历揭开。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈青', aliases: [] }],
      时间地点: '青云宗，夜。',
      关键事件: ['夜谈'],
      新增伏笔: [],
      状态变更: '',
      连续性事实: ['玉佩背面刻着沈字'],
    });
  }
  if (system.includes('你是小说定稿事实审查员')) {
    return eventReply(messages);
  }
  return reply(messages);
}

async function chapter4() {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === 4);
}

describe('定稿 · 判本章推进了哪几条叙事线', () => {
  let outcome;
  let judgeUser;

  before(async () => {
    plot(4, '夜谈', '沈青与林昭夜谈，玉佩的来历揭开。', '院外有人');
    t.write(CH4, `# 第4章 夜谈\n\n${CH4_TEXT}\n`);
    t.remove(THREADS);
    // 出场的人都没有卡：角色状态那一步不调，次数好数。
    t.remove('.novelforge/characters');
    t.write(
      file('玉佩的来历'),
      [
        '---',
        'kind: 支线',
        'plan: 2-8',
        '---',
        '',
        '# 玉佩的来历',
        '',
        '## 意图',
        '玉佩是沈家旧物。',
        '',
        '## 进展',
        '- 第 1 章 · 推进：玉佩露面 〔证据：「怀里揣着一块玉佩」〕',
        '- 作者自己加的备注',
        '',
      ].join('\n')
    );
    t.write(file('断剑之谜'), '---\nkind: 支线\nplan: 3-9\n---\n\n# 断剑之谜\n\n## 意图\n断剑里的字是谁刻的。\n');
    t.write(file('已经收了'), '---\nplan: 1-2\n---\n\n# 已经收了\n\n## 进展\n- 第 2 章 · 收束：收了 〔证据：「x」〕\n');
    project.invalidate();
    eventReply = () =>
      JSON.stringify({
        events: [
          { thread: '玉佩的来历', type: '回收', evidence: '那块玉佩原来是沈家的旧物', reason: '身世揭开' },
          { thread: '断剑之谜', type: '埋下', evidence: '断剑上刻着一行小字', reason: '编的' },
          { thread: '已经收了', type: '推进', evidence: '院外有人提着灯走过', reason: '收了的线' },
        ],
      });
    // 换成定稿要的那几种应答（更新细纲 / 叙事线），排线那一种照旧。
    fake = installFakeProvider(bundle.registry, { reply: finalizeReply });
    outcome = await bundle.finalize.finalizeChapter(project, await chapter4());
    const call = fake.calls.find((c) => c[0].content.includes('你是小说定稿事实审查员'));
    judgeUser = call[call.length - 1].content;
  });

  test('出场的人都没卡：更新细纲 1 次 + 叙事线 1 次', () => {
    assert.equal(outcome.calls, 2);
    assert.equal(outcome.threads.calls, 1);
  });

  test('只送还没收的线去判，带着状态与区间', () => {
    assert.ok(judgeUser.includes('- 玉佩的来历（支线 · 推进中 · 计划第 2–8 章）意图：玉佩是沈家旧物。；最近：第 1 章推进'), judgeUser);
    assert.ok(judgeUser.includes('- 断剑之谜（支线 · 计划中 · 计划第 3–9 章）'), judgeUser);
    assert.ok(!judgeUser.includes('已经收了'), judgeUser);
    assert.ok(judgeUser.includes('林昭看着她'), judgeUser);
  });

  test('证据逐字找得到的追加到对的线下（回收记成收束），作者的行不动', async () => {
    const text = t.read(file('玉佩的来历'));
    assert.match(
      text,
      /- 第 1 章 · 推进：玉佩露面 〔证据：「怀里揣着一块玉佩」〕\n- 作者自己加的备注\n- 第 4 章 · 收束：身世揭开 〔证据：「那块玉佩原来是沈家的旧物」〕/
    );
    const { threads: list } = await project.readThreads();
    const by = Object.fromEntries(list.map((x) => [x.name, x]));
    assert.equal(bundle.threadFile.threadStatus(by['玉佩的来历']), '已收束');
    assert.deepEqual(by['断剑之谜'].events, []);
  });

  test('编的证据、收了的线不记，完成提示里说出来', () => {
    assert.deepEqual(outcome.threads.recorded, [{ title: '玉佩的来历', type: '回收' }]);
    assert.deepEqual(
      outcome.threads.dropped.map((d) => [d.thread, d.why]),
      [
        ['断剑之谜', '证据在正文里找不到'],
        ['已经收了', '认不出是哪一条线'],
      ]
    );
    const said = bundle.finalize.describeFinalize(4, outcome);
    assert.ok(said.includes('叙事线：玉佩的来历回收'), said);
    assert.ok(said.includes('另有 2 条叙事线事件没有记'), said);
  });

  test('重新定稿同一章：同一句不重复记', async () => {
    // 玉佩那条已经收束了，不再送去判；把它改回推进再定稿一次，模型给同一句。
    t.write(file('玉佩的来历'), t.read(file('玉佩的来历')).replace('第 4 章 · 收束', '第 4 章 · 推进'));
    project.invalidate();
    const before = t.read(file('玉佩的来历'));
    eventReply = () =>
      JSON.stringify({ events: [{ thread: '玉佩的来历', type: '推进', evidence: '那块玉佩原来是沈家的旧物。', reason: '' }] });
    const again = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.deepEqual(again.threads.recorded, []);
    assert.equal(t.read(file('玉佩的来历')), before);
  });

  test('判叙事线失败：细纲照样更新了，黄 ❗ 挂在章节上，叙事线不动；再成了就清掉', async () => {
    const before = t.read(file('玉佩的来历'));
    eventReply = () => '这一章没什么好说的。';
    const failed = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.ok(failed.summary);
    assert.match(failed.threadsError, /解析不出来/);
    assert.equal(failed.calls, 2);
    assert.equal(t.read(file('玉佩的来历')), before);
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threads');
    assert.ok(bundle.finalize.describeFinalize(4, failed).includes('叙事线没判成'));

    eventReply = () => JSON.stringify({ events: [] });
    const ok = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(ok.threadsError, undefined);
    assert.deepEqual(await failuresOf(CH4), []);
    assert.ok(bundle.finalize.describeFinalize(4, ok).includes('叙事线没有新进展'));
  });

  test('线都收了（或没有叙事线）：不判，定稿只有更新细纲那一次', async () => {
    t.remove(THREADS);
    project.invalidate();
    fake.reset();
    const none = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(none.calls, 1);
    assert.equal(none.threads.calls, 0);
    assert.ok(!fake.calls.some((c) => c[0].content.includes('你是小说定稿事实审查员')));
    assert.ok(!bundle.finalize.describeFinalize(4, none).includes('叙事线'));
  });
});
