/**
 * 生成链：一件产物分几次调用才拼得出来时，经对话页从生成一路走到落盘。
 *
 * 三条链移植自 AI-Novel-Writer（generation/structured.ts 的文件头有出处）：
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 小说配置 · 一句话 | 截断整份重来、「全局要求」不合格只重写这一节；一句话、规模按弹窗的来；文风写进还没动过的 style.md |
 * | 小说配置 · style.md 改过 | 文风不写进去，并且说出来（第 3 条） |
 * | 角色图谱 | 身份清单 → 每批 3 人补详情；截断拆半；关系由清单生成到双方卡上；性别在清单里定、落进卡的 frontmatter |
 * | 细纲批次 | 截断对半拆，后一半看得见前一半；写入卡片列出会新建的角色卡（D19）与降级说明（第 2 条） |
 * | 细纲批次 · 漏章 | 模型正常收尾却漏写：报错、不出卡片、磁盘一个字节不动（fail-closed） |
 * | 细纲批次 · JSON 语法坏了 | 细纲试点起交给转写理顺：照抄的收下；改了内容的不收、重转一次 |
 * | 细纲批次 · 缺字段 | 单章紧凑重建一次，写明上次哪里不合格 |
 * | 大纲续写 | 只并进那一段，纯续写不弹审阅 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;
let gates;
let onGate = async () => 'proceed';

const CONFIG = [
  '---',
  'genre: 玄幻',
  'structure: three_act',
  'totalChapters: 30',
  'wordsPerChapter: 400',
  '---',
  '# 小说配置',
  '## 一句话',
  '少年入宗查旧案',
  '## 核心梗概',
  '林昭背着灭门旧案进青云宗。',
].join('\n');

const OUTLINE = outlineOf(20, { titles: { 1: '入局' }, text: { 1: '林昭进青云宗，查出第一块令牌的来历。' } });

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
}

async function send(payload) {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', targetNo: 0, attachments: [], excludedIds: [], ...payload },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    gate: gates[0],
    errors: posted.filter((m) => m.type === 'toast' && m.level === 'error').map((m) => m.message),
  };
}

/** 最后一次调用的 user 消息。 */
const userOf = (i) => {
  const msgs = fake.calls[i];
  return msgs[msgs.length - 1].content;
};

// 新合同：梗概 / 出场人物 / 时间地点 / 关键事件 / 看点 / 状态变更（连续性事实定稿时才有）。
// 章末钩子并进了看点，role 与 purpose 都没了。关键事件与定稿一样是一条一件事的数组（⚑B）。
const bp = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章题`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭'],
  timePlace: '青云宗山门，入夜',
  keyEvents: [`第 ${no} 章的关键事件：林昭在山门外踩点。`, '他翻墙进了后院，落在藏书阁门口。'],
  highlights: [`第 ${no} 章的钩子`],
  foreshadowing: [],
  stateChange: '',
  ...over,
});
const batchOf = (...items) => JSON.stringify({ blueprints: items });
const PLOT_T = (no) => ({ kind: 'plot', plotRelPath: `.novelforge/summaries/${String(no).padStart(3, '0')}.md` });

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'chain', title: '青云剑录' });
  project = t.project;
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

// ---------------------------------------------------------------- 小说配置

const GOOD_CONFIG = {
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '宗门 · 查案',
  plotStructure: 'heros_journey',
  narrativePOV: 'third_limited',
  coreOutline: '少年背着灭门旧案入宗，查出宗门与旧案的关系，最后在师门与真相之间做出选择。',
  worldSetting: '灵脉枯竭的九州。',
  goldenFinger: '一块能回放死者最后一刻的残令，每用一次折寿一月。',
  protagonistProfile: '林昭，隐忍，想替父洗冤。',
  globalGuidance: Array.from({ length: 10 }, (_, i) => `${i + 1}. 规则${i + 1}`).join('\n'),
  writingStyle: '冷峻克制，短句为主，少用比喻。',
};
const GOOD_GUIDANCE = '1. 不写上帝视角\n2. 每章留钩子\n3. 残令每次使用都有代价\n4. 对白分得出是谁在说';

describe('小说配置 · 从一句话生成', () => {
  let r;
  let calls;

  before(async () => {
    fake.reset([
      { text: '{"genre":"玄幻","coreOutline":"少年背着', stop: 'maxTokens' },
      { text: JSON.stringify(GOOD_CONFIG), stop: 'end' },
      { text: GOOD_GUIDANCE, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({
      text: '少年背着灭门旧案进宗门',
      stage: 'setting',
      capability: 'generate',
      target: { kind: 'setting', doc: 'config' },
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    calls = fake.callCount();
  });

  test('截断整份重来 1 次、全局要求重写 1 次：一共 3 次', () => {
    assert.equal(calls, 3);
    assert.ok(userOf(1).includes('上一轮输出因长度限制而中断'), userOf(1).slice(-600));
    assert.ok(userOf(2).includes('只纠正小说配置中的 globalGuidance 字段'), userOf(2).slice(0, 200));
  });

  test('卡片上写清调了几次、为什么', () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('一共调了 3 次模型'), r.gate.detail);
    assert.ok(r.gate.detail.includes('被输出上限截断') && r.gate.detail.includes('全局要求有 10 条'), r.gate.detail);
  });

  test('config.md：一句话是作者的原话，规模按弹窗，全局要求用重写的那一版', async () => {
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, '少年背着灭门旧案进宗门');
    assert.equal(book.totalChapters, 100);
    assert.equal(book.wordsPerChapter, 3000);
    assert.equal(book.structure, 'heros_journey');
    assert.equal(book.sections.全局要求, GOOD_GUIDANCE);
    assert.equal(book.sections.金手指, GOOD_CONFIG.goldenFinger);
  });

  // D14：文风不进 config.md。style.md 还是初始化那份模板，替换它不吞掉作者的一个字。
  test('文风写进还没动过的 style.md，不进 config.md', async () => {
    assert.ok((await project.readStyleGuide()).includes('冷峻克制'));
    assert.ok(!t.read('.novelforge/config.md').includes('冷峻克制'));
  });
});

describe('小说配置 · style.md 已经改过', () => {
  let r;
  let toasts;

  before(async () => {
    t.write('.novelforge/style.md', '# 文风指南\n\n作者自己写的文风。\n');
    t.write('.novelforge/config.md', CONFIG);
    project.invalidate();
    fake.reset([{ text: JSON.stringify({ ...GOOD_CONFIG, globalGuidance: GOOD_GUIDANCE }), stop: 'end' }]);
    h.expect();
    r = await send({
      text: '少年入宗查旧案，要更黑暗',
      stage: 'setting',
      capability: 'generate',
      target: { kind: 'setting', doc: 'config' },
      setup: { totalChapters: 30, wordsPerChapter: 400 },
    });
    toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
  });

  test('一次就过：只调 1 次', () => {
    assert.equal(fake.callCount(), 1);
  });

  test('style.md 一个字没动，并且说出来', () => {
    assert.equal(t.read('.novelforge/style.md'), '# 文风指南\n\n作者自己写的文风。\n');
    assert.ok(toasts.some((m) => m.includes('style.md 已有内容')), toasts.join('|'));
  });

  // 上游 mergeExpandedNovelConfig：作者写过的保留原文，生成的追加在后。
  test('保留原文，追加生成', async () => {
    const book = await project.readBookConfig();
    assert.ok(book.sections.核心梗概.startsWith('林昭背着灭门旧案进青云宗。\n\n'), book.sections.核心梗概);
    assert.equal(book.genre, '玄幻');
    assert.ok(r.gate.detail.includes('保留原文'), r.gate.detail);
  });
});

// ---------------------------------------------------------------- 角色图谱

describe('角色图谱 · 两段式', () => {
  const manifest = {
    slots: [
      { slotId: '1', name: '林昭', role: 'protagonist', gender: '男', narrativeDuty: '背着旧案入宗', relations: [{ targetSlotId: '2', relation: '同门，互相试探' }] },
      { slotId: '2', name: '沈青', role: 'supporting', gender: 'female', narrativeDuty: '引路人', relations: [] },
      { slotId: '3', name: '周岳', role: 'antagonist', narrativeDuty: '执法堂首座', relations: [{ targetSlotId: '1', relation: '处处压制' }] },
      { slotId: '4', name: '韩七', role: 'minor', narrativeDuty: '杂役', relations: [] },
    ],
  };
  const detail = (id, name) => ({ slotId: id, name, 身份: `${name}的身份`, 外貌: '青衫', 性格: '冷', 语言习惯: '少言', 当前状态: '在山门', 暗设: '无' });
  let r;
  let cards;

  before(async () => {
    for (const c of await project.listCharacters()) {
      t.remove(c.relPath);
    }
    project.invalidate();
    fake.reset([
      { text: JSON.stringify(manifest), stop: 'end' },
      // 第一批 3 人被截断：拆成 1 人 + 2 人重试。
      { text: '{"entries":[{"slotId":"1"', stop: 'maxTokens' },
      { text: JSON.stringify({ entries: [detail('1', '林昭')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('2', '沈青'), detail('3', '周岳')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('4', '韩七')] }), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'characters' } });
    cards = await project.listCharacters();
  });

  test('清单 1 次 + 详情（截断拆半）4 次', () => {
    assert.equal(fake.callCount(), 5);
    // 详情那一步带着冻结清单（2026-10-25 起一人一行，不再是 JSON），点名这一批写谁。
    assert.ok(userOf(1).includes('【冻结身份与关系清单】') && userOf(1).includes('- 周岳（反派）：执法堂首座'), userOf(1).slice(-1200));
    assert.ok(userOf(1).includes('【本批要写详情的人】\n林昭、沈青、周岳'), userOf(1).slice(-1200));
    assert.ok(userOf(1).includes('  - 与沈青：同门，互相试探'), userOf(1).slice(-1200));
  });

  test('卡片上说出拆半重试', () => {
    assert.ok(r.gate.detail.includes('拆成两半重试'), r.gate.detail);
    assert.ok(r.gate.detail.includes('角色图谱 · 4 人'), r.gate.detail);
  });

  test('四张卡都建了，定位进 tags，关系写到双方卡上', () => {
    assert.deepEqual(cards.map((c) => c.name).sort(), ['周岳', '林昭', '沈青', '韩七'].sort());
    const lin = cards.find((c) => c.name === '林昭');
    assert.deepEqual(lin.tags, ['主角']);
    assert.ok(lin.sections.人物关系.includes('- 与沈青：同门，互相试探'), lin.sections.人物关系);
    assert.ok(lin.sections.人物关系.includes('- 与周岳：周岳眼中——处处压制'), lin.sections.人物关系);
    assert.ok(lin.sections.身份.includes('叙事职责：背着旧案入宗'), lin.sections.身份);
  });

  // 名字看不出性别时写正文只能猜：性别在清单那一步定，跟着冻结清单进详情、落在卡的 frontmatter 上。
  test('性别：清单里定，详情那一步看得见，落盘成 frontmatter；没给的不写', () => {
    assert.ok(userOf(1).includes('- 沈青（配角，女）：引路人'), userOf(1).slice(-1200));
    assert.equal(cards.find((c) => c.name === '林昭').gender, '男');
    const shen = cards.find((c) => c.name === '沈青');
    assert.equal(shen.gender, '女');
    assert.match(t.read(shen.relPath), /^gender: 女$/m);
    assert.equal(cards.find((c) => c.name === '周岳').gender, undefined);
  });
});

// ---------------------------------------------------------------- 细纲批次

describe('细纲批次 · 截断对半拆', () => {
  let r;

  before(async () => {
    t.write('.novelforge/config.md', CONFIG);
    writeOutline(t, OUTLINE);
    project.invalidate();
    fake.reset([
      { text: batchOf(bp(1), bp(2)), stop: 'maxTokens' },
      { text: batchOf(bp(1), bp(2, { characters: ['林昭', '苏晚'], newCharacters: [{ name: '苏晚', role: 'supporting', gender: '女' }] })), stop: 'end' },
      { text: batchOf(bp(3), bp(4), bp(5)), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(1), range: { from: 1, to: 5 } });
  });

  test('第一次截断 → 1–2 章、3–5 章各一次', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(1).includes('第 1–2 章') && userOf(2).includes('第 3–5 章'), `${userOf(1).slice(-300)}\n${userOf(2).slice(-300)}`);
  });

  // 后一半要接得上前一半——前一半还没落盘，前序细纲一览把它接在最后；关键事件一章一行，条与条之间用「；」接。
  test('后一半看得见前一半刚排好的那两章', () => {
    assert.ok(
      userOf(2).includes('第2章 第2章题（刚排好，还没写入文件）：第 2 章的关键事件：林昭在山门外踩点。；他翻墙进了后院，落在藏书阁门口。'),
      userOf(2).slice(0, 3000)
    );
  });

  test('卡片：落点是第 1–5 章，列出会新建的角色卡与降级说明', () => {
    assert.ok(r.gate.title.includes('第 1–5 章 · 细纲'), r.gate.title);
    assert.ok(r.gate.detail.includes('会新建角色卡：苏晚'), r.gate.detail);
    assert.ok(r.gate.detail.includes('被输出上限截断，拆成两半重试'), r.gate.detail);
  });

  // 关键事件、看点都是一条一句的列表，落盘成 `- 一条` 一行，与定稿写出来的样子一致。
  test('五份细纲都落盘：标题进文件名，目标字数取配置的每章字数', async () => {
    // 第 6–20 章只有梗概（大纲排到了、细纲还没拆）：看排过的那几份。
    const plots = (await project.listPlots()).filter((p) => p.sections.关键事件.trim());
    assert.deepEqual(plots.map((p) => p.no), [1, 2, 3, 4, 5]);
    // 标题取大纲里那一条的（空壳上已经有了），不换成模型起的。
    assert.equal(plots[0].relPath, '.novelforge/summaries/001-入局.md');
    assert.ok(plots.every((p) => p.targetWords === 400), JSON.stringify(plots.map((p) => p.targetWords)));
    assert.equal(plots[2].sections.看点, '- 第 3 章的钩子');
    assert.equal(plots[2].sections.关键事件, '- 第 3 章的关键事件：林昭在山门外踩点。\n- 他翻墙进了后院，落在藏书阁门口。');
  });

  test('新角色建了卡（D19），性别落在卡上', async () => {
    const su = (await project.listCharacters()).find((c) => c.name === '苏晚');
    assert.ok(su && su.tags.includes('配角') && su.sections.身份.includes('第 2 章'), JSON.stringify(su));
    assert.equal(su.gender, '女');
  });

  test('全书下一步转去写第 1 章', async () => {
    const next = posted.filter((m) => m.type === 'pipeline').pop()?.next;
    assert.ok(next && next.label === '写第 1 章', JSON.stringify(next));
  });
});

describe('细纲批次 · 漏章 fail-closed', () => {
  let r;
  let before6;

  before(async () => {
    before6 = (await project.listPlots()).length;
    fake.reset([{ text: batchOf(bp(6), bp(7), bp(9), bp(10)), stop: 'end' }]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 10 } });
  });

  test('报错说出漏了哪一章，不出卡片', () => {
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('漏写了第 8 章')), r.errors.join('|'));
  });

  test('只调了 1 次（对偷懒的输出不重试）', () => {
    assert.equal(fake.callCount(), 1);
  });

  test('磁盘上一份细纲都没多', async () => {
    assert.equal((await project.listPlots()).length, before6);
  });

  test('已经收到的输出留在气泡里', () => {
    assert.ok(r.assistant.content.includes('第 6 章的关键事件'), r.assistant.content.slice(0, 200));
  });
});

// 细纲试点（2026-10-25）：从前的语法修复换成了转写——坏了语法的 JSON 也交给转写模型理顺，照抄的收下，改了字的重转。
describe('细纲批次 · JSON 语法坏了交给转写', () => {
  const broken = batchOf(bp(6), bp(7)).replace(/}]}$/, '},]}');

  test('照抄的转写收下', async () => {
    fake.reset([{ text: broken, stop: 'end' }, { text: batchOf(bp(6), bp(7)), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 2);
    assert.ok(fake.calls[1][0].content.includes('格式转写员'), fake.calls[1][0].content);
    assert.ok(r.gate && r.gate.detail.includes('调了 2 次'), JSON.stringify(r.gate ?? r.errors));
  });

  // 转写只许照抄——借机把关键事件改写一遍，就是一次没经过装配器的第二次生成。
  test('改了内容的转写不收，重转一次', async () => {
    fake.reset([
      { text: broken, stop: 'end' },
      { text: batchOf(bp(6, { keyEvents: ['改写过的事件'] }), bp(7)), stop: 'end' },
      { text: batchOf(bp(6), bp(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 3);
    assert.ok(fake.calls[2][1].content.includes('【上次转写不合格】这几处不是原文里的字：「改写过的事件」'), fake.calls[2][1].content.slice(0, 400));
    assert.ok(r.gate && r.gate.detail.includes('重转一次'), JSON.stringify(r.gate ?? r.errors));
  });

  // 复跑报告问题 7：模型在结尾多写了一个 `]`——转写理顺之后照收。
  test('结尾多写了一个收尾括号：转写理顺之后收下', async () => {
    fake.reset([{ text: batchOf(bp(6), bp(7)).replace(/]}$/, ']]}'), stop: 'end' }, { text: batchOf(bp(6), bp(7)), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 2);
    assert.ok(r.gate, JSON.stringify(r.errors));
  });
});

describe('细纲批次 · 单章缺字段 → 紧凑重建', () => {
  let r;

  // 梗概是必填的三个字段之一（另两个是 title、keyEvents）；看点、伏笔这类可以空着，空了不重建。
  before(async () => {
    fake.reset([
      { text: batchOf(bp(6, { synopsis: '' })), stop: 'end' },
      { text: batchOf(bp(6)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('重建那一次写明上次哪里不合格', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(1).includes('「梗概」那一节缺了或是空的') && userOf(1).includes('只写第 6 章这一章'), userOf(1).slice(-600));
  });

  test('卡片上说出重建过', () => {
    assert.ok(r.gate.detail.includes('单章重建一次'), r.gate.detail);
  });
});

// 关键事件是空数组：与缺梗概一样是必填项不合格，单章紧凑重建；重建时给成一段字（老合同的形状）照收。
describe('细纲批次 · 关键事件空着 → 紧凑重建，一段字照收', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: batchOf(bp(6, { keyEvents: [] })), stop: 'end' },
      { text: batchOf(bp(6, { keyEvents: '林昭踩点；翻墙进了后院\n- 落在藏书阁门口' })), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('重建那一次写明是关键事件空着', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(1).includes('「关键事件」那一节缺了或是空的'), userOf(1).slice(-600));
    assert.ok(r.gate.detail.includes('单章重建一次'), r.gate.detail);
  });

  test('一段字按换行与分号切成条，落盘一条一行', async () => {
    const plot = (await project.listPlots()).find((p) => p.no === 6);
    assert.equal(plot?.sections.关键事件, '- 林昭踩点\n- 翻墙进了后院\n- 落在藏书阁门口', JSON.stringify(plot?.sections));
  });
});

// ---------------------------------------------------------------- 大纲续写

describe('大纲续写 · 只并进那一段', () => {
  let r;
  let reviewed;

  before(async () => {
    fake.reset([{ text: outlineOf(30, { from: 21, heading: false, titles: { 21: '风起' }, text: { 21: '名册浮出水面。' } }), stop: 'end' }]);
    onGate = async () => 'proceed';
    h.expect();
    r = await send({ stage: 'outline', capability: 'generate', target: { kind: 'outline' }, range: { from: 21, to: 30 } });
    reviewed = h.reviewed.length;
  });

  test('卡片：落点是那一段，不说「覆盖」', () => {
    assert.ok(r.gate.title.includes('写入到「情节大纲 · 第 21–30 章」'), r.gate.title);
  });

  // 纯续写一个字都不吞，不弹审阅。
  test('不弹审阅，前 20 章原样在，新的一段接在后面', async () => {
    assert.equal(reviewed, 0);
    const outline = await project.readOutline();
    assert.ok(outline.includes('林昭进青云宗，查出第一块令牌的来历。') && outline.includes('名册浮出水面。'), outline);
    assert.ok(outline.indexOf('## 第20章') < outline.indexOf('## 第21章：风起'));
    assert.equal((outline.match(/^## 第\d+章/gm) ?? []).length, 30, '第 1–30 章各一条');
  });
});

// ---------------------------------------------------------------- 按格式写、转写成 JSON（2026-10-25 起）

const TRANSCRIBER = '格式转写员';
const systemOf = (i) => fake.calls[i][0].content;

/** 写配置的模型按小标题写出来的一份。 */
const CONFIG_PROSE = [
  '## 类型',
  '仙侠',
  '## 受众',
  '男频',
  '## 细分类型',
  '宗门 · 复仇',
  '## 故事结构',
  '英雄之旅',
  '## 叙事视角',
  '第三人称有限视角',
  '## 一句话卖点',
  '无',
  '## 核心梗概',
  '孤儿入宗复仇，一路查到宗主头上。',
  '## 核心卖点',
  '- 残令回放死者最后一刻',
  '- 执法堂步步紧逼',
  '## 世界观要点',
  '灵脉枯竭，宗门垄断灵石。',
  '## 金手指',
  '残令：每回放一次折寿一月。',
  '## 主角档案',
  '沈默寡言，记仇。',
  '## 全局要求',
  '1. 不写上帝视角',
  '2. 每章留钩子',
  '3. 残令每次使用都有代价',
  '4. 对白分得出是谁在说',
  '## 文风',
  '冷峻克制，短句为主。',
  '## 参考作品',
  '无',
].join('\n');
const CONFIG_COPIED = {
  genre: '仙侠',
  targetAudience: '男频',
  subGenre: '宗门 · 复仇',
  plotStructure: 'heros_journey',
  narrativePOV: 'third_limited',
  logline: '无',
  coreOutline: '孤儿入宗复仇，一路查到宗主头上。',
  sellingPoints: '- 残令回放死者最后一刻\n- 执法堂步步紧逼',
  worldSetting: '灵脉枯竭，宗门垄断灵石。',
  goldenFinger: '残令：每回放一次折寿一月。',
  protagonistProfile: '沈默寡言，记仇。',
  globalGuidance: '1. 不写上帝视角\n2. 每章留钩子\n3. 残令每次使用都有代价\n4. 对白分得出是谁在说',
  writingStyle: '冷峻克制，短句为主。',
  referenceWorks: '',
};

describe('小说配置 · 按格式写、转写成 JSON', () => {
  let r;

  before(async () => {
    t.write('.novelforge/config.md', CONFIG);
    project.invalidate();
    fake.reset([
      { text: CONFIG_PROSE, stop: 'end' },
      { text: JSON.stringify(CONFIG_COPIED), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ text: '要更黑暗', stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'config' } });
  });

  test('写一次、转一次；写配置的提示词不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(0).includes('【小说配置格式】') && userOf(0).includes('不写 JSON') && !userOf(0).includes('"coreOutline"'), userOf(0).slice(-800));
  });

  // 转写只看原文：给多了它会顺手补内容。
  test('转写只带合同与原文，不带书的上下文', () => {
    assert.ok(!systemOf(0).includes(TRANSCRIBER) && systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【小说配置 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('残令：每回放一次折寿一月。'), userOf(1));
    assert.ok(!userOf(1).includes('林昭背着灭门旧案进青云宗'), userOf(1));
  });

  test('照抄的落进 config.md：中文词对到故事结构，八节照原文', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('一共调了 2 次模型'), r.gate.detail);
    project.invalidate();
    const book = await project.readBookConfig();
    assert.equal(book.structure, 'heros_journey');
    assert.equal(book.pov, 'third_limited');
    assert.equal(book.sections.金手指, '残令：每回放一次折寿一月。');
    assert.equal(book.sections.全局要求, CONFIG_COPIED.globalGuidance);
  });
});

describe('小说配置 · 转写两次都改了字：按小节读原文', () => {
  let r;

  before(async () => {
    t.write('.novelforge/config.md', CONFIG);
    project.invalidate();
    const reworded = JSON.stringify({ ...CONFIG_COPIED, goldenFinger: '残令能回放死者临终一幕，代价是折寿。' });
    fake.reset([
      { text: CONFIG_PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ text: '要更黑暗', stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'config' } });
  });

  test('重转一次，说清哪几处不是原文里的字', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「残令能回放死者临终一幕，代价是折寿。」'), userOf(2).slice(0, 800));
  });

  test('不报错：卡片上说清没转成、按小节读了原文；八节照原文落盘', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('没能整理成 JSON') && r.gate.detail.includes('按小节读了原文'), r.gate.detail);
    project.invalidate();
    const book = await project.readBookConfig();
    assert.equal(book.sections.金手指, '残令：每回放一次折寿一月。');
    assert.ok(book.sections.核心梗概.includes('孤儿入宗复仇'), book.sections.核心梗概);
  });
});

describe('角色图谱 · 按格式写、转写成 JSON', () => {
  const MANIFEST_PROSE = [
    '## 林昭',
    '- 定位：主角',
    '- 性别：男',
    '- 叙事职责：背着旧案入宗',
    '- 关系：',
    '  - 与沈青：同门，互相试探',
    '## 沈青',
    '- 定位：配角',
    '- 性别：女',
    '- 叙事职责：引路人',
    '- 关系：无',
    '## 周岳',
    '- 定位：反派',
    '- 性别：男',
    '- 叙事职责：执法堂首座',
    '- 关系：',
    '  - 与林昭：处处压制',
  ].join('\n');
  // 转写模型把定位照抄成了中文（「主角」）：程序对回英文值，不按配角算。
  const MANIFEST_COPIED = {
    slots: [
      { slotId: '林昭', name: '林昭', role: '主角', gender: '男', narrativeDuty: '背着旧案入宗', relations: [{ targetSlotId: '沈青', relation: '同门，互相试探' }] },
      { slotId: '沈青', name: '沈青', role: 'supporting', gender: '女', narrativeDuty: '引路人', relations: [] },
      { slotId: '周岳', name: '周岳', role: 'antagonist', gender: '男', narrativeDuty: '执法堂首座', relations: [{ targetSlotId: '林昭', relation: '处处压制' }] },
    ],
  };
  const person = (name) => [`## ${name}`, '### 身份', `${name}出身寒门。`, '### 外貌', '青衫', '### 性格', '冷', '### 语言习惯', '少言', '### 当前状态', '在山门', '### 暗设', '无', '### 专属称呼', '无'];
  const DETAILS_PROSE = ['林昭', '沈青', '周岳'].flatMap(person).join('\n');
  const detail = (name, over = {}) => ({ name, 身份: `${name}出身寒门。`, 外貌: '青衫', 性格: '冷', 语言习惯: '少言', 当前状态: '在山门', 暗设: '无', aliases: [], ...over });
  let r;
  let cards;

  before(async () => {
    for (const c of await project.listCharacters()) {
      t.remove(c.relPath);
    }
    project.invalidate();
    fake.reset([
      { text: MANIFEST_PROSE, stop: 'end' },
      { text: JSON.stringify(MANIFEST_COPIED), stop: 'end' },
      { text: DETAILS_PROSE, stop: 'end' },
      // 改了一个人的身份：不收，重转一次。
      { text: JSON.stringify({ entries: [detail('林昭', { 身份: '林昭是寒门子弟。' }), detail('沈青'), detail('周岳')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('林昭'), detail('沈青'), detail('周岳')] }), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'characters' } });
    project.invalidate();
    cards = await project.listCharacters();
  });

  test('清单写 1、转写 1；详情写 1、转写 2（改了字重转一次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok([1, 3, 4].every((i) => systemOf(i).includes(TRANSCRIBER)) && !systemOf(0).includes(TRANSCRIBER) && !systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(0).includes('【身份清单格式】') && userOf(0).includes('不写 JSON'), userOf(0).slice(-800));
    assert.ok(userOf(1).includes('【身份清单 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('- 叙事职责：执法堂首座'), userOf(1));
    assert.ok(userOf(4).includes('【上次转写不合格】这几处不是原文里的字：「林昭是寒门子弟。」'), userOf(4).slice(0, 800));
  });

  test('详情那一步按冻结清单点名，按小标题写', () => {
    assert.ok(userOf(2).includes('- 林昭（主角，男）：背着旧案入宗\n  - 与沈青：同门，互相试探'), userOf(2).slice(-1500));
    assert.ok(userOf(2).includes('【本批要写详情的人】\n林昭、沈青、周岳') && userOf(2).includes('【角色详情格式】'), userOf(2).slice(-1500));
  });

  test('三张卡都建了：中文定位对回来，关系写到双方卡上，身份照原文', () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('重转一次'), r.gate.detail);
    const lin = cards.find((c) => c.name === '林昭');
    assert.deepEqual(lin.tags, ['主角']);
    assert.equal(lin.gender, '男');
    assert.ok(lin.sections.身份.startsWith('林昭出身寒门。'), lin.sections.身份);
    assert.ok(lin.sections.人物关系.includes('- 与沈青：同门，互相试探') && lin.sections.人物关系.includes('周岳眼中——处处压制'), lin.sections.人物关系);
    assert.equal(cards.find((c) => c.name === '沈青').gender, '女');
  });
});
