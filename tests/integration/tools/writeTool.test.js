/**
 * `write` 工具：agent 的落盘口。
 *
 * 这里钉五件事，每一件都是这一层特有的（写盘本身的行为由
 * `tests/integration/workspace/*.test.js` 守着）：
 *
 * 1. **`review` 永远 true，且不是工具参数**——模型没有关掉审阅的口子。
 *    细纲与正文（`chapters/` 下的章节）走的是同一个网关、同一张审阅框。
 * 2. **draftId 找不到 / 是讨论类产出 → error，绝不静默写空文件。**
 * 3. **作者拒绝 → 磁盘一字未改，且回给模型的话要说清「没有采纳」**，
 *    否则它会原地重试同一个动作。
 * 4. **守卫照旧拦**：越界、受保护路径、同名不覆盖，一条都不放行。
 * 5. **写失败挂一条失败记录**（第 16 条），成功清掉。
 *
 * 顺带钉住一期下沉到写入路径上的记账：细纲的 `upstreamHash` 记的是**大纲里覆盖
 * 本章那一节**的指纹，不是全书大纲的——续写后面一段大纲不该让前面的细纲挂 ⟳。
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
/** DraftStore 的替身：按 id 取。 */
let drafts;
let reports;

const PLOT_REL = '.novelforge/plots/001-夜入青云.md';
const PLOT2_REL = '.novelforge/plots/002-藏书阁.md';
const CHAPTER_REL = 'chapters/003-雪夜.md';
/** 两节的大纲：第 1 章落在前一节里。 */
const OUTLINE = '# 大纲\n\n## 第1–20章：入宗\n\n林昭入宗。\n\n## 第21–40章：下山\n\n林昭下山。\n';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
const run = (args) => tool().run(ctx, args);

/** 一份「已解析出结构化产物」的细纲草稿（D3 三节 + 规划字段）。 */
function plotDraft(id, sections) {
  return {
    id,
    action: { stage: 'plot', capability: 'generate' },
    target: { kind: 'plot', plotRelPath: PLOT_REL },
    raw: '…',
    artifact: { kind: 'plot', sections, role: '开篇', characters: ['林昭', '沈青'], title: '模型起的名字' },
    summary: '细纲 · 3/3 节',
    words: 620,
    createdAt: new Date().toISOString(),
  };
}

function sections(events) {
  return {
    ...bundle.plotFile.emptyPlotSections(),
    本章目的: '进入宗门',
    关键事件: events,
    章末钩子: '第三块令牌',
  };
}

function resetCtx() {
  reports = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: (id) => drafts.get(id), put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: () => {},
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    tools: './src/core/tools/novel/index.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });

  h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'agentwrite', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 大纲要有内容，upstreamHash 才记得上（空大纲不该凭空标脏）。
  await ws.write(project.relPath(project.outlinePath), { text: OUTLINE }, { mode: 'overwrite' });
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no,
      title,
      role: '',
      characters: [],
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 本章目的: '进入宗门' },
    });
  }
  await project.syncManifest();

  drafts = new Map([
    ['d-plot', plotDraft('d-plot', sections('踩点、失手、翻墙；收在藏书阁门口。'))],
    ['d-plot2', plotDraft('d-plot2', sections('第二版：先探后翻。'))],
    // 讨论类产出：没有 artifact。
    [
      'd-talk',
      {
        id: 'd-talk',
        action: { stage: 'plot', capability: 'discuss' },
        target: { kind: 'plot', plotRelPath: PLOT_REL },
        raw: '这一章的动机不够。',
        words: 9,
        createdAt: new Date().toISOString(),
      },
    ],
  ]);
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('用 draftId 写一份细纲', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ path: PLOT_REL, draftId: 'd-plot', mode: 'overwrite' });
  });

  test('没有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('内容真的落盘了', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('踩点、失手、翻墙'), JSON.stringify(plot.sections));
  });

  // 一期把记账下沉到写入路径本身：谁写都记。
  test('upstreamHash 记上了', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.upstreamHash, JSON.stringify(plot.upstreamHash));
  });

  // ★ 记的是覆盖第 1 章那一节的指纹：以后续写第 21–40 章那一节，第 1 章不挂 ⟳。
  test('upstreamHash 是大纲里覆盖本章那一节的指纹，不是全书的', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.upstreamHash, bundle.outlineFile.outlineUpstreamHash(OUTLINE, 1));
    assert.notEqual(plot.upstreamHash, bundle.outlineFile.outlineUpstreamHash(OUTLINE, undefined));
  });

  test('标题没被抹掉（重写细纲不动作者起的名字）', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.title, '夜入青云');
  });

  // 结构功能与计划出场的人是规划的一部分，跟着产物走。
  test('规划字段（role / characters）随产物落盘', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.role, '开篇');
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
  });

  test('返回文本里有落点与字数', () => {
    assert.ok(r.text.includes(PLOT_REL), r.text);
    assert.ok(/\d+ 字/.test(r.text), r.text);
  });

  test('display 给界面画一行', () => {
    assert.ok(r.display && r.display.title.includes('write'), JSON.stringify(r.display));
  });
});

describe('覆盖已有内容一定先请作者过目', () => {
  test('作者同意就覆盖', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: PLOT_REL, draftId: 'd-plot2', mode: 'overwrite' });
    assert.equal(r.error, undefined, r.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探后翻'), JSON.stringify(plot.sections));
  });

  test('确实弹了审阅（不是默默覆盖）', () => {
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
  });

  // 细纲号 = 章号：框上说「第 1 章的细纲」，与创作页、工程页是同一个说法，
  // 框里紧接着还要显示路径，两者对得上作者才认得出是同一份文件。
  test('审阅框上写的是「第 1 章的细纲」而不是路径', () => {
    assert.equal(h.reviewed[0].name, '第 1 章的细纲');
  });

  let rejected;
  test('作者拒绝时磁盘一字未改', async () => {
    resetCtx();
    h.setReviewVerdict('discard');
    h.expect();
    rejected = await run({ path: PLOT_REL, draftId: 'd-plot', mode: 'overwrite' });
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探后翻'), JSON.stringify(plot.sections));
  });

  // 不说清楚它会原地重试——那是最常见的烧钱方式。
  test('回给模型的话说清了作者没有采纳', () => {
    assert.ok(rejected.text.includes('没有采纳'), rejected.text);
  });

  test('还明说了不要重试同一个动作', () => {
    assert.ok(rejected.text.includes('不要重试'), rejected.text);
  });

  test('拒绝不算 error（那是作者的决定，不是故障）', () => {
    assert.equal(rejected.error, undefined, rejected.error);
  });
});

/**
 * 一章一纲之后正文直接落 `chapters/`：章节是作者的文件（第 9 条），覆盖它比覆盖
 * 一份细纲更要紧，所以同一张审阅框必须照样弹。
 */
describe('正文（章节）走同一个网关', () => {
  test('新建一章不打扰作者', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '雪下了一夜。' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((x) => x.name)));
    assert.ok(t.read(CHAPTER_REL).includes('雪下了一夜'), t.read(CHAPTER_REL));
  });

  test('新建的章节进了章节列表', async () => {
    const chapters = await project.listChapters();
    assert.ok(chapters.some((c) => c.relPath === CHAPTER_REL && c.order === 3), JSON.stringify(chapters.map((c) => c.relPath)));
  });

  test('覆盖一章正文先请作者过目，框上写「第 3 章」', async () => {
    resetCtx();
    h.setReviewVerdict('discard');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '整章换掉。', mode: 'overwrite' });
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
    assert.equal(h.reviewed[0].name, '第 3 章');
    assert.ok(r.text.includes('没有采纳'), r.text);
  });

  test('作者拒绝后正文一字未改', () => {
    assert.ok(t.read(CHAPTER_REL).includes('雪下了一夜') && !t.read(CHAPTER_REL).includes('整章换掉'), t.read(CHAPTER_REL));
  });

  // 追加是写正文的常态（「接着写」），不打扰作者。
  test('追加不弹审阅', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '天亮了。', mode: 'append' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(h.reviewed.length, 0);
    assert.ok(t.read(CHAPTER_REL).includes('天亮了'), t.read(CHAPTER_REL));
  });
});

describe('draftId 认不出来', () => {
  let r;

  before(async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    r = await run({ path: PLOT2_REL, draftId: '并不存在', mode: 'overwrite' });
  });

  test('给 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 静默降级成写空文件，等于把一份细纲抹平。
  test('没写盘', async () => {
    const plot = await project.readPlot(PLOT2_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('error 里说了该怎么办', () => {
    assert.ok(r.error.includes('generate') || r.error.includes('content'), r.error);
  });
});

describe('讨论类 draft 不能写成产物', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ path: PLOT2_REL, draftId: 'd-talk', mode: 'overwrite' });
  });

  test('给 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  test('没写盘', async () => {
    const plot = await project.readPlot(PLOT2_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('error 说清了它是讨论类产出', () => {
    assert.ok(/讨论|挑刺/.test(r.error), r.error);
  });
});

describe('八条守卫照旧拦着', () => {
  test('越界路径给 error', async () => {
    resetCtx();
    const r = await run({ path: '../../etc/passwd', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('工程目录'), r.error);
  });

  test('绝对路径给 error', async () => {
    resetCtx();
    const r = await run({ path: '/tmp/x.md', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('写进回收站给 error', async () => {
    resetCtx();
    const r = await run({ path: '.novelforge/.trash/x.md', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('固定目录本身给 error', async () => {
    resetCtx();
    const r = await run({ path: '.novelforge/plots', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('mode=create 撞上已有文件给 error，并指路到 overwrite', async () => {
    resetCtx();
    const r = await run({ path: PLOT_REL, content: 'x' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('overwrite'), r.error);
  });

  test('create 撞名时磁盘没被动过', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探后翻'), JSON.stringify(plot.sections));
  });
});

describe('写失败要留在出错的东西身上', () => {
  before(async () => {
    resetCtx();
    await bundle.errorLog.clearFailures(project, 'plot', PLOT2_REL, 'agentWrite');
    // create 撞上已有文件：守卫拦下，这一章一字未改，但作者要看得出「刚才那一下没成」。
    await run({ path: PLOT2_REL, content: 'x' });
  });

  test('errorLog 里挂上了一条', async () => {
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.ok(byTarget[PLOT2_REL], JSON.stringify(Object.keys(byTarget)));
  });

  test('挂在那一章的细纲上，而且写清了是哪个动作', async () => {
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.ok(byTarget[PLOT2_REL].some((f) => f.message.includes('写入')), JSON.stringify(byTarget[PLOT2_REL]));
  });

  // 修好了还挂着标记，用户会学会无视它。
  test('成功一次就清掉', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    await run({ path: PLOT2_REL, draftId: 'd-plot', mode: 'overwrite' });
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.equal(byTarget[PLOT2_REL], undefined, JSON.stringify(byTarget[PLOT2_REL]));
  });
});

describe('参数本身', () => {
  test('path 必填', async () => {
    resetCtx();
    const r = await run({ content: 'x' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('draftId 与 content 都不给就 error', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('draftId 与 content 都给也 error（不猜它想写哪个）', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL, draftId: 'd-plot', content: 'x' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('认不出的 mode 给 error', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL, content: 'x', mode: '强制覆盖' });
    assert.ok(r.error && r.error.includes('mode'), JSON.stringify(r));
  });
});

describe('工具定义本身', () => {
  test('标了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('不标 costly（写盘不调模型）', () => {
    assert.ok(!tool().costly, String(tool().costly));
  });

  // ★ 模型不该有关掉审阅的口子。
  test('review 不是工具参数', () => {
    assert.ok(!('review' in tool().parameters.properties), JSON.stringify(tool().parameters.properties));
  });

  test('参数是扁平的四个标量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['content', 'draftId', 'mode', 'path']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });

  test('描述里说清了覆盖会请作者过目', () => {
    assert.ok(tool().description.includes('过目') || tool().description.includes('审阅'), tool().description);
  });

  // 删除/改名/移动收益接近零，误操作的收拾成本极高。
  test('描述里明说没有删除/改名/移动', () => {
    assert.ok(tool().description.includes('删除'), tool().description);
  });
});
