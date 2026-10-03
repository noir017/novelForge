/**
 * 产物解析的三层降级 + 各条采纳落盘路径。
 *
 * 这一层最贵的失败方式不是崩溃，而是**静默写错地方或静默覆盖**——
 * 采纳细纲把手写的那份顶掉、生成角色图谱把作者改得很细的角色卡抹掉。
 * 所以这里的重点不是「能不能写进去」，而是「不该写的时候有没有拦住」。
 *
 * 一章一纲之后的五条采纳分支（`generation/accept.ts`）：
 *
 * | 产物 | 落点 | 已有内容时 |
 * |---|---|---|
 * | 小说配置 / 前提 / 世界观 | `config.md` / `premise.md` / `world.md` | 覆盖前审阅；配置的 frontmatter 合并 |
 * | 角色图谱 | `characters/` 下每人一张卡 | **同名跳过**，绝不覆盖，也就不必审阅 |
 * | 情节大纲 | `outline.md` | 覆盖前审阅 |
 * | 细纲 | `plots/NNN-标题.md` | 覆盖前审阅；标题 / 目标字数沿用磁盘那份 |
 * | 正文 | 同号的 `chapters/NNN-标题.md` | **追加**；落盘后在细纲上记 `writtenFrom` |
 *
 * 落盘的守卫在 `workspace/`，这里测的是分派与那几条取舍。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let A;
let plotFile;
let h;
let t;
let project;
/** `accept(target, artifact)`——绑好 project 的采纳入口。 */
let accept;

/** 按区间分节的大纲：细纲的上游指纹记的是覆盖本章的那一节。 */
const OUTLINE = '# 青云剑录 · 情节大纲\n\n## 第1–20章：第一幕 · 入局\n\n林昭进青云宗，藏书阁里有人在等他。\n';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    artifact: './src/core/features/artifact.ts',
    accept: './src/core/generation/accept.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
  });
  A = bundle.artifact;
  plotFile = bundle.plotFile;
  // 假宿主**没有** reviewReplace，于是覆盖审阅走 confirm 那条分支。
  // helper 默认带 reviewReplace，不摘掉的话「保留原样」这条路根本走不到。
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'creation',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
  t.write('.novelforge/outline.md', OUTLINE);
  project.invalidate();
  accept = (target, artifact, opts) => bundle.accept.acceptArtifact(project, target, artifact, opts);
});

after(() => {
  if (t) cleanup(t.dir);
});

/** 三节都填了的细纲小节。 */
const SECTIONS = {
  本章目的: '林昭进入青云宗',
  关键事件: '他在山门外踩点，失手惊动守卫，翻墙进了后院；收在藏书阁门口。',
  章末钩子: '藏书阁里亮着一盏灯。',
};

const settingT = (doc) => ({ kind: 'setting', doc });

// ================================================================ 产物解析

describe('artifact.ts · 细纲三层降级', () => {
  const act = { stage: 'plot', capability: 'generate' };
  let json;
  let english;
  let md;
  let plain;
  let irrelevant;

  before(() => {
    json = A.parseArtifact(act, JSON.stringify({
      title: '夜入青云',
      role: '小高潮',
      characters: ['林昭', '沈青'],
      targetWords: 3000,
      ...SECTIONS,
    }));
    // 移植过来的蓝图合同用的是英文键；`characters` 写成一个串、字数写成字符串也得认。
    english = A.parseArtifact(act, JSON.stringify({
      title: '林昭在暴雨的深夜翻越青云宗的侧峰围墙并且成功进入了藏书阁',
      purpose: '进宗门',
      keyEvents: ['踩点', '翻墙'],
      suspenseHook: '门后有人',
      characters: '林昭、沈青',
      targetWords: '3000',
    }));
    // 模型忘了 JSON，改回 Markdown 小节——这是最常见的不听话方式。
    md = A.parseArtifact(act, '## 本章目的\n\n林昭进入青云宗\n\n## 关键事件\n\n踩点、失手、翻墙');
    // 什么结构都没有：全文塞进主字段，好过整次生成作废。
    plain = A.parseArtifact(act, '这一章讲林昭翻墙进宗门。');
    // 语法合法但完全不相干的 JSON 不能认下来——认了会得到一份空细纲**且不再降级**。
    irrelevant = A.parseArtifact(act, '{"text":"林昭翻墙进宗门"}');
  });

  test('第一层 JSON', () => {
    assert.equal(json.kind, 'plot');
    assert.equal(json.sections.本章目的, '林昭进入青云宗');
  });

  test('JSON 三节都收下', () => {
    assert.equal(json.sections.章末钩子, '藏书阁里亮着一盏灯。');
  });

  test('JSON 带的规划字段也收下', () => {
    assert.equal(json.title, '夜入青云');
    assert.equal(json.role, '小高潮');
    assert.deepEqual(json.characters, ['林昭', '沈青']);
    assert.equal(json.targetWords, 3000);
  });

  test('英文键也认', () => {
    assert.equal(english.sections.本章目的, '进宗门');
    assert.ok(english.sections.关键事件.includes('翻墙'), english.sections.关键事件);
    assert.equal(english.sections.章末钩子, '门后有人');
  });

  test('写成一个串的出场人物被拆开', () => {
    assert.deepEqual(english.characters, ['林昭', '沈青']);
  });

  test('字符串的目标字数转成数字', () => {
    assert.equal(english.targetWords, 3000);
  });

  // 标题会变成文件名（`012-<标题>.md`），而模型很爱把一整句梗概当标题。
  test('过长的标题被收口', () => {
    assert.ok(english.title.length <= 18, english.title);
  });

  test('第二层 Markdown 小节', () => {
    assert.equal(md.sections.本章目的, '林昭进入青云宗');
    assert.equal(md.sections.关键事件, '踩点、失手、翻墙');
  });

  // 兜底落「关键事件」而不是「本章目的」：isPlotFilled 只看关键事件，兜底进别的
  // 那一节的话，这一章采纳后会显示成「还没排细纲」的空壳。
  test('第三层全文兜底进关键事件', () => {
    assert.equal(plain.sections.关键事件, '这一章讲林昭翻墙进宗门。');
  });

  test('兜底进去的细纲算「排过」', () => {
    assert.ok(plotFile.isPlotFilled(plain.sections), JSON.stringify(plain.sections));
  });

  // 严格解析不做全文兜底。批量路径（工程页一次给几十章写细纲）用它：
  // 那里没有人逐份过目，兜底会把模型的一句「我不太确定」变成一份「已规划」
  // 的细纲，紧接着的批量写正文还会照着它写出一整章。
  test('严格解析不兜底', () => {
    assert.equal(A.parsePlotStrict('这一章讲林昭翻墙进宗门。'), undefined);
  });

  test('严格解析仍认 JSON', () => {
    assert.equal(A.parsePlotStrict('{"关键事件":"进宗门"}')?.sections.关键事件, '进宗门');
  });

  test('严格解析仍认 Markdown 小节', () => {
    assert.equal(A.parsePlotStrict('## 关键事件\n\n进宗门')?.sections.关键事件, '进宗门');
  });

  test('不相干的 JSON 退到全文兜底', () => {
    assert.ok(irrelevant.sections.关键事件.includes('林昭翻墙'), JSON.stringify(irrelevant.sections));
  });

  test('代码块包裹能剥掉', () => {
    assert.equal(
      A.parseArtifact(act, '```json\n{"关键事件":"进宗门"}\n```').sections.关键事件,
      '进宗门'
    );
  });

  test('JSON 前后的废话不影响解析', () => {
    assert.equal(
      A.parseArtifact(act, '好的，以下是细纲：\n{"关键事件":"进宗门"}\n希望有帮助').sections.关键事件,
      '进宗门'
    );
  });

  // 落定与写细纲产出的是同一种产物，走的是同一条解析路（第 22 条）。
  test('落定与写细纲解析成同一种产物', () => {
    const settled = A.parseArtifact({ stage: 'plot', capability: 'settle' }, '{"关键事件":"进宗门"}');
    assert.equal(settled.kind, 'plot');
    assert.equal(settled.sections.关键事件, '进宗门');
  });
});

/**
 * 架构四件同属一个阶段，**要看 target 才分得清是哪一件**：三件是一份文档，
 * 「角色图谱」产出的是一组角色卡。本期是过渡版解析（JSON 同名键 / Markdown 小节），
 * 移植过来的合同是二期的事。
 */
describe('artifact.ts · 架构四件', () => {
  const act = { stage: 'setting', capability: 'generate' };
  let config;
  let configMd;
  let configPlain;
  let premise;
  let roster;
  let rosterMd;
  let bareRoster;

  before(() => {
    config = A.parseArtifact(act, JSON.stringify({
      genre: '武侠',
      structure: 'THREE_ACT',
      totalChapters: '30',
      wordsPerChapter: 3000,
      一句话: '一个从火里活下来的人回到起火的地方。',
      核心梗概: '林昭回青崖镇查七年前那场火。',
    }), settingT('config'));
    configMd = A.parseArtifact(act, '## 核心梗概\n\n回镇查火。\n\n## 金手指\n\n一块残缺的令牌。', settingT('config'));
    configPlain = A.parseArtifact(act, '一个回镇查火的故事。', settingT('config'));
    premise = A.parseArtifact(act, '## 核心冲突链\n\n回镇 → 被认出 → 被盯上', settingT('premise'));
    roster = A.parseArtifact(act, JSON.stringify({
      characters: [
        { name: '林昭', role: '主角', 身份: '火场里活下来的孤儿', aliases: '阿昭、小昭' },
        { name: '林昭', role: '重复的那一个' },
        { name: '沈青', role: '盟友', identity: '客栈老板娘' },
      ],
    }), settingT('characters'));
    rosterMd = A.parseArtifact(act, '## 林昭（主角）\n\n火场里活下来的孤儿。\n\n## 沈青\n\n客栈老板娘。', settingT('characters'));
    // 模型漏掉外层键，直接给数组。
    bareRoster = A.parseArtifact(act, '[{"name":"林昭"},{"name":"沈青"}]', settingT('characters'));
  });

  test('配置解析成一份架构文档', () => {
    assert.equal(config.kind, 'settingDoc');
    assert.equal(config.doc, 'config');
  });

  test('配置的小节收下', () => {
    assert.equal(config.sections.核心梗概, '林昭回青崖镇查七年前那场火。');
  });

  // 总章数与每章字数是整条链的长度锚点：大纲按它算区间，正文按它判写够没有。
  test('配置的规模参数转成数字', () => {
    assert.equal(config.config.totalChapters, 30);
    assert.equal(config.config.wordsPerChapter, 3000);
  });

  test('配置的枚举字段不分大小写', () => {
    assert.equal(config.config.structure, 'three_act');
  });

  test('配置的 Markdown 小节也认', () => {
    assert.equal(configMd.sections.金手指, '一块残缺的令牌。');
  });

  // 兜底进「核心梗概」：那是判配置「填过没有」看的那一节。
  test('配置的全文兜底进核心梗概', () => {
    assert.equal(configPlain.sections.核心梗概, '一个回镇查火的故事。');
  });

  test('前提按它自己的小节表解析', () => {
    assert.equal(premise.doc, 'premise');
    assert.equal(premise.sections.核心冲突链, '回镇 → 被认出 → 被盯上');
  });

  test('没给 target 时当作配置（架构的第一件）', () => {
    assert.equal(A.parseArtifact(act, '## 核心梗概\n\nx').doc, 'config');
  });

  test('角色图谱解析成一组人', () => {
    assert.equal(roster.kind, 'characterRoster');
    assert.deepEqual(roster.characters.map((c) => c.name), ['林昭', '沈青']);
  });

  test('同名的只收第一个', () => {
    assert.equal(roster.characters[0].role, '主角');
  });

  test('角色的定位、别名与身份都收下', () => {
    assert.deepEqual(roster.characters[0].aliases, ['阿昭', '小昭']);
    assert.equal(roster.characters[0].sections.身份, '火场里活下来的孤儿');
  });

  test('身份的英文键也认', () => {
    assert.equal(roster.characters[1].sections.身份, '客栈老板娘');
  });

  // 模型不按 JSON 答时，能留住的就是「这个人是谁」这一段。
  test('角色图谱的 Markdown 兜底：每个 ## 一人，括号里的定位剥掉', () => {
    assert.deepEqual(rosterMd.characters.map((c) => c.name), ['林昭', '沈青']);
    assert.equal(rosterMd.characters[1].sections.身份, '客栈老板娘。');
  });

  test('角色图谱的裸数组也认', () => {
    assert.deepEqual(bareRoster.characters.map((c) => c.name), ['林昭', '沈青']);
  });

  // 裸数组**只有一个人**时，「第一个 `{` 到最后一个 `}`」恰好是那个人自己——当成
  // 外层对象去取数组键会取到他的 `aliases`，名单就成了空的。整段以 `[` 开头时先认数组。
  test('裸数组只有一个人、且带 aliases 时也认得出来', () => {
    const one = A.parseArtifact(act, '[{"name":"林昭","aliases":["阿昭"],"role":"主角"}]', settingT('characters'));
    assert.deepEqual(one.characters.map((c) => c.name), ['林昭'], JSON.stringify(one));
  });
});

describe('artifact.ts · 空产物与描述', () => {
  test('正文原样收下', () => {
    assert.equal(
      A.parseArtifact({ stage: 'manuscript', capability: 'generate' }, '雨下了三天。').text,
      '雨下了三天。'
    );
  });

  test('大纲原样收下', () => {
    const a = A.parseArtifact({ stage: 'outline', capability: 'generate' }, '## 第1–20章：入局\n\n进宗门。');
    assert.equal(a.kind, 'outlineDoc');
    assert.ok(a.text.startsWith('## 第1–20章'), a.text);
  });

  test('空正文算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'manuscript', text: '   ' }));
  });

  test('一个人都没有的角色图谱算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'characterRoster', characters: [] }));
  });

  test('小节全空的架构文档算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'settingDoc', doc: 'world', sections: { 规则与漏洞: ' ' } }));
  });

  test('有内容的不算空', () => {
    assert.ok(!A.isArtifactEmpty(A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"关键事件":"x"}')));
  });

  test('细纲描述带填了几节', () => {
    const a = A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"本章目的":"x","关键事件":"y"}');
    assert.equal(A.describeArtifact(a), '细纲 · 2/3 节');
  });

  test('架构文档描述带填了几节', () => {
    assert.equal(
      A.describeArtifact({ kind: 'settingDoc', doc: 'config', sections: { 核心梗概: 'x', 金手指: 'y' } }),
      '小说配置 · 2/8 节'
    );
  });

  // 卡片上要说清「新建几张角色卡」，而不是一句光秃秃的「确定吗」。
  test('角色图谱描述报人数', () => {
    assert.equal(
      A.describeArtifact({ kind: 'characterRoster', characters: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
      '角色图谱 · 3 人'
    );
  });
});

// ================================================================ 采纳落盘

/**
 * 配置的小节整份换新，**frontmatter 合并**：产物给了的字段用产物的，没给的沿用
 * 磁盘那份。作者手定的「全书 100 章」不该因为重写一次梗概就被抹掉。
 */
describe('采纳 · 小说配置（覆盖要审阅，frontmatter 合并）', () => {
  const rel = '.novelforge/config.md';
  const artifact = () =>
    A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify({
      genre: '武侠',
      wordsPerChapter: 3000,
      一句话: '一个从火里活下来的人回到起火的地方。',
      核心梗概: '新写的梗概：林昭回青崖镇查火。',
    }), settingT('config'));
  let kept;
  let afterKept;
  let written;
  let config;

  before(async () => {
    // 作者手写过一份：定了类型与总章数。
    t.write(rel, '---\ngenre: 玄幻\ntotalChapters: 100\n---\n\n# 小说配置\n\n## 核心梗概\n\n作者自己写的梗概。\n');
    project.invalidate();

    h.expect('保留原样');
    kept = await accept(settingT('config'), artifact());
    afterKept = t.read(rel);

    h.expect('覆盖');
    written = await accept(settingT('config'), artifact());
    config = await project.readBookConfig();
  });

  test('拒绝覆盖时不写盘', () => {
    assert.equal(kept.skipped, true, kept.message);
    assert.ok(afterKept.includes('作者自己写的梗概'), afterKept);
  });

  test('确认后写回 config.md', () => {
    assert.equal(written.relPath, rel, written.message);
  });

  test('小节换成新的', () => {
    assert.equal(config.sections.核心梗概, '新写的梗概：林昭回青崖镇查火。');
  });

  test('产物给了的字段用产物的', () => {
    assert.equal(config.genre, '武侠');
    assert.equal(config.wordsPerChapter, 3000);
  });

  test('产物没给的字段沿用磁盘那份', () => {
    assert.equal(config.totalChapters, 100);
  });

  test('填过之后状态机认它', async () => {
    assert.equal((await project.settingFilled()).config, true);
  });
});

describe('采纳 · 故事前提 / 世界观', () => {
  let premise;
  let world;
  let filled;

  let reviewsOnBlank;

  before(async () => {
    // 初始化写的是空模板（全是占位）：拿它跟产物 diff 一遍没有意义，不审阅。
    const before = h.confirms.length;
    premise = await accept(settingT('premise'), {
      kind: 'settingDoc', doc: 'premise', sections: { 核心冲突链: '回镇 → 被认出 → 被盯上' },
    });
    world = await accept(settingT('world'), {
      kind: 'settingDoc', doc: 'world', sections: { 规则与漏洞: '过所制度：没有过所不得进镇。' },
    });
    reviewsOnBlank = h.confirms.length - before;
    filled = await project.settingFilled();
  });

  test('覆盖空模板不弹审阅', () => {
    assert.equal(reviewsOnBlank, 0, `弹了 ${reviewsOnBlank} 次`);
  });

  // 作者哪怕只填了一节，再生成就要先问（第 3 条）。
  test('已有内容时再采纳要先问，拒绝就一字不改', async () => {
    h.expect('保留原样');
    const kept = await accept(settingT('premise'), {
      kind: 'settingDoc', doc: 'premise', sections: { 核心冲突链: '另一条冲突链' },
    });
    assert.equal(kept.skipped, true, kept.message);
    assert.ok(t.read('.novelforge/premise.md').includes('回镇 → 被认出'), t.read('.novelforge/premise.md'));
  });

  test('前提写进 premise.md', () => {
    assert.equal(premise.relPath, '.novelforge/premise.md', premise.message);
    assert.ok(t.read('.novelforge/premise.md').includes('回镇 → 被认出'), t.read('.novelforge/premise.md'));
  });

  test('世界观写进 world.md', () => {
    assert.equal(world.relPath, '.novelforge/world.md', world.message);
  });

  // 空小节保留占位：作者手改时知道该往哪填。
  test('没给的小节留着标题', () => {
    assert.ok(t.read('.novelforge/premise.md').includes('## 悬念骨架'), t.read('.novelforge/premise.md'));
  });

  test('两件都算填过了', () => {
    assert.equal(filled.premise, true);
    assert.equal(filled.world, true);
  });
});

/**
 * 角色图谱：每人一张卡。
 *
 * - 没有卡的人直接建：新卡没有可覆盖的东西，不走审阅。
 * - **同名（或别名撞上）已有卡的走覆盖审阅，一张一审**（二期）：作者可能已经把那张卡
 *   改得很细，重新生成一次图谱不该静默抹掉它；同意了才换，新图谱里空着的节沿用旧卡。
 *   从前是一律跳过——那样作者想重做角色图谱时，已有的卡永远换不掉。
 */
describe('采纳 · 角色图谱（新卡直接建，同名的先审阅）', () => {
  const MINE = '.novelforge/characters/林昭.md';
  const handWritten = '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n\n## 身份\n\n作者改得很细的一段。\n\n## 性格\n\n作者写的性格。\n';
  const roster = {
    kind: 'characterRoster',
    characters: [
      { name: '林昭', role: '主角', aliases: [], sections: { 身份: '模型写的林昭' } },
      // 撞上的是已有卡的**别名**，同样是那一张：只审一次，不另建。
      { name: '阿昭', role: '主角', aliases: [], sections: {} },
      { name: '沈青', role: '盟友', aliases: ['青姐'], sections: { 身份: '客栈老板娘' } },
      { name: '韩七', role: '对手', aliases: [], sections: {} },
    ],
  };
  let kept;
  let keptText;
  let replaced;
  let reviewed;
  let again;
  let cards;

  before(async () => {
    t.write(MINE, handWritten);
    project.invalidate();
    // 第一次：作者在审阅里选「保留原样」（这个文件的假宿主没有 reviewReplace，
    // 审阅走 confirm）。
    h.expect('保留原样', '保留原样');
    kept = await accept(settingT('characters'), roster);
    keptText = t.read(MINE);
    reviewed = h.confirms.map((c) => c.message);
    // 第二次：同一份图谱，作者同意覆盖。
    h.expect('覆盖', '覆盖');
    replaced = await accept(settingT('characters'), roster);
    again = h.confirms.length;
    cards = await project.listCharacters();
  });

  test('新卡直接建，说出建了几张', () => {
    assert.ok(kept.message.includes('新建 2 张角色卡'), kept.message);
  });

  // 第 3 条：已有的卡先给作者看 diff。别名撞上的也是这一张，一共只审它一次。
  // 别名撞上的也是这一张：一共只审它一次，不会审两次、写两次。
  test('同名的卡先审阅，别名撞上的不另审一次', () => {
    assert.equal(reviewed.length, 1, JSON.stringify(reviewed));
    assert.ok(reviewed[0].includes('角色卡「林昭」'), reviewed[0]);
  });

  test('作者选保留：那张卡一个字节都没动，并且说出来', () => {
    assert.equal(keptText, handWritten);
    assert.ok(kept.message.includes('保留原样的 林昭'), kept.message);
  });

  test('撞上别名的不另建一张', () => {
    assert.ok(!t.has('.novelforge/characters/阿昭.md'));
  });

  test('新卡带上定位、别名与身份', async () => {
    const shen = cards.find((c) => c.name === '沈青');
    assert.deepEqual(shen?.tags, ['盟友'], JSON.stringify(shen));
    assert.deepEqual(shen?.aliases, ['青姐'], JSON.stringify(shen));
    assert.equal(shen?.sections.身份, '客栈老板娘', JSON.stringify(shen?.sections));
  });

  test('作者同意覆盖：新图谱里有的节换新，空着的节沿用旧卡，别名留着', async () => {
    const lin = cards.find((c) => c.name === '林昭');
    assert.equal(lin.sections.身份, '模型写的林昭');
    assert.equal(lin.sections.性格, '作者写的性格。');
    assert.deepEqual(lin.aliases, ['阿昭']);
    assert.ok(replaced.message.includes('覆盖 林昭'), replaced.message);
  });

  test('第二次不再新建（沈青、韩七已经有卡了），也不多出卡', () => {
    assert.ok(!replaced.message.includes('新建'), replaced.message);
    assert.equal(cards.length, 3, cards.map((c) => c.name).join('、'));
    assert.equal(again, 1);
  });

  test('有卡就算角色图谱填过了', async () => {
    assert.equal((await project.settingFilled()).characters, true);
  });
});

/**
 * 拆细纲给下一章找的落点是**纯序号的占位路径**（`plots/012.md`）：标题要等细纲
 * 出来才定得下来。采纳时按章号与产物带的标题新建。
 */
describe('采纳 · 细纲（新建：落点是占位路径）', () => {
  const placeholder = { kind: 'plot', plotRelPath: '.novelforge/plots/012.md' };
  const REL = '.novelforge/plots/012-夜入青云.md';
  let result;
  let confirms;
  let plot;
  let pipe;

  before(async () => {
    h.expect();
    result = await accept(placeholder, {
      kind: 'plot',
      title: '夜入青云',
      role: '小高潮',
      characters: ['林昭', '沈青'],
      targetWords: 3000,
      sections: { ...SECTIONS },
    });
    confirms = h.confirms.length;
    plot = await project.readPlot(REL);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot });
  });

  // 文件名里的标题等这一刻才定得下来，所以落点不是 target 上那个占位路径。
  test('按章号与产物的标题落盘', () => {
    assert.equal(result.relPath, REL, result.message);
  });

  test('占位路径没有被当成文件名', () => {
    assert.ok(!t.has(placeholder.plotRelPath));
  });

  test('消息说的是新建', () => {
    assert.ok(result.message.includes('已新建'), result.message);
  });

  test('新建不弹审阅', () => {
    assert.equal(confirms, 0);
  });

  test('规划字段都落进 frontmatter', () => {
    assert.equal(plot.role, '小高潮');
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
    assert.equal(plot.targetWords, 3000);
  });

  // 上游是大纲里**覆盖本章那一节**：改第 21–40 章那一节不该让这一章挂 ⟳。
  test('记下大纲里覆盖本章那一节的指纹', async () => {
    assert.equal(plot.upstreamHash, bundle.outlineFile.outlineUpstreamHash(await project.readOutline(), 12));
  });

  test('H1 是「第N章 标题」', () => {
    assert.ok(t.read(REL).includes('# 第12章 夜入青云'), t.read(REL).slice(0, 300));
  });

  test('写完就算排过细纲', () => {
    assert.ok(plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('这一章的下一步是写正文', () => {
    assert.equal(pipe.stage, 'manuscript', pipe.stage);
  });

  // 占位路径（`013.md`）上采纳过一次，文件已经按标题落成 `013-藏书阁.md`。再按同一个
  // 占位路径采纳，acceptPlot 要按章号认出那一份、走覆盖审阅——从前它认成「还没有」，
  // 走新建那条路，writePlot 把同号那份**不经审阅**顶掉（第 3 条）。
  // 用第 13 章演示，免得后面几组要用的第 12 章被改掉。
  test(
    '同号已有细纲时，按占位路径再采纳一次也要先问覆盖',
    async () => {
      await accept({ kind: 'plot', plotRelPath: '.novelforge/plots/013.md' }, {
        kind: 'plot', title: '藏书阁', sections: { ...SECTIONS, 关键事件: '第一版。' },
      });
      h.expect(); // 不排答案：真弹了审阅就当取消
      const second = await accept({ kind: 'plot', plotRelPath: '.novelforge/plots/013.md' }, {
        kind: 'plot', title: '藏书阁', sections: { ...SECTIONS, 关键事件: '第二版。' },
      });
      assert.equal(h.confirms.length, 1, `弹了 ${h.confirms.length} 次审阅：${second.message}`);
      assert.ok(t.read('.novelforge/plots/013-藏书阁.md').includes('第一版'), '第一版被静默覆盖了');
    }
  );
});

describe('采纳 · 细纲（覆盖要审阅）', () => {
  const target = { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' };
  const next = {
    ...SECTIONS,
    关键事件: '改成三拍：踩点、被狗惊动、翻墙；收在藏书阁门口。',
  };
  let kept;
  let afterKept;
  let written;
  let plot;
  let same;
  let sameConfirms;

  before(async () => {
    // 已有内容且不同 → 必须问。答「保留原样」就不能写。
    h.expect('保留原样');
    kept = await accept(target, { kind: 'plot', sections: next });
    afterKept = t.read(target.plotRelPath);

    // 产物带的标题与目标字数都与磁盘不同：「重写细纲」改的是这一章怎么走，
    // 不该顺手把作者起的名字、定的字数抹掉。结构功能是规划的一部分，跟着换。
    h.expect('覆盖');
    written = await accept(target, { kind: 'plot', title: '别的名字', role: '转折', targetWords: 5000, sections: next });
    plot = await project.readPlot(target.plotRelPath);

    // 一字未变时不该弹框——弹了只会让人以为自己点错了。
    h.expect();
    same = await accept(target, { kind: 'plot', sections: next });
    sameConfirms = h.confirms.length;
  });

  test('拒绝覆盖时不写盘', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('拒绝后磁盘上还是旧的', () => {
    assert.ok(!afterKept.includes('改成三拍'), afterKept);
  });

  test('确认后才写', () => {
    assert.equal(written.relPath, target.plotRelPath, written.message);
    assert.ok(t.read(target.plotRelPath).includes('改成三拍'));
  });

  test('标题沿用磁盘那份（文件名不变）', () => {
    assert.equal(plot.title, '夜入青云');
    assert.ok(!t.has('.novelforge/plots/012-别的名字.md'));
  });

  test('目标字数沿用磁盘那份', () => {
    assert.equal(plot.targetWords, 3000);
  });

  test('结构功能随产物更新', () => {
    assert.equal(plot.role, '转折');
  });

  test('没给出场人物时沿用磁盘那份', () => {
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
  });

  test('内容相同不弹框直接通过', () => {
    assert.notEqual(same.skipped, true, same.message);
    assert.equal(sameConfirms, 0);
  });

  // 落定走的是同一条落盘路（`acceptPlot`），只是上游那次调用的提示词不同。
  test('落定产出的细纲走同一条落盘路', async () => {
    h.expect('覆盖');
    const r = await accept(target, { kind: 'plot', sections: { ...next, 章末钩子: '讨论里定下的：灯灭了' } });
    assert.equal(r.relPath, target.plotRelPath, r.message);
    assert.ok(t.read(target.plotRelPath).includes('讨论里定下的'));
  });
});

/**
 * 正文落在**同号的章节**上：没有就新建 `chapters/NNN-<细纲标题>.md`；有了按写法落——
 * 「接着写」追加、其余覆盖（写入前审阅）。落盘之后在细纲上记 `writtenFrom`——少了这一步，
 * 这一章会永远显示（或永远不显示）「正文与细纲对不上」。
 */
describe('采纳 · 正文（落到同号章节）', () => {
  const plotRelPath = '.novelforge/plots/012-夜入青云.md';
  const CHAPTER = 'chapters/012-夜入青云.md';
  const target = { kind: 'manuscript', plotRelPath };
  let result;
  let confirms;
  let plot;
  let entry;
  let pipe;

  before(async () => {
    h.expect();
    result = await accept(target, { kind: 'manuscript', text: '雨下了三天，青云宗的石阶泡得发白。' });
    confirms = h.confirms.length;
    plot = await project.readPlot(plotRelPath);
    entry = (await project.readManifest()).chapters.find((c) => c.order === 12);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot });
  });

  test('正文落在同号的章节上', () => {
    assert.equal(result.relPath, CHAPTER, result.message);
  });

  test('正文确实写进去了', () => {
    assert.ok(t.read(CHAPTER).includes('石阶泡得发白'));
  });

  // H1 用的是清洗后的标题，与文件名词干一致——改名时 `renamedBody` 才认得出
  // 「这个 H1 是跟着文件名走的」。
  test('新建的章节带标题行', () => {
    assert.ok(t.read(CHAPTER).startsWith('# 夜入青云'), t.read(CHAPTER).slice(0, 40));
  });

  test('新建章节不弹审阅', () => {
    assert.equal(confirms, 0);
  });

  test('细纲上记下 writtenFrom = 细纲的内容指纹', () => {
    assert.equal(plot.writtenFrom, bundle.pipe.plotContentHash(plot));
  });

  // 章节是作者的文件：正文那一环的指纹记在细纲这一侧，章节里一笔都不记。
  test('章节里不记任何指纹', () => {
    assert.ok(!/writtenFrom|upstreamHash/.test(t.read(CHAPTER)), t.read(CHAPTER));
  });

  test('章节进了 manifest', () => {
    assert.equal(entry?.file, CHAPTER, JSON.stringify(entry));
  });

  test('刚写完的正文不标脏', () => {
    assert.equal(pipe.chapter.upstreamStale, false);
  });

  // 细纲定了 3000 字，写了十几个字——没写够就留在「待写正文」（接着写）。
  test('没写够目标字数时停在待写正文', () => {
    assert.equal(pipe.stage, 'manuscript', pipe.stage);
    assert.ok(pipe.progress.manuscript < 1, String(pipe.progress.manuscript));
  });

  describe('接着写一次', () => {
    let second;
    let text;
    let chapterCount;
    let confirmsAgain;

    before(async () => {
      h.expect();
      second = await accept(target, { kind: 'manuscript', text: '他数到第三盏灯才动。' }, { writeMode: 'continue' });
      confirmsAgain = h.confirms.length;
      text = t.read(CHAPTER);
      chapterCount = (await project.listChapters()).length;
    });

    // 「接着写」不该丢掉前面那几千字——所以是追加不是覆盖。
    test('追加在同一章末尾，不覆盖前一次', () => {
      assert.equal(second.relPath, CHAPTER, second.message);
      assert.ok(text.includes('石阶泡得发白') && text.includes('第三盏灯'), text);
    });

    // 从前两次追加之间插一行 `---` 当拆章的候选断点；拆章删了，现在只空一行。
    test('两次之间只空一行，不插分隔线', () => {
      assert.ok(text.includes('泡得发白。\n\n他数到'), JSON.stringify(text));
      assert.ok(!/^\s*-{3,}\s*$/m.test(text), text);
    });

    test('没有另建一章', () => {
      assert.equal(chapterCount, 1, String(chapterCount));
    });

    // 追加是唯一不走覆盖审阅的落盘路径——它不覆盖任何东西。
    test('追加不弹审阅', () => {
      assert.equal(confirmsAgain, 0);
    });
  });

  describe('细纲改过 → 正文标脏 → 重写后记新的指纹', () => {
    let stale;
    let declined;
    let stillStale;
    let rewritten;
    let fresh;
    let text;
    let asked;

    before(async () => {
      h.expect('覆盖');
      await accept({ kind: 'plot', plotRelPath }, {
        kind: 'plot', sections: { ...SECTIONS, 关键事件: '整章推倒：他没翻墙，是被人从正门请进去的。' },
      });
      stale = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });

      // 第一次作者在审阅里选「保留原样」：什么都不改，也不记指纹。
      h.expect('保留原样');
      declined = await accept(target, { kind: 'manuscript', text: '门开了，有人请他进去。' }, { writeMode: 'rewrite' });
      stillStale = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });

      h.expect('覆盖');
      rewritten = await accept(target, { kind: 'manuscript', text: '门开了，有人请他进去。' }, { writeMode: 'rewrite' });
      asked = h.confirms.length;
      text = t.read(CHAPTER);
      fresh = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });
    });

    // 重写细纲的那一步不许抹掉 writtenFrom：它对不上，正是「细纲在正文之后改过」的信号。
    test('细纲改后正文标脏', () => {
      assert.equal(stale.chapter.upstreamStale, true, JSON.stringify(stale.chapter));
    });

    // 第 3 条：重写吞掉的是一整章，写入前必须先问。
    test('重写覆盖前先问；保留原样就一个字不改、也不记指纹', () => {
      assert.equal(declined.skipped, true, declined.message);
      assert.equal(stillStale.chapter.upstreamStale, true);
    });

    test('答了覆盖：整章换成新写的，旧的不留', () => {
      assert.equal(asked, 1);
      assert.equal(rewritten.relPath, CHAPTER, rewritten.message);
      assert.ok(text.includes('门开了') && !text.includes('石阶泡得发白'), text);
    });

    // 标题行是作者起的名字，模型写的正文里没有它。
    test('标题行沿用原文件', () => {
      assert.ok(text.startsWith('# 夜入青云\n\n门开了'), JSON.stringify(text.slice(0, 30)));
    });

    test('照着新细纲写过之后不再标脏', () => {
      assert.equal(fresh.chapter.upstreamStale, false, JSON.stringify(fresh.chapter));
    });
  });
});

/**
 * 老工程里只有正文、没有细纲的章：target 上的细纲路径是它**应该**在的位置
 * （`plotPathForNo`），文件并不存在。正文照样落到那一章上，不凭空造细纲。
 */
describe('采纳 · 正文（只有正文、没有细纲的老章）', () => {
  const CHAPTER = 'chapters/020-旧章.md';
  let result;
  let plotPath;
  let unmarked;
  let asked;

  before(async () => {
    t.write(CHAPTER, '# 旧章\n\n作者早就写好的。\n');
    project.invalidate();
    plotPath = project.plotPathForNo(20, '旧章');
    result = await accept({ kind: 'manuscript', plotRelPath: plotPath }, { kind: 'manuscript', text: '接着往下写的一段。' }, { writeMode: 'continue' });
    // 老会话里的 Draft 没记写法：宁可多问一句，也不把一整章叠到已有的后面。
    h.expect('保留原样');
    unmarked = await accept({ kind: 'manuscript', plotRelPath: plotPath }, { kind: 'manuscript', text: '另起的一整章。' });
    asked = h.confirms.length;
  });

  test('接着写：追加到那一章上', () => {
    assert.equal(result.relPath, CHAPTER, result.message);
    const text = t.read(CHAPTER);
    assert.ok(text.includes('作者早就写好的') && text.includes('接着往下写'), text);
  });

  test('没记写法：按覆盖审阅，先问', () => {
    assert.equal(asked, 1);
    assert.equal(unmarked.skipped, true);
    assert.ok(!t.read(CHAPTER).includes('另起的一整章'));
  });

  test('不凭空造出一份细纲', () => {
    assert.ok(!t.has(plotPath), plotPath);
  });
});

describe('采纳 · 大纲整篇替换', () => {
  let kept;
  let result;
  let outline;

  before(async () => {
    h.expect('保留原样');
    kept = await accept({ kind: 'outline' }, { kind: 'outlineDoc', text: '## 第1–20章：入局\n\n不该写进去' });
    h.expect('覆盖');
    result = await accept(
      { kind: 'outline' },
      { kind: 'outlineDoc', text: '## 第1–20章：第一幕 · 入局\n\n- 林昭进宗门' }
    );
    outline = await project.readOutline();
  });

  test('拒绝覆盖时不写盘', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('大纲写回 outline.md', () => {
    assert.ok(result.relPath.endsWith('outline.md'), result.message);
  });

  test('大纲内容已换', () => {
    assert.ok(outline.includes('林昭进宗门') && !outline.includes('不该写进去'), outline);
  });
});

describe('采纳 · 认不出是哪一章时报错而不是乱写', () => {
  let plotMessage = '';
  let manuscriptMessage = '';

  before(async () => {
    try {
      await accept({ kind: 'plot', plotRelPath: '.novelforge/plots/没有章号.md' }, { kind: 'plot', sections: SECTIONS });
    } catch (err) {
      plotMessage = String(err.message ?? err);
    }
    try {
      await accept({ kind: 'manuscript', plotRelPath: '.novelforge/plots/没有章号.md' }, { kind: 'manuscript', text: 'x' });
    } catch (err) {
      manuscriptMessage = String(err.message ?? err);
    }
  });

  test('细纲认不出章号时抛错', () => {
    assert.ok(plotMessage.includes('认不出这份细纲的章号'), plotMessage);
  });

  test('正文认不出章号时抛错', () => {
    assert.ok(manuscriptMessage.includes('认不出这份细纲的章号'), manuscriptMessage);
  });

  test('没有凭空造出细纲或章节', () => {
    assert.ok(!t.has('.novelforge/plots/没有章号.md'));
    assert.ok(!t.has('chapters/没有章号.md'));
  });

  // 细纲与同号章节都不存在时：作者（或 agent 给了 `chapters/999.md`）明确要写这一章的
  // 正文，那就按号新建一个没有标题的章节——不拿路径里的词干当标题（那不是作者起的），
  // 也不凭空造一份细纲；没有细纲，writtenFrom 就无处可记，这一章永不标脏（第 18a 条）。
  test('细纲与同号章节都不存在时，按号新建章节、不造细纲', async () => {
    await accept({ kind: 'manuscript', plotRelPath: '.novelforge/plots/999-不存在.md' }, { kind: 'manuscript', text: '雨停了。' });
    assert.ok(t.has('chapters/999.md'), '没有按号新建章节');
    assert.ok(t.read('chapters/999.md').includes('雨停了。'));
    assert.ok(!t.has('.novelforge/plots/999-不存在.md') && !t.has('.novelforge/plots/999.md'), '凭空造了细纲');
  });
});
