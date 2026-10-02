/**
 * `run` 的四个写作技能动作（移植自 AI-Novel-Writer 的 inspect / install / bind 三个工具，并进 `run`，
 * 工具数不变）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 查与检查 `auto`；安装与绑定 `always` | 上游这两个都要确认；它们改的东西下游没有 diff 可看 |
 * | 安装的确认框说清装的是哪一份、正文开头是什么 | 上游的确认卡只显示一个地址 |
 * | 检查的回话说清元数据不可信、安装要作者确认 | 照搬上游的 note |
 * | 一个模型都不调 | 账上记 0 |
 * | 卸载被当成有意不给的动作拦下 | 与删除同理 |
 * | 参数给错动作当场报错 | 与 from / to 同一个道理 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const URL = 'https://github.com/o/r/tree/main/scene';
const RAW = 'https://raw.githubusercontent.com/o/r/main/scene/SKILL.md';
const SKILL = '---\nname: scene-craft\ndisplay_name: 场面写法\ndescription: 写场面的办法\n---\n每一场都要有一个选择。\n';

let bundle;
let t;
let home;
let ctx;
const realFetch = globalThis.fetch;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'run');
const run = (args) => tool().run(ctx, args);
const gateOf = (args) => tool().intent(args).gate;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    skills: './src/core/skills/index.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  home = makeTempDir('runSkillsHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  t = await makeTempProject(bundle.project, { prefix: 'runSkills', title: '技能动作' });
  globalThis.fetch = async (url) => (url === RAW ? new Response(SKILL, { status: 200 }) : new Response('nope', { status: 404 }));
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
});

after(() => {
  globalThis.fetch = realFetch;
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

describe('闸门按动作分', () => {
  test('查与检查不问', () => {
    assert.deepEqual([gateOf({ action: 'listSkills' }), gateOf({ action: 'inspectSkill', url: URL })], ['auto', 'auto']);
  });

  test('安装与绑定三种策略都问', () => {
    assert.deepEqual(
      [gateOf({ action: 'installSkill', url: URL }), gateOf({ action: 'bindSkill', name: 'builtin:x', stage: 'review' })],
      ['always', 'always']
    );
  });

  test('别的动作照旧是 mutating', () => {
    assert.equal(gateOf({ action: 'syncSummaries' }), 'mutating');
  });

  test('没检查过就要装：确认框先说会被拒绝', () => {
    assert.ok(tool().intent({ action: 'installSkill', url: 'https://github.com/x/y' }).detail.includes('还没检查过'));
  });

  // 不然 agent 用 write 新建一份 skills.json，就绕过了 bindSkill 那一问。
  test('write 新建 / 追加技能文件也是三种策略都问；别的文件照旧', () => {
    const write = bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
    const gate = (path, mode) => write.intent({ path, mode }, t.project).gate;
    assert.deepEqual(
      [
        gate('.novelforge/skills.json'),
        gate('.novelforge/skills/x/SKILL.md', 'append'),
        gate('.novelforge/skills.json', 'overwrite'),
        gate('.novelforge/style.md'),
      ],
      ['always', 'always', 'reviewed', 'mutating']
    );
  });

  test('绑定的确认框说清阶段', () => {
    assert.equal(
      tool().intent({ action: 'bindSkill', name: 'builtin:long-form-continuity', stage: 'drafting' }).title,
      '把写作技能 builtin:long-form-continuity 绑到「写正文」阶段'
    );
  });
});

describe('listSkills', () => {
  let r;
  before(async () => {
    r = await run({ action: 'listSkills' });
  });

  test('列出内置的 id，写明可绑', () => {
    assert.ok(r.text.includes('- builtin:long-form-continuity｜长篇连续性与场景推进｜内置｜建议 planning｜可绑'), r.text);
  });

  test('写明本工程每个阶段绑了什么', () => {
    assert.ok(r.text.includes('本工程的绑定：planning=（没绑）；drafting=（没绑）；review=（没绑）；refinement=（没绑）。'), r.text);
  });

  test('一个模型都不调', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('检查 → 安装 → 绑定', () => {
  let inspected;
  before(async () => {
    inspected = await run({ action: 'inspectSkill', url: URL });
  });

  test('检查的回话写明可以装，元数据不可信、安装要作者确认', () => {
    assert.ok(inspected.text.includes('检查了「场面写法」（name=scene-craft）：写场面的办法。'), inspected.text);
    assert.ok(inspected.text.includes('可以装。') && inspected.text.includes('不受信任的第三方文档'), inspected.text);
  });

  test('检查过之后，安装的确认框说清是哪一份、正文开头是什么', () => {
    const intent = tool().intent({ action: 'installSkill', url: URL });
    assert.equal(intent.title, '把写作技能「场面写法」装进我的技能库');
    assert.ok(intent.detail.includes('正文开头：每一场都要有一个选择。'), intent.detail);
  });

  test('安装：装进我的技能库，说清还没绑', async () => {
    const r = await run({ action: 'installSkill', url: URL });
    assert.equal(r.text, '已装进我的技能库：user:scene-craft（场面写法）。它还没绑到任何阶段。');
    assert.ok(fs.existsSync(home.rel('skills/scene-craft/SKILL.md')));
  });

  test('绑定：写进本工程的 skills.json', async () => {
    const r = await run({ action: 'bindSkill', name: 'user:scene-craft', stage: 'drafting' });
    assert.ok(!r.error, r.error);
    assert.deepEqual(JSON.parse(t.read('.novelforge/skills.json')).bindings, { drafting: 'user:scene-craft' });
  });

  test('一个模型都没调', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('参数与拒绝', () => {
  test('bindSkill 没给 stage', async () => {
    assert.ok((await run({ action: 'bindSkill', name: 'builtin:long-form-continuity' })).error.includes('还要 stage'));
  });

  test('bindSkill 给了认不出的 stage', async () => {
    assert.ok((await run({ action: 'bindSkill', name: 'builtin:long-form-continuity', stage: 'polish' })).error.includes('stage 只能是'));
  });

  test('bindSkill 绑一份不存在的技能', async () => {
    assert.ok((await run({ action: 'bindSkill', name: 'user:never-was', stage: 'review' })).error.includes('找不到技能'));
  });

  test('inspectSkill 没给 url', async () => {
    assert.ok((await run({ action: 'inspectSkill' })).error.includes('需要参数'));
  });

  test('别的动作给了 url / stage 当场报错', async () => {
    const [a, b] = await Promise.all([
      run({ action: 'listSkills', url: URL }),
      run({ action: 'syncSummaries', stage: 'review' }),
    ]);
    assert.ok(a.error.includes('不认 url') && b.error.includes('不认 stage'), `${a.error}|${b.error}`);
  });

  test('卸载技能被当成有意不给的动作拦下', async () => {
    assert.ok((await run({ action: 'uninstallSkill', name: 'user:scene-craft' })).error.includes('这是有意的'));
  });
});
