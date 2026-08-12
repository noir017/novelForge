/**
 * 「让用户挑一个」的清单构造（`src/core/choices.ts`）。
 *
 * 这两份清单原先长在插件壳的 extension.ts 里，其中「＋N 章待读」是算出来的：
 * 出场章（由摘要关联）里序号大于卡上 `updatedThrough` 的有几章。壳里抄一份这种
 * 计算，迟早与工程页上的同一行说明分叉，所以它回到了 core，并且有了这份测试。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let choices;
let t;

/** 一章正文 + 一份带 cast 的摘要。 */
function makeChapter(order, title, text, cast) {
  const n = String(order).padStart(3, '0');
  t.write(`chapters/${n}-${title}.md`, `# ${title}\n\n${text}\n`);
  t.write(
    `.novelforge/summaries/${n}-${title}.md`,
    `---\norder: ${order}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# ${title} · 摘要\n\n## 梗概\n\n略。\n`
  );
}

before(async () => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    choices: './src/core/choices.ts',
    project: './src/core/model/project.ts',
  });
  choices = bundle.choices;
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'choices' });

  makeChapter(1, '楔子', '雨下了三天。', ['林昭']);
  makeChapter(2, '夜访', '门被敲响了两次又停住。', ['林昭', '沈砚']);
  // initialize() 之后章节缓存已经是空数组了，手写文件绕过了所有写入口。
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('chapterChoices', () => {
  let list;
  before(async () => {
    list = await choices.chapterChoices(t.project);
  });

  test('每章一条，按章序', () => {
    assert.deepEqual(
      list.map((c) => c.value),
      [1, 2]
    );
  });

  test('序号补零到三位——长篇下拉里才是一列', () => {
    assert.equal(list[0].label, '001 楔子');
  });

  test('说明是字数', () => {
    assert.match(list[0].description, /^\d+ 字$/);
  });

  test('空工程给空清单，不抛（「还没有章节」由调用方说）', async () => {
    const empty = await makeTempProject(loadBundle({ project: './src/core/model/project.ts' }).project, {
      prefix: 'choices-empty',
    });
    try {
      assert.deepEqual(await choices.chapterChoices(empty.project), []);
    } finally {
      cleanup(empty.dir);
    }
  });
});

describe('characterChoices', () => {
  /** 一张卡：读到第 `updatedThrough` 章为止。 */
  function makeCard(name, updatedThrough) {
    t.write(
      `.novelforge/characters/${name}.md`,
      `---\nname: ${name}\naliases: []\ntags: [配角]\n` +
        (updatedThrough === undefined ? '' : `updatedThrough: ${updatedThrough}\n`) +
        `---\n\n# ${name}\n\n## 身份\n\n略。\n`
    );
  }

  test('value 是卡的相对路径（updateCharacterCard 认这个）', async () => {
    makeCard('林昭', 2);
    const list = await choices.characterChoices(t.project);
    const zhao = list.find((c) => c.label === '林昭');
    assert.equal(zhao.value, '.novelforge/characters/林昭.md');
  });

  test('读全了就不挂「待读」', async () => {
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '林昭').description, undefined);
  });

  test('落后几章就挂「＋N 章待读」', async () => {
    makeCard('沈砚', 1); // 出场在第 2 章，只读到第 1 章
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '沈砚').description, '＋1 章待读');
  });

  test('没在任何摘要里出现过的卡：不挂待读，detail 说「未在摘要中出现」', async () => {
    // 从没更新过（无 updatedThrough）也不该凭空催人——出场 0 章就是待读 0 章。
    makeCard('无名', undefined);
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    const anon = list.find((c) => c.label === '无名');
    assert.equal(anon.description, undefined);
    assert.equal(anon.detail, '未在摘要中出现');
  });

  test('detail 是出场章节的人话描述', async () => {
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '林昭').detail, '第 1、2 章');
  });

  test('没有角色卡时给空清单', async () => {
    const empty = await makeTempProject(loadBundle({ project: './src/core/model/project.ts' }).project, {
      prefix: 'choices-nocard',
    });
    try {
      assert.deepEqual(await choices.characterChoices(empty.project), []);
    } finally {
      cleanup(empty.dir);
    }
  });
});
