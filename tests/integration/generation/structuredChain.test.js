/**
 * 生成链：一件产物分几次调用才拼得出来时，经对话页从生成一路走到落盘。
 *
 * 三条链移植自 AI-Novel-Writer（generation/structured.ts 的文件头有出处）：
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 小说配置 · 一句话 | 截断整份重来、「全局要求」不合格只重写这一节；一句话、规模按弹窗的来；文风写进还没动过的 style.md |
 * | 小说配置 · style.md 改过 | 文风不写进去，并且说出来（第 3 条） |
 * | 角色图谱 | 身份清单 → 每批 3 人补详情；截断拆半；关系由清单生成到双方卡上 |
 * | 细纲批次 | 截断对半拆，后一半看得见前一半；写入卡片列出会新建的角色卡（D19）与降级说明（第 2 条） |
 * | 细纲批次 · 漏章 | 模型正常收尾却漏写：报错、不出卡片、磁盘一个字节不动（fail-closed） |
 * | 细纲批次 · 语法修复 | 只改标点的修复收下；改了内容的拒收 |
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

const OUTLINE = '# 情节大纲\n\n## 第1–20章：第一幕 · 入局\n\n林昭进青云宗，查出第一块令牌的来历。\n';

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

const bp = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章题`,
  role: '铺垫',
  purpose: `第 ${no} 章的目的`,
  keyEvents: `第 ${no} 章的关键事件：林昭在两个场面上推进。`,
  characters: ['林昭'],
  suspenseHook: `第 ${no} 章的钩子`,
  ...over,
});
const batchOf = (...items) => JSON.stringify({ blueprints: items });
const PLOT_T = (no) => ({ kind: 'plot', plotRelPath: `.novelforge/plots/${String(no).padStart(3, '0')}.md` });

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
      { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '背着旧案入宗', relations: [{ targetSlotId: '2', relation: '同门，互相试探' }] },
      { slotId: '2', name: '沈青', role: 'supporting', narrativeDuty: '引路人', relations: [] },
      { slotId: '3', name: '周岳', role: 'antagonist', narrativeDuty: '执法堂首座', relations: [{ targetSlotId: '1', relation: '处处压制' }] },
      { slotId: '4', name: '韩七', role: 'minor', narrativeDuty: '杂役', relations: [] },
    ],
  };
  const detail = (id, name) => ({ slotId: id, name, 身份: `${name}的身份`, 外貌: '青衫', 性格: '冷', 语言习惯: '少言', 当前状态: '在山门', 未收伏笔: '无' });
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
    // 详情那一步带着冻结清单。
    assert.ok(userOf(1).includes('【冻结身份与关系清单】') && userOf(1).includes('"name":"周岳"'), userOf(1).slice(-1200));
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
});

// ---------------------------------------------------------------- 细纲批次

describe('细纲批次 · 截断对半拆', () => {
  let r;

  before(async () => {
    t.write('.novelforge/config.md', CONFIG);
    t.write('.novelforge/outline.md', OUTLINE);
    project.invalidate();
    fake.reset([
      { text: batchOf(bp(1), bp(2)), stop: 'maxTokens' },
      { text: batchOf(bp(1), bp(2, { characters: ['林昭', '苏晚'], newCharacters: [{ name: '苏晚', role: 'supporting' }] })), stop: 'end' },
      { text: batchOf(bp(3), bp(4), bp(5)), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(1), range: { from: 1, to: 5 } });
  });

  test('第一次截断 → 1–2 章、3–5 章各一次', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(1).includes('第 1–2 章') && userOf(2).includes('第 3–5 章'), `${userOf(1).slice(-300)}\n${userOf(2).slice(-300)}`);
  });

  // 后一半要接得上前一半——前一半还没落盘，前序细纲一览把它接在最后。
  test('后一半看得见前一半刚排好的那两章', () => {
    assert.ok(userOf(2).includes('第2章 第2章题（刚排好，还没写入文件）'), userOf(2).slice(0, 3000));
  });

  test('卡片：落点是第 1–5 章，列出会新建的角色卡与降级说明', () => {
    assert.ok(r.gate.title.includes('第 1–5 章 · 细纲'), r.gate.title);
    assert.ok(r.gate.detail.includes('会新建角色卡：苏晚'), r.gate.detail);
    assert.ok(r.gate.detail.includes('被输出上限截断，拆成两半重试'), r.gate.detail);
  });

  test('五份细纲都落盘：标题进文件名，目标字数取配置的每章字数', async () => {
    const plots = await project.listPlots();
    assert.deepEqual(plots.map((p) => p.no), [1, 2, 3, 4, 5]);
    assert.equal(plots[0].relPath, '.novelforge/plots/001-第1章题.md');
    assert.ok(plots.every((p) => p.targetWords === 400), JSON.stringify(plots.map((p) => p.targetWords)));
    assert.equal(plots[2].sections.章末钩子, '第 3 章的钩子');
  });

  test('新角色建了卡（D19）', async () => {
    const su = (await project.listCharacters()).find((c) => c.name === '苏晚');
    assert.ok(su && su.tags.includes('配角') && su.sections.身份.includes('第 2 章'), JSON.stringify(su));
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

describe('细纲批次 · 语法修复', () => {
  const broken = batchOf(bp(6), bp(7)).replace(/}]}$/, '},]}');

  test('只改标点的修复收下', async () => {
    fake.reset([{ text: broken, stop: 'end' }, { text: batchOf(bp(6), bp(7)), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 2);
    assert.ok(fake.calls[1][0].content.includes('结构化 JSON 语法修复器'), fake.calls[1][0].content);
    assert.ok(r.gate && r.gate.detail.includes('修了一次（只改标点）'), JSON.stringify(r.gate ?? r.errors));
  });

  // 修复只许改标点——借机把关键事件改写一遍，就是一次没经过装配器的第二次生成。
  test('改了内容的修复拒收', async () => {
    fake.reset([{ text: broken, stop: 'end' }, { text: batchOf(bp(6, { keyEvents: '改写过的事件' }), bp(7)), stop: 'end' }]);
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('语法修复改动了细纲的内容')), r.errors.join('|'));
  });
});

describe('细纲批次 · 单章缺字段 → 紧凑重建', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: batchOf(bp(6, { suspenseHook: '' })), stop: 'end' },
      { text: batchOf(bp(6)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('重建那一次写明上次哪里不合格', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(1).includes('blueprints[0].suspenseHook') && userOf(1).includes('必须且只能返回 chapterNumber=6 的一项'), userOf(1).slice(-600));
  });

  test('卡片上说出重建过', () => {
    assert.ok(r.gate.detail.includes('单章重建一次'), r.gate.detail);
  });
});

// ---------------------------------------------------------------- 大纲续写

describe('大纲续写 · 只并进那一段', () => {
  let r;
  let reviewed;

  before(async () => {
    fake.reset([{ text: '## 第21–30章：第二幕 · 风起\n\n名册浮出水面。', stop: 'end' }]);
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
    assert.ok(outline.indexOf('第1–20章') < outline.indexOf('第21–30章'));
  });
});
