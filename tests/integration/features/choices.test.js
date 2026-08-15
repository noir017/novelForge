/**
 * 「让用户挑一个」的清单构造（`src/core/choices.ts`）。
 *
 * 这两份清单原先长在插件壳的 extension.ts 里，其中「＋N 章待读」是算出来的：
 * 出场章（由摘要关联）里章号大于卡上 `updatedThrough` 的有几章。壳里抄一份这种
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

/** 一章：细纲 + 成品正文 + 一份带 cast 的摘要。 */
function makePlot(no, title, text, cast) {
  const n = String(no).padStart(3, '0');
  const stem = `${n}-${title}`;
  t.write(`.novelforge/plots/${stem}.md`, `## 目标\n\n略。\n\n## 剧情脉络\n\n甲乙丙。\n`);
  t.write(`chapters/${stem}.md`, `# ${title}\n\n${text}\n`);
  t.write(
    `.novelforge/summaries/${stem}.md`,
    `---\nchapter: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
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

  makePlot(1, '楔子', '雨下了三天。', ['林昭']);
  makePlot(2, '夜访', '门被敲响了两次又停住。', ['林昭', '沈砚']);
  // 手写文件绕过了所有写入口，缓存要显式作废。
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('plotChoices', () => {
  let list;
  before(async () => {
    list = await choices.plotChoices(t.project);
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

  test('说明是正文字数', () => {
    assert.match(list[0].description, /^\d+ 字$/);
  });

  // 只排了剧情、还没写正文的段照样要列出来——那正是作者接下来要写的那些。
  test('没写正文的段说「还没有正文」', async () => {
    t.write('.novelforge/plots/003-空的.md', '## 目标\n\n略。\n\n## 剧情脉络\n\n丁。\n');
    t.project.invalidate();
    const withEmpty = await choices.plotChoices(t.project);
    assert.equal(withEmpty.find((c) => c.value === 3).description, '还没有正文');
  });

  test('空工程给空清单，不抛（「还没有章」由调用方说）', async () => {
    const empty = await makeTempProject(loadBundle({ project: './src/core/model/project.ts' }).project, {
      prefix: 'choices-empty',
    });
    try {
      assert.deepEqual(await choices.plotChoices(empty.project), []);
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
    // 从没更新过（无 updatedThrough）也不该凭空催人——出场 0 段就是待读 0 段。
    makeCard('无名', undefined);
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    const anon = list.find((c) => c.label === '无名');
    assert.equal(anon.description, undefined);
    assert.equal(anon.detail, '未在摘要中出现');
  });

  test('detail 是出场章的人话描述', async () => {
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
