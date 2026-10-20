/**
 * 新工程的空模板（架构三件、文风、情节大纲、全文大纲）经网关写（AGENTS 第 7 条）。
 *
 * 从前 `model/project.ts` 的 `initialize` 自己 `writeIfAbsent`，绕过了网关。现在分了层：`model/` 只建固定目录、写
 * manifest（`scaffold` / `createManifest`），模板的内容也在那里定义（`newProjectTemplates`，纯数据）；写盘由
 * `Workspace.initializeProject` 经 `write`（`mode: 'create'`）做——`model/` 不能反过来依赖网关。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 新工程照样有这几份空模板，字一个不差 | 行为对作者不变：主按钮仍从「生成小说配置」开始 |
 * | 已经存在的文件一个字节不动 | 与从前 `writeIfAbsent` 同一个口径（第 3 条） |
 * | 不弹审阅、不弹确认、不存历史版本 | 只新建、不覆盖，没有可问的 |
 * | 不让任何东西挂 ⟳、不给已有细纲补指纹 | 第 18 条：模板落盘只经 setting / doc 两种 handler，它们不记账 |
 * | 不刷日志 | 一次初始化不该在日志页留六行 |
 * | `model/` 这一层自己不写模板 | 分层：写盘只在网关 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
const dirs = [];

function tempDir(prefix) {
  const t = makeTempDir(prefix);
  dirs.push(t.dir);
  return t;
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    ws: './src/core/workspace/index.ts',
    actions: './src/core/actions.ts',
    pipe: './src/core/views/pipeline.ts',
    logger: './src/core/runtime/logger.ts',
  });
  h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
});

after(() => {
  for (const dir of dirs) cleanup(dir);
});

const TEMPLATE_RELS = [
  '.novelforge/config.md',
  '.novelforge/premise.md',
  '.novelforge/world.md',
  '.novelforge/style.md',
  '.novelforge/outline.md',
  '.novelforge/summaries/global.md',
];

describe('新建一个空工程', () => {
  let t;
  let project;
  let created;
  let templates;
  let reviewed;
  let confirms;
  let logs;

  before(async () => {
    t = tempDir('newproj');
    project = bundle.project.NovelProject.open(t.dir);
    h.reviewed.length = 0;
    h.confirms.length = 0;
    bundle.logger.clearLogs();
    const mark = bundle.logger.recentLogs().length;
    created = await new bundle.ws.Workspace(project).initializeProject({ title: '雾港', author: '某人' });
    templates = project.newProjectTemplates('雾港');
    reviewed = h.reviewed.length;
    confirms = h.confirms.length;
    logs = bundle.logger.recentLogs().slice(mark).filter((e) => e.level !== 'debug');
  });

  test('模板清单就是这六份', () => {
    assert.deepEqual(templates.map((x) => x.rel).sort(), [...TEMPLATE_RELS].sort());
  });

  test('六份空模板都在，字一个不差', () => {
    for (const { rel, text } of templates) {
      assert.equal(t.read(rel), text, rel);
    }
  });

  test('返回新建了哪几份', () => {
    assert.deepEqual([...created].sort(), [...TEMPLATE_RELS].sort());
  });

  test('情节大纲的模板带作品名', () => {
    assert.match(t.read('.novelforge/outline.md'), /雾港/);
  });

  test('固定目录建好了', () => {
    for (const d of ['chapters', '.novelforge/characters', '.novelforge/lore', '.novelforge/summaries', '.novelforge/sessions']) {
      assert.ok(fs.statSync(t.rel(d)).isDirectory(), d);
    }
  });

  test('manifest 写好了，工程算初始化过', async () => {
    assert.equal(await project.isInitialized(), true);
    const manifest = await project.readManifest();
    assert.equal(manifest.title, '雾港');
    assert.equal(manifest.author, '某人');
  });

  test('空模板不算填过：主按钮仍从「生成小说配置」开始', async () => {
    const filled = await project.settingFilled();
    assert.equal(filled.config, false);
    assert.equal(filled.premise, false);
    assert.equal(filled.world, false);
  });

  test('不弹审阅、不弹确认', () => {
    assert.equal(reviewed, 0);
    assert.equal(confirms, 0);
  });

  test('不存历史版本（没覆盖任何东西）', () => {
    assert.equal(t.has('.novelforge/history'), false);
  });

  test('不刷日志：没有 warn / error，也没有一份模板一行', () => {
    assert.ok(!logs.some((e) => e.level === 'warn' || e.level === 'error'), JSON.stringify(logs));
    assert.ok(logs.length <= 1, JSON.stringify(logs.map((e) => e.message)));
  });
});

describe('在已有东西的目录里初始化：已存在的一个字节不动', () => {
  const AUTHOR_CONFIG = '---\ngenre: 悬疑\n---\n\n# 小说配置\n\n作者自己写好的配置，一个字都不能动。\n';
  const AUTHOR_OUTLINE = '# 情节大纲\n\n## 第 1–10 章\n\n作者写好的大纲。\n';
  const CH = 'chapters/001-楔子.md';
  const PLOT = '.novelforge/summaries/001-楔子.md';
  let t;
  let project;
  let created;
  let plotBefore;
  let pipe;
  let againCreated;
  let snapshot;

  function readAll() {
    return Object.fromEntries(TEMPLATE_RELS.map((rel) => [rel, t.has(rel) && fs.statSync(t.rel(rel)).isFile() ? t.read(rel) : undefined]));
  }

  before(async () => {
    t = tempDir('newproj-existing');
    t.write('.novelforge/config.md', AUTHOR_CONFIG);
    t.write('.novelforge/outline.md', AUTHOR_OUTLINE);
    t.write(CH, '# 楔子\n\n雨下了三天。\n');
    // 一份记过 writtenFrom、没记大纲指纹的细纲：初始化不该给它补 upstreamHash，也不该让正文挂 ⟳。
    const { renderPlotFile, emptyPlotSections, plotContentHash } = bundle.plotFile;
    const sections = { ...emptyPlotSections(), 梗概: '楔子的计划', 关键事件: '- 下雨' };
    t.write(PLOT, renderPlotFile({ no: 1, title: '楔子', upstreamHash: '', writtenFrom: plotContentHash({ sections }), done: false, sections }));
    // 文风的落点上已经有一个目录：从前 writeIfAbsent 看到「有东西」就跳过，现在也一样，不抛。
    fs.mkdirSync(t.rel('.novelforge/style.md'), { recursive: true });
    plotBefore = t.read(PLOT);

    project = bundle.project.NovelProject.open(t.dir);
    created = await new bundle.ws.Workspace(project).initializeProject({ title: '旧稿新开', author: '' });
    project.invalidate();
    const plot = await project.getPlot(1);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 1, plot });

    snapshot = readAll();
    againCreated = await new bundle.ws.Workspace(project).initializeProject({ title: '旧稿新开', author: '' });
  });

  test('作者的配置与大纲一字不动', () => {
    assert.equal(t.read('.novelforge/config.md'), AUTHOR_CONFIG);
    assert.equal(t.read('.novelforge/outline.md'), AUTHOR_OUTLINE);
  });

  test('缺的那几份照样补上', () => {
    assert.deepEqual([...created].sort(), ['.novelforge/premise.md', '.novelforge/summaries/global.md', '.novelforge/world.md'].sort());
  });

  test('落点被目录占着的那一份跳过，不抛', () => {
    assert.ok(fs.statSync(t.rel('.novelforge/style.md')).isDirectory());
  });

  test('已有的细纲一字不动：没被补上 upstreamHash', () => {
    assert.equal(t.read(PLOT), plotBefore);
  });

  test('第 18 条：初始化之后细纲不挂 ⟳、正文不挂 ⟳', () => {
    assert.equal(pipe.plot.upstreamStale, false);
    assert.equal(pipe.chapter.upstreamStale, false);
  });

  test('不存历史版本', () => {
    assert.equal(t.has('.novelforge/history'), false);
  });

  test('再初始化一次：什么都不建、什么都不改', () => {
    assert.deepEqual(againCreated, []);
    assert.deepEqual(readAll(), snapshot);
  });
});

describe('分层：model/ 只建目录与 manifest，不写模板', () => {
  let t;

  before(async () => {
    t = tempDir('newproj-model');
    const project = bundle.project.NovelProject.open(t.dir);
    await project.scaffold();
    await project.createManifest({ title: '只有骨架', author: '' });
  });

  test('目录与 manifest 有了', () => {
    assert.ok(fs.statSync(t.rel('chapters')).isDirectory());
    assert.ok(t.has('.novelforge/project.json'));
  });

  test('一份模板都没写——写模板是网关的事', () => {
    for (const rel of TEMPLATE_RELS) {
      assert.equal(t.has(rel), false, rel);
    }
  });

  test('model/project.ts 里不再有直接写模板的 writeIfAbsent', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/core/model/project.ts'), 'utf8');
    assert.doesNotMatch(src, /writeIfAbsent/);
  });
});

describe('初始化流程（插件命令、网页按钮、CLI 共用的 initProjectFlow）照旧建出模板', () => {
  let t;
  let ok;

  before(async () => {
    t = tempDir('newproj-flow');
    const project = bundle.project.NovelProject.open(t.dir);
    h.expect('流程建的书', '作者甲');
    ok = await bundle.actions.initProjectFlow(project, '默认名');
  });

  test('初始化成功', () => {
    assert.equal(ok, true);
  });

  test('六份模板都在', () => {
    for (const rel of TEMPLATE_RELS) {
      assert.ok(t.has(rel), rel);
    }
    assert.match(t.read('.novelforge/outline.md'), /流程建的书/);
  });
});
