/**
 * 工程根范围的类文件操作（文件页）：重命名/移动/复制、固定目录保护、同名拒绝、
 * 垃圾箱豁免、章节联动。迁自 scripts/smoke-projectFiles.js（全部 30 条）。
 *
 * 条数说明：原脚本文本上只有 26 个 `check(`，但「固定目录不能改名」那条在
 * 5 元素的 for 循环里，运行时是 5 条。以运行时为准 = 30 条，一条一个 test。
 *
 * 时序敏感：`erred()` 读的是「距上一次 expect() 以来」攒下的 toast，
 * 所以每个操作后**当场**取值存进变量，断言只读变量。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/** 固定目录一律拒绝改名。 */
const FIXED_DIRS = ['chapters', '.novelforge', 'drafts', '.novelforge/characters', '.novelforge/.trash'];

describe('projectFiles.ts', () => {
  let pf;
  let h;
  let project;
  let dir;
  let rel;
  let write;
  let read;

  before(async () => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      fileOps: './src/core/files/fileOps.ts',
      projectFiles: './src/core/files/projectFiles.ts',
    });
    pf = bundle.projectFiles;
    // 原脚本的 host 字面量里没有 reviewReplace，显式抹掉，别走进 diff 审阅分支。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'projfiles', title: '文件页测试' });
    ({ dir, rel, write, read, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    write('notes/备忘.txt', '随便记的。\n');
    project.invalidate();
  });

  after(() => cleanup(dir));

  describe('根范围重命名', () => {
    let outside;
    let chapter;
    let h1Synced;
    const fixed = [];
    let escaped;
    let escapedErred;
    let missing;

    before(async () => {
      // 区外文件（notes/）也能改名——这是文件页与工程页的本质区别。
      h.expect('备忘改名');
      outside = await pf.renameAny(project, 'notes/备忘.txt');

      // 章节仍保留序号前缀与 H1 同步。
      h.expect('新的标题');
      chapter = await pf.renameAny(project, 'chapters/001-楔子.md');
      h1Synced = read('chapters/001-新的标题.md').startsWith('# 新的标题');

      for (const p of FIXED_DIRS) {
        h.expect('随便');
        const r = await pf.renameAny(project, p);
        fixed.push({ p, ok: r.ok, erred: h.erred() });
      }

      h.expect('外面');
      escaped = await pf.renameAny(project, '../外面');
      escapedErred = h.erred();

      h.expect('不存在');
      missing = await pf.renameAny(project, 'notes/幽灵.txt');
    });

    test('区外文件可重命名', () => {
      assert.ok(outside.ok, JSON.stringify(outside));
      assert.equal(outside.to, 'notes/备忘改名.txt', JSON.stringify(outside));
    });

    test('章节保留序号前缀', () => {
      assert.ok(chapter.ok, JSON.stringify(chapter));
      assert.equal(chapter.to, 'chapters/001-新的标题.md', JSON.stringify(chapter));
    });

    test('章节 H1 同步', () => {
      assert.ok(h1Synced);
    });

    for (const p of FIXED_DIRS) {
      test(`固定目录不能改名：${p}`, () => {
        const hit = fixed.find((x) => x.p === p);
        assert.equal(hit.ok, false);
        assert.ok(hit.erred);
      });
    }

    test('越界路径拒绝', () => {
      assert.equal(escaped.ok, false);
      assert.ok(escapedErred);
    });

    test('不存在的路径拒绝', () => {
      assert.equal(missing.ok, false);
    });
  });

  describe('移动（剪切+粘贴）', () => {
    let free;
    let sourceEmptied;
    let okOne;
    let badOne;
    let bothKept;
    let intoSub;
    let draftFollowed;
    let landedInSub;
    let outOfChapters;
    let draftStayed;
    let fixedDir;
    let intoSelf;
    let fromTrash;
    let escaped;
    let escapedErred;
    let already;

    before(async () => {
      fs.mkdirSync(rel('archive'), { recursive: true });

      // 区外自由移动。
      let results = await pf.moveInto(project, ['notes/备忘改名.txt'], 'archive');
      free = results[0];
      sourceEmptied = !fs.existsSync(rel('notes/备忘改名.txt'));

      // 多项粘贴：一项撞名，其余照常。
      write('archive/撞名.txt', '先来的。\n');
      write('notes/甲.txt', '甲。\n');
      write('notes/撞名.txt', '后来的。\n');
      project.invalidate();
      results = await pf.moveInto(project, ['notes/甲.txt', 'notes/撞名.txt'], 'archive');
      okOne = results.find((x) => x.from === 'notes/甲.txt');
      badOne = results.find((x) => x.from === 'notes/撞名.txt');
      bothKept =
        read('archive/撞名.txt').includes('先来的') && read('notes/撞名.txt').includes('后来的');

      // 章节移进 chapters 子目录：草稿跟着走。
      // manifest 已经不索引章节了（章节退出流水线，见 chapters.test.js 末尾），
      // 所以这里只验磁盘：文件到了新位置、草稿也跟过去了。
      fs.mkdirSync(rel('chapters/卷一'), { recursive: true });
      fs.mkdirSync(rel('drafts'), { recursive: true });
      write('drafts/001-新的标题.md', '# 草稿\n');
      project.invalidate();
      results = await pf.moveInto(project, ['chapters/001-新的标题.md'], 'chapters/卷一');
      intoSub = results[0];
      draftFollowed = fs.existsSync(rel('drafts/卷一/001-新的标题.md'));
      project.invalidate();
      landedInSub = fs.existsSync(rel('chapters/卷一/001-新的标题.md'));

      // 章节移出 chapters/：允许，但草稿留在原处（日志会 warn，这里只验磁盘状态）。
      results = await pf.moveInto(project, ['chapters/卷一/001-新的标题.md'], 'archive');
      outOfChapters = results[0];
      draftStayed = fs.existsSync(rel('drafts/卷一/001-新的标题.md'));

      // 固定目录不能搬。
      results = await pf.moveInto(project, ['chapters'], 'archive');
      fixedDir = results[0];

      // 文件夹不能进自己的子孙。
      results = await pf.moveInto(project, ['archive'], 'archive');
      intoSelf = results[0];

      // 垃圾箱里的东西不搬。
      write('.novelforge/.trash/notes/旧物.txt', '删掉的。\n');
      results = await pf.moveInto(project, ['.novelforge/.trash/notes/旧物.txt'], 'notes');
      fromTrash = results[0];

      // 越界落点。
      results = await pf.moveInto(project, ['notes/甲.txt'], '../../外面');
      escaped = results[0];
      escapedErred = h.erred();

      // 已在目标目录里。
      results = await pf.moveInto(project, ['archive/甲.txt'], 'archive');
      already = results[0];
    });

    test('区外文件可移动', () => {
      assert.ok(free.ok, JSON.stringify(free));
      assert.equal(free.to, 'archive/备忘改名.txt', JSON.stringify(free));
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('撞名项拒绝且原因明确', () => {
      assert.ok(badOne, JSON.stringify(badOne));
      assert.ok(!badOne.ok, JSON.stringify(badOne));
      assert.ok(badOne.error.includes('同名'), JSON.stringify(badOne));
    });

    test('其余项不受影响', () => {
      assert.ok(okOne, JSON.stringify(okOne));
      assert.ok(okOne.ok, JSON.stringify(okOne));
      assert.equal(okOne.to, 'archive/甲.txt', JSON.stringify(okOne));
    });

    test('撞名时两份都还在', () => {
      assert.ok(bothKept);
    });

    test('章节可移入子目录', () => {
      assert.ok(intoSub.ok, JSON.stringify(intoSub));
      assert.equal(intoSub.to, 'chapters/卷一/001-新的标题.md', JSON.stringify(intoSub));
    });

    test('草稿跟着搬', () => {
      assert.ok(draftFollowed);
    });

    test('文件确实到了子目录', () => {
      assert.ok(landedInSub);
    });

    test('章节可移出 chapters', () => {
      assert.ok(outOfChapters.ok, JSON.stringify(outOfChapters));
      assert.equal(outOfChapters.to, 'archive/001-新的标题.md', JSON.stringify(outOfChapters));
    });

    test('草稿留在原处', () => {
      assert.ok(draftStayed);
    });

    test('固定目录不能移动', () => {
      assert.equal(fixedDir.ok, false, JSON.stringify(fixedDir));
    });

    test('文件夹不能粘贴进自己', () => {
      assert.equal(intoSelf.ok, false, JSON.stringify(intoSelf));
    });

    test('回收站内容不能移动', () => {
      assert.equal(fromTrash.ok, false, JSON.stringify(fromTrash));
    });

    // ⚠ 这条的 erred() 沿用原脚本的语义，而原脚本**整节都没有调用过 expect()**——
    //   toast 队列自「根范围重命名」最后一次 expect('不存在') 起就没清过。
    //   所以它只证明「这一长串操作里出现过 error 级 toast」，
    //   **不**证明是这次越界落点报的错：上面任何一次拒绝都足以让它变绿。
    //   ok === false 那半边才是真正在测越界。原样保留，不在本次迁移里改断言。
    test('落点越界拒绝', () => {
      assert.equal(escaped.ok, false, JSON.stringify(escaped));
      assert.ok(escapedErred, JSON.stringify(escaped));
    });

    test('已在该目录时拒绝', () => {
      assert.equal(already.ok, false, JSON.stringify(already));
    });
  });

  describe('复制（复制+粘贴）', () => {
    let copied;
    let originalKept;
    let copyContent;
    let noDest;
    let recursive;
    let clash;
    let clashTargetKept;

    before(async () => {
      fs.mkdirSync(rel('copydest'), { recursive: true });
      let results = await pf.copyInto(project, ['archive/撞名.txt'], 'copydest');
      copied = results[0];
      originalKept = fs.existsSync(rel('archive/撞名.txt'));
      copyContent = read('copydest/撞名.txt');

      // 落点目录必须已存在——粘贴不会凭空建目录。
      results = await pf.copyInto(project, ['archive'], 'backup');
      noDest = results[0];

      fs.mkdirSync(rel('backup'), { recursive: true });
      results = await pf.copyInto(project, ['archive'], 'backup');
      recursive = { r: results[0], nested: fs.existsSync(rel('backup/archive/甲.txt')) };

      // 复制撞名同样拒绝。
      results = await pf.copyInto(project, ['notes/撞名.txt'], 'archive');
      clash = results[0];
      clashTargetKept = fs.existsSync(rel('archive/撞名.txt'));
    });

    test('复制后原文件还在', () => {
      assert.ok(copied.ok, JSON.stringify(copied));
      assert.ok(originalKept, JSON.stringify(copied));
    });

    test('复制出同名新文件', () => {
      assert.ok(copyContent.includes('先来的'));
    });

    test('落点目录不存在时拒绝', () => {
      assert.equal(noDest.ok, false, JSON.stringify(noDest));
    });

    test('目录递归复制', () => {
      assert.ok(recursive.r.ok, JSON.stringify(recursive.r));
      assert.ok(recursive.nested, JSON.stringify(recursive.r));
    });

    test('复制撞名拒绝', () => {
      assert.equal(clash.ok, false, JSON.stringify(clash));
      assert.ok(clashTargetKept, JSON.stringify(clash));
    });
  });
});
