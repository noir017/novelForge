/**
 * 拆书的纯函数（model/importText.ts）：解码、认标题、切章、抽样、写法技能的名字。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 没有 BOM、又不是合法 UTF-8 的按 GB18030 解 | 中文 txt 小说一大半是 GBK |
 * | 「第三回合」「第二节课」不是标题，「第三回 夜奔」是 | 回 / 节在正文里太常见 |
 * | 以句号收尾、超长的行不是标题 | 正文里「第一章写完那天」这种行 |
 * | 卷标题丢掉、目录里那串空标题跳过、第一个标题前的简介不导入 | 不能凭空多出几十个空章 |
 * | 一个标题都认不出时章为空 | 调用方据此拒绝导入，不把整本当一章 |
 * | 技能名只含字母数字与 `._-`，撞名加后缀 | 与 isSkillName 同一条规则，写盘不越界 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/importText.ts');
const skills = loadModule('src/core/model/writingSkill.ts');

describe('importText · 解码', () => {
  test('UTF-8 照读、BOM 去掉、换行统一', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('第一章 雪夜\r\n正文\r\n')]);
    const r = m.decodeTextBytes(bytes);
    assert.equal(r.encoding, 'utf-8');
    assert.equal(r.text, '第一章 雪夜\n正文\n');
  });

  test('不是合法 UTF-8 的按 GB18030 解', () => {
    // 「你好」的 GBK 编码
    const r = m.decodeTextBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    assert.equal(r.encoding, 'gb18030');
    assert.equal(r.text, '你好');
  });

  test('UTF-16 认 BOM', () => {
    const body = Buffer.from('楔子', 'utf16le');
    const r = m.decodeTextBytes(new Uint8Array([0xff, 0xfe, ...body]));
    assert.equal(r.encoding, 'utf-16le');
    assert.equal(r.text, '楔子');
  });

  test('decodeFileText：UTF-8 原样（换行不动），GBK 解成中文', () => {
    assert.equal(m.decodeFileText(Buffer.from('第一行\r\n第二行', 'utf8')), '第一行\r\n第二行');
    assert.equal(m.decodeFileText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a])), '你好\n');
  });
});

describe('importText · 认标题', () => {
  const chapter = (line) => m.classifyHeading(line);

  test('第X章：中文与阿拉伯数字、带不带分隔符、带 # 都认', () => {
    assert.deepEqual(chapter('第一章 风起青萍'), { kind: 'chapter', title: '风起青萍' });
    assert.deepEqual(chapter('第12章：雪夜'), { kind: 'chapter', title: '雪夜' });
    assert.deepEqual(chapter('　　第一百零三章 夜奔'), { kind: 'chapter', title: '夜奔' });
    assert.deepEqual(chapter('## 第 3 章 旧账'), { kind: 'chapter', title: '旧账' });
    assert.deepEqual(chapter('第一章'), { kind: 'chapter', title: '' });
    assert.deepEqual(chapter('Chapter 7: The Snow'), { kind: 'chapter', title: 'The Snow' });
  });

  test('回 / 节要跟分隔符或行尾', () => {
    assert.deepEqual(chapter('第三回 夜奔'), { kind: 'chapter', title: '夜奔' });
    assert.deepEqual(chapter('第二节'), { kind: 'chapter', title: '' });
    assert.equal(chapter('第三回合他输了'), undefined);
    assert.equal(chapter('第二节课下课'), undefined);
  });

  test('序章、楔子、番外算章，标题照原样', () => {
    assert.deepEqual(chapter('楔子'), { kind: 'chapter', title: '楔子' });
    assert.deepEqual(chapter('番外篇 旧事'), { kind: 'chapter', title: '番外篇 旧事' });
  });

  test('卷标题认出来但不算章', () => {
    assert.equal(chapter('第一卷 少年游').kind, 'volume');
    assert.equal(chapter('第二部').kind, 'volume');
  });

  test('句末标点收尾、超长的行是正文', () => {
    assert.equal(chapter('第一章写完的那天，他去了城外。'), undefined);
    assert.equal(chapter(`第一章${'很'.repeat(60)}`), undefined);
    assert.equal(chapter('他说：「第一章」'), undefined);
  });
});

describe('importText · 切章', () => {
  const book = [
    '青云剑录',
    '作者：某某',
    '简介：少年入宗。',
    '',
    '目录',
    '第一章 入宗',
    '第二章 雪夜',
    '',
    '第一卷 少年游',
    '第一章 入宗',
    '　　林昭站在山门前。',
    '',
    '　　“你来晚了。”沈青说。',
    '第二章 雪夜',
    '雪下了一夜。',
    '第二卷 江湖远',
    '第三章',
    '天亮了。',
  ].join('\n');

  test('按标题切；正文一段一行、去掉行首全角空格', () => {
    const r = m.splitChapters(book);
    assert.deepEqual(
      r.chapters.map((c) => [c.title, c.heading]),
      [
        ['入宗', '第一章 入宗'],
        ['雪夜', '第二章 雪夜'],
        ['', '第三章'],
      ]
    );
    assert.equal(r.chapters[0].body, '林昭站在山门前。\n\n“你来晚了。”沈青说。');
    assert.ok(r.chapters[0].words > 0);
  });

  test('简介不导入、卷标题与目录里的空标题都记下来', () => {
    const r = m.splitChapters(book);
    assert.ok(r.preface.words > 0);
    assert.match(r.preface.head, /青云剑录/);
    assert.deepEqual(r.volumes, ['第一卷 少年游', '第二卷 江湖远']);
    assert.deepEqual(r.empty, ['第一章 入宗', '第二章 雪夜']);
  });

  test('一个标题都认不出：章为空，整本都算简介', () => {
    const r = m.splitChapters('从前有座山。\n山里有座庙。');
    assert.equal(r.chapters.length, 0);
    assert.ok(r.preface.words > 0);
  });

  test('没有标题的书按字数切段', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i}段${'字'.repeat(1000)}。`).join('\n');
    const parts = m.splitBySize(text, 3000);
    assert.ok(parts.length >= 3 && parts.length <= 4, String(parts.length));
    assert.equal(parts[0].title, '第 1 段');
    assert.ok(parts.every((p) => p.words > 0));
  });
});

describe('importText · 抽样、节选与统计', () => {
  test('均匀抽样首尾必在、不重复', () => {
    assert.deepEqual(m.evenSample(100, 5), [0, 25, 50, 74, 99]);
    assert.deepEqual(m.evenSample(3, 5), [0, 1, 2]);
    assert.deepEqual(m.evenSample(0, 5), []);
  });

  test('看结构：开头三章 + 30% 处连续三章', () => {
    assert.deepEqual(m.structureSample(100), [0, 1, 2, 30, 31, 32]);
    assert.deepEqual(m.structureSample(4), [0, 1, 2, 3]);
  });

  test('头尾节选写明中间省略了几个字', () => {
    const text = '甲'.repeat(10) + '乙'.repeat(10) + '丙'.repeat(10);
    assert.equal(m.headTail(text, 10, 10), `${'甲'.repeat(10)}\n\n（中略 10 字）\n\n${'丙'.repeat(10)}`);
    assert.equal(m.headTail('短', 10, 10), '短');
    assert.match(m.headOf(text, 5), /（后略 25 字）$/);
  });

  test('篇幅统计：平均、中位数、对白占比', () => {
    const s = m.shapeStats([
      { body: '“走。”他说。\n\n雪很大。', words: 1000 },
      { body: '天亮了。', words: 3000 },
      { body: '「好。」', words: 2000 },
    ]);
    assert.equal(s.chapters, 3);
    assert.equal(s.avgWords, 2000);
    assert.equal(s.medianWords, 2000);
    assert.equal(s.dialoguePercent, 50);
  });

  test('规模缺省：平均字数取整到百，总章数两倍取整到 50', () => {
    assert.equal(m.roundedAverageWords([2960, 3040, 0]), 3000);
    assert.equal(m.roundedAverageWords([]), undefined);
    assert.equal(m.defaultTotalChapters(30), 100);
    assert.equal(m.defaultTotalChapters(120), 250);
  });
});

describe('importText · 写法技能', () => {
  test('名字合规、撞名加后缀', () => {
    const name = m.referenceSkillName('诡秘之主 (精校版)', new Set());
    assert.equal(name, '诡秘之主-精校版-写法');
    assert.ok(skills.isSkillName(name));
    assert.equal(m.referenceSkillName('诡秘之主 (精校版)', new Set([name])), `${name}-2`);
    assert.equal(m.referenceSkillName('###', new Set()), '参考书-写法');
    assert.ok(skills.isSkillName(m.referenceSkillName('长'.repeat(100), new Set())));
  });

  test('渲染出来的 SKILL.md 读得回来、阶段是规划、是兼容的', () => {
    const raw = m.renderReferenceSkill({ name: '青云剑录-写法', bookTitle: '青云剑录', body: '## 章节结构\n\n每章两到三个场景。' });
    const i = skills.inspectSkillMarkdown(raw, '青云剑录-写法');
    assert.equal(i.name, '青云剑录-写法');
    assert.equal(i.displayName, '《青云剑录》的写法');
    assert.equal(i.stage, 'planning');
    assert.equal(i.compatible, true);
    assert.match(i.body, /每章两到三个场景/);
  });
});
