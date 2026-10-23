/**
 * 分卷（2026-10-23 作者要求：工程页「章节」页签按卷分类、右键新建卷、新建的默认放进最新一卷）。
 *
 * 卷 = `chapters/` 下的一级目录，细纲在 `summaries/` 下镜像同一个目录。卷只是收纳，章号全书连续。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 新章的落点 | 没有空卷时跟上一章；右键「新建卷」（`newFolder` 落在章节根，问的是卷名、toast 说卷）之后接在最后的新章落进那一卷——细纲与「新建章节文件」都是；卷里有了章就照旧跟上一章；补中间空着的章号不被拉进新卷；卷里再建的子目录照旧叫文件夹 |
 * | 卷的列表 | `listVolumes` 只要一级目录，空的也在，名字里的数字按大小排 |
 * | 工程树 | 每行的 `volume`（有正文看正文、只有细纲看细纲，卷里再分的子目录算在这一卷）；`volumes` 按最小章号排、空卷殿后、根下的章是「未分卷」、只有细纲的卷也算；`latest` 与真正的落点一致；一卷都没有是空数组 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const CH = '# 正文\n\n雨下了三天。\n';

let bundle;
let h;

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    actions: './src/core/actions.ts',
    fileOps: './src/core/files/fileOps.ts',
    workspace: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    projectView: './src/core/views/projectView.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
});

describe('新章的落点：默认进最新的一卷', () => {
  let t;
  let project;
  const results = {};

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'volumes-landing', title: '分卷' });
    project = t.project;
    t.write('chapters/第一卷/001-楔子.md', CH);
    t.write('chapters/第一卷/002-入镇.md', CH);
    project.invalidate();

    results.beforeVolume = await project.subdirForNewChapter(3);

    h.expect('第二卷');
    results.created = await bundle.fileOps.newFolder(project, 'chapters', 'chapters');
    results.ask = h.inputs.at(-1);
    results.toast = h.toasts.at(-1);
    results.afterVolume = await project.subdirForNewChapter(3);
    results.plotPath = await project.plotPathForNewChapter(3, '雪夜');

    h.expect('雪夜');
    results.chapter = await bundle.actions.newChapterFlow(project);
    project.invalidate();
    results.plotOfChapter = (await project.getPlot(3))?.relPath;
    results.next = await project.subdirForNewChapter(4);

    // 第 10 章在第一卷、又建了一卷空的第三卷：接在最后（11）进第三卷，补中间空着的第 5 章仍跟上一章（第 3 章，第二卷）。
    t.write('chapters/第一卷/010-远方.md', CH);
    project.invalidate();
    h.expect('第三卷');
    await bundle.fileOps.newFolder(project, 'chapters', 'chapters');
    results.append = await project.subdirForNewChapter(11);
    results.gap = await project.subdirForNewChapter(5);

    h.expect('上');
    results.nested = await bundle.fileOps.newFolder(project, 'chapters', 'chapters/第一卷');
    results.nestedAsk = h.inputs.at(-1);
  });

  after(() => cleanup(t.dir));

  test('没有空卷时跟上一章', () => {
    assert.equal(results.beforeVolume, '第一卷');
  });

  test('「新建卷」建在章节根下，问的是卷名', () => {
    assert.equal(results.created, 'chapters/第二卷');
    assert.ok(fs.statSync(t.rel('chapters/第二卷')).isDirectory());
    assert.equal(results.ask.title, '新建卷', JSON.stringify(results.ask));
    assert.match(results.ask.placeHolder, /第二卷/);
  });

  test('toast 说新章会落进这一卷', () => {
    assert.match(results.toast, /^info: 已新建卷 chapters\/第二卷.*落进这一卷/);
  });

  test('建了空卷之后，接在最后的新章（细纲）落进它', () => {
    assert.equal(results.afterVolume, '第二卷');
    assert.equal(results.plotPath, '.novelforge/summaries/第二卷/003-雪夜.md');
  });

  test('「新建章节文件」不给落点也进最新的一卷，细纲跟着镜像', () => {
    assert.equal(results.chapter, 'chapters/第二卷/003-雪夜.md');
    assert.equal(results.plotOfChapter, '.novelforge/summaries/第二卷/003-雪夜.md');
  });

  test('卷里有了章，下一章照旧跟上一章', () => {
    assert.equal(results.next, '第二卷');
  });

  test('又建了一卷：接在最后的进新卷，补中间的章号仍跟上一章', () => {
    assert.equal(results.append, '第三卷');
    assert.equal(results.gap, '第二卷');
  });

  test('卷里再建的子目录照旧叫文件夹', () => {
    assert.equal(results.nested, 'chapters/第一卷/上');
    assert.equal(results.nestedAsk.title, '新建文件夹', JSON.stringify(results.nestedAsk));
  });
});

describe('卷的列表', () => {
  let t;
  let volumes;

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'volumes-list', title: '分卷' });
    t.write('chapters/第10卷/001-甲.md', CH);
    t.write('chapters/第2卷/上/002-乙.md', CH);
    t.write('chapters/003-丙.md', CH);
    fs.mkdirSync(t.rel('chapters/第3卷'));
    t.project.invalidate();
    volumes = await t.project.listVolumes();
  });

  after(() => cleanup(t.dir));

  test('只要一级目录，空的也在，数字按大小排', () => {
    assert.deepEqual(volumes, ['第2卷', '第3卷', '第10卷']);
  });
});

describe('工程树：章节按卷分段', () => {
  let t;
  let tree;
  let withoutEmpty;
  let flat;

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'volumes-tree', title: '分卷' });
    const project = t.project;
    // 第 1 章是序章、直接在根下；2–3 章在第一卷（第 3 章在卷里再分的「下」里）；第 4 章只拆了细纲、落在第二卷
    // （chapters/第二卷 还没有）；第三卷刚建、空着。
    t.write('chapters/001-序章.md', CH);
    t.write('chapters/第一卷/002-入镇.md', CH);
    t.write('chapters/第一卷/下/003-夜访.md', CH);
    project.invalidate();
    const ws = new bundle.workspace.Workspace(project);
    await ws.writePlot(
      { no: 4, title: '北行', upstreamHash: '', done: false, sections: bundle.plotFile.emptyPlotSections() },
      undefined,
      '.novelforge/summaries/第二卷/004.md'
    );
    fs.mkdirSync(t.rel('chapters/第三卷'));
    project.invalidate();
    tree = await bundle.projectView.buildProjectTree(project);

    fs.rmdirSync(t.rel('chapters/第三卷'));
    project.invalidate();
    withoutEmpty = await bundle.projectView.buildProjectTree(project);

    const plain = await makeTempProject(bundle.project, { prefix: 'volumes-flat', title: '不分卷' });
    plain.write('chapters/001-楔子.md', CH);
    plain.project.invalidate();
    flat = await bundle.projectView.buildProjectTree(plain.project);
    cleanup(plain.dir);
  });

  after(() => cleanup(t.dir));

  test('每行带它所在的卷：有正文看正文，只有细纲看细纲，卷里的子目录算在这一卷', () => {
    assert.deepEqual(
      tree.plots.map((p) => [p.no, p.volume]),
      [[1, ''], [2, '第一卷'], [3, '第一卷'], [4, '第二卷']]
    );
  });

  test('卷按最小章号排，空卷殿后，根下的章是「未分卷」', () => {
    assert.deepEqual(
      tree.volumes.map(({ name, relPath, from, to, latest }) => ({ name, relPath, from, to, latest })),
      [
        { name: '', relPath: 'chapters', from: 1, to: 1, latest: false },
        { name: '第一卷', relPath: 'chapters/第一卷', from: 2, to: 3, latest: false },
        { name: '第二卷', relPath: 'chapters/第二卷', from: 4, to: 4, latest: false },
        { name: '第三卷', relPath: 'chapters/第三卷', from: undefined, to: undefined, latest: true },
      ]
    );
  });

  test('字数按卷加', () => {
    const words = Object.fromEntries(tree.volumes.map((v) => [v.name, v.words]));
    assert.equal(words['第三卷'], 0);
    assert.equal(words['第二卷'], 0);
    assert.ok(words['第一卷'] > 0 && words[''] > 0, JSON.stringify(words));
  });

  test('没有空卷时，落点是最后一章所在的那一卷', () => {
    assert.deepEqual(
      withoutEmpty.volumes.filter((v) => v.latest).map((v) => v.name),
      ['第二卷']
    );
  });

  test('一卷都没有就是空数组', () => {
    assert.deepEqual(flat.volumes, []);
    assert.equal(flat.plots[0].volume, '');
  });
});
