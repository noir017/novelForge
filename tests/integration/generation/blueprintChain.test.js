/**
 * 二期验收：从空工程开始，**跟着主按钮走**，一路写到前 5 章细纲。
 *
 *   一句话 → 小说配置 → 故事前提 → 角色图谱 → 世界观 → 设定清单 → 情节大纲（第 1–20 章）→ 第 1–5 章细纲
 *
 * 每一步都照前端的做法：取后端推来的下一步（`pipeline.next`），按它的 stage / capability /
 * target / range 发送，落盘卡片答「写入」。钉的是整条链接得上：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 主按钮的顺序 | 第 20 条：状态机一次只推一个，推的是对的那一个 |
 * | 每一步的装配里有前面几步的产物 | 架构几件一件吃一件；大纲吃架构与结构指导；细纲吃大纲那一节 |
 * | 一共调了几次模型 | 第 4 条：配置 1、前提 1、角色图谱 2、世界观 1、设定清单 2、大纲 1、细纲 1 |
 * | 一张审阅都不弹 | 新工程里全是空模板，覆盖审阅只在真的要换掉作者的东西时出现 |
 * | 最后主按钮是「写第 1 章」 | 细纲拆完，全书状态机转进单章状态机 |
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
let controller;
let posted = [];

const IDEA = '一个从火里活下来的少年回到起火的镇子，发现幸存者不止他一个。';

const CONFIG_JSON = JSON.stringify({
  genre: '武侠',
  targetAudience: '男频',
  subGenre: '悬疑武侠',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '林昭携残令回到青崖镇，追查七年前那场火，发现镇上的人集体缄默，而放火的人就在其中。',
  worldSetting: '江湖式微，镇与镇之间靠一份名册维系。',
  goldenFinger: '残令能照见持令人最后看见的一幕，每用一次要付出一段记忆。',
  protagonistProfile: '林昭，外冷内热，唯一的执念是找出放火的人。',
  globalGuidance: '1. 不写上帝视角\n2. 每章结尾留一个未决的问题\n3. 残令每次使用都有代价\n4. 对白要分得出是谁在说',
  writingStyle: '冷峻克制，短句为主，少用比喻，动作先于心理。',
});

const PREMISE = [
  '## 一句话前提', '当孤儿林昭回到青崖镇，必须找出放火的人，否则幸存者一个个死去。',
  '## 核心冲突链', '灭门之火 → 回镇 → 残令被认出 → 持令人接连出事 → 镇上集体缄默。',
  '## 爽点循环', '残令照见最后一幕，代价是记忆。',
  '## 悬念骨架', '显性：谁在杀持令人。隐藏：那场火是镇上的人一起放的。',
].join('\n\n');

const MANIFEST = JSON.stringify({
  slots: [
    { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '回镇追查', relations: [{ targetSlotId: '2', relation: '互相试探' }] },
    { slotId: '2', name: '沈氏', role: 'supporting', narrativeDuty: '客栈老板娘，知道一半真相', relations: [] },
    { slotId: '3', name: '李叔', role: 'antagonist', narrativeDuty: '守卫，守着镇上的秘密', relations: [{ targetSlotId: '1', relation: '处处设防' }] },
  ],
});

const WORLD = [
  '## 规则与漏洞', '名册决定谁算镇上的人；残令是名册的钥匙。',
  '## 阶层与资源', '守卫垄断出入，客栈垄断消息。',
  '## 深层危机', '名册上的人正在被一个个抹掉。',
].join('\n\n');

const OUTLINE = [
  '## 第1–10章：第一幕 · 停舟', '林昭进镇，残令被李叔认出；沈氏试探；第二块令牌浮出水面。',
  '## 第11–20章：第一幕 · 名册', '持令人接连出事，名册的存在被揭开。',
].join('\n\n');

/** 设定清单：按武侠悬疑排的目录树（「地域/青崖」是二级，「门派」空着也建），五条一批就补完详情。 */
const LORE_LIST = JSON.stringify({
  categories: ['地域', '地域/青崖', '信物', '制度', '门派'],
  entries: [
    { title: '青崖镇', category: '地域', keywords: ['青崖'], brief: '偏僻小镇，七年前遭过一场大火' },
    { title: '停舟客栈', category: '地域/青崖', keywords: [], brief: '镇上唯一的客栈，沈氏开的' },
    { title: '残令', category: '信物', keywords: ['令牌'], brief: '能照见持令人最后一幕的令牌' },
    { title: '名册', category: '制度', keywords: [], brief: '决定谁算镇上的人' },
    { title: '镇口卡子', category: '地域/青崖', keywords: [], brief: '守卫查过所的地方' },
  ],
});

/** 按契约里认得出的那一段应答。 */
function reply(messages) {
  const user = messages[messages.length - 1].content;
  if (user.includes('【设定清单合同】')) return LORE_LIST;
  if (user.includes('【冻结设定清单】')) {
    const titles = /【本批必须完整生成的条目】\n([^\n]+)/.exec(user)[1].split('、');
    return JSON.stringify({ entries: titles.map((title) => ({ title, body: `## 概要\n${title}在青崖镇。\n\n## 规则与边界\n${title}的规矩。` })) });
  }
  if (user.includes('【JSON 字段结构】')) return CONFIG_JSON;
  if (user.includes('【冻结身份与关系清单】')) {
    const ids = /【本批必须完整生成的 slotId】\n([^\n]+)/.exec(user)[1].split('、');
    const names = { 1: '林昭', 2: '沈氏', 3: '李叔' };
    return JSON.stringify({
      entries: ids.map((id) => ({ slotId: id, name: names[id], 身份: `${names[id]}的身份`, 性格: '冷', 当前状态: '在青崖镇' })),
    });
  }
  if (user.includes('{"slots":[...]}')) return MANIFEST;
  if (user.includes('「故事前提」')) return PREMISE;
  if (user.includes('「世界观」')) return WORLD;
  if (user.includes('整合为全书的情节大纲')) return OUTLINE;
  const m = /chapterNumber 必须覆盖第 (\d+)(?:–(\d+))? 章的每一章/.exec(user);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    const blueprints = [];
    for (let no = from; no <= to; no++) {
      blueprints.push({
        chapterNumber: no,
        title: ['停舟', '令牌', '夜访', '井', '名册'][no - 1] ?? `第${no}章`,
        synopsis: `第 ${no} 章林昭要弄清的一件事`,
        characters: no === 4 ? ['林昭', '周老汉'] : ['林昭', '沈氏'],
        timePlace: '青崖镇，入夜',
        // 关键事件与定稿一样是一条一件事的数组（⚑B）。
        keyEvents: [`第 ${no} 章：林昭在镇上追查，残令照见一幕。`, '他为此付出代价。'],
        // 章末钩子不单列了，并进看点。
        highlights: [`第 ${no} 章结尾：又一个持令人不见了。`],
        foreshadowing: [],
        stateChange: '',
        ...(no === 4 ? { newCharacters: [{ name: '周老汉', role: 'minor' }] } : {}),
        // 设定名录：第 4 章引入一口古井（新设定，建空条目），也用到青崖镇（不是新的，不建）。
        ...(no === 4
          ? {
              settings: [
                { name: '古井', category: '地域/青崖', isNew: true, note: '镇北废宅里的枯井' },
                { name: '青崖镇', category: '地域', isNew: false, note: '' },
              ],
            }
          : {}),
      });
    }
    return JSON.stringify({ blueprints });
  }
  return '（认不出这一步）';
}

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

/** 后端最近一次推来的下一步。 */
async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按钮；一句话那一步照弹窗的做法带 setup。 */
async function press(step) {
  posted = [];
  const payload =
    step.form === 'idea'
      ? {
          text: IDEA,
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: 100, wordsPerChapter: 3000 },
        }
      : {
          text: '',
          stage: step.stage,
          capability: step.capability,
          target: step.target,
          targetNo: step.no ?? step.range?.from ?? 1,
          range: step.range,
        };
  await controller.handle({ type: 'send', payload: { ...payload, attachments: [], excludedIds: [] } });
  return posted.filter((m) => m.type === 'gate').pop();
}

/** 第 i 次调用的 user 消息。 */
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;

describe('二期验收：一句话 → 前 5 章细纲', () => {
  const labels = [];
  const gates = [];
  let finalStep;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      registry: './src/core/llm/registry.ts',
      provider: './src/core/llm/provider.ts',
      controller: './src/core/controller/index.ts',
      outlineFile: './src/core/model/outlineFile.ts',
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
      reply: (messages) => reply(messages),
      errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    });
    t = await makeTempProject(bundle.project, { prefix: 'phase2', title: '青崖记' });
    project = t.project;
    controller = new bundle.controller.ChatController(project);
    attach();

    // 跟着主按钮走七步。每一步之前记下按钮上的字。
    for (let i = 0; i < 7; i++) {
      const step = await nextStep();
      assert.ok(step, `第 ${i + 1} 步没有下一步`);
      labels.push(step.label);
      gates.push(await press(step));
    }
    finalStep = await nextStep();
  });

  after(() => {
    controller?.dispose();
    if (t) cleanup(t.dir, bundle?.db);
  });

  test('主按钮的顺序：配置 → 前提 → 角色图谱 → 世界观 → 设定清单 → 大纲 → 拆细纲', () => {
    assert.deepEqual(labels, [
      '生成小说配置',
      '生成故事前提',
      '生成角色图谱',
      '生成世界观',
      '生成设定清单',
      '生成情节大纲（第 1–20 章）',
      '拆细纲（第 1–5 章）',
    ]);
  });

  test('每一步都出了落盘卡片，而且一张覆盖审阅都没弹', () => {
    assert.equal(gates.filter(Boolean).length, 7, JSON.stringify(gates.map((g) => g?.title)));
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((r) => r.relPath)));
  });

  // 第 4 条：配置 1、前提 1、角色图谱 2（清单 + 一批 3 人的详情）、世界观 1、设定清单 2（清单 + 一批 5 条的详情）、
  // 大纲 1、细纲 1。
  test('一共调了 9 次模型', () => {
    assert.equal(fake.callCount(), 9);
  });

  test('小说配置：一句话、规模、结构都在，文风进了 style.md', async () => {
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, IDEA);
    assert.equal(book.totalChapters, 100);
    assert.equal(book.wordsPerChapter, 3000);
    assert.equal(book.structure, 'three_act');
    assert.ok((await project.readStyleGuide()).includes('冷峻克制'));
  });

  test('前提照着配置写：它的装配里有配置的核心梗概', () => {
    assert.ok(userOf(1).includes('林昭携残令回到青崖镇'), userOf(1).slice(0, 1500));
  });

  test('角色图谱：三张卡，关系写到双方卡上', async () => {
    const cards = await project.listCharacters();
    const lin = cards.find((c) => c.name === '林昭');
    assert.ok(lin && lin.tags.includes('主角'), JSON.stringify(lin));
    assert.ok(lin.sections.人物关系.includes('与沈氏：互相试探') && lin.sections.人物关系.includes('与李叔：李叔眼中——处处设防'), lin.sections.人物关系);
  });

  test('世界观照着前提与角色写：装配里有前提的冲突链与角色图谱', () => {
    const world = userOf(4);
    assert.ok(world.includes('灭门之火 → 回镇') && world.includes('【角色图谱】') && world.includes('- 林昭'), world.slice(0, 2500));
  });

  // 设定清单吃世界观与角色图谱（一行一人：人不是设定），卡片上事先列出会建哪几条。
  test('设定清单照着世界观排：装配里有世界观与角色图谱，卡片列出会新建的条目', () => {
    const lore = userOf(5);
    assert.ok(lore.includes('名册决定谁算镇上的人') && lore.includes('【角色图谱】') && lore.includes('- 林昭'), lore.slice(0, 2500));
    assert.ok(lore.includes('世界观讲整体怎么运转，条目讲某一个东西') && lore.includes('人不是设定'), lore.slice(-2500));
    assert.ok(gates[4].detail.includes('设定清单 · 5 条 · 5 个分类'), gates[4].detail);
    assert.ok(gates[4].detail.includes('会新建设定条目：青崖镇、停舟客栈、残令、名册、镇口卡子'), gates[4].detail);
  });

  test('设定清单落了盘：分类目录（空的也建）、条目建在分类里', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '地域/青崖', '门派', '信物', '制度']);
    const inn = (await project.listLore()).find((e) => e.title === '停舟客栈');
    assert.equal(inn.relPath, '.novelforge/lore/地域/青崖/停舟客栈.md');
    assert.equal(inn.brief, '镇上唯一的客栈，沈氏开的');
    assert.ok(inn.body.includes('## 概要\n停舟客栈在青崖镇。'), inn.body);
  });

  // 三幕 100 章：第一幕是第 1–20 章。结构指导点明这一批落在第一幕。
  test('大纲带着按总章数算好的结构指导，只写第 1–20 章', async () => {
    const outline = userOf(7);
    assert.ok(outline.includes('第一幕 · 建置（第 1–20 章）') && outline.includes('本次只写第 1–20 章'), outline.slice(0, 4000));
    assert.equal(bundle.outlineFile.outlineCoverage(await project.readOutline()), 20);
  });

  test('细纲批次只带大纲里覆盖这几章的那一节', () => {
    const plots = userOf(8);
    assert.ok(plots.includes('第一幕 · 停舟') && !plots.includes('名册的存在被揭开'), plots.slice(0, 4000));
  });

  // 细纲与单章摘要并成一份之后落在 summaries/ 根下；钩子并进了「看点」，每章都该有一条。
  test('第 1–5 章的细纲都落了盘：标题进文件名，目标字数取每章字数', async () => {
    const plots = await project.listPlots();
    assert.deepEqual(plots.map((p) => p.relPath), [
      '.novelforge/summaries/001-停舟.md',
      '.novelforge/summaries/002-令牌.md',
      '.novelforge/summaries/003-夜访.md',
      '.novelforge/summaries/004-井.md',
      '.novelforge/summaries/005-名册.md',
    ]);
    assert.ok(plots.every((p) => p.targetWords === 3000 && p.sections.看点.trim()), JSON.stringify(plots.map((p) => p.targetWords)));
    // 关键事件落盘成一条一行，与定稿写出来的样子一致。
    assert.equal(plots[1].sections.关键事件, '- 第 2 章：林昭在镇上追查，残令照见一幕。\n- 他为此付出代价。');
  });

  test('细纲里的新角色建了卡，卡片上事先列出过', async () => {
    assert.ok((await project.listCharacters()).some((c) => c.name === '周老汉'));
    assert.ok(gates[6].detail.includes('会新建角色卡：周老汉'), gates[6].detail);
  });

  // 设定名录：新设定随细纲一起建空条目（同 D19），建在它的分类目录里，一句话取蓝图的 note；
  // 用到的已有设定（设定清单排过的青崖镇）只记进第九节，不再建一条。
  test('细纲里的新设定建了空条目，卡片上事先列出过；第九节记下计划用到的设定', async () => {
    const well = (await project.listLore()).find((e) => e.title === '古井');
    assert.ok(well, '建了「古井」');
    assert.equal(well.relPath, '.novelforge/lore/地域/青崖/古井.md');
    assert.equal(well.category, '地域/青崖');
    assert.equal(well.brief, '镇北废宅里的枯井');
    assert.equal((await project.listLore()).filter((e) => e.title === '青崖镇').length, 1);
    assert.ok(gates[6].detail.includes('会新建设定条目：古井'), gates[6].detail);
    assert.ok(!gates[6].detail.includes('青崖镇'), gates[6].detail);
    assert.deepEqual((await project.getPlot(4)).lore, [
      { name: '古井', category: '地域/青崖', note: '镇北废宅里的枯井' },
      { name: '青崖镇', category: '地域', note: '' },
    ]);
  });

  test('拆完细纲，主按钮转到「写第 1 章」', () => {
    assert.equal(finalStep?.label, '写第 1 章', JSON.stringify(finalStep));
  });
});
