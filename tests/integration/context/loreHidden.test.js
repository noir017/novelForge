/**
 * 设定条目的「暗设」在上下文里的去留（完善设定，2026-10-19）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 正文阶段（写、讨论）与续写：整条只带明面，有暗设被去掉的在明细里注一句；没有暗设的不注 | 写正文不需要知道真相，带上了正文模型就容易说漏；第 2 条 |
 * | 规划（细纲 / 大纲 / 世界观）：整条带全部，暗设挪到最后、标题换成「暗设（读者还不知道）」 | 排细纲要知道哪些没揭开，作者写的标题五花八门 |
 * | 正文阶段 @ 引用的设定条目去掉暗设、明细注一句；规划时、别的种类的引用原样带 | 作者 @ 一条设定也不该把真相带进正文 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail: 3,
});

const PLOT = '.novelforge/summaries/002-夜探.md';
const TIANJI = '.novelforge/lore/宗门/天机阁.md';
const SECRET = '阁主就是林昭失踪的父亲。';
const DROPPED = '暗设没带：写正文不带读者还不知道的事，要让这一章揭开就写进本章细纲';

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'loreHidden', title: '暗设测试' });
  t.write(
    TIANJI,
    [
      '---',
      'title: 天机阁',
      'keywords: [天机]',
      'brief: 江湖上最大的情报组织',
      '---',
      '',
      '# 天机阁',
      '',
      '## 概要',
      '',
      '江湖上最大的情报组织。',
      '',
      '## 暗设（未揭示）',
      '',
      SECRET,
      '',
      '## 规则与边界',
      '',
      '只卖消息，不杀人。',
      '',
    ].join('\n')
  );
  t.write('.novelforge/lore/地域/青崖镇.md', '---\ntitle: 青崖镇\nkeywords: []\n---\n\n# 青崖镇\n\n偏僻小镇，镇口设卡。\n');
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write(
    PLOT,
    [
      '---',
      'no: 2',
      'title: 夜探',
      '---',
      '',
      '# 第2章 夜探',
      '',
      '## 梗概',
      '',
      '林昭夜探分舵。',
      '',
      '## 关键事件',
      '',
      '- 林昭摸进分舵。',
      '',
      '## 设定',
      '',
      '- 天机阁〔宗门〕：分舵设在青崖镇',
      '- 青崖镇〔地域〕',
      '',
    ].join('\n')
  );
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(action, target, extra = {}) {
  return bundle.builder.buildContext(t.project, { action, target, ask: '', targetWords: 1200, ...extra }, config());
}

const WRITE = { stage: 'manuscript', capability: 'generate' };
const ON_CHAPTER = { kind: 'manuscript', plotRelPath: PLOT };
const lore = (b, title) => b.items.find((i) => i.kind === 'lore' && i.label === `设定 · ${title}`);
const prompt = (b) => b.messages.map((m) => m.content).join('\n');

describe('正文阶段与续写：暗设不带', () => {
  test('写正文：整条只带明面，明细里注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    const item = lore(b, '天机阁');
    assert.equal(item.status, 'included');
    assert.equal(item.text, '【天机阁〔宗门〕】江湖上最大的情报组织\n## 概要\n\n江湖上最大的情报组织。\n\n## 规则与边界\n\n只卖消息，不杀人。');
    assert.equal(item.note, `本章细纲的设定里有「天机阁」；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET), '真相进了写正文的提示词');
  });

  test('没有暗设的条目不注', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    assert.equal(lore(b, '青崖镇').note, '本章细纲的设定里有「青崖镇」');
  });

  test('讨论正文也不带', async () => {
    const b = await build({ stage: 'manuscript', capability: 'discuss' }, ON_CHAPTER);
    assert.ok(!lore(b, '天机阁').text.includes(SECRET));
    assert.ok(lore(b, '天机阁').note.endsWith(DROPPED));
  });

  test('续写那几轮也不带', async () => {
    const b = await build(WRITE, ON_CHAPTER, {
      step: { kind: 'continuation', tail: '他想起天机阁的规矩。', written: 300, recovery: false },
    });
    assert.ok(!lore(b, '天机阁').text.includes(SECRET));
    assert.ok(!prompt(b).includes(SECRET));
  });
});

describe('规划阶段：整条带全部，暗设标明读者还不知道', () => {
  const MARKED = `## 暗设（读者还不知道）\n\n${SECRET}`;

  test('细纲：暗设挪到最后，标题换成统一的标记', async () => {
    const b = await build({ stage: 'plot', capability: 'generate' }, { kind: 'plot', plotRelPath: PLOT });
    const item = lore(b, '天机阁');
    assert.ok(item.text.endsWith(`只卖消息，不杀人。\n\n${MARKED}`), item.text);
    assert.ok(!item.text.includes('暗设（未揭示）'), item.text);
    assert.ok(!item.note.includes('暗设没带'), item.note);
  });

  test('大纲：作者点名的整条带，含暗设', async () => {
    const b = await build({ stage: 'outline', capability: 'generate' }, { kind: 'outline' }, { ask: '天机阁的分舵' });
    assert.ok(lore(b, '天机阁').text.endsWith(MARKED), lore(b, '天机阁').text);
  });

  test('世界观：作者点名的整条带，含暗设', async () => {
    const b = await build(
      { stage: 'setting', capability: 'generate' },
      { kind: 'setting', doc: 'world' },
      { ask: '把天机阁写进去' }
    );
    assert.ok(lore(b, '天机阁').text.endsWith(MARKED), lore(b, '天机阁').text);
  });
});

describe('@ 引用的设定条目', () => {
  const att = (kind) => ({ id: `${kind}:${TIANJI}`, kind, label: '设定 天机阁', relPath: TIANJI });
  const attached = (b) => b.items.find((i) => i.kind === 'attachment');

  test('正文阶段：去掉暗设，明细注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att('lore')] });
    const item = attached(b);
    assert.equal(item.status, 'included');
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗设'), item.text);
    assert.ok(item.text.includes('只卖消息，不杀人。'), item.text);
    assert.equal(item.note, `设定条目引用；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET));
  });

  test('规划时原样带', async () => {
    const b = await build({ stage: 'plot', capability: 'generate' }, { kind: 'plot', plotRelPath: PLOT }, {
      attachments: [att('lore')],
    });
    assert.ok(attached(b).text.includes(`## 暗设（未揭示）\n\n${SECRET}`), attached(b).text);
    assert.equal(attached(b).note, '设定条目引用');
  });

  test('别的种类（整文件引用）不动', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att('file')] });
    assert.ok(attached(b).text.includes(SECRET));
    assert.equal(attached(b).note, '整文件引用');
  });
});
