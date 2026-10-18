/**
 * 内置编辑器怎么称呼一份文件（`views/editorLabel.ts`）：标签上的类型短标记与名字、工具栏上的面包屑。
 * 规则只在后端（`kindOfPath` 与章节 / 细纲的文件名规则），前端不拿路径猜——与 `kind`、`draftPath` 同一条原则。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 同一章的正文 / 细纲 / 草稿三份短标记各不相同、名字一样 | 从前三个标签都只写「003-夜访.md」 |
 * | 面包屑写「第 3 章 夜访」，分卷目录各占一段且可点 | 原始路径 `.novelforge/summaries/…` 看不懂 |
 * | 架构几件、大纲、文风是中文称呼 | `config.md` 在标签上叫 config 等于没说 |
 * | 认不出的文件扩展名留着 | `project.json` 去掉扩展名就认不出了 |
 * | 越界、空串不抛 | 输入是前端传上来的路径 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let t;
let describeFile;

before(async () => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    label: './src/core/views/editorLabel.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'edlabel' });
  describeFile = (rel) => bundle.label.describeEditorFile(t.project, rel);
});

after(() => {
  if (t) cleanup(t.dir);
});

/** 面包屑写成一行字，目录段后面标 `[dir]`。 */
const crumbs = (rel) =>
  describeFile(rel)
    .crumbs.map((c) => (c.dir !== undefined ? `${c.label}[${c.dir}]` : c.label))
    .join(' › ');

describe('editorLabel · 正文 / 细纲 / 草稿', () => {
  test('正文不带短标记，名字去掉扩展名', () => {
    const l = describeFile('chapters/003-夜访.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: '003-夜访' });
  });

  test('正文的面包屑：正文 › 第 3 章 夜访', () => {
    assert.equal(crumbs('chapters/003-夜访.md'), '正文[chapters] › 第 3 章 夜访');
  });

  test('分卷目录里的正文：卷目录各占一段、可点', () => {
    assert.equal(crumbs('chapters/第一卷/003-夜访.txt'), '正文[chapters] › 第一卷[chapters/第一卷] › 第 3 章 夜访');
    assert.equal(describeFile('chapters/第一卷/003-夜访.txt').title, '003-夜访');
  });

  test('细纲带「细纲」，面包屑从细纲根起、卷目录照样一段', () => {
    const l = describeFile('.novelforge/summaries/第一卷/003-夜访.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '细纲', title: '003-夜访' });
    assert.equal(
      crumbs('.novelforge/summaries/第一卷/003-夜访.md'),
      '细纲[.novelforge/summaries] › 第一卷[.novelforge/summaries/第一卷] › 第 3 章 夜访'
    );
  });

  test('草稿带「草稿」，面包屑同样写第几章', () => {
    const l = describeFile('drafts/003-夜访.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '草稿', title: '003-夜访' });
    assert.equal(crumbs('drafts/003-夜访.md'), '草稿[drafts] › 第 3 章 夜访');
  });

  test('同一章的三份：名字一样、短标记各不相同', () => {
    const tags = ['chapters/003-夜访.md', '.novelforge/summaries/003-夜访.md', 'drafts/003-夜访.md'].map(
      (p) => describeFile(p).tag
    );
    assert.equal(new Set(tags).size, 3, JSON.stringify(tags));
  });

  test('文件名里没有标题：面包屑写「第 N 章」', () => {
    assert.equal(crumbs('chapters/007.md'), '正文[chapters] › 第 7 章');
  });

  test('没有扩展名的章节照样认', () => {
    assert.equal(describeFile('chapters/012-雪夜').title, '012-雪夜');
    assert.equal(crumbs('chapters/012-雪夜'), '正文[chapters] › 第 12 章 雪夜');
  });
});

describe('editorLabel · 角色与设定', () => {
  test('角色卡：角色 › 林晚', () => {
    const l = describeFile('.novelforge/characters/林晚.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '角色', title: '林晚' });
    assert.equal(crumbs('.novelforge/characters/林晚.md'), '角色[.novelforge/characters] › 林晚');
  });

  test('子目录里的角色卡：子目录一段', () => {
    assert.equal(
      crumbs('.novelforge/characters/配角/李叔.md'),
      '角色[.novelforge/characters] › 配角[.novelforge/characters/配角] › 李叔'
    );
  });

  test('设定条目：设定 › 地点 › 青石镇', () => {
    const l = describeFile('.novelforge/lore/地点/青石镇.md');
    assert.equal(l.tag, '设定');
    assert.equal(crumbs('.novelforge/lore/地点/青石镇.md'), '设定[.novelforge/lore] › 地点[.novelforge/lore/地点] › 青石镇');
  });
});

describe('editorLabel · 有中文称呼的固定文件', () => {
  test('小说配置：标签上是中文称呼、不带短标记，面包屑归在故事架构', () => {
    const l = describeFile('.novelforge/config.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: '小说配置' });
    assert.equal(crumbs('.novelforge/config.md'), '故事架构[.novelforge] › 小说配置');
  });

  test('故事前提、世界观、情节大纲', () => {
    assert.equal(describeFile('.novelforge/premise.md').title, '故事前提');
    assert.equal(describeFile('.novelforge/world.md').title, '世界观');
    assert.equal(crumbs('.novelforge/outline.md'), '故事架构[.novelforge] › 情节大纲');
  });

  test('文风指南、全书摘要、叙事线归在文风与摘要（与工程页、「转到…」同一个叫法）', () => {
    assert.equal(describeFile('.novelforge/style.md').title, '文风指南');
    assert.equal(describeFile('.novelforge/summaries/global.md').title, '全书摘要');
    assert.equal(crumbs('.novelforge/threads.md'), '文风与摘要[.novelforge] › 叙事线');
  });
});

describe('editorLabel · 其他文件', () => {
  test('写作技能：SKILL.md 叫技能目录的名字', () => {
    const l = describeFile('.novelforge/skills/快节奏/SKILL.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '技能', title: '快节奏' });
  });

  test('认不出的文件：原文件名、扩展名留着、目录一段一段', () => {
    const l = describeFile('.novelforge/project.json');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: 'project.json' });
    assert.equal(crumbs('.novelforge/project.json'), '.novelforge[.novelforge] › project.json');
  });

  test('工程根下的随手文件只有一段', () => {
    assert.equal(crumbs('notes.txt'), 'notes.txt');
  });

  test('越界、空串不抛', () => {
    assert.doesNotThrow(() => describeFile('../外面.md'));
    assert.doesNotThrow(() => describeFile(''));
  });
});
