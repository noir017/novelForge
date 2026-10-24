/**
 * 章节文件名规则：什么算章节、序号/词干/扩展名怎么拆，以及 extractH1 只看首行。
 * 迁自 scripts/smoke-chapters.js 的 `== 章节文件名规则 ==` 与 `== extractH1 只看首行 ==` 两节
 * （原脚本 main() 里第一次 NovelProject.open 之前的纯函数部分）。
 *
 * 这两节零 I/O：不建工程、不要 host，直接 bundle 出来调。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('章节文件名规则', () => {
  let chapterFile;

  before(() => {
    chapterFile = loadModule('src/core/model/chapterFile.ts');
  });

  // 「什么算章节」不再只认 .md——数字前缀 + 非二进制扩展名即可。
  const yes = ['001-楔子.md', '001-楔子.txt', '001-楔子', '004.json', '001-手记.rtf', '12_初入江湖.md', '003.md'];
  for (const name of yes) {
    test(`「${name}」算章节`, () => {
      assert.ok(chapterFile.isChapterFileName(name));
    });
  }

  const no = ['001-封面.png', '002-稿.docx', '003.zip', '004.mp3', '005.pdf', '006.exe', '笔记.txt', 'README.md'];
  for (const name of no) {
    test(`「${name}」不算章节`, () => {
      assert.ok(!chapterFile.isChapterFileName(name));
    });
  }

  // 作者放在卷目录里的笔记：整个标题就是笔记词（可带编号）才不算，词只在开头或结尾的照样是章节。
  const notes = ['047 细纲.txt', '048 作话.txt', '049-大纲.md', '050_笔记', '051 细纲2.txt', '052-Notes.md', '053.设定.txt'];
  for (const name of notes) {
    test(`笔记「${name}」不算章节`, () => {
      assert.ok(!chapterFile.isChapterFileName(name));
    });
  }
  const titled = ['047-设定崩塌.txt', '012-草稿纸上的名字.txt', '003-大纲之外.md', '020-作话之后', '031-备份计划.txt'];
  for (const name of titled) {
    test(`标题里带笔记词的「${name}」仍是章节`, () => {
      assert.ok(chapterFile.isChapterFileName(name));
    });
  }

  test('解析出序号/词干/扩展名', () => {
    const parsed = chapterFile.parseChapterFileName('001-楔子.txt');
    assert.equal(parsed.order, 1, JSON.stringify(parsed));
    assert.equal(parsed.stem, '楔子', JSON.stringify(parsed));
    assert.equal(parsed.ext, '.txt', JSON.stringify(parsed));
  });

  test('`003.md` 的词干为空（点没被当成分隔符吃掉扩展名）', () => {
    const bare = chapterFile.parseChapterFileName('003.md');
    assert.equal(bare.order, 3, JSON.stringify(bare));
    assert.equal(bare.stem, '', JSON.stringify(bare));
    assert.equal(bare.ext, '.md', JSON.stringify(bare));
  });

  test('无扩展名解析正确', () => {
    const noExt = chapterFile.parseChapterFileName('005-无扩展名');
    assert.equal(noExt.order, 5, JSON.stringify(noExt));
    assert.equal(noExt.stem, '无扩展名', JSON.stringify(noExt));
    assert.equal(noExt.ext, '', JSON.stringify(noExt));
  });
});

describe('extractH1 只看首行', () => {
  let markdown;

  before(() => {
    markdown = loadModule('src/core/model/markdown.ts');
  });

  test('首行是标题时取到', () => {
    assert.equal(markdown.extractH1('# 楔子\n\n正文'), '楔子');
  });

  test('标题在中段时不取', () => {
    assert.equal(
      markdown.extractH1('第一行\n\n# 后面的'),
      undefined,
      String(markdown.extractH1('第一行\n\n# 后面的'))
    );
  });

  test('与 stripH1 互逆', () => {
    assert.equal(markdown.stripH1('第一行\n\n# 后面的'), '第一行\n\n# 后面的');
  });
});
