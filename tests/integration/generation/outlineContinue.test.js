/**
 * `/续写大纲`（2026-10-24）：停在一章上也能往后排大纲。从前回全书那一层只有目标下拉框最上面那一项，
 * 主按钮又只在「下一章超出大纲」时才推续写，作者找不到入口。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 跨层 | 在第 3 章的细纲上 `/续写大纲`：前端不带区间，后端按大纲排到哪现算（第 4–23 章）；这一轮临时换到情节大纲，跑完回到第 3 章 |
 * | 重来 | 会话已经回到原来那一章，重来一轮照样换过去再回来，区间照旧 |
 * | 大纲那一层 | 续写就是这一层自己的生成；区间收在总章数；会话留在大纲那一层 |
 * | 拦下 | 排到最后一章：不调模型、不记一轮，说总章数；要续的那一段里已经有正文：不调模型，指去从已写正文补齐 |
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

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const PLOT3 = { kind: 'plot', plotRelPath: PLOT(3) };
const OUTLINE = { kind: 'outline' };
/** `/续写大纲` 发出来的样子：带着情节大纲的阶段与目标，不带区间。 */
const CONTINUE = { stage: 'outline', capability: 'generate', target: OUTLINE };

function plotText(no) {
  return ['---', `no: ${no}`, `title: 第${no}章`, '---', '', `# 第${no}章 第${no}章`, '', '## 梗概', '', `第${no}章的梗概。`, ''].join('\n');
}

/** 模型续出来的那一段：一章一条。 */
const outlineOf = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `## 第${from + i}章：续${from + i}\n\n林昭往下查，第${from + i}章。`).join('\n\n');

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

async function continueOutline(answer, text = '') {
  posted.length = 0;
  gates = [];
  h.expect();
  fake.reset(answer === undefined ? [] : [{ text: answer, stop: 'end' }]);
  await controller.handle({ type: 'send', payload: payload({ text, ...CONTINUE }) });
  project.invalidate();
}

const toasts = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);
const prompt = (i = 0) => fake.calls[i].map((m) => m.content).join('\n');
const lastUser = () => controller.current.turns.filter((x) => x.role === 'user').at(-1);

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
  t = await makeTempProject(bundle.project, { prefix: 'outlineContinue', title: '天机录' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ngenre: 武侠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
  t.write(CH(1), '# 第1章\n\n第1章的正文。\n');
  t.write(CH(2), '# 第2章\n\n第2章的正文。\n');
  for (const no of [1, 2, 3]) {
    t.write(PLOT(no), plotText(no));
  }
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
  await controller.handle({ type: 'setTarget', target: PLOT3 });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('跨层：在第 3 章的细纲上 /续写大纲', () => {
  before(async () => {
    await continueOutline(outlineOf(4, 23), '让主角在第 10 章前进宗门');
  });

  test('一次调用；区间由后端按大纲排到哪现算：第 4–23 章', () => {
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必须写第 4–23 章的情节大纲'), prompt().slice(-2000));
    assert.ok(prompt().includes('让主角在第 10 章前进宗门'));
  });

  test('命令记成「续写大纲」，区间记在这一轮上（重来照用）', () => {
    const turn = lastUser();
    assert.equal(turn.command, '续写大纲');
    assert.equal(turn.continueOutline, true);
    assert.deepEqual(turn.range, { from: 4, to: 23 });
  });

  test('卡片落在那一段，写进各章细纲的梗概', async () => {
    assert.ok(gates[0]?.title.includes('情节大纲 · 第 4–23 章'), gates[0]?.title);
    const outline = await project.readOutline();
    assert.equal((outline.match(/^## 第\d+章/gm) ?? []).length, 23, outline.slice(0, 300));
    assert.ok(outline.includes('林昭往下查，第23章。'));
  });

  test('跑完回到第 3 章的细纲', () => {
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
    assert.equal(controller.current.capability, 'discuss');
    assert.deepEqual(posted.filter((m) => m.type === 'session').at(-1).session.target, PLOT3);
  });
});

describe('重来', () => {
  test('会话已经回到第 3 章：照样换到情节大纲、区间照旧，跑完再回来', async () => {
    const turn = lastUser();
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: outlineOf(4, 23), stop: 'end' }]);
    await controller.handle({ type: 'retry', turnId: turn.id, payload: payload({ stage: 'plot', capability: 'discuss', target: PLOT3 }) });
    project.invalidate();
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必须写第 4–23 章的情节大纲'), prompt().slice(-2000));
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
  });
});

describe('大纲那一层', () => {
  before(async () => {
    await controller.handle({ type: 'setTarget', target: OUTLINE });
    await continueOutline(outlineOf(24, 30));
  });

  test('续写就是这一层自己的生成：区间收在总章数（第 24–30 章）', () => {
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必须写第 24–30 章的情节大纲'), prompt().slice(-2000));
    assert.deepEqual(lastUser().range, { from: 24, to: 30 });
  });

  test('会话留在大纲那一层', () => {
    assert.deepEqual(controller.current.target, OUTLINE);
    assert.equal(controller.current.stage, 'outline');
  });
});

describe('拦下', () => {
  test('排到最后一章了：不调模型、不记一轮，说总章数', async () => {
    const before0 = controller.current.turns.length;
    await continueOutline();
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('已经排到第 30 章，全书共 30 章')), toasts().join('|'));
  });

  test('要续的那一段里已经有正文：不调模型，指去从已写正文补齐', async () => {
    t.write('.novelforge/config.md', '---\ngenre: 武侠\ntotalChapters: 60\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
    t.write(CH(31), '# 第31章\n\n先写了的第31章。\n');
    project.invalidate();
    const before0 = controller.current.turns.length;
    await continueOutline();
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('情节大纲只排到第 30 章，可第 31 章里已经有正文') && m.includes('从已写正文补齐')), toasts().join('|'));
  });
});
