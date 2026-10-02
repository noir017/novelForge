/**
 * 从已写正文整理（拆书 A）的装配：`BuildRequest.derive` 时三张配方带上 `written` 层，契约换成
 * 「照正文整理」的说法。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 不是 derive 时一条 `written` 都没有、契约照旧 | 三张配方都挂着这一层，平时必须是空的 |
 * | 架构：均匀抽样 5 章的开头 + 全书梗概；系统提示说清「这一次是整理」 | 上游只看首末两章，长书中段全丢 |
 * | 梗概放不下时降级或丢弃，写明原因 | 第 2 条：不静默截断 |
 * | 大纲：区间里各章的摘要；没摘要的退回正文头尾 | 大纲照「发生了什么」整理 |
 * | 细纲：区间里各章正文的头尾；JSON 合同与平常一字不差 | 第 22 条：几条路共用同一份蓝图合同 |
 * | 规划阶段绑了技能，derive 时也不带 | 照实整理，不按技能的排法改写已经发生的事 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  recentChaptersFullText: 2,
  prevChapterTailChars: 1500,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

const N = 8;
/** 每章：开头一句可认的话 + 很长的中段 + 结尾一句钩子。 */
const body = (no) => `第${no}章开头：林昭醒来。\n\n${'山风很冷。'.repeat(1200)}\n\n第${no}章结尾：门外有人敲了三下。`;

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    prompts: './src/core/context/prompts.ts',
    ws: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'deriveCtx', title: '整理测试' });
  for (let no = 1; no <= N; no++) {
    t.write(`chapters/00${no}-第${no}回.md`, `# 第${no}回\n\n${body(no)}\n`);
  }
  t.project.invalidate();
  // 第 1–6 章有摘要；第 7、8 章没有。
  const ws = new bundle.ws.Workspace(t.project);
  for (const chapter of (await t.project.listChapters()).filter((c) => c.order <= 6)) {
    await ws.writeSummary(chapter, chapter.contentHash, {
      梗概: `第${chapter.order}章梗概：林昭查到了第${chapter.order}条线索。`,
      出场人物: '林昭',
      时间地点: '青云山',
      关键事件: `第${chapter.order}章关键事件：翻墙。`,
      新增伏笔: '',
      状态变更: `第${chapter.order}章后林昭受了轻伤。`,
      连续性事实: '',
    });
  }
  t.write('.novelforge/skills/排法/SKILL.md', '---\nname: 排法\n---\n每章三个场景。\n');
  t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings: { planning: 'project:排法' } }));
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(request, cfg = config()) {
  return bundle.builder.buildContext(t.project, { ask: '', ...request }, cfg);
}
const written = (built) => built.items.filter((i) => i.kind === 'written');
const user = (built) => built.messages[built.messages.length - 1].content;
const system = (built) => built.messages[0].content;

describe('derive · 平时不带', () => {
  test('架构、大纲、细纲三张配方不 derive 时没有 written，契约照旧', async () => {
    const setting = await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'premise' } });
    const outline = await build({ action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, range: { from: 1, to: 20 } });
    const plot = await build({
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: '.novelforge/plots/003.md' },
      range: { from: 3, to: 5 },
      targetNo: 3,
    });
    for (const b of [setting, outline, plot]) {
      assert.equal(written(b).length, 0);
      assert.ok(!user(b).includes('# 已写正文'));
      assert.ok(!user(b).includes('从已写正文整理'));
    }
    assert.match(user(outline), /结构拐点/);
    assert.match(user(plot), /商业网文节奏设计原则/);
    // 平时规划阶段绑的技能照带。
    assert.ok(setting.items.some((i) => i.kind === 'skill' && i.status === 'included'));
  });
});

describe('derive · 架构', () => {
  test('均匀抽样 5 章的开头节选 + 全书梗概；系统提示与契约说清是整理', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'config' },
      derive: { through: N },
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    const items = written(b);
    const samples = items.filter((i) => i.id !== 'written:synopsis');
    assert.deepEqual(samples.map((i) => i.id), ['written:1', 'written:3', 'written:5', 'written:6', 'written:8']);
    assert.ok(samples.every((i) => i.status === 'included'));
    assert.match(samples[0].text, /（后略 \d+ 字）/);
    const synopsis = items.find((i) => i.id === 'written:synopsis');
    assert.equal(synopsis.status, 'included');
    assert.match(synopsis.text, /第1章梗概/);
    assert.match(synopsis.note, /2 章还没有摘要/);

    assert.match(system(b), /这一次不是从零创作：作者已经写到第 8 章/);
    const u = user(b);
    assert.ok(u.includes('# 已写正文（作者已经写成的权威事实'));
    assert.ok(u.includes('【从已写正文整理（重要）】作者已经写到第 8 章'));
    assert.ok(u.includes('基于上面「已写正文」'));
    // 规模照给，JSON 合同不变；不说「我的脑洞」。
    assert.ok(u.includes('- 计划总章数：100 章'));
    assert.ok(u.includes('【不可变小说配置 JSON 合同】'));
    assert.ok(!u.includes('# 我的脑洞'));
    assert.ok(!u.includes('契合市场'));
  });

  test('只看第 1–through 章', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'world' },
      derive: { through: 3 },
    });
    assert.ok(written(b).every((i) => i.id === 'written:synopsis' || Number(i.id.split(':')[1]) <= 3));
    assert.match(user(b), /基于「已写正文」与小说配置/);
  });

  test('梗概放不下时降级（隔章抽）或丢弃，写明预算不足', async () => {
    const b = await build(
      {
        action: { stage: 'setting', capability: 'generate' },
        target: { kind: 'setting', doc: 'premise' },
        derive: { through: N },
      },
      config({ contextWindow: 12000, maxOutputTokens: 1000 })
    );
    const synopsis = written(b).find((i) => i.id === 'written:synopsis');
    assert.ok(synopsis, '梗概那一条要留在明细里');
    assert.ok(['degraded', 'dropped'].includes(synopsis.status), synopsis.status);
    assert.match(synopsis.note, /预算不足/);
  });

  test('规划阶段绑的技能 derive 时不带', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'premise' },
      derive: { through: N },
    });
    assert.ok(!b.items.some((i) => i.kind === 'skill'));
  });
});

describe('derive · 大纲与细纲', () => {
  test('大纲：区间里各章的摘要；没摘要的章退回正文头尾', async () => {
    const b = await build({
      action: { stage: 'outline', capability: 'generate' },
      target: { kind: 'outline' },
      range: { from: 5, to: 8 },
      derive: { through: N },
    });
    const items = written(b);
    assert.deepEqual(items.map((i) => i.id), ['written:5', 'written:6', 'written:7', 'written:8']);
    assert.match(items[0].text, /梗概：第5章梗概/);
    assert.match(items[0].text, /状态变更：第5章后林昭受了轻伤/);
    assert.match(items[2].text, /第7章开头/);
    assert.match(items[2].note, /还没有摘要/);
    const u = user(b);
    assert.ok(u.includes('整理出这一段的情节大纲'));
    assert.ok(u.includes('「## 第a–b章：标题」'));
    assert.ok(!u.includes('结构拐点'));
  });

  test('细纲：区间里各章正文的头尾，JSON 合同与平常一字不差', async () => {
    const request = {
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: '.novelforge/plots/003.md' },
      range: { from: 3, to: 5 },
      targetNo: 3,
    };
    const b = await build({ ...request, derive: { through: N } });
    const items = written(b);
    assert.deepEqual(items.map((i) => i.id), ['written:3', 'written:4', 'written:5']);
    assert.match(items[0].text, /第3章开头/);
    assert.match(items[0].text, /第3章结尾：门外有人敲了三下/);
    assert.match(items[0].text, /（中略 \d+ 字）/);
    const u = user(b);
    assert.ok(u.includes('照正文实际写的提取，不可臆造'));
    assert.ok(u.includes('不要输出 newCharacters'));
    assert.ok(!u.includes('商业网文节奏设计原则'));
    assert.ok(!u.includes('【章节容量合同】'));
    assert.ok(u.includes(bundle.prompts.blueprintJsonContract({ from: 3, to: 5 })));
  });
});
