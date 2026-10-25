/**
 * 展开一条设定（完善设定，2026-10-19，设计稿 §1、§3）：经对话页从装配一路走到落盘。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 原料 | views/loreMaterial.ts：计划只认没定稿的细纲（「设定」一节按名录同一张表认，关键词也算），记录只认定稿过的；水位停在第一处没定稿的章之前；路径上没有文件时按路径拼一条空的 |
 * | 装配 | 这一条整份带（含暗设，标明读者还不知道）；已排细纲里用到它的那几句与定稿过的记录带章号；相关条目去掉它自己，关键词命中的整条、同目录的一行；不按正文「整理」；合同是展开那一份，不是设定清单 |
 * | 原料封顶 | 计划与定稿记录合计封顶，放不下的写进明细（第 2 条） |
 * | 只有一句话的直接写 | 右键「展开…」先问要求再发一轮生成；卡片列出会建的子条目与还没定的问题；正文、一句话换新，关键词只增不减，记作机器写的，水位同整合；子条目建空条目；问题不写进任何文件 |
 * | 作者写过的先对比 | 有内容（含只写了暗设）的走覆盖审阅；放弃了一个字不动、子条目也不建 |
 * | 只给名字 | 先在分类目录下建空条目再展开；是人名就报错、不问不建；取消就什么都不做 |
 * | 路径上还没有文件 | 按路径新建、标题取文件名；是人名的不建 |
 * | 解析不了 | 没有卡片、不写入、失败挂在这一条上；语法坏了交给转写理顺（共 2 次） |
 * | 按格式写、转写成 JSON | 2026-10-25 起按小标题写，转写模型照抄成 JSON：转写只带合同与原文；两次都改字就不给写入，原文留在气泡里 |
 * | 单章细纲建空条目 | `isNew` 的新设定随单章细纲建空条目，卡片上先列出来（§3） |
 * | 会话 | 存下的草稿目标读回来还是这一条，不是整批设定清单 |
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
const CJG = '.novelforge/lore/宗门/藏经阁.md';

function plotText(no, { hash, synopsis = '往下查。', events = '- 有事发生', facts = '', lore = '' } = {}) {
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
    events,
    '',
    '## 连续性事实',
    '',
    facts || '（待补充）',
    '',
    '## 设定',
    '',
    lore || '（无）',
    '',
  ].join('\n');
}

function entry(title, { keywords = [title], brief = '', body = '' } = {}) {
  return ['---', `title: ${title}`, `keywords: [${keywords.join(', ')}]`, ...(brief ? [`brief: ${brief}`] : []), '---', '', `# ${title}`, '', body, ''].join('\n');
}

const EXPANSION = {
  brief: '江湖上卖消息的楼阁',
  keywords: ['天机楼', '林昭', '阁规'],
  body: {
    概要: '一座卖消息的七层楼，立在青崖镇北。',
    规则与边界: '一问一价，不问来者；问到阁主身世的，一律不答。',
    现状: '阁主闭关，由二当家打理。',
    暗设: '阁主是前朝太子，楼下密道通往皇陵。',
  },
  children: [
    { name: '阁规', category: '制度', brief: '天机阁的十条规矩' },
    { name: '青云宗', category: '宗门', brief: '已有条目' },
    { name: '林昭', category: '', brief: '人' },
  ],
  questions: ['阁规是成文的还是口传的？', '二当家知不知道阁主的身世？'],
};
const QUESTION = '二当家知不知道阁主的身世？';

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

/**
 * 右键「展开…」：`answers` 是问要求那一句的回答（undefined = 取消）。答了要求，接着的确认框缺省点「开始展开」；
 * 要测确认框的另传 `confirm`（undefined = 取消，`{ action, choice }` = 换了模型）。
 */
async function expand(msg, ...answers) {
  const [ask] = answers;
  const confirm = answers.length > 1 ? answers[1] : '开始展开';
  posted.length = 0;
  gates = [];
  h.expect(...(answers.length === 0 ? [] : ask === undefined ? [undefined] : [ask, confirm]));
  await controller.handle({ type: 'expandLore', ...msg });
  project.invalidate();
  return gates[0];
}

const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const systemOf = (i) => fake.calls[i][0].content;
const read = (rel) => t.read(rel);
const listLore = async () => {
  project.invalidate();
  return project.listLore();
};

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    builder: './src/core/context/builder.ts',
    session: './src/core/model/session.ts',
    lore: './src/core/features/lore.ts',
    material: './src/core/views/loreMaterial.ts',
    fs: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  // 多配一个 strong：确认框上为这一轮换它。对话页选定的（`models` 首项）仍是 m。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'strong', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'loreExpand', title: '天机录' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ngenre: 武侠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n江湖消息都从天机阁买。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿。\n');
  // 只有一句话（细纲带出来的空条目）。
  t.write(TJG, entry('天机阁', { keywords: ['天机阁', '阁里'], brief: '卖消息的楼' }));
  // 作者写过的：明面一句、暗设一句。
  t.write(CJG, entry('藏经阁', { brief: '青云宗藏书处', body: '## 概要\n作者写的：藏书三万卷。\n\n## 暗设\n作者写的：底层藏着魔功。' }));
  t.write('.novelforge/lore/宗门/青云宗.md', entry('青云宗', { brief: '正道第一宗', body: '剑修。' }));
  t.write('.novelforge/lore/地域/九层楼.md', entry('九层楼', { brief: '天机阁的藏书楼', body: '九层，每层一个守楼人。' }));
  t.write('.novelforge/lore/地域/后山.md', entry('后山', { brief: '后山禁地', body: '有阵法。' }));
  t.write('.novelforge/lore/秘药.md', entry('秘药', { brief: '只写了暗设', body: '## 暗设\n作者写的：秘药是毒。' }));
  fs.mkdirSync(path.join(t.dir, '.novelforge/lore/制度'), { recursive: true });

  for (let no = 1; no <= 2; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  const hashOf = (no) => chapters.find((c) => c.order === no).contentHash;
  t.write(PLOT(1), plotText(1, { hash: hashOf(1), lore: '- 天机阁〔宗门〕：一问一价', facts: '- 林昭在天机阁买了第一条消息' }));
  t.write(PLOT(2), plotText(2, { hash: hashOf(2), events: '- 林昭再去天机阁，被拒之门外。' }));
  // 没定稿（还没写正文）的计划：展开要为它服务。
  t.write(
    PLOT(3),
    plotText(3, {
      synopsis: '林昭夜入天机阁，直奔九层楼。',
      events: '- 林昭在九层楼下见到二当家。\n- 二当家要价一条命。',
      lore: '- 天机阁〔宗门〕：林昭在此买阁主的消息\n- 九层楼〔地域〕',
    })
  );
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail: 3,
});

function build(relPath, extra = {}) {
  return bundle.builder.buildContext(
    project,
    { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'lore', relPath }, ask: '', targetNo: 1, ...extra },
    config()
  );
}

describe('原料（views/loreMaterial）', () => {
  test('计划：没定稿的细纲里「设定」一节点名它的（写的是关键词也算）与提到它的句子；记录：只认定稿过的', async () => {
    t.write(PLOT(6), plotText(6, { synopsis: '没有提到。', lore: '- 阁里：二当家坐镇' }));
    project.invalidate();
    try {
      const { entry } = await bundle.material.loreEntryAt(project, TJG);
      const { uses, records } = await bundle.material.expansionMaterial(project, entry);
      assert.deepEqual(
        uses.map((u) => [u.no, u.where, u.text]),
        [
          [3, '设定', '天机阁：林昭在此买阁主的消息'],
          [3, '梗概', '林昭夜入天机阁，直奔九层楼。'],
          [6, '设定', '阁里：二当家坐镇'],
        ]
      );
      assert.deepEqual(records.map((f) => [f.no, f.text]), [
        [1, '一问一价'],
        [1, '林昭在天机阁买了第一条消息'],
        [2, '林昭再去天机阁，被拒之门外。'],
      ]);
    } finally {
      fs.rmSync(path.join(t.dir, PLOT(6)));
      project.invalidate();
    }
  });

  test('水位停在第一处没定稿的章之前；路径上没有文件时按路径拼一条空的', async () => {
    assert.equal(await bundle.material.integrationWatermark(project), 2);
    const missing = await bundle.material.loreEntryAt(project, '.novelforge/lore/地域/鬼门关.md');
    assert.equal(missing.exists, false);
    assert.equal(missing.entry.title, '鬼门关');
    assert.equal(missing.entry.category, '地域');
    assert.equal(missing.entry.body, '');
  });
});

describe('装配', () => {
  let b;
  let user;
  before(async () => {
    b = await build(TJG);
    user = b.messages[b.messages.length - 1].content;
  });

  test('系统提示与合同是展开那一份，不借设定清单、不按正文「整理」', () => {
    assert.ok(b.messages[0].content.includes('这一次只管一条设定：把它往前想细'), b.messages[0].content.slice(0, 300));
    // 2026-10-25 起按小标题写，不写 JSON（JSON 合同挪给转写那一步）。
    assert.ok(user.includes('【展开格式】') && user.includes('不写 JSON') && !user.includes('{"brief"'), user.slice(-1500));
    assert.ok(user.includes('2–5 条还没定、要作者拍板的问题'));
    assert.ok(!user.includes('【设定清单格式】') && !user.includes('# 已写正文'), user.slice(-3000));
    assert.ok(!b.messages[0].content.includes('不补完、不推测'));
  });

  test('这一条整份带：一句话、关键词、还只有一句话的说明', () => {
    const self = b.items.find((i) => i.kind === 'loreSelf');
    assert.equal(self.status, 'included');
    assert.equal(self.source, TJG);
    assert.ok(self.text.includes('【天机阁〔宗门〕】') && self.text.includes('一句话：卖消息的楼') && self.text.includes('关键词：天机阁、阁里'), self.text);
    assert.ok(self.note.includes('还只有一句话'), self.note);
    assert.ok(user.includes('# 当前这一条设定'), user.slice(-3000));
  });

  test('已排细纲里用到它的地方：「设定」一节那一行与提到它的句子，带章号；定稿过的不算计划', () => {
    const plan = b.items.find((i) => i.kind === 'lorePlan');
    assert.ok(plan.text.includes('第 3 章《第3章》（设定）：天机阁：林昭在此买阁主的消息'), plan.text);
    assert.ok(plan.text.includes('第 3 章《第3章》（梗概）：林昭夜入天机阁，直奔九层楼。'), plan.text);
    assert.ok(!plan.text.includes('二当家要价一条命'), plan.text);
    assert.ok(!plan.text.includes('第 2 章'), plan.text);
    assert.ok(user.includes('# 已排细纲里用到它的地方'));
  });

  test('定稿过的记录：「设定」一节那一句、连续性事实、提到它的句子，带章号', () => {
    const rec = b.items.find((i) => i.kind === 'loreRecord');
    assert.ok(rec.text.includes('- 第 1 章：一问一价'), rec.text);
    assert.ok(rec.text.includes('- 第 1 章：林昭在天机阁买了第一条消息'), rec.text);
    assert.ok(rec.text.includes('- 第 2 章：林昭再去天机阁，被拒之门外。'), rec.text);
    assert.ok(user.includes('# 定稿过的记录（已经写进正文的事实，不能推翻）'));
  });

  test('相关条目：不带它自己；用到它的句子里提到的整条带；同目录的一行带；不相干的不带；给分类表', () => {
    const lore = b.items.filter((i) => i.kind === 'lore');
    const by = (title) => lore.find((i) => i.label === `设定 · ${title}`);
    assert.equal(by('天机阁'), undefined);
    assert.ok(by('九层楼').text.includes('九层，每层一个守楼人。'), by('九层楼').text);
    assert.ok(by('九层楼').note.includes('上下文中出现「九层楼」'), by('九层楼').note);
    assert.equal(by('青云宗').text, '- 青云宗〔宗门〕：正道第一宗');
    assert.equal(by('藏经阁').text, '- 藏经阁〔宗门〕：青云宗藏书处');
    assert.equal(by('后山'), undefined);
    assert.ok(lore.some((i) => i.id === 'lore:categories'));
  });

  test('作者写过暗设的：暗设整份带、标明读者还不知道', async () => {
    const b2 = await build(CJG);
    const self = b2.items.find((i) => i.kind === 'loreSelf');
    assert.ok(self.text.includes('作者写的：藏书三万卷。') && self.text.includes('作者写的：底层藏着魔功。'), self.text);
    assert.ok(self.text.includes('暗设（读者还不知道）'), self.text);
    assert.equal(self.note, undefined);
  });

  test('目标不是单条设定时那两层什么都不带', async () => {
    const b3 = await bundle.builder.buildContext(
      project,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' },
      config()
    );
    assert.ok(!b3.items.some((i) => ['loreSelf', 'lorePlan', 'loreRecord'].includes(i.kind)));
  });
});

describe('原料封顶', () => {
  test('计划超了封顶只带前几行，写明带到第几章（第 2 条）', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `- 林昭第 ${i + 1} 次在天机阁打听那桩旧案，二当家照例只收一半的价钱。`).join('\n');
    t.write(PLOT(4), plotText(4, { events: long }));
    project.invalidate();
    try {
      const b = await build(TJG);
      const plan = b.items.find((i) => i.kind === 'lorePlan');
      assert.equal(plan.status, 'degraded');
      assert.ok(/计划与同步记录合计封顶 6000 token，只带了前 \d+ 行（到第 \d 章），第 4 章起的没带/.test(plan.note), plan.note);
      assert.ok(plan.text.includes('第 3 章《第3章》（设定）'), plan.text.slice(0, 200));
      const rec = b.items.find((i) => i.kind === 'loreRecord');
      assert.equal(rec.status, 'included');
    } finally {
      fs.rmSync(path.join(t.dir, PLOT(4)));
      project.invalidate();
    }
  });
});

describe('只有一句话的：直接写', () => {
  let gate;
  let before1;
  before(async () => {
    fake.reset([{ text: JSON.stringify(EXPANSION), stop: 'end' }]);
    before1 = read(TJG);
    gate = await expand({ relPath: TJG }, '阁规要严一些');
  });

  test('先问一句要求（报调用次数），再发一轮生成：1 次，作者的话进上下文', () => {
    assert.equal(h.inputs.length, 1);
    assert.ok(h.inputs[0].title.includes('天机阁') && h.inputs[0].prompt.includes('预计 2 次调用，最多 3 次'), JSON.stringify(h.inputs[0]));
    assert.equal(fake.callCount(), 1);
    assert.ok(userOf(0).includes('阁规要严一些'));
    assert.ok(systemOf(0).includes('把它往前想细'));
  });

  test('问完要求再弹确认框：报次数，模型缺省是对话页那个，带详细度下拉框', () => {
    assert.equal(h.confirms.length, 1);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['开始展开']);
    assert.ok(c.message.includes('展开设定「天机阁」') && c.message.includes('预计 2 次调用，最多 3 次'), c.message);
    assert.equal(c.call.model, 'p/m');
    // 转写不跟这一次挑的模型：单列一行（2026-10-25 起）。
    assert.ok(c.call.fixed?.some((line) => line.includes('转写')), JSON.stringify(c.call));
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
    assert.equal(fake.calls[0].ref, 'p/m');
  });

  test('对话页的目标换成这一条，命令记成「展开这条设定」', () => {
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: TJG });
    assert.equal(controller.current.stage, 'setting');
    const userTurn = controller.current.turns.find((x) => x.role === 'user');
    assert.equal(userTurn.command, '展开这条设定');
  });

  test('卡片：形状、会新建的子条目（已有的、人名丢掉）、还没定的问题；不说会覆盖', () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.title.includes('设定 · 天机阁') && gate.title.includes('写入'), gate.title);
    assert.ok(gate.detail.includes('设定 · 天机阁 · 展开 3/3 节 + 暗设 · 拆出 1 条 · 还没定的 2 问'), gate.detail);
    assert.ok(gate.detail.includes('会新建设定条目：阁规'), gate.detail);
    assert.ok(gate.detail.includes(`还没定的`) && gate.detail.includes(`2. ${QUESTION}`), gate.detail);
    assert.ok(gate.detail.includes('「青云宗」已经有条目了') && gate.detail.includes('「林昭」是角色卡上的人'), gate.detail);
    assert.ok(!gate.detail.includes('那里已经有内容了'), gate.detail);
  });

  test('没走覆盖审阅（原来只有一句话）', () => {
    assert.equal(h.reviewed.length, 0);
    assert.notEqual(read(TJG), before1);
  });

  test('正文与一句话换新；关键词只增不减，人名、子条目不收；记作机器写的；水位同整合', async () => {
    const e = (await listLore()).find((x) => x.relPath === TJG);
    assert.equal(e.brief, '江湖上卖消息的楼阁');
    assert.deepEqual(e.keywords, ['天机阁', '阁里', '天机楼']);
    assert.ok(e.body.startsWith('## 概要\n一座卖消息的七层楼'), e.body);
    assert.ok(e.body.endsWith('## 暗设\n阁主是前朝太子，楼下密道通往皇陵。'), e.body);
    assert.ok(bundle.lore.loreOwnedByMachine(e));
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    assert.equal(e.updatedThrough, 2);
  });

  test('子条目建成空条目，放在分类目录里', async () => {
    const child = (await listLore()).find((x) => x.title === '阁规');
    assert.equal(child.relPath, '.novelforge/lore/制度/阁规.md');
    assert.equal(child.brief, '天机阁的十条规矩');
    assert.deepEqual(child.keywords, ['阁规']);
    assert.equal(child.body.trim(), '');
    assert.equal((await listLore()).filter((x) => x.title === '青云宗').length, 1);
  });

  test('还没定的问题不写进任何工程文件', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const hits = walk(path.join(t.dir, '.novelforge'))
      .filter((f) => !f.includes(`${path.sep}sessions${path.sep}`) && !f.endsWith('.db') && !f.includes(`${path.sep}.history${path.sep}`))
      .filter((f) => fs.readFileSync(f, 'utf8').includes(QUESTION));
    assert.deepEqual(hits, []);
  });

  test('toast 说清展开了哪一条、建了哪几条', () => {
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('已展开设定「天机阁」') && m.includes('阁规')), toasts.join('|'));
  });
});

describe('作者写过的：先对比', () => {
  let before2;
  after(() => h.setReviewVerdict('apply'));

  test('有内容的走覆盖审阅；放弃了一个字不动，子条目也不建', async () => {
    before2 = read(CJG);
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [{ name: '魔功', category: '功法', brief: '藏在底层的功法' }] }), stop: 'end' }]);
    h.setReviewVerdict('discard');
    const gate = await expand({ relPath: CJG }, '');
    assert.ok(gate.detail.includes('那里已经有内容了'), gate.detail);
    assert.ok(gate.title.includes('覆盖'), gate.title);
    assert.deepEqual(h.reviewed.map((r) => r.relPath), [CJG]);
    assert.equal(h.reviewed[0].name, '设定「藏经阁」');
    assert.equal(read(CJG), before2);
    assert.ok(!(await listLore()).some((x) => x.title === '魔功'));
  });

  test('采纳了才写，覆盖审阅里看得到原来的内容', async () => {
    h.setReviewVerdict('apply');
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ relPath: CJG }, '');
    assert.equal(h.reviewed.length, 1);
    assert.ok(h.reviewed[0].current.includes('作者写的：藏书三万卷。'));
    assert.ok(read(CJG).includes('一座卖消息的七层楼'));
  });

  // 明面是空的，但作者写过暗设：直接写会吞掉那一句，所以也先对比。
  test('只写了暗设的也先对比', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    const gate = await expand({ relPath: '.novelforge/lore/秘药.md' }, '');
    assert.ok(gate.detail.includes('那里已经有内容了'), gate.detail);
    assert.deepEqual(h.reviewed.map((r) => r.relPath), ['.novelforge/lore/秘药.md']);
  });

  // 条目早就整合到了更后面（之后前面某章正文又改过、整合水位停在了那里）：展开不能把它拉回去，
  // 不然已经并进条目的那些章又挂上 ＋N。
  test('水位只往前推不往回退', async () => {
    const QYZ = '.novelforge/lore/宗门/青云宗.md';
    const text = read(QYZ).replace('title: 青云宗\n', 'title: 青云宗\nupdatedThrough: 9\n');
    t.write(QYZ, text);
    project.invalidate();
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ relPath: QYZ }, '');
    const e = (await listLore()).find((x) => x.relPath === QYZ);
    assert.equal(e.updatedThrough, 9);
  });
});

describe('只给名字', () => {
  test('先在分类目录下建空条目再展开', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '暗河', category: '地域' }, '');
    const e = (await listLore()).find((x) => x.title === '暗河');
    assert.equal(e.relPath, '.novelforge/lore/地域/暗河.md');
    assert.ok(e.body.includes('一座卖消息的七层楼'));
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: '.novelforge/lore/地域/暗河.md' });
    assert.ok(h.inputs[0].prompt.includes('会先建一条空条目'), h.inputs[0].prompt);
  });

  test('名字已被已有条目（关键词）占了就展开那一条', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '阁里', category: '地域' }, '');
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: TJG });
    assert.ok(!(await listLore()).some((x) => x.title === '阁里'));
  });

  test('是人名就报错：不问、不建、不调模型', async () => {
    fake.reset([]);
    await expand({ name: '阿昭', category: '地域' });
    assert.equal(h.inputs.length, 0);
    assert.equal(fake.callCount(), 0);
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('人不是设定')), toasts.join('|'));
    assert.ok(!(await listLore()).some((x) => x.title === '阿昭'));
  });

  test('取消就什么都不做：不建空条目、不调模型', async () => {
    fake.reset([]);
    await expand({ name: '鬼市', category: '地域' }, undefined);
    assert.equal(h.inputs.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!(await listLore()).some((x) => x.title === '鬼市'));
  });

  // 确认框问在建空条目之前：在那里取消也不留空条目。
  test('写了要求、在确认框上取消：同样不建空条目、不调模型', async () => {
    fake.reset([]);
    await expand({ name: '鬼市', category: '地域' }, '多写些规矩', undefined);
    assert.equal(h.confirms.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!(await listLore()).some((x) => x.title === '鬼市'));
  });
});

describe('路径上还没有文件（MCP 给了一条新路径）', () => {
  async function sendTo(relPath) {
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await controller.handle({
      type: 'send',
      payload: { text: '', targetNo: 1, attachments: [], excludedIds: [], stage: 'setting', capability: 'generate', target: { kind: 'lore', relPath } },
    });
    project.invalidate();
    return gates[0];
  }

  test('按这个路径新建，标题取文件名，记作机器写的', async () => {
    const gate = await sendTo('.novelforge/lore/地域/鬼门关.md');
    assert.ok(!gate.detail.includes('那里已经有内容了'), gate.detail);
    const e = (await listLore()).find((x) => x.relPath === '.novelforge/lore/地域/鬼门关.md');
    assert.equal(e.title, '鬼门关');
    assert.equal(e.keywords[0], '鬼门关');
    assert.ok(bundle.lore.loreOwnedByMachine(e));
  });

  test('文件名是角色卡上的人就不建', async () => {
    await sendTo('.novelforge/lore/林昭.md');
    assert.ok(!fs.existsSync(path.join(t.dir, '.novelforge/lore/林昭.md')));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('「林昭」是角色卡上的人')), toasts.join('|'));
  });
});

describe('解析不了', () => {
  test('没有卡片、不写入；失败挂在这一条上', async () => {
    const before3 = read('.novelforge/lore/宗门/青云宗.md');
    fake.reset([{ text: '青云宗应该更神秘一些，我建议……', stop: 'end' }]);
    const gate = await expand({ relPath: '.novelforge/lore/宗门/青云宗.md' }, '');
    assert.equal(gate, undefined);
    assert.equal(read('.novelforge/lore/宗门/青云宗.md'), before3);
    const turn = controller.current.turns[controller.current.turns.length - 1];
    assert.ok(turn.error && turn.error.includes('展开解析不出来'), turn.error);
    assert.equal(turn.artifact, undefined);
  });

  test('被截断的不给写入，也不重来', async () => {
    fake.reset([{ text: '{"brief":"正道第一宗","body":{"概要":"剑修', stop: 'maxTokens' }]);
    const gate = await expand({ relPath: '.novelforge/lore/宗门/青云宗.md' }, '');
    assert.equal(gate, undefined);
    assert.equal(fake.callCount(), 1);
  });

  // 2026-10-25 起语法修复那一次换成转写：坏了语法的 JSON 一律交给转写理顺，照抄的收下。
  test('JSON 语法坏了交给转写理顺：一共 2 次', async () => {
    const broken = '{"brief":"正道第一宗","keywords":[],"body":{"概要":"剑修。" "现状":"封山。"},"children":[],"questions":[]}';
    const fixed = '{"brief":"正道第一宗","keywords":[],"body":{"概要":"剑修。", "现状":"封山。"},"children":[],"questions":[]}';
    fake.reset([{ text: broken, stop: 'end' }, { text: fixed, stop: 'end' }]);
    h.setReviewVerdict('apply');
    const gate = await expand({ relPath: '.novelforge/lore/宗门/青云宗.md' }, '');
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(1).includes('格式转写员') && userOf(1).includes('【设定展开 JSON 合同】'), userOf(1).slice(0, 500));
    assert.ok(gate.detail.includes('一共调了 2 次模型'), gate.detail);
    assert.ok(read('.novelforge/lore/宗门/青云宗.md').includes('封山。'));
  });
});

// 2026-10-25 起按小标题写，转写模型照抄成 JSON（features/transcribe.ts）。
describe('按格式写、转写成 JSON', () => {
  const DHD = '.novelforge/lore/地域/断魂渡.md';
  const PROSE = [
    '## 一句话',
    '断魂河上的老渡口',
    '## 关键词',
    '魂渡、老渡',
    '## 概要',
    '断魂河上的老渡口，归船帮。',
    '## 规则与边界',
    '只在子时开船，一船不过七人。',
    '## 现状',
    '（未交代）',
    '## 暗设',
    '船帮帮主是十年前失踪的捕头。',
    '## 子条目',
    '- 船帮（势力）：把持断魂渡的帮会',
    '## 还没定的问题',
    '- 船帮收不收外人？',
  ].join('\n');
  const copied = (rule) =>
    JSON.stringify({
      brief: '断魂河上的老渡口',
      keywords: ['魂渡', '老渡'],
      body: { 概要: '断魂河上的老渡口，归船帮。', 规则与边界: rule, 现状: '（未交代）', 暗设: '船帮帮主是十年前失踪的捕头。' },
      children: [{ name: '船帮', category: '势力', brief: '把持断魂渡的帮会' }],
      questions: ['船帮收不收外人？'],
    });

  before(() => {
    t.write(DHD, entry('断魂渡', { brief: '渡口' }));
    project.invalidate();
  });

  test('写一次、转一次：转写只带合同与原文，照抄的落盘、子条目建空条目', async () => {
    fake.reset([
      { text: PROSE, stop: 'end' },
      { text: copied('只在子时开船，一船不过七人。'), stop: 'end' },
    ]);
    const gate = await expand({ relPath: DHD }, '');
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('把它往前想细') && !systemOf(0).includes('格式转写员'));
    assert.ok(systemOf(1).includes('格式转写员'), systemOf(1));
    assert.ok(userOf(1).includes('【原文】') && userOf(1).includes('只在子时开船，一船不过七人。'), userOf(1));
    assert.ok(!userOf(1).includes('# 定稿过的记录') && !userOf(1).includes('# 相关世界观设定'), userOf(1));
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('一共调了 2 次模型'), gate.detail);
    const text = read(DHD);
    assert.ok(text.includes('只在子时开船，一船不过七人。') && text.includes('## 暗设'), text);
    assert.ok((await listLore()).some((e) => e.title === '船帮'));
  });

  test('转写两次都改了字：不给写入，原文留在气泡里', async () => {
    t.write(DHD, entry('断魂渡', { brief: '渡口' }));
    project.invalidate();
    const before4 = read(DHD);
    const reworded = copied('子时开船，最多载七人。');
    fake.reset([
      { text: PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    const gate = await expand({ relPath: DHD }, '');
    assert.equal(gate, undefined);
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字'), userOf(2).slice(0, 600));
    assert.equal(read(DHD), before4);
    const turn = controller.current.turns[controller.current.turns.length - 1];
    assert.ok(turn.error && turn.error.includes('展开解析不出来'), turn.error);
    assert.ok(turn.content.includes('只在子时开船，一船不过七人。'), turn.content.slice(0, 300));
  });
});

describe('单章细纲建空条目（§3）', () => {
  const blueprint = (no, settings) =>
    JSON.stringify({
      blueprints: [
        {
          chapterNumber: no,
          title: `第${no}章`,
          synopsis: '林昭下暗河。',
          characters: ['林昭'],
          timePlace: '夜，城下',
          keyEvents: ['林昭摸进鬼市。'],
          highlights: ['鬼市开张'],
          foreshadowing: [],
          stateChange: '',
          settings,
        },
      ],
    });

  async function writePlot(no, settings) {
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: blueprint(no, settings), stop: 'end' }]);
    await controller.handle({
      type: 'send',
      payload: { text: '下鬼市', targetNo: no, attachments: [], excludedIds: [], stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: PLOT(no) } },
    });
    project.invalidate();
    return gates[0];
  }

  test('新建一章细纲：isNew 的建空条目，卡片上先列出来；已有的、人名不建', async () => {
    const gate = await writePlot(5, [
      { name: '鬼市', category: '地域', isNew: true, note: '城下的夜市' },
      { name: '天机阁', category: '宗门', isNew: true, note: '已有' },
      { name: '阿昭', category: '', isNew: true, note: '人' },
      { name: '九层楼', category: '地域', isNew: false, note: '' },
    ]);
    assert.ok(gate.detail.includes('会新建设定条目：鬼市'), gate.detail);
    const ghost = (await listLore()).find((x) => x.title === '鬼市');
    assert.equal(ghost.relPath, '.novelforge/lore/地域/鬼市.md');
    assert.equal(ghost.brief, '城下的夜市');
    assert.equal(ghost.body.trim(), '');
    assert.equal((await listLore()).filter((x) => x.title === '天机阁').length, 1);
    assert.ok(read(PLOT(5)).includes('- 鬼市〔地域〕：城下的夜市'));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('新建设定条目：鬼市')), toasts.join('|'));
  });

  test('覆盖已有的那一章细纲时也建', async () => {
    const gate = await writePlot(5, [{ name: '黑水渡', category: '地域', isNew: true, note: '鬼市的渡口' }]);
    assert.ok(gate.detail.includes('会新建设定条目：黑水渡'), gate.detail);
    assert.ok((await listLore()).some((x) => x.relPath === '.novelforge/lore/地域/黑水渡.md'));
  });
});

describe('会话', () => {
  test('存下的展开草稿读回来目标还是这一条，不是整批设定清单', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: { kind: 'lore', relPath: TJG } });
    session.stage = 'setting';
    session.capability = 'generate';
    session.drafts = [
      { id: 'd1', action: { stage: 'setting', capability: 'generate' }, target: { kind: 'lore', relPath: TJG }, raw: '{}', words: 0, createdAt: new Date().toISOString() },
    ];
    await store.write(session);
    const back = await store.read(session.id);
    assert.deepEqual(back.target, { kind: 'lore', relPath: TJG });
    assert.equal(back.stage, 'setting');
    assert.equal(back.capability, 'generate');
    assert.deepEqual(back.drafts[0].target, { kind: 'lore', relPath: TJG });
  });
});

// 对话页这条路认确认框上换的模型（generate 认 `pinnedModel`）：只这一轮，对话页选定的不变。
describe('确认框上换一个模型', () => {
  test('这一轮只用它', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '寒潭', category: '地域' }, '', { action: '开始展开', choice: { model: 'p/strong' } });
    assert.equal(fake.callCount(), 1);
    assert.equal(fake.calls[0].ref, 'p/strong');
  });

  test('下一轮不问的生成照旧用对话页那个（选择不写回设置）', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '寒潭', category: '地域' }, '');
    assert.equal(fake.calls[0].ref, 'p/m');
  });
});
