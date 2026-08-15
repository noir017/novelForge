/**
 * 路径 → 种类。**纯函数、零 I/O、绝不抛**——它会被前端传上来的路径调用。
 *
 * 判定逻辑从前散在四处（fileOps 的 sectionOf / isPlotPath、plotFile 的
 * parsePlotFileName、sceneFile 的 parseSceneFileName、chapterFile 的
 * parseChapterFileName），各认一半。这组用例守的是「收成一张表之后口径一字未变」。
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
});

describe('kindOfPath · 场景', () => {
  const rel = '.novelforge/scenes/012-入宗/02-翻越侧峰.md';

  test('镜像目录下的 .md 是场景', () => {
    assert.equal(kindOf(rel).kind, 'scene');
  });

  test('章号从镜像目录名反推', () => {
    assert.equal(kindOf(rel).no, 12);
  });

  test('场号从文件名前缀取', () => {
    assert.equal(kindOf(rel).sceneNo, 2);
  });

  // 反推靠 plotStem 的逆运算：scenes/012-入宗/ → plots/012-入宗.md。
  test('反推得出所属细纲的路径', () => {
    assert.equal(kindOf(rel).plotRelPath, '.novelforge/plots/012-入宗.md');
  });

  test('场景的创作目标带场号', () => {
    assert.deepEqual(kindOf(rel).target, {
      kind: 'scene',
      plotRelPath: '.novelforge/plots/012-入宗.md',
      sceneNo: 2,
    });
  });

  // 镜像目录里没有数字前缀的文件不是场景（同一条规则：前缀决定顺序）。
  test('场景目录里没有数字前缀的文件不是场景', () => {
    assert.equal(kindOf('.novelforge/scenes/012-入宗/说明.md').kind, 'other');
  });
});

describe('kindOfPath · 中转站正文', () => {
  test('manuscripts/ 下的 .md 是中转站正文', () => {
    assert.equal(kindOf('.novelforge/manuscripts/012-入宗.md').kind, 'manuscript');
  });

  test('中转站正文带上章号', () => {
    assert.equal(kindOf('.novelforge/manuscripts/012-入宗.md').no, 12);
  });

  test('中转站正文反推得出所属细纲', () => {
    assert.equal(
      kindOf('.novelforge/manuscripts/012-入宗.md').plotRelPath,
      '.novelforge/plots/012-入宗.md'
    );
  });

  test('中转站正文的创作层是 manuscript', () => {
    assert.equal(kindOf('.novelforge/manuscripts/012-入宗.md').stage, 'manuscript');
  });
});

describe('kindOfPath · 章节（不认扩展名，AGENTS 第 9 条）', () => {
  test('chapters/ 下的 .md 是章节', () => {
    assert.equal(kindOf('chapters/012-入宗.md').kind, 'chapter');
  });

  test('章节带上章号', () => {
    assert.equal(kindOf('chapters/012-入宗.md').no, 12);
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
    { kind: 'outline' },
    { kind: 'plot', plotRelPath: '.novelforge/plots/012-入宗.md' },
    { kind: 'scene', plotRelPath: '.novelforge/plots/012-入宗.md', sceneNo: 2 },
    { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-入宗.md' },
  ];

  for (const target of targets) {
    test(`${target.kind} 的落点能反解回同一个目标`, () => {
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

  test('正文落在中转站而不是 chapters/', () => {
    assert.equal(
      bundle.kind.pathOfTarget(project, {
        kind: 'manuscript',
        plotRelPath: '.novelforge/plots/012-入宗.md',
      }),
      '.novelforge/manuscripts/012-入宗.md'
    );
  });
});
