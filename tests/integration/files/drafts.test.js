/**
 * 草稿：每章在 drafts/ 下的镜像，按需创建、绝不覆盖、不进章节树也不进上下文。
 * 迁自 scripts/smoke-chapters.js 的草稿各节（40 条）。
 *
 * 分家说明：章节扫描/可编辑判定/createChapter 在同目录的 chapters.test.js；
 * 原 `== manifest 认得非 .md 章节 ==` 3 条里，只有「manifest 里没有草稿」在本文件
 * （它要求草稿真的存在才有意义），另两条在 chapters.test.js。3 = 1 + 2。
 *
 * 原脚本在草稿各节之前还跑过 `== createChapter ==` 一节（建 009/010 再删掉并 invalidate），
 * 磁盘与 manifest 均无残留，故此处略去，不影响任何断言。
 *
 * 时序敏感：草稿会被改名/移动搬走，凡是读草稿内容或 has() 的断言，
 * 都在操作后**当场**取值存进变量——等到断言时再读，文件早就不在原路径了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 产物写入搬进了 `core/workspace/`：正文追加要插分隔标记与记 beatsHash、
 * 建章节要同名报错并同步 manifest、草稿按需创建但绝不覆盖。`NovelProject`
 * 这一层只留领域查询。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);


describe('草稿', () => {
  let projectView;
  let fileOps;
  let attachments;
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
      chapterFile: './src/core/model/chapterFile.ts',
      markdown: './src/core/model/markdown.ts',
      project: './src/core/model/project.ts',
      ws: './src/core/workspace/index.ts',
      projectView: './src/core/views/projectView.ts',
      fileOps: './src/core/files/fileOps.ts',
      fileEditing: './src/core/files/fileEditing.ts',
      attachments: './src/core/files/attachments.ts',
    });
    wsMod = bundle.ws;
    ({ projectView, fileOps, attachments } = bundle);
    // 原脚本的 host 字面量里没有 reviewReplace，显式抹掉，别走进 diff 审阅分支。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'drafts', title: '章节格式测试' });
    ({ dir, rel, write, read, has, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    write('chapters/002-手记.txt', '他翻开笔记。\n\n# 这是纸上写的字\n\n然后合上了。\n');
    write('chapters/卷一/003-夜访.md', '# 夜访\n\n三更时分。\n');
    write('chapters/004-无扩展名', '没有扩展名的一章。\n');
    write('chapters/005-封面.png', 'PNG 假装');
    write('chapters/笔记.txt', '没有数字前缀，不是章节');
    write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    write('.novelforge/characters/说明.txt', '角色区不放宽扩展名');
    project.invalidate();
  });

  after(() => cleanup(dir));

  describe('草稿路径推导', () => {
    test('根目录 .md 章节', () => {
      assert.equal(
        project.draftRelPathFor('chapters/001-楔子.md'),
        'drafts/001-楔子.md',
        project.draftRelPathFor('chapters/001-楔子.md')
      );
    });

    test('子目录镜像层级', () => {
      assert.equal(
        project.draftRelPathFor('chapters/卷一/003-夜访.md'),
        'drafts/卷一/003-夜访.md',
        project.draftRelPathFor('chapters/卷一/003-夜访.md')
      );
    });

    test('.txt 章节草稿也是 .txt', () => {
      assert.equal(
        project.draftRelPathFor('chapters/002-手记.txt'),
        'drafts/002-手记.txt',
        project.draftRelPathFor('chapters/002-手记.txt')
      );
    });

    test('无扩展名章节草稿也无扩展名', () => {
      assert.equal(
        project.draftRelPathFor('chapters/004-无扩展名'),
        'drafts/004-无扩展名',
        project.draftRelPathFor('chapters/004-无扩展名')
      );
    });

    test('章节根之外的路径没有草稿', () => {
      assert.equal(
        project.draftRelPathFor('.novelforge/characters/林昭.md'),
        undefined,
        project.draftRelPathFor('.novelforge/characters/林昭.md')
      );
    });
  });

  describe('草稿按需创建，绝不覆盖', () => {
    let first;
    let firstExists;
    let firstHead;
    let secondBody;
    let txtDraftBody;
    let paths;

    before(async () => {
      const md = await project.getChapter(1);
      first = await wsOf(project).ensureDraft(md);
      firstExists = has(first);
      firstHead = read(first);

      // 作者往草稿里写了东西，再点一次「打开草稿」不能被抹掉。
      write(first, '# 楔子 · 草稿\n\n这段是我自己写的，不能丢。\n');
      const second = await wsOf(project).ensureDraft(md);
      secondBody = read(second);

      const txt = await project.getChapter(2);
      const txtDraft = await wsOf(project).ensureDraft(txt);
      txtDraftBody = read(txtDraft);

      paths = await project.listDraftPaths();
    });

    test('返回草稿相对路径', () => {
      assert.equal(first, 'drafts/001-楔子.md', first);
    });

    test('草稿已落盘', () => {
      assert.ok(firstExists);
    });

    test('markdown 草稿带模板头', () => {
      assert.ok(firstHead.startsWith('# 楔子 · 草稿'), firstHead.slice(0, 20));
    });

    test('第二次调用不覆盖已有草稿', () => {
      assert.ok(secondBody.includes('这段是我自己写的'), secondBody);
    });

    test('.txt 章节的草稿是空文件（不塞 markdown）', () => {
      assert.equal(txtDraftBody, '', JSON.stringify(txtDraftBody));
    });

    test('listDraftPaths 收到两份', () => {
      assert.equal(paths.size, 2, `got ${paths.size}`);
    });

    test('集合里是工作区相对路径', () => {
      assert.ok(paths.has('drafts/001-楔子.md'), [...paths].join(','));
      assert.ok(paths.has('drafts/002-手记.txt'), [...paths].join(','));
    });
  });

  describe('草稿不混进章节与工程树', () => {
    let chapters;
    let flat;
    let withDraft;
    let noDraft;

    before(async () => {
      project.invalidate();
      chapters = await project.listChapters();

      // 工程树只有一条章节列表（规划与成品合在一起），本身就是扁平的。
      const tree = await projectView.buildProjectTree(project);
      flat = tree.plots;

      withDraft = flat.find((n) => n.no === 1);
      noDraft = flat.find((n) => n.no === 3);
    });

    test('drafts/ 里的文件不算章节', () => {
      assert.ok(
        !chapters.some((c) => c.relPath.startsWith('drafts/')),
        chapters.map((c) => c.relPath).join(',')
      );
    });

    test('章节数没变', () => {
      assert.equal(chapters.length, 4, `got ${chapters.length}`);
    });

    test('树上没有 drafts 节点', () => {
      assert.ok(
        !flat.some((n) => n.relPath.startsWith('drafts/')),
        flat.map((n) => n.relPath).join(',')
      );
    });

    test('已建草稿的章节 hasDraft 为真', () => {
      assert.equal(withDraft.hasDraft, true);
    });

    test('带上 draftPath', () => {
      assert.equal(withDraft.draftPath, 'drafts/001-楔子.md', withDraft.draftPath);
    });

    test('未建草稿的章节 hasDraft 为假', () => {
      assert.equal(noDraft.hasDraft, false);
    });

    test('未建也给出 draftPath（路径是推导出来的）', () => {
      assert.equal(noDraft.draftPath, 'drafts/卷一/003-夜访.md', noDraft.draftPath);
    });

    test('草稿不是可管理区', () => {
      assert.equal(fileOps.sectionOf(project, 'drafts/001-楔子.md'), undefined);
    });
  });

  describe('@ 引用里的草稿组', () => {
    let choices;
    let drafts;

    before(async () => {
      choices = await attachments.listAttachmentChoices(project);
      drafts = choices.filter((c) => c.group === '草稿');
    });

    test('只列已存在的草稿', () => {
      assert.equal(drafts.length, 2, `got ${drafts.length}`);
    });

    test('标签带「· 草稿」', () => {
      assert.ok(
        drafts.every((d) => d.label.includes('· 草稿')),
        drafts.map((d) => d.label).join(' | ')
      );
    });

    test('detail 指向 drafts/', () => {
      assert.ok(
        drafts.every((d) => d.detail.startsWith('drafts/')),
        drafts.map((d) => d.detail).join(' | ')
      );
    });

    test('章节组不受影响', () => {
      assert.equal(choices.filter((c) => c.group === '章节').length, 4);
    });
  });

  describe('草稿跟随章节改名 / 移动', () => {
    let renamed;
    let oldDraftGone;
    let renamedDraftExists;
    let renamedDraftBody;
    let moved;
    let movedDraftExists;
    let movedOldDraftGone;
    let txtRenamed;
    let txtBodyBefore;
    let txtBodyAfter;
    let txtDraftExists;

    before(async () => {
      h.expect('楔子改名');
      renamed = await fileOps.renameEntry(project, 'chapters/001-楔子.md');
      oldDraftGone = !has('drafts/001-楔子.md');
      renamedDraftExists = has('drafts/001-楔子改名.md');
      // 这份草稿马上会被下面的移动搬到 drafts/归档/ 去，内容必须当场读出来。
      renamedDraftBody = read('drafts/001-楔子改名.md');

      fs.mkdirSync(rel('chapters/归档'), { recursive: true });
      h.expect();
      moved = await fileOps.moveEntry(project, 'chapters/001-楔子改名.md', 'chapters/归档');
      movedDraftExists = has('drafts/归档/001-楔子改名.md');
      movedOldDraftGone = !has('drafts/001-楔子改名.md');

      // .txt 章节改名：不该往正文里塞 H1。
      txtBodyBefore = read('chapters/002-手记.txt');
      h.expect('手记改名');
      txtRenamed = await fileOps.renameEntry(project, 'chapters/002-手记.txt');
      txtBodyAfter = read(txtRenamed);
      txtDraftExists = has('drafts/002-手记改名.txt');
    });

    test('章节已改名', () => {
      assert.equal(renamed, 'chapters/001-楔子改名.md', renamed);
    });

    test('旧草稿已不在', () => {
      assert.ok(oldDraftGone);
    });

    test('草稿跟着改名', () => {
      assert.ok(renamedDraftExists);
    });

    test('草稿内容原样带过去', () => {
      assert.ok(renamedDraftBody.includes('这段是我自己写的'), renamedDraftBody);
    });

    test('章节已移动', () => {
      assert.equal(moved, 'chapters/归档/001-楔子改名.md', moved);
    });

    test('草稿跟着移动', () => {
      assert.ok(movedDraftExists);
    });

    test('旧位置草稿已清掉', () => {
      assert.ok(movedOldDraftGone);
    });

    test('.txt 章节改名保留序号前缀', () => {
      assert.equal(txtRenamed, 'chapters/002-手记改名.txt', txtRenamed);
    });

    test('.txt 章节正文一个字节没动', () => {
      assert.equal(txtBodyAfter, txtBodyBefore);
    });

    test('.txt 草稿也跟着改名', () => {
      assert.ok(txtDraftExists);
    });
  });

  describe('目标已有草稿时不覆盖', () => {
    let targetBody;
    let oldDraftKept;
    let oldDraftBody;
    let toastSnapshot;

    before(async () => {
      write('chapters/007-甲.md', '# 甲\n\n正文\n');
      project.invalidate();
      const seven = await project.getChapter(7);
      await wsOf(project).ensureDraft(seven);
      write('drafts/007-甲.md', '旧草稿');
      // 提前占位：改名后的目标草稿已经存在。
      write('drafts/007-乙.md', '占位的新草稿');

      h.expect('乙');
      await fileOps.renameEntry(project, 'chapters/007-甲.md');
      targetBody = read('drafts/007-乙.md');
      oldDraftKept = has('drafts/007-甲.md');
      oldDraftBody = read('drafts/007-甲.md');
      toastSnapshot = [...h.toasts];
    });

    test('目标草稿未被覆盖', () => {
      assert.equal(targetBody, '占位的新草稿', targetBody);
    });

    test('旧草稿留在原处', () => {
      assert.ok(oldDraftKept);
      assert.equal(oldDraftBody, '旧草稿');
    });

    test('给出了提示', () => {
      assert.ok(
        toastSnapshot.some((t) => t.startsWith('error:') && t.includes('drafts/007-乙.md')),
        toastSnapshot.join(' | ')
      );
    });
  });

  describe('删章节不删草稿', () => {
    let trashed;
    let draftKept;

    before(async () => {
      h.expect('删除');
      await fileOps.deleteEntry(project, 'chapters/归档/001-楔子改名.md');
      trashed = has('.novelforge/.trash/chapters/归档/001-楔子改名.md');
      draftKept = has('drafts/归档/001-楔子改名.md');
    });

    test('章节已进回收站', () => {
      assert.ok(trashed);
    });

    test('草稿没被一起删', () => {
      assert.ok(draftKept);
    });
  });

  /**
   * 草稿不进 manifest。
   *
   * manifest 索引的是 `chapters/` 里的成品；`drafts/` 是它的镜像目录，
   * 与正文一一同名，扫岔一层就会让每一章凭空多出一条索引。
   */
  describe('草稿不进 manifest', () => {
    let manifest;

    before(async () => {
      project.invalidate();
      manifest = await project.syncManifest();
    });

    test('manifest 里没有草稿', () => {
      assert.ok(
        !manifest.chapters.some((c) => c.file.startsWith('drafts/')),
        JSON.stringify(manifest.chapters.map((c) => c.file))
      );
    });

    // 反过来也要守：章节必须在，否则「不进草稿」可以靠索引全空来蒙混过关。
    test('manifest 里有章节', () => {
      assert.ok(
        manifest.chapters.every((c) => c.file.startsWith('chapters/')) && manifest.chapters.length > 0,
        JSON.stringify(manifest.chapters.map((c) => c.file))
      );
    });
  });
});
