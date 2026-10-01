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
