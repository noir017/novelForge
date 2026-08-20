/**
 * `edit` 工具：定点替换。
 *
 * 四件事：
 *
 * 1. **唯一才改**——命中多处且没给 all 时报错，且错误里说清几处。
 * 2. **找不到时指路「先 read 一遍」**，否则模型会把同一个 old 再发一遍。
 * 3. **守卫照旧**：越界、回收站一条都不放行。
 * 4. **记账照旧**：改一份细纲照样记 upstreamHash（`ws.edit` 走的是 `write`）。
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

const PLOT_REL = '.novelforge/plots/001-夜入青云.md';
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
    { text: '# 大纲\n\n林昭入宗。\n' },
    { mode: 'overwrite' }
  );
  await ws.writePlot({
    no: 1,
    title: '夜入青云',
    arc: '',
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      目标: '进入宗门',
      剧情脉络: '林昭踩点，林昭失手，最后翻墙进去。',
      冲突与转折: '守卫换班',
      伏笔与回收: '第三块令牌',
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

  test('错误里说清了命中几处', () => {
    assert.ok(r.error.includes('2 处'), r.error);
  });

  test('错误里给了两条出路（写长一点 / all=true）', () => {
    assert.ok(r.error.includes('all=true'), r.error);
  });

  test('一个字都没改', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.剧情脉络.includes('林昭踩点'), plot.sections.剧情脉络);
  });

  test('给了 all=true 就全换', async () => {
    resetCtx();
    const ok = await run({ path: PLOT_REL, old: '林昭', new: '林昀', all: true });
    assert.equal(ok.error, undefined, ok.error);
    assert.ok(ok.text.includes('2 处'), ok.text);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(!plot.sections.剧情脉络.includes('林昭'), plot.sections.剧情脉络);
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
    assert.ok(plot.sections.剧情脉络.includes('林昀被发现'), plot.sections.剧情脉络);
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
    assert.ok(plot.sections.剧情脉络.includes('林昀被发现'), plot.sections.剧情脉络);
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
    const r = await run({ path: '.novelforge/plots/999-没有这一章.md', old: 'a', new: 'b' });
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
