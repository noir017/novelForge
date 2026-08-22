/**
 * `core/skills/`：两个来源合并成一份索引、取正文、名字前缀与冲突处理。
 *
 * 这一层的判断只有三件事，全在这里钉住：
 *
 * 1. **前缀恒在**，且两个来源同名时**两份都列**——这样同一份技能在任何工程里的
 *    叫法都一样，模型不必猜这一次要不要带前缀；
 * 2. **索引只列名字，零文件读取**——正文由 `skill` 工具在真要用时才取；
 * 3. **取不到只回 error，绝不抛**，而且名单从**实际扫到的那一份**来
 *    （写死一串名字，加了技能之后那句话就在撒谎）。
 *
 * 用真临时目录而不是打桩 fs：这一层的活就是 `readdir` 一个可能不存在的目录，
 * 打了桩就等于把唯一要测的东西替换掉了。
 */
const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');

const { skills, projectMod } = loadBundle({
  skills: './src/core/skills/index.ts',
  projectMod: './src/core/model/project.ts',
});

const dirs = [];
after(() => {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** 开一个只有 `.novelforge/skills/` 的工程——这一层用不着完整初始化。 */
function projectWith(names) {
  const t = makeTempDir('skills');
  dirs.push(t.dir);
  for (const name of names) {
    fs.mkdirSync(path.join(t.dir, '.novelforge/skills', name), { recursive: true });
  }
  return { ...t, project: projectMod.NovelProject.open(t.dir) };
}

/** 内置那一半是烘出来的常量，测试里取第一个当样本。 */
const BUILTIN_NAMES = Object.keys(skills.BUILTIN_SKILLS).sort();
const SOME_BUILTIN = BUILTIN_NAMES[0];

describe('listSkills：两个来源合并', () => {
  test('至少有一个内置技能（防止空跑通过）', () => {
    assert.ok(BUILTIN_NAMES.length > 0);
  });

  test('没有工程技能目录时只有内置那一半，且不抛', async () => {
    const { project } = projectWith([]);
    const list = await skills.listSkills(project);
    assert.deepEqual(
      list.map((s) => s.name),
      BUILTIN_NAMES.map((n) => `builtin:${n}`)
    );
  });

  test('前缀恒在，不是撞名了才加', async () => {
    const { project } = projectWith(['我的审章流程']);
    const list = await skills.listSkills(project);
    assert.ok(list.every((s) => /^(builtin|project):/.test(s.name)), JSON.stringify(list));
    assert.ok(list.some((s) => s.name === 'project:我的审章流程'));
  });

  test('两个来源同名时两份都列，各带各的前缀', async () => {
    const { project } = projectWith([SOME_BUILTIN]);
    const names = (await skills.listSkills(project)).map((s) => s.name);
    assert.ok(names.includes(`builtin:${SOME_BUILTIN}`), names.join(' / '));
    assert.ok(names.includes(`project:${SOME_BUILTIN}`), names.join(' / '));
  });

  test('内置在前、工程在后，各自按名字排（顺序稳定，索引才一轮内不变）', async () => {
    const { project } = projectWith(['乙', '甲']);
    const list = await skills.listSkills(project);
    const sources = list.map((s) => s.source);
    assert.equal(sources.lastIndexOf('builtin') < sources.indexOf('project'), true);
    assert.deepEqual(
      list.filter((s) => s.source === 'project').map((s) => s.stem),
      ['乙', '甲'].sort()
    );
  });

  test('目录里的文件不算技能（一个技能 = 一个目录）', async () => {
    const t = projectWith([]);
    fs.mkdirSync(path.join(t.dir, '.novelforge/skills'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, '.novelforge/skills/README.md'), '不是技能', 'utf8');
    const list = await skills.listSkills(t.project);
    assert.deepEqual(list.filter((s) => s.source === 'project'), []);
  });

  test('stem 是不带前缀的那一半', async () => {
    const { project } = projectWith(['我的流程']);
    const one = (await skills.listSkills(project)).find((s) => s.source === 'project');
    assert.deepEqual({ name: one.name, stem: one.stem }, {
      name: 'project:我的流程',
      stem: '我的流程',
    });
  });
});

describe('describeSkills：拼进 system 的那一段', () => {
  /** 把一批技能全开到某一档。索引与 `/` 两条路各吃哪几档是这一层的判断。 */
  const modesFor = (names, mode) => Object.fromEntries(names.map((n) => [n, mode]));

  test('一个技能都没有时是空串（不拼一句每回合都要发的废话）', () => {
    assert.equal(skills.describeSkills([]), '');
  });

  // **缺省是「仅用户」**，所以什么都不配的工程里索引整段不拼——这是最常见的
  // 那条路，也是「装一份技能不让每一轮变贵」这个承诺的兑现处。
  test('缺省全是「仅用户」时索引是空的', async () => {
    const { project } = projectWith(['我的流程']);
    const list = await skills.listSkills(project);
    assert.ok(list.length > 0, '得真的扫到技能，否则这条在空跑');
    assert.ok(list.every((s) => s.mode === 'user'), JSON.stringify(list.map((s) => s.mode)));
    assert.equal(skills.describeSkills(list), '');
  });

  test('逐行列出全名，含前缀', async () => {
    const { project } = projectWith(['我的流程']);
    const all = ['project:我的流程', `builtin:${SOME_BUILTIN}`];
    const list = await skills.listSkills(project, modesFor(all, 'title'));
    const text = skills.describeSkills(list);
    assert.match(text, /- project:我的流程/);
    assert.match(text, new RegExp(`- builtin:${SOME_BUILTIN}`));
  });

  // 「仅标题」只给名字：描述那一行是「完整」档才付的钱。
  test('「仅标题」不带描述', async () => {
    const { project } = projectWith([]);
    const list = await skills.listSkills(project, { [`builtin:${SOME_BUILTIN}`]: 'title' });
    const text = skills.describeSkills(list);
    assert.match(text, new RegExp(`- builtin:${SOME_BUILTIN}$`, 'm'));
  });

  test('「完整」带上那一行描述', async () => {
    const { project } = projectWith([]);
    const list = await skills.listSkills(project, { [`builtin:${SOME_BUILTIN}`]: 'full' });
    const text = skills.describeSkills(list);
    const desc = skills.BUILTIN_SKILLS[SOME_BUILTIN].description;
    assert.ok(desc, '这个内置技能得写了 description，否则这条在空跑');
    assert.ok(text.includes(desc), text);
  });

  // 「禁用」两边都看不见；「仅用户」只有作者呼得出来。两者在索引里一样缺席，
  // 但那是两件事——区别在 listInvocableSkills 那一侧。
  test('「禁用」与「仅用户」都不进索引', async () => {
    const { project } = projectWith(['甲', '乙']);
    const list = await skills.listSkills(project, {
      'project:甲': 'off',
      'project:乙': 'user',
      [`builtin:${SOME_BUILTIN}`]: 'title',
    });
    const text = skills.describeSkills(list);
    assert.ok(!text.includes('project:甲'), text);
    assert.ok(!text.includes('project:乙'), text);
    assert.match(text, new RegExp(`- builtin:${SOME_BUILTIN}`));
  });

  // 名字抄错就调不到，而不做模糊匹配是有意的——所以得在索引里把话说清楚。
  test('告诉模型名字要照抄', () => {
    const text = skills.describeSkills([
      { name: 'builtin:x', source: 'builtin', stem: 'x', mode: 'title', description: '' },
    ]);
    assert.match(text, /照抄/);
  });
});

describe('listInvocableSkills：作者 / 呼得出来的那些', () => {
  test('缺省（仅用户）呼得出来——那一档的全部意义就在这儿', async () => {
    const { project } = projectWith(['我的流程']);
    const list = await skills.listSkills(project);
    const names = skills.listInvocableSkills(list).map((s) => s.name);
    assert.ok(names.includes('project:我的流程'), names.join(' / '));
  });

  test('「仅标题」/「完整」也呼得出来（那两档是 agent 也看得见，不是作者看不见）', async () => {
    const { project } = projectWith(['甲', '乙']);
    const list = await skills.listSkills(project, { 'project:甲': 'title', 'project:乙': 'full' });
    const names = skills.listInvocableSkills(list).map((s) => s.name);
    assert.ok(names.includes('project:甲'), names.join(' / '));
    assert.ok(names.includes('project:乙'), names.join(' / '));
  });

  test('只有「禁用」不在', async () => {
    const { project } = projectWith(['甲']);
    const list = await skills.listSkills(project, { 'project:甲': 'off' });
    const names = skills.listInvocableSkills(list).map((s) => s.name);
    assert.ok(!names.includes('project:甲'), names.join(' / '));
  });
});

describe('readSkill：取正文', () => {
  test('取内置那一半，回的是常量里那一份原文', async () => {
    const { project } = projectWith([]);
    const list = await skills.listSkills(project);
    const got = await skills.readSkill(project, list, `builtin:${SOME_BUILTIN}`);
    assert.equal(got.ok, true);
    assert.equal(got.text, skills.BUILTIN_SKILLS[SOME_BUILTIN].body);
  });

  test('取工程那一半，读的是磁盘上那份 SKILL.md', async () => {
    const t = projectWith(['我的流程']);
    t.write('.novelforge/skills/我的流程/SKILL.md', '# 我的流程\n\n第一步…\n');
    const list = await skills.listSkills(t.project);
    const got = await skills.readSkill(t.project, list, 'project:我的流程');
    assert.equal(got.ok, true);
    assert.match(got.text, /第一步/);
  });

  test('同名时按前缀分得清是哪一份', async () => {
    const t = projectWith([SOME_BUILTIN]);
    t.write(`.novelforge/skills/${SOME_BUILTIN}/SKILL.md`, '作者自己写的那一份');
    const list = await skills.listSkills(t.project);
    const mine = await skills.readSkill(t.project, list, `project:${SOME_BUILTIN}`);
    const ours = await skills.readSkill(t.project, list, `builtin:${SOME_BUILTIN}`);
    assert.equal(mine.text, '作者自己写的那一份');
    assert.equal(ours.text, skills.BUILTIN_SKILLS[SOME_BUILTIN].body);
  });

  test('目录在但没有 SKILL.md：回 error，不抛', async () => {
    const t = projectWith(['空壳']);
    const list = await skills.listSkills(t.project);
    const got = await skills.readSkill(t.project, list, 'project:空壳');
    assert.equal(got.ok, false);
    assert.match(got.error, /SKILL\.md/);
  });
});

describe('readSkill：取不到的时候', () => {
  // **正文要真的写进去**：只建目录的话，每一条查找都会因为「没有 SKILL.md」
  // 而失败，于是下面几条断言全都通过，但一条都没在测它自己说的那件事。
  const listOf = async () => {
    const t = projectWith(['我的流程']);
    t.write('.novelforge/skills/我的流程/SKILL.md', '正文');
    return { project: t.project, list: await skills.listSkills(t.project) };
  };

  test('名字不存在回 error 而不是抛', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, '并不存在的技能');
    assert.equal(got.ok, false);
    assert.match(got.error, /没有叫/);
  });

  // 名单从实际扫到的那一份来：写死一串名字，加了技能之后这句话就在撒谎。
  test('顺带列出实际有哪些', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, 'x');
    assert.match(got.error, /project:我的流程/);
    assert.match(got.error, new RegExp(`builtin:${SOME_BUILTIN}`));
  });

  test('不做模糊匹配：少了前缀就不认', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, SOME_BUILTIN);
    assert.equal(got.ok, false, '猜错时模型会拿到一份自己没想要的技能，而且不会知道');
    assert.match(got.error, /没有叫/);
  });

  test('大小写不同也不认', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, 'PROJECT:我的流程');
    assert.equal(got.ok, false);
    assert.match(got.error, /没有叫/);
  });

  // 名字**不认**模糊匹配，但前后空白是抄进来时带的、不是名字的一部分。
  test('前后空白照旧认得出来', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, '  project:我的流程  ');
    assert.equal(got.ok, true, got.error);
    assert.equal(got.text, '正文');
  });

  test('名字为空时给的是同一份名单', async () => {
    const { project, list } = await listOf();
    const got = await skills.readSkill(project, list, '');
    assert.equal(got.ok, false);
    assert.match(got.error, /必填/);
    assert.match(got.error, /project:我的流程/);
  });
});
