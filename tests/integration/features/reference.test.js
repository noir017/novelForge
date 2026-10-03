/**
 * 从参考书学写法（拆书 B，features/reference.ts）：只学怎么写——文风写 `style.md`，结构与节奏写成一份
 * 「规划」阶段的写作技能，问绑不绑。原文一个字都不进工程。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 确认框报次数、抽哪几章、写到哪；style.md 有内容时按钮写明会覆盖 | 第 3、4 条 |
 * | 文风那次用参考书那份提示词（带任务边界），样章是均匀抽的开头 | 只学技法、不复述内容 |
 * | 写法那次带篇幅统计、看章节的头尾 | 结构与钩子要看结尾 |
 * | 技能写成本工程的 `SKILL.md`、stage 是规划、兼容；作者点了才绑 | 第 25 条精神：改往后每次生成的提示词要先问 |
 * | 原文不进工程 | 作者拍板：只学写法 |
 * | 只学文风：1 次调用，不写技能 | 选什么做什么 |
 * | 技能正文不兼容：不绑，说清为什么 | 绑上会让装配器每次都 dropped |
 * | 写一半就停 / 撞上限：不写盘 | 半份文风指南、半份技能会被当成完整的照做 |
 * | 宿主能选本机文件：工程外的 txt 也能学；MCP 给的路径仍只认工程里的 | 作者点的入口不必先把书搬进工程；外部 agent 不读工程外的文件 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let home;
/** 提示词规定的小节一个不缺——缺了会被当成截断拦下。 */
const sections = (heads, first) => heads.map((x, i) => `## ${x}\n\n${i === 0 ? first : '……'}`).join('\n\n');
const STYLE_HEADS = ['叙事视角', '句式节奏', '遣词特征', '对白风格', '描写偏好', '修辞习惯', '禁用清单'];
const SKILL_HEADS = ['章节结构', '场景推进', '钩子与悬念', '节奏与爽点', '信息投放', '开篇写法', '规划时怎么用'];
const STYLE_FULL = sections(STYLE_HEADS, '第三人称限知。');
const SKILL_FULL = `${sections(SKILL_HEADS, '每章两到三个场景，结尾停在未决的选择上。')}\n\n- 每章至少一次局面变化。`;
let skillBody = SKILL_FULL;
let styleReply = STYLE_FULL;
const projects = [];

/** 一本 12 章的参考书：每章开头写明章号，结尾一句钩子；里面有专有名词「玄天宗」。 */
const BOOK = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 第${i + 1}个标题\n第${i + 1}章开头，玄天宗的钟响了。\n${'风吹过山岗。'.repeat(500)}\n第${i + 1}章结尾：门开了。`).join('\n');

function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  if (sys.includes('需要从一本**参考书**的样章中归纳出一份「文风指南」')) return 'style';
  if (sys.includes('拆出它的「写法」')) return 'skill';
  return '?';
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    reference: './src/core/features/reference.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
  });
  bundle.host.initHost(h.host);
  home = makeTempDir('referenceHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  fake = installFakeProvider(bundle.registry, {
    reply: (messages) => (kindOf(messages) === 'style' ? styleReply : skillBody),
  });
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '学写法测试' });
  projects.push(t);
  t.write('参考/玄天录.txt', BOOK);
  t.project.invalidate();
  fake.reset();
  return t;
}

/** 工程里所有文件的内容拼起来（不含参考书本身）：看原文有没有漏进来。 */
function allProjectText(t) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (!abs.endsWith('玄天录.txt') && !abs.endsWith('.db')) out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(t.dir);
  return out.join('\n');
}

describe('从参考书学写法 · 两样都学', () => {
  let t;
  let r;
  before(async () => {
    t = await fresh('ref-both');
    // 选书 → 两样都学 → 开始 → 绑到规划
    h.expect('参考/玄天录.txt', 'both', '开始学', '绑到规划');
    r = await bundle.reference.learnFromReference(t.project);
  });

  test('确认框报次数、抽哪几章、写到哪', () => {
    const c = h.confirms[0];
    assert.equal(c.message, '从《玄天录》学文风与写法，预计 2 次调用。现在开始？');
    assert.deepEqual(c.actions, ['开始学']);
    assert.match(c.detail, /认出 12 章/);
    assert.match(c.detail, /看第 1、4、7、9、12 章（首尾与中间均匀抽）/);
    assert.match(c.detail, /看第 1、2、3、4、5、6 章（开篇与全书 30% 处/);
    assert.match(c.detail, /\.novelforge\/skills\/玄天录-写法\/SKILL\.md/);
    assert.match(c.detail, /原文不写进工程的任何文件/);
  });

  test('两次调用：文风带任务边界、写法带篇幅统计与章节结尾', () => {
    assert.equal(r.calls, 2);
    assert.deepEqual(fake.calls.map(kindOf), ['style', 'skill']);
    const [style, skill] = fake.calls;
    assert.match(style[0].content, /禁止复述样章的具体情节、角色名、地点名/);
    assert.match(style[1].content, /【样章：第 1 章】\n第1章开头/);
    assert.match(style[1].content, /（后略 \d+ 字）/);
    assert.match(skill[0].content, /不要提到工具、脚本、文件或附件/);
    assert.match(skill[1].content, /# 参考书的篇幅统计（程序数的）/);
    assert.match(skill[1].content, /全书 12 章/);
    assert.match(skill[1].content, /第3章结尾：门开了/);
  });

  test('文风写进 style.md', () => {
    assert.equal(r.style, '.novelforge/style.md');
    assert.match(t.read('.novelforge/style.md'), /第三人称限知/);
  });

  test('写法写成本工程的技能：stage 是规划、兼容；作者点了才绑', async () => {
    assert.deepEqual(r.skill, { id: 'project:玄天录-写法', relPath: '.novelforge/skills/玄天录-写法/SKILL.md', bound: true });
    const raw = t.read('.novelforge/skills/玄天录-写法/SKILL.md');
    assert.match(raw, /^---\nname: 玄天录-写法\ndisplay_name: 《玄天录》的写法\n/);
    assert.match(raw, /stage: planning/);
    assert.match(raw, /每章两到三个场景/);
    const skill = await bundle.skills.loadSkill('project:玄天录-写法', t.project);
    assert.equal(skill.inspection.compatible, true);
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, 'project:玄天录-写法');
    assert.match(h.confirms[1].message, /把「《玄天录》的写法」绑到「规划（架构 \/ 大纲 \/ 细纲）」阶段吗？/);
  });

  test('原文不进工程', () => {
    const all = allProjectText(t);
    assert.ok(!all.includes('玄天宗的钟响了'));
    assert.ok(!all.includes('风吹过山岗。风吹过山岗。'));
  });
});

describe('从参考书学写法 · 边角', () => {
  test('只学文风：1 次调用，不写技能；style.md 有内容时按钮写明会覆盖', async () => {
    const t = await fresh('ref-style');
    t.write('.novelforge/style.md', '# 文风指南\n\n作者自己调过的文风。\n');
    t.project.invalidate();
    h.expect('参考/玄天录.txt', 'style', '覆盖 style.md 并开始');
    const r = await bundle.reference.learnFromReference(t.project);
    assert.deepEqual(h.confirms[0].actions, ['覆盖 style.md 并开始']);
    assert.match(h.confirms[0].detail, /它已经有内容，会被覆盖/);
    assert.equal(r.calls, 1);
    assert.equal(r.skill, undefined);
    assert.match(t.read('.novelforge/style.md'), /第三人称限知/);
    assert.ok(!t.has('.novelforge/skills'));
  });

  test('作者在确认框取消：一次都不调、什么都不写', async () => {
    const t = await fresh('ref-cancel');
    h.expect('参考/玄天录.txt', 'both', undefined);
    const r = await bundle.reference.learnFromReference(t.project);
    assert.equal(r.calls, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(!t.has('.novelforge/skills'));
  });

  test('同名技能已在：加后缀，不覆盖', async () => {
    const t = await fresh('ref-taken');
    t.write('.novelforge/skills/玄天录-写法/SKILL.md', '---\nname: 玄天录-写法\n---\n作者的旧版。\n');
    t.project.invalidate();
    h.expect('参考/玄天录.txt', 'skill', '开始学', undefined);
    const r = await bundle.reference.learnFromReference(t.project);
    assert.equal(r.skill.id, 'project:玄天录-写法-2');
    assert.equal(r.skill.bound, false);
    assert.match(t.read('.novelforge/skills/玄天录-写法/SKILL.md'), /作者的旧版/);
  });

  test('技能正文不兼容：不问绑定，说清为什么', async () => {
    const t = await fresh('ref-incompat');
    const saved = skillBody;
    skillBody = sections(SKILL_HEADS, '每次规划前先调用 outline 工具检查结构。');
    try {
      h.expect('参考/玄天录.txt', 'skill', '开始学');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.skill.bound, false);
      assert.equal(h.confirms.length, 1);
      assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('不兼容')), h.toasts.join('|'));
    } finally {
      skillBody = saved;
    }
  });

  test('写法写到一半就停：不写技能、不问绑定，报出缺了哪几节；文风照常写', async () => {
    const t = await fresh('ref-cut');
    skillBody = '## 章节结构\n\n- **结尾停靠**：\n  1. 视觉峰值\n  2. 规则';
    try {
      h.expect('参考/玄天录.txt', 'both', '开始学');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.calls, 2);
      assert.equal(r.skill, undefined);
      assert.equal(r.style, '.novelforge/style.md');
      assert.ok(!t.has('.novelforge/skills'));
      assert.equal(h.confirms.length, 1);
      assert.ok(
        h.toasts.some((x) => x.startsWith('error:') && x.includes('写法没学成') && x.includes('缺了「场景推进」')),
        h.toasts.join('|')
      );
    } finally {
      skillBody = SKILL_FULL;
    }
  });

  test('上游报撞到输出上限：小节齐全也不写 style.md', async () => {
    const t = await fresh('ref-maxtokens');
    t.write('.novelforge/style.md', '# 文风指南\n\n作者自己调过的文风。\n');
    t.project.invalidate();
    styleReply = { text: STYLE_FULL, stop: 'maxTokens' };
    try {
      h.expect('参考/玄天录.txt', 'style', '覆盖 style.md 并开始');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.style, undefined);
      assert.match(t.read('.novelforge/style.md'), /作者自己调过的文风/);
      assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('输出上限')), h.toasts.join('|'));
    } finally {
      styleReply = STYLE_FULL;
    }
  });

  test('宿主能选本机文件：工程外的 txt 照样能学，确认框写绝对路径，原文不进工程', async () => {
    const t = await fresh('ref-host');
    const outside = makeTempDir('referenceBook');
    fs.writeFileSync(outside.rel('外面的书.txt'), BOOK);
    const asked = [];
    h.host.pickHostFile = async (opts) => {
      asked.push(opts);
      return outside.rel('外面的书.txt');
    };
    try {
      h.expect('style', '开始学');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0].extensions, ['txt']);
      assert.equal(asked[0].startDir, t.project.root);
      assert.equal(r.calls, 1);
      assert.equal(h.confirms[0].message, '从《外面的书》学文风，预计 1 次调用。现在开始？');
      assert.ok(h.confirms[0].detail.includes(`文件：${outside.rel('外面的书.txt')}`), h.confirms[0].detail);
      assert.ok(!allProjectText(t).includes('玄天宗的钟响了'));
    } finally {
      delete h.host.pickHostFile;
      fs.rmSync(outside.dir, { recursive: true, force: true });
    }
  });

  test('作者在本机选择器里取消：一次都不调', async () => {
    const t = await fresh('ref-host-cancel');
    h.host.pickHostFile = async () => undefined;
    const before = h.confirms.length;
    try {
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.calls, 0);
      assert.equal(h.confirms.length, before);
    } finally {
      delete h.host.pickHostFile;
    }
  });

  test('MCP 给的路径只认工程里的：工程外的绝对路径拒绝，不弹选择器', async () => {
    const t = await fresh('ref-mcp-abs');
    const outside = makeTempDir('referenceMcp');
    fs.writeFileSync(outside.rel('外面的书.txt'), BOOK);
    let opened = false;
    h.host.pickHostFile = async () => {
      opened = true;
      return undefined;
    };
    try {
      await assert.rejects(bundle.reference.learnFromReference(t.project, { path: outside.rel('外面的书.txt') }), /不是工程里能拆的 txt/);
      assert.equal(opened, false);
    } finally {
      delete h.host.pickHostFile;
      fs.rmSync(outside.dir, { recursive: true, force: true });
    }
  });

  test('认不出章节标题的书按字数切段', async () => {
    const t = await fresh('ref-bysize');
    t.write('参考/散文.txt', Array.from({ length: 6 }, (_, i) => `第${i}段${'字'.repeat(3000)}。`).join('\n'));
    t.project.invalidate();
    h.expect('参考/散文.txt', 'style', '开始学');
    await bundle.reference.learnFromReference(t.project);
    assert.match(h.confirms[0].detail, /认不出章节标题，按约 3000 字一段切成 6 段/);
    assert.match(h.confirms[0].detail, /段（首尾与中间均匀抽）/);
  });
});
