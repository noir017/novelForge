/**
 * 从已写正文整理（拆书 A）的装配：`BuildRequest.derive` 时架构那张配方带上 `written` 层，
 * 契约换成「照正文整理」的说法。细纲不再从正文整理：拆书第一步「先整理细纲」已经照正文写出了
 * 定稿过的细纲，「补细纲」那一步连同细纲配方里的 `written` 层一起删了。情节大纲也不再整理：它是各章细纲梗概的
 * 汇总，细纲齐了它就齐了（docs/design/plans/2026-10-22-outline-from-plots.md），大纲配方不再挂 `written` 层。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 不是 derive 时一条 `written` 都没有、契约照旧 | 配方挂着这一层，平时必须是空的 |
 * | 架构：均匀抽样 5 章的开头 + 全书梗概（取自定稿过的细纲）；系统提示说清「这一次是整理」 | 上游只看首末两章，长书中段全丢 |
 * | 梗概放不下时降级或丢弃，写明原因 | 第 2 条：不静默截断 |
 * | 大纲那一层不带已写正文，即使请求里带着 derive | 大纲配方不再挂 `written` 层 |
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
    ws: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'deriveCtx', title: '整理测试' });
  for (let no = 1; no <= N; no++) {
    t.write(`chapters/00${no}-第${no}回.md`, `# 第${no}回\n\n${body(no)}\n`);
  }
  t.project.invalidate();
  // 第 1–6 章定稿过（细纲照正文更新、记了 sourceHash）；第 7、8 章还没定稿。
  const ws = new bundle.ws.Workspace(t.project);
  for (const chapter of (await t.project.listChapters()).filter((c) => c.order <= 6)) {
    await ws.finalizePlot(chapter, {
      梗概: `第${chapter.order}章梗概：林昭查到了第${chapter.order}条线索。`,
      出场人物: '林昭',
      时间地点: '青云山',
      关键事件: `第${chapter.order}章关键事件：翻墙。`,
      看点: `- 第${chapter.order}章看点：执事当众被林昭拆穿\n- 门外是谁`,
      状态变更: `第${chapter.order}章后林昭受了轻伤。`,
      连续性事实: '',
    }, [{ name: '林昭', aliases: [] }]);
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
  test('架构、大纲不 derive 时没有 written，契约照旧；细纲配方从来不带', async () => {
    // 角色图谱不随正文自动整理（见下一条）。
    const setting = await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'characters' } });
    const outline = await build({ action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, range: { from: 1, to: 20 } });
    const plot = await build({
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: '.novelforge/summaries/003.md' },
      range: { from: 3, to: 5 },
      targetNo: 3,
    });
    for (const b of [setting, outline, plot]) {
      assert.equal(written(b).length, 0);
      assert.ok(!user(b).includes('# 已写正文'));
      assert.ok(!user(b).includes('从已写正文整理'));
    }
    assert.match(user(outline), /一章一章推演这一段/);
    assert.match(user(plot), /商业网文节奏设计原则/);
    // 平时规划阶段绑的技能照带。
    assert.ok(setting.items.some((i) => i.kind === 'skill' && i.status === 'included'));
  });
});

describe('derive · 单件生成架构', () => {
  test('已经写了正文：配置、前提、世界观自动照正文整理，写到第几章按连续有正文算；不带规划技能', async () => {
    for (const doc of ['config', 'premise', 'world']) {
      const b = await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc } });
      assert.ok(written(b).length > 0, doc);
      assert.ok(user(b).includes('从已写正文整理'), doc);
      assert.ok(!b.items.some((i) => i.kind === 'skill' && i.status === 'included'), doc);
    }
  });

  test('讨论照旧，不带已写正文', async () => {
    const b = await build({ action: { stage: 'setting', capability: 'discuss' }, target: { kind: 'setting', doc: 'premise' }, ask: '聊聊' });
    assert.equal(written(b).length, 0);
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
    // 看点跟在同一行梗概后面，多条用分号连起来。
    assert.match(synopsis.text, /第1章梗概：林昭查到了第1条线索。｜看点：第1章看点：执事当众被林昭拆穿；门外是谁/);
    assert.match(synopsis.note, /2 章还没同步，没有梗概可带/);

    assert.match(system(b), /这一次不是从零创作：作者已经写到第 8 章/);
    const u = user(b);
    assert.ok(u.includes('# 已写正文（作者已经写成的权威事实'));
    assert.ok(u.includes('【从已写正文整理（重要）】作者已经写到第 8 章'));
    assert.ok(u.includes('基于上面「已写正文」'));
    // 规模照给，格式不变（2026-10-25 起按小标题写）；不说「我的脑洞」。
    assert.ok(u.includes('- 计划总章数：100 章'));
    assert.ok(u.includes('【小说配置格式】'));
    // 没有作者的一句话：一句话卖点必须写。
    assert.ok(u.includes('「一句话卖点」也必须写'), u.slice(-1500));
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

describe('derive · 大纲', () => {
  // 情节大纲是各章细纲梗概的汇总，不再照正文整理：大纲配方不挂 `written` 层，请求里带着 derive 也不带正文。
  test('大纲配方不带已写正文，契约照旧是规划', async () => {
    const b = await build({
      action: { stage: 'outline', capability: 'generate' },
      target: { kind: 'outline' },
      range: { from: 5, to: 8 },
      derive: { through: N },
    });
    assert.deepEqual(written(b), []);
    assert.ok(user(b).includes('一章一章推演这一段'));
  });
});
