/**
 * 设置页「技能」删本工程的技能（controller/skills.ts 的 uninstallSkillFrom，source=project）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 作者点了「删除」：整个技能目录进 `.novelforge/.trash/`，绑了它的阶段解绑 | 不真删；留着绑定会让每次生成都报「找不到」 |
 * | 作者取消：目录与绑定都不动 | 删除要先问 |
 * | 内置技能拦下 | 内置的删不掉 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const SKILL = '---\nname: 玄天录-写法\ndisplay_name: 《玄天录》的写法\ndescription: 拆出来的写法\nstage: planning\n---\n## 章节结构\n\n每章两到三个场景。\n';

let bundle;
let h;
let home;
const projects = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    skills: './src/core/skills/index.ts',
    ctl: './src/core/controller/skills.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
  home = makeTempDir('skillsRemoveHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '删技能' });
  projects.push(t);
  t.write('.novelforge/skills/玄天录-写法/SKILL.md', SKILL);
  t.project.invalidate();
  const workspace = new bundle.ws.Workspace(t.project);
  await bundle.skills.saveSkillBinding(t.project, workspace, 'planning', 'project:玄天录-写法');
  const posts = [];
  const toasts = [];
  const sink = { post: (m) => posts.push(m), toast: (m, level) => toasts.push(`${level ?? 'info'}:${m}`) };
  return { t, scope: { project: t.project, workspace }, sink, posts, toasts };
}

describe('删本工程的技能', () => {
  test('点了删除：目录进回收站，绑定解开，重推一份技能表', async () => {
    const { t, scope, sink, posts, toasts } = await fresh('skill-rm');
    h.expect('删除');
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'project:玄天录-写法');
    assert.ok(!t.has('.novelforge/skills/玄天录-写法'));
    assert.match(t.read('.novelforge/.trash/.novelforge/skills/玄天录-写法/SKILL.md'), /每章两到三个场景/);
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, undefined);
    assert.match(h.confirms.at(-1).message, /删掉本工程的技能「《玄天录》的写法」/);
    assert.ok(toasts.some((x) => x.startsWith('info:已删除「《玄天录》的写法」') && x.includes('规划')), toasts.join('|'));
    const view = posts.at(-1).view;
    assert.ok(!view.rows.some((r) => r.id === 'project:玄天录-写法'));
  });

  test('取消：目录与绑定都不动', async () => {
    const { t, scope, sink } = await fresh('skill-keep');
    h.expect(undefined);
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'project:玄天录-写法');
    assert.ok(t.has('.novelforge/skills/玄天录-写法/SKILL.md'));
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, 'project:玄天录-写法');
  });

  test('内置技能拦下', async () => {
    const { scope, sink, toasts } = await fresh('skill-builtin');
    const before = h.confirms.length;
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'builtin:plain-prose');
    assert.equal(h.confirms.length, before);
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('内置技能删不掉')), toasts.join('|'));
  });
});
