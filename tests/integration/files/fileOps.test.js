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

/**
 * 细纲与场景的写入搬进了 `core/workspace/`：改名要连带搬走场景目录与中转站
 * 正文、写入要记上游指纹、删除要进 `.trash/`，那些是网关的活。`NovelProject`
 * 这一层只留领域查询。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

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
      ws: './src/core/workspace/index.ts',
      projectView: './src/core/views/projectView.ts',
      fileOps: './src/core/files/fileOps.ts',
      characters: './src/core/features/characters.ts',
      actions: './src/core/actions.ts',
    });
    wsMod = bundle.ws;
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

  /**
   * 章节列表是**扁平**的：一行一章，按章号排。
   *
   * `chapters/` 下的分卷子目录只是作者的收纳，不体现在这条列表上——
   * 流水线的顺序才是这一层最要紧的信息，折进目录反而看不出来。
   * （目录树那套仍在角色/设定两个区里用，见本文件后面几节。）
   */
  describe('章节列表是扁平的', () => {
    let tree;

    before(async () => {
      fs.mkdirSync(rel('chapters/第二卷'), { recursive: true });
      project.invalidate();
      tree = await projectView.buildProjectTree(project);
    });

    test('子目录里的章也列得出来', () => {
      assert.ok(
        tree.plots.some((p) => p.chapterPath.includes('第一卷/')),
        tree.plots.map((p) => p.chapterPath).join(',')
      );
    });

    test('列表上没有目录节点', () => {
      assert.ok(tree.plots.every((p) => typeof p.no === 'number'));
    });

    // 每层内章节正序（第 1 章在上），与文件名顺序一致。
    describe('同层排序', () => {
      let reordered;

      before(async () => {
        write('chapters/第一卷/004-后续.md', '# 后续\n\n再后来。\n');
        project.invalidate();
        reordered = (await projectView.buildProjectTree(project)).plots.map((p) => p.no);
      });

      // 004 必须清掉：后面「在文件夹里新建」等着 004 这个序号。
      // 原脚本把清理写在断言之后，断言一挂就污染后续小节；这里挂 after() 保证一定跑。
      after(() => {
        fs.rmSync(rel('chapters/第一卷/004-后续.md'));
        project.invalidate();
      });

      // 分卷子目录不参与排序：`第一卷/002` 与根下的 `003` 是同一条列表上的
      // 两章，按章号排。
      test('章节按章号正序排列', () => {
        assert.equal(reordered.join(','), '1,2,3,4');
      });
    });

    test('chapterCount 是全书总章数', () => {
      assert.equal(tree.chapterCount, 3, String(tree.chapterCount));
    });

    // 这个工程只有 chapters/ 里的成品、一份细纲都没有——字数照样算得出来，
    // 那正是「老工程打开就能用」的样子。
    test('totalWords 算的是成品的字数', () => {
      assert.ok(tree.totalWords > 0, String(tree.totalWords));
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
    let chapterBody;
    let chapterTitle;
    let inputCount;
    let nextOrder;
    let cardCreated;
    let loreCreated;
    let loreEscaped;
    let escaped;
    let crossed;

    before(async () => {
      // 新建章节不再问标题：文件按纯序号命名，标题等细纲写完再改名定下来。
      // 所以这里**不排队答案**，并当场记下 input 次数以证明它没弹框
      // （h.expect 会清空录制，晚一步取值就归零了）。
      h.expect();
      chapterPath = await actionsMod.newChapterFlow(project, 'chapters/第三卷');
      inputCount = h.inputs.length;
      chapterBody = read(chapterPath);
      project.invalidate();
      const chapters = await project.listChapters();
      nextOrder = chapters.find((c) => c.order === 4);
      chapterTitle = nextOrder && nextOrder.title;

      h.expect('沈氏');
      await charactersMod.newCharacter(project, '.novelforge/characters/配角');
      cardCreated = fs.existsSync(rel('.novelforge/characters/配角/沈氏.md'));

      h.expect('崖字令牌');
      await charactersMod.newLore(project, '.novelforge/lore/势力');
      loreCreated = fs.existsSync(rel('.novelforge/lore/势力/崖字令牌.md'));

      h.expect('青崖镇');
      await charactersMod.newLore(project, '../../外面');
      loreEscaped = fs.existsSync(rel('.novelforge/lore/青崖镇.md'));

      escaped = await actionsMod.newChapterFlow(project, '../../../外面');
      crossed = await actionsMod.newChapterFlow(project, '.novelforge/characters');
    });

    test('章节建到指定目录，名字只有序号', () => {
      assert.equal(chapterPath, 'chapters/第三卷/004.md', chapterPath);
    });

    test('新建不弹标题输入框', () => {
      assert.equal(inputCount, 0, `${inputCount} 次 input`);
    });

    // 没有标题就不写标题行：`# ` 后面空着的 H1 会让改名时的同步判据从第一天
    // 就对不上（renamedBody 拿空标题去比，永远不匹配）。
    test('无标题时正文里没有 H1', () => {
      assert.equal(chapterBody.trim(), '', JSON.stringify(chapterBody));
    });

    test('标题回落成「第 N 章」', () => {
      assert.equal(chapterTitle, '第 4 章', chapterTitle);
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
      assert.equal(escaped, 'chapters/005.md', escaped);
    });

    test('落点跨区的章节退回 chapters/', () => {
      assert.equal(crossed, 'chapters/006.md', crossed);
    });
  });

  describe('重命名', () => {
    let renamed;
    let renamedBody;
    let renamedTitle;
    let renamedAgain;
    let renamedAgainBody;
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
      // 纯序号名（新建出来的样子）第一次命名：序号后面没有分隔符，得补一个 `-`。
      h.expect('新的一章');
      renamed = await fileOps.renameEntry(project, 'chapters/第三卷/004.md');
      renamedBody = read(renamed);
      project.invalidate();
      const named = (await project.listChapters()).find((c) => c.relPath === renamed);
      renamedTitle = named && named.title;

      // 再改一次：这一次旧标题非空，走的是 H1 同步那条路（此时没有 H1 可同步，
      // 正文仍该一字不动）。
      h.expect('新的一章改名');
      renamedAgain = await fileOps.renameEntry(project, renamed);
      renamedAgainBody = read(renamedAgain);

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

    test('纯序号名改名补上分隔符', () => {
      assert.equal(renamed, 'chapters/第三卷/004-新的一章.md', renamed);
    });

    // 本来没有 H1 的章节**不该被凭空塞进一行**：那会改动正文，contentHash
    // 一变这一章的摘要立刻过期，而作者只是给它起了个名字。标题从文件名取
    // 就够了（listChapters 的回落链本来就这么做）。
    test('无 H1 的章节改名后正文仍是空的', () => {
      assert.equal(renamedBody.trim(), '', JSON.stringify(renamedBody));
    });

    test('标题跟着文件名走', () => {
      assert.equal(renamedTitle, '新的一章', renamedTitle);
    });

    test('保留序号前缀', () => {
      assert.equal(renamedAgain, 'chapters/第三卷/004-新的一章改名.md', renamedAgain);
    });

    test('没有 H1 时不会凭空补出一行', () => {
      assert.equal(renamedAgainBody.trim(), '', JSON.stringify(renamedAgainBody));
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
    let bodyBefore;
    let bodyAfter;
    let landed;
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
      // 移动只搬文件，不动内容。manifest 已经不索引章节了（章节退出流水线，
      // 见 chapters.test.js 末尾那一节），所以拿正文自己前后比。
      bodyBefore = read('chapters/001-楔子.md');

      moved = await fileOps.moveEntry(project, 'chapters/001-楔子.md', 'chapters/第二卷');
      sourceEmptied = !fs.existsSync(rel('chapters/001-楔子.md'));

      project.invalidate();
      // 当场取值：后面几步还会把它移来移去，晚一步读到的是后来的状态。
      landed = fs.existsSync(rel('chapters/第二卷/001-楔子.md'));
      bodyAfter = read('chapters/第二卷/001-楔子.md');

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

    test('新位置读得到', () => {
      assert.ok(landed);
    });

    test('正文没被改动', () => {
      assert.equal(bodyAfter, bodyBefore);
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

  /**
   * 摘要挂在**章节**上：它描述的是成品。
   *
   * 落点镜像章节在 `chapters/` 之下的相对路径（含分卷子目录），扩展名换 `.md`。
   * 同章号不同文件名的两章因此各有独立摘要，互不覆盖——这正是不能用章号
   * 当键的理由。
   */
  describe('摘要挂在章节上', () => {
    let chA;
    let chB;
    let seqSaved;
    let bodySaved;
    let ra;
    let rb;

    before(async () => {
      const sections = (text) => {
        const s = projectMod.emptySummarySections();
        s.梗概 = text;
        return s;
      };
      // 同一个章号、不同标题：作者手改文件名撞车时两条都要留住。
      write('chapters/020-序.md', '# 序\n\n序章正文。\n');
      write('chapters/020-正文.md', '# 正文\n\n正文内容。\n');
      project.invalidate();

      const listed = await project.listChapters();
      chA = listed.find((c) => c.relPath === 'chapters/020-序.md');
      chB = listed.find((c) => c.relPath === 'chapters/020-正文.md');
      await wsOf(project).writeSummary(chA, 'HASH_A', sections('序章的梗概。'), []);
      await wsOf(project).writeSummary(chB, 'HASH_B', sections('正文的梗概。'), []);

      seqSaved = has('.novelforge/summaries/020-序.md');
      bodySaved = has('.novelforge/summaries/020-正文.md');
      ra = await project.readSummary(chA.relPath);
      rb = await project.readSummary(chB.relPath);
    });

    test('第一章的摘要按章节名落盘', () => {
      assert.ok(seqSaved);
    });

    test('同号不同名的第二章摘要独立落盘', () => {
      assert.ok(bodySaved);
    });

    test('第一章读回自己的内容', () => {
      assert.equal(ra && ra.sections.梗概, '序章的梗概。', JSON.stringify(ra && ra.sections));
    });

    test('第二章读回自己的内容', () => {
      assert.equal(rb && rb.sections.梗概, '正文的梗概。', JSON.stringify(rb && rb.sections));
    });

    test('两份摘要互不覆盖', () => {
      assert.notEqual(ra.sections.梗概, rb.sections.梗概);
    });

    // 分卷子目录也要镜像进去，否则两卷里的同名章会撞成一份摘要。
    test('子目录跟着镜像', () => {
      assert.equal(
        project.summaryMirrorRelPath('chapters/第一卷/003-深处.md'),
        '.novelforge/summaries/第一卷/003-深处.md'
      );
    });
  });

  /**
   * 单段摘要的浮窗视图（工程页鼠标悬停在剧情行上时按需取一次）。
   *
   * 与 `buildProjectTree` 分开是有意的：摘要正文上千字，而那棵树每次文件变动
   * 都全量重推，把摘要塞进去等于每保存一次正文就多推几百 KB。
   */
  describe('单段摘要视图（悬停浮窗的数据源）', () => {
    const PLOT = '.novelforge/plots/030-有摘要.md';
    let view;
    let staleAfterEdit;
    let none;
    let ghost;
    let handEdited;
    let allPlaceholder;

    const chapterOf = async (no) => (await project.listChapters()).find((c) => c.order === no);

    before(async () => {
      await wsOf(project).writePlot({
        no: 30, title: '有摘要', arc: '', upstreamHash: '', done: false,
        sections: { 目标: 'x', 剧情脉络: '甲乙丙', 冲突与转折: '', 伏笔与回收: '' },
      });
      // 摘要挂在成品上，所以这一章要先拆分发布出去。
      write('chapters/030-有摘要.md', '# 有摘要\n\n正文内容。\n');
      project.invalidate();
      const secs = projectMod.emptySummarySections();
      secs.梗概 = '摘要正文。';
      await wsOf(project).writeSummary(await chapterOf(30), (await chapterOf(30)).contentHash, secs, []);
      project.invalidate();
      view = await projectView.buildPlotSummaryView(project, PLOT);

      // 正文改过 → 浮窗必须说「已过期」，否则用户会照着旧摘要做判断。
      write('chapters/030-有摘要.md', '# 有摘要\n\n正文内容。又加了一段。\n');
      project.invalidate();
      staleAfterEdit = (await projectView.buildPlotSummaryView(project, PLOT)).stale;

      // 没总结过的章不是错误，给 exists:false 让前端说清楚。
      const bare = await wsOf(project).writePlot({
        no: 31, title: '没摘要', arc: '', upstreamHash: '', done: false,
        sections: { 目标: 'y', 剧情脉络: '丁', 冲突与转折: '', 伏笔与回收: '' },
      });
      write('chapters/031-没摘要.md', '# 没摘要\n\n随便写点。\n');
      project.invalidate();
      none = await projectView.buildPlotSummaryView(project, bare);

      // 不存在的章：不抛异常，退化成「没有摘要」。
      ghost = await projectView.buildPlotSummaryView(project, '.novelforge/plots/999-不存在.md');

      // 作者手改摘要、把小节标题全删了 → 退回全文，不给空浮窗。
      const secs2 = projectMod.emptySummarySections();
      secs2.梗概 = '会被覆盖掉。';
      await wsOf(project).writeSummary(await chapterOf(31), 'H', secs2, []);
      const summaryFile = rel('.novelforge/summaries/031-没摘要.md');
      const raw = fs.readFileSync(summaryFile, 'utf8');
      // 留下 frontmatter 与 H1，正文改成没有任何 `## 小节` 的大白话。
      fs.writeFileSync(
        summaryFile,
        `${raw.split('\n\n#')[0]}\n\n# 第31章 没摘要 · 摘要\n\n我自己写的一段话。\n`
      );
      project.invalidate();
      handEdited = await projectView.buildPlotSummaryView(project, bare);

      // 六个小节全是占位的空摘要：不退回全文，否则浮窗里摊六行「（待补充）」。
      await wsOf(project).writeSummary(await chapterOf(31), 'H', projectMod.emptySummarySections(), []);
      project.invalidate();
      allPlaceholder = await projectView.buildPlotSummaryView(project, bare);
    });

    test('摘要存在', () => {
      assert.equal(view.exists, true);
    });

    test('带章号与标题', () => {
      assert.equal(view.no, 30, view.title);
      assert.equal(view.title, '有摘要', view.title);
    });

    test('新鲜的摘要不标过期', () => {
      assert.equal(view.stale, false);
    });

    test('给出摘要文件路径', () => {
      assert.ok(view.relPath.endsWith('030-有摘要.md'), view.relPath);
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

    test('未总结的章 exists 为 false', () => {
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

    test('不存在的段退化为空视图', () => {
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

  /**
   * 细纲的改名与删除**不走区守卫那条路**。
   *
   * `plots/` 不是三个可管理区之一（`sectionOf` 认不出它），而且一段剧情
   * 不只是一个文件：中转站正文的身份就是段文件名的词干，当成普通文件搬会把它
   * 变成孤儿——作者会看到「这一段还没写正文」，而那份正文就躺在旁边一个没人
   * 认领的目录里。
   */
  describe('细纲的改名与删除', () => {
    const NO = 40;
    let created;
    let renamed;
    let renamedExists;
    let oldGone;
    let manuscriptFollowed;
    let summaryFollowed;
    let sectionsKept;
    let manifestFollowed;
    let deleted;
    let plotTrashed;
    let manuscriptTrashed;
    let cancelled;
    let cancelledKept;
    let missing;
    let missingErred;

    before(async () => {
      created = await wsOf(project).writePlot({
        no: NO, title: '', arc: '', upstreamHash: '', done: false,
        sections: { 目标: '进宗门', 剧情脉络: '甲乙丙', 冲突与转折: '', 伏笔与回收: '' },
      });
      await wsOf(project).appendToManuscript(created, '正文内容。');
      await project.syncManifest();
      project.invalidate();

      // 纯序号名（新建出来的样子）的第一次命名。
      h.expect('入宗风波');
      renamed = await fileOps.renamePlot(project, created);
      renamedExists = !!renamed && has(renamed);
      oldGone = !has(created);
      manuscriptFollowed = has('.novelforge/manuscripts/040-入宗风波.md');
      project.invalidate();
      const after = await project.readPlot(renamed);
      sectionsKept = after && after.sections.剧情脉络;

      // 取消删除：什么都不该动。
      h.expect(undefined);
      cancelled = await fileOps.deletePlot(project, renamed);
      cancelledKept = has(renamed);

      h.expect('删除');
      deleted = await fileOps.deletePlot(project, renamed);
      plotTrashed = has('.novelforge/.trash/.novelforge/plots/040-入宗风波.md');
      manuscriptTrashed = has('.novelforge/.trash/.novelforge/manuscripts/040-入宗风波.md');

      // 已经删掉的段再删一次：报错退出，不抛。
      h.expect('删除');
      missing = await fileOps.deletePlot(project, renamed);
      missingErred = h.erred();
      project.invalidate();
    });

    test('改名后新文件在', () => {
      assert.ok(renamedExists, String(renamed));
    });

    test('改名保留序号前缀', () => {
      assert.equal(renamed, '.novelforge/plots/040-入宗风波.md', String(renamed));
    });

    test('旧文件不再并存', () => {
      assert.ok(oldGone);
    });

    test('正文跟着改名', () => {
      assert.ok(manuscriptFollowed);
    });

    test('改名不动小节内容', () => {
      assert.equal(sectionsKept, '甲乙丙', String(sectionsKept));
    });

    test('取消删除时返回 false', () => {
      assert.equal(cancelled, false);
    });

    test('取消删除时文件还在', () => {
      assert.ok(cancelledKept);
    });

    test('确认后删掉了', () => {
      assert.equal(deleted, true);
    });

    test('删除是搬进回收站，不真删', () => {
      assert.ok(plotTrashed);
    });

    test('正文一起进回收站', () => {
      assert.ok(manuscriptTrashed);
    });

    // 摘要**不**跟着走：它挂在 `chapters/` 里的成品上。删掉细纲只是放弃这一章
    // 的规划稿，不该把作者已经拆分发布出去的正文与摘要一起带走。
    test('删细纲不动摘要', () => {
      assert.ok(!has('.novelforge/.trash/.novelforge/summaries/040-入宗风波.md'));
    });

    test('删不存在的段返回 false', () => {
      assert.equal(missing, false);
    });

    test('删不存在的段报错而不是静默', () => {
      assert.ok(missingErred);
    });
  });
});
