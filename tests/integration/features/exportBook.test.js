/**
 * 导出全文（`features/exportBook.ts`，2026-10-24）：全部章节按章号拼成一份 txt，写到工程根下的 `导出/<书名>.txt`。
 *
 * - 开头《书名》与作者；章标题「第一章 楔子」（汉字章号），没起名的只有「第二章」，标题已经带章号的照原样。
 * - 分卷的书进一卷之前单起一行卷名；更深的子目录不出行。markdown 正文去掉 `# 标题` 行，`\r\n` 当 `\n`。
 * - 没有正文的章不放进去；再导一次直接覆盖，不审阅；超过网关 2MB 上限的也写得下。
 * - `导出/` 不扫成章节、不进导入原稿的清单。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('导出全文', () => {
  let bundle;
  let h;
  let t;
  let project;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      exportBook: './src/core/features/exportBook.ts',
    });
    h = makeFakeHost();
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'export-book', title: '雪夜行' });
    project = t.project;
  });

  after(() => cleanup(t.dir));

  describe('标题行', () => {
    test('汉字章号 + 标题', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 1, title: '楔子' }), '第一章 楔子');
      assert.equal(bundle.exportBook.exportHeading({ order: 105, title: '夜奔' }), '第一百零五章 夜奔');
    });

    test('没起名的章只有章号', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 12, title: '第 12 章' }), '第十二章');
    });

    test('标题已经带章号的照原样', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 4, title: '第四章-风起' }), '第四章-风起');
    });
  });

  describe('还没有章节', () => {
    let result;

    before(async () => {
      h.expect();
      result = await bundle.exportBook.exportBookText(project);
    });

    test('只提示，不写文件', () => {
      assert.equal(result, undefined);
      assert.ok(h.erred());
      assert.ok(!t.has('导出/雪夜行.txt'));
    });
  });

  describe('拼成一份', () => {
    let result;
    let text;
    let toasts;
    let chapterPaths;
    let importable;

    before(async () => {
      t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      t.write('chapters/002.txt', '他走进青崖镇。\r\n\r\n镇上很静。\r\n');
      t.write('chapters/第二卷/003-夜访.txt', '三更时分。\n');
      t.write('chapters/第二卷/深处/004-第四章-风起.txt', '风起了。');
      t.write('chapters/第二卷/005-空章.txt', '');
      t.write('chapters/第三卷/011-远方.txt', '远方。\n');
      t.write('原稿.txt', '一本要导入的书。\n');
      project.invalidate();
      h.expect();
      result = await bundle.exportBook.exportBookText(project);
      toasts = [...h.toasts];
      text = t.read('导出/雪夜行.txt');
      project.invalidate();
      chapterPaths = (await project.listChapters()).map((c) => c.relPath);
      importable = (await project.listImportableTexts()).map((x) => x.relPath);
    });

    test('写到 导出/<书名>.txt', () => {
      assert.deepEqual(result, { rel: '导出/雪夜行.txt', chapters: 5, skipped: 1 });
    });

    test('书名、作者、卷名、章标题与正文按章号排好', () => {
      assert.equal(
        text,
        [
          '《雪夜行》\n作者：测试',
          '第一章 楔子\n\n雨下了三天。',
          '第二章\n\n他走进青崖镇。\n\n镇上很静。',
          '第二卷',
          '第三章 夜访\n\n三更时分。',
          '第四章-风起\n\n风起了。',
          '第三卷',
          '第十一章 远方\n\n远方。',
        ].join('\n\n') + '\n'
      );
    });

    test('提示里报了路径、章数与没放进去的空章', () => {
      assert.ok(toasts.some((x) => x.startsWith('info: 已导出全文：导出/雪夜行.txt（5 章') && x.includes('1 章没有正文')), toasts.join(' | '));
    });

    test('导出的那份不算章节、不进导入原稿的清单', () => {
      assert.ok(!chapterPaths.some((p) => p.startsWith('导出/')), chapterPaths.join(', '));
      assert.deepEqual(importable, ['原稿.txt']);
    });
  });

  describe('再导一次', () => {
    let text;
    let reviews;
    let confirms;

    before(async () => {
      t.write('chapters/001-楔子.md', '# 楔子\n\n雨停了。\n');
      // 超过网关的 2MB 上限：导出的那份照样写得下。
      t.write('chapters/012-长章.txt', '长'.repeat(800 * 1024));
      project.invalidate();
      h.expect();
      await bundle.exportBook.exportBookText(project);
      reviews = h.reviewed.length;
      confirms = h.confirms.length;
      text = t.read('导出/雪夜行.txt');
    });

    test('直接覆盖，不审阅、不确认', () => {
      assert.equal(reviews, 0);
      assert.equal(confirms, 0);
      assert.ok(text.includes('第一章 楔子\n\n雨停了。'), text.slice(0, 80));
      assert.ok(!text.includes('雨下了三天'));
    });

    test('超过 2MB 也写得下', () => {
      assert.ok(Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024);
      assert.ok(text.includes('第十二章 长章'));
    });
  });
});
