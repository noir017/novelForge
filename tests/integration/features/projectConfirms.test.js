/**
 * 工程页上从前调模型不先问的三处，现在都先弹确认框（2026-10-23 作者要的）：报次数、为这一次挑模型。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 重建全文大纲：章章都定稿过也先问，报批数与次数；取消零调用、全文大纲不动 | 第 4 条：不偷偷烧 token。从前只有有没定稿的章时才问（⚑9） |
 * | 提取文风：第一次（style.md 还是模板）也先问，按钮是「开始提取」；已有内容时是「覆盖」 | 从前只有覆盖时才问 |
 * | 提取角色卡：挑完章先问；取消零调用 | 从前挑完章就调 |
 * | 换了模型，这一次只用它 | 确认框的规矩（docs/design/plans/2026-10-20-call-choice.md） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const N = 4;
const CH = (no) => `chapters/00${no}-第${no}章.md`;
const GLOBAL = '.novelforge/summaries/global.md';
const STYLE = '.novelforge/style.md';

/** 文风那一次要提示词规定的小节齐全才算完整（照着系统提示词里的 `## ` 回）；别的一律给一段话。 */
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('文风')) {
    const heads = system.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('## '));
    return heads.map((head) => `${head}\n\n${head.slice(3)}的说明。`).join('\n\n');
  }
  if (system.includes('角色')) {
    return JSON.stringify([{ name: '林昭', 身份: '孤儿' }]);
  }
  return '林昭从青崖镇一路查到天机阁。';
}

const refsUsed = () => [...new Set(fake.calls.map((m) => m.ref))];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    summarize: './src/core/features/summarize.ts',
    style: './src/core/features/style.ts',
    characters: './src/core/features/characters.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: makeSettings({
      contextWindow: 16000,
      maxOutputTokens: 1000,
      summaryBatchSize: 3,
      providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }, { name: 'strong' }] }],
    }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'project-confirms', title: '确认框测试' });
  project = t.project;
  for (let no = 1; no <= N; no++) {
    t.write(CH(no), `# 第${no}章\n\n林昭在第${no}章走进青崖镇，沈氏在柜台后看着他。\n`);
  }
  project.invalidate();
  // 四章都定稿过：细纲记下的 sourceHash 对得上正文。
  for (const ch of await project.listChapters()) {
    t.write(
      `.novelforge/summaries/00${ch.order}-第${ch.order}章.md`,
      `---\nno: ${ch.order}\ntitle: 第${ch.order}章\nsourceHash: ${ch.contentHash}\ncast: [林昭]\n---\n\n# 第${ch.order}章 第${ch.order}章\n\n## 梗概\n\n第${ch.order}章的事。\n`
    );
  }
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('重建全文大纲：章章都定稿过也先问', () => {
  let global;

  test('取消：不调模型，全文大纲一个字不动', async () => {
    global = t.has(GLOBAL) ? t.read(GLOBAL) : undefined;
    h.expect();
    fake.reset();
    await bundle.summarize.rebuildGlobalSummary(project);
    assert.equal(fake.callCount(), 0);
    assert.equal(t.has(GLOBAL) ? t.read(GLOBAL) : undefined, global);
  });

  test('确认框报批数与次数：4 章分 2 批、再合并一次，共 3 次；不带详细度下拉框', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['重建']);
    assert.ok(c.message.includes('4 章定稿过的细纲分 2 批归纳，再合并成一份') && c.message.includes('预计 3 次调用'), c.message);
    assert.equal(c.call.contextDetail, undefined, JSON.stringify(c.call));
  });

  test('换一个模型点「重建」：3 次都用它，写出全文大纲', async () => {
    h.expect({ action: '重建', choice: { model: 'fake/strong' } });
    fake.reset();
    await bundle.summarize.rebuildGlobalSummary(project);
    assert.equal(fake.callCount(), 3);
    assert.deepEqual(refsUsed(), ['fake/strong']);
    assert.notEqual(t.read(GLOBAL), global);
  });
});

describe('提取文风：第一次也先问', () => {
  test('挑完样章、在确认框上取消：不调模型，style.md 不写', async () => {
    const before = t.has(STYLE) ? t.read(STYLE) : undefined;
    h.expect('1,2');
    fake.reset();
    await bundle.style.extractStyle(project);
    assert.equal(fake.callCount(), 0);
    assert.equal(t.has(STYLE) ? t.read(STYLE) : undefined, before);
  });

  test('确认框说读哪几章、报次数；按钮是「开始提取」，没有覆盖的话', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['开始提取']);
    assert.ok(c.message.includes('读第 1、2 章正文') && c.message.includes('预计 1 次调用，最多 3 次'), c.message);
    assert.equal(c.detail, undefined);
  });

  test('点「开始提取」：写进 style.md', async () => {
    h.expect('1,2', '开始提取');
    fake.reset();
    await bundle.style.extractStyle(project);
    assert.equal(fake.callCount(), 1);
    assert.match(t.read(STYLE), /叙事视角的说明/);
  });

  test('已有内容再提取：按钮是「覆盖」，说清会盖掉', async () => {
    h.expect('1', undefined);
    fake.reset();
    await bundle.style.extractStyle(project);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['覆盖']);
    assert.match(c.detail, /会覆盖当前内容/);
    assert.equal(fake.callCount(), 0);
  });
});

describe('提取角色卡：挑完章先问', () => {
  test('在确认框上取消：不调模型', async () => {
    h.expect('3,4');
    fake.reset();
    await bundle.characters.extractCharacters(project);
    assert.equal(fake.callCount(), 0);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['开始提取']);
    assert.ok(c.message.includes('读第 3、4 章正文'), c.message);
  });

  test('换一个模型点「开始提取」：只用它', async () => {
    h.expect('3,4', { action: '开始提取', choice: { model: 'fake/strong' } });
    fake.reset();
    await bundle.characters.extractCharacters(project);
    assert.equal(fake.callCount(), 1);
    assert.deepEqual(refsUsed(), ['fake/strong']);
  });
});
