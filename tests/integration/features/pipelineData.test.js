/**
 * 创作流水线的数据层：镜像路径、细纲与场景读写、改名跟随、新鲜度链、工作区卡。
 *
 * 生产那一段的轴是**细纲**（`.novelforge/plots/NNN-标题.md`）：场景与中转站正文
 * 都按它的文件名词干镜像。拆分之后一切按章，摘要与草稿挂在 `chapters/` 上——
 * 那一侧的读写另见 tests/integration/files/chapters.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 细纲与场景的写入搬进了 `core/workspace/`：改名要连带搬走场景目录与中转站
 * 正文、写入要记上游指纹、删除要进 `.trash/`，那些是网关的活。`NovelProject`
 * 这一层只留领域查询。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

let bundle;
let h;
let t;
let project;

/** 一份「排过剧情」的小节（剧情脉络非空，isPlotFilled 才认）。 */
const filledSections = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  目标: '林昭成功进入青云宗。',
  剧情脉络: '他在山门外等到天黑，翻过侧峰，被巡逻的人撞见。收在：他站在藏书阁门口。',
  ...extra,
});

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    fileOps: './src/core/files/fileOps.ts',
    pipe: './src/core/views/pipeline.ts',
    workbench: './src/core/views/workbench.ts',
  });
  wsMod = bundle.ws;
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'pipeline',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('数据层 · 目录与镜像路径', () => {
  const plot = '.novelforge/plots/012-夜入青云.md';

  test('初始化建出 plots/', () => {
    assert.ok(t.has('.novelforge/plots'));
  });

  test('初始化建出 scenes/', () => {
    assert.ok(t.has('.novelforge/scenes'));
  });

  test('初始化建出 manuscripts/', () => {
    assert.ok(t.has('.novelforge/manuscripts'));
  });

  // 三套伴生文件的身份都是段文件名的**词干**：改标题会改文件名，
  // 三者必须一起跟着走（见 carryPlotCompanions）。
  test('场景目录按段名开一层', () => {
    assert.equal(project.sceneMirrorRelPath(plot), '.novelforge/scenes/012-夜入青云');
  });

  test('正文与段同名', () => {
    assert.equal(project.manuscriptMirrorRelPath(plot), '.novelforge/manuscripts/012-夜入青云.md');
  });

  // 摘要镜像的是**章节**：`chapters/012-夜入青云.md` → `summaries/012-夜入青云.md`。
  test('摘要与章节同名', () => {
    assert.equal(
      project.summaryMirrorRelPath('chapters/012-夜入青云.md'),
      '.novelforge/summaries/012-夜入青云.md'
    );
  });

  // 细纲不在 chapters/ 之下，问它的摘要路径应当得到 undefined——
  // 那正是 `carrySummary` 判断「搬出发布区了」的依据。
  test('细纲路径问不出摘要镜像', () => {
    assert.equal(project.summaryMirrorRelPath(plot), undefined);
  });

  // 同序号不同文件名的两段各有独立的三套伴生文件——这正是不能用段号当键的理由。
  test('同序号不同文件的正文互不覆盖', () => {
    assert.notEqual(
      project.manuscriptPathForPlot('.novelforge/plots/001-甲.md'),
      project.manuscriptPathForPlot('.novelforge/plots/001-乙.md')
    );
  });

  test('未命名的段（纯序号名）也有伴生路径', () => {
    assert.equal(project.manuscriptMirrorRelPath('.novelforge/plots/007.md'), '.novelforge/manuscripts/007.md');
  });
});

describe('数据层 · 细纲与场景读写', () => {
  let plotRel;
  let noPlot;
  let noScenes;
  let plotBack;
  let listed;
  let nextNo;
  let hadScene02;
  let scenes;
  let sceneTwo;
  let oldFileGone;
  let newFileThere;
  let countAfterRename;
  let deleted3;
  let countAfterDelete;
  let inTrash;
  let deleted9;

  before(async () => {
    noPlot = await project.readPlot('.novelforge/plots/012-夜入青云.md');
    noScenes = await project.listScenes('.novelforge/plots/012-夜入青云.md');
    nextNo = await project.nextPlotNo();

    plotRel = await wsOf(project).writePlot({
      no: 12,
      title: '夜入青云',
      arc: '第一幕',
      targetWords: 3000,
      upstreamHash: 'OUTLINE_A',
      done: false,
      sections: filledSections(),
    });
    plotBack = await project.readPlot(plotRel);
    listed = await project.listPlots();

    for (const [no, title] of [[1, '山门观察'], [2, '翻越侧峰'], [3, '初见沈月']]) {
      await wsOf(project).writeScene(plotRel, {
        plotRelPath: plotRel, no, title, place: '青云宗', time: '子时', characters: ['林昭'],
        upstreamHash: 'PLOT_A', status: 'ready',
        sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲、乙' },
      });
    }
    hadScene02 = t.has('.novelforge/scenes/012-夜入青云/02-翻越侧峰.md');
    scenes = await project.listScenes(plotRel);
    sceneTwo = await project.readScene(plotRel, 2);

    // 改标题会改文件名——旧文件必须删掉，否则一场变两场。
    await wsOf(project).writeScene(plotRel, {
      plotRelPath: plotRel, no: 2, title: '翻墙', place: '', time: '', characters: [],
      upstreamHash: 'PLOT_A', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
    });
    oldFileGone = !t.has('.novelforge/scenes/012-夜入青云/02-翻越侧峰.md');
    newFileThere = t.has('.novelforge/scenes/012-夜入青云/02-翻墙.md');
    countAfterRename = (await project.listScenes(plotRel)).length;

    // 删除是搬进 .trash/，不真删（AGENTS.md 第 6 条）。
    deleted3 = await wsOf(project).deleteScene(plotRel, 3);
    countAfterDelete = (await project.listScenes(plotRel)).length;
    inTrash = t.has('.novelforge/.trash/.novelforge/scenes/012-夜入青云/03-初见沈月.md');
    deleted9 = await wsOf(project).deleteScene(plotRel, 9);
  });

  test('没写过时读不出细纲', () => {
    assert.equal(noPlot, undefined);
  });

  test('没写过时场景列表为空', () => {
    assert.equal(noScenes.length, 0);
  });

  test('空工程的下一段是第 1 段', () => {
    assert.equal(nextNo, 1);
  });

  test('细纲落在 plots/ 下，名字带三位序号', () => {
    assert.equal(plotRel, '.novelforge/plots/012-夜入青云.md', plotRel);
  });

  test('细纲读得回来', () => {
    assert.equal(plotBack.sections.目标, '林昭成功进入青云宗。');
  });

  test('listPlots 列得到它', () => {
    assert.equal(listed.filter((p) => p.no === 12).length, 1, JSON.stringify(listed.map((p) => p.no)));
  });

  test('有第 12 段之后下一段是第 13 段', async () => {
    assert.equal(await project.nextPlotNo(), 13);
  });

  test('场景落在按段名开的目录里', () => {
    assert.ok(hadScene02);
  });

  test('列出三场', () => {
    assert.equal(scenes.length, 3, String(scenes.length));
  });

  test('场景按号排序', () => {
    assert.equal(scenes.map((s) => s.no).join(','), '1,2,3');
  });

  test('按号取单场', () => {
    assert.equal(sceneTwo.title, '翻越侧峰');
  });

  test('改标题后旧文件被删', () => {
    assert.ok(oldFileGone);
  });

  test('改标题后新文件在', () => {
    assert.ok(newFileThere);
  });

  test('改标题后仍是三场', () => {
    assert.equal(countAfterRename, 3);
  });

  test('删掉第 3 场', () => {
    assert.equal(deleted3, true);
  });

  test('删后只剩两场', () => {
    assert.equal(countAfterDelete, 2);
  });

  test('被删的场景进了回收站', () => {
    assert.ok(inTrash);
  });

  test('删不存在的场景返回 false', () => {
    assert.equal(deleted9, false);
  });
});

/**
 * 段改标题 = 改文件名。三套伴生文件（场景目录 / 正文 / 摘要）的身份都是段的
 * 文件名词干，不跟着搬的话，作者会看到「这一段还没拆场景」——而那两个场景就
 * 躺在旁边一个孤儿目录里。
 */
describe('数据层 · 段改名时三套伴生文件跟随', () => {
  const from = '.novelforge/plots/012-夜入青云.md';
  const to = '.novelforge/plots/012-夜入.md';
  let renamed;
  let plotRead;
  let sceneCount;
  let manuscriptText;
  let plotHashBefore;
  let plotHashAfter;
  let beatsBefore;
  let beatsAfter;

  before(async () => {
    // 改名前的两个上游指纹。改名**绝不能**动它们：一旦哪个字段进了哈希，
    // 改个名就会让这一段的下游全部凭空标脏（AGENTS.md 第 18 条 (b)）。
    plotHashBefore = bundle.pipe.plotContentHash(await project.readPlot(from));
    beatsBefore = await project.beatsHashFor(from);
    await wsOf(project).appendToManuscript(from, '正文若干字。');
    // 摘要挂在**成品**上，所以先造一章发布文件再总结它。
    t.write('chapters/012-夜入青云.md', '# 夜入青云\n\n正文若干字。\n');
    project.invalidate();
    await wsOf(project).writeSummary(
      (await project.listChapters()).find((c) => c.order === 12),
      'HASH_X',
      { 梗概: '略', 出场人物: '林昭', 时间地点: '', 关键事件: '', 新增伏笔: '', 状态变更: '' },
      []
    );

    const plot = await project.readPlot(from);
    renamed = await wsOf(project).writePlot({ ...plot, title: '夜入' });

    plotRead = await project.readPlot(to);
    sceneCount = (await project.listScenes(to)).length;
    manuscriptText = (await project.readManuscript(to))?.text ?? '';
    plotHashAfter = bundle.pipe.plotContentHash(plotRead);
    beatsAfter = await project.beatsHashFor(to);
  });

  test('改名成功', () => {
    assert.equal(renamed, to, String(renamed));
  });

  test('旧的段文件不再存在', () => {
    assert.ok(!t.has(from));
  });

  test('场景目录跟着改名', () => {
    assert.ok(t.has('.novelforge/scenes/012-夜入/01-山门观察.md'));
  });

  test('旧场景目录不再存在', () => {
    assert.ok(!t.has('.novelforge/scenes/012-夜入青云'));
  });

  test('正文跟着改名', () => {
    assert.ok(t.has('.novelforge/manuscripts/012-夜入.md'));
  });

  test('旧正文不再存在', () => {
    assert.ok(!t.has('.novelforge/manuscripts/012-夜入青云.md'));
  });

  // 摘要挂在成品上，改细纲的名字动不到它——那是 `carrySummary` 的活。
  test('改细纲的名字不搬摘要', () => {
    assert.ok(t.has('.novelforge/summaries/012-夜入青云.md'));
  });

  test('改名后场景仍读得到', () => {
    assert.equal(sceneCount, 2);
  });

  test('改名后正文仍读得到', () => {
    assert.ok(manuscriptText.includes('正文若干字'), manuscriptText);
  });

  // 这两条是防「改个名把整段标脏」的回归线。
  test('剧情的内容指纹没变', () => {
    assert.equal(plotHashAfter, plotHashBefore);
  });

  test('场景的 beatsHash 没变', () => {
    assert.equal(beatsAfter, beatsBefore);
  });
});

/**
 * 流水线新建那条路的主流程：建出来只有序号（`030.md`），先排剧情，排完了
 * 才给它起名。起名走的是 `writePlot`（标题变→文件名变），不是 fileOps。
 */
describe('数据层 · 给未命名的段起名', () => {
  let bare;
  let named;
  let plotRead;
  let plotText;
  let manuscriptAfter;

  before(async () => {
    bare = await wsOf(project).writePlot({
      no: 30, title: '', arc: '', upstreamHash: '', done: false,
      sections: filledSections({ 目标: '起个名字。' }),
    });
    await wsOf(project).appendToManuscript(bare, '未命名时就写了的正文。');

    const plot = await project.readPlot(bare);
    named = await wsOf(project).writePlot({ ...plot, title: '风起' });
    plotRead = await project.readPlot(named);
    plotText = t.read('.novelforge/plots/030-风起.md');
    manuscriptAfter = (await project.readManuscript(named))?.text ?? '';
  });

  test('未命名时落成纯序号名', () => {
    assert.equal(bare, '.novelforge/plots/030.md', String(bare));
  });

  test('起名后序号前缀保留，后面补分隔符', () => {
    assert.equal(named, '.novelforge/plots/030-风起.md', String(named));
  });

  test('旧的纯序号文件被删掉，不会一段变两段', () => {
    assert.ok(!t.has('.novelforge/plots/030.md'));
  });

  test('title: 换成真标题', () => {
    assert.equal(plotRead.title, '风起', plotRead.title);
  });

  // 标题行说「剧情段」而不是「第 N 章」：一段可以拆成三章，写成「第 30 章」
  // 会在文件里留下一个假承诺。
  test('H1 跟着换成真标题', () => {
    assert.ok(plotText.includes('# 剧情段 30 风起'), plotText.slice(0, 300));
  });

  // 起名前写的正文不能丢——它跟着段名走，起名时必须一起搬。
  test('起名前写的正文跟着过来了', () => {
    assert.ok(manuscriptAfter.includes('未命名时就写了的正文'), manuscriptAfter);
  });
});

describe('新鲜度链', () => {
  const plotRel = '.novelforge/plots/012-夜入.md';
  let pFresh;
  let pOutlineChanged;
  let pScenesFresh;
  let pPlotChanged;
  let beatsBefore;
  let beatsAfterStatus;
  let pManuscriptFresh;
  let pManuscriptStale;

  // buildPlotPipeline 收的是「一章」（章号 + 细纲 + 成品），不再是光秃的细纲。
  const build = async () => {
    const plot = await project.readPlot(plotRel);
    const chapter = (await project.listChapters()).find((c) => c.order === plot.no);
    return bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot, chapter });
  };

  before(async () => {
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局');
    const outlineHash = bundle.fs.hash(await project.readOutline());

    // 细纲记下当时的大纲指纹。
    const plot = await project.readPlot(plotRel);
    await wsOf(project).writePlot({ ...plot, upstreamHash: outlineHash });
    pFresh = await build();

    // 改大纲 → 细纲标脏。零模型调用。
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局（改了）');
    pOutlineChanged = await build();

    // 场景记下当时的剧情指纹。
    const plotHash = bundle.pipe.plotContentHash(await project.readPlot(plotRel));
    for (const no of [1, 2]) {
      await wsOf(project).writeScene(plotRel, {
        plotRelPath: plotRel, no, title: `场景${no}`, place: '', time: '', characters: [],
        upstreamHash: plotHash, status: 'ready',
        sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
      });
    }
    pScenesFresh = await build();

    // 改剧情 → 该段全部场景标脏。
    const p = await project.readPlot(plotRel);
    p.sections.冲突与转折 = '改成三拍';
    await wsOf(project).writePlot(p);
    pPlotChanged = await build();

    // 只改 status 不该让下游标脏——采纳正文时会把场景标 written。
    beatsBefore = await project.beatsHashFor(plotRel);
    await wsOf(project).writeScene(plotRel, {
      ...(await project.readScene(plotRel, 1)), plotRelPath: plotRel, status: 'written',
    });
    beatsAfterStatus = await project.beatsHashFor(plotRel);

    // 写正文 → 记下场景指纹 → 改场景 → 正文标脏。
    await project.markBeatsWritten(plotRel, await project.beatsHashFor(plotRel));
    pManuscriptFresh = await build();

    const s2 = await project.readScene(plotRel, 2);
    s2.sections.动作 = '甲、乙、丙';
    await wsOf(project).writeScene(plotRel, { ...s2, plotRelPath: plotRel });
    pManuscriptStale = await build();
  });

  test('刚生成的剧情不脏', () => {
    assert.equal(pFresh.plot.upstreamStale, false);
  });

  test('改大纲后剧情标脏', () => {
    assert.equal(pOutlineChanged.plot.upstreamStale, true);
  });

  test('刚生成的场景不脏', () => {
    assert.ok(pScenesFresh.scenes.every((s) => !s.upstreamStale));
  });

  test('改剧情后场景全部标脏', () => {
    assert.equal(pPlotChanged.scenes.length, 2);
    assert.ok(pPlotChanged.scenes.every((s) => s.upstreamStale));
  });

  test('只改场景状态不改变 beats 指纹', () => {
    assert.equal(beatsAfterStatus, beatsBefore);
  });

  test('刚写完的正文不脏', () => {
    assert.equal(pManuscriptFresh.manuscript.beatsStale, false);
  });

  test('改场景后正文标脏', () => {
    assert.equal(pManuscriptStale.manuscript.beatsStale, true);
  });

  // **已经发布的章不被拉回去**：中转站那份拆分时就删了，把作者已经发出去的
  // 文字标成「待写正文」是在撺掇他重写。工程页那一行仍会挂 ⟳ 提醒，够了。
  // （未发布的章退回「待写正文」那一条在 tests/unit/model/pipeline.test.js 里守。）
  test('已发布的章：正文标脏也不退回待写正文', () => {
    assert.notEqual(pManuscriptStale.stage, 'manuscript', pManuscriptStale.stage);
  });
});

describe('新鲜度链 · 手写产物不标脏', () => {
  let p;

  before(async () => {
    // 作者手写的细纲没有 upstreamHash。拿一个凭空的过期标记去催他重做，
    // 比不标更糟——他会学会无视所有标记。
    t.write('.novelforge/plots/020-手写.md', '## 目标\n\n我自己写的\n\n## 剧情脉络\n\nx');
    t.write('.novelforge/manuscripts/020-手写.md', '# 第20段 手写 · 正文\n\n正文');
    const plot = await project.readPlot('.novelforge/plots/020-手写.md');
    // 收的是「一章」（章号 + 细纲 + 成品）。直接把 `Plot` 递进去也**编译得过**
    // （它恰好有 `no`，另两个字段可选），但 plot/chapter 会双双是 undefined，
    // 于是整章按空事实推导——断言看着绿，测的却不是这一章。
    p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  });

  test('手写剧情（无 upstreamHash）不标脏', () => {
    assert.equal(p.plot.upstreamStale, false);
  });

  test('从没记过 beatsHash 的正文不标脏', () => {
    assert.equal(p.manuscript.beatsStale, false);
  });
});

describe('流水线索引', () => {
  let index;
  let plotCount;
  let handwritten;

  before(async () => {
    // buildPipelineIndex 连摘要索引、manifest 与大纲原文一起返回（同一次刷新里
    // 工程树与出场索引要的是同一批摘要），流水线本身在 .pipelines 上。
    ({ pipelines: index } = await bundle.pipe.buildPipelineIndex(project));
    plotCount = (await project.listPlots()).length;
    handwritten = index.get('.novelforge/plots/020-手写.md');
  });

  // 索引按**细纲路径**索引：段号与章号是两条轴（一段可以拆成三章），
  // 拿号当键会让两条轴上毫不相干的东西撞在一起。路径是段唯一的身份。
  test('索引按细纲路径索引', () => {
    assert.ok(index.has('.novelforge/plots/012-夜入.md'), [...index.keys()].join('|'));
  });

  test('索引覆盖全部段', () => {
    assert.equal(index.size, plotCount);
  });

  test('没拆场景的段停在待拆场景', () => {
    assert.equal(handwritten.stage, 'scene', handwritten.stage);
  });

  test('没拆场景时场景完成度为 0', () => {
    assert.equal(handwritten.progress.scene, 0);
  });

  // 位次是推导出来的：最新章号 + 在未交付的段里排第几。它与文件名前缀
  // （段号）不是一回事，界面上那个「剧情 N」认的是这个。
  test('未交付的段带上了显示位次', async () => {
    const { segments, chapters } = await bundle.pipe.buildPipelineIndex(project);
    const max = chapters.reduce((m, c) => Math.max(m, c.order), 0);
    assert.deepEqual(
      segments.map((p) => p.displayNo),
      segments.map((_, i) => max + i + 1),
      JSON.stringify(segments.map((p) => [p.no, p.displayNo]))
    );
  });
});

describe('工作区卡', () => {
  const plotRel = '.novelforge/plots/012-夜入.md';
  let plotCard;
  let scene;
  let withMeta;
  let meta;
  let ms;
  let skeleton;
  let shell;
  let gone;
  let outline;

  before(async () => {
    const wb = (target) => bundle.workbench.buildWorkbench(project, target);

    plotCard = await wb({ kind: 'plot', plotRelPath: plotRel });
    scene = await wb({ kind: 'scene', plotRelPath: plotRel, sceneNo: 2 });

    // 填了地点时间就该合成一行「这一幕」——那是这一层最要紧的三样元信息。
    await wsOf(project).writeScene(plotRel, {
      plotRelPath: plotRel, no: 2, title: '翻墙', place: '青云宗侧峰', time: '子时，暴雨',
      characters: ['林昭'], upstreamHash: 'X', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
    });
    withMeta = await wb({ kind: 'scene', plotRelPath: plotRel, sceneNo: 2 });
    meta = withMeta.sections.find((s) => s.key === '这一幕');

    // 正文层只给统计。上万字摊进一张浮窗既读不下去，又把「这一层齐没齐」埋掉了。
    ms = await wb({ kind: 'manuscript', plotRelPath: plotRel });

    // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
    // 只判文件在不在的话，一份只有目标的骨架会渲染成一张几乎空的卡。
    const bare = await wsOf(project).writePlot({
      no: 40, title: '空骨架', arc: '', upstreamHash: '', done: false,
      sections: bundle.plotFile.emptyPlotSections(),
    });
    skeleton = await wb({ kind: 'plot', plotRelPath: bare });

    // 刚拆出来的场景只有元信息，小节全空。这时用 warning 而不是 empty——
    // empty 会连「这一幕」一起藏掉，而地点时间恰恰是这时唯一有的东西。
    await wsOf(project).writeScene(plotRel, {
      plotRelPath: plotRel, no: 5, title: '空壳', place: '山门', time: '黄昏',
      characters: [], upstreamHash: '', status: 'draft',
      sections: bundle.sceneFile.emptySceneSections(),
    });
    shell = await wb({ kind: 'scene', plotRelPath: plotRel, sceneNo: 5 });

    // 段刚被改名/删除时给一张说得清情况的空卡，而不是让整条推送失败。
    gone = await wb({ kind: 'scene', plotRelPath: '.novelforge/plots/999-不存在.md', sceneNo: 1 });
    outline = await wb({ kind: 'outline' });
  });

  test('剧情卡摊开小节', () => {
    assert.ok(plotCard.sections.length > 0, JSON.stringify(plotCard.sections));
  });

  test('剧情卡标题带章号', () => {
    assert.ok(plotCard.title.includes('第 12 章'), plotCard.title);
  });

  test('剧情卡指向细纲文件', () => {
    assert.ok(plotCard.relPath.includes('plots/'), plotCard.relPath);
  });

  // 空小节不进卡片：卡片是给人看的，不是一张待填表格。
  test('空小节不显示', () => {
    assert.ok(
      plotCard.sections.every((s) => s.text.trim() && s.text !== '（待补充）'),
      JSON.stringify(plotCard.sections)
    );
  });

  test('场景卡带素材小节', () => {
    assert.ok(
      scene.sections.some((s) => s.key === '动作'),
      JSON.stringify(scene.sections.map((s) => s.key))
    );
  });

  // 这一场的 place/time/characters 都是空的 → 不画那一行，而不是画一行空的。
  test('没有地点时间时不画「这一幕」', () => {
    assert.ok(
      !scene.sections.some((s) => s.key === '这一幕'),
      JSON.stringify(scene.sections.map((s) => s.key))
    );
  });

  // 上一组刚改过剧情的小节，场景的 upstreamHash 还是旧的 → 与剧情对不上。
  test('场景卡说出上游变更', () => {
    assert.ok(!!scene.warning, scene.warning);
  });

  test('有地点时间时合成「这一幕」', () => {
    assert.ok(
      meta && meta.text.includes('侧峰') && meta.text.includes('子时') && meta.text.includes('林昭'),
      JSON.stringify(withMeta.sections.map((s) => s.key))
    );
  });

  test('正文卡只给统计', () => {
    assert.ok(
      ms.sections.every((s) => s.key === '篇幅' || s.key === '场景'),
      JSON.stringify(ms.sections.map((s) => s.key))
    );
  });

  test('正文卡不摊全文', () => {
    assert.ok(ms.sections.every((s) => s.text.length < 60), JSON.stringify(ms.sections));
  });

  test('空骨架剧情说「还没排剧情」', () => {
    assert.ok(
      skeleton.sections.length === 0 && !!skeleton.empty,
      JSON.stringify(skeleton)
    );
  });

  test('空壳场景仍显示元信息', () => {
    assert.ok(
      shell.sections.some((s) => s.key === '这一幕'),
      JSON.stringify(shell.sections.map((s) => s.key))
    );
  });

  test('空壳场景提示还没有素材', () => {
    assert.ok(shell.warning?.includes('素材'), shell.warning);
  });

  test('段不存在时给空卡而非抛', () => {
    assert.ok(!!gone.empty, JSON.stringify(gone));
  });

  test('大纲卡指向 outline.md', () => {
    assert.ok(outline.relPath.endsWith('outline.md'), outline.relPath);
  });
});
