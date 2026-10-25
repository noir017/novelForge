/**
 * 细纲试点（2026-10-25）：写细纲的模型按小标题写自然语言，转写模型照抄成 JSON。
 *
 * 作者实测同一份上下文，要模型直接出 JSON 写出来的细纲明显不如放开写。于是细纲（单章、批次、批量拆细纲）的提示词不再
 * 要 JSON，转写那一步由「转写」那一档的模型做：作者定的是**固定的转写模型**——不跟对话页选的、也不跟确认框上为这一次
 * 挑的模型。那一档没配就沿用默认模型。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 批次 · 照抄收下 | 写一次、转一次；写细纲的是对话页那个模型，转写的是转写那一档；转写只看原文，不带书的上下文；气泡换成规范化 JSON |
 * | 批次 · 改了字 | 转写改了原文的字不收，重转一次（说清哪几处）；全程只重转一次，还改就对半拆、各写各转 |
 * | 批次 · 原文没写那一章 | 偷懒：报漏写，不重转（转写搬不出原文没有的章） |
 * | 批次 · 不像细纲 | 连「梗概」「关键事件」都没有的输出不花转写那一次，按解不出来走拆半 / 重建 |
 * | 单章 | 写第 N 章细纲也转写；照抄的落进细纲七节与「设定」一节 |
 * | 单章 · 转写两次不合格 | 按小节读原文，叙事线计划与「设定」一节带不上，说明里写清 |
 * | 批量拆细纲 · 确认框钉了模型 | 写细纲用钉的那个，转写照样走转写那一档（第 12 条的例外） |
 * | 转写模型调用失败 | 写好的原文不丢：单章按小节读、说明里写清；批次报错，原文留在气泡里 |
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
let onGate = async () => 'skip';
/** 按模型引用注入异常（fakeProvider 的 behavior）：建 provider 时现读，改它只影响之后建的。 */
const behavior = {};

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
const THREAD = '.novelforge/threads/青云旧案.md';

/** 写细纲的模型按格式写出来的一章。 */
const prose = (no) =>
  [
    `## 第${no}章：第${no}章题`,
    '### 梗概',
    `第 ${no} 章的梗概`,
    '### 出场人物',
    '林昭、沈青',
    '### 时间地点',
    '青云宗山门，入夜',
    '### 关键事件',
    `- 第 ${no} 章：林昭在山门外踩点。`,
    '- 他翻墙进了后院，落在藏书阁门口。',
    '### 看点',
    `- 第 ${no} 章的钩子`,
    '### 状态变更',
    '无',
    '### 叙事线',
    '- 青云旧案·推进：林昭摸到藏书阁。',
    '### 新角色',
    '无',
    '### 设定',
    '- 藏经阁（地点，新）：宗门藏旧卷宗的地方。',
  ].join('\n');

/** 转写模型照抄出来的那一章。 */
const copied = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章题`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭', '沈青'],
  timePlace: '青云宗山门，入夜',
  keyEvents: [`第 ${no} 章：林昭在山门外踩点。`, '他翻墙进了后院，落在藏书阁门口。'],
  highlights: [`第 ${no} 章的钩子`],
  stateChange: '无',
  threads: [{ line: '青云旧案', type: '推进', what: '林昭摸到藏书阁。' }],
  newCharacters: [],
  settings: [{ name: '藏经阁', category: '地点', isNew: true, note: '宗门藏旧卷宗的地方。' }],
  ...over,
});
const json = (...items) => JSON.stringify({ blueprints: items });
const PLOT_T = (no) => ({ kind: 'plot', plotRelPath: `.novelforge/summaries/${String(no).padStart(3, '0')}.md` });
const TRANSCRIBER = '格式转写员';

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

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    batch: './src/core/features/pipelineBatch.ts',
    db: './src/core/runtime/db.ts',
  });
  // 对话页选的是 big；转写那一档（缺省快速档）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'transcribe', title: '青云剑录' });
  project = t.project;
  t.write('.novelforge/config.md', CONFIG);
  writeOutline(t, OUTLINE);
  // 有一条线：批量拆细纲就不先排线。
  t.write(THREAD, '---\nkind: 主线\n---\n\n# 青云旧案\n\n## 意图\n十年前那把火。\n');
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('细纲批次 · 按小标题写，转写模型照抄成 JSON', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' },
      { text: json(copied(6), copied(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('写一次、转一次', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(r.gate && r.gate.detail.includes('调了 2 次'), JSON.stringify(r.gate ?? r.errors));
  });

  test('写细纲的提示词不要 JSON', () => {
    assert.ok(userOf(0).includes('写第 6–7 章的细纲：一章一份') && userOf(0).includes('不写 JSON'), userOf(0).slice(-600));
  });

  test('写细纲的是对话页那个模型，转写的是转写那一档', () => {
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
  });

  // 转写只看原文：给多了它会顺手补内容。
  test('转写只带合同与原文，不带书的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【原文】') && userOf(1).includes('第 6 章的梗概') && userOf(1).includes('原文写的是第 6–7 章'), userOf(1).slice(0, 600));
    assert.ok(!userOf(1).includes('林昭背着灭门旧案进青云宗'), userOf(1).slice(0, 600));
  });

  test('气泡换成规范化 JSON，「无」换成空的', () => {
    const decoded = JSON.parse(r.assistant.content);
    assert.deepEqual(decoded.blueprints.map((b) => b.chapterNumber), [6, 7]);
    assert.equal(decoded.blueprints[0].stateChange, '');
    assert.deepEqual(decoded.blueprints[0].threads, [{ line: '青云旧案', type: '推进', what: '林昭摸到藏书阁。' }]);
  });
});

describe('细纲批次 · 转写改了原文的字', () => {
  let r;

  before(async () => {
    const reworded = json(copied(6, { keyEvents: ['林昭夜探藏书阁，被人发现。'] }), copied(7));
    fake.reset([
      { text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: prose(6), stop: 'end' },
      { text: json(copied(6)), stop: 'end' },
      { text: prose(7), stop: 'end' },
      { text: json(copied(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('重转那一次说清哪几处不是原文里的字', () => {
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「林昭夜探藏书阁，被人发现。」'), userOf(2).slice(0, 600));
  });

  test('全程只重转一次：还改就对半拆，各写各转', () => {
    assert.equal(fake.callCount(), 7);
    assert.ok(userOf(3).includes('写第 6 章的细纲：') && userOf(5).includes('写第 7 章的细纲：'), `${userOf(3).slice(-300)}\n${userOf(5).slice(-300)}`);
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('重转一次') && r.gate.detail.includes('拆成两半重试'), r.gate.detail);
  });
});

describe('细纲批次 · 原文就没写那一章', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: prose(6), stop: 'end' },
      { text: json(copied(6)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('报漏写、不出卡片、不重转', () => {
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('漏写了第 7 章')), r.errors.join('|'));
    assert.equal(fake.callCount(), 2);
  });

  test('写好的原文留在气泡里', () => {
    assert.ok(r.assistant.content.includes('第 6 章的梗概'), r.assistant.content.slice(0, 200));
  });
});

describe('细纲批次 · 不像细纲的输出不转写', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: '我不太确定这一章要写什么。', stop: 'end' },
      { text: '还是不确定。', stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('单章重建一次、还不行就停，一次转写都没花', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(!fake.calls.some((c) => c[0].content.includes(TRANSCRIBER)));
    assert.ok(userOf(1).includes('【上次输出不合格】没有按格式写'), userOf(1).slice(-400));
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('细纲不合格')), r.errors.join('|'));
  });
});

describe('单章细纲 · 写第 N 章细纲也转写', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: prose(8), stop: 'end' },
      { text: json(copied(8)), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(8) } });
  });

  test('写一次、转一次；转写的是转写那一档，合同里给了章号', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(refOf(1), 'p/small');
    assert.ok(userOf(0).includes('写第 8 章的细纲：以「## 第8章：标题」开头'), userOf(0).slice(-800));
    assert.ok(userOf(1).includes('原文写的是第 8 章，只有一项，chapterNumber 是 8'), userOf(1).slice(0, 600));
  });

  test('照抄的落进细纲七节与「设定」一节', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    project.invalidate();
    const plot = await project.getPlot(8);
    assert.equal(plot.sections.关键事件, '- 第 8 章：林昭在山门外踩点。\n- 他翻墙进了后院，落在藏书阁门口。', JSON.stringify(plot.sections));
    assert.equal(plot.sections.出场人物, '林昭、沈青');
    assert.ok(plot.lore.some((l) => l.name === '藏经阁'), JSON.stringify(plot.lore));
  });
});

describe('单章细纲 · 转写两次都不合格', () => {
  let r;

  before(async () => {
    const reworded = json(copied(9, { synopsis: '改写过的梗概' }));
    fake.reset([
      { text: prose(9), stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(9) } });
  });

  test('重转一次，还不行就按小节读原文，说明里写清', async () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(r.gate && r.gate.detail.includes('转写没成，按小节读了原文'), JSON.stringify(r.gate ?? r.errors));
    project.invalidate();
    const plot = await project.getPlot(9);
    assert.ok(plot.sections.关键事件.includes('林昭在山门外踩点'), JSON.stringify(plot.sections));
    assert.equal(plot.sections.出场人物, '林昭、沈青', JSON.stringify(plot.sections));
  });
});

describe('批量拆细纲 · 确认框上钉了模型，转写照样走转写那一档', () => {
  let returned;

  before(async () => {
    fake.reset([
      { text: prose(10), stop: 'end' },
      { text: json(copied(10)), stop: 'end' },
    ]);
    returned = await bundle.batch.generatePlots(project, { range: { from: 10, to: 10 }, call: { model: 'p/big' } });
  });

  test('写细纲用钉的那个，转写用 small', () => {
    assert.equal(returned, 2);
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
    assert.ok(systemOf(1).includes(TRANSCRIBER));
  });

  // 梗概沿用空壳上的那一条（大纲里这一章那一条，是这一批的上游）。
  test('细纲写进去了', async () => {
    project.invalidate();
    const plot = await project.getPlot(10);
    assert.ok(plot.sections.关键事件.includes('第 10 章：林昭在山门外踩点'), JSON.stringify(plot.sections));
  });
});

describe('转写模型调用失败', () => {
  before(() => {
    behavior['p/small'] = 'fail';
  });
  after(() => {
    delete behavior['p/small'];
  });

  test('单章：按小节读原文，说明里写清', async () => {
    fake.reset([{ text: prose(11), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(11) } });
    assert.ok(r.gate && r.gate.detail.includes('转写调用失败') && r.gate.detail.includes('按小节读了原文'), JSON.stringify(r.gate ?? r.errors));
  });

  test('批次：报错、不出卡片，写好的原文留在气泡里', async () => {
    fake.reset([{ text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('转写调用失败')), r.errors.join('|'));
    assert.ok(r.assistant.content.includes('第 7 章的梗概'), r.assistant.content.slice(0, 300));
  });
});
