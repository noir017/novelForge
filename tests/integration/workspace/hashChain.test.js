/**
 * 指纹链的记账**下沉到写入路径本身**。
 *
 * 这是本期唯一有意的行为变化：`upstreamHash` / `beatsHash` 从前只在
 * `features/creation.ts` 的采纳路径上记，作者在内置编辑器里改一份细纲，
 * 指纹链就断了——那一章从此再也不挂 ⟳。现在**谁写都记**。
 *
 * 三条不能碰的既有取舍（AGENTS 第 18 条）也在这里守：
 * - `plotContentHash` 只哈希四个小节，不含 frontmatter
 * - `beatsHashFor` 排除场景的 `status`
 * - 手写的产物永不标脏
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（没抛）';
}

/** 从磁盘上那份细纲/场景的 frontmatter 里抠一个字段。 */
function fm(relPath, key) {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(t.read(relPath));
  return m ? m[1].trim() : undefined;
}

const filled = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  目标: '林昭进入青云宗。',
  剧情脉络: '他在山门外等到天黑，翻过侧峰。',
  ...extra,
});

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    pipe: './src/core/views/pipeline.ts',
    ws: './src/core/workspace/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wshash' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('细纲 · 写入就记 upstreamHash', () => {
  const rel = '.novelforge/plots/012-入宗.md';

  before(async () => {
    await ws.writePlot({
      no: 12,
      title: '入宗',
      arc: '第一幕',
      upstreamHash: bundle.fs.hash(await project.readOutline()),
      done: false,
      sections: filled(),
    });
  });

  test('落在 plots/ 下，名字带三位序号', () => {
    assert.ok(t.has(rel), rel);
  });

  test('frontmatter 里有 upstreamHash', async () => {
    assert.equal(fm(rel, 'upstreamHash'), bundle.fs.hash(await project.readOutline()));
  });

  // **这是修的那个缺陷**：改大纲之后作者在编辑器里改细纲，从前 upstreamHash
  // 不会跟着更新，那一章从此永远挂着一个洗不掉的 ⟳。
  test('改大纲后直接 write 细纲文本，upstreamHash 跟着更新', async () => {
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局（改过）\n');
    project.invalidate();
    const nextOutline = bundle.fs.hash(await project.readOutline());
    assert.notEqual(fm(rel, 'upstreamHash'), nextOutline, '前置：此刻还是旧的');

    const current = t.read(rel);
    await ws.write(rel, { text: current.replace('翻过侧峰', '翻过后山') }, {
      mode: 'overwrite',
      review: false,
    });
    assert.equal(fm(rel, 'upstreamHash'), nextOutline);
  });

  test('正文内容照样写进去了', () => {
    assert.ok(t.read(rel).includes('翻过后山'), t.read(rel));
  });

  // 缺陷修复的核心断言：不经采纳、不经 writePlot，纯 write 一段文本也记账。
  test('edit 定点改一处也记 upstreamHash', async () => {
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局（再改）\n');
    project.invalidate();
    const nextOutline = bundle.fs.hash(await project.readOutline());
    await ws.edit(rel, [{ old: '翻过后山', new: '绕过前山' }]);
    assert.equal(fm(rel, 'upstreamHash'), nextOutline);
  });
});

describe('细纲 · 手写的产物永不标脏（第 18a 条）', () => {
  const rel = '.novelforge/plots/021-手写.md';

  before(async () => {
    // 作者在 vim 里敲出来的细纲：没有 frontmatter，也就没有上游。
    t.write(rel, '## 目标\n\n我自己写的\n\n## 剧情脉络\n\n甲乙丙\n');
    project.invalidate();
    await ws.write(rel, { text: '## 目标\n\n我自己写的\n\n## 剧情脉络\n\n甲乙丙丁\n' }, {
      mode: 'overwrite',
      review: false,
    });
  });

  test('改了内容', () => {
    assert.ok(t.read(rel).includes('甲乙丙丁'), t.read(rel));
  });

  // 拿一个凭空的过期标记去催作者重做，他会学会无视所有标记。
  test('没有 frontmatter 的细纲不会被凭空补上 upstreamHash', () => {
    assert.ok(!t.read(rel).includes('upstreamHash'), t.read(rel));
  });

  test('视图层照样不标脏', async () => {
    const plot = await project.readPlot(rel);
    const p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
    assert.equal(p.plot.upstreamStale, false);
  });

  // writePlot 是**领域写入器**：调用方把整份 frontmatter 都说全了，
  // 包括「这一章没有上游」。newPlotFlow 正是这样建出手工新章的。
  test('writePlot 传空 upstreamHash 时不被补上', async () => {
    const bare = await ws.writePlot({
      no: 22, title: '', arc: '', upstreamHash: '', done: false,
      sections: bundle.plotFile.emptyPlotSections(),
    });
    assert.ok(!t.read(bare).includes('upstreamHash'), t.read(bare));
  });
});

describe('场景 · 写入就记 upstreamHash', () => {
  const plotRel = '.novelforge/plots/012-入宗.md';
  let plotHash;

  before(async () => {
    plotHash = bundle.pipe.plotContentHash(await project.readPlot(plotRel));
    await ws.writeScene(plotRel, {
      plotRelPath: plotRel, no: 1, title: '山门观察', place: '山门', time: '黄昏',
      characters: ['林昭'], upstreamHash: plotHash, status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '他蹲了两个时辰。' },
    });
  });

  test('场景落在按细纲名开的目录里', () => {
    assert.ok(t.has('.novelforge/scenes/012-入宗/01-山门观察.md'));
  });

  test('场景的 upstreamHash 是细纲的内容指纹', () => {
    assert.equal(fm('.novelforge/scenes/012-入宗/01-山门观察.md', 'upstreamHash'), plotHash);
  });

  test('改细纲后直接 write 场景文本，upstreamHash 跟着更新', async () => {
    const p = await project.readPlot(plotRel);
    p.sections.冲突与转折 = '改成三拍';
    await ws.writePlot(p);
    const nextPlotHash = bundle.pipe.plotContentHash(await project.readPlot(plotRel));
    assert.notEqual(nextPlotHash, plotHash, '前置：细纲指纹变了');

    const sceneRel = '.novelforge/scenes/012-入宗/01-山门观察.md';
    await ws.write(sceneRel, { text: t.read(sceneRel).replace('两个时辰', '三个时辰') }, {
      mode: 'overwrite',
      review: false,
    });
    assert.equal(fm(sceneRel, 'upstreamHash'), nextPlotHash);
  });

  // **第 18b 条**：把 frontmatter 算进 plotContentHash，会让「排一次剧情」
  // 立刻使全部场景过期。
  test('plotContentHash 只哈希四个小节，改 frontmatter 不动它', async () => {
    const before = bundle.pipe.plotContentHash(await project.readPlot(plotRel));
    const p = await project.readPlot(plotRel);
    await ws.writePlot({ ...p, targetWords: 4000, arc: '第二幕' });
    assert.equal(bundle.pipe.plotContentHash(await project.readPlot(plotRel)), before);
  });

  // 同上：把这一章标成 done 不该让四个场景一起标脏。
  test('把细纲标 done 不改变它的内容指纹', async () => {
    const before = bundle.pipe.plotContentHash(await project.readPlot(plotRel));
    const p = await project.readPlot(plotRel);
    await ws.writePlot({ ...p, done: true });
    assert.equal(fm(plotRel, 'status'), 'done');
    assert.equal(bundle.pipe.plotContentHash(await project.readPlot(plotRel)), before);
  });

  test('把细纲标 done 之后场景不标脏', async () => {
    const plot = await project.readPlot(plotRel);
    const p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
    assert.ok(p.scenes.every((s) => !s.upstreamStale), JSON.stringify(p.scenes));
  });
});

describe('场景 · 改标题清掉旧文件名', () => {
  const plotRel = '.novelforge/plots/012-入宗.md';

  before(async () => {
    await ws.writeScene(plotRel, {
      plotRelPath: plotRel, no: 2, title: '翻越侧峰', place: '', time: '', characters: [],
      upstreamHash: '', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
    });
    await ws.writeScene(plotRel, {
      plotRelPath: plotRel, no: 2, title: '翻墙', place: '', time: '', characters: [],
      upstreamHash: '', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
    });
  });

  test('新文件名在', () => {
    assert.ok(t.has('.novelforge/scenes/012-入宗/02-翻墙.md'));
  });

  // 不清掉的话同一场以两个文件名并存，一场变两场。
  test('旧文件名没了', () => {
    assert.ok(!t.has('.novelforge/scenes/012-入宗/02-翻越侧峰.md'));
  });

  test('仍然只有两场', async () => {
    assert.equal((await project.listScenes(plotRel)).length, 2);
  });
});

describe('beatsHash · 排除场景的 status（第 18b 条）', () => {
  const plotRel = '.novelforge/plots/012-入宗.md';
  let beatsBefore;
  let afterStatus;

  before(async () => {
    beatsBefore = await project.beatsHashFor(plotRel);
    const s1 = await project.readScene(plotRel, 1);
    // 采纳正文时会把场景标成 written——那一次写入不该让刚写好的正文
    // 立刻显示「上游已变更」。
    await ws.writeScene(plotRel, { ...s1, plotRelPath: plotRel, status: 'written' });
    afterStatus = await project.beatsHashFor(plotRel);
  });

  test('只改 status 不改变 beats 指纹', () => {
    assert.equal(afterStatus, beatsBefore);
  });

  test('改小节才改变 beats 指纹', async () => {
    const s1 = await project.readScene(plotRel, 1);
    s1.sections.动作 = '他蹲了整整一夜。';
    await ws.writeScene(plotRel, { ...s1, plotRelPath: plotRel });
    assert.notEqual(await project.beatsHashFor(plotRel), beatsBefore);
  });
});

describe('细纲改名 · 伴生跟随', () => {
  const from = '.novelforge/plots/012-入宗.md';
  const to = '.novelforge/plots/012-入宗风波.md';

  before(async () => {
    t.write('.novelforge/manuscripts/012-入宗.md', '---\nplot: .novelforge/plots/012-入宗.md\n---\n\n# 第12章 入宗 · 正文\n\n正文若干字。\n');
    // 摘要挂在成品上，删细纲/改细纲名都不该动它。
    t.write('chapters/012-入宗.md', '# 入宗\n\n正文若干字。\n');
    t.write('.novelforge/summaries/012-入宗.md', '---\nchapter: 12\nsourceHash: X\n---\n\n# 摘要\n\n略\n');
    project.invalidate();

    const plot = await project.readPlot(from);
    await ws.writePlot({ ...plot, title: '入宗风波' });
  });

  test('细纲改名成功', () => {
    assert.ok(t.has(to));
  });

  test('旧细纲没了', () => {
    assert.ok(!t.has(from));
  });

  test('场景目录跟着搬', () => {
    assert.ok(t.has('.novelforge/scenes/012-入宗风波/01-山门观察.md'));
  });

  test('旧场景目录没了', () => {
    assert.ok(!t.has('.novelforge/scenes/012-入宗'));
  });

  test('中转站正文跟着搬', () => {
    assert.ok(t.has('.novelforge/manuscripts/012-入宗风波.md'));
  });

  test('旧中转站正文没了', () => {
    assert.ok(!t.has('.novelforge/manuscripts/012-入宗.md'));
  });

  // 摘要挂在 chapters/ 上，跟着章节文件走，不跟细纲。
  test('摘要没被搬走', () => {
    assert.ok(t.has('.novelforge/summaries/012-入宗.md'));
  });

  test('成品没被动', () => {
    assert.ok(t.has('chapters/012-入宗.md'));
  });
});

describe('细纲改名到已存在的目标 · 伴生不动', () => {
  before(async () => {
    // 先造一个占着 `030-占位` 这个名字的场景目录与中转站正文。
    t.write('.novelforge/scenes/030-占位/01-别人的.md', '别人的场景');
    t.write('.novelforge/manuscripts/030-占位.md', '别人的正文');
    await ws.writePlot({
      no: 30, title: '原名', arc: '', upstreamHash: '', done: false, sections: filled(),
    });
    t.write('.novelforge/manuscripts/030-原名.md', '我的正文');
    project.invalidate();

    const plot = await project.readPlot('.novelforge/plots/030-原名.md');
    await ws.writePlot({ ...plot, title: '占位' });
  });

  test('细纲本身改名了', () => {
    assert.ok(t.has('.novelforge/plots/030-占位.md'));
  });

  // 目标已存在时不动（不静默覆盖）——覆盖会把它的东西吞掉。
  test('目标位置原有的场景没被覆盖', () => {
    assert.equal(t.read('.novelforge/scenes/030-占位/01-别人的.md'), '别人的场景');
  });

  test('目标位置原有的正文没被覆盖', () => {
    assert.equal(t.read('.novelforge/manuscripts/030-占位.md'), '别人的正文');
  });

  test('搬不过去的那份留在原处，不凭空消失', () => {
    assert.equal(t.read('.novelforge/manuscripts/030-原名.md'), '我的正文');
  });
});

describe('删细纲 · 连带场景与中转站，不碰 chapters/ 与摘要', () => {
  const rel = '.novelforge/plots/012-入宗风波.md';
  let deleted;
  let missing;

  before(async () => {
    deleted = await ws.deletePlot(rel);
    missing = await ws.deletePlot(rel);
  });

  test('返回 true', () => {
    assert.equal(deleted, true);
  });

  test('细纲进了回收站', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/plots/012-入宗风波.md'));
  });

  test('场景目录进了回收站', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/scenes/012-入宗风波/01-山门观察.md'));
  });

  test('中转站正文进了回收站', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/manuscripts/012-入宗风波.md'));
  });

  // 那两样描述的是已经发布的成品。删掉细纲只是放弃这一章的规划稿，
  // 不该顺手把作者已经拆出去的正文一起带走。
  test('chapters/ 里的成品没被动', () => {
    assert.ok(t.has('chapters/012-入宗.md'));
  });

  test('摘要没被动', () => {
    assert.ok(t.has('.novelforge/summaries/012-入宗.md'));
  });

  test('删已经删掉的返回 false，不抛', () => {
    assert.equal(missing, false);
  });
});

describe('删场景 · 搬进回收站', () => {
  const plotRel = '.novelforge/plots/030-占位.md';

  before(async () => {
    await ws.writeScene(plotRel, {
      plotRelPath: plotRel, no: 1, title: '待删', place: '', time: '', characters: [],
      upstreamHash: '', status: 'draft', sections: bundle.sceneFile.emptySceneSections(),
    });
  });

  test('删掉返回 true', async () => {
    assert.equal(await ws.deleteScene(plotRel, 1), true);
  });

  test('进了回收站，不真删', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/scenes/030-占位/01-待删.md'));
  });

  test('删不存在的场景返回 false', async () => {
    assert.equal(await ws.deleteScene(plotRel, 9), false);
  });
});

describe('细纲 / 场景照样过八条守卫', () => {
  test('往越界路径写细纲被拒', async () => {
    assert.equal(await codeOf(() => ws.write('../plots/001.md', { text: 'x' })), 'outOfRoot');
  });

  test('细纲的乐观锁照常生效', async () => {
    const rel = '.novelforge/plots/030-占位.md';
    assert.equal(
      await codeOf(() => ws.write(rel, { text: 'x' }, { mode: 'overwrite', baseHash: '旧的' })),
      'conflict'
    );
  });

  test('细纲的覆盖审阅照常生效', async () => {
    const rel = '.novelforge/plots/030-占位.md';
    const before = t.read(rel);
    h.expect('保留原样');
    const r = await ws.write(rel, { text: '不该写进去' }, { mode: 'overwrite' });
    assert.equal(r.skipped, true);
    assert.equal(t.read(rel), before);
  });
});
