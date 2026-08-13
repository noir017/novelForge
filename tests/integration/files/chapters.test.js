/**
 * 「什么算章节」落到磁盘上的部分：任意后缀的扫描、可编辑判定、createChapter 的默认扩展名。
 * 迁自 scripts/smoke-chapters.js 的文件系统半场（19 条）。
 *
 * 分家说明（三处，账要对得上）：
 * - 本脚本前两节（`== 章节文件名规则 ==` 18 条、`== extractH1 只看首行 ==` 3 条）是纯函数，
 *   不在本文件，另见 unit 侧。
 * - 草稿相关各节（40 条）在同目录的 drafts.test.js。
 * - 原 `== manifest 认得非 .md 章节 ==` 共 3 条：前两条属章节议题留在本文件，
 *   第三条「manifest 里没有草稿」只有草稿真的存在时才有意义，放在 drafts.test.js。
 *   3 = 2 + 1，不重不漏。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('章节文件规则（磁盘）', () => {
  let projectView;
  let fileEditing;
  let project;
  let dir;
  let rel;
  let write;
  let read;
  let remove;

  before(async () => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      chapterFile: './src/core/model/chapterFile.ts',
      markdown: './src/core/model/markdown.ts',
      project: './src/core/model/project.ts',
      projectView: './src/core/projectView.ts',
      fileOps: './src/core/files/fileOps.ts',
      fileEditing: './src/core/files/fileEditing.ts',
      attachments: './src/core/files/attachments.ts',
    });
    ({ projectView, fileEditing } = bundle);
    // 原脚本的 host 字面量里没有 reviewReplace，显式抹掉，别走进 diff 审阅分支。
    bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);

    const t = await makeTempProject(bundle.project, { prefix: 'chapters', title: '章节格式测试' });
    ({ dir, rel, write, read, remove, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    // 正文中段有一行像标题的字：不该被当成章节标题，也不该从正文里消失。
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

  describe('扫描：任意后缀', () => {
    let chapters;
    let txt;
    let txtBody;
    let md;
    let mdBody;
    let bare;
    let cards;

    before(async () => {
      chapters = await project.listChapters();
      txt = chapters.find((c) => c.order === 2);
      txtBody = await project.readChapterText(txt);
      md = chapters.find((c) => c.order === 1);
      mdBody = await project.readChapterText(md);
      bare = chapters.find((c) => c.order === 4);
      cards = await project.listCharacters();
    });

    test('扫到四章（.md / .txt / 无扩展名，跨子目录）', () => {
      assert.equal(chapters.length, 4, `got ${chapters.length}`);
    });

    test('png 不算章节', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('.png')));
    });

    test('无数字前缀的 txt 不算章节', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('笔记.txt')));
    });

    test('.txt 章节标题取自文件名，不吃正文里的 #', () => {
      assert.equal(txt.title, '手记', txt.title);
    });

    test('.txt 章节正文原样保留那行 #', () => {
      assert.ok(txtBody.includes('# 这是纸上写的字'), txtBody);
    });

    test('.md 章节仍取 H1', () => {
      assert.equal(md.title, '楔子', md.title);
    });

    test('.md 章节 readChapterText 仍剥掉 H1', () => {
      assert.equal(mdBody, '雨下了三天。', mdBody);
    });

    test('无扩展名章节标题取自文件名', () => {
      assert.equal(bare.title, '无扩展名', bare.title);
    });

    test('角色区仍然只认 .md', () => {
      assert.equal(cards.length, 1, `got ${cards.length}`);
      assert.equal(cards[0].name, '林昭', `got ${cards.length}`);
    });
  });

  describe('可编辑判定', () => {
    test('无扩展名章节可编辑', () => {
      assert.ok(fileEditing.isEditablePath('chapters/004-无扩展名'));
    });

    test('.rtf 章节可编辑', () => {
      assert.ok(fileEditing.isEditablePath('chapters/006-手记.rtf'));
    });

    test('.png 不可编辑', () => {
      assert.ok(!fileEditing.isEditablePath('chapters/005-封面.png'));
    });

    test('白名单里的 json 仍可编辑', () => {
      assert.ok(fileEditing.isEditablePath('.novelforge/project.json'));
    });

    test('非章节的 png 不可编辑', () => {
      assert.ok(!fileEditing.isEditablePath('media/icon.png'));
    });
  });

  describe('createChapter 默认仍出 .md', () => {
    let created;
    let createdHead;
    let txt;
    let txtBody;

    before(async () => {
      created = await project.createChapter(9, '新章', '', undefined);
      createdHead = read(created);
      txt = await project.createChapter(10, '纯文本章', '正文', undefined, '.txt');
      txtBody = read(txt);
    });

    after(() => {
      remove(created);
      remove(txt);
      project.invalidate();
    });

    test('文件名带 .md', () => {
      assert.equal(created, 'chapters/009-新章.md', created);
    });

    test('markdown 家族写标题行', () => {
      assert.ok(createdHead.startsWith('# 新章'), createdHead.slice(0, 20));
    });

    test('指定 .txt 时不写标题行', () => {
      assert.equal(txtBody, '正文\n', JSON.stringify(txtBody));
    });
  });

  describe('manifest 认得非 .md 章节', () => {
    let manifest;
    let txt;

    before(async () => {
      project.invalidate();
      manifest = await project.syncManifest();
      txt = manifest.chapters.find((c) => c.file.endsWith('.txt'));
    });

    test('.txt 章节进了 manifest', () => {
      assert.ok(txt, manifest.chapters.map((c) => c.file).join(','));
    });

    test('记录了 order 与 hash', () => {
      assert.ok(txt);
      assert.equal(txt.order, 2);
      assert.equal(typeof txt.contentHash, 'string');
    });
  });
});
