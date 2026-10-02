/**
 * 路径 → 种类。**纯函数、零 I/O、绝不抛**——它会被前端传上来的路径调用。
 *
 * 判定逻辑从前散在三处（fileOps 的 sectionOf / isPlotPath、plotFile 的
 * parsePlotFileName、chapterFile 的 parseChapterFileName），各认一半。
 * 这组用例守的是「收成一张表之后口径一字未变」。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let kindOf;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    kind: './src/core/workspace/kind.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'wskind' });
  project = t.project;
  kindOf = (rel) => bundle.kind.kindOfPath(project, rel);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('kindOfPath · 固定单文件', () => {
  test('outline.md 是大纲', () => {
    assert.equal(kindOf('.novelforge/outline.md').kind, 'outline');
  });

  test('大纲带上创作层', () => {
    assert.equal(kindOf('.novelforge/outline.md').stage, 'outline');
  });

  test('大纲带上创作目标', () => {
    assert.deepEqual(kindOf('.novelforge/outline.md').target, { kind: 'outline' });
  });

  test('style.md 是文风指南', () => {
    assert.equal(kindOf('.novelforge/style.md').kind, 'style');
  });

  // 它就躺在 summaries/ 里，必须排在单章摘要之前判，否则会被当成第 0 章的摘要。
  test('summaries/global.md 是全书摘要而不是某一章的摘要', () => {
    assert.equal(kindOf('.novelforge/summaries/global.md').kind, 'globalSummary');
  });

  // 叙事线（七期）：与全书摘要同类，没有创作阶段，也不是哪一层的生成目标。
  test('threads.md 是叙事线，不带创作层与目标', () => {
    const k = kindOf('.novelforge/threads.md');
    assert.equal(k.kind, 'threads');
    assert.equal(k.stage, undefined);
    assert.equal(k.target, undefined);
  });

  // 写作技能：阶段绑定与本工程的技能目录，都在链外，没有创作阶段。
  test('skills.json 与 skills/ 下的文件是技能，不带创作层与目标', () => {
    const kinds = ['.novelforge/skills.json', '.novelforge/skills/去AI味/SKILL.md', '.novelforge/skills'].map(kindOf);
    assert.deepEqual(
      kinds.map((k) => [k.kind, k.stage, k.target]),
      [
        ['skill', undefined, undefined],
        ['skill', undefined, undefined],
        ['skill', undefined, undefined],
      ]
    );
  });

  // 架构三件与大纲同级：各自是一份固定文件，带着「是哪一件」。
  for (const doc of ['config', 'premise', 'world']) {
    test(`${doc}.md 是架构文档，带上 doc 与创作目标`, () => {
      const k = kindOf(`.novelforge/${doc}.md`);
      assert.equal(k.kind, 'setting');
      assert.equal(k.doc, doc);
      assert.equal(k.stage, 'setting');
      assert.deepEqual(k.target, { kind: 'setting', doc });
    });
  }
});

describe('kindOfPath · 细纲', () => {
  test('带标题的细纲', () => {
    assert.equal(kindOf('.novelforge/plots/012-入宗.md').kind, 'plot');
  });

  test('细纲带上章号', () => {
    assert.equal(kindOf('.novelforge/plots/012-入宗.md').no, 12);
  });

  test('细纲的创作层是 plot', () => {
    assert.equal(kindOf('.novelforge/plots/012-入宗.md').stage, 'plot');
  });

  test('细纲的创作目标指回自己', () => {
    assert.deepEqual(kindOf('.novelforge/plots/012-入宗.md').target, {
      kind: 'plot',
      plotRelPath: '.novelforge/plots/012-入宗.md',
    });
  });

  // 流水线新建出来的章就是纯序号名——标题要等剧情排完才定。
  test('纯序号名的细纲一样认得出', () => {
    assert.equal(kindOf('.novelforge/plots/012.md').kind, 'plot');
  });

  test('纯序号名的细纲章号仍是 12', () => {
    assert.equal(kindOf('.novelforge/plots/012.md').no, 12);
  });

  // 细纲只认 markdown 家族（它是插件自己的数据格式，与「章节不认扩展名」相反）。
  test('plots/ 下的 .txt 不是细纲', () => {
    assert.equal(kindOf('.novelforge/plots/012-入宗.txt').kind, 'other');
  });

  // 细纲是平铺的（一章一纲）。老工程按卷分的子目录里那些四节细纲不再是这条链上的
  // 东西——判成 other，但 rel 照给：文件确实在那儿，只是不再是产物。
  test('plots/ 下按卷分的子目录里的文件不是细纲', () => {
    const k = kindOf('.novelforge/plots/01-觉醒之日/003-楼道.md');
    assert.equal(k.kind, 'other');
    assert.equal(k.rel, '.novelforge/plots/01-觉醒之日/003-楼道.md');
  });
});

// 场景那一层已经删掉（见 core/model/pipeline.ts 的文件头）。老工程磁盘上那个
// 目录还在、而且是作者的文件——代码里彻底不认它，判成 `other`：工程页不显示、
// 装配器不读、网关按普通文本处理。**判成 other 而不是抛错**，因为它确实存在。
describe('kindOfPath · 老工程留下的 scenes/', () => {
  test('镜像目录下的 .md 不再是产物', () => {
    assert.equal(kindOf('.novelforge/scenes/012-入宗/02-翻越侧峰.md').kind, 'other');
  });

  test('不认它属于哪一层', () => {
    assert.equal(kindOf('.novelforge/scenes/012-入宗/02-翻越侧峰.md').stage, undefined);
  });

  test('也不给它一个创作目标', () => {
    assert.equal(kindOf('.novelforge/scenes/012-入宗/02-翻越侧峰.md').target, undefined);
  });

  // 越界才不给 rel。它没越界，只是不再是产物——`rel` 照给，调用方仍然认得出
  // 这是工程内的一个普通文件。
  test('仍然给出规范化的相对路径', () => {
    assert.equal(
      kindOf('.novelforge/scenes/012-入宗/02-翻越侧峰.md').rel,
      '.novelforge/scenes/012-入宗/02-翻越侧峰.md'
    );
  });
});

// 卷与中转站两层也删了，老工程里那两个目录同 scenes/ 一样：判成 other、不抛。
describe('kindOfPath · 老工程留下的 volumes/ 与 manuscripts/', () => {
  for (const rel of ['.novelforge/volumes/01-觉醒之日.md', '.novelforge/manuscripts/012-入宗.md']) {
    test(`${rel} 是 other、没有创作层`, () => {
      const k = kindOf(rel);
      assert.equal(k.kind, 'other');
      assert.equal(k.stage, undefined);
      assert.equal(k.rel, rel);
    });
  }
});

describe('kindOfPath · 章节（不认扩展名，AGENTS 第 9 条）', () => {
  test('chapters/ 下的 .md 是章节', () => {
    assert.equal(kindOf('chapters/012-入宗.md').kind, 'chapter');
  });

  test('章节带上章号', () => {
    assert.equal(kindOf('chapters/012-入宗.md').no, 12);
  });

  // 第 12 章的细纲在哪要按号去 plots/ 里认，那一步要读盘——这里是纯函数，不给。
  test('章节不带创作目标', () => {
    assert.equal(kindOf('chapters/012-入宗.md').target, undefined);
  });

  test('无扩展名也是章节', () => {
    assert.equal(kindOf('chapters/012-楔子').kind, 'chapter');
  });

  test('无扩展名的章号照样取得到', () => {
    assert.equal(kindOf('chapters/012-楔子').no, 12);
  });

  test('.txt 也是章节', () => {
    assert.equal(kindOf('chapters/第一卷/013-夜访.txt').kind, 'chapter');
  });

  // 层级只是收纳，章号只看文件名前缀（AGENTS 第 8 条）。
  test('分卷子目录里的章号不受层级影响', () => {
    assert.equal(kindOf('chapters/第一卷/013-夜访.txt').no, 13);
  });

  test('二进制黑名单里的扩展名不是章节', () => {
    assert.equal(kindOf('chapters/cover.png').kind, 'other');
  });

  test('没有数字前缀的不是章节', () => {
    assert.equal(kindOf('chapters/说明.md').kind, 'other');
  });
});

describe('kindOfPath · 摘要 / 角色 / 设定 / 草稿', () => {
  test('summaries/ 下是摘要', () => {
    assert.equal(kindOf('.novelforge/summaries/012-入宗.md').kind, 'summary');
  });

  test('摘要带上章号', () => {
    assert.equal(kindOf('.novelforge/summaries/012-入宗.md').no, 12);
  });

  test('characters/ 下是角色卡', () => {
    assert.equal(kindOf('.novelforge/characters/林昭.md').kind, 'character');
  });

  test('lore/ 下是设定条目', () => {
    assert.equal(kindOf('.novelforge/lore/青云宗.md').kind, 'lore');
  });

  // 角色/设定区不跟着章节放宽扩展名，仍然只认 .md。
  test('角色区的 .txt 不是角色卡', () => {
    assert.equal(kindOf('.novelforge/characters/林昭.txt').kind, 'other');
  });

  test('drafts/ 下是草稿', () => {
    assert.equal(kindOf('drafts/012-入宗.md').kind, 'draft');
  });
});

describe('kindOfPath · 越界一律 other 且不抛', () => {
  const bad = ['../etc/passwd', '/abs/path', 'C:\\Windows', '', '   ', '..'];

  for (const input of bad) {
    test(`${JSON.stringify(input)} 的种类是 other`, () => {
      assert.equal(kindOf(input).kind, 'other');
    });

    test(`${JSON.stringify(input)} 的 rel 是 undefined`, () => {
      assert.equal(kindOf(input).rel, undefined);
    });
  }

  test('null / undefined 也不抛', () => {
    assert.equal(kindOf(undefined).kind, 'other');
    assert.equal(kindOf(null).kind, 'other');
  });

  test('工程内的普通文件是 other，但有 rel', () => {
    const k = kindOf('随手记.md');
    assert.equal(k.kind, 'other');
    assert.equal(k.rel, '随手记.md');
  });

  // 前端传上来的路径可能带反斜杠，规范化成正斜杠。
  test('反斜杠被规范化成正斜杠', () => {
    assert.equal(kindOf('.novelforge\\plots\\012-入宗.md').kind, 'plot');
  });
});

describe('pathOfTarget · 与 kindOfPath 往返', () => {
  const targets = [
    { kind: 'setting', doc: 'config' },
    { kind: 'setting', doc: 'premise' },
    { kind: 'setting', doc: 'world' },
    { kind: 'outline' },
    { kind: 'plot', plotRelPath: '.novelforge/plots/012-入宗.md' },
  ];

  for (const target of targets) {
    test(`${JSON.stringify(target)} 的落点能反解回同一个目标`, () => {
      const rel = bundle.kind.pathOfTarget(project, target);
      assert.deepEqual(kindOf(rel).target, target, rel);
    });
  }

  test('大纲的落点就是 outline.md', () => {
    assert.equal(bundle.kind.pathOfTarget(project, { kind: 'outline' }), '.novelforge/outline.md');
  });

  test('细纲的落点就是它自己', () => {
    assert.equal(
      bundle.kind.pathOfTarget(project, { kind: 'plot', plotRelPath: '.novelforge/plots/012-入宗.md' }),
      '.novelforge/plots/012-入宗.md'
    );
  });

  test('角色图谱的落点是角色目录', () => {
    assert.equal(bundle.kind.pathOfTarget(project, { kind: 'setting', doc: 'characters' }), '.novelforge/characters');
  });

  // 正文落在同号的章节上，那一章在不在、叫什么要读盘才知道——纯函数不猜，
  // 抛出来让调用方改用 chapterTargetOf。
  test('正文的落点不在这里算', () => {
    assert.throws(
      () => bundle.kind.pathOfTarget(project, { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-入宗.md' }),
      /chapterTargetOf/
    );
  });
});
