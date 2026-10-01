/**
 * 叙事线（七期）：工程页「从细纲排出」。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 没有细纲时不调模型 | 第 4 条：没有东西可排就不花钱 |
 * | 确认框报 1 次调用与档位 | 第 4 条：动手之前写明 |
 * | 只追加新线，已有的、作者写的一个字不动 | 第 3 条、第 19 条的批量路径 |
 * | 同名跳过、区间越界的丢，提示里分开说 | 第 2 条：丢了什么要说出来 |
 * | 提示里有全部细纲与已有的线 | 修上游只给一章蓝图、看不到已有的线 |
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
 * | 这一步失败摘要照样在，黄 ❗ 挂在章节上 | 第 16 条：部分完成 |
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

const THREADS = '.novelforge/threads.md';

function plot(no, title, events, hook) {
  t.write(
    `.novelforge/plots/00${no}-${title}.md`,
    `---\nno: ${no}\ntitle: ${title}\ntargetWords: 3000\n---\n\n# 第${no}章 ${title}\n\n## 本章目的\n\n第${no}章的目的\n\n## 关键事件\n\n${events}\n\n## 章末钩子\n\n${hook}\n`
  );
}

function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('只从作者给的故事前提、情节大纲与各章细纲里提出跨章的伏笔')) {
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
    threadsFile: './src/core/model/threadsFile.ts',
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

describe('排叙事线 · 还没有细纲', () => {
  test('不调模型、不弹确认框，说清先拆细纲', async () => {
    h.expect('开始排');
    fake.reset();
    assert.equal(await bundle.threads.generateThreads(project), 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('先拆出细纲')), h.toasts.join('|'));
  });
});

const HAND = [
  '# 叙事线',
  '',
  '## 玉佩的来历',
  '- 类型：伏笔',
  '- 计划：第 2–8 章',
  '- 意图：作者自己写的意图。',
  '- 事件：',
  '- 作者自己加的备注',
  '',
].join('\n');

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
    plot(1, '雪夜', '林昭在雪夜里被人追杀，怀里揣着一块玉佩。', '追兵举起了火把');
    plot(2, '入宗', '林昭拜入青云宗，看见执法堂的令牌上有云纹。', '有人认出了他');
    plot(3, '试剑', '试剑大会上林昭断了剑。', '断剑里藏着字');
    t.write(THREADS, HAND);
    project.invalidate();
    planReply = () =>
      '```json\n' +
      JSON.stringify({
        threads: [
          { title: '玉佩 的来历', type: '伏笔', from: 1, to: 6, intent: '换个说法再提一遍' },
          { title: '断剑之谜', type: '悬念', from: 3, to: 9, intent: '断剑里的字是谁刻的' },
          { title: '执法堂', type: '支线', from: 2, to: 30, intent: '超出全书章数' },
          { title: '青云旧案', type: '主线', from: 1, to: 20, intent: '十年前那把火' },
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

  test('确认框报 1 次调用、哪一档、追加不改', () => {
    assert.ok(confirm.message.includes('要从第 1–3 章的细纲排出叙事线，预计 1 次调用'), confirm.message);
    assert.ok(confirm.detail.includes('剧情细纲'), confirm.detail);
    assert.ok(confirm.detail.includes('已有的 1 条不会改动'), confirm.detail);
    assert.equal(returned, 1);
    assert.equal(fake.callCount(), 1);
  });

  test('提示里有全部细纲、前提、已有的线与总章数', () => {
    assert.ok(system.includes('1..20 范围内的整数'), system);
    for (const s of ['第1章 雪夜', '第2章 入宗', '第3章 试剑', '断剑里藏着字', '谁放的那把火', '少年背着旧案入宗']) {
      assert.ok(user.includes(s), s);
    }
    assert.ok(user.includes('【已有的叙事线（不要重复）】\n- 玉佩的来历（第 2–8 章） · 伏笔'), user);
  });

  test('只追加新线：作者写的原样在前，同名的、越界的不收', () => {
    const text = t.read(THREADS);
    assert.ok(text.startsWith(HAND.trimEnd()), text);
    const list = bundle.threadsFile.parseThreads(text);
    assert.deepEqual(list.map((x) => x.title), ['玉佩的来历', '断剑之谜', '青云旧案']);
    assert.equal(list[0].intent, '作者自己写的意图。');
    assert.deepEqual([list[1].from, list[1].to, list[1].kind], [3, 9, '悬念']);
  });

  test('提示里说清跳过与丢掉了几条，并打开文件', () => {
    const done = h.toasts.find((x) => x.includes('排出 2 条叙事线'));
    assert.ok(done, h.toasts.join('|'));
    assert.ok(done.includes('同名跳过 1 条') && done.includes('1 条不合格没收'), done);
    assert.deepEqual(h.opened, [THREADS]);
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
    const before = t.read(THREADS);
    planReply = () => '我觉得可以写几条伏笔。';
    fake.reset();
    h.expect('开始排');
    assert.equal(await bundle.threads.generateThreads(project), 1);
    assert.equal(t.read(THREADS), before);
    const [f] = await failuresOf(THREADS);
    assert.equal(f?.severity, 'error');
    assert.match(f.message, /排叙事线失败/);
    assert.ok(h.erred());

    planReply = () => JSON.stringify({ threads: [{ title: '新的一条', type: '伏笔', from: 4, to: 6, intent: '意图' }] });
    fake.reset();
    h.expect('开始排');
    await bundle.threads.generateThreads(project);
    assert.deepEqual(await failuresOf(THREADS), []);
    assert.ok(t.read(THREADS).startsWith(before.trimEnd()));
  });

  test('一条都不合格也算失败，不写文件', async () => {
    const before = t.read(THREADS);
    planReply = () => JSON.stringify({ threads: [{ title: '断剑之谜', type: '悬念', from: 3, to: 9, intent: '重名' }] });
    fake.reset();
    h.expect('开始排');
    await bundle.threads.generateThreads(project);
    assert.equal(t.read(THREADS), before);
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
    t.write(
      THREADS,
      [
        '# 叙事线',
        '',
        '## 玉佩的来历',
        '- 类型：伏笔',
        '- 计划：第 2–8 章',
        '- 意图：玉佩是沈家旧物。',
        '- 事件：',
        '  - 第 1 章 · 埋下：「怀里揣着一块玉佩」',
        '- 作者自己加的备注',
        '',
        '## 断剑之谜',
        '- 类型：悬念',
        '- 计划：第 3–9 章',
        '- 意图：断剑里的字是谁刻的。',
        '',
        '## 已经收了',
        '- 计划：第 1–2 章',
        '- 第 2 章 · 回收：「x」',
        '',
      ].join('\n')
    );
    project.invalidate();
    eventReply = () =>
      JSON.stringify({
        events: [
          { thread: '玉佩的来历', type: '回收', evidence: '那块玉佩原来是沈家的旧物', reason: '身世揭开' },
          { thread: '断剑之谜', type: '埋下', evidence: '断剑上刻着一行小字', reason: '编的' },
          { thread: '已经收了', type: '推进', evidence: '院外有人提着灯走过', reason: '收了的线' },
        ],
      });
    // 换成定稿要的那几种应答（摘要 / 叙事线），排线那一种照旧。
    fake = installFakeProvider(bundle.registry, { reply: finalizeReply });
    outcome = await bundle.finalize.finalizeChapter(project, await chapter4());
    const call = fake.calls.find((c) => c[0].content.includes('你是小说定稿事实审查员'));
    judgeUser = call[call.length - 1].content;
  });

  test('出场的人都没卡：摘要 1 次 + 叙事线 1 次', () => {
    assert.equal(outcome.calls, 2);
    assert.equal(outcome.threads.calls, 1);
  });

  test('只送还没收的线去判，带着状态与区间', () => {
    assert.ok(judgeUser.includes('- 玉佩的来历（伏笔 · 已埋下 · 计划第 2–8 章）意图：玉佩是沈家旧物。；最近：第 1 章埋下'), judgeUser);
    assert.ok(judgeUser.includes('- 断剑之谜（悬念 · 计划中 · 计划第 3–9 章）'), judgeUser);
    assert.ok(!judgeUser.includes('已经收了'), judgeUser);
    assert.ok(judgeUser.includes('林昭看着她'), judgeUser);
  });

  test('证据逐字找得到的追加到对的线下，作者的行不动', () => {
    const text = t.read(THREADS);
    assert.match(
      text,
      /  - 第 1 章 · 埋下：「怀里揣着一块玉佩」\n  - 第 4 章 · 回收：「那块玉佩原来是沈家的旧物」——身世揭开\n- 作者自己加的备注/
    );
    const list = bundle.threadsFile.parseThreads(text);
    assert.equal(bundle.threadsFile.threadStatus(list[0]), '已回收');
    assert.deepEqual(list[1].events, []);
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
    // 玉佩那条已经回收了，不再送去判；把它改回推进中再定稿一次，模型给同一句。
    t.write(THREADS, t.read(THREADS).replace('第 4 章 · 回收', '第 4 章 · 推进'));
    project.invalidate();
    const before = t.read(THREADS);
    eventReply = () =>
      JSON.stringify({ events: [{ thread: '玉佩的来历', type: '推进', evidence: '那块玉佩原来是沈家的旧物。', reason: '' }] });
    const again = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.deepEqual(again.threads.recorded, []);
    assert.equal(t.read(THREADS), before);
  });

  test('判叙事线失败：摘要照样在，黄 ❗ 挂在章节上，threads.md 不动；再成了就清掉', async () => {
    const before = t.read(THREADS);
    eventReply = () => '这一章没什么好说的。';
    const failed = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.ok(failed.summary);
    assert.match(failed.threadsError, /解析不出来/);
    assert.equal(failed.calls, 2);
    assert.equal(t.read(THREADS), before);
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

  test('线都收了（或没有 threads.md）：不判，定稿只有摘要那一次', async () => {
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
