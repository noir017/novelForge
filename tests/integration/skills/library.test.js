/**
 * 技能库（core/skills/）：三个来源怎么读、从 GitHub 先检查再安装、卸载进回收站、阶段绑定。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 内置 → 我的技能库 → 本工程，身份是目录名 | 同名可以各有一份，靠前缀分开 |
 * | 链接、名字不合法、没有 SKILL.md 的目录跳过 | 我的技能库在工程外，这就是它的边界 |
 * | 没检查过不装；检查后内容变了不装；不兼容不装；同名不覆盖 | 照搬上游的五道关（第 3 条） |
 * | 检查不写任何文件 | 检查只是看 |
 * | 卸载挪进回收站，不真删 | 第 6 条的精神 |
 * | 绑之前要求技能存在且兼容；绑定文件读不懂时拒绝改写 | 不把读不懂的那几项悄悄冲掉 |
 * | 装配器问的那一句：没绑 / 带不上的原因 / 那一份 | 绑了却带不上要说出来 |
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let home;
let skills;
let ws;
const realFetch = globalThis.fetch;

const skillMd = (name, body = '每一场都要有一个选择。', extra = []) =>
  ['---', `name: ${name}`, `display_name: ${name} 的写法`, 'description: 测试用', ...extra, '---', body, ''].join('\n');

/** 假的 GitHub：`files` 是 raw 地址 → 内容，`branches` 是 owner/repo → 默认分支。 */
function fakeGitHub(files, branches = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
    if (api) {
      const branch = branches[`${api[1]}/${api[2]}`];
      return branch
        ? new Response(JSON.stringify({ default_branch: branch }), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    return url in files ? new Response(files[url], { status: 200 }) : new Response('nope', { status: 404 });
  };
  return calls;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    skills: './src/core/skills/index.ts',
    ws: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  skills = bundle.skills;
  t = await makeTempProject(bundle.project, { prefix: 'skillLib', title: '技能测试' });
  ws = new bundle.ws.Workspace(t.project);
  home = makeTempDir('skillHome');
  skills.setUserSkillsDir(home.rel('skills'));
});

after(() => {
  globalThis.fetch = realFetch;
  skills?.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

describe('三个来源', () => {
  before(() => {
    home.write('skills/scene-craft/SKILL.md', skillMd('scene-craft'));
    home.write('skills/no-file/README.md', 'x');
    home.write('skills/bad name/SKILL.md', skillMd('bad'));
    t.write('.novelforge/skills/去AI味/SKILL.md', skillMd('anything-else', '少用「仿佛」。'));
    t.write('.novelforge/skills/scene-craft/SKILL.md', skillMd('scene-craft', '工程里的那一份。'));
    try {
      fs.symlinkSync(home.rel('skills/scene-craft'), home.rel('skills/linked'), 'dir');
    } catch {
      // Windows 上没权限建链接：这一条就只验剩下的。
    }
  });

  test('内置 → 我的技能库 → 本工程，各来源内按名字排', async () => {
    const ids = (await skills.listSkills(t.project)).map((s) => s.id);
    assert.deepEqual(ids, [
      'builtin:long-form-continuity',
      'builtin:natural-prose-refinement',
      'builtin:plain-prose',
      'user:scene-craft',
      'project:scene-craft',
      'project:去AI味',
    ]);
  });

  test('身份是目录名，frontmatter 的 name 只用来显示', async () => {
    const own = await skills.loadSkill('project:去AI味', t.project);
    assert.deepEqual([own.name, own.inspection.name, own.inspection.body], ['去AI味', 'anything-else', '少用「仿佛」。']);
  });

  test('本工程的技能带工程内路径，我的技能库的没有', async () => {
    const [user, own] = await Promise.all([
      skills.loadSkill('user:scene-craft'),
      skills.loadSkill('project:scene-craft', t.project),
    ]);
    assert.deepEqual([user.relPath, own.relPath], [undefined, '.novelforge/skills/scene-craft/SKILL.md']);
  });

  test('没给工程就认不出本工程的技能', async () => {
    assert.equal(await skills.loadSkill('project:scene-craft'), undefined);
  });

  test('内置的都兼容', async () => {
    const list = await skills.listSkills();
    assert.ok(list.filter((s) => s.source === 'builtin').every((s) => s.inspection.compatible));
  });

  test('修正文风建议绑在写正文阶段', async () => {
    const plain = await skills.loadSkill('builtin:plain-prose');
    assert.equal(plain.inspection.stage, 'drafting');
  });

  test('链接过去的目录认不出', async () => {
    assert.equal(await skills.loadSkill('user:linked'), undefined);
  });
});

describe('从 GitHub 检查与安装', () => {
  const RAW = 'https://raw.githubusercontent.com/o/r/main/SKILL.md';
  const URL = 'https://github.com/o/r';

  beforeEach(() => {
    fs.rmSync(home.rel('skills/remote-skill'), { recursive: true, force: true });
  });

  test('仓库首页：先问默认分支，再下载 raw', async () => {
    const calls = fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.deepEqual(calls, ['https://api.github.com/repos/o/r', RAW]);
    assert.deepEqual([r.resolvedUrl, r.inspection.name, r.blockers], [RAW, 'remote-skill', []]);
  });

  test('检查不写任何文件', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    assert.ok(!fs.existsSync(home.rel('skills/remote-skill')));
  });

  test('检查过的那一份装得进来，原样落盘', async () => {
    const raw = skillMd('remote-skill');
    fakeGitHub({ [RAW]: raw }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    const s = await skills.installGitHubSkill(URL);
    assert.equal(s.id, 'user:remote-skill');
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/SKILL.md'), 'utf8'), raw);
  });

  test('没检查过不装', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await assert.rejects(skills.installGitHubSkill('https://github.com/o/r/tree/main'), /请先检查/);
  });

  test('检查之后内容变了不装', async () => {
    const files = { [RAW]: skillMd('remote-skill') };
    fakeGitHub(files, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    files[RAW] = skillMd('remote-skill', '换了一段。');
    await assert.rejects(skills.installGitHubSkill(URL), /检查之后变了/);
    assert.ok(!fs.existsSync(home.rel('skills/remote-skill')));
  });

  test('不兼容的：检查时就说装不了，装也装不进来', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill', '写完运行 scripts/lint.sh。') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.ok(r.blockers[0].includes('依赖脚本'), r.blockers.join('|'));
    await assert.rejects(skills.installGitHubSkill(URL), /装不了/);
  });

  test('同名的已经装了：说清要先卸载旧的，不覆盖', async () => {
    home.write('skills/remote-skill/SKILL.md', '旧的');
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.ok(r.blockers[0].includes('先卸载旧的'), r.blockers.join('|'));
    await assert.rejects(skills.installGitHubSkill(URL));
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/SKILL.md'), 'utf8'), '旧的');
  });

  test('超过 64 KiB 的不收', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill', '字'.repeat(23000)) }, { 'o/r': 'main' });
    await assert.rejects(skills.inspectGitHubSkill(URL), /64 KiB/);
  });

  test('下载失败说出 HTTP 状态', async () => {
    fakeGitHub({}, { 'o/r': 'main' });
    await assert.rejects(skills.inspectGitHubSkill(URL), /HTTP 404/);
  });

  test('确认框要的检查结果不用联网就拿得到', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    assert.equal(skills.inspectedGitHubSkill(URL).inspection.name, 'remote-skill');
  });
});

describe('卸载', () => {
  test('整个目录挪进与技能库同级的 .trash/skills/', async () => {
    home.write('skills/to-remove/SKILL.md', skillMd('to-remove'));
    const dest = await skills.uninstallUserSkill('to-remove');
    assert.equal(dest, home.rel('.trash', 'skills', 'to-remove'));
    assert.ok(!fs.existsSync(home.rel('skills/to-remove')) && fs.existsSync(path.join(dest, 'SKILL.md')));
  });

  test('回收站里已经有同名的：加 -2，不盖掉', async () => {
    home.write('skills/to-remove/SKILL.md', skillMd('to-remove'));
    const dest = await skills.uninstallUserSkill('to-remove');
    assert.equal(path.basename(dest), 'to-remove-2');
  });

  test('本来就没有：什么都不做', async () => {
    assert.equal(await skills.uninstallUserSkill('never-was'), undefined);
  });
});

describe('阶段绑定', () => {
  const bindingsText = () => t.read('.novelforge/skills.json');

  test('绑上一份：写进 .novelforge/skills.json', async () => {
    await skills.saveSkillBinding(t.project, ws, 'drafting', 'builtin:long-form-continuity');
    assert.deepEqual(JSON.parse(bindingsText()), { version: 1, bindings: { drafting: 'builtin:long-form-continuity' } });
  });

  test('装配器问得到那一份', async () => {
    const r = await skills.boundSkillFor(t.project, 'drafting');
    assert.deepEqual([r.status, r.skill.id], ['ok', 'builtin:long-form-continuity']);
  });

  test('没绑的阶段：none', async () => {
    assert.equal((await skills.boundSkillFor(t.project, 'review')).status, 'none');
  });

  test('不存在的技能绑不上', async () => {
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'review', 'user:never-was'), /找不到技能/);
  });

  test('不兼容的技能绑不上', async () => {
    t.write('.novelforge/skills/needs-tool/SKILL.md', skillMd('needs-tool', '先调用检索工具。'));
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'review', 'project:needs-tool'), /不兼容/);
  });

  test('解绑：那一项删掉', async () => {
    await skills.saveSkillBinding(t.project, ws, 'drafting', null);
    assert.deepEqual(JSON.parse(bindingsText()).bindings, {});
  });

  test('绑着的技能后来不见了：说找不到，不抛', async () => {
    t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings: { review: 'user:gone' } }));
    const r = await skills.boundSkillFor(t.project, 'review');
    assert.equal(r.status, 'problem');
    assert.ok(r.note.includes('user:gone') && r.note.includes('找不到了'), r.note);
  });

  test('绑着的技能后来变得不兼容：说不兼容', async () => {
    t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings: { review: 'project:needs-tool' } }));
    const r = await skills.boundSkillFor(t.project, 'review');
    assert.ok(r.status === 'problem' && r.note.includes('不兼容'), JSON.stringify(r));
  });

  test('绑定文件读不懂：装配器说读不懂；改绑定拒绝改写', async () => {
    t.write('.novelforge/skills.json', '{ 坏了');
    const r = await skills.boundSkillFor(t.project, 'planning');
    assert.ok(r.status === 'problem' && r.note.includes('读不懂'), JSON.stringify(r));
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'planning', 'builtin:long-form-continuity'), /先手动修好或删掉/);
    assert.equal(bindingsText(), '{ 坏了');
  });

  test('只有别的阶段那一项读不懂：这个阶段照常', async () => {
    t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings: { review: 3, drafting: 'builtin:long-form-continuity' } }));
    assert.equal((await skills.boundSkillFor(t.project, 'drafting')).status, 'ok');
    assert.equal((await skills.boundSkillFor(t.project, 'planning')).status, 'none');
  });

  test('卸载之后把指向它的绑定一起解掉', async () => {
    t.write('.novelforge/skills.json', JSON.stringify({ version: 1, bindings: { review: 'user:x', drafting: 'user:x', planning: 'builtin:long-form-continuity' } }));
    const stages = await skills.unbindSkillEverywhere(t.project, ws, 'user:x');
    assert.deepEqual(stages.sort(), ['drafting', 'review']);
    assert.deepEqual(JSON.parse(bindingsText()).bindings, { planning: 'builtin:long-form-continuity' });
  });
});
