/**
 * 角色卡与设定的维护改成转写（2026-10-25）：更新角色卡 / 建卡、提取角色、记设定、建条目 / 整合、按目录整理，
 * 干活的模型按格式写自然语言，转写那一档的模型照抄成原来那份 JSON，解码与后处理一行没改。
 *
 * 干活的走各自那一档（这里没配，沿用默认模型 big），转写走「转写」那一档（快速档配的是 small）：两个模型分得清谁干活谁转写。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 更新角色卡 · 照抄收下 | 写一次（不要 JSON，十个小标题）、转一次；转写只带合同与原文；照抄的落进卡里；确认框报「预计 2 次，最多 3 次」、单列转写 |
 * | 更新角色卡 · 改了字 | 不收，重转一次，说清哪几处；重转照抄了就照常写回 |
 * | 更新角色卡 · 转写调用失败 | 同从前解析失败：这一批跳过，卡一个字不改，卡上挂红 ❗ |
 * | 提取角色 | 按人物、小标题写，转写成数组；剧作称谓换成别名里的真名那条后处理照旧 |
 * | 记设定 | 「## 设定」一条一行写，转写成 `{"设定":[…]}`，写进细纲「设定」一节前照旧校验；转写调用失败同从前解析不出来：「设定」一节不动、挂黄 ❗ |
 * | 建条目 | 「一句话 / 关键词 / ## 概要……」写，转写成 `{brief, keywords, body}`，body 是整段 Markdown；重转仍不合格同从前解析不了：这一条重写一次、再转 |
 * | 按目录整理 | 「## 新目录」「## 搬家」写，转写成搬家清单，路径照抄才认得出来 |
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
/** 按模型引用注入异常（fakeProvider 的 behavior）：建 provider 时现读。 */
const behavior = {};

const TRANSCRIBER = '格式转写员';
const CARD = '.novelforge/characters/林昭.md';
const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/00${no}-第${no}章.md`;
const TEXT = [
  '雨下了一整夜。林昭进了青崖镇，镇口的守卫查验过所。',
  '停舟客栈是镇上唯一的客栈，二层木楼。韩厉带人摸进镇口，火把一路烧到客栈门前。',
  '沈氏在柜台后看着他，没说话。林昭只说了一句「知道了」。',
].join('\n\n');

/** 干活那一次各步的原文（按系统提示认）；转写那一次按队列交回。 */
const prose = {};
let transcripts = [];
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    return transcripts.shift() ?? '（转写队列空了）';
  }
  if (system.includes('负责维护一部长篇小说的人物档案')) return prose.card;
  if (system.includes('负责从正文中提取人物档案')) return prose.characters;
  if (system.includes('负责记下这一章正文里出现了哪些设定')) return prose.record;
  if (system.includes('把定稿细纲里关于一个设定的记录整理成一条设定条目')) return prose.entry;
  if (system.includes('负责把设定条目归进合适的目录')) return prose.organize;
  return '（认不出这一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
const lastConfirm = () => h.confirms[h.confirms.length - 1];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    characterCard: './src/core/features/characterCard.ts',
    characters: './src/core/features/characters.ts',
    loreRecord: './src/core/features/loreRecord.ts',
    lore: './src/core/features/lore.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 16000 }, { name: 'small', contextWindow: 16000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    // 记设定缺省也是快速档：挪到均衡档（没配，沿用 big），写的与转写的才分得开。
    taskTiers: { loreScan: 'balanced' },
    contextWindow: 16000,
    maxOutputTokens: 1000,
    concurrency: 1,
  };
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'maintain-transcribe', title: '维护转写' });
  project = t.project;
  t.write(CH(1), `# 第1章\n\n${TEXT}\n`);
  t.write(CARD, '---\nname: 林昭\naliases: []\ntags: []\n---\n\n# 林昭\n\n## 身份\n\n（待补充）\n');
  project.invalidate();
  // 第 1 章定稿过（细纲的 sourceHash 对得上正文）：林昭出场；「设定」一节记过停舟客栈。
  const ch1 = (await project.listChapters()).find((c) => c.order === 1);
  t.write(
    PLOT(1),
    `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch1.contentHash}\ncast: [林昭, 沈氏]\n---\n\n# 第1章 第1章\n\n` +
      '## 梗概\n\n林昭进镇。\n\n## 关键事件\n\n- 林昭住进停舟客栈。\n\n## 设定\n\n- 停舟客栈〔地域〕：镇上唯一的客栈\n'
  );
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

// ---------------------------------------------------------------- 更新角色卡

prose.card = [
  '## 别名',
  '阿昭',
  '## 标签',
  '主角',
  '## 性别',
  '男',
  '## 身份',
  '刚进青崖镇的外乡少年，背着灭门旧案。',
  '## 外貌',
  '无',
  '## 性格',
  '沉默寡言，遇事先藏三分。',
  '## 语言习惯',
  '答话极短，常说「知道了」。',
  '## 人物关系',
  '- 沈氏：客栈掌柜，收留了他',
  '## 当前状态',
  '住在停舟客栈，等天亮。',
  '## 暗设',
  '无',
].join('\n');

const cardJson = (over = {}) =>
  JSON.stringify({
    aliases: ['阿昭'],
    tags: ['主角'],
    性别: '男',
    身份: '刚进青崖镇的外乡少年，背着灭门旧案。',
    外貌: '无',
    性格: '沉默寡言，遇事先藏三分。',
    语言习惯: '答话极短，常说「知道了」。',
    人物关系: '- 沈氏：客栈掌柜，收留了他',
    当前状态: '住在停舟客栈，等天亮。',
    暗设: '',
    ...over,
  });

describe('更新角色卡 · 按小标题写，转写照抄收下', () => {
  let card;

  before(async () => {
    transcripts = [cardJson()];
    fake.reset();
    h.expect('开始');
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    card = t.read(CARD);
  });

  test('写一次、转一次：干活的是 big，转写的是转写那一档的 small', () => {
    assert.equal(fake.callCount(), 2);
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
  });

  test('写角色卡的提示词不要 JSON，十个小标题；字数上限与暗设只做减法照旧', () => {
    const s = systemOf(0);
    assert.ok(s.includes('不写 JSON') && s.includes('## 别名') && s.includes('## 暗设'), s.slice(0, 600));
    assert.ok(s.includes('80 字以内') && s.includes('可以写到 200 字') && s.includes('150 字以内') && s.includes('每条不超过 25 字'), s);
    assert.match(s, /「暗设」是作者定下的、读者还不知道的真相，只做减法/);
    assert.ok(userOf(0).includes('按格式写出完整的档案'), userOf(0).slice(-200));
  });

  test('转写只带合同与原文，不带正文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【角色卡 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('沉默寡言，遇事先藏三分。'), userOf(1));
    assert.ok(!userOf(1).includes('雨下了一整夜'), userOf(1));
  });

  test('照抄的落进卡里；写「无」的那一节空着', () => {
    assert.match(card, /## 性格\n\n沉默寡言，遇事先藏三分。/);
    assert.match(card, /## 人物关系\n\n- 沈氏：客栈掌柜，收留了他/);
    assert.match(card, /阿昭/);
    assert.doesNotMatch(card, /## 外貌\n\n无/);
  });

  test('确认框报写 1 次、转写 1 次，单列转写交给谁', () => {
    const c = h.confirms.find((x) => x.message.includes('次调用'));
    assert.ok(c.message.includes('分 1 批，预计 2 次调用，最多 3 次（写 1 次、转写模型照抄成 JSON 1 次；转写不合格重转 1 次）'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('转写 · 整理成 JSON') && x.includes('不跟这一次挑的模型')), JSON.stringify(c.call));
  });
});

describe('更新角色卡 · 转写改了原文的字', () => {
  let card;

  before(async () => {
    transcripts = [cardJson({ 性格: '冷静克制，城府很深。' }), cardJson()];
    fake.reset();
    h.expect('开始');
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    card = t.read(CARD);
  });

  test('不收，重转一次，说清哪几处不是原文里的字；重转照抄了就照常写回', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「冷静克制，城府很深。」'), userOf(2).slice(0, 600));
    assert.match(card, /沉默寡言，遇事先藏三分。/);
    assert.doesNotMatch(card, /冷静克制/);
  });
});

describe('更新角色卡 · 转写调用失败', () => {
  let before1;
  let after1;
  let marks;

  before(async () => {
    t.write(CARD, '---\nname: 林昭\naliases: []\ntags: []\n---\n\n# 林昭\n\n## 身份\n\n旧的身份\n');
    project.invalidate();
    before1 = t.read(CARD);
    behavior['p/small'] = 'fail';
    try {
      transcripts = [];
      fake.reset();
      h.expect('开始');
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      delete behavior['p/small'];
    }
    after1 = t.read(CARD);
    marks = (await bundle.errorLog.listActiveFailures(project))[CARD] ?? [];
  });

  test('同从前解析失败：这一批跳过，卡一个字不改，卡上挂红 ❗，说清是转写调用失败', () => {
    assert.equal(after1, before1);
    assert.ok(marks.some((m) => m.severity === 'error' && m.message.includes('解析失败')), JSON.stringify(marks));
    assert.ok(marks.some((m) => (m.detail ?? '').includes('转写调用失败')), JSON.stringify(marks));
  });
});

// ---------------------------------------------------------------- 提取角色

prose.characters = [
  '## 韩厉',
  '### 别名',
  '无',
  '### 标签',
  '反派',
  '### 性别',
  '男',
  '### 身份',
  '黑风寨寨主，带人夜袭青崖镇。',
  '### 外貌',
  '无',
  '### 性格',
  '多疑，下手狠。',
  '### 语言习惯',
  '无',
  '### 人物关系',
  '无',
  '### 当前状态',
  '带人摸进镇口。',
  '### 暗设',
  '无',
  '',
  '## 反派',
  '### 别名',
  '韩厉、头领',
  '### 标签',
  '反派',
  '### 性别',
  '男',
  '### 身份',
  '黑风寨头领',
  '### 外貌',
  '无',
  '### 性格',
  '无',
  '### 语言习惯',
  '无',
  '### 人物关系',
  '无',
  '### 当前状态',
  '无',
  '### 暗设',
  '无',
].join('\n');

describe('提取角色 · 按人物、小标题写，转写成数组', () => {
  let card;
  let files;

  before(async () => {
    transcripts = [
      JSON.stringify([
        { name: '韩厉', aliases: [], tags: ['反派'], 性别: '男', 身份: '黑风寨寨主，带人夜袭青崖镇。', 性格: '多疑，下手狠。', 当前状态: '带人摸进镇口。' },
        { name: '反派', aliases: ['韩厉', '头领'], tags: ['反派'], 性别: '男', 身份: '黑风寨头领' },
      ]),
    ];
    fake.reset();
    h.expect('1', '开始提取');
    await bundle.characters.extractCharacters(project);
    project.invalidate();
    card = (await project.listCharacters()).find((c) => c.name === '韩厉');
    files = (await project.listCharacters()).map((c) => c.name);
  });

  test('写一次、转一次；写的提示词不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不写 JSON') && systemOf(0).includes('### 别名'), systemOf(0).slice(0, 400));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【人物档案 JSON 合同】') && userOf(1).includes('黑风寨寨主'), userOf(1));
    assert.equal(refOf(1), 'p/small');
  });

  test('确认框报写 1 次、转写 1 次', () => {
    const c = h.confirms.find((x) => x.actions.includes('开始提取'));
    assert.ok(c.message.includes('预计 2 次调用，最多 3 次'), c.message);
  });

  test('照抄的建成卡；剧作称谓换成别名里的真名、并成一条（后处理照旧）', () => {
    assert.ok(card, files.join('、'));
    assert.ok(!files.includes('反派'), files.join('、'));
    assert.equal(card.sections.性格, '多疑，下手狠。');
    assert.equal(card.gender, '男');
    assert.ok(card.aliases.includes('头领') && card.tags.includes('反派'), JSON.stringify(card));
  });
});

// ---------------------------------------------------------------- 记设定

prose.record = ['## 设定', '- 停舟客栈（地域）：镇上唯一的客栈，二层木楼', '- 过所（制度）', '- 黑市（地点）'].join('\n');

describe('记设定 · 一条一行写，转写成 {"设定":[…]}', () => {
  let plot;

  before(async () => {
    transcripts = [
      JSON.stringify({
        设定: [
          { name: '停舟客栈', category: '地域', fact: '镇上唯一的客栈，二层木楼' },
          { name: '过所', category: '制度', fact: '' },
          { name: '黑市', category: '地点', fact: '' },
        ],
      }),
    ];
    fake.reset();
    h.expect('开始记');
    await bundle.loreRecord.recordLore(project, CH(1));
    project.invalidate();
    plot = await project.getPlot(1);
  });

  test('写一次、转一次；写的提示词不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
    assert.ok(systemOf(0).includes('不写 JSON') && systemOf(0).includes('「名字（分类）：说明」'), systemOf(0).slice(0, 600));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【设定 JSON 合同】') && userOf(1).includes('二层木楼'), userOf(1));
  });

  test('确认框报写 1 次、转写 1 次，单列转写', () => {
    const c = lastConfirm();
    assert.ok(c.message.includes('读第 1 章正文，预计 2 次调用，最多 3 次'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('转写 · 整理成 JSON')), JSON.stringify(c.call));
  });

  test('写进「设定」一节之前照旧校验：名字不在正文里的丢掉', () => {
    assert.deepEqual(plot.lore, [
      { name: '停舟客栈', category: '地域', note: '镇上唯一的客栈，二层木楼' },
      { name: '过所', category: '制度', note: '' },
    ]);
  });
});

describe('记设定 · 转写调用失败', () => {
  let beforeText;
  let failures;

  before(async () => {
    beforeText = t.read(PLOT(1));
    behavior['p/small'] = 'fail';
    try {
      transcripts = [];
      fake.reset();
      h.expect('开始记');
      await bundle.loreRecord.recordLore(project, CH(1));
    } finally {
      delete behavior['p/small'];
    }
    failures = (await bundle.errorLog.listActiveFailures(project))[CH(1)] ?? [];
  });

  test('同从前解析不出来：「设定」一节不动，挂黄 ❗，说清是转写调用失败', () => {
    assert.equal(t.read(PLOT(1)), beforeText);
    assert.ok(failures.some((f) => f.op === 'loreRecord' && f.severity === 'warn' && f.message.includes('转写调用失败')), JSON.stringify(failures));
  });
});

// ---------------------------------------------------------------- 建条目

prose.entry = [
  '一句话：青崖镇上唯一的客栈',
  '关键词：停舟、客栈',
  '## 概要',
  '青崖镇上唯一的客栈，二层木楼。',
  '',
  '## 规则与边界',
  '（未交代）',
  '',
  '## 现状',
  '照常开门。',
].join('\n');

describe('建条目 · 「一句话 / 关键词 / ## 概要」写，转写成 {brief, keywords, body}', () => {
  let entry;

  before(async () => {
    transcripts = [
      JSON.stringify({
        brief: '青崖镇上唯一的客栈',
        keywords: ['停舟', '客栈'],
        body: '## 概要\n青崖镇上唯一的客栈，二层木楼。\n\n## 规则与边界\n（未交代）\n\n## 现状\n照常开门。',
      }),
    ];
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['停舟客栈']);
    project.invalidate();
    entry = (await project.listLore()).find((e) => e.title === '停舟客栈');
  });

  test('写一次、转一次；写的提示词不要 JSON，统称那一条照旧在', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不写 JSON') && systemOf(0).includes('一句话：') && systemOf(0).includes('关键词：'), systemOf(0).slice(0, 600));
    assert.match(systemOf(0), /5\. 它是一个统称/);
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【设定条目 JSON 合同】') && userOf(1).includes('照常开门。'), userOf(1));
  });

  test('确认框报写 1 次、转写 1 次，整理不出来重写一次', () => {
    const c = lastConfirm();
    assert.ok(c.message.includes('建 1 条设定：预计 2 次调用，最多 6 次'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('转写 · 整理成 JSON')), JSON.stringify(c.call));
  });

  test('照抄的建成条目：一句话、关键词、正文三节', () => {
    assert.ok(entry, '没建出来');
    assert.equal(entry.brief, '青崖镇上唯一的客栈');
    assert.ok(entry.keywords.includes('停舟'), JSON.stringify(entry.keywords));
    assert.match(entry.body, /## 概要\n+青崖镇上唯一的客栈，二层木楼。/);
    assert.match(entry.body, /## 现状\n+照常开门。/);
  });
});

describe('建条目 · 重转仍不合格：这一条重写一次、再转', () => {
  let entry;

  before(async () => {
    const good = {
      brief: '青崖镇上唯一的客栈',
      keywords: [],
      body: '## 概要\n青崖镇上唯一的客栈，二层木楼。\n\n## 规则与边界\n（未交代）\n\n## 现状\n照常开门。',
    };
    const reworded = JSON.stringify({ ...good, brief: '镇口查验身份用的凭证' });
    transcripts = [reworded, reworded, JSON.stringify(good)];
    fake.reset();
    h.expect('开始建');
    await bundle.lore.buildLoreEntries(project, ['过所']);
    project.invalidate();
    entry = (await project.listLore()).find((e) => e.title === '过所');
  });

  test('写、转、重转都不合格之后重写一次，再转照抄了就照常建（一共 5 次，没超过报的 6 次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「镇口查验身份用的凭证」'), userOf(2).slice(0, 400));
    assert.ok(!systemOf(3).includes(TRANSCRIBER) && systemOf(3).includes('整理成一条设定条目'), systemOf(3).slice(0, 100));
    assert.ok(entry, '没建出来');
  });
});

// ---------------------------------------------------------------- 按目录整理

prose.organize = ['## 新目录', '文书', '## 搬家', '- 路引 → 文书'].join('\n');

describe('按目录整理 · 「## 新目录」「## 搬家」写，转写成搬家清单', () => {
  let plan;

  before(async () => {
    t.write('.novelforge/lore/路引.md', '---\ntitle: 路引\nkeywords: [路引]\n---\n\n# 路引\n\n出入凭证。\n');
    project.invalidate();
    transcripts = [JSON.stringify({ folders: ['文书'], moves: [{ from: '路引', to: '文书' }] })];
    fake.reset();
    h.expect('开始', '照这样整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    plan = lastConfirm();
  });

  test('写一次、转一次；写的提示词不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不写 JSON') && systemOf(0).includes('条目路径 → 要搬去的目录'), systemOf(0));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【搬家清单 JSON 合同】') && userOf(1).includes('- 路引 → 文书'), userOf(1));
  });

  test('确认框报写 1 次、转写 1 次', () => {
    const go = h.confirms.find((c) => c.actions.includes('开始'));
    assert.ok(go.message.includes('分 1 批，预计 2 次调用，最多 3 次'), go.message);
  });

  test('照抄的清单照常校验、给作者看、搬', () => {
    assert.match(plan.message, /搬 1 条设定，新建 1 个目录/);
    assert.ok(!t.has('.novelforge/lore/路引.md'));
    assert.ok(t.has('.novelforge/lore/文书/路引.md'));
  });
});
