/**
 * 正文的分段格式与一键排版（`src/core/model/paragraphFormat.ts`，纯函数、零 import——内置编辑器直接打包它）。
 *
 * | 组 | 钉的是什么 |
 * |---|---|
 * | 取值 | 英文值与中文说法都认、写坏了是 undefined；三种格式各自的段间隔与段首缩进 |
 * | 分隔行 | 标题行与只有符号的场景分隔行不缩进；一行省略号 / 破折号是一句话，要缩进 |
 * | `formatProse` | 三种格式各排一遍；frontmatter 原样；首尾空白（含全角、不换行空格、制表符）去掉；空了几行都收成一种；文末恰好一个换行；`\r\n` 当 `\n`；节选不认 frontmatter、不补换行；改了几处数得对、没变是 0 |
 * | `toFullWidthPunct` | 只在中文语境里转；数字之间、英文、`文件名.md`、网址、代码、frontmatter 不动；省略号、破折号、括号、直双引号的正反例；只改给定范围 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let P;
before(() => {
  P = loadModule('src/core/model/paragraphFormat.ts');
});

const W = '　　';

describe('分段格式的取值', () => {
  test('英文值不分大小写都认', () => {
    assert.equal(P.parseParagraphStyle('indent'), 'indent');
    assert.equal(P.parseParagraphStyle(' Both '), 'both');
  });

  test('中文说法也认', () => {
    assert.equal(P.parseParagraphStyle('空行分段'), 'blank');
    assert.equal(P.parseParagraphStyle('段首缩进'), 'indent');
    assert.equal(P.parseParagraphStyle('缩进加空行'), 'both');
  });

  test('写坏了、空着是 undefined（不猜）', () => {
    assert.equal(P.parseParagraphStyle('缩进'), undefined);
    assert.equal(P.parseParagraphStyle(''), undefined);
    assert.equal(P.isParagraphStyle('tab'), false);
  });

  test('缺省是空行分段', () => {
    assert.equal(P.DEFAULT_PARAGRAPH_STYLE, 'blank');
  });

  test('三种格式的段间隔、段首缩进与另起一段要插的字', () => {
    assert.deepEqual(
      P.PARAGRAPH_STYLES.map((s) => [P.paragraphGap(s), P.paragraphIndent(s), P.paragraphBreak(s)]),
      [
        ['\n\n', '', '\n\n'],
        ['\n', W, `\n${W}`],
        ['\n\n', W, `\n\n${W}`],
      ]
    );
  });
});

describe('标题行与场景分隔行', () => {
  test('# 开头的是标题', () => {
    assert.equal(P.isHeadingLine('# 第一章'), true);
    assert.equal(P.isHeadingLine('  ## 雨夜'), true);
    assert.equal(P.isHeadingLine('他说 # 号'), false);
  });

  test('只有符号的行是场景分隔', () => {
    for (const line of ['---', '***', '* * *', '※', '◇◇◇', '＊＊＊', '　~~~　']) {
      assert.equal(P.isSceneBreakLine(line), true, line);
    }
  });

  test('一行省略号、破折号是一句话，不是分隔', () => {
    for (const line of ['……', '——', '“……”', '- 一项', '他']) {
      assert.equal(P.isSceneBreakLine(line), false, line);
    }
  });
});

describe('formatProse', () => {
  const messy = `\n\n# 第一章 雨夜\n${W}他推开门。 \n\n\n\t她笑了。 \n* * *\n　后来的事。`;

  test('空行分段：段间空一行、段首不缩进', () => {
    assert.equal(P.formatProse(messy, 'blank'), '# 第一章 雨夜\n\n他推开门。\n\n她笑了。\n\n* * *\n\n后来的事。\n');
  });

  test('段首缩进：段首两个全角空格、段间不空行，标题与分隔行不缩进', () => {
    assert.equal(
      P.formatProse(messy, 'indent'),
      `# 第一章 雨夜\n${W}他推开门。\n${W}她笑了。\n* * *\n${W}后来的事。\n`
    );
  });

  test('缩进加空行：段首缩进且段间空一行', () => {
    assert.equal(
      P.formatProse(messy, 'both'),
      `# 第一章 雨夜\n\n${W}他推开门。\n\n${W}她笑了。\n\n* * *\n\n${W}后来的事。\n`
    );
  });

  test('顶部 frontmatter 原样保留', () => {
    const text = '---\ntitle: 雨夜\ntags: [a, b]\n---\n他推开门。\n她笑了。';
    assert.equal(P.formatProse(text, 'blank'), '---\ntitle: 雨夜\ntags: [a, b]\n---\n他推开门。\n\n她笑了。\n');
  });

  test('开头就是 --- 分隔线的正文不当成 frontmatter', () => {
    assert.equal(P.formatProse('---\n他推开门。\n---\n她笑了。', 'blank'), '---\n\n他推开门。\n\n---\n\n她笑了。\n');
  });

  test('\\r\\n 当 \\n', () => {
    assert.equal(P.formatProse('他推开门。\r\n\r\n她笑了。\r\n', 'blank'), '他推开门。\n\n她笑了。\n');
  });

  test('文末恰好一个换行', () => {
    assert.equal(P.formatProse('他推开门。\n\n\n', 'blank'), '他推开门。\n');
    assert.equal(P.formatProse('他推开门。', 'indent'), `${W}他推开门。\n`);
  });

  test('只有空白：排成空的', () => {
    assert.equal(P.formatProse('\n　\n', 'blank'), '');
  });

  test('已经是这个格式：一字不变，改了 0 处', () => {
    const text = `# 第一章\n${W}他推开门。\n${W}她笑了。\n`;
    assert.deepEqual(P.layoutProse(text, 'indent'), { text, changes: 0 });
  });

  test('改了几处：重排过的行与改过的段间隔各算一处', () => {
    // 「她笑了。」要缩进（1）；两段之间空了一行要收成不空行（1）；文末补换行（1）。
    assert.equal(P.layoutProse(`${W}他推开门。\n\n她笑了。`, 'indent').changes, 3);
  });

  test('节选：不认 frontmatter、不补文末换行', () => {
    assert.equal(P.formatProse('---\na: b\n---\n他推开门。', 'indent', { fragment: true }), `---\n${W}a: b\n---\n${W}他推开门。`);
  });
});

describe('toFullWidthPunct', () => {
  const t = (s) => P.toFullWidthPunct(s);

  test('前一个字是汉字时，半角 , . ? ! : ; 转全角', () => {
    assert.equal(t('他来了,坐下.真的?好!注意:一;二'), '他来了，坐下。真的？好！注意：一；二');
  });

  test('前一个字是中文标点或弯引号时也转', () => {
    assert.equal(t('“走吧”,他说'), '“走吧”，他说');
    assert.equal(t('（笑）.'), '（笑）。');
  });

  test('数字之间不动', () => {
    assert.equal(t('圆周率3.14，共1,000人'), '圆周率3.14，共1,000人');
  });

  test('英文句子不动', () => {
    assert.equal(t('Hello, world. Are you ok?'), 'Hello, world. Are you ok?');
  });

  test('「文件名.md」这种点后面紧跟字母数字的不动', () => {
    assert.equal(t('改一下配置.md里的值'), '改一下配置.md里的值');
  });

  test('网址与邮箱不动，网址后面那个句子的标点照转', () => {
    assert.equal(t('见https://a.com/b?x=1,y=2.'), '见https://a.com/b?x=1,y=2.');
    assert.equal(t('网址www.example.com,好的.'), '网址www.example.com,好的。');
    assert.equal(t('写信给我a.b@c.com,谢谢'), '写信给我a.b@c.com,谢谢');
  });

  test('Markdown 代码（行内与围栏）不动', () => {
    assert.equal(t('用`中,文`表示\n```\n代码,里\n```\n完了,'), '用`中,文`表示\n```\n代码,里\n```\n完了，');
  });

  test('顶部 frontmatter 不动', () => {
    assert.equal(t('---\ncast: [林昭, 苏晚]\n---\n林昭,走了'), '---\ncast: [林昭, 苏晚]\n---\n林昭，走了');
  });

  test('挨着中文的 ... 与 。。。 转 ……', () => {
    assert.equal(t('他说...算了'), '他说……算了');
    assert.equal(t('...算了'), '……算了');
    assert.equal(t('真的。。。吗'), '真的……吗');
  });

  test('英文里的省略号、两个点不动', () => {
    assert.equal(t('Wait... ok'), 'Wait... ok');
    assert.equal(t('他..走'), '他..走');
  });

  test('汉字之间的 -- 转 ——，别处不动', () => {
    assert.equal(t('他--他说'), '他——他说');
    assert.equal(t('a--b，十-一'), 'a--b，十-一');
  });

  test('括号里有汉字：一对一起转', () => {
    assert.equal(t('他(笑着)说'), '他（笑着）说');
  });

  test('括号里没有英文字母、外面挨着汉字：转', () => {
    assert.equal(t('(1)第一条'), '（1）第一条');
  });

  test('f(x) 这种不动，落单的括号不动', () => {
    assert.equal(t('函数f(x)的值'), '函数f(x)的值');
    assert.equal(t('他说(没说完'), '他说(没说完');
  });

  test('直双引号：同一行成对、中间有汉字时按顺序转成 “”', () => {
    assert.equal(t('他说:"你好."她答:"嗯."'), '他说：“你好。”她答：“嗯。”');
  });

  test('直双引号落单、或那一对里没有汉字：不动', () => {
    assert.equal(t('他说:"你好'), '他说："你好');
    assert.equal(t('型号"A1"很好'), '型号"A1"很好');
  });

  test('直单引号一律不动（英文撇号会把配对搅乱）', () => {
    assert.equal(t("don't 他说'好'"), "don't 他说'好'");
  });

  test('只改给定范围，判语境照样看前后文', () => {
    const text = '第一句,第二句,第三句,';
    const r = P.fullWidthPunct(text, { range: { start: 4, end: 8 } });
    assert.equal(r.text, '第一句,第二句，第三句,');
    assert.equal(r.changes, 1);
  });

  test('列出每一处替换（位置按原文）', () => {
    assert.deepEqual(P.fullWidthPunct('好...,').edits, [
      { at: 1, from: '...', to: '……' },
      { at: 4, from: ',', to: '，' },
    ]);
  });

  test('没有要转的：原样、0 处', () => {
    assert.deepEqual(P.fullWidthPunct('他走了。'), { text: '他走了。', changes: 0, edits: [] });
  });
});
