/**
 * 落定设定（完善设定二期，设计稿 §4）：经对话页从一段讨论一路走到落盘。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 落定 | 在细纲层聊完、`/落定设定`：这一轮临时换到设定目录，落完回到原来那一章；命令记成「落定设定」 |
 * | 装配 | 系统提示是落定设定那一份；讨论作为多轮消息带着；讨论里提到的已有条目整条带（含暗设，标明读者还不知道），其余一行；合同是落定那一份 |
 * | 卡片 | 落到「设定名录」；会新建、会更新（按磁盘认）、还没定的都列出来；人名丢掉写进说明 |
 * | 落盘 | 新的直接建在分类目录、记作机器写的、水位 0；已有的关键词只增不减、记作机器写的、**水位不动**；写过内容的先对比，只有一句话的直接写；问题不写进任何文件 |
 * | 放弃 | 覆盖审阅里放弃了那一条原样留着，别的照写 |
 * | 重来 | 会话已经回到原来的目标，重来一轮照样换过去再回来 |
 * | 拦下 | 一句都没聊过、输入框也空着：不调模型；解析不了：没有卡片、不写入、照样回到原来的目标；一条都没定下来：没有卡片，气泡里说清 |
 * | 会话 | 存下的落定草稿读回来还是落定设定，不是设定清单 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
let controller;
let posted;
let gates;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const TJG = '.novelforge/lore/宗门/天机阁.md';
const JCL = '.novelforge/lore/地域/九层楼.md';
const GS = '.novelforge/lore/地域/鬼市.md';
const LORE_DIR = { kind: 'setting', doc: 'lore' };
const PLOT3 = { kind: 'plot', plotRelPath: PLOT(3) };
const QUESTION = '鬼市开在哪座城下？';

function entry(title, { keywords = [title], brief = '', body = '', through } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(through !== undefined ? [`updatedThrough: ${through}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function plotText(no, { hash, synopsis = '往下查。', lore = '' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(hash ? [`sourceHash: ${hash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    synopsis,
    '',
    '## 关键事件',
    '',
    '- 有事发生',
    '',
    '## 设定',
    '',
    lore || '（无）',
    '',
  ].join('\n');
}

const SETTLED = {
  entries: [
    {
      title: '天机阁',
      category: '宗门',
      keywords: ['天机楼', '林昭'],
      brief: '江湖上卖消息的楼阁',
      body: {
        概要: '作者写的：七层楼，立在青崖镇北。',
        规则与边界: '一问一价；问阁主身世的一律不答。',
        现状: '阁主闭关，二当家打理。',
        暗设: '作者写的：阁主是前朝太子。二当家也知道。',
      },
    },
    { title: '九层楼', category: '地域', keywords: [], brief: '天机阁的藏书楼', body: { 概要: '九层，每层一个守楼人。', 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' } },
    { title: '鬼市', category: '地域', keywords: ['夜市'], brief: '城下的夜市', body: { 概要: '子时开张的夜市。', 规则与边界: '只收现银。', 现状: '（未交代）', 暗设: '鬼市主人是天机阁二当家。' } },
    { title: '阿昭', category: '', keywords: [], brief: '人', body: { 概要: '人。', 规则与边界: '', 现状: '', 暗设: '' } },
  ],
  questions: [QUESTION, '二当家知不知道阁主的身世？'],
};

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

const payload = (over) => ({ text: '', targetNo: 3, attachments: [], excludedIds: [], ...over });

/** 在第 3 章细纲上讨论一句（模型答 `reply`）。 */
async function discuss(text, reply) {
  fake.reset([{ text: reply, stop: 'end' }]);
  await controller.handle({ type: 'send', payload: payload({ text, stage: 'plot', capability: 'discuss', target: PLOT3 }) });
}

/** `/落定设定`：模型答 `answer`（字符串或一串）。 */
async function settle(answer, text = '') {
  posted.length = 0;
  gates = [];
  h.expect();
  fake.reset((Array.isArray(answer) ? answer : [answer]).map((a) => ({ text: typeof a === 'string' ? a : JSON.stringify(a), stop: 'end' })));
  await controller.handle({ type: 'send', payload: payload({ text, stage: 'setting', capability: 'settle', target: LORE_DIR }) });
  project.invalidate();
  return gates[0];
}

const read = (rel) => t.read(rel);
const listLore = async () => {
  project.invalidate();
  return project.listLore();
};
const toasts = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    session: './src/core/model/session.ts',
    generate: './src/core/generation/generate.ts',
    lore: './src/core/features/lore.ts',
    fs: './src/core/model/fs.ts',
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
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'loreSettle', title: '天机录' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ngenre: 武侠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n江湖消息都从天机阁买。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿。\n');
  // 作者写过的：明面、暗设都有，整合到了第 1 章。
  t.write(
    TJG,
    entry('天机阁', {
      keywords: ['天机阁', '阁里'],
      brief: '卖消息的楼',
      body: '## 概要\n作者写的：七层楼。\n\n## 暗设\n作者写的：阁主是前朝太子。',
      through: 1,
    })
  );
  // 只有一句话（细纲带出来的空条目）。
  t.write(JCL, entry('九层楼', { brief: '天机阁的藏书楼' }));
  t.write('.novelforge/lore/宗门/青云宗.md', entry('青云宗', { brief: '正道第一宗', body: '## 概要\n剑修。' }));
  fs.mkdirSync(path.join(t.dir, '.novelforge/lore/地域'), { recursive: true });

  t.write(CH(1), '# 第1章\n\n第1章的正文。\n');
  project.invalidate();
  const chapters = await project.listChapters();
  t.write(PLOT(1), plotText(1, { hash: chapters[0].contentHash, lore: '- 天机阁〔宗门〕：一问一价' }));
  t.write(PLOT(3), plotText(3, { synopsis: '林昭夜入九层楼。' }));
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
  await controller.handle({ type: 'setTarget', target: PLOT3 });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('拦下：一句都没聊过', () => {
  test('输入框也空着：不调模型、不记一轮，说清为什么', async () => {
    const before0 = controller.current.turns.length;
    await settle(SETTLED);
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('这个对话里还没有讨论')), toasts().join('|'));
    assert.deepEqual(controller.current.target, PLOT3);
  });
});

describe('落定', () => {
  let gate;
  let built;
  before(async () => {
    await discuss('天机阁要立规矩：一问一价，问阁主身世的不答。再加一个鬼市，子时开张。', '好的。天机阁的阁规就这么定；鬼市只收现银。');
    gate = await settle(SETTLED);
    built = fake.calls[0];
  });

  test('一次调用；命令记成「落定设定」；落完回到第 3 章的细纲', () => {
    assert.equal(fake.callCount(), 1);
    const userTurn = controller.current.turns.filter((x) => x.role === 'user').at(-1);
    assert.equal(userTurn.command, '落定设定');
    assert.equal(userTurn.settleLore, true);
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
    assert.equal(controller.current.capability, 'discuss');
    const sessions = posted.filter((m) => m.type === 'session');
    assert.deepEqual(sessions.at(-1).session.target, PLOT3);
  });

  test('装配：系统提示是落定设定那一份；讨论作为多轮消息带着', () => {
    const system = built[0].content;
    assert.ok(system.includes('这一次只把讨论里已经定下来的设定落成条目'), system.slice(0, 300));
    assert.ok(!system.includes('你和作者刚讨论完这一章'), system);
    assert.ok(built.some((m) => m.role === 'user' && m.content.startsWith('天机阁要立规矩')), JSON.stringify(built.map((m) => m.role)));
    assert.ok(built.some((m) => m.role === 'assistant' && m.content.includes('鬼市只收现银')));
  });

  test('装配：讨论里提到的已有条目整条带（含暗设），没提到的一行；合同是落定那一份', () => {
    const user = built[built.length - 1].content;
    assert.ok(user.includes('作者写的：七层楼。'), user.slice(0, 2000));
    assert.ok(user.includes('暗设（读者还不知道）') && user.includes('作者写的：阁主是前朝太子。'), user.slice(0, 2000));
    assert.ok(user.includes('- 青云宗〔宗门〕：正道第一宗'), user.slice(0, 2000));
    assert.ok(user.includes('【不可变落定设定 JSON 合同】'), user.slice(-1500));
    assert.ok(!user.includes('【设定清单合同】'));
  });

  test('装配明细：命中的来源写的是「讨论里提到」', () => {
    const turn = controller.current.turns.filter((x) => x.role === 'assistant').at(-1);
    const item = turn.context.items.find((i) => i.label === '设定 · 天机阁');
    assert.equal(item.status, 'included');
    assert.ok(item.note.includes('讨论里提到「天机阁」'), item.note);
  });

  test('卡片：落到设定名录；会新建、会更新、还没定的都列出来；人名丢掉写进说明', () => {
    assert.ok(gate, toasts().join('|'));
    assert.ok(gate.title.includes('「设定名录」') && gate.title.includes('写入'), gate.title);
    assert.ok(gate.detail.includes('落定设定 · 3 条（改已有的 2 条）'), gate.detail);
    assert.ok(gate.detail.includes('会新建设定条目：鬼市'), gate.detail);
    assert.ok(gate.detail.includes('会更新设定条目：天机阁、九层楼'), gate.detail);
    assert.ok(gate.detail.includes('还没定的') && gate.detail.includes(`1. ${QUESTION}`), gate.detail);
    assert.ok(gate.detail.includes('「阿昭」是角色卡上的人'), gate.detail);
  });

  test('写过内容的先对比；只有一句话的直接写', () => {
    assert.deepEqual(h.reviewed.map((r) => r.relPath), [TJG]);
    assert.equal(h.reviewed[0].name, '设定「天机阁」');
  });

  test('新的：建在分类目录，记作机器写的，水位 0', async () => {
    const e = (await listLore()).find((x) => x.relPath === GS);
    assert.ok(e, (await listLore()).map((x) => x.relPath).join(','));
    assert.equal(e.title, '鬼市');
    assert.deepEqual(e.keywords, ['鬼市', '夜市']);
    assert.equal(e.brief, '城下的夜市');
    assert.ok(e.body.includes('子时开张的夜市。') && e.body.endsWith('## 暗设\n鬼市主人是天机阁二当家。'), e.body);
    assert.equal(e.updatedThrough, 0);
    assert.ok(bundle.lore.loreOwnedByMachine(e));
  });

  test('已有的：正文换成合并后的，关键词只增不减（人名不收），记作机器写的，水位不动', async () => {
    const e = (await listLore()).find((x) => x.relPath === TJG);
    assert.equal(e.brief, '江湖上卖消息的楼阁');
    assert.deepEqual(e.keywords, ['天机阁', '阁里', '天机楼']);
    assert.ok(e.body.includes('一问一价；问阁主身世的一律不答。') && e.body.includes('二当家也知道。'), e.body);
    assert.equal(e.updatedThrough, 1);
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    const j = (await listLore()).find((x) => x.relPath === JCL);
    assert.ok(j.body.includes('九层，每层一个守楼人。'), j.body);
    assert.equal(j.updatedThrough, undefined);
    assert.ok(!(await listLore()).some((x) => x.title === '阿昭'));
  });

  test('还没定的问题不写进任何工程文件', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const hits = walk(path.join(t.dir, '.novelforge'))
      .filter((f) => !f.includes(`${path.sep}sessions${path.sep}`) && !f.endsWith('.db') && !f.includes(`${path.sep}.history${path.sep}`))
      .filter((f) => fs.readFileSync(f, 'utf8').includes(QUESTION));
    assert.deepEqual(hits, []);
  });

  test('toast 说清建了哪几条、更新了哪几条', () => {
    assert.ok(toasts().some((m) => m.includes('落定设定：新建 1 条设定条目（鬼市），更新 天机阁、九层楼')), toasts().join('|'));
  });
});

describe('放弃与重来', () => {
  after(() => h.setReviewVerdict('apply'));

  test('覆盖审阅里放弃了那一条原样留着，别的照写', async () => {
    const before1 = read(TJG);
    h.setReviewVerdict('discard');
    await settle({
      entries: [
        { ...SETTLED.entries[0], body: { ...SETTLED.entries[0].body, 现状: '天机阁被烧了。' } },
        { title: '黑水渡', category: '地域', keywords: [], brief: '鬼市的渡口', body: { 概要: '渡口。', 规则与边界: '', 现状: '', 暗设: '' } },
      ],
      questions: [],
    }, '再定一个黑水渡');
    assert.equal(read(TJG), before1);
    assert.ok(fs.existsSync(path.join(t.dir, '.novelforge/lore/地域/黑水渡.md')));
    assert.ok(toasts().some((m) => m.includes('保留原样的 天机阁')), toasts().join('|'));
  });

  test('重来：会话已经回到第 3 章，照样换到设定目录跑一轮，再回来', async () => {
    const userTurn = controller.current.turns.filter((x) => x.role === 'user').at(-1);
    assert.equal(userTurn.settleLore, true);
    assert.deepEqual(controller.current.target, PLOT3);
    gates = [];
    h.expect();
    fake.reset([{ text: JSON.stringify({ entries: [], questions: [] }), stop: 'end' }]);
    await controller.handle({ type: 'retry', turnId: userTurn.id, payload: payload({ stage: 'plot', capability: 'discuss', target: PLOT3 }) });
    assert.equal(fake.callCount(), 1);
    assert.ok(fake.calls[0][0].content.includes('这一次只把讨论里已经定下来的设定落成条目'));
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
  });
});

describe('拦下：解析不了、一条都没定', () => {
  test('解析不了：没有卡片、不写入、失败说清；照样回到原来的目标', async () => {
    const before2 = read(TJG);
    const gate = await settle('我觉得天机阁还可以再想想……');
    assert.equal(gate, undefined);
    assert.equal(read(TJG), before2);
    const turn = controller.current.turns.at(-1);
    assert.ok(turn.error && turn.error.includes('落定设定解析不出来'), turn.error);
    assert.deepEqual(controller.current.target, PLOT3);
  });

  test('JSON 语法坏了修一次（只改标点）：一共 2 次', async () => {
    const broken = '{"entries":[{"title":"乱葬岗","category":"地域","keywords":[],"brief":"城外" "body":{"概要":"城外的坟地。"}}],"questions":[]}';
    const fixed = '{"entries":[{"title":"乱葬岗","category":"地域","keywords":[],"brief":"城外", "body":{"概要":"城外的坟地。"}}],"questions":[]}';
    const gate = await settle([broken, fixed]);
    assert.equal(fake.callCount(), 2);
    assert.ok(gate.detail.includes('修了一次（只改标点）') && gate.detail.includes('一共调了 2 次模型'), gate.detail);
    assert.ok(fs.existsSync(path.join(t.dir, '.novelforge/lore/地域/乱葬岗.md')));
  });

  test('一条都没定下来：没有卡片、不算失败，气泡里说清并列出还没定的', async () => {
    const gate = await settle({ entries: [], questions: [QUESTION] });
    assert.equal(gate, undefined);
    const turn = controller.current.turns.at(-1);
    assert.equal(turn.error, undefined);
    assert.ok(turn.content.startsWith('讨论里还没有定下来的设定') && turn.content.includes(`1. ${QUESTION}`), turn.content);
    assert.equal(turn.artifact, undefined);
  });
});

describe('会话', () => {
  test('存下的落定草稿读回来还是落定设定，不是设定清单', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: LORE_DIR });
    session.stage = 'setting';
    session.capability = 'settle';
    session.drafts = [
      { id: 'd1', action: { stage: 'setting', capability: 'settle' }, target: LORE_DIR, raw: '{}', words: 0, createdAt: new Date().toISOString() },
    ];
    await store.write(session);
    const back = await store.read(session.id);
    assert.equal(back.capability, 'settle');
    assert.deepEqual(back.drafts[0].action, { stage: 'setting', capability: 'settle' });
    const art = bundle.generate.parseDraftArtifact(back.drafts[0].action, JSON.stringify(SETTLED), back.drafts[0].target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.settle, true);
  });

  test('别的架构文档上记着 settle 的会话读回来是讨论', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: { kind: 'setting', doc: 'world' } });
    session.stage = 'setting';
    session.capability = 'settle';
    await store.write(session);
    assert.equal((await store.read(session.id)).capability, 'discuss');
  });
});
