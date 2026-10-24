/**
 * 工程页「新建章节文件」：先问章节名称，正文建出来的同时配好细纲（`actions.ts` 的 `newChapterFlow`）。
 *
 * - 取消就什么都不建；留空照旧是纯序号名。正文是 `.txt`（2026-10-24），细纲照旧是 `.md`。
 * - 这一章还没有细纲：在正文的镜像位置建一份空骨架，标题就是这个名字，没有上游指纹，还算「没拆细纲」。
 * - 这一章已经排好了细纲：名字先填它的标题，正文落进它所在的子目录，不另建一份；名字改了，细纲跟着新正文改名、
 *   改标题，作者在细纲里手加的东西一个字不丢。
 *
 * 2026-10-23 作者定案：从前「不问标题、只建 0 字正文」，现在要先问名字、自动建细纲模板。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('新建章节文件：先问名字、配上细纲', () => {
  let bundle;
  let h;
  let t;
  let project;
  let actions;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      actions: './src/core/actions.ts',
      plotFile: './src/core/model/plotFile.ts',
    });
    actions = bundle.actions;
    h = makeFakeHost();
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'new-chapter', title: '新建章节' });
    project = t.project;
    t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    project.invalidate();
  });

  after(() => cleanup(t.dir));

  describe('取消', () => {
    let result;
    let chapters;
    let plots;

    before(async () => {
      h.expect(undefined);
      result = await actions.newChapterFlow(project);
      project.invalidate();
      chapters = (await project.listChapters()).length;
      plots = (await project.listPlots()).length;
    });

    test('返回 undefined，正文与细纲都没建', () => {
      assert.equal(result, undefined);
      assert.equal(chapters, 1);
      assert.equal(plots, 0);
    });
  });

  describe('这一章还没有细纲：建一份空骨架', () => {
    let rel;
    let ask;
    let body;
    let plot;
    let paired;
    let toasts;

    before(async () => {
      h.expect('夜入 青云');
      rel = await actions.newChapterFlow(project);
      ask = h.inputs[0];
      toasts = [...h.toasts];
      body = t.read(rel);
      project.invalidate();
      plot = await project.readPlot('.novelforge/summaries/002-夜入-青云.md');
      paired = (await project.getPlot(2))?.relPath;
    });

    test('先弹「新建第 N 章」，没有预填', () => {
      assert.equal(ask?.title, '新建第 2 章');
      assert.equal(ask?.value, '');
    });

    // 2026-10-24 作者定：新建章节文件默认 .txt，纯文本不写标题行（标题从文件名取）。
    test('正文按名字建出来，是 .txt、不带标题行', () => {
      assert.equal(rel, 'chapters/002-夜入-青云.txt');
      assert.equal(body, '\n');
    });

    test('细纲建在正文的镜像位置，按路径配得上', () => {
      assert.equal(paired, '.novelforge/summaries/002-夜入-青云.md');
    });

    test('细纲的标题与文件名同一份清洗过的名字', () => {
      assert.equal(plot?.title, '夜入-青云');
    });

    test('是空骨架：没有上游指纹，还算没拆细纲', () => {
      assert.equal(plot?.upstreamHash, '');
      assert.equal(bundle.plotFile.isPlotFilled(plot.sections), false);
    });

    test('提示里报了细纲的路径', () => {
      assert.ok(toasts.some((x) => x.includes('.novelforge/summaries/002-夜入-青云.md')), toasts.join(' | '));
    });
  });

  describe('名字留空：纯序号名，细纲也是纯序号名', () => {
    let rel;
    let plotRel;

    before(async () => {
      h.expect('');
      rel = await actions.newChapterFlow(project);
      project.invalidate();
      plotRel = (await project.getPlot(3))?.relPath;
    });

    test('正文是纯序号名', () => {
      assert.equal(rel, 'chapters/003.txt');
    });

    test('细纲也建了', () => {
      assert.equal(plotRel, '.novelforge/summaries/003.md');
    });
  });

  describe('这一章已经排好了细纲', () => {
    const PLAN = (no, title) =>
      `---\nno: ${no}\ntitle: ${title}\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n${title}的梗概。\n\n## 作者备注\n\n别忘了伏笔。\n`;
    let same;
    let sameAsk;
    let sameBytes;
    let sameCount;
    let renamed;
    let renamedAsk;
    let renamedPlot;
    let oldGone;

    before(async () => {
      // 正文写到第 3 章，细纲已经排到了第二卷的第 4、5 章。
      t.write('.novelforge/summaries/第二卷/004-雪夜.md', PLAN(4, '雪夜'));
      t.write('.novelforge/summaries/第二卷/005-风起.md', PLAN(5, '风起'));
      project.invalidate();

      h.expect('雪夜');
      same = await actions.newChapterFlow(project);
      sameAsk = h.inputs[0];
      sameBytes = t.read('.novelforge/summaries/第二卷/004-雪夜.md');
      project.invalidate();
      sameCount = (await project.listPlots()).filter((p) => p.no === 4).length;

      h.expect('夜行');
      renamed = await actions.newChapterFlow(project);
      renamedAsk = h.inputs[0];
      renamedPlot = t.has('.novelforge/summaries/第二卷/005-夜行.md') ? t.read('.novelforge/summaries/第二卷/005-夜行.md') : undefined;
      oldGone = !t.has('.novelforge/summaries/第二卷/005-风起.md');
    });

    test('名字先填了细纲的标题', () => {
      assert.equal(sameAsk?.value, '雪夜');
      assert.equal(renamedAsk?.value, '风起');
    });

    test('正文落进细纲所在的子目录', () => {
      assert.equal(same, 'chapters/第二卷/004-雪夜.txt');
      assert.equal(renamed, 'chapters/第二卷/005-夜行.txt');
    });

    test('名字没改：细纲一个字节不动，也不另建一份', () => {
      assert.equal(sameBytes, PLAN(4, '雪夜'));
      assert.equal(sameCount, 1);
    });

    test('名字改了：细纲跟着新正文改名、改标题', () => {
      assert.ok(oldGone);
      assert.ok(renamedPlot && renamedPlot.includes('title: 夜行') && renamedPlot.includes('# 第5章 夜行'), String(renamedPlot));
    });

    test('细纲里别的内容原样留着（梗概、作者手加的小节）', () => {
      assert.ok(renamedPlot.includes('风起的梗概') && renamedPlot.includes('别忘了伏笔'), renamedPlot);
    });
  });
});
