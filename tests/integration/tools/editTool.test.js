/**
 * `edit` 工具：定点替换。
 *
 * 五件事：
 *
 * 1. **唯一才改**——命中多处且没给 all 时报错，且错误里说清几处。
 * 2. **找不到时指路「先 read 一遍」**，否则模型会把同一个 old 再发一遍。
 * 3. **守卫照旧**：越界、回收站一条都不放行。
 * 4. **记账照旧**：改一份细纲照样记 upstreamHash（`ws.edit` 走的是 `write`）。
 * 5. **指纹链不断**：改细纲只动小节文字，正文落盘时记在细纲 frontmatter 上的 `writtenFrom`
 *    原样留着——于是改过细纲之后，同号那一章的正文如实挂 ⟳（细纲在正文之后改过）。
 *    定稿记的 `sourceHash` 也在同一份 frontmatter 里，同样原样留着：定稿过的章只挂 ⟳，不被拉回。
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
let h;
let ctx;

const PLOT_REL = '.novelforge/summaries/001-夜入青云.md';
const CHAPTER_REL = 'chapters/001-夜入青云.md';
const NOTE_REL = '.novelforge/lore/门派.md';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'edit');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    views: './src/core/views/projectView.ts',
    tools: './src/core/tools/novel/index.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });

  h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'agentedit', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.write(
    project.relPath(project.outlinePath),
    { text: '# 大纲\n\n## 第1–20章：入宗\n\n林昭入宗。\n' },
    { mode: 'overwrite' }
  );
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      梗概: '进入宗门',
      出场人物: '林昭',
      关键事件: '林昭踩点，林昭失手，最后翻墙进去。',
      看点: '第三块令牌',
    },
  });
  await ws.write(NOTE_REL, { text: '# 门派\n\n青云宗在北境。\n' }, { mode: 'create' });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('唯一命中就改', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: NOTE_REL, old: '北境', new: '南岭' });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('文件真的改了', async () => {
    const file = await ctx.workspace.read(NOTE_REL);
    assert.ok(file.text.includes('南岭'), file.text);
    assert.ok(!file.text.includes('北境'), file.text);
  });

  test('返回文本说了替换几处、改的是哪份', () => {
    assert.ok(r.text.includes('1 处'), r.text);
    assert.ok(r.text.includes(NOTE_REL), r.text);
  });

  test('display 给界面画一行', () => {
    assert.ok(r.display && r.display.title.includes('edit'), JSON.stringify(r.display));
  });
});

describe('命中多处', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: PLOT_REL, old: '林昭', new: '林昀' });
  });

  test('没给 all 就报错', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 「出场人物」一节里也有一个「林昭」，所以是 3 处——编辑按整份文件的原文算，
  // 不是只看「关键事件」那一节。
  test('错误里说清了命中几处', () => {
    assert.ok(r.error.includes('3 处'), r.error);
  });

  test('错误里给了两条出路（写长一点 / all=true）', () => {
    assert.ok(r.error.includes('all=true'), r.error);
  });

  test('一个字都没改', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昭踩点'), plot.sections.关键事件);
  });

  test('给了 all=true 就全换', async () => {
    resetCtx();
    const ok = await run({ path: PLOT_REL, old: '林昭', new: '林昀', all: true });
    assert.equal(ok.error, undefined, ok.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(!plot.sections.关键事件.includes('林昭'), plot.sections.关键事件);
  });

  // 一期把记账下沉到写入路径本身：edit 也走 write，所以指纹链不会断。
  test('改完照样记 upstreamHash', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.upstreamHash, JSON.stringify(plot.upstreamHash));
  });

  test('把 old 写长一点让它唯一也行', async () => {
    resetCtx();
    const ok = await run({ path: PLOT_REL, old: '林昀失手', new: '林昀被发现' });
    assert.equal(ok.error, undefined, ok.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昀被发现'), plot.sections.关键事件);
  });
});

/**
 * 细纲 → 正文那一环的指纹记在细纲上（`writtenFrom`，正文落盘时记）。edit 改的是
 * 小节里的一句话，**frontmatter 里那条记录必须原样留着**：抹掉它，这一章就再也
 * 不会因为细纲改过而挂 ⟳；留着它、而小节变了，正文就如实显示「与细纲对不上」。
 */
describe('改细纲之后，同号那一章的正文挂 ⟳', () => {
  let before_;
  let after_;
  let writtenFromBefore;

  before(async () => {
    resetCtx();
    const ws = new bundle.ws.Workspace(project);
    // 按当前细纲写出第 1 章的正文，并像正文落盘那一步一样记下细纲指纹。
    await ws.createChapter(1, '夜入青云', '雨下了三天。林昀翻墙进了宗门。');
    const plot = await project.readPlot(PLOT_REL);
    writtenFromBefore = bundle.plotFile.plotContentHash(plot);
    await ws.recordWrittenFrom(PLOT_REL, writtenFromBefore);
    await project.syncManifest();
    before_ = await bundle.views.buildPlotPipelineView(project, PLOT_REL);

    await run({ path: PLOT_REL, old: '最后翻墙进去', new: '最后从后山溜进去' });
    after_ = await bundle.views.buildPlotPipelineView(project, PLOT_REL);
  });

  test('改之前正文不挂 ⟳', () => {
    assert.equal(before_.chapter.upstreamStale, false, JSON.stringify(before_.chapter));
  });

  test('edit 没抹掉 writtenFrom', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.writtenFrom, writtenFromBefore);
  });

  test('改之后正文挂 ⟳', () => {
    assert.equal(after_.chapter.upstreamStale, true, JSON.stringify(after_.chapter));
  });

  // 状态机据此说「重写第 1 章」而不是「定稿」。
  test('状态机把这一章拉回「待写正文」', () => {
    assert.equal(after_.stage, 'manuscript', after_.stage);
  });

  test('正文一个字都没动（编辑细纲不碰章节）', () => {
    assert.ok(t.read(CHAPTER_REL).includes('林昀翻墙进了宗门'), t.read(CHAPTER_REL));
  });
});

/**
 * 细纲与「定稿档案」现在是同一份文件：定稿记的 `sourceHash` 就在 edit 要改的那份 frontmatter 里。
 * edit 只改小节文字，那条记录必须留着——抹掉它，一章写完的书会因为作者顺手改了一句细纲
 * 退回「待定稿」，再定稿一次就是白花一次模型调用。留着它、而小节变了，正文挂 ⟳ 提醒
 * 「定稿之后细纲又改过，正文可能没跟上」（作者定案 7），这一章仍算写完（第 18 条）。
 */
describe('改一份定稿过的细纲：正文挂 ⟳，这一章仍算定稿过', () => {
  const FINAL_REL = '.novelforge/summaries/002-藏书阁.md';
  let sourceHashBefore;
  let after_;

  before(async () => {
    resetCtx();
    const ws = new bundle.ws.Workspace(project);
    await ws.createChapter(2, '藏书阁', '林昀摸进藏书阁，在最底层翻到第三块令牌。');
    await project.syncManifest();
    const chapter = (await project.listChapters()).find((c) => c.order === 2);
    await ws.finalizePlot(
      chapter,
      {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: '林昀夜探藏书阁。',
        出场人物: '林昀',
        关键事件: '林昀摸进藏书阁，翻到第三块令牌。',
      },
      [{ name: '林昀', aliases: [] }]
    );
    sourceHashBefore = (await project.readPlot(FINAL_REL)).sourceHash;

    await run({ path: FINAL_REL, old: '翻到第三块令牌', new: '翻到半块令牌' });
    after_ = await bundle.views.buildPlotPipelineView(project, FINAL_REL);
  });

  test('定稿前提成立：落盘时记下了 sourceHash', () => {
    assert.ok(sourceHashBefore, JSON.stringify(sourceHashBefore));
  });

  test('edit 没抹掉定稿记的 sourceHash', async () => {
    const plot = await project.readPlot(FINAL_REL);
    assert.equal(plot.sourceHash, sourceHashBefore);
  });

  test('改之后正文挂 ⟳', () => {
    assert.equal(after_.chapter.upstreamStale, true, JSON.stringify(after_.chapter));
  });

  test('这一章不被拉回，仍是完成', () => {
    assert.equal(after_.stage, 'done', after_.stage);
  });
});

describe('找不到要替换的内容', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: PLOT_REL, old: '这段话根本不在文件里', new: 'x' });
  });

  test('给 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 只回一句「找不到」，它多半会原地把同一个 old 再发一遍。
  test('指路「先 read 一遍」', () => {
    assert.ok(r.error.includes('read'), r.error);
  });

  test('文件没被动过', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昀被发现'), plot.sections.关键事件);
  });
});

describe('守卫照旧拦着', () => {
  test('越界路径给 error', async () => {
    resetCtx();
    const r = await run({ path: '../../etc/passwd', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('不存在的文件给 error 而不是抛', async () => {
    resetCtx();
    const r = await run({ path: '.novelforge/summaries/999-没有这一章.md', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('回收站里的东西改不了', async () => {
    resetCtx();
    const r = await run({ path: '.novelforge/.trash/x.md', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });
});

describe('参数本身', () => {
  test('path 必填', async () => {
    resetCtx();
    const r = await run({ old: 'a', new: 'b' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('old 不能是空串', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '', new: 'b' });
    assert.ok(r.error && r.error.includes('old'), JSON.stringify(r));
  });

  test('new 缺席就 error', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '青云宗' });
    assert.ok(r.error && r.error.includes('new'), JSON.stringify(r));
  });

  // 删掉一段是合法的编辑。
  test('new 是空串表示删掉这一段', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '在南岭', new: '' });
    assert.equal(r.error, undefined, r.error);
    const file = await ctx.workspace.read(NOTE_REL);
    assert.ok(!file.text.includes('南岭'), file.text);
  });
});

describe('工具定义本身', () => {
  test('标了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('不标 costly（改字不调模型）', () => {
    assert.ok(!tool().costly, String(tool().costly));
  });

  test('参数是扁平的四个标量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['all', 'new', 'old', 'path']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });

  // 不收 edits 数组：一次一处，出错时状态清楚。
  test('不收多处批量编辑', () => {
    assert.ok(!('edits' in tool().parameters.properties), JSON.stringify(tool().parameters.properties));
  });

  test('描述里说清了 old 要逐字相同且唯一', () => {
    assert.ok(tool().description.includes('唯一'), tool().description);
  });
});
