/**
 * 工程页「补齐设定」：配置 → 前提 → 角色图谱 → 世界观，只补空白、严格串行（D21）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 没有一句话 | 配置缺席又没有脑洞可展开：不调模型，说清先做什么 |
 * | 补齐 | 确认框报出缺哪几件、预计与上限；按顺序一件一件来，后一件读得到前一件 |
 * | 一件失败就停 | 后面几件不跑；失败挂在那一行上（第 16 条） |
 * | 都齐了 | 一次都不调 |
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

function reply(messages) {
  const user = messages[messages.length - 1].content;
  const which = user.includes('【JSON 字段结构】')
    ? 'config'
    : user.includes('【冻结身份与关系清单】')
      ? 'details'
      : user.includes('{"slots":[...]}')
        ? 'manifest'
        : user.includes('「故事前提」')
          ? 'premise'
          : user.includes('「世界观」')
            ? 'world'
            : 'unknown';
  if (fail.has(which)) {
    return '';
  }
  switch (which) {
    case 'config':
      return CONFIG_JSON;
    case 'premise':
      return '## 一句话前提\n\n当孤儿遭遇灭门，必须入宗查案。\n\n## 核心冲突链\n\n灭门 → 入宗 → 查案 → 执法堂阻挠。\n\n## 金手指定位\n\n残令。\n\n## 悬念骨架\n\n谁放的火。';
    case 'manifest':
      return MANIFEST;
    case 'details':
      return DETAILS;
    case 'world':
      return '## 规则与漏洞\n\n灵脉决定修为。\n\n## 阶层与资源\n\n宗门垄断灵脉。\n\n## 深层危机\n\n灵脉在枯竭。';
    default:
      return 'unknown';
  }
}

/** 调用的顺序：每次调用认出是哪一件。 */
function order() {
  return fake.calls.map((c) => {
    const u = c[c.length - 1].content;
    return u.includes('【JSON 字段结构】')
      ? 'config'
      : u.includes('【冻结身份与关系清单】')
        ? 'details'
        : u.includes('{"slots":[...]}')
          ? 'manifest'
          : u.includes('「故事前提」')
            ? 'premise'
            : u.includes('「世界观」')
              ? 'world'
              : '?';
  });
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

describe('补齐设定 · 没有一句话', () => {
  test('配置缺席又没有脑洞可展开：不调模型，说清先做什么', async () => {
    h.expect('开始补齐');
    fake.reset();
    const n = await bundle.batch.completeSettings(project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('一句话')), h.toasts.join('|'));
  });
});

describe('补齐设定', () => {
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

  // 配置 1–3 次 + 前提 1 次 + 角色图谱 2–4 次（最多 16）+ 世界观 1 次。
  test('确认框报出缺哪几件、预计与上限', () => {
    assert.ok(
      confirm?.message.includes('要补齐小说配置、故事前提、角色图谱、世界观，预计 5–7 次调用，最多 21 次'),
      JSON.stringify(confirm)
    );
    assert.ok(confirm.detail.includes('按 100 章 × 3000 字展开'), confirm.detail);
  });

  test('按顺序一件一件来', () => {
    assert.deepEqual(calls, ['config', 'premise', 'manifest', 'details', 'world']);
    assert.equal(returned, 5);
  });

  // 每件都吃前面几件的产出：世界观那一次的装配里有刚写好的前提与角色。
  test('后一件读得到前一件', () => {
    const world = fake.calls[4][fake.calls[4].length - 1].content;
    assert.ok(world.includes('灭门 → 入宗 → 查案') && world.includes('- 林昭'), world.slice(0, 1500));
  });

  // 第 19 条的批量那一面：只补空白，作者写过的节一个字不动，也不弹审阅。
  test('作者写过的节原样留着，不弹审阅', async () => {
    const premise = await project.readSettingDoc('premise');
    assert.equal(premise.sections.一句话前提, '作者自己写的一句话前提。');
    assert.ok(premise.sections.核心冲突链.includes('灭门'), premise.sections.核心冲突链);
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms.map((c) => c.message)));
  });

  test('四件都落了盘', async () => {
    const filled = await project.settingFilled();
    assert.deepEqual(filled, { config: true, premise: true, characters: true, world: true });
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, '少年背着旧案入宗');
    assert.equal(book.totalChapters, 100);
    assert.equal((await project.listCharacters()).length >= 3, true);
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

describe('补齐设定 · 一件失败就停', () => {
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
