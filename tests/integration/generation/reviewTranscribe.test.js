/**
 * 审稿改成转写（2026-10-25）：审稿模型按「总评」「问题」「目标核对」三个小标题写自然语言，引文用「」括出来；转写模型
 * （「转写」那一档，不跟对话页选的模型）照抄成原来那份 JSON，之后照旧拿正文核引文、逐项核对目标（generation/review.ts）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 照抄收下 | 审 1 次、转写 1 次；审的是对话页那个模型，转写的是转写那一档；转写只带合同与审稿原文；气泡是给人读的报告 |
 * | 转写改了引文 | 不收，重转一次，说清哪一处不是原文里的字 |
 * | 转写两次都不合格 | 照原来解析失败的走法：丢弃、按格式重写一次，照样转写；告诉审稿模型的只是「整理不出来」 |
 * | 转写调用失败 | 不重写，报错、不出报告；写好的原文留在气泡里 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let fake;
let t;
let project;
/** 按模型引用注入异常（fakeProvider 的 behavior）：建 provider 时现读。 */
const behavior = {};

const P2 = '.novelforge/summaries/002-客栈.md';
const TRANSCRIBER = '格式转写员';

const CH2 = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  filler(600, 7),
  '“你明天就走？”她问。林昭点了点头，说：“天一亮就走。”',
].join('\n\n');

/** 审稿模型按格式写出来的报告：一条伪造的引文、一项待核实没给证据。 */
const PROSE = [
  '### 总评',
  '整体顺畅，一处硬伤。',
  '### 问题',
  '- 剧情合理性（严重）：残令前文已经交出去了。原文：「她把那块残令收进了袖中」',
  '- 角色状态（建议）：编出来的一句。原文：「林昭拔剑指着她的喉咙」',
  '- 前后章节串联（通过）：接得上',
  '### 目标核对',
  '- g1（已完成）：回到客栈。证据：「林昭推开客栈的门」',
  '- g2（未完成）：细纲要他今晚就走，正文里他说明天走。证据：「天一亮就走」',
  '- g3（待核实）：没写到李叔。证据：无',
].join('\n');

/** 转写模型照抄出来的那一份（`over` 换掉其中几样）。 */
const copied = (over = {}) =>
  JSON.stringify({
    summary: '整体顺畅，一处硬伤。',
    items: [
      { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已经交出去了。' },
      { category: '角色状态', severity: 'warning', quote: '林昭拔剑指着她的喉咙', description: '编出来的一句。' },
      { category: '前后章节串联', severity: 'pass', quote: '', description: '接得上' },
    ],
    goalReviews: [
      { id: 'g1', status: 'completed', description: '回到客栈。', evidence: ['林昭推开客栈的门'] },
      { id: 'g2', status: 'unmet', description: '细纲要他今晚就走，正文里他说明天走。', evidence: ['天一亮就走'] },
      { id: 'g3', status: 'unknown', description: '没写到李叔。', evidence: ['无'] },
    ],
    ...over,
  });

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;

async function review(replies) {
  fake.reset(replies);
  const r = { deltas: [], done: undefined, error: undefined };
  const out = await bundle.generate.generate(
    project,
    { action: { stage: 'manuscript', capability: 'review' }, target: { kind: 'manuscript', plotRelPath: P2 }, ask: '' },
    {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => {
        r.done = full;
      },
      onError: (m) => {
        r.error = m;
      },
      onCancelled: () => {},
    },
    { signal: new AbortController().signal }
  );
  return { ...out, rec: r };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  // 对话页选的是 big；转写那一档（缺省快速档）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  const h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'review-transcribe', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 2,
    title: '客栈',
    targetWords: 800,
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      梗概: '林昭回镇落脚',
      出场人物: '林昭、沈氏',
      关键事件: '林昭回到客栈；林昭当晚离开青崖镇；李叔来客栈找林昭',
      看点: '- 门外有人敲了三下',
    },
  });
  await ws.createChapter(2, '客栈', CH2);
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('审稿 · 按格式写，转写模型照抄成 JSON', () => {
  let r;
  before(async () => {
    r = await review([
      { text: PROSE, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
  });

  test('审 1 次、转写 1 次；审的是对话页那个模型，转写的是转写那一档', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(r.draft.calls, 2);
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
  });

  test('审稿的提示词不要 JSON：按三个小标题写，冻结清单一项一行', () => {
    assert.ok(userOf(0).includes('按「### 总评」「### 问题」「### 目标核对」三个小标题写审稿报告，不写 JSON'), userOf(0).slice(-2500));
    assert.ok(userOf(0).includes('冻结清单：\n- g1：林昭回到客栈\n'), userOf(0).slice(-2500));
  });

  // 转写只看原文：给多了它会顺手补内容。
  test('转写只带合同与审稿原文，不带待审正文与书的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【审稿报告 JSON 合同】') && userOf(1).includes(`【原文】\n${PROSE}`), userOf(1).slice(0, 800));
    assert.ok(!userOf(1).includes('# 待审正文'), userOf(1).slice(0, 800));
  });

  test('照旧拿正文核引文：伪造的那一条丢掉；目标照转写的结论，「无」换成没有证据', () => {
    const report = r.draft.review;
    assert.deepEqual(report.issues.map((i) => [i.category, i.severity, i.quote]), [['剧情合理性', 'error', '她把那块残令收进了袖中']]);
    assert.deepEqual(report.passes.map((p) => p.category), ['前后章节串联']);
    assert.equal(report.dropped.length, 1);
    assert.deepEqual(report.goals.map((g) => [g.id, g.status, g.quotes]), [
      ['g1', 'completed', ['林昭推开客栈的门']],
      ['g2', 'unmet', ['天一亮就走']],
      ['g3', 'unknown', []],
    ]);
    assert.equal(report.coverage, 'complete');
  });

  test('气泡里转写只加一行，最后换成给人读的报告', () => {
    assert.ok(r.rec.deltas.some((d) => d.includes('——审稿转写成 JSON（')), r.rec.deltas.join('').slice(-300));
    assert.match(r.rec.done, /^# 第 2 章《客栈》审稿/);
    assert.doesNotMatch(r.rec.done, /"items"/);
  });
});

describe('审稿 · 转写改了引文', () => {
  test('不收，重转一次，说清哪一处不是原文里的字', async () => {
    const reworded = copied({
      items: [{ category: '剧情合理性', severity: 'error', quote: '她把那块残令藏进了袖中', description: '残令前文已经交出去了。' }],
    });
    const r = await review([
      { text: PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
    assert.equal(fake.callCount(), 3);
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次转写不合格】这几处不是原文里的字：「她把那块残令藏进了袖中」'), userOf(2).slice(0, 800));
    assert.equal(r.draft.calls, 3);
    assert.match(r.draft.notes.join('\n'), /审稿转写不合格（这几处不是原文里的字：「她把那块残令藏进了袖中」），重转一次/);
    assert.deepEqual(r.draft.review.issues.map((i) => i.quote), ['她把那块残令收进了袖中']);
  });
});

describe('审稿 · 转写两次都不合格', () => {
  test('丢弃、按格式重写一次（审稿模型），照样转写；重写那一次只说整理不出来', async () => {
    const bad = copied({ summary: '整体还算顺畅' });
    const r = await review([
      { text: PROSE, stop: 'end' },
      { text: bad, stop: 'end' },
      { text: bad, stop: 'end' },
      { text: PROSE, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
    assert.equal(fake.callCount(), 5);
    assert.deepEqual([0, 1, 2, 3, 4].map(refOf), ['p/big', 'p/small', 'p/small', 'p/big', 'p/small']);
    assert.ok(userOf(3).includes('上一轮审稿输出未通过格式校验（整理不出一份报告），已被丢弃'), userOf(3).slice(0, 400));
    assert.doesNotMatch(userOf(3), /不是原文里的字/);
    assert.equal(r.draft.calls, 5);
    assert.match(r.draft.notes.join('\n'), /审稿转写没成（这几处不是原文里的字：「整体还算顺畅」），已丢弃并重写一次/);
    assert.ok(r.draft.review);
  });
});

describe('审稿 · 转写调用失败', () => {
  before(() => {
    behavior['p/small'] = 'fail';
  });
  after(() => {
    delete behavior['p/small'];
  });

  test('不重写：报错、不出报告，写好的原文留在气泡里', async () => {
    const r = await review([{ text: PROSE, stop: 'end' }]);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /审稿写好了，但转写调用失败/);
    assert.ok(r.rec.done.includes('她把那块残令收进了袖中'), r.rec.done.slice(0, 300));
    assert.ok(!fake.calls.slice(1).some((c) => c.ref === 'p/big'), '没有重写');
  });
});
