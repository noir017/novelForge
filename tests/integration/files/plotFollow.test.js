/**
 * 细纲跟着正文走：细纲镜像正文在章节根下的相对路径（`chapters/第一卷/003-深处.txt` ↔
 * `summaries/第一卷/003-深处.md`），与草稿同一套镜像。
 *
 * - 工程页给正文改名、移动（单章或整个卷目录）时，细纲一并搬过去（`handlers/chapter.ts` 的 `carryPlot`）；
 *   不搬的话这一章立刻变成「还没有细纲」，排好的计划与定稿的档案都还躺在旧路径下。
 * - 目标位置已有细纲时不覆盖，两份都留着、说出来（第 3 条）；要同步正文 `# 标题` 行的改名干脆整个不做（写标题之前
 *   `Workspace.checkMove` 就拦下），不然标题与文件名换了，细纲却留在旧路径上。
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

    // 工程页那一行先认细纲的标题：只搬文件不改标题，改完名那一行还挂着旧名字（2026-10-23 作者提的）。
    test('细纲里的标题跟着改成新名（frontmatter 与标题行）', () => {
      assert.ok(renamedPlot && renamedPlot.includes('title: 入镇') && renamedPlot.includes('# 第1章 入镇'), String(renamedPlot));
      assert.ok(!renamedPlot.includes('title: 楔子'), renamedPlot);
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
      assert.equal(txtPlot?.title, '旧手记');
    });
  });

  // 只改标题那两行，别的一个字节不动；作者在细纲上另起过的标题不动、说出来；标题不进指纹，改了不挂 ⟳。
  describe('改名时细纲的标题跟着改', () => {
    const KEPT = '---\nno: 50\ntitle: 另起的标题\n---\n\n# 第50章 另起的标题\n\n## 梗概\n\n梗概。\n';
    const NO_FM = '# 第52章 手写\n\n## 梗概\n\n手写的。\n\n## 作者备注\n\n别删我。\n';
    const CRLF = '---\r\nno: 53\r\ntitle: 回车\r\n---\r\n\r\n# 第53章 回车\r\n\r\n## 梗概\r\n\r\n回车的梗概。\r\n';
    let kept;
    let keptToasts;
    let unnamed;
    let noFm;
    let crlf;
    let hashed;
    let writtenFrom;

    before(async () => {
      t.write('chapters/050-旧名.md', '# 旧名\n\n正文\n');
      t.write('.novelforge/summaries/050-旧名.md', KEPT);
      project.invalidate();
      h.expect('新名');
      await fileOps.renameEntry(project, 'chapters/050-旧名.md');
      kept = t.read('.novelforge/summaries/050-新名.md');
      keptToasts = [...h.toasts];

      // 纯序号名的正文与细纲（新建时名字留空的样子）：第一次起名，细纲的空标题也填上。
      t.write('chapters/051.md', '正文\n');
      project.invalidate();
      await wsOf(project).writePlot({ no: 51, title: '', upstreamHash: '', done: false, sections: { 梗概: '空着' } });
      h.expect('起名');
      await fileOps.renameEntry(project, 'chapters/051.md');
      unnamed = t.read('.novelforge/summaries/051-起名.md');

      t.write('chapters/052-手写.md', '# 手写\n\n正文\n');
      t.write('.novelforge/summaries/052-手写.md', NO_FM);
      project.invalidate();
      h.expect('改过');
      await fileOps.renameEntry(project, 'chapters/052-手写.md');
      noFm = t.read('.novelforge/summaries/052-改过.md');

      t.write('chapters/053-回车.txt', '正文\r\n');
      t.write('.novelforge/summaries/053-回车.md', CRLF);
      project.invalidate();
      h.expect('换行');
      await fileOps.renameEntry(project, 'chapters/053-回车.txt');
      crlf = t.read('.novelforge/summaries/053-换行.md');

      // 照细纲写过正文（记着 writtenFrom）：改名之后指纹还对得上，不挂 ⟳。
      t.write('chapters/054-指纹.md', '# 指纹\n\n正文\n');
      t.write('.novelforge/summaries/054-指纹.md', PLOT(54, '指纹'));
      project.invalidate();
      const before54 = await project.getPlot(54);
      await wsOf(project).recordWrittenFrom(before54.relPath, bundle.plotFile.plotContentHash(before54));
      project.invalidate();
      writtenFrom = (await project.getPlot(54)).writtenFrom;
      h.expect('改指纹');
      await fileOps.renameEntry(project, 'chapters/054-指纹.md');
      project.invalidate();
      const after54 = await project.getPlot(54);
      hashed = { title: after54?.title, writtenFrom: after54?.writtenFrom, now: after54 && bundle.plotFile.plotContentHash(after54) };
    });

    test('作者另起的标题不动，文件照样跟着正文搬', () => {
      assert.equal(kept, KEPT);
    });

    test('另起的标题没跟着改，说出来了', () => {
      assert.ok(keptToasts.some((x) => x.includes('另起的标题') && x.includes('没跟着改')), keptToasts.join(' | '));
    });

    test('细纲的空标题第一次起名也填上', () => {
      assert.ok(unnamed.includes('title: 起名') && unnamed.includes('# 第51章 起名'), unnamed);
      assert.ok(unnamed.includes('空着'), unnamed);
    });

    test('没有 frontmatter 的细纲只换标题行、不补 frontmatter，别的原样', () => {
      assert.equal(noFm, NO_FM.replace('# 第52章 手写', '# 第52章 改过'));
    });

    test('CRLF 的细纲照样改，换行不变', () => {
      assert.equal(crlf, CRLF.replace('title: 回车', 'title: 换行').replace('# 第53章 回车', '# 第53章 换行'));
    });

    test('标题不进指纹：改名之后 writtenFrom 还对得上', () => {
      assert.equal(hashed.title, '改指纹');
      assert.ok(writtenFrom);
      assert.equal(hashed.writtenFrom, writtenFrom);
      assert.equal(hashed.now, writtenFrom);
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

  // 要同步正文 `# 标题` 行的改名（`.md` 正文、标题与旧文件名一致）先写标题、再搬家：细纲那一侧会撞时
  // 写标题之前就停下，什么都不动（第 3 条）——不然正文的标题、文件名改了，细纲却留在旧路径上。
  describe('目标位置已有细纲时不覆盖：要同步标题的改名整个不做', () => {
    const CH = 'chapters/020-甲.md';
    const BODY = '# 甲\n\n正文\n';
    const MINE = PLOT(20, '甲');
    const THEIRS = PLOT(20, '乙', '（占位）');
    let result;
    let body;
    let targetBody;
    let oldPlot;
    let renamedTo;
    let toasts;

    before(async () => {
      t.write(CH, BODY);
      t.write('.novelforge/summaries/020-甲.md', MINE);
      t.write('.novelforge/summaries/020-乙.md', THEIRS);
      project.invalidate();
      h.expect('乙');
      result = await fileOps.renameEntry(project, CH);
      body = t.has(CH) ? t.read(CH) : undefined;
      targetBody = t.read('.novelforge/summaries/020-乙.md');
      oldPlot = t.has('.novelforge/summaries/020-甲.md') ? t.read('.novelforge/summaries/020-甲.md') : undefined;
      renamedTo = t.has('chapters/020-乙.md');
      toasts = [...h.toasts];
    });

    test('没有改名', () => {
      assert.equal(result, undefined);
      assert.equal(renamedTo, false);
    });

    test('正文一字不动（# 标题行没被改成新名字）', () => {
      assert.equal(body, BODY);
    });

    test('目标细纲没被盖掉', () => {
      assert.equal(targetBody, THEIRS);
    });

    test('这一章的细纲原样留在原处', () => {
      assert.equal(oldPlot, MINE);
    });

    test('说出来了', () => {
      assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('020-乙.md')), toasts.join(' | '));
    });
  });

  // 不同步标题的改名（`.txt` 正文、标题与文件名不一致）行为照旧：正文照样改名，细纲留在原处并说出来。
  describe('目标位置已有细纲时不覆盖：不同步标题的改名照旧', () => {
    let targetBody;
    let oldKept;
    let renamed;
    let toasts;

    before(async () => {
      t.write('chapters/021-甲.txt', '正文\n');
      t.write('.novelforge/summaries/021-甲.md', PLOT(21, '甲'));
      t.write('.novelforge/summaries/021-乙.md', PLOT(21, '乙', '（占位）'));
      project.invalidate();
      h.expect('乙');
      renamed = await fileOps.renameEntry(project, 'chapters/021-甲.txt');
      targetBody = t.read('.novelforge/summaries/021-乙.md');
      oldKept = t.has('.novelforge/summaries/021-甲.md');
      toasts = [...h.toasts];
    });

    test('正文照样改名', () => {
      assert.equal(renamed, 'chapters/021-乙.txt');
    });

    test('目标细纲没被盖掉', () => {
      assert.ok(targetBody.includes('（占位）'), targetBody);
    });

    test('旧细纲留在原处', () => {
      assert.ok(oldKept);
    });

    test('说出来了', () => {
      assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('021-乙.md')), toasts.join(' | '));
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
