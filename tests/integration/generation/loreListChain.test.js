/**
 * 架构 · 设定清单（设定名录第四期）：经对话页从生成一路走到落盘。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 两段式落盘 | 清单 → 每批 6 条补正文、截断拆半；装配带本书的分类表与已有条目；人名不进清单；卡片列出会新建哪几条；先建分类目录（空的也建），新条目建在分类里、归机器、水位 0；名字撞上已有条目的走覆盖审阅，关键词并起来 |
 * | 覆盖审阅放弃了 | 作者那一条一个字不动，新条目照建（第 3 条） |
 * | 调用次数封顶 | 详情一路截断拆到底也不越过主按钮报的上限 24 次，剩下的只按清单建（第 4 条）；转写的调用也算进去 |
 * | 按格式写、转写成 JSON | 2026-10-25 起清单与详情都按小标题写，转写模型照抄成 JSON：转写只带合同与原文；改了字重转一次 |
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
let controller;
let posted;
let gates;

/** 作者手写的已有条目：正文没有机器的指纹，算作者的。 */
const QINGYUN = '---\ntitle: 青云宗\nkeywords: [青云门]\nbrief: 正道第一大宗\n---\n\n# 青云宗\n\n作者写的：山门在北。\n';

const MANIFEST = {
  categories: ['宗门', '地域', '法宝', '禁地/北境'],
  entries: [
    // 「青云门」是已有条目的关键词：认回「青云宗」，分类以它实际所在的目录为准。
    { title: '青云门', category: '地域', keywords: ['青云'], brief: '正道大宗，执掌北境' },
    { title: '青崖镇', category: '地域', keywords: ['青崖'], brief: '偏僻小镇，镇口设卡查过所' },
    { title: '停舟客栈', category: '地域', keywords: [], brief: '镇上唯一的客栈' },
    { title: '崖字令', category: '法宝', keywords: ['令牌'], brief: '刻着崖字的旧令牌' },
    // 人不是设定：角色卡上有他。
    { title: '林昭', category: '地域', keywords: [], brief: '主角' },
  ],
};
const body = (title) => `## 概要\n${title}的概要。\n\n## 规则与边界\n${title}的规矩。\n\n## 现状\n（未交代）`;
const detailsOf = (...titles) => JSON.stringify({ entries: titles.map((title) => ({ title, body: body(title) })) });

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

async function generateLoreList() {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', targetNo: 0, attachments: [], excludedIds: [], stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'lore' } },
  });
  return gates[0];
}

const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'lorelist', title: '青云剑录' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ngenre: 仙侠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭入青云宗查旧案。\n');
  t.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n灭门 → 入宗 → 查案。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n北境诸镇凭过所出入，崖字令能开镇口的卡子。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿。\n');
  t.write('.novelforge/lore/宗门/青云宗.md', QINGYUN);
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('设定清单 · 两段式落盘', () => {
  let gate;
  let entries;

  before(async () => {
    fake.reset([
      { text: JSON.stringify(MANIFEST), stop: 'end' },
      // 一批四条被截断：拆成两条 + 两条重试。
      { text: '{"entries":[{"title":"青云宗"', stop: 'maxTokens' },
      { text: detailsOf('青云宗', '青崖镇'), stop: 'end' },
      { text: detailsOf('停舟客栈', '崖字令'), stop: 'end' },
    ]);
    h.setReviewVerdict('apply');
    gate = await generateLoreList();
    project.invalidate();
    entries = await project.listLore();
  });

  test('清单 1 次 + 详情（截断拆半）3 次', () => {
    assert.equal(fake.callCount(), 4);
    // 冻结的清单一条一行（2026-10-25 起不再是 JSON）：「青云门」已认回「青云宗」，分类以它所在的目录为准。
    assert.ok(userOf(1).includes('【冻结设定清单】') && userOf(1).includes('- 青云宗（宗门）：正道大宗，执掌北境'), userOf(1).slice(-1500));
    assert.ok(userOf(2).includes('【本批必须完整生成的条目】\n青云宗、青崖镇'), userOf(2).slice(-800));
  });

  // 清单要照用本书的目录、照抄已有条目的名字：分类表与已有条目一行一条由 lore 层带进来。
  test('清单那一次带着世界观、本书的分类表与已有条目', () => {
    const u = userOf(0);
    assert.ok(u.includes('崖字令能开镇口的卡子'), u.slice(0, 2000));
    assert.ok(u.includes('本书的设定分类：宗门'), u);
    assert.ok(u.includes('- 青云宗〔宗门〕：正道第一大宗'), u);
    assert.ok(u.includes('【设定清单格式】') && u.includes('人不是设定'), u.slice(-2000));
    // 按格式写，不要 JSON（2026-10-25 起）。
    assert.ok(u.includes('不写 JSON') && !u.includes('{"categories"'), u.slice(-2000));
  });

  test('卡片：形状、会新建哪几条、拆半与丢掉人名的说明；不说「会覆盖」', () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('设定清单 · 4 条 · 4 个分类'), gate.detail);
    assert.ok(gate.detail.includes('会新建设定条目：青崖镇、停舟客栈、崖字令'), gate.detail);
    assert.ok(gate.detail.includes('拆成两半重试'), gate.detail);
    assert.ok(gate.detail.includes('「林昭」是角色卡上的人'), gate.detail);
    assert.ok(!gate.detail.includes('那里已经有内容了'), gate.detail);
  });

  test('先建分类目录：空的也建（作者看得到分类表）', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '法宝', '禁地', '禁地/北境', '宗门']);
  });

  test('新条目建在分类目录里：一句话、关键词含标题、机器写的指纹、水位 0', () => {
    const town = entries.find((e) => e.title === '青崖镇');
    assert.equal(town.relPath, '.novelforge/lore/地域/青崖镇.md');
    assert.equal(town.brief, '偏僻小镇，镇口设卡查过所');
    assert.deepEqual(town.keywords, ['青崖镇', '青崖']);
    assert.equal(town.updatedThrough, 0);
    assert.equal(town.bodyHash, bundle.fs.hash(body('青崖镇')));
    assert.ok(bundle.lore.loreOwnedByMachine(town));
    assert.ok(!entries.some((e) => e.title === '林昭'));
  });

  // 第 3 条：名字（这里是关键词）撞上已有条目的，一条一审；关键词并起来，一句话新的优先，正文换新、归机器。
  test('撞上已有条目的走覆盖审阅，采纳后合并', () => {
    assert.deepEqual(h.reviewed.map((r) => r.relPath), ['.novelforge/lore/宗门/青云宗.md']);
    assert.equal(h.reviewed[0].name, '设定「青云宗」');
    const qy = entries.find((e) => e.title === '青云宗');
    assert.equal(qy.relPath, '.novelforge/lore/宗门/青云宗.md');
    assert.deepEqual(qy.keywords, ['青云门', '青云']);
    assert.equal(qy.brief, '正道大宗，执掌北境');
    assert.ok(qy.body.includes('青云宗的规矩。') && !qy.body.includes('作者写的'), qy.body);
    assert.ok(bundle.lore.loreOwnedByMachine(qy));
    assert.equal(entries.filter((e) => e.title === '青云宗').length, 1);
  });

  test('一共四条：新建三条 + 合并进去的那一条已有条目，没有重复', () => {
    assert.equal(entries.length, 4);
  });
});

describe('设定清单 · 覆盖审阅放弃了', () => {
  let before2;

  before(async () => {
    t.write('.novelforge/lore/宗门/青云宗.md', QINGYUN);
    project.invalidate();
    before2 = t.read('.novelforge/lore/宗门/青云宗.md');
    fake.reset([
      {
        text: JSON.stringify({
          categories: ['宗门'],
          entries: [
            { title: '青云宗', category: '宗门', keywords: [], brief: '换一个说法' },
            { title: '藏经阁', category: '宗门', keywords: [], brief: '青云宗的藏书处' },
          ],
        }),
        stop: 'end',
      },
      { text: detailsOf('青云宗', '藏经阁'), stop: 'end' },
    ]);
    h.expect();
    h.setReviewVerdict('discard');
    await generateLoreList();
    project.invalidate();
  });

  after(() => h.setReviewVerdict('apply'));

  test('作者那一条一个字不动', () => {
    assert.equal(h.reviewed.length, 1);
    assert.equal(t.read('.novelforge/lore/宗门/青云宗.md'), before2);
  });

  test('新条目照建，并说出保留了哪一条', async () => {
    assert.ok((await project.listLore()).some((e) => e.relPath === '.novelforge/lore/宗门/藏经阁.md'));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('新建 1 条设定条目') && m.includes('保留原样的 青云宗')), toasts.join('|'));
  });
});

describe('设定清单 · 调用次数封顶', () => {
  const S = loadModule('src/core/generation/structured.ts');
  const P = loadModule('src/core/model/pipeline.ts');
  let result;
  let calls = 0;

  before(async () => {
    const manifest = {
      categories: ['地域', '宗门', '法宝'],
      entries: Array.from({ length: 30 }, (_, i) => ({ title: `物${i + 1}`, category: '地域', keywords: [], brief: `第 ${i + 1} 样` })),
    };
    // 详情每一次都被截断：一路对半拆下去。
    const io = {
      messages: [],
      build: async () => [{ role: 'user', content: '详情' }],
      call: async () => {
        calls++;
        return { text: '{"entries":[', stop: 'maxTokens' };
      },
    };
    result = await S.completeLoreList({ text: JSON.stringify(manifest), stop: 'end' }, io, { categories: [], entries: [], people: [] });
  });

  // 一批要写一次、转写一次：余量不够两次就不写了，所以停在上限或差一次。
  test('一共调用不超过主按钮报的上限', () => {
    assert.ok(result.calls <= P.LORE_LIST_CALLS_MAX && result.calls >= P.LORE_LIST_CALLS_MAX - 1, String(result.calls));
    assert.equal(calls + 1, result.calls);
    assert.equal(P.loreListCalls().max, P.LORE_LIST_CALLS_MAX);
  });

  test('剩下的条目只按清单建，并说明为什么', () => {
    const out = JSON.parse(result.raw);
    assert.equal(out.entries.length, 30);
    assert.ok(out.entries.every((e) => !e.body && e.brief), JSON.stringify(out.entries.slice(0, 2)));
    assert.ok(result.notes.some((n) => n.includes(`上限 ${P.LORE_LIST_CALLS_MAX}`)), result.notes.join('\n'));
  });
});

// 写到一半再排清单：定稿里单独记下的名字不能被清单里的一条收成关键词（收了它就再也建不出自己的条目）。
describe('设定清单 · 名录里另记着的名字', () => {
  before(async () => {
    t.write('chapters/001-第1章.md', '# 第1章\n\n他抬手一道寒冰锁。\n');
    project.invalidate();
    const [ch] = await project.listChapters();
    t.write(
      '.novelforge/summaries/001-第1章.md',
      `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch.contentHash}\n---\n\n# 第1章 第1章\n\n## 设定\n\n- 寒冰锁〔法术〕：缚住对手的冰锁\n`
    );
    project.invalidate();
    fake.reset([
      {
        text: JSON.stringify({
          categories: ['法术'],
          entries: [{ title: '魔法体系', category: '法术', keywords: ['寒冰锁', '施法'], brief: '这本书的魔法' }],
        }),
        stop: 'end',
      },
      { text: detailsOf('魔法体系'), stop: 'end' },
    ]);
    await generateLoreList();
    project.invalidate();
  });

  test('「魔法体系」不收「寒冰锁」', async () => {
    const magic = (await project.listLore()).find((e) => e.title === '魔法体系');
    assert.ok(magic, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.deepEqual(magic.keywords, ['魔法体系', '施法']);
  });
});

// ---------------------------------------------------------------- 按格式写、转写成 JSON（2026-10-25 起）

const TRANSCRIBER = '格式转写员';
const systemOf = (i) => fake.calls[i][0].content;

describe('设定清单 · 按格式写、转写成 JSON', () => {
  const PROSE_LIST = ['## 分类', '- 地域', '- 渡口', '## 清单', '- 黑水渡（渡口；别称：黑渡）：北境唯一能过黑水的渡口', '- 断剑崖（地域）：崖上插满断剑'].join('\n');
  const LIST_JSON = JSON.stringify({
    categories: ['地域', '渡口'],
    entries: [
      { title: '黑水渡', category: '渡口', keywords: ['黑渡'], brief: '北境唯一能过黑水的渡口' },
      { title: '断剑崖', category: '地域', keywords: [], brief: '崖上插满断剑' },
    ],
  });
  const PROSE_DETAILS = [
    '## 黑水渡',
    '### 概要',
    '黑水河上的老渡口，归船帮。',
    '### 规则与边界',
    '只在子时开船，一船不过七人。',
    '### 现状',
    '（未交代）',
    '## 断剑崖',
    '### 概要',
    '北境的断崖，崖上插满断剑。',
    '### 规则与边界',
    '拔剑者会被崖上的剑意所伤。',
    '### 现状',
    '无',
  ].join('\n');
  const detailJson = (rule) =>
    JSON.stringify({
      entries: [
        { title: '黑水渡', body: { 概要: '黑水河上的老渡口，归船帮。', 规则与边界: rule, 现状: '（未交代）' } },
        { title: '断剑崖', body: { 概要: '北境的断崖，崖上插满断剑。', 规则与边界: '拔剑者会被崖上的剑意所伤。', 现状: '无' } },
      ],
    });
  let gate;

  before(async () => {
    fake.reset([
      { text: PROSE_LIST, stop: 'end' },
      { text: LIST_JSON, stop: 'end' },
      { text: PROSE_DETAILS, stop: 'end' },
      // 转写改了原文的字：不收，重转一次。
      { text: detailJson('子时开船，最多载七人。'), stop: 'end' },
      { text: detailJson('只在子时开船，一船不过七人。'), stop: 'end' },
    ]);
    h.setReviewVerdict('apply');
    gate = await generateLoreList();
    project.invalidate();
  });

  test('清单写 1 次、转写 1 次；详情写 1 次、转写 2 次（改了字重转一次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok(!systemOf(0).includes(TRANSCRIBER) && !systemOf(2).includes(TRANSCRIBER));
    assert.ok([1, 3, 4].every((i) => systemOf(i).includes(TRANSCRIBER)), systemOf(1));
  });

  // 转写只看原文：给多了它会顺手补内容。
  test('转写只带合同与原文，不带书的上下文', () => {
    assert.ok(userOf(1).includes('【设定清单 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('- 黑水渡（渡口；别称：黑渡）'), userOf(1));
    assert.ok(!userOf(1).includes('崖字令能开镇口的卡子'), userOf(1));
    assert.ok(userOf(3).includes('【设定详情 JSON 合同】') && userOf(3).includes('只在子时开船，一船不过七人。'), userOf(3));
  });

  test('详情那一次带着冻结清单（一条一行）', () => {
    assert.ok(userOf(2).includes('- 黑水渡（渡口）：北境唯一能过黑水的渡口'), userOf(2).slice(-1500));
    assert.ok(userOf(2).includes('【本批必须完整生成的条目】\n黑水渡、断剑崖'), userOf(2).slice(-1500));
  });

  test('重转那一次说清哪几处不是原文里的字', () => {
    assert.ok(userOf(4).includes('【上次转写不合格】这几处不是原文里的字：「子时开船，最多载七人。」'), userOf(4).slice(0, 800));
  });

  test('照抄的落盘：分类、关键词、正文三节；卡片上说出重转', async () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('重转一次'), gate.detail);
    const ferry = (await project.listLore()).find((e) => e.title === '黑水渡');
    assert.ok(ferry, JSON.stringify((await project.listLore()).map((e) => e.title)));
    assert.equal(ferry.category, '渡口');
    assert.deepEqual(ferry.keywords, ['黑水渡', '黑渡']);
    assert.ok(ferry.body.includes('只在子时开船，一船不过七人。'), ferry.body);
  });
});

describe('设定清单 · 转写的调用也算进封顶', () => {
  const S = loadModule('src/core/generation/structured.ts');
  const P = loadModule('src/core/model/pipeline.ts');
  let result;
  let writes = 0;
  let transcribes = 0;

  before(async () => {
    const manifest = {
      categories: ['地域', '宗门', '法宝'],
      entries: Array.from({ length: 30 }, (_, i) => ({ title: `物${i + 1}`, category: '地域', keywords: [], brief: `第 ${i + 1} 样` })),
    };
    // 详情按格式写了，转写每一次都改字：重转一次（全程只这一次），之后对半拆、各写各转，直到上限。
    const io = {
      messages: [],
      build: async () => [{ role: 'user', content: '详情' }],
      call: async () => {
        writes++;
        return { text: '## 物1\n### 概要\n第一样东西。\n### 规则与边界\n无\n### 现状\n无', stop: 'end' };
      },
      transcribe: async () => {
        transcribes++;
        return { text: JSON.stringify({ entries: [{ title: '物1', body: { 概要: '改写过的东西' } }] }), stop: 'end' };
      },
    };
    result = await S.completeLoreList({ text: JSON.stringify(manifest), stop: 'end' }, io, { categories: [], entries: [], people: [] });
  });

  test('写与转写合起来不超过上限，两样都记在账上', () => {
    assert.ok(transcribes > 0);
    assert.equal(result.calls, 1 + writes + transcribes);
    assert.ok(result.calls <= P.LORE_LIST_CALLS_MAX, String(result.calls));
    assert.ok(result.notes.some((n) => n.includes(`上限 ${P.LORE_LIST_CALLS_MAX}`)), result.notes.join('\n'));
  });

  test('全程只重转一次', () => {
    assert.equal(result.notes.filter((n) => n.includes('重转一次')).length, 1, result.notes.join('\n'));
  });
});
