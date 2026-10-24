/**
 * 规划时的前情分三段（docs/design/plans/2026-10-22-planning-context-bands.md）：续写大纲、拆细纲不再随章数涨。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 续写大纲：最近 10 章整条，再往前一章一行最多 `outlineBriefMax` 章，更早的不逐章列 | 从前更早的一章不落地全列、还强制带，七八百章撑爆窗口 |
 * | 明细说清更早的看全文大纲、全文大纲写到哪、没有全文大纲时照实说 | 第 2 条：不静默截断 |
 * | 全文大纲在大纲、细纲两张配方里是 P1 | 远段靠它接住 |
 * | 一章一行的那一段放不下从最老的丢起，条目标 degraded、写明哪几章没带 | 第 4 级不封顶也不会超长 |
 * | 拆细纲：大纲只带这一批与前面还没拆的空壳，前面拆过的交给前序细纲一览 | 同一份细纲不带两遍 |
 * | 前序细纲一览放不下从最老的丢起，不整份丢 | 同上 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const N = 150;
const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

/** 拆过的细纲（有关键事件）；`stub` 是大纲排到了、还没拆的空壳（只有梗概）。 */
function plotText(no, stub = false) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    `林昭在第${no}章查到第${no}条线索。`,
    ...(stub ? [] : ['', '## 关键事件', '', `- 林昭在第${no}章去井边。`]),
    '',
  ].join('\n');
}

const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, ask: '', range: { from: 151, to: 170 } };
const BATCH = { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(151) }, ask: '', range: { from: 151, to: 155 } };

let bundle;
before(() => {
  bundle = loadBundle({ host: './src/core/host.ts', project: './src/core/model/project.ts', builder: './src/core/context/builder.ts' });
  bundle.host.initHost(makeFakeHost().host);
});

/**
 * 第 1–150 章拆过细纲（第 148 章是还没拆的空壳），第 151–170 章是空壳；`summaryThrough` 给了就写一份全文大纲、
 * 记它写到第几章。
 */
async function setup(summaryThrough) {
  const t = await makeTempProject(bundle.project, { prefix: 'planningBands', title: '分三段' });
  for (let no = 1; no <= 170; no++) {
    t.write(PLOT(no), plotText(no, no === 148 || no > N));
  }
  if (summaryThrough !== undefined) {
    t.write('.novelforge/summaries/global.md', `# 全文大纲\n\n## 主线进展\n\n${'林昭一路追查令牌的来历。'.repeat(20)}\n`);
    const manifest = JSON.parse(t.read('.novelforge/project.json'));
    t.write('.novelforge/project.json', JSON.stringify({ ...manifest, globalSummaryThrough: summaryThrough }, null, 2));
  }
  t.project.invalidate();
  return t;
}

async function withProject(summaryThrough, fn) {
  const t = await setup(summaryThrough);
  try {
    return await fn((request, extra) => bundle.builder.buildContext(t.project, request, config(extra)));
  } finally {
    cleanup(t.dir);
  }
}

const item = (built, id) => built.items.find((i) => i.id === id);

describe('续写大纲：近段整条、中段一章一行、远段交给全文大纲', () => {
  test('第 3 级：第 141–170 章整条（区间里的空壳也在内），第 41–140 章一行，第 1–40 章不逐章列', () =>
    withProject(30, async (build) => {
      const doc = item(await build(OUTLINE), 'outlineDoc');
      assert.equal(doc.status, 'included');
      assert.ok(doc.text.includes('## 第141章：第141章\n林昭在第141章查到第141条线索。'), doc.text.slice(-400));
      assert.ok(doc.text.includes('- 第41章 第41章：林昭在第41章') && !doc.text.includes('第40章'), doc.text.slice(0, 300));
      assert.match(doc.note, /第 41–140 章只带第一行，第 141–170 章带整条/);
      assert.match(
        doc.note,
        /第 1–40 章没逐章列（一章一行最多 100 章，上下文详细度「详细」），更早的看全文大纲；全文大纲只写到第 30 章：第 31–40 章这次没带/
      );
    }));

  test('「精简」一章一行只列 30 章；全文大纲写到了就不另说', () =>
    withProject(200, async (build) => {
      const doc = item(await build(OUTLINE, { contextDetail: 1 }), 'outlineDoc');
      assert.ok(doc.text.includes('- 第111章') && !doc.text.includes('第110章'), doc.text.slice(0, 200));
      assert.match(doc.note, /第 1–110 章没逐章列（一章一行最多 30 章，上下文详细度「精简」），更早的看全文大纲$/);
    }));

  test('没有全文大纲：照实说这几章这次没带', () =>
    withProject(undefined, async (build) => {
      assert.match(item(await build(OUTLINE), 'outlineDoc').note, /还没有全文大纲：第 1–40 章这次没带/);
    }));

  test('全文大纲在大纲配方里是 P1', () =>
    withProject(30, async (build) => {
      const summary = item(await build(OUTLINE), 'globalSummary');
      assert.ok(summary && summary.status === 'included' && summary.priority === 1, JSON.stringify(summary));
    }));

  test('「完整」不封顶也不超长：一行一行放不下从最老的丢起，近段照样整条', () =>
    withProject(30, async (build) => {
      const built = await build(OUTLINE, { contextDetail: 4, contextWindow: 9000 });
      const doc = item(built, 'outlineDoc');
      assert.equal(doc.status, 'degraded');
      assert.ok(doc.text.includes('## 第150章：第150章') && doc.text.includes('- 第140章'), doc.text.slice(-300));
      assert.ok(!doc.text.includes('- 第1章 '), doc.text.slice(0, 200));
      assert.match(doc.note, /预算不足，第 1–\d+ 章没带/);
      assert.ok(built.usedTokens <= built.budget, `${built.usedTokens} > ${built.budget}`);
    }));
});

describe('拆细纲：同一份细纲不带两遍', () => {
  test('大纲只带这一批与前面还没拆的空壳', () =>
    withProject(30, async (build) => {
      const doc = item(await build(BATCH), 'outlineDoc');
      assert.ok(doc.text.includes('## 第148章') && doc.text.includes('## 第151章') && doc.text.includes('## 第155章'), doc.text);
      assert.ok(!doc.text.includes('第147章') && !doc.text.includes('第150章') && !doc.text.includes('第156章'), doc.text);
      assert.match(doc.note, /第 148 章还没拆细纲，带梗概；只带这一次要拆的/);
    }));

  test('前序细纲一览封顶时说清更早的看全文大纲、全文大纲写到哪；全文大纲 P1', () =>
    withProject(30, async (build) => {
      const built = await build(BATCH);
      const list = item(built, 'plotList');
      // 2026-10-24 一览从 100 章降到 30 章；大纲的中段仍是 100（上面续写大纲那几条）。
      assert.equal(list.label, '前序细纲一览（30 章）');
      assert.ok(!list.text.includes('第148章'), '空壳不进一览');
      assert.match(list.note, /只带最近 30 章（上下文详细度「详细」），更早的看全文大纲；全文大纲只写到第 30 章：第 31–\d+ 章这次没带/);
      assert.equal(item(built, 'globalSummary').priority, 1);
    }));

  test('前序细纲一览放不下从最老的丢起，最后几章（带看点的）留着', () =>
    withProject(30, async (build) => {
      const list = item(await build(BATCH, { contextDetail: 4, contextWindow: 9000 }), 'plotList');
      assert.equal(list.status, 'degraded');
      assert.ok(list.text.endsWith('第150章 第150章：林昭在第150章去井边。'), list.text.slice(-200));
      assert.ok(!list.text.includes('第1章 '), list.text.slice(0, 200));
      assert.match(list.note, /预算不足，第 1–\d+ 章没带/);
    }));
});
