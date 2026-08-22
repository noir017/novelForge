/**
 * `skill` 工具：取一份技能的正文。
 *
 * 走**真的那条路**（`ToolRegistry.invoke`），因为这个工具的价值全在边角上：
 *
 * 1. **`gate: 'auto'`**——不花钱、不写盘，三种策略下都不该弹框；
 * 2. **取不到只回 error，绝不抛**，而且名单从实际扫到的那一份来；
 * 3. **只回 `SKILL.md` 正文，不回 `references/`**——附件由模型自己用 `read` 取；
 * 4. **不做模糊匹配**，猜错时模型会拿到一份自己没想要的技能而且不会知道。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let registry;

/** 内置那一半是烘出来的常量，取第一个当样本。 */
let someBuiltin;

const run = (args) =>
  registry.invoke('skill', args, {
    signal: new AbortController().signal,
    report: () => {},
    usage: { record: () => {} },
  });

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    tools: './src/core/tools/novel/index.ts',
    skills: './src/core/skills/index.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ name: 'standalone', settings: () => ({}) }).host);

  t = await makeTempProject(bundle.project, { prefix: 'agentskill', title: '青云剑录' });
  project = t.project;

  someBuiltin = Object.keys(bundle.skills.BUILTIN_SKILLS).sort()[0];

  // 作者自己写的一份，连一个附件——附件是 `read` 的活，这里要验它不被塞进返回值。
  t.write('.novelforge/skills/我的审章流程/SKILL.md', '# 我的审章流程\n\n细则见 references/细则.md\n');
  t.write('.novelforge/skills/我的审章流程/references/细则.md', '这是附件，不该出现在 skill 的返回里');

  registry = bundle.tools.createNovelTools({
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
  });
});

after(async () => {
  await cleanup(t);
});

describe('注册与闸门', () => {
  test('它就是第八个工具', () => {
    assert.equal(bundle.tools.NOVEL_TOOLS.length, 8);
    assert.deepEqual(registry.names(), [
      'list',
      'read',
      'search',
      'skill',
      'generate',
      'write',
      'edit',
      'run',
    ]);
  });

  // 不花钱、不写盘、不改任何东西——跟 list / read / search 同一档。
  test('gate 是 auto（三种策略下都不弹框）', () => {
    assert.equal(registry.intent('skill', { name: 'x' }).gate, 'auto');
  });

  test('既不 costly 也不 mutating', () => {
    const def = bundle.tools.NOVEL_TOOLS.find((d) => d.name === 'skill');
    assert.equal(!!def.costly, false);
    assert.equal(!!def.mutating, false);
  });
});

describe('取正文', () => {
  test('内置那一半：回的是常量里那一份原文', async () => {
    const r = await run({ name: `builtin:${someBuiltin}` });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, bundle.skills.BUILTIN_SKILLS[someBuiltin]);
  });

  test('工程那一半：回的是磁盘上那份 SKILL.md', async () => {
    const r = await run({ name: 'project:我的审章流程' });
    assert.equal(r.ok, true, r.error);
    assert.match(r.text, /我的审章流程/);
  });

  // 附件靠 read 取（技能正文里写着相对路径）。一次性倒给模型等于把「按需读」
  // 这件事取消掉——而那正是技能不进 AGENT_SYSTEM 的理由。
  test('只回 SKILL.md，不带 references/ 的内容', async () => {
    const r = await run({ name: 'project:我的审章流程' });
    assert.equal(r.text.includes('这是附件'), false, r.text);
  });

  test('那一行摘要上写得出是哪一份', async () => {
    const r = await run({ name: 'project:我的审章流程' });
    assert.match(r.display.title, /project:我的审章流程/);
  });

  test('不花钱（draftIds 空，也没记账）', async () => {
    const r = await run({ name: `builtin:${someBuiltin}` });
    assert.deepEqual(r.draftIds, []);
  });
});

describe('取不到的时候：回 error，绝不抛', () => {
  test('名字不存在', async () => {
    const r = await run({ name: '并不存在的技能' });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有叫/);
  });

  // 名单从实际扫到的那一份来——写死一串名字，作者新写一个技能之后这句话就在撒谎。
  test('顺带列出实际有哪些（含作者刚写的那个）', async () => {
    const r = await run({ name: 'x' });
    assert.match(r.error, /project:我的审章流程/);
    assert.match(r.error, new RegExp(`builtin:${someBuiltin}`));
  });

  test('不做模糊匹配：少了前缀不认', async () => {
    const r = await run({ name: someBuiltin });
    assert.equal(r.ok, false, '猜错时它会拿到一份自己没想要的技能，而且不会知道');
  });

  test('没填 name 时给的是同一份名单', async () => {
    const r = await run({});
    assert.equal(r.ok, false);
    assert.match(r.error, /project:我的审章流程/);
  });

  test('目录在但没有 SKILL.md', async () => {
    fs.mkdirSync(path.join(t.dir, '.novelforge/skills/空壳'), { recursive: true });
    const r = await run({ name: 'project:空壳' });
    assert.equal(r.ok, false);
    assert.match(r.error, /SKILL\.md/);
  });

  // 工具体里一行路径检查都没有，靠的是「名字只能从扫出来的那一份里挑」。
  test('拿路径当名字穿不出去', async () => {
    for (const evil of ['project:../../../etc/passwd', '../../secrets', 'project:a/../../b']) {
      const r = await run({ name: evil });
      assert.equal(r.ok, false, evil);
      assert.match(r.error, /没有叫/);
    }
  });
});

describe('作者中途新写一个技能', () => {
  // 索引一轮之内不变（那是循环那一层的事），但工具每次调用重新扫——
  // 于是「照着索引调」与「工具认得的名单」不会分叉。
  test('工具当场就认得出来', async () => {
    t.write('.novelforge/skills/临时加的/SKILL.md', '新写的');
    const r = await run({ name: 'project:临时加的' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, '新写的');
  });
});
