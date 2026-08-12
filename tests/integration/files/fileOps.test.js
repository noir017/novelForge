/**
 * 层级目录与类文件操作：递归扫描、树折叠、路径守卫，以及新建/重命名/移动/删除，
 * 外加摘要的新鲜度与路径映射。迁自 scripts/smoke-fileops.js（全部 112 条）。
 *
 * 时序敏感（两类，都按「操作后当场取值」处理）：
 * - `erred()` 读的是距上一次 expect() 以来攒下的 toast，晚一步取值就串味；
 * - 文件会被改名/移动/删除，`existsSync` / `read` 晚一步取值读到的是后来的状态。
 * 断言只读变量，不在 test 里现算。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('fileOps.ts', () => {
  let projectMod;
  let projectView;
  let fileOps;
  let charactersMod;
  let actionsMod;
  let h;
  let project;
  let dir;
  let rel;
  let write;
  let read;
  let has;

  before(async () => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      projectView: './src/core/projectView.ts',
      fileOps: './src/core/fileOps.ts',
      characters: './src/core/features/characters.ts',
      actions: './src/core/actions.ts',
    });
    projectMod = bundle.project;
    projectView = bundle.projectView;
    fileOps = bundle.fileOps;
    charactersMod = bundle.characters;
    actionsMod = bundle.actions;
    // 原脚本的 host 字面量里没有 reviewReplace，必须显式抹掉：
    // characters.ts 用 `host.reviewReplace ? … : host.confirm(…)` 分支，
    // 默认 fakeHost 带着它会把用例送进另一条路径。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'fileops', title: '层级测试' });
    ({ dir, rel, write, read, has, project } = t);
  });

  after(() => cleanup(dir));

  describe('递归扫描', () => {
    let chapters;
    let cards;
    let lore;
    let afterTrash;

    before(async () => {
      write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      write('chapters/第一卷/002-入镇.md', '# 入镇\n\n他走进青崖镇。\n');
      write('chapters/第一卷/深处/003-夜访.md', '# 夜访\n\n三更时分。\n');
      write('chapters/第一卷/笔记.txt', '没有数字前缀，不是章节');
      write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n');
      write('.novelforge/characters/配角/李叔.md', '---\nname: 李叔\n---\n\n# 李叔\n');
      write('.novelforge/lore/势力/玄门七宗.md', '---\ntitle: 玄门七宗\nkeywords: [玄门]\n---\n\n# 玄门七宗\n');
      project.invalidate();

      chapters = await project.listChapters();
      cards = await project.listCharacters();
      lore = await project.listLore();

      // .trash 里的东西不能被扫回来，否则「删除」等于没删。
      write('.novelforge/.trash/.novelforge/characters/已删.md', '---\nname: 已删\n---\n');
      afterTrash = await project.listCharacters();
    });

    test('扫到三层里的全部章节', () => {
      assert.equal(chapters.length, 3, `got ${chapters.length}`);
    });

    test('顺序由序号决定而非目录深度', () => {
      assert.equal(chapters.map((c) => c.order).join(','), '1,2,3');
    });

    test('子目录章节的 relPath 带目录', () => {
      assert.equal(chapters[2].relPath, 'chapters/第一卷/深处/003-夜访.md', chapters[2].relPath);
    });

    test('无数字前缀的文件不算章节', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('.txt')));
    });

    test('角色卡递归扫描', () => {
      assert.equal(cards.length, 2, `got ${cards.length}`);
    });

    test('子目录角色的 slug 带路径前缀', () => {
      const li = cards.find((c) => c.name === '李叔');
      assert.equal(li.slug, '配角/李叔', li.slug);
    });

    test('根目录角色的 slug 与改造前一致', () => {
      assert.equal(cards.find((c) => c.name === '林昭').slug, '林昭');
    });

    test('设定递归扫描', () => {
      assert.equal(lore.length, 1, lore[0] && lore[0].slug);
      assert.equal(lore[0].slug, '势力/玄门七宗', lore[0] && lore[0].slug);
    });

    test('回收站里的文件不参与扫描', () => {
      assert.equal(afterTrash.length, 2);
    });
  });

  describe('树的折叠', () => {
    let tree;
    let vol1;
    let deep;

    before(async () => {
      fs.mkdirSync(rel('chapters/第二卷'), { recursive: true });
      project.invalidate();
      tree = await projectView.buildProjectTree(project);
      vol1 = tree.chapters.find((n) => n.kind === 'dir' && n.label === '第一卷');
      deep = vol1.children.find((n) => n.kind === 'dir');
    });

    test('章节区顶层：两个文件夹 + 一个文件', () => {
      assert.equal(tree.chapters.length, 3, String(tree.chapters.length));
    });

    test('目录排在文件前面', () => {
      const kinds = tree.chapters.map((n) => n.kind).join(',');
      assert.equal(tree.chapters[0].kind, 'dir', kinds);
      assert.equal(tree.chapters[2].kind, 'chapter', kinds);
    });

    test('第一卷有子目录与章节', () => {
      assert.equal(vol1.children.length, 2, String(vol1.children.length));
    });

    test('fileCount 统计整棵子树', () => {
      assert.equal(vol1.fileCount, 2, String(vol1.fileCount));
    });

    test('第三层节点在位', () => {
      assert.equal(deep.label, '深处');
      assert.equal(deep.children[0].order, 3);
    });

    // 每层内章节正序（第 1 章在上），与文件名顺序一致。
    describe('同层排序', () => {
      let reordered;

      before(async () => {
        write('chapters/第一卷/004-后续.md', '# 后续\n\n再后来。\n');
        project.invalidate();
        reordered = (await projectView.buildProjectTree(project)).chapters
          .find((n) => n.kind === 'dir' && n.label === '第一卷')
          .children.filter((n) => n.kind === 'chapter')
          .map((n) => n.order);
      });

      // 004 必须清掉：后面「在文件夹里新建」等着 004 这个序号。
      // 原脚本把清理写在断言之后，断言一挂就污染后续小节；这里挂 after() 保证一定跑。
      after(() => {
        fs.rmSync(rel('chapters/第一卷/004-后续.md'));
        project.invalidate();
      });

      test('同层章节正序排列', () => {
        assert.equal(reordered.join(','), '2,4');
      });
    });

    // ⚠ vol2 取自上面那棵**旧** tree 快照（建于写入 004 之前）。原脚本如此，照搬。
    //   快照是不可变的所以能过，但它验的是「当时那棵树」，不是此刻磁盘的状态。
    test('空文件夹也在树上', () => {
      const vol2 = tree.chapters.find((n) => n.kind === 'dir' && n.label === '第二卷');
      assert.ok(vol2);
      assert.equal(vol2.children.length, 0);
      assert.equal(vol2.fileCount, 0);
    });

    test('chapterCount 仍是全书总章数', () => {
      assert.equal(tree.chapterCount, 3, String(tree.chapterCount));
    });

    test('totalWords 跨目录累加', () => {
      assert.ok(tree.totalWords > 0);
    });

    test('给出各区根目录', () => {
      assert.equal(tree.chaptersRoot, 'chapters', tree.charactersRoot);
      assert.equal(tree.charactersRoot, '.novelforge/characters', tree.charactersRoot);
    });

    test('角色区顶层：一个文件夹 + 一个文件', () => {
      assert.equal(tree.characters.filter((n) => n.kind === 'dir').length, 1);
      assert.equal(tree.characters.filter((n) => n.kind === 'file').length, 1);
    });
  });

  describe('路径守卫', () => {
    let norm;

    before(() => {
      norm = fileOps.normalizeRel;
    });

    test('拒绝 ..', () => {
      assert.equal(norm('../外面'), undefined);
    });

    test('拒绝夹在中间的 ..', () => {
      assert.equal(norm('chapters/../../外面'), undefined);
    });

    test('拒绝绝对路径', () => {
      assert.equal(norm('/etc/passwd'), undefined);
      assert.equal(norm('C:/Windows'), undefined);
    });

    test('拒绝空路径', () => {
      assert.equal(norm(''), undefined);
      assert.equal(norm('   '), undefined);
    });

    test('反斜杠归一为正斜杠', () => {
      assert.equal(norm('chapters\\第一卷'), 'chapters/第一卷');
    });

    test('去掉结尾斜杠', () => {
      assert.equal(norm('chapters/第一卷/'), 'chapters/第一卷');
    });

    test('内部 . 被折叠', () => {
      assert.equal(norm('chapters/./卷一'), 'chapters/卷一');
    });

    test('识别章节区', () => {
      assert.equal(fileOps.sectionOf(project, 'chapters/001-楔子.md').section, 'chapters');
    });

    test('识别角色区', () => {
      assert.equal(
        fileOps.sectionOf(project, '.novelforge/characters/林昭.md').section,
        'characters'
      );
    });

    test('区外路径无归属', () => {
      assert.equal(fileOps.sectionOf(project, '.novelforge/style.md'), undefined);
    });

    test('越界路径无归属', () => {
      assert.equal(fileOps.sectionOf(project, '../x'), undefined);
    });
  });

  describe('新建文件夹', () => {
    let created;
    let createdExists;
    let nested;
    let dup;
    let dupErred;
    let escaped;
    let dirty;

    before(async () => {
      h.expect('第三卷');
      created = await fileOps.newFolder(project, 'chapters');
      createdExists = fs.existsSync(rel('chapters/第三卷'));

      h.expect('子卷');
      nested = await fileOps.newFolder(project, 'chapters', 'chapters/第三卷');

      h.expect('第三卷');
      dup = await fileOps.newFolder(project, 'chapters');
      dupErred = h.erred();

      h.expect('越界');
      escaped = await fileOps.newFolder(project, 'chapters', '../../外面');

      // 名字里的非法字符被清洗，而不是原样写进文件系统。
      h.expect('第四:卷?');
      dirty = await fileOps.newFolder(project, 'chapters');
    });

    test('建在区根目录下', () => {
      assert.equal(created, 'chapters/第三卷', created);
    });

    test('目录真的建出来了', () => {
      assert.ok(createdExists);
    });

    test('可建在子目录下', () => {
      assert.equal(nested, 'chapters/第三卷/子卷', nested);
    });

    test('同名文件夹被拒绝', () => {
      assert.equal(dup, undefined);
      assert.ok(dupErred);
    });

    test('落点越界时退回区根目录', () => {
      assert.equal(escaped, 'chapters/越界', escaped);
    });

    test('文件名非法字符被清洗', () => {
      assert.equal(dirty, 'chapters/第四卷', dirty);
    });
  });

  describe('在文件夹里新建', () => {
    let chapterPath;
    let nextOrder;
    let cardCreated;
    let loreCreated;
    let loreEscaped;
    let escaped;
    let crossed;

    before(async () => {
      h.expect('新的一章');
      chapterPath = await actionsMod.newChapterFlow(project, 'chapters/第三卷');
      project.invalidate();
      nextOrder = (await project.listChapters()).find((c) => c.order === 4);

      h.expect('沈氏');
      await charactersMod.newCharacter(project, '.novelforge/characters/配角');
      cardCreated = fs.existsSync(rel('.novelforge/characters/配角/沈氏.md'));

      h.expect('崖字令牌');
      await charactersMod.newLore(project, '.novelforge/lore/势力');
      loreCreated = fs.existsSync(rel('.novelforge/lore/势力/崖字令牌.md'));

      h.expect('青崖镇');
      await charactersMod.newLore(project, '../../外面');
      loreEscaped = fs.existsSync(rel('.novelforge/lore/青崖镇.md'));

      h.expect('越界的章');
      escaped = await actionsMod.newChapterFlow(project, '../../../外面');

      h.expect('跨区的章');
      crossed = await actionsMod.newChapterFlow(project, '.novelforge/characters');
    });

    test('章节建到指定目录', () => {
      assert.equal(chapterPath, 'chapters/第三卷/004-新的一章.md', chapterPath);
    });

    test('序号仍是全书唯一的下一个', () => {
      assert.notEqual(nextOrder, undefined);
    });

    test('角色卡建到指定目录', () => {
      assert.ok(cardCreated);
    });

    test('设定建到指定目录', () => {
      assert.ok(loreCreated);
    });

    test('落点越界的设定退回区根目录', () => {
      assert.ok(loreEscaped);
    });

    test('落点越界的章节退回 chapters/', () => {
      assert.equal(escaped, 'chapters/005-越界的章.md', escaped);
    });

    test('落点跨区的章节退回 chapters/', () => {
      assert.equal(crossed, 'chapters/006-跨区的章.md', crossed);
    });
  });

  describe('重命名', () => {
    let renamed;
    let renamedBody;
    let keptBody;
    let dirRenamed;
    let dirExists;
    let childrenFollowed;
    let cleaned;
    let cleanedBody;
    let againBody;
    let clash;
    let clashErred;
    let clashKept;
    let root;
    let rootErred;
    let outside;
    let outsideErred;

    before(async () => {
      h.expect('新的一章改名');
      renamed = await fileOps.renameEntry(project, 'chapters/第三卷/004-新的一章.md');
      renamedBody = read(renamed);

      // 作者手写过的 H1 不该被改名顺手改掉。
      write('chapters/008-占位.md', '# 作者自己写的标题\n\n正文。\n');
      project.invalidate();
      h.expect('改过的名');
      const kept = await fileOps.renameEntry(project, 'chapters/008-占位.md');
      keptBody = read(kept);

      h.expect('第三卷改名');
      dirRenamed = await fileOps.renameEntry(project, 'chapters/第三卷');
      dirExists = fs.existsSync(rel(dirRenamed));
      project.invalidate();
      childrenFollowed = (await project.listChapters()).some((c) =>
        c.relPath.startsWith('chapters/第三卷改名/')
      );

      // 名字被清洗后，H1 要与清洗结果一致而不是与用户原样输入一致——
      // 否则下次改名就认不出「这个 H1 是跟着文件名走的」，同步会断掉。
      write('chapters/007-原名.md', '# 原名\n\n正文。\n');
      project.invalidate();
      h.expect('带:非法?字符');
      cleaned = await fileOps.renameEntry(project, 'chapters/007-原名.md');
      cleanedBody = read(cleaned);

      h.expect('再改一次');
      const again = await fileOps.renameEntry(project, cleaned);
      againBody = read(again);

      h.expect('第一卷');
      clash = await fileOps.renameEntry(project, 'chapters/第二卷');
      clashErred = h.erred();
      clashKept = fs.existsSync(rel('chapters/第二卷'));

      h.expect('随便什么');
      root = await fileOps.renameEntry(project, 'chapters');
      rootErred = h.erred();

      h.expect('随便什么');
      outside = await fileOps.renameEntry(project, '.novelforge/style.md');
      outsideErred = h.erred();
    });

    test('保留序号前缀', () => {
      assert.equal(renamed, 'chapters/第三卷/004-新的一章改名.md', renamed);
    });

    test('正文 H1 同步更新', () => {
      assert.ok(renamedBody.startsWith('# 新的一章改名'), renamedBody.slice(0, 20));
    });

    test('与文件名不一致的 H1 不动', () => {
      assert.ok(keptBody.startsWith('# 作者自己写的标题'));
    });

    test('文件夹可重命名', () => {
      assert.equal(dirRenamed, 'chapters/第三卷改名', dirRenamed);
      assert.ok(dirExists, dirRenamed);
    });

    test('里面的章节跟着走', () => {
      assert.ok(childrenFollowed);
    });

    test('非法字符被清洗进文件名', () => {
      assert.equal(cleaned, 'chapters/007-带非法字符.md', cleaned);
    });

    test('H1 与清洗后的文件名一致', () => {
      assert.ok(cleanedBody.startsWith('# 带非法字符'), cleanedBody.slice(0, 20));
    });

    test('清洗后仍能继续同步 H1', () => {
      assert.ok(againBody.startsWith('# 再改一次'), againBody.slice(0, 20));
    });

    test('重名被拒绝且原目录还在', () => {
      assert.equal(clash, undefined);
      assert.ok(clashErred);
      assert.ok(clashKept);
    });

    test('区根目录不能重命名', () => {
      assert.equal(root, undefined);
      assert.ok(rootErred);
    });

    test('区外文件不能操作', () => {
      assert.equal(outside, undefined);
      assert.ok(outsideErred);
    });
  });

  describe('移动', () => {
    let moved;
    let sourceEmptied;
    let entry;
    let hashBefore;
    let cross;
    let crossErred;
    let intoSelf;
    let intoSelfErred;
    let escape;
    let escapeErred;
    let collide;
    let collideErred;
    let bothKept;
    let picked;

    before(async () => {
      const manifestBefore = await project.readManifest();
      hashBefore = manifestBefore.chapters.find((c) => c.order === 1)?.contentHash;

      moved = await fileOps.moveEntry(project, 'chapters/001-楔子.md', 'chapters/第二卷');
      sourceEmptied = !fs.existsSync(rel('chapters/001-楔子.md'));

      project.invalidate();
      const manifestAfter = await project.syncManifest();
      entry = manifestAfter.chapters.find((c) => c.order === 1);

      h.expect();
      cross = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', '.novelforge/characters');
      crossErred = h.erred();

      h.expect();
      intoSelf = await fileOps.moveEntry(project, 'chapters/第一卷', 'chapters/第一卷/深处');
      intoSelfErred = h.erred();

      h.expect();
      escape = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', '../../外面');
      escapeErred = h.erred();

      // 目标目录已有同名文件时必须拒绝，不能覆盖。
      write('chapters/第一卷/001-楔子.md', '# 另一个楔子\n\n别的内容。\n');
      project.invalidate();
      h.expect();
      collide = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', 'chapters/第一卷');
      collideErred = h.erred();
      bothKept =
        fs.existsSync(rel('chapters/第二卷/001-楔子.md')) &&
        read('chapters/第一卷/001-楔子.md').includes('另一个楔子');
      fs.rmSync(rel('chapters/第一卷/001-楔子.md'));

      // 不带 targetDir 时走 Host.pick。
      project.invalidate();
      h.expect('chapters');
      picked = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md');
    });

    test('文件移动到目标目录', () => {
      assert.equal(moved, 'chapters/第二卷/001-楔子.md', moved);
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('manifest 记下新路径', () => {
      assert.equal(entry.file, 'chapters/第二卷/001-楔子.md', entry.file);
    });

    test('正文没被改动', () => {
      assert.equal(entry.contentHash, hashBefore);
    });

    test('不能跨区移动', () => {
      assert.equal(cross, undefined);
      assert.ok(crossErred);
    });

    test('文件夹不能移进自己里面', () => {
      assert.equal(intoSelf, undefined);
      assert.ok(intoSelfErred);
    });

    test('不能移出工程', () => {
      assert.equal(escape, undefined);
      assert.ok(escapeErred);
    });

    test('同名不覆盖', () => {
      assert.equal(collide, undefined);
      assert.ok(collideErred);
    });

    test('两份文件都还在', () => {
      assert.ok(bothKept);
    });

    test('可经选择框移回根目录', () => {
      assert.equal(picked, 'chapters/001-楔子.md', picked);
    });
  });

  describe('删除', () => {
    let ok;
    let sourceEmptied;
    let trashed;
    let countBefore;
    let countAfter;
    let noOverwrite;
    let cancelled;
    let cancelledKept;
    let dirDeleted;
    let dirGone;
    let subtreeTrashed;
    let orderGone;
    let root;
    let rootErred;
    let rootKept;
    let missing;
    let missingErred;

    before(async () => {
      write('chapters/009-待删.md', '# 待删\n\n第一份内容。\n');
      project.invalidate();
      countBefore = (await project.listChapters()).length;

      h.expect('删除');
      ok = await fileOps.deleteEntry(project, 'chapters/009-待删.md');
      sourceEmptied = !fs.existsSync(rel('chapters/009-待删.md'));
      trashed = fs.existsSync(rel('.novelforge/.trash/chapters/009-待删.md'));
      project.invalidate();
      countAfter = (await project.listChapters()).length;

      // 同名再删一次不能把回收站里那份覆盖掉。
      write('chapters/009-待删.md', '# 待删\n\n第二份内容。\n');
      project.invalidate();
      h.expect('删除');
      await fileOps.deleteEntry(project, 'chapters/009-待删.md');
      noOverwrite =
        fs.existsSync(rel('.novelforge/.trash/chapters/009-待删-2.md')) &&
        read('.novelforge/.trash/chapters/009-待删.md').includes('第一份内容');

      h.expect(undefined);
      cancelled = await fileOps.deleteEntry(project, 'chapters/第一卷');
      cancelledKept = fs.existsSync(rel('chapters/第一卷'));

      h.expect('删除');
      dirDeleted = await fileOps.deleteEntry(project, 'chapters/第一卷');
      dirGone = !fs.existsSync(rel('chapters/第一卷'));
      subtreeTrashed = fs.existsSync(rel('.novelforge/.trash/chapters/第一卷/深处/003-夜访.md'));
      project.invalidate();
      orderGone = !(await project.listChapters()).some((c) => c.order === 3);

      h.expect('删除');
      root = await fileOps.deleteEntry(project, 'chapters');
      rootErred = h.erred();
      rootKept = fs.existsSync(rel('chapters'));

      h.expect('删除');
      missing = await fileOps.deleteEntry(project, 'chapters/不存在.md');
      missingErred = h.erred();
    });

    test('确认后删除', () => {
      assert.equal(ok, true);
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('搬进回收站并保留原路径', () => {
      assert.ok(trashed);
    });

    test('列表里少了一章', () => {
      assert.equal(countAfter, countBefore - 1);
    });

    test('回收站里同名不覆盖', () => {
      assert.ok(noOverwrite);
    });

    test('取消则什么都不做', () => {
      assert.equal(cancelled, false);
      assert.ok(cancelledKept);
    });

    test('文件夹整棵子树一起删', () => {
      assert.equal(dirDeleted, true);
      assert.ok(dirGone);
    });

    test('子树内容在回收站里', () => {
      assert.ok(subtreeTrashed);
    });

    test('删掉的章节不再出现', () => {
      assert.ok(orderGone);
    });

    test('区根目录不能删', () => {
      assert.equal(root, false);
      assert.ok(rootErred);
      assert.ok(rootKept);
    });

    test('不存在的路径报错而非抛异常', () => {
      assert.equal(missing, false);
      assert.ok(missingErred);
    });
  });

  /** 在整棵树里找到指定序号的章节节点。 */
  const findOrder = (nodes, order) => {
    for (const n of nodes) {
      if (n.kind === 'dir') {
        const hit = findOrder(n.children, order);
        if (hit) return hit;
      } else if (n.order === order) return n;
    }
    return undefined;
  };

  describe('摘要新鲜度跨目录', () => {
    let staleBefore;
    let movedNode;

    before(async () => {
      // 挪动章节不该让它的摘要变成「过期」——序号没变，就还是同一章。
      write('chapters/010-有摘要.md', '# 有摘要\n\n正文内容。\n');
      project.invalidate();
      const chapter = (await project.listChapters()).find((c) => c.order === 10);
      const sections = projectMod.emptySummarySections();
      sections.梗概 = '摘要正文。';
      await project.writeSummary(chapter, sections);
      project.invalidate();

      const treeBefore = await projectView.buildProjectTree(project);
      // ⚠ 原脚本这里直接 `findTen(...).stale`，找不到节点就抛 TypeError，
      //   报出来的是崩溃而不是「哪条断言挂了」。此处保持同样的取值方式。
      staleBefore = findOrder(treeBefore.chapters, 10).stale;

      fs.mkdirSync(rel('chapters/归档'), { recursive: true });
      await fileOps.moveEntry(project, 'chapters/010-有摘要.md', 'chapters/归档');
      project.invalidate();
      const treeAfter = await projectView.buildProjectTree(project);
      movedNode = findOrder(treeAfter.chapters, 10);
    });

    test('刚写完摘要不算过期', () => {
      assert.equal(staleBefore, false);
    });

    test('移动后仍在树上', () => {
      assert.ok(movedNode, movedNode && movedNode.relPath);
      assert.equal(movedNode.relPath, 'chapters/归档/010-有摘要.md', movedNode && movedNode.relPath);
    });

    test('移动后摘要仍算新鲜', () => {
      assert.equal(movedNode.stale, false);
    });

    // 摘要按文件名+路径映射，章节搬进归档/ 后摘要也跟着搬到 summaries/归档/ 下。
    test('摘要路径跟随章节移动', () => {
      assert.ok(movedNode.summaryPath.endsWith('归档/010-有摘要.md'), movedNode.summaryPath);
    });
  });

  describe('单章摘要视图（悬停浮窗的数据源）', () => {
    let view;
    let staleAfterEdit;
    let none;
    let ghost;
    let handEdited;
    let allPlaceholder;

    before(async () => {
      // 上一块留下的：chapters/归档/010-有摘要.md，摘要只填了「梗概」。
      view = await projectView.buildChapterSummaryView(project, 10);

      // 正文改过 → 浮窗必须说「已过期」，否则用户会照着旧摘要做判断。
      write('chapters/归档/010-有摘要.md', '# 有摘要\n\n正文内容。又加了一段。\n');
      project.invalidate();
      staleAfterEdit = (await projectView.buildChapterSummaryView(project, 10)).stale;

      // 没总结过的章节不是错误，给 exists:false 让前端说清楚。
      write('chapters/011-没摘要.md', '# 没摘要\n\n正文。\n');
      project.invalidate();
      none = await projectView.buildChapterSummaryView(project, 11);

      // 不存在的章节：不抛异常，退化成「没有摘要」。
      ghost = await projectView.buildChapterSummaryView(project, 999);

      // 作者手改摘要、把小节标题全删了 → 退回全文，不给空浮窗。
      const ch11 = (await project.listChapters()).find((c) => c.order === 11);
      const secs = projectMod.emptySummarySections();
      secs.梗概 = '会被覆盖掉。';
      await project.writeSummary(ch11, secs);
      // 摘要按文件名映射：chapters/011-没摘要.md → summaries/011-没摘要.md
      const summaryFile = rel('.novelforge/summaries/011-没摘要.md');
      const raw = fs.readFileSync(summaryFile, 'utf8');
      // 留下 frontmatter 与 H1，正文改成没有任何 `## 小节` 的大白话。
      fs.writeFileSync(
        summaryFile,
        `${raw.split('\n\n#')[0]}\n\n# 第11章 没摘要 · 摘要\n\n我自己写的一段话。\n`
      );
      project.invalidate();
      handEdited = await projectView.buildChapterSummaryView(project, 11);

      // 六个小节全是占位的空摘要：不退回全文，否则浮窗里摊六行「（待补充）」。
      await project.writeSummary(ch11, projectMod.emptySummarySections());
      project.invalidate();
      allPlaceholder = await projectView.buildChapterSummaryView(project, 11);
    });

    after(() => {
      fs.rmSync(rel('chapters/011-没摘要.md'));
      project.invalidate();
    });

    test('摘要存在', () => {
      assert.equal(view.exists, true);
    });

    test('带章号与标题', () => {
      assert.equal(view.order, 10, view.title);
      assert.equal(view.title, '有摘要', view.title);
    });

    test('新鲜的摘要不标过期', () => {
      assert.equal(view.stale, false);
    });

    test('给出摘要文件路径', () => {
      assert.ok(view.relPath.endsWith('归档/010-有摘要.md'), view.relPath);
    });

    test('只给非空小节', () => {
      const names = JSON.stringify(view.sections.map((s) => s.name));
      assert.equal(view.sections.length, 1, names);
      assert.equal(view.sections[0].name, '梗概', names);
    });

    test('小节带正文', () => {
      assert.equal(view.sections[0].text, '摘要正文。', view.sections[0].text);
    });

    test('「（待补充）」占位不进浮窗', () => {
      assert.ok(
        !view.sections.some((s) => s.text.includes('待补充')),
        JSON.stringify(view.sections)
      );
    });

    test('改正文后标为过期', () => {
      assert.equal(staleAfterEdit, true);
    });

    test('未总结的章节 exists 为 false', () => {
      assert.equal(none.exists, false);
    });

    test('未总结时仍带标题（浮窗标题行要用）', () => {
      assert.equal(none.title, '没摘要', none.title);
    });

    test('未总结时算过期', () => {
      assert.equal(none.stale, true);
    });

    test('未总结时小节为空', () => {
      assert.equal(none.sections.length, 0);
    });

    test('未总结时不给摘要路径', () => {
      assert.equal(none.relPath, '');
    });

    test('不存在的章节退化为空视图', () => {
      assert.equal(ghost.exists, false);
      assert.equal(ghost.title, '');
    });

    test('小节全被删掉时退回摘要全文', () => {
      const dump = JSON.stringify(handEdited.sections);
      assert.equal(handEdited.sections.length, 1, dump);
      assert.equal(handEdited.sections[0].text, '我自己写的一段话。', dump);
    });

    test('全占位的摘要不退回全文', () => {
      assert.equal(allPlaceholder.sections.length, 0, JSON.stringify(allPlaceholder.sections));
    });

    test('全占位的摘要仍算存在（前端说「摘要文件是空的」）', () => {
      assert.equal(allPlaceholder.exists, true);
    });
  });

  describe('同序号不同文件名 → 摘要各自独立', () => {
    // 用户报告的 bug：两个同序号文件（如「001 序.txt」「001 正文.txt」）共用 001.md，
    // 后写的摘要覆盖先写的。修复后摘要按完整文件名映射，互不覆盖。
    let chapters;
    let a;
    let b;
    let seqSaved;
    let bodySaved;
    let ra;
    let rb;
    let flat20;

    before(async () => {
      write('chapters/020 序.txt', '# 序\n\n序章正文。\n');
      write('chapters/020 正文.txt', '# 正文\n\n正文内容。\n');
      project.invalidate();
      chapters = (await project.listChapters()).filter((c) => c.order === 20);

      a = chapters.find((c) => c.title === '序');
      b = chapters.find((c) => c.title === '正文');

      const sa = projectMod.emptySummarySections();
      sa.梗概 = '序章的梗概。';
      const sb = projectMod.emptySummarySections();
      sb.梗概 = '正文的梗概。';
      await project.writeSummary(a, sa);
      await project.writeSummary(b, sb);
      project.invalidate();

      // 两份摘要落在不同文件里，互不覆盖。
      seqSaved = fs.existsSync(rel('.novelforge/summaries/020 序.md'));
      bodySaved = fs.existsSync(rel('.novelforge/summaries/020 正文.md'));

      ra = await project.readSummary(a);
      rb = await project.readSummary(b);

      // 工程页树上两条同序号章节都该是「已总结、新鲜」。
      const tree = await projectView.buildProjectTree(project);
      flat20 = (function flat(nodes) {
        const out = [];
        for (const n of nodes) {
          if (n.kind === 'dir') out.push(...flat(n.children));
          else if (n.order === 20) out.push(n);
        }
        return out;
      })(tree.chapters);
    });

    after(() => {
      fs.rmSync(rel('chapters/020 序.txt'));
      fs.rmSync(rel('chapters/020 正文.txt'));
      fs.rmSync(rel('.novelforge/summaries/020 序.md'));
      fs.rmSync(rel('.novelforge/summaries/020 正文.md'));
      project.invalidate();
    });

    test('两个同序号章节都被扫到', () => {
      assert.equal(chapters.length, 2, `实际 ${chapters.length}`);
    });

    test('两个章节标题不同', () => {
      const detail = `${a && a.title} / ${b && b.title}`;
      assert.ok(a, detail);
      assert.ok(b, detail);
      assert.notEqual(a.title, b.title, detail);
    });

    test('序章摘要独立落盘', () => {
      assert.ok(seqSaved);
    });

    test('正文摘要独立落盘', () => {
      assert.ok(bodySaved);
    });

    test('序章摘要读回自己的内容', () => {
      assert.ok(ra, ra && ra.sections.梗概);
      assert.equal(ra.sections.梗概, '序章的梗概。', ra && ra.sections.梗概);
    });

    test('正文摘要读回自己的内容', () => {
      assert.ok(rb, rb && rb.sections.梗概);
      assert.equal(rb.sections.梗概, '正文的梗概。', rb && rb.sections.梗概);
    });

    test('两份摘要内容不同', () => {
      assert.notEqual(ra.sections.梗概, rb.sections.梗概);
    });

    test('两份摘要都算新鲜', () => {
      assert.equal(ra.sourceHash, a.contentHash);
      assert.equal(rb.sourceHash, b.contentHash);
    });

    test('树上两条都不算过期', () => {
      const detail = flat20.map((c) => `${c.title}:${c.stale}`).join(',');
      assert.equal(flat20.length, 2, detail);
      assert.ok(flat20.every((c) => !c.stale), detail);
    });
  });

  describe('旧式摘要回退与迁移', () => {
    // 升级前生成的摘要是 NNN.md（按序号）。升级后 readSummary 必须仍能读到它，
    // 重新生成摘要时再迁移到按文件名映射的新路径，并清掉旧的 NNN.md（序号唯一时）。
    let ch;
    let legacyRead;
    let newSaved;
    let legacyCleaned;
    let migrated;

    before(async () => {
      write('chapters/009-旧式.md', '# 旧式\n\n旧式章节正文。\n');
      // 手写一份旧式摘要。
      write(
        '.novelforge/summaries/009.md',
        '---\norder: 9\ntitle: 旧式\nsourceHash: legacy\n---\n\n# 第9章 旧式 · 摘要\n\n## 梗概\n\n旧式梗概。\n'
      );
      project.invalidate();
      ch = (await project.listChapters()).find((c) => c.order === 9);
      legacyRead = await project.readSummary(ch);

      // 重新生成：写入新路径，旧式 009.md 被清理（序号唯一）。
      const secs = projectMod.emptySummarySections();
      secs.梗概 = '新式梗概。';
      await project.writeSummary(ch, secs);
      project.invalidate();
      newSaved = fs.existsSync(rel('.novelforge/summaries/009-旧式.md'));
      legacyCleaned = !fs.existsSync(rel('.novelforge/summaries/009.md'));
      migrated = await project.readSummary(ch);
    });

    after(() => {
      fs.rmSync(rel('chapters/009-旧式.md'));
      fs.rmSync(rel('.novelforge/summaries/009-旧式.md'));
      project.invalidate();
    });

    test('旧式摘要经回退仍能读到', () => {
      assert.ok(legacyRead, legacyRead && legacyRead.sections.梗概);
      assert.equal(legacyRead.sections.梗概, '旧式梗概。', legacyRead && legacyRead.sections.梗概);
    });

    test('旧式摘要因 hash 不匹配算过期', () => {
      assert.ok(legacyRead);
      assert.notEqual(legacyRead.sourceHash, ch.contentHash);
    });

    test('新式摘要按文件名落盘', () => {
      assert.ok(newSaved);
    });

    test('旧式 009.md 已被迁移清理', () => {
      assert.ok(legacyCleaned);
    });

    test('迁移后读到新式内容', () => {
      assert.ok(migrated);
      assert.equal(migrated.sections.梗概, '新式梗概。');
    });

    test('迁移后算新鲜', () => {
      assert.ok(migrated);
      assert.equal(migrated.sourceHash, ch.contentHash);
    });
  });
});
