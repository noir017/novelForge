/**
 * 创作流水线的数据层：路径规则、细纲读写、改名、新鲜度链、流水线索引、全书事实、工作区卡。
 *
 * 一章一纲之后只有**一条轴**：细纲号 = 章号。细纲**镜像正文在章节根下的相对路径**
 * （`chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`），有正文的章按路径认它的细纲，
 * 还没有正文的章按号认计划；定稿反向更新的也是同一份细纲，不再另写一份单章摘要。从前的卷、
 * 剧情段位次、中转站 `manuscripts/`、拆章与 `plots/` 都不读了；老工程磁盘上的那几个目录一个字节都不动，
 * 代码只是不再读它们。
 *
 * 章节那一侧的读写（扫描、扩展名、草稿）另见 tests/integration/files/chapters.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

let bundle;
let h;
let t;
let project;
const dirs = [];

/** 一份排过的细纲（「关键事件」非空，isPlotFilled 才认）。 */
const filledSections = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '林昭成功进入青云宗。',
  关键事件: '他在山门外等到天黑，翻过侧峰，被巡逻的人撞见。',
  看点: '他站在藏书阁门口，门里亮着灯。',
  ...extra,
});

/** 一份最小的可写细纲。 */
const writable = (no, title, extra = {}) => ({
  no, title, upstreamHash: '', done: false, sections: filledSections(), ...extra,
});

/** 定稿时模型答回来的七节（反向更新之后的样子）。 */
const FINALIZED = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '夜入青云。',
  出场人物: '林昭',
  关键事件: '等、翻、被撞见。',
  看点: '- 藏书阁门里亮着灯。',
  ...extra,
});

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    model: './src/core/model/pipeline.ts',
    pipe: './src/core/views/pipeline.ts',
    workbench: './src/core/views/workbench.ts',
    guard: './src/core/workspace/guard.ts',
    kind: './src/core/workspace/kind.ts',
    logger: './src/core/runtime/logger.ts',
  });
  wsMod = bundle.ws;
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'pipeline',
    title: '青云剑录',
    keepExamples: true,
  });
  dirs.push(t.dir);
  project = t.project;
});

after(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
});

describe('数据层 · 目录与路径规则', () => {
  const plot = '.novelforge/summaries/012-夜入青云.md';

  // 细纲与全文大纲（global.md）都在 summaries/。
  test('初始化建出 summaries/', () => {
    assert.ok(t.has('.novelforge/summaries'));
  });

  // 卷与中转站两层删掉了，细纲也搬出了 plots/：新工程不再建那几个目录（老工程里的原样留着，见 guard.ts）。
  test('初始化不再建 volumes/、manuscripts/ 与 plots/', () => {
    assert.ok(!t.has('.novelforge/volumes') && !t.has('.novelforge/manuscripts') && !t.has('.novelforge/plots'));
  });

  // 架构三件写空模板：结构完整、全是占位，状态机于是从「生成小说配置」开始。
  test('初始化写入架构三件的空模板', () => {
    for (const rel of ['.novelforge/config.md', '.novelforge/premise.md', '.novelforge/world.md']) {
      assert.ok(t.has(rel), rel);
    }
  });

  test('空模板都不算填过', async () => {
    assert.deepEqual(await project.settingFilled(), {
      config: false, premise: false, characters: false, world: false, lore: false,
    });
  });

  // 细纲镜像正文在章节根下的相对路径，扩展名换成 .md（与草稿同一套）。
  test('正文 → 细纲：相对路径相同，扩展名换成 .md', () => {
    assert.equal(project.plotPathForChapter('chapters/012-夜入青云.md'), plot);
    assert.equal(project.plotPathForChapter('chapters/第一卷/003-深处.txt'), '.novelforge/summaries/第一卷/003-深处.md');
    assert.equal(project.plotPathForChapter('chapters/001 序'), '.novelforge/summaries/001 序.md');
  });

  test('细纲 → 照它写出来的正文：反推回章节根', () => {
    assert.equal(project.chapterPathForPlot('.novelforge/summaries/第二卷/010-雪夜.md'), 'chapters/第二卷/010-雪夜.md');
    assert.equal(project.chapterPathForPlot('chapters/010-雪夜.md'), undefined);
  });

  // 前面一章都没有时落在根下。「第 9 章」是 `listChapters` 给无标题章的回落值——那是没有名字，不是名字。
  test('还没有正文也没有细纲的章：落在根下，回落标题不进文件名', async () => {
    assert.equal(await project.plotPathForNewChapter(12, '夜入青云'), plot);
    assert.equal(await project.plotPathForNewChapter(9, '第 9 章'), '.novelforge/summaries/009.md');
  });
});

describe('数据层 · 细纲读写', () => {
  let plotRel;
  let noPlot;
  let plotBack;
  let listed;
  let nextNo;

  before(async () => {
    noPlot = await project.readPlot('.novelforge/summaries/012-夜入青云.md');
    nextNo = await project.nextPlotNo();

    plotRel = await wsOf(project).writePlot(writable(12, '夜入青云', {
      sections: filledSections({ 出场人物: '林昭、沈青' }),
      targetWords: 3000,
      upstreamHash: 'OUTLINE_A',
    }));
    plotBack = await project.readPlot(plotRel);
    listed = await project.listPlots();
  });

  test('没写过时读不出细纲', () => {
    assert.equal(noPlot, undefined);
  });

  test('空工程的下一章是第 1 章', () => {
    assert.equal(nextNo, 1);
  });

  test('没有正文、前面也没有章：细纲落在 summaries/ 根下，名字带三位序号', () => {
    assert.equal(plotRel, '.novelforge/summaries/012-夜入青云.md', plotRel);
  });

  test('七节读得回来', () => {
    assert.equal(plotBack.sections.梗概, '林昭成功进入青云宗。');
    assert.ok(plotBack.sections.关键事件.includes('翻过侧峰'), plotBack.sections.关键事件);
    assert.ok(plotBack.sections.看点.includes('藏书阁'), plotBack.sections.看点);
  });

  test('章号来自文件名', () => {
    assert.equal(plotBack.no, 12);
  });

  test('目标字数读得回来（状态机拿它判「写够没有」）', () => {
    assert.equal(plotBack.targetWords, 3000);
  });

  // 没定稿时「出场人物」写的是计划出场：挑角色卡、预检用，按顿号切出名字。
  test('计划出场从「出场人物」一节读回来', () => {
    assert.deepEqual(plotBack.characters, ['林昭', '沈青']);
  });

  test('还没定稿：sourceHash 是空串', () => {
    assert.equal(plotBack.sourceHash, '');
  });

  test('listPlots 列得到它', () => {
    assert.equal(listed.filter((p) => p.no === 12).length, 1, JSON.stringify(listed.map((p) => p.no)));
  });

  // 跨细纲与 chapters/ 取最大号 +1（见 NovelProject.nextPlotNo 的注释）。
  test('有第 12 章细纲之后，新建细纲落到第 13 章', async () => {
    assert.equal(await project.nextPlotNo(), 13);
  });
});

/**
 * 老工程留下的东西：`plots/` 里的细纲、`summaries/` 子目录里按章节路径镜像的单章摘要、老四节格式的
 * 细纲、`summaries/` 根下的老单章摘要。**解析一律不抛**（第 1 条），读进来如实退化，那些文件一个字节
 * 都不动。`plots/` 不做迁移（作者定案 2）：判成 other，不读、不显示、不删，目录守卫照旧拦着；
 * `summaries/` 下的老摘要（根下与子目录里的）本来就镜像正文的路径、就是这七节、带着 sourceHash 与 cast，
 * 直接当成定稿过的细纲。
 */
describe('数据层 · 老工程留下的文件', () => {
  const LEGACY_PLOT = '.novelforge/plots/007-老细纲.md';
  const LEGACY_PLOT_TEXT =
    '---\nno: 7\ntitle: 老细纲\nrole: 开篇\n---\n\n## 本章目的\n\n进宗门\n\n## 关键事件\n\n甲、乙、丙。\n\n## 章末钩子\n\n门里有人。\n';
  const NESTED = '.novelforge/summaries/卷一/001-高烧.md';
  const OLD = '.novelforge/summaries/008-老格式.md';
  const OLD_TEXT = '---\nno: 8\ntitle: 老格式\n---\n\n## 目标\n\n进宗门\n\n## 剧情脉络\n\n甲、乙、丙。\n';
  const OLD_SUMMARY = '.novelforge/summaries/009-旧摘要.md';
  let listed;
  let index;
  let old;
  let oldPipe;
  let oldSummary;
  let oldSummaryPipe;

  before(async () => {
    t.write(LEGACY_PLOT, LEGACY_PLOT_TEXT);
    t.write(NESTED, '---\nchapter: 1\nsourceHash: x\n---\n\n## 关键事件\n\n老卷里的一章。\n');
    t.write(OLD, OLD_TEXT);
    // 老工程的单章摘要：frontmatter 记的是 `chapter:`，带 sourceHash 与 cast，小节本来就是七节里的那几节。
    t.write('chapters/009-旧摘要.md', '# 旧摘要\n\n他回到镇上。\n');
    project.invalidate();
    const chapter9 = (await project.listChapters()).find((c) => c.order === 9);
    t.write(
      OLD_SUMMARY,
      `---\nchapter: 9\nsourceHash: ${chapter9.contentHash}\ncast: [林昭(阿昭)]\ngeneratedBy: novel-forge\n---\n\n` +
        '# 第9章 旧摘要 · 摘要\n\n## 梗概\n\n他回到镇上。\n\n## 出场人物\n\n林昭\n\n## 关键事件\n\n回镇。\n'
    );
    project.invalidate();
    listed = await project.listPlots();
    index = await bundle.pipe.buildPipelineIndex(project);
    old = await project.readPlot(OLD);
    oldPipe = await bundle.pipe.buildPlotPipeline(project, { no: 8, plot: old });
    oldSummary = listed.find((p) => p.relPath === OLD_SUMMARY);
    oldSummaryPipe = index.byNo.get(9);
  });

  after(() => {
    t.remove('.novelforge/plots');
    t.remove('.novelforge/summaries/卷一');
    t.remove(OLD);
    t.remove(OLD_SUMMARY);
    t.remove('chapters/009-旧摘要.md');
    project.invalidate();
  });

  test('plots/ 里的细纲不进 listPlots', () => {
    assert.ok(!listed.some((p) => p.relPath === LEGACY_PLOT), listed.map((p) => p.relPath).join('|'));
  });

  test('plots/ 里的细纲不进流水线', () => {
    assert.ok(!index.byNo.has(7), index.rows.map((r) => r.no).join(','));
  });

  test('plots/ 里的文件判成 other', () => {
    assert.equal(bundle.kind.kindOfPath(project, LEGACY_PLOT).kind, 'other');
  });

  // 代码不再读它，不等于可以替作者处置它：整棵目录照旧不能改名、搬走或删除。
  test('plots/ 目录照旧受保护', () => {
    assert.equal(bundle.guard.isProtectedPath(project, '.novelforge/plots'), true);
  });

  test('读一遍不改动 plots/ 里的文件', () => {
    assert.equal(t.read(LEGACY_PLOT), LEGACY_PLOT_TEXT);
  });

  // 老工程的单章摘要本来就镜像正文的相对路径：分卷的书，摘要就在卷目录里。
  test('summaries/ 子目录里的老摘要照样是细纲', () => {
    assert.ok(listed.some((p) => p.relPath === NESTED), listed.map((p) => p.relPath).join('|'));
  });

  test('summaries/ 子目录里的文件判成 plot', () => {
    assert.equal(bundle.kind.kindOfPath(project, NESTED).kind, 'plot');
  });

  test('老四节细纲读得出来，不抛', () => {
    assert.equal(old?.no, 8);
    assert.equal(old?.title, '老格式');
  });

  // 「目标」「剧情脉络」都不是七节里的名字：如实说「待写细纲」，而不是假装排过。
  test('老四节细纲七节全空，算没排过', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(old.sections), JSON.stringify(old.sections));
    assert.equal(oldPipe.stage, 'plot', oldPipe.stage);
  });

  test('读一遍不改动那份文件', () => {
    assert.equal(t.read(OLD), OLD_TEXT);
  });

  test('summaries/ 根下的老摘要当成一份细纲读进来，章号取文件名', () => {
    assert.equal(oldSummary?.no, 9, listed.map((p) => p.relPath).join('|'));
  });

  test('老摘要带着的 sourceHash 读得回来', async () => {
    const chapter9 = (await project.listChapters()).find((c) => c.order === 9);
    assert.equal(oldSummary.sourceHash, chapter9.contentHash);
  });

  // 定稿过的细纲，出场人物取 frontmatter 的 cast（实际出场），别名一并读回来。
  test('老摘要的 cast 就是这一章的实际出场', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(oldSummary.cast)), [{ name: '林昭', aliases: ['阿昭'] }]);
  });

  test('sourceHash 对得上正文：这一章算定稿过、写完了', () => {
    assert.equal(oldSummaryPipe?.stage, 'done', JSON.stringify(oldSummaryPipe));
  });
});

/**
 * 这一章已经有正文时改细纲的标题：细纲镜像正文的路径，**文件名跟着正文不动**，只换 frontmatter
 * 里的标题。改文件名的是正文那一侧（工程页「重命名」，细纲跟着搬，见 files/fileOps.test.js）。
 */
describe('数据层 · 有正文时改细纲标题', () => {
  const rel = '.novelforge/summaries/012-夜入青云.md';
  let renamed;
  let plotHashBefore;
  let plotHashAfter;
  let after;
  let pipe;

  before(async () => {
    // 改名前的内容指纹。改名**绝不能**动它：一旦哪个字段进了哈希，
    // 改个名就会让这一章的正文凭空标脏（AGENTS.md 第 18 条 (b)）。
    plotHashBefore = bundle.plotFile.plotContentHash(await project.readPlot(rel));
    t.write('chapters/012-夜入青云.md', '# 夜入青云\n\n正文若干字。\n');
    project.invalidate();

    const plot = await project.readPlot(rel);
    renamed = await wsOf(project).writePlot({ ...plot, title: '夜入' });
    after = await project.readPlot(rel);
    plotHashAfter = bundle.plotFile.plotContentHash(after);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: after });
  });

  test('落点仍是正文的镜像', () => {
    assert.equal(renamed, rel, String(renamed));
  });

  test('标题换了', () => {
    assert.equal(after.title, '夜入');
  });

  test('没有多出第二份细纲', async () => {
    assert.equal((await project.listPlots()).filter((p) => p.no === 12).length, 1);
  });

  test('正文不跟着改名', () => {
    assert.ok(t.has('chapters/012-夜入青云.md'));
  });

  test('细纲与正文按路径认到一起', () => {
    assert.equal(pipe.chapter.relPath, 'chapters/012-夜入青云.md', JSON.stringify(pipe.chapter));
  });

  // 这一条是防「改个名把整章标脏」的回归线。
  test('细纲的内容指纹没变', () => {
    assert.equal(plotHashAfter, plotHashBefore);
  });
});

/**
 * 新建细纲那条路的主流程：建出来只有序号（`030.md`），细纲排出来才给它起名。
 * 起名走的是 `writePlot`（还没有正文时：标题变 → 文件名变），不是 fileOps。
 */
describe('数据层 · 给未命名的细纲起名', () => {
  let bare;
  let named;
  let plotRead;
  let plotText;
  let pipe;
  let dest;

  before(async () => {
    bare = await wsOf(project).writePlot(writable(30, '', { sections: filledSections({ 梗概: '起个名字。' }) }));
    const plot = await project.readPlot(bare);
    named = await wsOf(project).writePlot({ ...plot, title: '风起' });
    plotRead = await project.readPlot(named);
    plotText = t.read('.novelforge/summaries/030-风起.md');
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 30, plot: plotRead });
    dest = await bundle.pipe.chapterTargetOf(project, named);
  });

  test('未命名时落成纯序号名', () => {
    assert.equal(bare, '.novelforge/summaries/030.md', String(bare));
  });

  test('起名后序号前缀保留，后面补分隔符', () => {
    assert.equal(named, '.novelforge/summaries/030-风起.md', String(named));
  });

  test('旧的纯序号文件被删掉，不会一章变两份', () => {
    assert.ok(!t.has('.novelforge/summaries/030.md'));
  });

  test('title: 换成真标题', () => {
    assert.equal(plotRead.title, '风起', plotRead.title);
  });

  // 标题行就说「第 N 章」：细纲号 = 章号，从前那个「剧情段 N」的说法没有了。
  test('H1 跟着换成「第N章 标题」', () => {
    assert.ok(plotText.includes('# 第30章 风起'), plotText.slice(0, 300));
  });

  // 正文照细纲的路径反推着落：落盘之后镜像回去正好是这一份。
  test('写正文时落在细纲反推出来的位置', () => {
    assert.deepEqual({ exists: dest.exists, rel: dest.rel }, { exists: false, rel: 'chapters/030-风起.md' });
  });

  test('流水线这一行的标题取细纲的', () => {
    assert.equal(pipe.title, '风起', pipe.title);
  });

  after(() => {
    t.remove('.novelforge/summaries/030-风起.md');
    project.invalidate();
  });
});

describe('新鲜度链', () => {
  const plotRel = '.novelforge/summaries/012-夜入青云.md';
  const CHAPTER = 'chapters/012-夜入青云.md';
  const OUTLINE = '# 大纲\n\n## 第1–20章：第一幕 · 入局\n\n林昭进青云宗。\n';
  let pFresh;
  let pOutlineChanged;
  let pWritten;
  let pPlotChanged;
  let pFinalized;
  let pEditedAfterFinalize;
  let pProseChanged;

  const build = async () => {
    project.invalidate();
    const plot = await project.readPlot(plotRel);
    return bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  };

  before(async () => {
    t.write('.novelforge/outline.md', OUTLINE);
    project.invalidate();

    // 细纲记下当时大纲里覆盖第 12 章那一节的指纹。
    const plot = await project.readPlot(plotRel);
    const slice = bundle.outlineFile.outlineUpstreamHash(await project.readOutline(), 12);
    await wsOf(project).writePlot({ ...plot, upstreamHash: slice });
    pFresh = await build();

    // 改大纲覆盖本章的那一节 → 细纲标脏。零模型调用。
    t.write('.novelforge/outline.md', OUTLINE.replace('林昭进青云宗。', '林昭进青云宗（改了）。'));
    pOutlineChanged = await build();

    // 正文写够（细纲定了 3000 字），并按正文落盘那一步的样子在细纲上记 writtenFrom。
    t.write(CHAPTER, `# 夜入青云\n\n${'雨'.repeat(2600)}\n`);
    project.invalidate();
    const current = await project.readPlot(plotRel);
    await wsOf(project).recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(current));
    pWritten = await build();

    // 改细纲 → 这一章的正文标脏。
    const p = await project.readPlot(plotRel);
    p.sections.关键事件 = '改成三拍：等、翻、被撞见。';
    await wsOf(project).writePlot(p);
    pPlotChanged = await build();

    // 定稿：细纲照正文反向更新，记下正文的 contentHash，writtenFrom 刷成更新后的指纹。
    const chapter = (await project.listChapters()).find((c) => c.order === 12);
    await wsOf(project).finalizePlot(chapter, FINALIZED(), [{ name: '林昭', aliases: [] }]);
    pFinalized = await build();

    // 定稿之后作者又改了细纲。
    const q = await project.readPlot(plotRel);
    q.sections.关键事件 = '等、翻、被撞见，又被放走。';
    await wsOf(project).writePlot(q);
    pEditedAfterFinalize = await build();

    // 定稿之后又改了正文。
    await wsOf(project).write(CHAPTER, { text: '天快亮了。' }, { mode: 'append' });
    pProseChanged = await build();
  });

  test('刚排的细纲不脏', () => {
    assert.equal(pFresh.plot.upstreamStale, false);
  });

  test('改了大纲里覆盖本章那一节，细纲标脏', () => {
    assert.equal(pOutlineChanged.plot.upstreamStale, true);
  });

  test('刚写完的正文不脏', () => {
    assert.equal(pWritten.chapter.upstreamStale, false);
  });

  test('写够了、没定稿：待定稿', () => {
    assert.equal(pWritten.stage, 'finalize', pWritten.stage);
  });

  test('改细纲后正文标脏', () => {
    assert.equal(pPlotChanged.chapter.upstreamStale, true);
  });

  // 从前正文在中转站，拆分就是闸口；现在没拆分这一步，细纲改了而作者还没认可过
  // 那份正文，下一步就该是拿新细纲重写。
  test('没定稿的章：细纲改了退回待写正文（重写）', () => {
    assert.equal(pPlotChanged.stage, 'manuscript', pPlotChanged.stage);
  });

  test('定稿之后这一章写完了', () => {
    assert.equal(pFinalized.stage, 'done', pFinalized.stage);
  });

  // 定稿把细纲改成了正文写成的样子，两者此刻是对得上的。
  test('定稿刷新 writtenFrom，正文不再挂 ⟳', () => {
    assert.equal(pFinalized.chapter.upstreamStale, false);
  });

  // **定稿过的章不被拉回去**：那是作者已经认可的文字，把它标成「待写正文」是在撺掇他
  // 重写。工程页那一行仍会挂 ⟳ 提醒，够了。
  test('定稿过的章：细纲改了也不退回，只挂 ⟳', () => {
    assert.equal(pEditedAfterFinalize.stage, 'done', pEditedAfterFinalize.stage);
    assert.equal(pEditedAfterFinalize.chapter.upstreamStale, true);
  });

  test('定稿之后正文又改过：定稿标过期', () => {
    assert.equal(pProseChanged.summary.stale, true, JSON.stringify(pProseChanged.summary));
  });

  test('定稿之后正文又改过：不再算写完', () => {
    assert.notEqual(pProseChanged.stage, 'done');
  });

  // 只改 frontmatter 里的 status 不该让下游标脏——`plotContentHash` 只哈希
  // 七个小节（第 18b 条）。
  test('把细纲标成 done 不改变它的内容指纹', async () => {
    const p = await project.readPlot(plotRel);
    const before = bundle.plotFile.plotContentHash(p);
    await wsOf(project).writePlot({ ...p, done: true });
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), before);
  });

  // 作者手工宣布「这一章过了」：只允许向前覆盖推导值——定稿之后正文又改过也算。
  test('标了 done 的章算完成', async () => {
    const p = await build();
    assert.equal(p.stage, 'done', p.stage);
  });
});

describe('新鲜度链 · 手写产物不标脏', () => {
  let p;

  before(async () => {
    // 作者手写的细纲没有 upstreamHash，手写的正文没有 writtenFrom。拿一个凭空的
    // 过期标记去催他重做，比不标更糟——他会学会无视所有标记。
    t.write('.novelforge/summaries/020-手写.md', '## 梗概\n\n我自己写的\n\n## 关键事件\n\nx');
    t.write('chapters/020-手写.md', '# 手写\n\n正文');
    project.invalidate();
    const plot = await project.readPlot('.novelforge/summaries/020-手写.md');
    // 收的是「一章」（章号 + 细纲 + 成品）。直接把 `Plot` 递进去也**编译得过**
    // （它恰好有 `no`，另两个字段可选），但 plot/chapter 会双双是 undefined，
    // 于是整章按空事实推导——断言看着绿，测的却不是这一章。
    p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  });

  test('前提：这一章的细纲与正文都认到了', () => {
    assert.ok(p.plot.exists && p.chapter.exists, JSON.stringify(p));
  });

  test('手写细纲（无 upstreamHash）不标脏', () => {
    assert.equal(p.plot.upstreamStale, false);
  });

  test('从没记过 writtenFrom 的正文不标脏', () => {
    assert.equal(p.chapter.upstreamStale, false);
  });
});

describe('流水线索引', () => {
  let index;
  let plotNos;
  let chapterNos;

  before(async () => {
    // 只有正文、没有细纲的一章（老工程里每一章都是这样）。
    t.write('chapters/025-只有正文.md', '# 只有正文\n\n作者早就写好的一章。\n');
    // 同号两份章节：作者手改文件名撞了号。
    t.write('chapters/026-a.md', '# a\n\n甲。\n');
    t.write('chapters/026-b.md', '# b\n\n乙。\n');
    t.write('.novelforge/config.md', '---\ntotalChapters: 60\n---\n\n# 小说配置\n');
    project.invalidate();
    index = await bundle.pipe.buildPipelineIndex(project);
    plotNos = (await project.listPlots()).map((p) => p.no);
    chapterNos = (await project.listChapters()).map((c) => c.order);
  });

  // 细纲号 = 章号：两条列表按号合并成一条轴，一个章号一行。
  test('一个章号一行（细纲号 ∪ 章节号），升序', () => {
    const expected = [...new Set([...plotNos, ...chapterNos])].sort((a, b) => a - b);
    assert.deepEqual(index.rows.map((r) => r.no), expected);
  });

  test('缺号的不补空行', () => {
    assert.ok(!index.rows.some((r) => r.no === 1), index.rows.map((r) => r.no).join(','));
  });

  test('byNo 按章号索引', () => {
    assert.equal(index.byNo.get(12)?.plot.relPath, '.novelforge/summaries/012-夜入青云.md');
  });

  test('只有正文的章也占一行，细纲路径是它应该在的位置', () => {
    const row = index.byNo.get(25);
    assert.equal(row?.plot.exists, false, JSON.stringify(row?.plot));
    assert.equal(row?.plot.relPath, '.novelforge/summaries/025-只有正文.md');
  });

  // 老工程的章有字，于是是「待定稿」或「已完成」——不被倒回去要求补细纲。
  test('只有正文的章不被倒回去要求补细纲', () => {
    assert.equal(index.byNo.get(25)?.stage, 'finalize', index.byNo.get(25)?.stage);
  });

  // 撞号时不猜、不崩：认路径排序第一份，两份都还在章节列表里，作者看得见冲突。
  test('同号两份章节时只占一行，认路径排序第一份', () => {
    assert.equal(index.rows.filter((r) => r.no === 26).length, 1);
    assert.equal(index.byNo.get(26)?.chapter.relPath, 'chapters/026-a.md');
    assert.equal(index.chapters.filter((c) => c.order === 26).length, 2);
  });

  test('完成度只有三段', () => {
    assert.deepEqual(Object.keys(index.byNo.get(12).progress).sort(), ['manuscript', 'plot', 'summary']);
  });

  // 大纲、配置、manifest 与细纲列表只读一次，跟索引一起返回：工程树与出场索引接着用这一份
  // （出场索引只认其中定稿过的细纲）。
  test('大纲与配置跟索引一起返回', async () => {
    assert.equal(index.outline, await project.readOutline());
    assert.equal(index.config.totalChapters, 60);
    assert.ok(index.plots && index.manifest, Object.keys(index).join(','));
  });

  // 单章不被倒回去要求补细纲，但**全书**是会被推回架构那一步的——这是有意的（D11）：
  // 新链路写正文要读前提、角色与世界观，没有它们上下文就是空的。
  // （从 volumeFlow.test.js「老工程照旧」挪过来，结论按一章一纲的口径改了。）
  test('老工程：有正文、没有架构，全书被推回架构的第一件', async () => {
    const facts = await bundle.pipe.buildBookFacts(project, index);
    assert.equal(bundle.model.deriveBookStage(facts), 'setting');
    assert.deepEqual(bundle.model.deriveBookNextStep('setting', facts)?.target, { kind: 'setting', doc: 'config' });
  });
});

/**
 * 「N 章的上游产物有变更」只在标脏的那几章变了时记：索引每次 `pushState` 都建一趟，
 * 名单不变还照记，编辑器里打几个字日志页就被同一行刷屏。
 */
describe('流水线索引 · 上游变更的日志不刷屏', () => {
  let p;
  let pr;
  let afterSame;
  let afterMore;
  let afterCleared;
  let afterAgain;
  /** 排过之后大纲那一节改过的细纲：upstreamHash 对不上，标脏。 */
  const stalePlot = (no, title) => `---\nno: ${no}\ntitle: ${title}\nupstreamHash: 旧的指纹\n---\n\n## 关键事件\n\n- 计划。\n`;
  /** 手写的细纲：没有 upstreamHash，不标脏。 */
  const handPlot = (no, title) => `---\nno: ${no}\ntitle: ${title}\n---\n\n## 关键事件\n\n- 计划。\n`;
  const staleLogs = () =>
    bundle.logger
      .recentLogs()
      .filter((e) => e.scope === '流水线' && e.message.endsWith('章的上游产物有变更'))
      .map((e) => e.detail.split('｜')[0]);
  const rebuild = async (times) => {
    pr.invalidate();
    for (let i = 0; i < times; i++) {
      await bundle.pipe.buildPipelineIndex(pr);
    }
    return staleLogs();
  };

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'stalelog', title: '刷屏' });
    dirs.push(p.dir);
    pr = p.project;
    bundle.logger.clearLogs();

    p.write('.novelforge/summaries/082-雪夜.md', stalePlot(82, '雪夜'));
    afterSame = await rebuild(3);

    p.write('.novelforge/summaries/083-冰河.md', stalePlot(83, '冰河'));
    afterMore = await rebuild(2);

    p.write('.novelforge/summaries/082-雪夜.md', handPlot(82, '雪夜'));
    p.write('.novelforge/summaries/083-冰河.md', handPlot(83, '冰河'));
    afterCleared = await rebuild(2);

    p.write('.novelforge/summaries/082-雪夜.md', stalePlot(82, '雪夜'));
    afterAgain = await rebuild(2);
  });

  test('标脏的章没变：建几趟索引都只记一条', () => {
    assert.deepEqual(afterSame, ['第 82 章']);
  });

  test('又有一章标脏：再记一条', () => {
    assert.deepEqual(afterMore, ['第 82 章', '第 82 章、第 83 章']);
  });

  test('都不脏了：不记', () => {
    assert.deepEqual(afterCleared, afterMore);
  });

  test('消掉之后又标脏：重新记', () => {
    assert.deepEqual(afterAgain, [...afterMore, '第 82 章']);
  });
});

/** 「有几个章号不止一个正文文件」也是索引每趟都会碰到的，同样只在撞号的名单变了时记。 */
describe('流水线索引 · 撞号的日志不刷屏', () => {
  let p;
  let pr;
  let afterSame;
  let afterMore;
  let afterCleared;
  let afterAgain;
  const duplicateLogs = () =>
    bundle.logger
      .recentLogs()
      .filter((e) => e.scope === '流水线' && e.message.startsWith('有几个章号不止一个正文文件'))
      .map((e) => e.detail);
  const rebuild = async (times) => {
    pr.invalidate();
    for (let i = 0; i < times; i++) {
      await bundle.pipe.buildPipelineIndex(pr);
    }
    return duplicateLogs();
  };

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'duplog', title: '撞号' });
    dirs.push(p.dir);
    pr = p.project;
    bundle.logger.clearLogs();

    p.write('chapters/090-a.md', '# a\n\n甲。\n');
    p.write('chapters/090-b.md', '# b\n\n乙。\n');
    afterSame = await rebuild(3);

    p.write('chapters/091-a.md', '# a\n\n甲。\n');
    p.write('chapters/091-b.md', '# b\n\n乙。\n');
    afterMore = await rebuild(2);

    p.remove('chapters/090-b.md');
    p.remove('chapters/091-b.md');
    afterCleared = await rebuild(2);

    p.write('chapters/090-b.md', '# b\n\n乙。\n');
    afterAgain = await rebuild(2);
  });

  test('撞号的章没变：建几趟索引都只记一条', () => {
    assert.deepEqual(afterSame, ['第 90 章']);
  });

  test('又撞了一个号：再记一条', () => {
    assert.deepEqual(afterMore, ['第 90 章', '第 90 章、第 91 章']);
  });

  test('都不撞了：不记', () => {
    assert.deepEqual(afterCleared, afterMore);
  });

  test('解开之后又撞号：重新记', () => {
    assert.deepEqual(afterAgain, [...afterMore, '第 90 章']);
  });
});

/**
 * 全书状态机要的事实（`buildBookFacts`）。**只有这一份**：主按钮、工程页的全书阶段与
 * agent 的状态注入都吃它（第 20 条）。另起一个工程，从空白一步步推到「在写」。
 */
describe('全书事实 · 从空工程一路推到在写', () => {
  let p;
  let pr;
  const facts = async () => bundle.pipe.buildBookFacts(pr);
  const stageOf = async () => bundle.model.deriveBookStage(await facts());
  let empty;
  let beforeLore;
  let afterSettings;
  let afterPlot;
  let afterChapters;
  let afterEmptyChapter;

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'bookfacts', title: '全书' });
    dirs.push(p.dir);
    pr = p.project;
    empty = { facts: await facts(), stage: await stageOf() };

    // 架构前四件与一节大纲。
    p.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查火。\n');
    p.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n回镇 → 被认出。\n');
    p.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n过所制度。\n');
    p.write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    p.write('.novelforge/outline.md', '# 大纲\n\n## 第1–20章：第一幕\n\n进镇。\n');
    pr.invalidate();
    beforeLore = { facts: await facts(), stage: await stageOf() };

    // 第五件设定清单：一条条目就算填过（与角色图谱一张卡就算同理）。
    p.write('.novelforge/lore/地域/青崖镇.md', '---\ntitle: 青崖镇\nkeywords: [青崖镇]\n---\n\n# 青崖镇\n');
    pr.invalidate();
    afterSettings = { facts: await facts(), stage: await stageOf() };

    await wsOf(pr).writePlot(writable(1, '楔子'));
    afterPlot = { facts: await facts(), stage: await stageOf() };

    // 第 1、2、4 章有正文：下一个该写的是缺口第 3 章。
    p.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    p.write('chapters/002-入镇.md', '# 入镇\n\n他走进镇子。\n');
    p.write('chapters/004-夜访.md', '# 夜访\n\n三更时分。\n');
    pr.invalidate();
    afterChapters = await facts();

    // 空文件不算写过：作者建了一个空章节占位，主按钮仍该说「写这一章」。
    p.write('chapters/003.md', '');
    pr.invalidate();
    afterEmptyChapter = await facts();
  });

  test('空工程：架构五件都没有，从「架构」开始', () => {
    assert.deepEqual(empty.facts.settings, { config: false, premise: false, characters: false, world: false, lore: false });
    assert.equal(empty.stage, 'setting');
  });

  // 初始化写的大纲模板只有一行 `>` 说明：那是脚手架，不是大纲。
  test('空工程：大纲模板不算写过，覆盖到第 0 章', () => {
    assert.equal(empty.facts.outlineFilled, false);
    assert.equal(empty.facts.outlineCoverage, 0);
  });

  test('空工程：下一章是第 1 章，没有细纲', () => {
    assert.equal(empty.facts.nextChapterNo, 1);
    assert.equal(empty.facts.nextPlotFilled, false);
  });

  // 设定名录：大纲写在前面也不跳过——五件按顺序，世界观之后是设定清单。
  test('前四件齐了、还没有设定条目：架构那一档推设定清单', () => {
    assert.equal(beforeLore.facts.settings.lore, false);
    assert.equal(beforeLore.stage, 'setting');
    assert.deepEqual(bundle.model.deriveBookNextStep('setting', beforeLore.facts).target, { kind: 'setting', doc: 'lore' });
  });

  test('架构齐了：五件都认', () => {
    assert.deepEqual(afterSettings.facts.settings, { config: true, premise: true, characters: true, world: true, lore: true });
  });

  test('大纲按区间标题算覆盖到第几章', () => {
    assert.equal(afterSettings.facts.outlineFilled, true);
    assert.equal(afterSettings.facts.outlineCoverage, 20);
  });

  test('总章数取自 config.md', () => {
    assert.equal(afterSettings.facts.totalChapters, 30);
  });

  test('架构与大纲齐了、第 1 章没有细纲：拆细纲', () => {
    assert.equal(afterSettings.stage, 'plots');
  });

  test('第 1 章排好细纲：在写', () => {
    assert.equal(afterPlot.facts.nextPlotFilled, true);
    assert.equal(afterPlot.stage, 'writing');
  });

  // 连续才算：跳着写是作者的自由，但主按钮只推一个，推的应该是那个缺口。
  test('第 1、2、4 章有正文时，下一个该写的是第 3 章', () => {
    assert.equal(afterChapters.nextChapterNo, 3);
  });

  test('空章节文件不算写过', () => {
    assert.equal(afterEmptyChapter.nextChapterNo, 3);
  });

  describe('chapterTargetOf · 正文该落在哪', () => {
    test('同号章节已存在（哪怕是空文件）就用它', async () => {
      await wsOf(pr).writePlot(writable(3, '夜渡'));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/summaries/003-夜渡.md');
      assert.deepEqual({ exists: dest.exists, rel: dest.rel, no: dest.no }, { exists: true, rel: 'chapters/003.md', no: 3 });
    });

    test('还没有就是 chapters/NNN-<细纲标题>.md', async () => {
      await wsOf(pr).writePlot(writable(5, '客栈里的女人'));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/summaries/005-客栈里的女人.md');
      assert.deepEqual(
        { exists: dest.exists, rel: dest.rel, title: dest.title },
        { exists: false, rel: 'chapters/005-客栈里的女人.md', title: '客栈里的女人' }
      );
    });

    test('细纲没有标题时落成纯序号名', async () => {
      await wsOf(pr).writePlot(writable(6, ''));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/summaries/006.md');
      assert.equal(dest.rel, 'chapters/006.md');
    });

    test('认不出章号时抛错，而不是乱落', async () => {
      await assert.rejects(() => bundle.pipe.chapterTargetOf(pr, '.novelforge/summaries/没有号.md'), /认不出/);
    });
  });
});

describe('工作区卡', () => {
  const plotRel = '.novelforge/summaries/012-夜入青云.md';
  let plotCard;
  let ms;
  let skeleton;
  let gone;
  let outline;
  let premiseCard;
  let rosterCard;

  before(async () => {
    const wb = (target) => bundle.workbench.buildWorkbench(project, target);

    plotCard = await wb({ kind: 'plot', plotRelPath: plotRel });

    // 正文层摊的是**本章细纲的各节**加篇幅：写正文时最常回头看的是「这一章要落实
    // 哪几件事、看点落在哪」。正文本身上万字，塞进浮窗读不下去。
    ms = await wb({ kind: 'manuscript', plotRelPath: plotRel });

    // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
    const bare = await wsOf(project).writePlot(writable(40, '空骨架', { sections: bundle.plotFile.emptyPlotSections() }));
    skeleton = await wb({ kind: 'plot', plotRelPath: bare });

    // 细纲刚被改名/删除时给一张说得清情况的空卡，而不是让整条推送失败。
    gone = await wb({ kind: 'plot', plotRelPath: '.novelforge/summaries/999-不存在.md' });
    outline = await wb({ kind: 'outline' });
    premiseCard = await wb({ kind: 'setting', doc: 'premise' });
    rosterCard = await wb({ kind: 'setting', doc: 'characters' });
  });

  test('细纲卡摊开小节', () => {
    assert.deepEqual(plotCard.sections.map((s) => s.key), ['梗概', '出场人物', '关键事件', '看点']);
  });

  test('细纲卡标题带章号', () => {
    assert.ok(plotCard.title.includes('第 12 章'), plotCard.title);
  });

  test('细纲卡指向细纲文件', () => {
    assert.equal(plotCard.relPath, plotRel);
  });

  // 上一组把大纲覆盖第 12 章的那一节改过了：作者正在看这一章，此刻正是告诉他的时候。
  test('细纲卡说出大纲那一节变过', () => {
    assert.ok(!!plotCard.warning, JSON.stringify(plotCard));
  });

  // 空小节不进卡片：卡片是给人看的，不是一张待填表格。
  test('空小节不显示', () => {
    assert.ok(
      plotCard.sections.every((s) => s.text.trim() && s.text !== '（待补充）'),
      JSON.stringify(plotCard.sections)
    );
  });

  test('正文卡先报篇幅，再摊本章细纲', () => {
    assert.deepEqual(ms.sections.map((s) => s.key), ['篇幅', '梗概', '出场人物', '关键事件', '看点']);
  });

  test('正文卡不摊正文全文', () => {
    assert.ok(!ms.sections.some((s) => s.text.includes('雨雨雨雨')), JSON.stringify(ms.sections).slice(0, 200));
  });

  test('正文卡指向同号的章节', () => {
    assert.equal(ms.relPath, 'chapters/012-夜入青云.md');
  });

  // 目标字数是状态机判「写够没有」的依据，卡片上必须看得见它。这一章的细纲写了 3000。
  test('有目标字数时篇幅那一行报出它', () => {
    const words = ms.sections.find((s) => s.key === '篇幅');
    assert.ok(words && words.text.includes('3000'), JSON.stringify(ms.sections));
  });

  // 反过来：细纲与配置里都没写目标字数时，判据退化成「有正文就算写够」——
  // 那也得说出来，否则作者看不懂它凭什么已经算完了。
  test('没有目标字数时卡片说清判据', async () => {
    t.write('.novelforge/config.md', '---\ngenre: 武侠\n---\n\n# 小说配置\n');
    project.invalidate();
    const bare = await wsOf(project).writePlot(writable(41, '没写字数'));
    const card = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: bare });
    assert.ok(card.sections.some((s) => s.key === '目标篇幅'), JSON.stringify(card.sections.map((s) => s.key)));
  });

  // 细纲没写就用 config.md 的每章字数。
  test('细纲没写目标字数时按配置的每章字数算', async () => {
    t.write('.novelforge/config.md', '---\nwordsPerChapter: 2500\n---\n\n# 小说配置\n');
    project.invalidate();
    const card = await bundle.workbench.buildWorkbench(project, {
      kind: 'manuscript', plotRelPath: '.novelforge/summaries/041-没写字数.md',
    });
    assert.ok(card.sections.every((s) => s.key !== '目标篇幅'), JSON.stringify(card.sections));
  });

  // 上一组在定稿之后又改过这一章的细纲，而正文那一侧记的还是定稿时的指纹。
  test('正文卡说出细纲在正文之后改过', () => {
    assert.ok(!!ms.warning, JSON.stringify(ms));
  });

  test('空骨架细纲说「还没排细纲」', () => {
    assert.ok(skeleton.sections.length === 0 && !!skeleton.empty, JSON.stringify(skeleton));
  });

  test('细纲不存在时给空卡而非抛', () => {
    assert.ok(!!gone.empty, JSON.stringify(gone));
  });

  test('大纲卡指向 outline.md', () => {
    assert.ok(outline.relPath.endsWith('outline.md'), outline.relPath);
  });

  test('架构卡报的是架构那一层', () => {
    assert.equal(premiseCard.stage, 'setting');
    assert.equal(premiseCard.relPath, '.novelforge/premise.md');
  });

  // 空模板全是占位：卡片说「还没有」，不摊一张全是「（待补充）」的表。
  test('只有模板的架构文档给空卡', () => {
    assert.ok(premiseCard.sections.length === 0 && !!premiseCard.empty, JSON.stringify(premiseCard));
  });

  test('角色图谱卡指向角色目录', () => {
    assert.equal(rosterCard.relPath, '.novelforge/characters');
  });
});

/**
 * 细纲镜像正文的相对路径（2026-10-18 作者定案：「必须保证相对路径，无相对路径是绝对错的」）。
 * 合并细纲与摘要那一次曾把细纲改成平铺在 `summaries/` 根下、按章号配对，分卷的书里
 * `summaries/第二卷/…` 的老摘要于是在工程页上一份都认不出、点章节打不开，而对话页按路径直接读
 * 却读得到。另起一个工程，把那几条路都走一遍。
 */
describe('细纲镜像正文的相对路径', () => {
  let p;
  let pr;
  const NESTED_PLOT = '.novelforge/summaries/第二卷/050-雪夜.md';
  const NESTED_CHAPTER = 'chapters/第二卷/050-雪夜.txt';
  const ORPHAN = '.novelforge/summaries/050-旧名.md';
  let listed;
  let index;
  let byNo;
  let resolved;
  let pipeView;
  let finalized;
  let newPlot;
  let dest;
  let dupPlots;

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'mirror', title: '分卷' });
    dirs.push(p.dir);
    pr = p.project;
    p.write('chapters/第一卷/049-渡口.md', '# 渡口\n\n他到了渡口。\n');
    p.write(NESTED_CHAPTER, '雪下了一夜。\n');
    p.write(NESTED_PLOT, '---\nno: 50\ntitle: 雪夜\n---\n\n# 第50章 雪夜\n\n## 梗概\n\n雪夜。\n\n## 关键事件\n\n- 雪下了一夜。\n');
    // 作者在外面给正文改过名：旧名字的细纲成了孤儿，不冒认这一章。
    p.write(ORPHAN, '---\nno: 50\ntitle: 旧名\n---\n\n## 关键事件\n\n- 旧的计划。\n');
    pr.invalidate();

    listed = await pr.listPlots();
    index = await bundle.pipe.buildPipelineIndex(pr);
    byNo = await pr.getPlot(50);
    resolved = await pr.resolvePlot(ORPHAN);
    pipeView = await bundle.pipe.buildPlotPipeline(pr, { no: 50, plot: byNo });

    const chapter = (await pr.listChapters()).find((c) => c.order === 50);
    finalized = await wsOf(pr).finalizePlot(chapter, FINALIZED(), [{ name: '林昭', aliases: [] }]);

    // 新的一章（还没有正文也没有细纲）跟上一章放在一起：上一章在第二卷，它也落进第二卷。
    newPlot = await wsOf(pr).writePlot(writable(51, '冰河'));
    dest = await bundle.pipe.chapterTargetOf(pr, newPlot);

    // 同号的两个文件（作话与正文）各有各的细纲，不再互相覆盖（7bf8ada 修过的那个 bug）。
    p.write('chapters/060 序.txt', '序。\n');
    p.write('chapters/060 正文.txt', '正文。\n');
    pr.invalidate();
    const sixty = (await pr.listChapters()).filter((c) => c.order === 60);
    for (const c of sixty) {
      await wsOf(pr).finalizePlot(c, FINALIZED({ 梗概: c.relPath }), []);
    }
    dupPlots = await Promise.all(sixty.map((c) => pr.plotOfChapter(c)));
  });

  test('子目录里的细纲列得出来', () => {
    assert.ok(listed.some((x) => x.relPath === NESTED_PLOT), listed.map((x) => x.relPath).join('|'));
  });

  test('子目录里的细纲判成 plot', () => {
    assert.equal(bundle.kind.kindOfPath(pr, NESTED_PLOT).kind, 'plot');
  });

  test('有正文的章只认正文镜像的那一份，孤儿不冒认', () => {
    assert.equal(byNo?.relPath, NESTED_PLOT);
    assert.equal(index.byNo.get(50)?.plot.relPath, NESTED_PLOT);
    assert.equal(index.byNo.get(50)?.plot.exists, true);
  });

  // 对话页按 target 路径读、工程页按章号读，两边必须是同一份。
  test('target 指着孤儿时也认到这一章现在的那一份', () => {
    assert.equal(resolved?.relPath, NESTED_PLOT);
  });

  test('流水线这一行的细纲与正文配上了', () => {
    assert.equal(pipeView.chapter.relPath, NESTED_CHAPTER);
    assert.equal(pipeView.plot.relPath, NESTED_PLOT);
  });

  test('定稿写回镜像的那一份，不在根下另建一份', () => {
    assert.equal(finalized.rel, NESTED_PLOT);
    assert.ok(!p.has('.novelforge/summaries/050-雪夜.md'));
  });

  test('还没有正文的新一章：细纲跟上一章落进同一个子目录', () => {
    assert.equal(newPlot, '.novelforge/summaries/第二卷/051-冰河.md');
  });

  test('照它写正文时，正文也落进那个子目录', () => {
    assert.deepEqual({ exists: dest.exists, rel: dest.rel }, { exists: false, rel: 'chapters/第二卷/051-冰河.md' });
  });

  test('还没有细纲的新一章，落点也跟上一章走', async () => {
    assert.equal(await pr.plotPathOfNo(52), '.novelforge/summaries/第二卷/052.md');
  });

  test('有正文没细纲的章，落点是正文的镜像', async () => {
    assert.equal(await pr.plotPathOfNo(49), '.novelforge/summaries/第一卷/049-渡口.md');
  });

  test('同号的两个文件各有各的细纲', () => {
    assert.deepEqual(
      dupPlots.map((x) => x?.relPath).sort(),
      ['.novelforge/summaries/060 序.md', '.novelforge/summaries/060 正文.md']
    );
    assert.deepEqual(dupPlots.map((x) => x?.sections.梗概).sort(), ['chapters/060 序.txt', 'chapters/060 正文.txt']);
  });
});
