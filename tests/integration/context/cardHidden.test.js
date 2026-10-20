/**
 * 角色卡的「暗设」在上下文里的去留（叙事线重做第 10 个提交，设计稿「六、角色卡」⚑ 定案 B）：原来那一节叫「未收伏笔」，
 * 伏笔并进了叙事线，这一节改写读者还不知道的事。与设定条目的暗设（loreHidden.test.js、第 27 条）同一个口径。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 正文阶段（写、讨论、审稿）与续写：卡上不带暗设，真有暗设被去掉的在明细里注一句；空的、写着「无」的不注 | 写正文不需要知道真相，带上了正文模型就容易说漏；第 2 条 |
 * | 规划（细纲 / 大纲 / 架构）：整张带，暗设放在最后、标题写「暗设（读者还不知道）」 | 排细纲、排大纲要知道哪些没揭开 |
 * | 只带要点（「精简」）时：规划带身份 / 当前状态 / 暗设，写正文只带身份 / 当前状态，明细照实写 | 暗设是规划时守秘密最要紧的那一节 |
 * | 老卡里的「未收伏笔」不读 | 不兼容老工程：认不出的小节留在文件里，不进上下文 |
 * | 正文阶段 @ 引用的角色卡去掉暗设、明细注一句；规划时原样带 | 作者 @ 一张卡也不该把真相带进正文 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = (contextDetail = 3) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail,
});

const PLOT = '.novelforge/summaries/002-夜探.md';
const LIN = '.novelforge/characters/林昭.md';
const SHEN = '.novelforge/characters/沈青.md';
const SECRET = '林昭自己就是那份烧毁的名册上的人。';
const OLD = '他认得那块令牌的来历';
const DROPPED = '暗设没带：写正文不带读者还不知道的事，要让这一章揭开就写进本章细纲';
const MARKED = `## 暗设（读者还不知道）\n\n${SECRET}`;

const card = (name, sections, tags = []) =>
  [
    '---',
    `name: ${name}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    `# ${name}`,
    '',
    ...Object.entries(sections).flatMap(([k, v]) => [`## ${k}`, '', v, '']),
  ].join('\n');

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
  t = await makeTempProject(bundle.project, { prefix: 'cardHidden', title: '角色暗设' });
  t.write(LIN, card('林昭', { 身份: '火灾幸存者', 当前状态: '在客栈', 暗设: SECRET }, ['主角']));
  // 图谱让模型没有就写「无」：当没有。
  t.write(SHEN, card('沈青', { 身份: '药材商', 当前状态: '在客栈', 暗设: '无' }));
  // 老卡：「未收伏笔」是认不出的小节。
  t.write('.novelforge/characters/李叔.md', card('李叔', { 身份: '镇口守卫', 当前状态: '在镇口', 未收伏笔: OLD }));
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write(
    PLOT,
    ['---', 'no: 2', 'title: 夜探', '---', '', '# 第2章 夜探', '', '## 梗概', '', '林昭夜探分舵。', '', '## 出场人物', '', '林昭、沈青、李叔', ''].join('\n')
  );
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(action, target, extra = {}, detail = 3) {
  return bundle.builder.buildContext(t.project, { action, target, ask: '', targetWords: 1200, ...extra }, config(detail));
}

const WRITE = { stage: 'manuscript', capability: 'generate' };
const ON_CHAPTER = { kind: 'manuscript', plotRelPath: PLOT };
const PLAN = { stage: 'plot', capability: 'generate' };
const ON_PLOT = { kind: 'plot', plotRelPath: PLOT };
const cardOf = (b, name) => b.items.find((i) => i.kind === 'character' && i.label === `角色 · ${name}`);
const prompt = (b) => b.messages.map((m) => m.content).join('\n');

describe('正文阶段与续写：角色卡的暗设不带', () => {
  test('写正文：卡上没有暗设，明细里注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    const item = cardOf(b, '林昭');
    assert.equal(item.status, 'included');
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗设'), item.text);
    assert.ok(item.text.includes('## 当前状态\n\n在客栈'), item.text);
    assert.ok(item.note.endsWith(`；${DROPPED}`), item.note);
    assert.ok(!prompt(b).includes(SECRET), '真相进了写正文的提示词');
  });

  test('暗设写着「无」的卡不注', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    assert.ok(!cardOf(b, '沈青').note.includes('暗设没带'), cardOf(b, '沈青').note);
    assert.ok(!cardOf(b, '沈青').text.includes('暗设'), cardOf(b, '沈青').text);
  });

  for (const [what, action, extra] of [
    ['讨论正文', { stage: 'manuscript', capability: 'discuss' }, {}],
    ['审稿', { stage: 'manuscript', capability: 'review' }, {}],
    ['续写那几轮', WRITE, { step: { kind: 'continuation', tail: '他想起那场火。', written: 300, recovery: false } }],
  ]) {
    test(`${what}也不带`, async () => {
      const b = await build(action, ON_CHAPTER, extra);
      assert.ok(!cardOf(b, '林昭').text.includes(SECRET), cardOf(b, '林昭').text);
      assert.ok(!prompt(b).includes(SECRET));
    });
  }

  test('精简：写正文只带身份 / 当前状态，明细照实写', async () => {
    const b = await build(WRITE, ON_CHAPTER, {}, 1);
    const item = cardOf(b, '林昭');
    assert.equal(item.status, 'degraded');
    assert.match(item.note, /上下文详细度「精简」只带身份\/当前状态；暗设没带/);
    assert.ok(!item.text.includes(SECRET), item.text);
  });
});

describe('规划阶段：整张带，暗设标明读者还不知道', () => {
  test('细纲：暗设放在最后，标题写「暗设（读者还不知道）」', async () => {
    const b = await build(PLAN, ON_PLOT);
    const item = cardOf(b, '林昭');
    assert.ok(item.text.endsWith(`在客栈\n\n${MARKED}`), item.text);
    assert.ok(!item.note.includes('暗设没带'), item.note);
  });

  test('大纲、架构也带', async () => {
    const outline = await build({ stage: 'outline', capability: 'generate' }, { kind: 'outline' }, { ask: '林昭' });
    assert.ok(cardOf(outline, '林昭').text.endsWith(MARKED), cardOf(outline, '林昭').text);
    const setting = await build({ stage: 'setting', capability: 'generate' }, { kind: 'setting', doc: 'world' }, { ask: '林昭' });
    assert.ok(cardOf(setting, '林昭').text.endsWith(MARKED), cardOf(setting, '林昭').text);
  });

  test('精简：规划时带身份 / 当前状态 / 暗设', async () => {
    const b = await build(PLAN, ON_PLOT, {}, 1);
    const item = cardOf(b, '林昭');
    assert.match(item.note, /只带身份\/当前状态\/暗设$/);
    assert.ok(item.text.endsWith(MARKED), item.text);
  });

  test('暗设写着「无」的卡不带空标题', async () => {
    const b = await build(PLAN, ON_PLOT);
    assert.ok(!cardOf(b, '沈青').text.includes('暗设'), cardOf(b, '沈青').text);
  });
});

describe('老卡里的「未收伏笔」不读', () => {
  test('写正文、排细纲都不带', async () => {
    for (const b of [await build(WRITE, ON_CHAPTER), await build(PLAN, ON_PLOT)]) {
      const item = cardOf(b, '李叔');
      assert.ok(item && !item.text.includes(OLD) && !item.text.includes('未收伏笔'), item?.text);
      assert.ok(!item.note.includes('暗设没带'), item.note);
    }
  });

  test('读卡时这一节不进 sections，文件里还在', async () => {
    const li = (await t.project.listCharacters()).find((c) => c.name === '李叔');
    assert.equal(li.sections.暗设, '');
    assert.ok(!Object.values(li.sections).some((v) => v.includes(OLD)));
    assert.ok(t.read('.novelforge/characters/李叔.md').includes(`## 未收伏笔\n\n${OLD}`));
  });
});

describe('@ 引用的角色卡', () => {
  const att = (relPath, label) => ({ id: `character:${relPath}`, kind: 'character', label, relPath });
  const attached = (b) => b.items.find((i) => i.kind === 'attachment');

  test('正文阶段：去掉暗设，明细注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att(LIN, '角色 林昭')] });
    const item = attached(b);
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗设'), item.text);
    assert.ok(item.text.includes('火灾幸存者'), item.text);
    assert.equal(item.note, `角色卡引用；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET));
  });

  test('正文阶段：暗设写着「无」只去掉那一节，不注', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att(SHEN, '角色 沈青')] });
    assert.ok(!attached(b).text.includes('暗设'), attached(b).text);
    assert.equal(attached(b).note, '角色卡引用');
  });

  test('规划时原样带', async () => {
    const b = await build(PLAN, ON_PLOT, { attachments: [att(LIN, '角色 林昭')] });
    assert.ok(attached(b).text.includes(`## 暗设\n\n${SECRET}`), attached(b).text);
    assert.equal(attached(b).note, '角色卡引用');
  });
});
