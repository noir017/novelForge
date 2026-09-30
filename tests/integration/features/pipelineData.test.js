/**
 * 创作流水线的数据层：路径规则、细纲读写、改名、新鲜度链、流水线索引、全书事实、工作区卡。
 *
 * 一章一纲之后只有**一条轴**：细纲号 = 章号。第 N 章的细纲（`plots/NNN-*.md`，平铺）、
 * 正文（同号的 `chapters/NNN-*`）、摘要按号互认，认号只在 `views/pipeline.ts` 里做。
 * 从前的卷、剧情段位次、中转站 `manuscripts/` 与拆章都删了；老工程磁盘上的那几个
 * 目录一个字节都不动，代码只是不再读它们。
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
  本章目的: '林昭成功进入青云宗。',
  关键事件: '他在山门外等到天黑，翻过侧峰，被巡逻的人撞见。',
  章末钩子: '他站在藏书阁门口，门里亮着灯。',
  ...extra,
});

/** 一份最小的可写细纲。 */
const writable = (no, title, extra = {}) => ({
  no, title, role: '', characters: [], upstreamHash: '', done: false, sections: filledSections(), ...extra,
});

const SUMMARY = (text) => ({ 梗概: text, 出场人物: '林昭', 时间地点: '', 关键事件: '', 新增伏笔: '', 状态变更: '' });

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
  const plot = '.novelforge/plots/012-夜入青云.md';

  test('初始化建出 plots/', () => {
    assert.ok(t.has('.novelforge/plots'));
  });

  // 卷与中转站两层删掉了：新工程不再建那两个目录（老工程里的原样留着，见 guard.ts）。
  test('初始化不再建 volumes/ 与 manuscripts/', () => {
    assert.ok(!t.has('.novelforge/volumes') && !t.has('.novelforge/manuscripts'));
  });

  // 架构三件写空模板：结构完整、全是占位，状态机于是从「生成小说配置」开始。
  test('初始化写入架构三件的空模板', () => {
    for (const rel of ['.novelforge/config.md', '.novelforge/premise.md', '.novelforge/world.md']) {
      assert.ok(t.has(rel), rel);
    }
  });

  test('空模板都不算填过', async () => {
    assert.deepEqual(await project.settingFilled(), {
      config: false, premise: false, characters: false, world: false,
    });
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

  // 只有正文、还没有细纲的章要一个稳定的落点：界面上选中它、切到细纲层去补规划。
  test('没有细纲的章给出它应该在的位置', () => {
    assert.equal(project.plotPathForNo(12, '夜入青云'), plot);
  });

  // 「第 9 章」是 `listChapters` 给无标题章的回落值——那是没有名字，不是名字。
  test('回落标题不进细纲文件名', () => {
    assert.equal(project.plotPathForNo(9, '第 9 章'), '.novelforge/plots/009.md');
  });
});

describe('数据层 · 细纲读写', () => {
  let plotRel;
  let noPlot;
  let plotBack;
  let listed;
  let nextNo;

  before(async () => {
    noPlot = await project.readPlot('.novelforge/plots/012-夜入青云.md');
    nextNo = await project.nextPlotNo();

    plotRel = await wsOf(project).writePlot(writable(12, '夜入青云', {
      role: '小高潮',
      characters: ['林昭', '沈青'],
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

  test('细纲平铺在 plots/ 根下，名字带三位序号', () => {
    assert.equal(plotRel, '.novelforge/plots/012-夜入青云.md', plotRel);
  });

  test('三节读得回来', () => {
    assert.equal(plotBack.sections.本章目的, '林昭成功进入青云宗。');
    assert.ok(plotBack.sections.关键事件.includes('翻过侧峰'), plotBack.sections.关键事件);
    assert.ok(plotBack.sections.章末钩子.includes('藏书阁'), plotBack.sections.章末钩子);
  });

  test('章号来自文件名', () => {
    assert.equal(plotBack.no, 12);
  });

  test('目标字数读得回来（状态机拿它判「写够没有」）', () => {
    assert.equal(plotBack.targetWords, 3000);
  });

  test('结构功能与计划出场读得回来', () => {
    assert.equal(plotBack.role, '小高潮');
    assert.deepEqual(plotBack.characters, ['林昭', '沈青']);
  });

  test('listPlots 列得到它', () => {
    assert.equal(listed.filter((p) => p.no === 12).length, 1, JSON.stringify(listed.map((p) => p.no)));
  });

  // 跨 plots/ 与 chapters/ 取最大号 +1（见 NovelProject.nextPlotNo 的注释）。
  test('有第 12 章细纲之后，新建细纲落到第 13 章', async () => {
    assert.equal(await project.nextPlotNo(), 13);
  });
});

/**
 * 老工程留下的东西：按卷分的子目录里的细纲、老四节格式的细纲。**解析一律不抛**
 * （第 1 条），读进来如实退化，那些文件一个字节都不动。
 */
describe('数据层 · 老工程的细纲', () => {
  const NESTED = '.novelforge/plots/01-觉醒/001-高烧.md';
  const OLD = '.novelforge/plots/007-老格式.md';
  const OLD_TEXT = '---\nno: 7\ntitle: 老格式\n---\n\n## 目标\n\n进宗门\n\n## 剧情脉络\n\n甲、乙、丙。\n';
  let listed;
  let old;
  let pipe;

  before(async () => {
    t.write(NESTED, '---\nno: 1\n---\n\n## 剧情脉络\n\n老卷里的一段。\n');
    t.write(OLD, OLD_TEXT);
    project.invalidate();
    listed = await project.listPlots();
    old = await project.readPlot(OLD);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 7, plot: old });
  });

  after(() => {
    t.remove('.novelforge/plots/01-觉醒');
    t.remove(OLD);
    project.invalidate();
  });

  // 扫出来只会让同一个章号冒出两份细纲（D11）。
  test('按卷分的子目录不扫', () => {
    assert.ok(!listed.some((p) => p.relPath === NESTED), listed.map((p) => p.relPath).join('|'));
  });

  test('老四节细纲读得出来，不抛', () => {
    assert.equal(old?.no, 7);
    assert.equal(old?.title, '老格式');
  });

  // 「目标」「剧情脉络」都不是新三节里的名字：如实说「待写细纲」，而不是假装排过。
  test('老四节细纲三节全空，算没排过', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(old.sections), JSON.stringify(old.sections));
    assert.equal(pipe.stage, 'plot', pipe.stage);
  });

  test('读一遍不改动那份文件', () => {
    assert.equal(t.read(OLD), OLD_TEXT);
  });
});

/**
 * 细纲改标题 = 改文件名。正文与摘要都挂在**章节**上，不跟着细纲走——从前改细纲名
 * 要连带搬走中转站里那份正文，一章一纲之后正文就是章节，改名不必带走任何东西。
 */
describe('数据层 · 细纲改名', () => {
  const from = '.novelforge/plots/012-夜入青云.md';
  const to = '.novelforge/plots/012-夜入.md';
  let renamed;
  let plotHashBefore;
  let plotHashAfter;
  let pipe;

  before(async () => {
    // 改名前的内容指纹。改名**绝不能**动它：一旦哪个字段进了哈希，
    // 改个名就会让这一章的正文凭空标脏（AGENTS.md 第 18 条 (b)）。
    plotHashBefore = bundle.pipe.plotContentHash(await project.readPlot(from));
    t.write('chapters/012-夜入青云.md', '# 夜入青云\n\n正文若干字。\n');
    project.invalidate();
    await wsOf(project).writeSummary(
      (await project.listChapters()).find((c) => c.order === 12),
      'HASH_X',
      SUMMARY('略'),
      []
    );

    const plot = await project.readPlot(from);
    renamed = await wsOf(project).writePlot({ ...plot, title: '夜入' });
    const after = await project.readPlot(to);
    plotHashAfter = bundle.pipe.plotContentHash(after);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: after });
  });

  test('改名成功', () => {
    assert.equal(renamed, to, String(renamed));
  });

  test('旧的细纲文件不再存在，不会一章两份', () => {
    assert.ok(!t.has(from));
  });

  test('同号的章节不跟着改名', () => {
    assert.ok(t.has('chapters/012-夜入青云.md'));
  });

  test('摘要不跟着搬', () => {
    assert.ok(t.has('.novelforge/summaries/012-夜入青云.md'));
  });

  // 按号认，不按名字：细纲叫「夜入」、章节叫「夜入青云」，仍然是同一章。
  test('改名后按号仍认得同号的章节', () => {
    assert.equal(pipe.chapter.relPath, 'chapters/012-夜入青云.md', JSON.stringify(pipe.chapter));
  });

  // 这一条是防「改个名把整章标脏」的回归线。
  test('细纲的内容指纹没变', () => {
    assert.equal(plotHashAfter, plotHashBefore);
  });
});

/**
 * 新建细纲那条路的主流程：建出来只有序号（`030.md`），细纲排出来才给它起名。
 * 起名走的是 `writePlot`（标题变 → 文件名变），不是 fileOps。
 */
describe('数据层 · 给未命名的细纲起名', () => {
  let bare;
  let named;
  let plotRead;
  let plotText;
  let pipe;

  before(async () => {
    bare = await wsOf(project).writePlot(writable(30, '', { sections: filledSections({ 本章目的: '起个名字。' }) }));
    // 起名之前就有了一章同号的正文（作者手贴的）。
    t.write('chapters/030.md', '未命名时就写了的正文。\n');
    project.invalidate();

    const plot = await project.readPlot(bare);
    named = await wsOf(project).writePlot({ ...plot, title: '风起' });
    plotRead = await project.readPlot(named);
    plotText = t.read('.novelforge/plots/030-风起.md');
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 30, plot: plotRead });
  });

  test('未命名时落成纯序号名', () => {
    assert.equal(bare, '.novelforge/plots/030.md', String(bare));
  });

  test('起名后序号前缀保留，后面补分隔符', () => {
    assert.equal(named, '.novelforge/plots/030-风起.md', String(named));
  });

  test('旧的纯序号文件被删掉，不会一章变两份', () => {
    assert.ok(!t.has('.novelforge/plots/030.md'));
  });

  test('title: 换成真标题', () => {
    assert.equal(plotRead.title, '风起', plotRead.title);
  });

  // 标题行就说「第 N 章」：细纲号 = 章号，从前那个「剧情段 N」的说法没有了。
  test('H1 跟着换成「第N章 标题」', () => {
    assert.ok(plotText.includes('# 第30章 风起'), plotText.slice(0, 300));
  });

  // 章节是作者的文件：给细纲起名不去改它的名字，按号照样认到一起。
  test('同号的正文原地不动，按号照样认到一起', () => {
    assert.ok(t.has('chapters/030.md'));
    assert.equal(pipe.chapter.relPath, 'chapters/030.md', JSON.stringify(pipe.chapter));
  });

  test('流水线这一行的标题取细纲的', () => {
    assert.equal(pipe.title, '风起', pipe.title);
  });
});

describe('新鲜度链', () => {
  const plotRel = '.novelforge/plots/012-夜入.md';
  const CHAPTER = 'chapters/012-夜入青云.md';
  const OUTLINE = '# 大纲\n\n## 第1–20章：第一幕 · 入局\n\n林昭进青云宗。\n';
  let pFresh;
  let pOutlineChanged;
  let pWritten;
  let pPlotChanged;
  let pFinalized;

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
    await wsOf(project).recordWrittenFrom(plotRel, bundle.pipe.plotContentHash(current));
    pWritten = await build();

    // 改细纲 → 这一章的正文标脏。
    const p = await project.readPlot(plotRel);
    p.sections.关键事件 = '改成三拍：等、翻、被撞见。';
    await wsOf(project).writePlot(p);
    pPlotChanged = await build();

    // 定稿：摘要对上正文。定稿过的章即使细纲后来改了也不拉回「待写」。
    const chapter = (await project.listChapters()).find((c) => c.order === 12);
    await wsOf(project).writeSummary(chapter, chapter.contentHash, SUMMARY('夜入青云。'), []);
    pFinalized = await build();
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

  // **定稿过的章不被拉回去**：那是作者已经认可的文字，把它标成「待写正文」是在撺掇他
  // 重写。工程页那一行仍会挂 ⟳ 提醒，够了。
  test('定稿过的章：细纲改了也不退回，只挂 ⟳', () => {
    assert.equal(pFinalized.stage, 'done', pFinalized.stage);
    assert.equal(pFinalized.chapter.upstreamStale, true);
  });

  // 只改 frontmatter 里的 status 不该让下游标脏——`plotContentHash` 只哈希
  // 三个小节（第 18b 条）。
  test('把细纲标成 done 不改变它的内容指纹', async () => {
    const p = await project.readPlot(plotRel);
    const before = bundle.pipe.plotContentHash(p);
    await wsOf(project).writePlot({ ...p, done: true });
    assert.equal(bundle.pipe.plotContentHash(await project.readPlot(plotRel)), before);
  });

  // 作者手工宣布「这一章过了」：只允许向前覆盖推导值。
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
    t.write('.novelforge/plots/020-手写.md', '## 本章目的\n\n我自己写的\n\n## 关键事件\n\nx');
    t.write('chapters/020-手写.md', '# 手写\n\n正文');
    project.invalidate();
    const plot = await project.readPlot('.novelforge/plots/020-手写.md');
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
    assert.equal(index.byNo.get(12)?.plot.relPath, '.novelforge/plots/012-夜入.md');
  });

  test('只有正文的章也占一行，细纲路径是它应该在的位置', () => {
    const row = index.byNo.get(25);
    assert.equal(row?.plot.exists, false, JSON.stringify(row?.plot));
    assert.equal(row?.plot.relPath, '.novelforge/plots/025-只有正文.md');
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

  // 大纲、配置、manifest 与摘要只读一次，跟索引一起返回：工程树与出场索引接着用这一份。
  test('大纲与配置跟索引一起返回', async () => {
    assert.equal(index.outline, await project.readOutline());
    assert.equal(index.config.totalChapters, 60);
    assert.ok(index.summaries && index.manifest, Object.keys(index).join(','));
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
 * 全书状态机要的事实（`buildBookFacts`）。**只有这一份**：主按钮、工程页的全书阶段与
 * agent 的状态注入都吃它（第 20 条）。另起一个工程，从空白一步步推到「在写」。
 */
describe('全书事实 · 从空工程一路推到在写', () => {
  let p;
  let pr;
  const facts = async () => bundle.pipe.buildBookFacts(pr);
  const stageOf = async () => bundle.model.deriveBookStage(await facts());
  let empty;
  let afterSettings;
  let afterPlot;
  let afterChapters;
  let afterEmptyChapter;

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'bookfacts', title: '全书' });
    dirs.push(p.dir);
    pr = p.project;
    empty = { facts: await facts(), stage: await stageOf() };

    // 架构四件与一节大纲。
    p.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查火。\n');
    p.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n回镇 → 被认出。\n');
    p.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n过所制度。\n');
    p.write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    p.write('.novelforge/outline.md', '# 大纲\n\n## 第1–20章：第一幕\n\n进镇。\n');
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

  test('空工程：架构四件都没有，从「架构」开始', () => {
    assert.deepEqual(empty.facts.settings, { config: false, premise: false, characters: false, world: false });
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

  test('架构齐了：四件都认', () => {
    assert.deepEqual(afterSettings.facts.settings, { config: true, premise: true, characters: true, world: true });
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
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/plots/003-夜渡.md');
      assert.deepEqual({ exists: dest.exists, rel: dest.rel, no: dest.no }, { exists: true, rel: 'chapters/003.md', no: 3 });
    });

    test('还没有就是 chapters/NNN-<细纲标题>.md', async () => {
      await wsOf(pr).writePlot(writable(5, '客栈里的女人'));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/plots/005-客栈里的女人.md');
      assert.deepEqual(
        { exists: dest.exists, rel: dest.rel, title: dest.title },
        { exists: false, rel: 'chapters/005-客栈里的女人.md', title: '客栈里的女人' }
      );
    });

    test('细纲没有标题时落成纯序号名', async () => {
      await wsOf(pr).writePlot(writable(6, ''));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelforge/plots/006.md');
      assert.equal(dest.rel, 'chapters/006.md');
    });

    test('认不出章号时抛错，而不是乱落', async () => {
      await assert.rejects(() => bundle.pipe.chapterTargetOf(pr, '.novelforge/plots/没有号.md'), /认不出/);
    });
  });
});

describe('工作区卡', () => {
  const plotRel = '.novelforge/plots/012-夜入.md';
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

    // 正文层摊的是**本章细纲的三节**加篇幅：写正文时最常回头看的是「这一章要落实
    // 哪几件事、结尾留什么钩子」。正文本身上万字，塞进浮窗读不下去。
    ms = await wb({ kind: 'manuscript', plotRelPath: plotRel });

    // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
    const bare = await wsOf(project).writePlot(writable(40, '空骨架', { sections: bundle.plotFile.emptyPlotSections() }));
    skeleton = await wb({ kind: 'plot', plotRelPath: bare });

    // 细纲刚被改名/删除时给一张说得清情况的空卡，而不是让整条推送失败。
    gone = await wb({ kind: 'plot', plotRelPath: '.novelforge/plots/999-不存在.md' });
    outline = await wb({ kind: 'outline' });
    premiseCard = await wb({ kind: 'setting', doc: 'premise' });
    rosterCard = await wb({ kind: 'setting', doc: 'characters' });
  });

  test('细纲卡摊开小节', () => {
    assert.deepEqual(plotCard.sections.map((s) => s.key), ['本章目的', '关键事件', '章末钩子']);
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
    assert.deepEqual(ms.sections.map((s) => s.key), ['篇幅', '本章目的', '关键事件', '章末钩子']);
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
      kind: 'manuscript', plotRelPath: '.novelforge/plots/041-没写字数.md',
    });
    assert.ok(card.sections.every((s) => s.key !== '目标篇幅'), JSON.stringify(card.sections));
  });

  // 上一组改过这一章的细纲，而正文记的还是改之前的指纹。
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
