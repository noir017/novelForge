/**
 * 全书查找替换在一份文件上的口径（`src/core/model/bookFind.ts`）与范围表（`model/bookFindScope.ts`）。
 * 读盘、按范围列文件、上限在 tests/integration/views/bookFind.test.js；替换在 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 匹配口径 | 与内置编辑器的查找条同一份（`textFind`）：大小写、正则、零长度跳过、跨行 |
 * | 护住的字 | frontmatter 的围栏、键名、机器记的账（指纹、章号、字数、水位、状态位）不搜；名字 / 别名 / 标题 / cast 这些人写的值照搜；解析器认的小节标题不搜；大纲区间标题只护「第 a–b 章」那一截；正文、草稿一个字都不护 |
 * | 上下文 | 行号、列、同一行里前后一截（截过带「…」）、跨行画成「↵」、`\r\n` 不进上下文 |
 * | 预览 | 每一处换成什么：字面量原样，正则 `$1` 在全文里逐处展开 |
 * | 范围表 | 六个范围、缺省只勾正文、`isBookFindScope` |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const bf = loadModule('src/core/model/bookFind.ts');
const scope = loadModule('src/core/model/bookFindScope.ts');
const tf = loadModule('src/core/model/textFind.ts');

/** 一份文件里能搜到的字，按顺序。 */
const found = (text, kind, query, opts) => bf.fileHits(text, kind, query, opts).matches.map((m) => text.slice(m.start, m.end));

describe('匹配口径与查找条同一份', () => {
  const text = '林晚推门。\n林晚霞没说话。LIN lin\n';

  test('正文一个字都不护：结果与 textFind.findMatches 完全一样', () => {
    for (const [q, o] of [['林晚', {}], ['lin', {}], ['lin', { caseSensitive: true }], ['^林', { regex: true }], ['a*', { regex: true }]]) {
      assert.deepEqual(bf.fileHits(text, 'chapter', q, o).matches, tf.findMatches(text, q, o).matches, `${q} ${JSON.stringify(o)}`);
    }
  });

  test('零长度匹配跳过；正则可以跨行', () => {
    assert.deepEqual(found(text, 'chapter', '^', { regex: true }), []);
    assert.deepEqual(found(text, 'chapter', '。\\n林', { regex: true }), ['。\n林']);
  });

  test('正则写错：error，不抛', () => {
    const r = bf.fileHits(text, 'chapter', '(', { regex: true });
    assert.ok(r.error);
    assert.deepEqual(r.matches, []);
  });
});

describe('护住的字：frontmatter', () => {
  const plot = [
    '---',
    'no: 3',
    'title: 林晚夜访',
    'targetWords: 3000',
    'upstreamHash: a3f3',
    'writtenFrom: 33bb',
    'sourceHash: 3c3c',
    'cast: [林晚(阿晚), 老周]',
    'status: done',
    'generatedBy: novel-forge',
    '---',
    '',
    '# 第3章 林晚夜访',
    '',
    '## 梗概',
    '林晚在第3个夜里出门。',
    '',
  ].join('\n');

  test('人写的值照搜：标题、cast；正文照搜', () => {
    assert.deepEqual(found(plot, 'plot', '林晚'), ['林晚', '林晚', '林晚', '林晚']);
  });

  test('机器记的账不搜：章号、字数、指纹、状态位里的「3」一个都不列', () => {
    const at = bf.fileHits(plot, 'plot', '3').matches.map((m) => plot.slice(0, m.start).split('\n').length);
    // 只剩 `# 第3章` 那一行（第 13 行）与正文那一行（第 16 行）。
    assert.deepEqual(at, [13, 16]);
  });

  test('键名与围栏不搜', () => {
    assert.deepEqual(found(plot, 'plot', 'title'), []);
    assert.deepEqual(found(plot, 'plot', '---'), []);
    assert.deepEqual(found(plot, 'plot', 'Hash'), []);
  });

  test('从人写的值伸到下一行的匹配（跨行正则）不算', () => {
    assert.deepEqual(found(plot, 'plot', '夜访\\ntargetWords', { regex: true }), []);
  });

  test('块状数组：人写的键下面的条目照搜，机器的键下面的不搜', () => {
    const card = ['---', 'name: 林晚', 'aliases:', '  - 阿晚', '  - 晚儿', 'appearsIn:', '  - 3', '  - 13', '---', '', '# 林晚', ''].join('\n');
    // name、两条别名、`# 林晚` 标题行：四处；appearsIn 下面的 3、13 不列。
    assert.deepEqual(found(card, 'character', '晚'), ['晚', '晚', '晚', '晚']);
    assert.deepEqual(found(card, 'character', '3'), []);
  });

  test('CRLF 的 frontmatter 一样认；值里不含行尾的 \\r', () => {
    const crlf = '---\r\nname: 林晚\r\nstateHash: 3\r\n---\r\n\r\n# 林晚\r\n';
    assert.deepEqual(found(crlf, 'character', '林晚'), ['林晚', '林晚']);
    assert.deepEqual(found(crlf, 'character', '3'), []);
    assert.deepEqual(found('---\r\nname: 林晚\r\n---\r\n\r\n正文', 'character', '晚\\r', { regex: true }), []);
  });

  test('BOM 开头的 frontmatter 一样认', () => {
    const bom = '﻿---\nname: 林晚\nbodyHash: 33\n---\n\n正文 33';
    assert.deepEqual(bf.fileHits(bom, 'lore', '33').matches.length, 1);
  });

  test('正文与草稿不护：章节文件开头即使写了 frontmatter 也照搜', () => {
    const chapter = '---\nno: 3\n---\n\n第3章';
    assert.equal(found(chapter, 'chapter', '3').length, 2);
    assert.equal(found(chapter, 'draft', '3').length, 2);
  });

  test('机器记的账覆盖第 18 条的五个指纹与水位、状态位', () => {
    for (const key of ['upstreamHash', 'writtenFrom', 'sourceHash', 'stateHash', 'bodyHash', 'no', 'targetWords', 'updatedThrough', 'stateThrough', 'appearsIn', 'through', 'status', 'generatedBy', 'paragraphStyle']) {
      assert.ok(bf.MACHINE_FRONTMATTER_KEYS.has(key), key);
    }
    for (const key of ['name', 'aliases', 'title', 'cast', 'keywords', 'brief', 'tags']) {
      assert.ok(!bf.MACHINE_FRONTMATTER_KEYS.has(key), key);
    }
  });
});

describe('护住的字：解析器认的小节标题', () => {
  test('细纲的八节与第九节「设定」的标题行不搜，内容照搜', () => {
    const plot = '## 关键事件\n- 发生关键事件\n\n## 设定\n- 关键〔物品〕：一把钥匙\n\n### 关键事件：\n';
    assert.deepEqual(found(plot, 'plot', '关键'), ['关键', '关键']);
    assert.deepEqual(found(plot, 'plot', '设定'), []);
  });

  test('作者自加的小节标题照搜', () => {
    assert.deepEqual(found('## 关键事件补记\n', 'plot', '事件'), ['事件']);
  });

  test('角色卡、设定条目、架构、文风各认各的', () => {
    assert.deepEqual(found('## 当前状态\n状态良好', 'character', '状态'), ['状态']);
    assert.deepEqual(found('## 现状\n现状如此', 'lore', '现状'), ['现状']);
    assert.deepEqual(found('## 金手指\n他的金手指', 'setting', '金手指'), ['金手指']);
    assert.deepEqual(found('## 禁用词表\n- 禁用「顿时」', 'style', '禁用'), ['禁用']);
    // 种类对不上就不护：正文里的「## 当前状态」是作者写的字。
    assert.deepEqual(found('## 当前状态\n', 'chapter', '状态'), ['状态']);
  });

  test('情节大纲：区间标题只护「第 a–b 章」那一截，后面的标题照搜', () => {
    const outline = '# 情节大纲\n\n## 第1–5章：林晚入宗\n第1章林晚到了。\n\n## 第 6 章 - 第 10 章 林晚下山\n';
    assert.deepEqual(found(outline, 'outline', '林晚'), ['林晚', '林晚', '林晚']);
    const digits = bf.fileHits(outline, 'outline', '1').matches.map((m) => outline.slice(0, m.start).split('\n').length);
    assert.deepEqual(digits, [4]);
    // 不是区间标题（没有「章」）的照搜。
    assert.deepEqual(found('## 第 3 节\n', 'outline', '3'), ['3']);
  });
});

describe('每一处那一行的上下文', () => {
  test('行号、列、前后一截', () => {
    const text = '第一行\n林晚推开门，走了进去。\n';
    const [h] = bf.describeHits(text, bf.fileHits(text, 'chapter', '推开').matches);
    assert.deepEqual(
      { line: h.line, col: h.col, before: h.before, text: h.text, after: h.after },
      { line: 2, col: 2, before: '林晚', text: '推开', after: '门，走了进去。' }
    );
  });

  test('长行截断：前后带「…」', () => {
    const text = `${'甲'.repeat(60)}林晚${'乙'.repeat(80)}`;
    const [h] = bf.describeHits(text, bf.fileHits(text, 'chapter', '林晚').matches);
    assert.ok(h.before.startsWith('…'));
    assert.ok(h.after.endsWith('…'));
    assert.equal(h.before.length, scope.BOOK_FIND_CONTEXT.before + 1);
    assert.equal(h.after.length, scope.BOOK_FIND_CONTEXT.after + 1);
  });

  test('同一行几处、跨好几行：行号逐处往下数', () => {
    const text = '林\n\n林林\n林';
    const lines = bf.describeHits(text, bf.fileHits(text, 'chapter', '林').matches).map((h) => [h.line, h.col]);
    assert.deepEqual(lines, [[1, 0], [3, 0], [3, 1], [4, 0]]);
  });

  test('跨行的匹配画成「↵」；CRLF 的 \\r 不进上下文', () => {
    const text = '上一行末尾\r\n下一行开头\r\n';
    const ms = bf.fileHits(text, 'chapter', '末尾\\r?\\n下', { regex: true }).matches;
    const [h] = bf.describeHits(text, ms);
    assert.equal(h.text, '末尾↵下');
    assert.equal(h.after, '一行开头');
    const [g] = bf.describeHits(text, bf.fileHits(text, 'chapter', '下一行').matches);
    assert.equal(g.after, '开头');
    assert.equal(g.line, 2);
  });
});

describe('预览：每一处换成什么', () => {
  test('字面量原样；正则 $1 在全文里逐处展开', () => {
    const text = '第1章 第2章';
    const lit = bf.fileHits(text, 'chapter', '章').matches;
    assert.deepEqual(bf.replacementsAt(text, lit, '章', '$1节'), ['$1节', '$1节']);
    const re = bf.fileHits(text, 'chapter', '第(\\d)章', { regex: true }).matches;
    assert.deepEqual(bf.replacementsAt(text, re, '第(\\d)章', 'Ch$1', { regex: true }), ['Ch1', 'Ch2']);
  });

  test('与 textFind.replaceSelectedIn 换出来的是同一个样子', () => {
    const text = '林晚说：「晚了。」林晚走了。';
    const ms = bf.fileHits(text, 'chapter', '(林)晚', { regex: true }).matches;
    const shown = bf.replacementsAt(text, ms, '(林)晚', '$1婉', { regex: true });
    const applied = tf.replaceSelectedIn(text, ms, '(林)晚', '$1婉', { regex: true }).text;
    let rebuilt = '';
    let last = 0;
    ms.forEach((m, i) => {
      rebuilt += text.slice(last, m.start) + shown[i];
      last = m.end;
    });
    assert.equal(rebuilt + text.slice(last), applied);
  });
});

describe('范围表', () => {
  test('六个范围，缺省只勾正文', () => {
    assert.deepEqual([...scope.BOOK_FIND_SCOPES], ['chapter', 'plot', 'draft', 'character', 'lore', 'doc']);
    assert.deepEqual([...scope.DEFAULT_BOOK_FIND_SCOPES], ['chapter']);
    for (const s of scope.BOOK_FIND_SCOPES) {
      assert.ok(scope.BOOK_FIND_SCOPE_LABEL[s] && scope.BOOK_FIND_SCOPE_HINT[s], s);
    }
  });

  test('isBookFindScope 只认表里的', () => {
    assert.equal(scope.isBookFindScope('plot'), true);
    assert.equal(scope.isBookFindScope('skill'), false);
    assert.equal(scope.isBookFindScope(3), false);
  });
});
