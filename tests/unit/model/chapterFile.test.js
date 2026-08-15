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

/**
 * `splitByMark`：把中转站正文按单独一行 `---` 切成若干章。
 *
 * 这是拆分动作的判据。它**绝不抛**——作者会在正文里手打各种东西，
 * 一个畸形的分隔符不该让「拆成章节」这个按钮报错。
 *
 * 空片一律丢弃：连着两条 `---`、首尾各有一条，都不该产出一个空章节文件。
 */
describe('正文按 --- 拆分', () => {
  let chapterFile;
  const split = (text) => chapterFile.splitByMark(text);

  before(() => {
    chapterFile = loadModule('src/core/model/chapterFile.ts');
  });

  // 没有标记 = 一整章。这是「不标断点就直接发布」那条路。
  test('没有标记时是一整片', () => {
    assert.deepEqual(split('上半段。\n\n下半段。'), ['上半段。\n\n下半段。']);
  });

  test('一条标记切成两片', () => {
    assert.deepEqual(split('甲。\n\n---\n\n乙。'), ['甲。', '乙。']);
  });

  test('两条标记切成三片', () => {
    assert.deepEqual(split('甲。\n---\n乙。\n---\n丙。'), ['甲。', '乙。', '丙。']);
  });

  test('标记行本身不进任何一片', () => {
    assert.ok(!split('甲。\n---\n乙。').some((p) => p.includes('---')));
  });

  // 连着两条 = 作者手抖，不该多出一个空章。
  test('连续标记不产出空片', () => {
    assert.deepEqual(split('甲。\n---\n---\n乙。'), ['甲。', '乙。']);
  });

  test('开头的标记不产出空片', () => {
    assert.deepEqual(split('---\n甲。'), ['甲。']);
  });

  test('结尾的标记不产出空片', () => {
    assert.deepEqual(split('甲。\n---\n'), ['甲。']);
  });

  test('每片首尾空白被去掉', () => {
    assert.deepEqual(split('\n\n甲。\n\n---\n\n\n乙。\n\n'), ['甲。', '乙。']);
  });

  // 零片是「整篇只有分隔线」——调用方据此报错，而不是建一批空文件。
  test('整篇只有标记时零片', () => {
    assert.deepEqual(split('---\n---\n'), []);
  });

  test('空正文零片', () => {
    assert.deepEqual(split(''), []);
  });

  // Markdown 本身允许三个以上短横，顺手多打一个不该让拆分静默失效。
  test('四个以上短横同样算标记', () => {
    assert.deepEqual(split('甲。\n-----\n乙。'), ['甲。', '乙。']);
  });

  test('标记行前后的空白不影响识别', () => {
    assert.deepEqual(split('甲。\n  ---\t\n乙。'), ['甲。', '乙。']);
  });

  // 两个短横不是 Markdown 分隔线，也不该被当成断点。
  test('两个短横不算标记', () => {
    assert.deepEqual(split('甲。\n--\n乙。'), ['甲。\n--\n乙。']);
  });

  // 行内出现的横线是正文（西式破折号、图表），切开它等于毁掉一章。
  test('行内的横线不算标记', () => {
    assert.deepEqual(split('他顿了顿 --- 然后走了。'), ['他顿了顿 --- 然后走了。']);
  });

  test('CRLF 正文照样切得开', () => {
    assert.deepEqual(split('甲。\r\n---\r\n乙。'), ['甲。', '乙。']);
  });
});

