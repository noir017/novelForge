/**
 * `skill` 工具：取一份技能的正文。
 *
 * 走**真的那条路**（`ToolRegistry.invoke`），因为这个工具的价值全在边角上：
 *
 * 1. **`gate: 'auto'`**——不花钱、不写盘，三种策略下都不该弹框；
 * 2. **取不到只回 error，绝不抛**，而且名单从实际扫到的那一份来；
 * 3. **只回 `SKILL.md` 正文，不回 `references/`**——附件由模型自己用 `read` 取；
 * 4. **不做模糊匹配**，猜错时模型会拿到一份自己没想要的技能而且不会知道；
 * 5. **只够得着 agent 看得见的那几档**——`仅用户` 的意思正是「等作者呼出」，
 *    工具替它读走了那一档就没有意义了。
 *
 * 第 5 条决定了这里的 fixture：**技能的缺省档是「仅用户」**，所以每一条取正文
 * 的用例都要先把它开到 `title` / `full`，否则工具本该取不到。那也是这个文件里
 * 最容易写出「因为别的原因而通过」的地方（缺省档下所有查找都失败，于是一串
 * 断言全绿，但一条都没在测它自己说的那件事）。
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

/**
 * 这一轮配置里的技能档位。**工具每次调用都重读配置**（`readConfig`），所以
 * 改这个对象就等于改了作者在设置页上的选择。
 */
let skillModes = {};

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
  bundle.host.initHost(makeFakeHost({ name: 'standalone', settings: () => ({ skillModes }) }).host);

  t = await makeTempProject(bundle.project, { prefix: 'agentskill', title: '青云剑录' });
  project = t.project;

  someBuiltin = Object.keys(bundle.skills.BUILTIN_SKILLS).sort()[0];

  // 作者自己写的一份，连一个附件——附件是 `read` 的活，这里要验它不被塞进返回值。
  t.write('.novelforge/skills/我的审章流程/SKILL.md', '# 我的审章流程\n\n细则见 references/细则.md\n');
  t.write('.novelforge/skills/我的审章流程/references/细则.md', '这是附件，不该出现在 skill 的返回里');

  // 给创作模型的那一份：这个工具**取不到它**，而且回的不是「没有这个名字」
  // 而是一句指路。缺省档（仅用户）在这一类上就等于启用，所以不必配。
  t.write(
    '.novelforge/skills/去AI味/SKILL.md',
    '---\ndescription: 清 AI 味\naudience: generate\n---\n\n# 去AI味\n'
  );

  // 默认把这两份开到「仅标题」= agent 看得见。取不到那几条用例各自改。
  skillModes = { [`builtin:${someBuiltin}`]: 'title', 'project:我的审章流程': 'title' };

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
    assert.equal(r.text, bundle.skills.BUILTIN_SKILLS[someBuiltin].body);
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
    // 要开到 agent 看得见，否则先撞上「没有叫…的技能」，测不到这一条想测的
    // 那句话（`listSkills` 刻意不 stat，所以「目录在、正文缺」只有取的时候才知道）。
    skillModes = { ...skillModes, 'project:空壳': 'title' };
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
    skillModes = { ...skillModes, 'project:临时加的': 'title' };
    const r = await run({ name: 'project:临时加的' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, '新写的');
  });
});

describe('够不着「仅用户」与「禁用」那两档', () => {
  // 「仅用户」的意思正是**「别自己去读，等作者呼」**（呼出时整份正文由
  // controller 折进那句话）。工具放行的话那一档就没有意义了。
  test('「仅用户」取不到', async () => {
    skillModes = { 'project:我的审章流程': 'user' };
    const r = await run({ name: 'project:我的审章流程' });
    assert.equal(r.ok, false, '这一档是留给作者呼出的，agent 不该自己读走');
    assert.match(r.error, /没有叫/);
  });

  test('「禁用」取不到', async () => {
    skillModes = { 'project:我的审章流程': 'off' };
    const r = await run({ name: 'project:我的审章流程' });
    assert.equal(r.ok, false);
  });

  // 名单里列着、却又拒掉，模型只会照着再试一次（一整轮上下文的钱）。
  test('取不到的那一档不出现在「可用的是」里', async () => {
    skillModes = { 'project:我的审章流程': 'user', [`builtin:${someBuiltin}`]: 'title' };
    const r = await run({ name: 'x' });
    assert.equal(r.error.includes('project:我的审章流程'), false, r.error);
    assert.match(r.error, new RegExp(`builtin:${someBuiltin}`));
  });

  // 缺省就是「仅用户」，所以什么都不配的工程里 agent 一份都读不到——它连
  // 名字都没在索引里见过。
  test('什么都不配时一份都取不到', async () => {
    skillModes = {};
    const r = await run({ name: `builtin:${someBuiltin}` });
    assert.equal(r.ok, false);
    assert.match(r.error, /一个技能都没有|没有叫/);
  });
});

// ---------------------------------------------------------------------------

/**
 * 给创作模型的那一类：**拒绝，而且指条路。**
 *
 * 回一句泛泛的「没有叫 X 的技能」会让模型照着索引里明明列着的名字反复再试
 * ——那一段的名字是它自己刚读到的。所以这里要认出这个名字，说清它该怎么用。
 */
describe('generate 类：取不到，但要指条路', () => {
  test('拒绝，不当成「没有这个名字」', async () => {
    const r = await run({ name: 'project:去AI味' });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('没有叫'), r.error);
  });

  test('错误里点名 generate 与 skills 参数', async () => {
    const { error } = await run({ name: 'project:去AI味' });
    assert.match(error, /generate/);
    assert.match(error, /skills/);
  });

  // 回给模型的是那句指路的话（registry 把 error 也放进 text），关键是**技能正文
  // 一个字都不在里面**——这一类的正文进 agent 上下文正是这一刀要避免的事。
  test('技能正文一个字都不回', async () => {
    const r = await run({ name: 'project:去AI味' });
    assert.ok(!r.text.includes('# 去AI味'), r.text);
  });

  // 「可用的是」那半句是 agent 类的名单，把 generate 类列进去再拒掉它，
  // 模型只会照着再试一次。
  test('它不出现在别处的「可用的是」名单里', async () => {
    const { error } = await run({ name: 'project:并不存在' });
    assert.match(error, /没有叫/);
    assert.ok(!error.includes('project:去AI味'), error);
  });
});
