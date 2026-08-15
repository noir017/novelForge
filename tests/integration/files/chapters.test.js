/**
 * 「什么算章节」落到磁盘上的部分：任意后缀的扫描、可编辑判定、createChapter 的默认扩展名。
 * 迁自 scripts/smoke-chapters.js 的文件系统半场（19 条）。
 *
 * 分家说明（三处，账要对得上）：
 * - 本脚本前两节（`== 章节文件名规则 ==` 18 条、`== extractH1 只看首行 ==` 3 条）是纯函数，
 *   不在本文件，另见 unit 侧。
 * - 草稿相关各节（40 条）在同目录的 drafts.test.js。
 * - 原 `== manifest 认得非 .md 章节 ==` 那一节已随「章节退出流水线」改写：manifest
 *   现在只索引剧情段，见本文件末尾那一节。
 *   「manifest 里没有草稿」那一条只有草稿真的存在时才有意义，放在 drafts.test.js。
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
      projectView: './src/core/views/projectView.ts',
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
    let bare;
    let bareBody;
    let bareTitle;
    let bareWords;

    before(async () => {
      created = await project.createChapter(9, '新章', '', undefined);
      createdHead = read(created);
      txt = await project.createChapter(10, '纯文本章', '正文', undefined, '.txt');
      txtBody = read(txt);
      // 流水线新建那条路：还没有标题可言，落成纯序号名。
      bare = await project.createChapter(11, '', '', undefined);
      bareBody = read(bare);
      project.invalidate();
      const scanned = (await project.listChapters()).find((c) => c.relPath === bare);
      bareTitle = scanned && scanned.title;
      bareWords = scanned && scanned.wordCount;
    });

    after(() => {
      remove(created);
      remove(txt);
      remove(bare);
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

    test('标题留空时文件名只有序号', () => {
      assert.equal(bare, 'chapters/011.md', bare);
    });

    // 不写 `# `：空标题行既没意义，又会让改名时的 H1 同步判据从第一天就对不上。
    test('标题留空时不写标题行', () => {
      assert.equal(bareBody.trim(), '', JSON.stringify(bareBody));
    });

    test('扫描时标题回落成「第 N 章」', () => {
      assert.equal(bareTitle, '第 11 章', bareTitle);
    });

    test('新建出来是 0 字', () => {
      assert.equal(bareWords, 0, String(bareWords));
    });
  });

  /**
   * 章节退出流水线之后，manifest 只索引**剧情段**。
   *
   * 这一节从前钉的是「.txt 章节也进 manifest」——那时章节是创作单位。现在
   * `chapters/` 是作者切好的发布区，工具不分析它的内容，也就没有什么可索引的：
   * 它的字数、hash、摘要新鲜度全都无从谈起（一章可能是两段拼的）。
   */
  describe('manifest 不索引章节', () => {
    let manifest;

    before(async () => {
      project.invalidate();
      manifest = await project.syncManifest();
    });

    test('manifest 里是 plots 而不是 chapters', () => {
      assert.ok(Array.isArray(manifest.plots), JSON.stringify(Object.keys(manifest)));
      assert.equal(manifest.chapters, undefined);
    });

    // 这个工程只有 chapters/ 下的文件，一段剧情都没有。
    test('只有章节没有剧情段时 plots 为空', () => {
      assert.equal(manifest.plots.length, 0, JSON.stringify(manifest.plots));
    });

    // 章节仍然扫得到、列得出、能改名/移动/删除——只是不进索引。
    test('章节仍然列得出来', async () => {
      assert.ok((await project.listChapters()).length > 0);
    });
  });
});
