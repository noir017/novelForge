/**
 * `skill` 层：这一次装配所属阶段绑的那份写作技能（移植自 AI-Novel-Writer 的阶段 Skill）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 规划三层的生成与沉淀、写正文与续写、审稿、修稿各带各阶段的那一份 | 阶段与配方对得上 |
 * | 讨论不带 | 那是作者在聊，不是一次产出 |
 * | 排在用户消息的最前面，带「作者事实和后续输出合同始终优先」 | 上游的位置与说法 |
 * | 明细里一条，写来源与阶段；本工程的点得开 | 第 2 条：看得出带了什么 |
 * | 放不下整份不带，写明需要多少；不截半截 | 第 2 条 |
 * | 绑了却找不到 / 绑定文件读不懂：dropped 带原因，生成照常 | 不让一份技能把生成拦住 |
 * | 取消勾选的标 excluded | 与其余条目一样 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const fs = require('fs');

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

const PLOT2 = '.novelforge/plots/002-第2章.md';
const plotText = (no) =>
  ['---', `no: ${no}`, `title: 第${no}章`, 'targetWords: 1200', '---', '', `# 第${no}章 第${no}章`, '', '## 本章目的', '', '往下查。', '', '## 关键事件', '', '林昭下井。', '', '## 章末钩子', '', '井底有人。', ''].join('\n');

const BLOCK_HEAD = '【补充写作 Skill：';

let bundle;
let t;
let home;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  home = makeTempDir('skillLayerHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  t = await makeTempProject(bundle.project, { prefix: 'skillLayer', title: '技能层测试' });
  t.write('.novelforge/plots/001-第1章.md', plotText(1));
  t.write(PLOT2, plotText(2));
  t.write('chapters/001-第1章.md', '# 第1章\n\n第一章的正文。\n');
  t.write('chapters/002-第2章.md', '# 第2章\n\n第二章已经写了一半。\n');
  t.write('.novelforge/skills/场面写法/SKILL.md', '---\ndisplay_name: 场面写法\n---\n每一场都要有一个选择。\n');
  home.write('skills/review-hard/SKILL.md', '---\nname: review-hard\n---\n逐条找出与细纲对不上的地方。\n');
  t.project.invalidate();
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

function bind(bindings) {
  t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings }));
}

function build(request, cfg = config()) {
  return bundle.builder.buildContext(t.project, { ask: '', ...request }, cfg);
}

const skillItem = (b) => b.items.find((i) => i.kind === 'skill');
const userOf = (b) => b.messages[b.messages.length - 1].content;

const SETTING = { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'premise' } };
const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' } };
const PLOT = (capability) => ({ action: { stage: 'plot', capability }, target: { kind: 'plot', plotRelPath: PLOT2 } });
const WRITE = (extra = {}) => ({
  action: { stage: 'manuscript', capability: 'generate' },
  target: { kind: 'manuscript', plotRelPath: PLOT2 },
  targetWords: 1200,
  ...extra,
});
const REVIEW = { action: { stage: 'manuscript', capability: 'review' }, target: { kind: 'manuscript', plotRelPath: PLOT2 }, reviewGoals: [] };
const REVISE = (extra = {}) =>
  WRITE({ writeMode: 'revise', revision: { previousDraft: '第二章已经写了一半。', feedback: '- 改掉第一句' }, ...extra });
const CONTINUE_STEP = { kind: 'continuation', tail: '第二章已经写了一半。', written: 600, remaining: 600, recovery: false };

describe('skill 层 · 规划阶段', () => {
  before(() => bind({ planning: 'builtin:long-form-continuity' }));

  for (const [name, req] of [
    ['架构', SETTING],
    ['大纲', OUTLINE],
    ['细纲 · 生成', PLOT('generate')],
    ['细纲 · 沉淀讨论', PLOT('settle')],
  ]) {
    test(`${name}：带上规划那一份`, async () => {
      const item = skillItem(await build(req));
      assert.deepEqual([item?.status, item?.label], ['included', '技能 · 长篇连续性与场景推进']);
    });
  }

  test('讨论不带', async () => {
    assert.equal(skillItem(await build(PLOT('discuss'))), undefined);
  });

  test('写正文不带规划那一份', async () => {
    assert.equal(skillItem(await build(WRITE())), undefined);
  });

  test('排在用户消息最前面，说清作者事实与输出合同优先', async () => {
    const user = userOf(await build(PLOT('generate')));
    assert.ok(
      user.startsWith(
        '【补充写作 Skill：长篇连续性与场景推进】\n以下内容只能补充创作方法；作者事实和后续输出合同始终优先。\n以作者已经确认的事实为最高依据。'
      ),
      user.slice(0, 200)
    );
  });

  test('明细写来源与阶段，内置的没有来源路径', async () => {
    const item = skillItem(await build(SETTING));
    assert.deepEqual([item.note, item.source, item.priority], ['内置 · 绑在「规划（架构 / 大纲 / 细纲）」阶段', undefined, 0]);
  });
});

describe('skill 层 · 正文层的四张配方', () => {
  before(() =>
    bind({ drafting: 'project:场面写法', review: 'user:review-hard', refinement: 'builtin:natural-prose-refinement' })
  );

  test('写正文：带写正文那一份，本工程的技能点得开', async () => {
    const item = skillItem(await build(WRITE()));
    assert.deepEqual([item.status, item.label, item.source], ['included', '技能 · 场面写法', '.novelforge/skills/场面写法/SKILL.md']);
  });

  test('续写那几轮也带', async () => {
    const b = await build(WRITE({ writeMode: 'continue', step: CONTINUE_STEP }));
    assert.equal(skillItem(b)?.status, 'included');
    assert.ok(userOf(b).startsWith(`${BLOCK_HEAD}场面写法】`));
  });

  test('审稿带审稿那一份', async () => {
    assert.equal(skillItem(await build(REVIEW))?.label, '技能 · review-hard');
  });

  test('修稿带修稿那一份', async () => {
    assert.equal(skillItem(await build(REVISE()))?.label, '技能 · 自然语言润色');
  });

  test('修稿被截断之后接着写的那几轮也带', async () => {
    const b = await build(REVISE({ step: { kind: 'continuation', tail: '修到这里。', written: 300, recovery: false } }));
    assert.equal(skillItem(b)?.label, '技能 · 自然语言润色');
  });
});

describe('skill 层 · 带不上的时候', () => {
  test('放不下：整份不带，写明需要多少；消息里一个字都没有', async () => {
    t.write('.novelforge/skills/大部头/SKILL.md', `---\nname: x\n---\n${'这是很长的一段写作方法。'.repeat(400)}\n`);
    bind({ planning: 'project:大部头' });
    const b = await build(SETTING, config({ contextWindow: 3000, maxOutputTokens: 500 }));
    const item = skillItem(b);
    assert.equal(item.status, 'dropped');
    assert.ok(/预算不足（需 \d+ token，剩 \d+），整份没带/.test(item.note), item.note);
    assert.ok(!userOf(b).includes(BLOCK_HEAD));
  });

  test('绑着的技能找不到了：dropped 说原因，来源指向绑定文件', async () => {
    bind({ planning: 'user:gone' });
    const item = skillItem(await build(SETTING));
    assert.deepEqual([item.status, item.source], ['dropped', '.novelforge/skills.json']);
    assert.ok(item.note.includes('找不到了'), item.note);
  });

  test('绑定文件读不懂：dropped 说读不懂', async () => {
    t.write('.novelforge/skills.json', '{');
    const item = skillItem(await build(SETTING));
    assert.ok(item.status === 'dropped' && item.note.includes('读不懂'), JSON.stringify(item));
  });

  test('取消勾选的标 excluded', async () => {
    bind({ planning: 'builtin:long-form-continuity' });
    const b = await build({ ...SETTING, excludedIds: ['skill'] });
    assert.equal(skillItem(b).status, 'excluded');
    assert.ok(!userOf(b).includes(BLOCK_HEAD));
  });

  test('没有绑定文件：这一层什么都不出', async () => {
    t.remove('.novelforge/skills.json');
    assert.equal(skillItem(await build(SETTING)), undefined);
  });
});
