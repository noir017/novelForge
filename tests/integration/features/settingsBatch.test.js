/**
 * 工程页「补齐架构」：配置 → 前提 → 角色图谱 → 世界观 → 设定清单，只补空白、严格串行（D21）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 没有一句话 | 配置缺席又没有脑洞可展开：不调模型，说清先做什么 |
 * | 补齐 | 确认框报出缺哪几件、预计与上限；按顺序一件一件来，后一件读得到前一件；设定清单建了目录与条目 |
 * | 一件失败就停 | 后面几件不跑；失败挂在那一行上（第 16 条） |
 * | 都齐了 | 一次都不调 |
 * | 已经写了正文 | 照正文整理；设定清单算填过，不排 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let settings = {};
/** 按契约里认得出的那一段应答；`fail` 里列的那一件答空话。 */
let fail = new Set();

const CONFIG_JSON = JSON.stringify({
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '宗门',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '少年背着旧案入宗，查出宗门与旧案的关系。',
  worldSetting: '灵脉枯竭的九州。',
  goldenFinger: '残令。',
  protagonistProfile: '林昭，隐忍。',
  globalGuidance: '1. 不写上帝视角\n2. 每章留钩子\n3. 金手指有代价\n4. 对白分得出是谁',
  writingStyle: '冷峻克制。',
});
const MANIFEST = JSON.stringify({
  slots: [
    { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '主角', relations: [{ targetSlotId: '2', relation: '同门' }] },
    { slotId: '2', name: '沈青', role: 'supporting', narrativeDuty: '引路人', relations: [] },
    { slotId: '3', name: '周岳', role: 'antagonist', narrativeDuty: '对手', relations: [] },
  ],
});
const DETAILS = JSON.stringify({
  entries: ['林昭', '沈青', '周岳'].map((name, i) => ({ slotId: String(i + 1), name, 身份: `${name}的身份`, 当前状态: '在山门' })),
});
/** 设定清单：三个一级分类、十二条（详情两批）。 */
const LORE_TITLES = ['青云宗', '执法堂', '藏经阁', '青崖镇', '停舟客栈', '灵脉', '镇妖塔', '残令', '过所', '外门', '内门', '灵石'];
const LORE_CATEGORY = ['宗门', '宗门', '宗门', '地域', '地域', '地域', '地域', '法宝', '制度', '宗门', '宗门', '法宝'];
const LORE_MANIFEST = JSON.stringify({
  categories: ['宗门', '地域', '法宝', '制度'],
  entries: LORE_TITLES.map((title, i) => ({ title, category: LORE_CATEGORY[i], keywords: [], brief: `${title}的一句话` })),
});
/** 详情：按这一批点名的条目答。 */
function loreDetails(user) {
  const named = /【本批必须完整生成的条目】\n([^\n]+)/.exec(user)?.[1].split('、') ?? [];
  return JSON.stringify({ entries: named.map((title) => ({ title, body: `## 概要\n${title}的概要。\n\n## 规则与边界\n${title}的规矩。` })) });
}

function which(user) {
  return user.includes('【冻结设定清单】')
    ? 'loreDetails'
    : user.includes('【设定清单合同】')
      ? 'loreList'
      : user.includes('【JSON 字段结构】')
        ? 'config'
        : user.includes('【冻结身份与关系清单】')
          ? 'details'
          : user.includes('{"slots":[...]}')
            ? 'manifest'
            : user.includes('「故事前提」')
              ? 'premise'
              : user.includes('「世界观」')
                ? 'world'
                : '?';
}

function reply(messages) {
  const user = messages[messages.length - 1].content;
  const kind = which(user);
  if (fail.has(kind)) {
    return '';
  }
  switch (kind) {
    case 'config':
      return CONFIG_JSON;
    case 'premise':
      return '## 一句话前提\n\n当孤儿遭遇灭门，必须入宗查案。\n\n## 核心冲突链\n\n灭门 → 入宗 → 查案 → 执法堂阻挠。\n\n## 爽点循环\n\n残令。\n\n## 悬念骨架\n\n谁放的火。';
    case 'manifest':
      return MANIFEST;
    case 'details':
      return DETAILS;
    case 'world':
      return '## 规则与漏洞\n\n灵脉决定修为。\n\n## 阶层与资源\n\n宗门垄断灵脉。\n\n## 深层危机\n\n灵脉在枯竭。';
    case 'loreList':
      return LORE_MANIFEST;
    case 'loreDetails':
      return loreDetails(user);
    default:
      return 'unknown';
  }
}

/** 调用的顺序：每次调用认出是哪一件。 */
function order() {
  return fake.calls.map((c) => which(c[c.length - 1].content));
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    batch: './src/core/features/pipelineBatch.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => reply(messages) });
  t = await makeTempProject(bundle.project, { prefix: 'settings', title: '青云剑录' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('补齐架构 · 没有一句话', () => {
  test('配置缺席又没有脑洞可展开：不调模型，说清先做什么', async () => {
    h.expect('开始补齐');
    fake.reset();
    const n = await bundle.batch.completeSettings(project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('一句话')), h.toasts.join('|'));
  });
});

describe('补齐架构', () => {
  let confirm;
  let calls;
  let returned;

  before(async () => {
    const cfg = t.read('.novelforge/config.md').replace(/## 一句话\n\n（待补充）/, '## 一句话\n\n少年背着旧案入宗');
    t.write('.novelforge/config.md', cfg);
    // 前提只写了一句话前提、冲突链还空着：算没填过，要补——但作者写的那一节不能动。
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n作者自己写的一句话前提。\n\n## 核心冲突链\n\n（待补充）\n');
    project.invalidate();
    fail = new Set();
    fake.reset();
    h.expect('开始补齐');
    returned = await bundle.batch.completeSettings(project);
    confirm = h.confirms[0];
    calls = order();
  });

  // 配置 1–3 次 + 前提 1 次 + 角色图谱 2–4 次（最多 16）+ 世界观 1 次 + 设定清单 3–6 次（最多 12）。
  test('确认框报出缺哪几件、预计与上限', () => {
    assert.ok(
      confirm?.message.includes('要补齐小说配置、故事前提、角色图谱、世界观、设定清单，预计 8–13 次调用，最多 33 次'),
      JSON.stringify(confirm)
    );
    assert.ok(confirm.detail.includes('按 100 章 × 3000 字展开'), confirm.detail);
    assert.ok(confirm.detail.includes('世界观 → 设定清单'), confirm.detail);
  });

  test('按顺序一件一件来', () => {
    assert.deepEqual(calls, ['config', 'premise', 'manifest', 'details', 'world', 'loreList', 'loreDetails', 'loreDetails']);
    assert.equal(returned, 8);
  });

  // 每件都吃前面几件的产出：世界观那一次的装配里有刚写好的前提与角色。
  test('后一件读得到前一件', () => {
    const world = fake.calls[4][fake.calls[4].length - 1].content;
    assert.ok(world.includes('灭门 → 入宗 → 查案') && world.includes('- 林昭'), world.slice(0, 1500));
    // 设定清单读得到刚写好的世界观与角色图谱（一行一人）。
    const lore = fake.calls[5][fake.calls[5].length - 1].content;
    assert.ok(lore.includes('灵脉在枯竭') && lore.includes('- 林昭'), lore.slice(0, 1500));
  });

  // 第 19 条的批量那一面：只补空白，作者写过的节一个字不动，也不弹审阅。
  test('作者写过的节原样留着，不弹审阅', async () => {
    const premise = await project.readSettingDoc('premise');
    assert.equal(premise.sections.一句话前提, '作者自己写的一句话前提。');
    assert.ok(premise.sections.核心冲突链.includes('灭门'), premise.sections.核心冲突链);
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms.map((c) => c.message)));
  });

  test('五件都落了盘', async () => {
    const filled = await project.settingFilled();
    assert.deepEqual(filled, { config: true, premise: true, characters: true, world: true, lore: true });
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, '少年背着旧案入宗');
    assert.equal(book.totalChapters, 100);
    assert.equal((await project.listCharacters()).length >= 3, true);
  });

  // 分类就是目录：清单排的四个目录都建了（「制度」下也有一条，「法宝」两条）；条目归机器、水位 0。
  test('设定清单：建了分类目录与十二条条目', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '法宝', '制度', '宗门'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    const entries = await project.listLore();
    assert.equal(entries.length, 12);
    const inn = entries.find((e) => e.title === '停舟客栈');
    assert.equal(inn.relPath, '.novelforge/lore/地域/停舟客栈.md');
    assert.equal(inn.brief, '停舟客栈的一句话');
    assert.equal(inn.updatedThrough, 0);
    assert.ok(inn.body.includes('## 规则与边界\n停舟客栈的规矩。'), inn.body);
    assert.ok(loadModule('src/core/features/lore.ts').loreOwnedByMachine(inn));
  });

  // D15：图谱写的当前状态是开篇状态、归机器——定稿时才能接着往后更新，而不是被当成作者写的。
  test('角色图谱建的卡盖了章：开篇状态、归机器', async () => {
    const stateModel = loadModule('src/core/model/characterState.ts');
    const cards = await project.listCharacters();
    assert.ok(cards.length > 0);
    for (const c of cards) {
      assert.equal(c.stateThrough, 0, c.name);
      assert.ok(stateModel.stateOwnedByMachine(c), c.name);
    }
  });

  test('都齐了就一次都不调', async () => {
    fake.reset();
    h.expect('开始补齐');
    assert.equal(await bundle.batch.completeSettings(project), 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('都已经有了')), h.toasts.join('|'));
  });
});

describe('补齐架构 · 一件失败就停', () => {
  let calls;
  let failures;

  before(async () => {
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n（待补充）\n');
    t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n（待补充）\n');
    project.invalidate();
    fail = new Set(['premise']);
    fake.reset();
    h.expect('开始补齐');
    await bundle.batch.completeSettings(project);
    calls = order();
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('前提没成，世界观不跑', async () => {
    assert.deepEqual(calls, ['premise']);
    assert.equal((await project.settingFilled()).world, false);
  });

  test('失败挂在故事前提那一行上', () => {
    assert.ok(!!failures['.novelforge/premise.md'], JSON.stringify(Object.keys(failures)));
  });

  test('toast 说清停在哪', () => {
    assert.ok(h.toasts.some((x) => x.includes('故事前提没补上') && x.includes('已经停下')), h.toasts.join('|'));
  });
});

describe('补齐架构 · 已经写了正文', () => {
  let w;
  let n;
  let configCall;

  before(async () => {
    w = await makeTempProject(bundle.project, { prefix: 'settings-written', title: '旧稿' });
    w.write('chapters/001-第1章.md', '# 第1章\n\n林昭背着藤箱进了青崖镇。\n');
    w.write('chapters/002-第2章.md', '# 第2章\n\n林昭在镇口撞见了守卫。\n');
    w.project.invalidate();
    fail = new Set();
    fake.reset();
    h.expect('开始补齐');
    n = await bundle.batch.completeSettings(w.project);
    configCall = fake.calls.find((c) => c[c.length - 1].content.includes('【JSON 字段结构】'));
  });

  after(() => {
    if (w) cleanup(w.dir);
  });

  test('没有一句话也补得出配置：照已写正文整理', async () => {
    assert.ok(n > 0);
    assert.ok(configCall, JSON.stringify(order()));
    assert.ok(configCall[configCall.length - 1].content.includes('从已写正文整理'));
    assert.equal((await w.project.settingFilled()).config, true);
  });

  test('确认框说清照正文整理', () => {
    assert.ok(h.confirms.some((c) => (c.detail ?? '').includes('照已写正文整理')), JSON.stringify(h.confirms));
  });

  // 在写的书：设定清单算填过（设定从定稿里长、从名录建条目），补齐不排它，也不调它。
  test('设定清单算填过：一条条目都没有也不排', async () => {
    assert.equal((await w.project.settingFilled()).lore, true);
    assert.ok(!order().includes('loreList'), order().join(','));
    assert.ok(!h.confirms.some((c) => c.message.includes('设定清单')), JSON.stringify(h.confirms.map((c) => c.message)));
    assert.deepEqual(await w.project.listLore(), []);
  });
});
