/**
 * 上下文详细度（model/contextDetail.ts）在装配器里的落点：同一个工程、同一章，四级各装一次。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 近章全文 0 / 1 / 2 / 3 章 | 级别越高带得越多，这是开关的全部意思 |
 * | 「精简」只带最近 5 章细纲，更早的合成**一条** dropped，说明写级别 | 第 2 条：不静默截断；也不拿九十几行「不带」淹掉明细 |
 * | 没写级别（老配置、手写的测试配置）= 「详细」 | 缺省第 3 级，与从前一样 |
 * | 「精简」不带定稿原文片段，出一条说明 | 第 2 条 |
 * | 「精简」上一章结尾不超过 1000 字、角色卡只带要点、叙事线 3 条 | 每一项都按级别 |
 * | 历史封顶随级别；落定细纲仍是 60% | settle 要沉淀的就是那段讨论 |
 * | 细纲阶段前后几章、前序细纲一览按级别 | 同上 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const N = 12;

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

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

/** 一章约 2000 字，十来段：上一章结尾要真被截。 */
function chapterText(no) {
  const para = (k) => `第${no}章第${k}段，${'雨还在下，'.repeat(36)}林昭往井边走。`;
  return [
    `# 第${no}章`,
    '',
    `林昭在第${no}章把第${no}块令牌塞进怀里。`,
    '',
    ...Array.from({ length: 10 }, (_, k) => [para(k + 1), '']).flat(),
  ].join('\n');
}

/** 一份还没定稿的细纲（计划）。 */
function plotText(no) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 出场人物',
    '',
    '林昭',
    '',
    '## 关键事件',
    '',
    `林昭在第${no}章去井边。`,
    '',
    '## 看点',
    '',
    '- 井底有人。',
    '',
  ].join('\n');
}

/** 五条都与第 13 章有关（区间盖住第 13 章），「精简」只带得下 3 条。一条线一个文件。 */
const THREADS = ['玉佩', '名册', '大火', '师父', '来信'].map((name) => [
  `.novelforge/threads/${name}之谜.md`,
  `---\nkind: 支线\nplan: 10-20\n---\n\n# ${name}之谜\n\n## 意图\n${name}的来历。\n`,
]);

let bundle;
before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    detail: './src/core/model/contextDetail.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
});

/** 第 1..12 章正文都写了、细纲都定稿了（sourceHash 对得上）；第 13 章的细纲还是计划。 */
async function setupManuscript() {
  const t = await makeTempProject(bundle.project, { prefix: 'contextDetail', title: '详细度测试' });
  for (let no = 1; no <= N; no++) {
    t.write(CH(no), chapterText(no));
  }
  t.write(PLOT(N + 1), plotText(N + 1));
  t.write(
    '.novelforge/characters/林昭.md',
    '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿\n\n## 外貌\n\n左眉有一道疤\n\n## 当前状态\n\n在查案\n'
  );
  for (const [rel, text] of THREADS) {
    t.write(rel, text);
  }
  t.project.invalidate();
  const chapters = await t.project.listChapters();
  for (let no = 1; no <= N; no++) {
    const ch = chapters.find((c) => c.order === no);
    t.write(
      `.novelforge/summaries/${pad3(no)}-第${no}章.md`,
      `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${ch.contentHash}\ncast: [林昭]\n---\n\n# 第${no}章 第${no}章\n\n## 梗概\n\n第${no}章的事。\n\n## 出场人物\n\n林昭\n\n## 连续性事实\n\n- 林昭收起第${no}块令牌 〔证据：「林昭在第${no}章把第${no}块令牌塞进怀里。」〕\n`
    );
  }
  t.project.invalidate();
  return t;
}

function write13(t, extra = {}, request = {}) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(N + 1) }, ask: '', targetWords: 1200, ...request },
    config(extra)
  );
}

const live = (b, kind) => b.items.filter((i) => i.kind === kind && (i.status === 'included' || i.status === 'degraded'));

describe('上下文详细度 · 写第 13 章（前 12 章都定稿了）', () => {
  let t;
  const built = {};

  before(async () => {
    t = await setupManuscript();
    for (const d of [1, 2, 3, 4]) {
      built[d] = await write13(t, { contextDetail: d });
    }
    built.none = await write13(t);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('装配结果记着按哪一级装的；没写级别 = 3', () => {
    assert.deepEqual([1, 2, 3, 4].map((d) => built[d].detail), [1, 2, 3, 4]);
    assert.equal(built.none.detail, 3);
  });

  test('近章全文 0 / 1 / 2 / 3 章', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((d) => live(built[d], 'manuscriptFull').length),
      [0, 1, 2, 3]
    );
  });

  test('级别越高用量越大', () => {
    const used = [1, 2, 3, 4].map((d) => built[d].usedTokens);
    assert.ok(used[0] < used[1] && used[1] < used[2] && used[2] < used[3], used.join(' < '));
  });

  // 写正文只带前几章细纲（`plotPrev`，上文），条数随级别 1 / 2 / 3 / 5；更早的不带，也不一章一条说「不带」（2026-10-21）。
  test('前几章细纲 1 / 2 / 3 / 5 章，都是紧挨着的那几章', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((d) => live(built[d], 'plotSummary').map((i) => i.label.match(/第 (\d+) 章/)[1]).join(',')),
      ['12', '11,12', '10,11,12', '8,9,10,11,12']
    );
    assert.ok(!built[4].items.some((i) => i.kind === 'plotSummary' && i.status === 'dropped'), '更早的不一章一条');
  });

  test('「精简」不带定稿原文片段，出一条说明', () => {
    const ev = built[1].items.filter((i) => i.kind === 'evidence');
    assert.deepEqual(ev.map((i) => [i.id, i.status]), [['evidence:off', 'dropped']]);
    assert.match(ev[0].note, /上下文详细度「精简」不带原文片段/);
    assert.ok(live(built[3], 'evidence').length > 0, '缺省那一级照样带');
  });

  test('「精简」上一章结尾不超过 1000 字', () => {
    const tail = (b) => b.items.find((i) => i.kind === 'prevTail');
    const short = tail(built[1]).text.replace('……（前略）\n\n', '');
    assert.ok(short.length <= 1000, String(short.length));
    // 「标准」起带了上一章全文，结尾片段被整章取代（去重），不再单独带。
    assert.equal(tail(built[2]).status, 'dropped');
  });

  test('「精简」角色卡只带要点，说明写级别', () => {
    const card = built[1].items.find((i) => i.id === 'character:林昭');
    assert.equal(card.status, 'degraded');
    assert.ok(!card.text.includes('左眉有一道疤'), card.text);
    assert.ok(card.text.includes('在查案'), card.text);
    // 写正文时暗设不带（叙事线重做第 10 个提交），要点只剩身份 / 当前状态。
    assert.match(card.note, /上下文详细度「精简」只带身份\/当前状态$/);
    const full = built[3].items.find((i) => i.id === 'character:林昭');
    assert.equal(full.status, 'included');
    assert.ok(full.text.includes('左眉有一道疤'));
  });

  test('叙事线：「精简」3 条，「详细」5 条全带', () => {
    assert.equal(live(built[1], 'thread').length, 3);
    const dropped = built[1].items.filter((i) => i.kind === 'thread' && i.status === 'dropped');
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((i) => i.note === '叙事线一次只带 3 条，排在后面的没带'), dropped.map((i) => i.note).join('|'));
    assert.equal(live(built[3], 'thread').length, 5);
  });

  test('续写那几轮的近章事实：「精简」最多 6 章', async () => {
    const step = { kind: 'continuation', tail: '林昭往井边走。', written: 800, remaining: 400, recovery: false };
    const cont = await write13(t, { contextDetail: 1 }, { step });
    assert.equal(live(cont, 'facts').length, 6);
    const contDefault = await write13(t, {}, { step });
    assert.equal(live(contDefault, 'facts').length, 12);
  });

  test('测试的单项覆盖叠在级别那一行上', async () => {
    const b = await write13(t, { contextDetail: 4, contextOverrides: { fullTextChapters: 0 } });
    assert.equal(live(b, 'manuscriptFull').length, 0);
    assert.ok(live(b, 'evidence').length > 0, '其余照「完整」');
  });
});

describe('上下文详细度 · 历史封顶', () => {
  let t;
  const many = [];
  before(async () => {
    t = await setupManuscript();
    for (let i = 1; i <= 40; i++) {
      many.push({ id: `m${i}`, role: i % 2 === 1 ? 'user' : 'assistant', content: `第 ${i} 轮的内容。`.repeat(60), at: '2026-08-01T10:00:00Z' });
    }
  });
  after(() => cleanup(t.dir, bundle.db));

  const historyTokens = (b) => live(b, 'history').reduce((s, i) => s + i.tokens, 0);

  test('「精简」历史不超过预算 15%，「完整」可以到 40%', async () => {
    const small = await write13(t, { contextDetail: 1, contextWindow: 40000 }, { history: many });
    assert.ok(historyTokens(small) <= Math.floor(small.budget * 0.15) + 5, `${historyTokens(small)} / ${small.budget}`);
    const big = await write13(t, { contextDetail: 4, contextWindow: 40000 }, { history: many });
    assert.ok(historyTokens(big) > Math.floor(big.budget * 0.3), `${historyTokens(big)} / ${big.budget}`);
    assert.ok(historyTokens(big) <= Math.floor(big.budget * 0.4) + 5, `${historyTokens(big)} / ${big.budget}`);
  });

  test('落定细纲不随级别：「精简」也照样能用到 15% 以上', async () => {
    const settle = await bundle.builder.buildContext(
      t.project,
      { action: { stage: 'plot', capability: 'settle' }, target: { kind: 'plot', plotRelPath: PLOT(N + 1) }, ask: '', history: many },
      config({ contextDetail: 1, contextWindow: 40000 })
    );
    assert.ok(historyTokens(settle) > Math.floor(settle.budget * 0.15), `${historyTokens(settle)} / ${settle.budget}`);
  });
});

describe('上下文详细度 · 细纲阶段（第 36 章，前面 35 章、后面 2 章都排了细纲）', () => {
  let t;
  const built = {};
  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'contextDetailPlot', title: '细纲测试' });
    for (let no = 1; no <= 38; no++) {
      t.write(PLOT(no), plotText(no));
    }
    t.project.invalidate();
    for (const d of [1, 3, 4]) {
      built[d] = await bundle.builder.buildContext(
        t.project,
        { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(36) }, ask: '' },
        config({ contextDetail: d })
      );
    }
  });
  after(() => cleanup(t.dir, bundle.db));

  /** 细纲条目的章号（`plot:<路径>`），本章自己除外。 */
  const neighbours = (b) =>
    b.items
      .filter((i) => i.kind === 'plot' && i.status === 'included')
      .map((i) => Number(/summaries\/(\d+)/.exec(i.id)?.[1]))
      .filter((no) => no !== 36);

  test('前后几章细纲：「精简」1 / 1，「详细」3 / 1，「完整」5 / 2', () => {
    const count = (b) => {
      const nos = neighbours(b);
      return [nos.filter((n) => n < 36).length, nos.filter((n) => n > 36).length];
    };
    assert.deepEqual(count(built[1]), [1, 1]);
    assert.deepEqual(count(built[3]), [3, 1]);
    assert.deepEqual(count(built[4]), [5, 2]);
  });

  // 2026-10-24 一览单独一组数（10 / 20 / 30 / 不限），不再与大纲的中段共用 30 / 50 / 100 / 不限。
  test('前序细纲一览：「精简」只带最近 10 章、「详细」30 章并说明；「完整」不限', () => {
    const list = (b) => b.items.find((i) => i.id === 'plotList');
    assert.match(list(built[1]).label, /（10 章）/);
    assert.match(list(built[1]).note, /只带最近 10 章（上下文详细度「精简」）/);
    assert.match(list(built[3]).label, /（30 章）/);
    assert.match(list(built[3]).note, /只带最近 30 章（上下文详细度「详细」）/);
    assert.match(list(built[4]).label, /（30 章）/);
    assert.equal(list(built[4]).note, undefined);
  });
});
