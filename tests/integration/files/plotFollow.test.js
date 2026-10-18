/**
 * 细纲跟着正文走：细纲镜像正文在章节根下的相对路径（`chapters/第一卷/003-深处.txt` ↔
 * `summaries/第一卷/003-深处.md`），与草稿同一套镜像。
 *
 * - 工程页给正文改名、移动（单章或整个卷目录）时，细纲一并搬过去（`handlers/chapter.ts` 的 `carryPlot`）；
 *   不搬的话这一章立刻变成「还没有细纲」，排好的计划与定稿的档案都还躺在旧路径下。
 * - 目标位置已有细纲时不覆盖，两份都留着、说出来（第 3 条）。
 * - 删正文不删细纲：它退回这一章的计划。
 * - 照细纲新写一章正文时，细纲的文件名与新正文对不上（还没起名时建的 `030.md`）就跟着改名
 *   （`Workspace.createChapterAt`），两边从此按路径认得出彼此。
 *
 * 2026-10-18 作者定案：「必须要保证相对路径，无相对路径是绝对错的」；工程页里改名、移动，细纲跟着走。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const PLOT = (no, title, extra = '') =>
  `---\nno: ${no}\ntitle: ${title}\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n${title}的梗概。\n\n## 关键事件\n\n- ${title}${extra}\n`;

describe('细纲跟着正文走', () => {
  let bundle;
  let h;
  let t;
  let project;
  let fileOps;
  const wsOf = (p) => new bundle.ws.Workspace(p);

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      ws: './src/core/workspace/index.ts',
      fileOps: './src/core/files/fileOps.ts',
      plotFile: './src/core/model/plotFile.ts',
    });
    fileOps = bundle.fileOps;
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'plot-follow', title: '分卷' });
    project = t.project;
  });

  after(() => cleanup(t.dir));

  describe('改名、移动单章', () => {
    let renamed;
    let renamedPlot;
    let oldPlotGone;
    let moved;
    let movedPlot;
    let txtRenamed;
    let txtPlot;

    before(async () => {
      t.write('chapters/第一卷/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      t.write('.novelforge/summaries/第一卷/001-楔子.md', PLOT(1, '楔子'));
      t.write('chapters/第一卷/002-手记.txt', '他翻开笔记。\n');
      t.write('.novelforge/summaries/第一卷/002-手记.md', PLOT(2, '手记'));
      project.invalidate();

      h.expect('入镇');
      renamed = await fileOps.renameEntry(project, 'chapters/第一卷/001-楔子.md');
      renamedPlot = t.has('.novelforge/summaries/第一卷/001-入镇.md') && t.read('.novelforge/summaries/第一卷/001-入镇.md');
      oldPlotGone = !t.has('.novelforge/summaries/第一卷/001-楔子.md');

      fs.mkdirSync(t.rel('chapters/第二卷'), { recursive: true });
      h.expect();
      moved = await fileOps.moveEntry(project, 'chapters/第一卷/001-入镇.md', 'chapters/第二卷');
      movedPlot = await project.getPlot(1);

      h.expect('旧手记');
      txtRenamed = await fileOps.renameEntry(project, 'chapters/第一卷/002-手记.txt');
      txtPlot = await project.getPlot(2);
    });

    test('正文改了名', () => {
      assert.equal(renamed, 'chapters/第一卷/001-入镇.md');
    });

    test('细纲跟着改名，内容原样带过去', () => {
      assert.ok(renamedPlot && renamedPlot.includes('楔子的梗概'), String(renamedPlot));
    });

    test('旧位置的细纲不在了，不会一章两份', () => {
      assert.ok(oldPlotGone);
    });

    test('正文移进另一个卷目录，细纲跟着进 summaries/ 的同名目录', () => {
      assert.equal(moved, 'chapters/第二卷/001-入镇.md');
      assert.equal(movedPlot?.relPath, '.novelforge/summaries/第二卷/001-入镇.md');
    });

    test('.txt 正文改名，细纲（.md）也跟着改名', () => {
      assert.equal(txtRenamed, 'chapters/第一卷/002-旧手记.txt');
      assert.equal(txtPlot?.relPath, '.novelforge/summaries/第一卷/002-旧手记.md');
    });
  });

  describe('整个卷目录一起搬', () => {
    let movedDir;
    let plot;

    before(async () => {
      t.write('chapters/第三卷/010-雪夜.md', '# 雪夜\n\n雪。\n');
      t.write('.novelforge/summaries/第三卷/010-雪夜.md', PLOT(10, '雪夜'));
      fs.mkdirSync(t.rel('chapters/归档'), { recursive: true });
      project.invalidate();
      h.expect();
      movedDir = await fileOps.moveEntry(project, 'chapters/第三卷', 'chapters/归档');
      plot = await project.getPlot(10);
    });

    test('卷目录搬过去了', () => {
      assert.equal(movedDir, 'chapters/归档/第三卷');
    });

    test('summaries/ 里那个卷目录整棵跟着走', () => {
      assert.equal(plot?.relPath, '.novelforge/summaries/归档/第三卷/010-雪夜.md');
      assert.ok(!t.has('.novelforge/summaries/第三卷'));
    });
  });

  describe('目标位置已有细纲时不覆盖', () => {
    let targetBody;
    let oldKept;
    let toasts;

    before(async () => {
      t.write('chapters/020-甲.md', '# 甲\n\n正文\n');
      t.write('.novelforge/summaries/020-甲.md', PLOT(20, '甲'));
      t.write('.novelforge/summaries/020-乙.md', PLOT(20, '乙', '（占位）'));
      project.invalidate();
      h.expect('乙');
      await fileOps.renameEntry(project, 'chapters/020-甲.md');
      targetBody = t.read('.novelforge/summaries/020-乙.md');
      oldKept = t.has('.novelforge/summaries/020-甲.md');
      toasts = [...h.toasts];
    });

    test('目标细纲没被盖掉', () => {
      assert.ok(targetBody.includes('（占位）'), targetBody);
    });

    test('旧细纲留在原处', () => {
      assert.ok(oldKept);
    });

    test('说出来了', () => {
      assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('020-乙.md')), toasts.join(' | '));
    });
  });

  describe('删正文不删细纲', () => {
    let plotKept;
    let back;

    before(async () => {
      t.write('chapters/030-残灯.md', '# 残灯\n\n灯芯烧到了底。\n');
      t.write('.novelforge/summaries/030-残灯.md', PLOT(30, '残灯'));
      project.invalidate();
      h.expect('删除');
      await fileOps.deleteEntry(project, 'chapters/030-残灯.md');
      plotKept = t.has('.novelforge/summaries/030-残灯.md');
      back = await project.getPlot(30);
    });

    test('细纲还在', () => {
      assert.ok(plotKept);
    });

    test('它退回这一章的计划（按号认得出）', () => {
      assert.equal(back?.relPath, '.novelforge/summaries/030-残灯.md');
    });
  });

  describe('照细纲新写一章：细纲跟着改名到新正文的镜像', () => {
    let rel;
    let plot;

    before(async () => {
      // 还没起名时建的纯序号细纲，后来排出了标题。
      t.write('.novelforge/summaries/第二卷/040.md', PLOT(40, '冰河'));
      project.invalidate();
      rel = await wsOf(project).createChapterAt('chapters/第二卷/040-冰河.md', '冰面裂了。', '.novelforge/summaries/第二卷/040.md');
      plot = await project.getPlot(40);
    });

    test('正文落在给定位置，标题行取文件名', () => {
      assert.equal(rel, 'chapters/第二卷/040-冰河.md');
      assert.equal(t.read(rel), '# 冰河\n\n冰面裂了。\n');
    });

    test('细纲改名到新正文的镜像，按路径认得出', () => {
      assert.equal(plot?.relPath, '.novelforge/summaries/第二卷/040-冰河.md');
      assert.ok(!t.has('.novelforge/summaries/第二卷/040.md'));
    });
  });
});
