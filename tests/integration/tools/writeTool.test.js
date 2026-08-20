/**
 * `write` 工具：agent 的落盘口。
 *
 * 这里钉五件事，每一件都是这一层特有的（写盘本身的行为由
 * `tests/integration/workspace/*.test.js` 守着）：
 *
 * 1. **`review` 永远 true，且不是工具参数**——模型没有关掉审阅的口子。
 * 2. **draftId 找不到 / 是讨论类产出 → error，绝不静默写空文件。**
 * 3. **作者拒绝 → 磁盘一字未改，且回给模型的话要说清「没有采纳」**，
 *    否则它会原地重试同一个动作。
 * 4. **守卫照旧拦**：越界、受保护路径、同名不覆盖，一条都不放行。
 * 5. **写失败挂一条失败记录**（第 16 条），成功清掉。
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

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
const run = (args) => tool().run(ctx, args);

/** 一份「已解析出结构化产物」的草稿。 */
function plotDraft(id, sections) {
  return {
    id,
    action: { stage: 'plot', capability: 'generate' },
    target: { kind: 'plot', plotRelPath: PLOT_REL },
    raw: '…',
    artifact: { kind: 'plot', sections },
    summary: '剧情 · 4/4 节',
    words: 620,
    createdAt: new Date().toISOString(),
  };
}

function sections(trunk) {
  return {
    ...bundle.plotFile.emptyPlotSections(),
    目标: '进入宗门',
    剧情脉络: trunk,
    冲突与转折: '三拍推进',
    伏笔与回收: '第三块令牌',
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
  await ws.write(project.relPath(project.outlinePath), { text: '# 大纲\n\n林昭入宗。\n' }, { mode: 'overwrite' });
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no,
      title,
      arc: '',
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 目标: '进入宗门' },
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
    assert.ok(plot.sections.剧情脉络.includes('踩点、失手、翻墙'), JSON.stringify(plot.sections));
  });

  // 一期把记账下沉到写入路径本身：谁写都记。
  test('upstreamHash 记上了（大纲指纹）', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.upstreamHash, JSON.stringify(plot.upstreamHash));
  });

  test('标题没被抹掉（重写剧情不动作者起的名字）', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.title, '夜入青云');
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
    assert.ok(plot.sections.剧情脉络.includes('先探后翻'), JSON.stringify(plot.sections));
  });

  test('确实弹了审阅（不是默默覆盖）', () => {
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
  });

  // 报的是**段号**（文件名前缀），不是界面上那个「剧情 N」位次：框里紧接着
  // 还要显示路径，两者对得上作者才认得出是同一份文件。
  test('审阅框上写的是「剧情段 1 的细纲」而不是路径', () => {
    assert.equal(h.reviewed[0].name, '剧情段 1 的细纲');
  });

  let rejected;
  test('作者拒绝时磁盘一字未改', async () => {
    resetCtx();
    h.setReviewVerdict('discard');
    h.expect();
    rejected = await run({ path: PLOT_REL, draftId: 'd-plot', mode: 'overwrite' });
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.剧情脉络.includes('先探后翻'), JSON.stringify(plot.sections));
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
    assert.ok(plot.sections.剧情脉络.includes('先探后翻'), JSON.stringify(plot.sections));
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
