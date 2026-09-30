/**
 * 审稿链与修稿链（五期，generation/review.ts、generation/revision.ts，经 `generate` 跑）。
 *
 * | 情形 | 断言 |
 * |---|---|
 * | 审稿一次成功 | 1 次调用；Draft 带报告、**没有 artifact**；气泡是给人读的报告，不是 JSON |
 * | 伪造的引文 | 那一条被丢掉，notes 写明 |
 * | 审稿被截断 | 整份重来一次，重来那次说明上一次被丢弃 |
 * | 审稿不合格 | 按合同重建一次；两次都不行报错、不出报告 |
 * | 还没有正文 | 不调模型，报错 |
 * | 审稿不走续写链 | 审稿 JSON 不会被当成正文续写、查重演 |
 * | 修稿一次成功 | 发出去的有整章原文与清单；Draft 是正文产物、写法 revise |
 * | 修稿被截断 | 接着写，拼成一份 |
 * | 截断三轮仍没写完 | 报错，不出 Draft |
 * | 明显短于原稿 | 报错，不出 Draft |
 * | 修稿落盘 | 覆盖前审阅，不记 writtenFrom |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let gen;
let h;
let fake;
let t;
let project;
let settings = {};
let script = [];

const P2 = '.novelforge/plots/002-客栈.md';
const P3 = '.novelforge/plots/003-夜访.md';

const CH2 = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  filler(600, 7),
  '“你明天就走？”她问。林昭点了点头，说：“天一亮就走。”',
].join('\n\n');

function recorder() {
  const r = { deltas: [], done: undefined, error: undefined };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
    },
  };
}

async function run(capability, plotRelPath, replies, extra = {}) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await gen.generate(
    project,
    { action: { stage: 'manuscript', capability }, target: { kind: 'manuscript', plotRelPath }, ask: '', ...extra },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, users: fake.calls.map((c) => c[c.length - 1].content) };
}

const review = (replies, extra) => run('review', P2, replies, extra);
const revise = (replies, brief = '【已确认纳入本次修稿的审稿项】\n1. [角色状态 / 严重] 残令前文已经交出去了') =>
  run('generate', P2, replies, { writeMode: 'revise', reviseBrief: brief });

function reviewJson({ items, goals } = {}) {
  return JSON.stringify({
    summary: '整体顺畅，一处硬伤',
    items: items ?? [
      { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已经交出去了' },
      { category: '角色状态', severity: 'warning', quote: '林昭拔剑指着她的喉咙', description: '编出来的一句' },
      { category: '前后章节串联', severity: 'pass', description: '接得上' },
    ],
    goalReviews: goals ?? [
      { id: 'g1', status: 'completed', description: '回到客栈', evidence: [{ quote: '林昭推开客栈的门' }] },
      { id: 'g2', status: 'unmet', description: '细纲要他今晚就走，正文里他说明天走', evidence: [{ quote: '天一亮就走' }] },
      { id: 'g3', status: 'unknown', description: '没写到敲门', evidence: [] },
    ],
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    accept: './src/core/generation/accept.ts',
    revision: './src/core/generation/revision.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  gen = bundle.generate;
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'review-chain', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  await ws.writePlot({
    no: 2, title: '客栈', role: '', characters: [], targetWords: 800, upstreamHash: '', done: false,
    sections: { ...empty, 本章目的: '落脚', 关键事件: '林昭回到客栈；林昭当晚离开青崖镇', 章末钩子: '门外有人敲了三下' },
  });
  await ws.writePlot({
    no: 3, title: '夜访', role: '', characters: [], targetWords: 800, upstreamHash: '', done: false,
    sections: { ...empty, 本章目的: 'x', 关键事件: '夜访', 章末钩子: 'y' },
  });
  await ws.createChapter(2, '客栈', CH2);
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('审稿 · 一次成功', () => {
  let r;
  before(async () => {
    r = await review([{ text: reviewJson(), stop: 'end' }]);
  });

  test('调一次；Draft 带报告、没有 artifact', () => {
    assert.equal(r.calls, 1);
    assert.equal(r.draft.calls, 1);
    assert.equal(r.draft.artifact, undefined);
    assert.equal(r.draft.review.chapterNo, 2);
    assert.equal(r.draft.review.chapterRelPath, 'chapters/002-客栈.md');
  });

  test('伪造的引文那一条被丢掉，notes 写明', () => {
    assert.deepEqual(r.draft.review.issues.map((i) => i.category), ['剧情合理性']);
    assert.equal(r.draft.review.dropped.length, 1);
    assert.match(r.draft.notes.join('\n'), /丢掉 1 条引文站不住的意见/);
  });

  test('目标：两条关键事件 + 章末钩子；未完成有证据留着，待核实照收', () => {
    assert.deepEqual(r.draft.review.goals.map((g) => [g.kind, g.status]), [
      ['event', 'completed'],
      ['event', 'unmet'],
      ['hook', 'unknown'],
    ]);
    assert.equal(r.draft.review.coverage, 'complete');
  });

  test('气泡是给人读的报告，不是 JSON', () => {
    assert.match(r.rec.done, /^# 第 2 章《客栈》审稿/);
    assert.doesNotMatch(r.rec.done, /"items"/);
    assert.equal(r.draft.raw, r.rec.done);
  });

  test('发出去的那一次是审稿：全文与冻结清单都在', () => {
    assert.match(r.users[0], /# 待审正文/);
    assert.match(r.users[0], /冻结清单：\[\{"id":"g1","text":"林昭回到客栈"\}/);
  });
});

describe('审稿 · 出岔子', () => {
  test('被截断：整份重来一次，重来那次说清上一次被丢弃', async () => {
    const r = await review([{ text: '{"summary":"写了一半', stop: 'maxTokens' }, { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.equal(r.draft.calls, 2);
    assert.match(r.users[1], /因长度限制而中断，已被丢弃/);
    assert.match(r.draft.notes.join(), /整份重来一次/);
  });

  test('不合格：按合同重建一次', async () => {
    const r = await review(['这一章写得挺好，没有问题。', { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.match(r.users[1], /未通过合同校验（输出里没有 JSON 对象）/);
    assert.ok(r.draft.review);
  });

  test('截断又不合格：3 次到顶', async () => {
    const r = await review([{ text: '{', stop: 'maxTokens' }, '不是 JSON', { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 3);
    assert.ok(r.draft.review);
  });

  test('两次都不合格：报错，不出报告', async () => {
    const r = await review(['不是 JSON', '还不是']);
    assert.equal(r.calls, 2);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /两次都没有产出合格的审稿报告/);
  });

  test('这一章还没有正文：不调模型，报错', async () => {
    const r = await run('review', P3, ['不该被调用']);
    assert.equal(r.calls, 0);
    assert.match(r.rec.error, /还没有正文，没法审稿/);
  });

  // 审稿也在正文层：按旧判据它会被当成正文去续写（输出很短、又没到八成）。
  test('审稿不走续写链：短短一段 JSON 不会被续写', async () => {
    const r = await review([{ text: reviewJson({ items: [{ category: 'x', severity: 'pass', description: 'ok' }], goals: [] }), stop: 'end' }]);
    assert.equal(r.calls, 1);
    assert.equal(r.draft.length, undefined);
  });
});

describe('修稿', () => {
  const REVISED = CH2.replace('她把那块残令收进了袖中。', '她看了一眼他空着的手，什么也没问。');

  test('一次成功：整章原文与清单都发出去了；Draft 是正文、写法 revise', async () => {
    const r = await revise([{ text: REVISED, stop: 'end' }]);
    assert.equal(r.calls, 1);
    assert.ok(r.users[0].includes('她把那块残令收进了袖中。'), '原文在');
    assert.match(r.users[0], /【已确认纳入本次修稿的审稿项】/);
    assert.match(r.users[0], /【修复原则】/);
    assert.equal(r.draft.writeMode, 'revise');
    assert.equal(r.draft.artifact.kind, 'manuscript');
    assert.equal(r.draft.raw.trim(), REVISED.trim());
    assert.equal(r.draft.length, undefined);
    assert.match(r.draft.notes.join(), /修订稿 \d+ 字（原稿 \d+ 字）/);
  });

  test('被截断：接着写，拼成一份；续写那一次带已修订的末尾', async () => {
    const half = REVISED.slice(0, Math.floor(REVISED.length / 2));
    const rest = REVISED.slice(half.length);
    const r = await revise([{ text: half, stop: 'maxTokens' }, { text: rest, stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.match(r.users[1], /# 已修订正文（末尾，从这里接着输出）/);
    assert.match(r.users[1], /上一轮修稿输出因长度限制而中断/);
    assert.equal(r.draft.calls, 2);
    assert.ok(r.draft.raw.replace(/\s+/g, '').length >= REVISED.replace(/\s+/g, '').length - 2);
  });

  test('截断三轮仍没写完：报错，不出 Draft', async () => {
    const r = await revise([
      { text: filler(300, 21), stop: 'maxTokens' },
      { text: filler(300, 22), stop: 'maxTokens' },
      { text: filler(300, 23), stop: 'maxTokens' },
      { text: filler(300, 24), stop: 'maxTokens' },
    ]);
    assert.equal(r.calls, 4);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /续写 3 轮仍没写完/);
  });

  test('明显短于原稿：报错，不出 Draft', async () => {
    const r = await revise([{ text: '她看了一眼他空着的手，什么也没问。', stop: 'end' }]);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /修订稿明显短于原稿/);
  });

  test('这一章没有正文：不调模型，报错', async () => {
    script = ['不该被调用'];
    fake.calls.length = 0;
    const rec = recorder();
    await gen.generate(
      project,
      { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', writeMode: 'revise', reviseBrief: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    assert.equal(fake.calls.length, 0);
    assert.match(rec.r.error, /已经没有正文了，没法修稿/);
  });

  test('落盘：覆盖前审阅，不记 writtenFrom', async () => {
    const r = await revise([{ text: REVISED, stop: 'end' }]);
    const before = (await project.getPlot(2)).writtenFrom;
    h.reviewed.length = 0;
    h.setReviewVerdict('apply');
    const res = await bundle.accept.acceptArtifact(project, r.draft.target, r.draft.artifact, { writeMode: 'revise' });
    assert.equal(res.relPath, 'chapters/002-客栈.md');
    assert.equal(h.reviewed.length, 1);
    const text = await project.readChapterText(await project.getChapter(2));
    assert.ok(text.includes('她看了一眼他空着的手'));
    assert.equal((await project.getPlot(2)).writtenFrom, before);
  });
});

describe('修稿 · 完整性校验（纯函数）', () => {
  test('下限 = min(原稿, max(200, 0.6 × min(原稿, 每章字数)))', () => {
    const { revisionShortfall, countProseUnits } = bundle.revision;
    const src = filler(1000, 30);
    assert.equal(countProseUnits(src), 1000);
    assert.equal(revisionShortfall(src, filler(600, 31), 3000), undefined);
    assert.match(revisionShortfall(src, filler(599, 32), 3000), /599 \/ 1000 字，至少要 600 字/);
    // 每章字数更小时按它封顶：0.6 × 500 = 300。
    assert.equal(revisionShortfall(src, filler(300, 33), 500), undefined);
    // 下限不低于 200，除非原稿本身更短。
    assert.match(revisionShortfall(src, filler(199, 34), 100), /至少要 200 字/);
    assert.equal(revisionShortfall(filler(150, 35), filler(150, 36), 3000), undefined);
  });

  test('英文按词、标点空白不算', () => {
    assert.equal(bundle.revision.countProseUnits('他说：“Hello world!”  好。'), 5);
  });
});
