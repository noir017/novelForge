/**
 * 自定义敏感词表的解析（`src/core/model/sensitiveWords.ts`，纯函数）。作者手维护这份文件（第 1 条：认不出的行跳过、绝不抛），
 * 内置编辑器的写作体检拿解析结果在正文里找字。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 一行一个词 | 前后空白不算、词中间的空格留着、行号从 1 起 |
 * | 注释与空行 | `#` 开头（前面可以有空白）的整行不算，空行不算；词里的 `#` 不当注释 |
 * | 替换词 | `词 => 替换词`，左右空白不算；只认半角 `=>` |
 * | 坏行 | `=>` 前没词、后没替换词、两个 `=>`、太长、替换词与原词一样、与前面某行重复（英文不分大小写）——跳过并说出第几行、为什么 |
 * | 容错 | BOM、CRLF、读不到（undefined）都不抛 |
 * | 模板 | 全是注释、一个词都不生效 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const s = loadModule('src/core/model/sensitiveWords.ts');
const plain = (x) => JSON.parse(JSON.stringify(x));

describe('敏感词表：一行一个词', () => {
  test('前后空白不算、词中间的空格留着、行号从 1 起', () => {
    const r = s.parseSensitiveWords('  某平台  \nfree money\n赌博');
    assert.deepEqual(plain(r.terms), [
      { term: '某平台', line: 1 },
      { term: 'free money', line: 2 },
      { term: '赌博', line: 3 },
    ]);
    assert.deepEqual(r.bad, []);
  });

  test('# 开头的行是注释（前面可以有空白），空行不算；词里的 # 不当注释', () => {
    const r = s.parseSensitiveWords('# 注释\n\n   # 也是注释\n   \nC#\n第一#');
    assert.deepEqual(plain(r.terms), [
      { term: 'C#', line: 5 },
      { term: '第一#', line: 6 },
    ]);
  });
});

describe('敏感词表：替换词', () => {
  test('「词 => 替换词」，左右空白不算', () => {
    const r = s.parseSensitiveWords('赌博=>博戏\n  杀人   =>   伤人  ');
    assert.deepEqual(plain(r.terms), [
      { term: '赌博', replacement: '博戏', line: 1 },
      { term: '杀人', replacement: '伤人', line: 2 },
    ]);
  });

  test('只认半角的「=>」：全角的那几个字原样是词的一部分', () => {
    const r = s.parseSensitiveWords('赌博＝＞博戏');
    assert.deepEqual(plain(r.terms), [{ term: '赌博＝＞博戏', line: 1 }]);
  });
});

describe('敏感词表：坏行跳过，说出第几行、为什么', () => {
  const r = s.parseSensitiveWords(
    ['好词', '=> 替换', '缺替换 =>', 'a => b => c', '长'.repeat(33), '同 => 同', 'Hello', 'HELLO => hi', 'ｈｅｌｌｏ', '后面的好词'].join('\n')
  );

  test('好的行照收，坏行不连累后面', () => {
    assert.deepEqual(r.terms.map((t) => t.term), ['好词', 'Hello', '后面的好词']);
  });

  test('每一个坏行都记下行号', () => {
    assert.deepEqual(r.bad.map((b) => b.line), [2, 3, 4, 5, 6, 8, 9]);
  });

  test('原因说得出', () => {
    const reason = Object.fromEntries(r.bad.map((b) => [b.line, b.reason]));
    assert.match(reason[2], /前面没有词/);
    assert.match(reason[3], /后面没有替换词/);
    assert.match(reason[4], /只能有一个/);
    assert.match(reason[5], /太长/);
    assert.match(reason[6], /一样/);
    assert.match(reason[8], /第 7 行/);
    assert.match(reason[9], /第 7 行/);
  });

  test('正好 32 个字不算太长', () => {
    assert.equal(s.parseSensitiveWords('长'.repeat(32)).terms.length, 1);
  });
});

describe('敏感词表：容错', () => {
  test('BOM 与 CRLF', () => {
    const r = s.parseSensitiveWords('﻿甲\r\n乙 => 丙\r\n');
    assert.deepEqual(plain(r.terms), [
      { term: '甲', line: 1 },
      { term: '乙', replacement: '丙', line: 2 },
    ]);
  });

  test('读不到（undefined）、不是字符串：当空的，不抛', () => {
    assert.deepEqual(plain(s.parseSensitiveWords(undefined)), { terms: [], bad: [] });
    assert.deepEqual(plain(s.parseSensitiveWords(42)), { terms: [], bad: [] });
  });

  test('模板全是注释：一个词都不生效、没有坏行', () => {
    const r = s.parseSensitiveWords(s.SENSITIVE_TEMPLATE);
    assert.deepEqual(plain(r), { terms: [], bad: [] });
    assert.match(s.SENSITIVE_TEMPLATE, /=>/);
  });
});
