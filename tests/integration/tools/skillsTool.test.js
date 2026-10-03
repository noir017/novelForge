/**
 * `skills` 工具：写作技能的查、检查、安装、绑定（移植自 AI-Novel-Writer 的 inspect / install / bind
 * 三个工具，多一个 list 用来查 id）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 查与检查 `auto`；安装与绑定 `always` | 上游这两个都要确认；它们改的东西下游没有 diff 可看 |
 * | 安装的确认框说清装的是哪一份、正文开头是什么 | 上游的确认卡只显示一个地址 |
 * | 检查的回话说清元数据不可信、安装要作者确认 | 照搬上游的 note |
 * | 一个模型都不调 | 账上记 0 |
 * | 卸载被当成有意不给的动作拦下 | 与删除同理 |
 * | 参数给错动作当场报错 | 模型以为传了、其实被忽略，比多一次往返更糟 |
 * | 工具一个模型都不调，但不只读 | 装与绑会改东西：MCP 上落成 readOnlyHint=false |
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

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'skills');
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
  home = makeTempDir('skillsToolHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  t = await makeTempProject(bundle.project, { prefix: 'skillsTool', title: '技能动作' });
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
    assert.deepEqual([gateOf({ action: 'list' }), gateOf({ action: 'inspect', url: URL })], ['auto', 'auto']);
  });

  test('安装与绑定三种策略都问', () => {
    assert.deepEqual(
      [gateOf({ action: 'install', url: URL }), gateOf({ action: 'bind', id: 'builtin:x', stage: 'review' })],
      ['always', 'always']
    );
  });

  // 认不出的动作在执行时会被拒；问的那一步按缺省 mutating 走，不因为同属 skills 就跟着 auto。
  test('认不出的动作归 mutating', () => {
    assert.equal(gateOf({ action: 'uninstall' }), 'mutating');
  });

  test('没检查过就要装：确认框先说会被拒绝', () => {
    assert.ok(tool().intent({ action: 'install', url: 'https://github.com/x/y' }).detail.includes('还没检查过'));
  });

  // 不然 agent 用 write 新建一份 skills.json，就绕过了 bind 那一问。
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
      tool().intent({ action: 'bind', id: 'builtin:long-form-continuity', stage: 'drafting' }).title,
      '把写作技能 builtin:long-form-continuity 绑到「写正文」阶段'
    );
  });
});

describe('list', () => {
  let r;
  before(async () => {
    r = await run({ action: 'list' });
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
    inspected = await run({ action: 'inspect', url: URL });
  });

  test('检查的回话写明可以装，元数据不可信、安装要作者确认', () => {
    assert.ok(inspected.text.includes('检查了「场面写法」（name=scene-craft）：写场面的办法。'), inspected.text);
    assert.ok(inspected.text.includes('可以装。') && inspected.text.includes('不受信任的第三方文档'), inspected.text);
    // 下一步该调哪个动作写在回话里：动作名要与这个工具的枚举对得上。
    assert.ok(inspected.text.includes('（install，url 用同一个地址）'), inspected.text);
  });

  test('检查过之后，安装的确认框说清是哪一份、正文开头是什么', () => {
    const intent = tool().intent({ action: 'install', url: URL });
    assert.equal(intent.title, '把写作技能「场面写法」装进我的技能库');
    assert.ok(intent.detail.includes('正文开头：每一场都要有一个选择。'), intent.detail);
  });

  test('安装：装进我的技能库，说清还没绑', async () => {
    const r = await run({ action: 'install', url: URL });
    assert.equal(r.text, '已装进我的技能库：user:scene-craft（场面写法）。它还没绑到任何阶段。');
    assert.ok(fs.existsSync(home.rel('skills/scene-craft/SKILL.md')));
  });

  test('绑定：写进本工程的 skills.json', async () => {
    const r = await run({ action: 'bind', id: 'user:scene-craft', stage: 'drafting' });
    assert.ok(!r.error, r.error);
    assert.deepEqual(JSON.parse(t.read('.novelforge/skills.json')).bindings, { drafting: 'user:scene-craft' });
  });

  test('一个模型都没调', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('参数与拒绝', () => {
  // stage 是 bind 的必填：缺了在动手前就拦下，带上阶段的说明。
  test('bind 没给 stage', async () => {
    const r = await run({ action: 'bind', id: 'builtin:long-form-continuity' });
    assert.ok(r.error.startsWith('bind 需要参数：stage。stage：绑到哪个阶段'), r.error);
  });

  test('bind 两个都没给：一次说全', async () => {
    const r = await run({ action: 'bind' });
    assert.ok(r.error.startsWith('bind 需要参数：id、stage。'), r.error);
  });

  test('bind 给了认不出的 stage', async () => {
    const r = await run({ action: 'bind', id: 'builtin:long-form-continuity', stage: 'polish' });
    assert.equal(r.error, 'stage 只能是 planning / drafting / review / refinement。');
  });

  test('bind 绑一份不存在的技能', async () => {
    assert.ok((await run({ action: 'bind', id: 'user:never-was', stage: 'review' })).error.includes('找不到技能'));
  });

  test('inspect 没给 url', async () => {
    assert.ok((await run({ action: 'inspect' })).error.startsWith('inspect 需要参数：url。'));
  });

  // 从前 bind 的 id 走的是 name：拿着老提示词来的模型要听到「不认 name」，而不是被静默忽略。
  test('bind 给了 name 当场报错', async () => {
    const r = await run({ action: 'bind', name: 'builtin:long-form-continuity', stage: 'review' });
    assert.equal(r.error, 'bind 不认 name。');
  });

  test('别的动作给了 url / stage 当场报错，说清谁认', async () => {
    const [a, b] = await Promise.all([run({ action: 'list', url: URL }), run({ action: 'inspect', url: URL, stage: 'review' })]);
    assert.equal(a.error, 'list 不认 url，只有 inspect / install 认。');
    assert.equal(b.error, 'inspect 不认 stage，只有 bind 认。');
  });

  test('卸载技能被当成有意不给的动作拦下', async () => {
    for (const action of ['uninstall', 'uninstallSkill']) {
      const r = await run({ action, id: 'user:scene-craft' });
      assert.ok(r.error.includes('没有卸载技能这个动作，而且这是有意的'), r.error);
    }
    assert.ok(fs.existsSync(home.rel('skills/scene-craft/SKILL.md')));
  });
});

describe('工具定义本身', () => {
  test('参数：action、url、id、stage', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'id', 'stage', 'url']);
    assert.deepEqual(tool().parameters.properties.stage.enum, ['planning', 'drafting', 'review', 'refinement']);
  });

  // 一个模型都不调，但装与绑改东西：不 costly，mutating。
  test('不 costly，但 mutating', () => {
    assert.equal(tool().costly, false);
    assert.equal(tool().mutating, true);
  });

  test('描述里写着先 inspect 再 install、装完 bind', () => {
    assert.ok(tool().description.includes('先 inspect 再 install（同一个 url），装完用 bind 绑到阶段才会用上'), tool().description);
  });
});
