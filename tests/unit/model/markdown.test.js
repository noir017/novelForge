/**
 * Markdown 解析：frontmatter、小节抽取、H1 处理、序列化往返。
 * 迁自 scripts/smoke.js 的 `== markdown.ts ==` 一节。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

describe('markdown.ts', () => {
  let md;
  let parsed;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
    const raw = fs.readFileSync(path.join(SAMPLE, '.novelforge/characters/林昭.md'), 'utf8');
    parsed = md.parseMarkdown(raw);
  });

  test('解析 frontmatter name', () => {
    assert.equal(parsed.frontmatter.name, '林昭');
  });

  test('解析行内数组 aliases', () => {
    assert.ok(Array.isArray(parsed.frontmatter.aliases), JSON.stringify(parsed.frontmatter.aliases));
    assert.equal(parsed.frontmatter.aliases[0], '阿昭');
  });

  test('解析数字字段 firstAppear', () => {
    assert.equal(parsed.frontmatter.firstAppear, '1');
  });

  test('body 不含 frontmatter', () => {
    assert.ok(!parsed.body.startsWith('---'));
  });

  describe('pickSections', () => {
    let sections;
    before(() => {
      sections = md.pickSections(parsed.body, ['身份', '语言习惯', '当前状态', '不存在的小节']);
    });

    test('抽取「身份」小节', () => {
      assert.ok(sections.身份.includes('七年前那场火的幸存者'), sections.身份);
    });

    test('抽取「语言习惯」小节', () => {
      assert.ok(sections.语言习惯.includes('答话极短'), sections.语言习惯);
    });

    test('抽取「当前状态」小节', () => {
      assert.ok(sections.当前状态.includes('停舟'), sections.当前状态);
    });

    test('缺失小节返回空串', () => {
      assert.equal(sections.不存在的小节, '');
    });
  });

  describe('块状数组写法', () => {
    let block;
    before(() => {
      block = md.parseMarkdown('---\ntags:\n  - 主角\n  - 视角人物\nname: 甲\n---\n\n正文');
    });

    test('解析块状数组', () => {
      assert.ok(Array.isArray(block.frontmatter.tags), JSON.stringify(block.frontmatter.tags));
      assert.equal(block.frontmatter.tags.length, 2, JSON.stringify(block.frontmatter.tags));
    });

    test('块状数组后的键仍能解析', () => {
      assert.equal(block.frontmatter.name, '甲');
    });
  });

  describe('H1 处理', () => {
    test('extractH1', () => {
      assert.equal(md.extractH1('# 楔子\n\n正文'), '楔子');
    });

    test('stripH1 去掉标题', () => {
      assert.ok(md.stripH1('# 楔子\n\n雨下了三天').startsWith('雨下了三天'));
    });

    test('stripH1 不误伤无标题正文', () => {
      assert.equal(md.stripH1('雨下了三天'), '雨下了三天');
    });
  });

  describe('容错：作者会手改任何 Markdown', () => {
    test('无 frontmatter 不抛错', () => {
      assert.equal(md.parseMarkdown('# 标题\n正文').frontmatter.name, undefined);
    });

    test('畸形行被跳过而非抛错', () => {
      const messy = md.parseMarkdown('---\n这行不是键值对\nname: 乙\n---\n正文');
      assert.equal(messy.frontmatter.name, '乙');
    });
  });

  describe('序列化往返', () => {
    test('frontmatter 序列化往返', () => {
      const fm = md.stringifyFrontmatter({ name: '丙', aliases: ['x', 'y'], firstAppear: 3, skip: undefined });
      const round = md.parseMarkdown(`${fm}\n\n正文`);
      assert.equal(round.frontmatter.name, '丙');
      assert.equal(round.frontmatter.aliases.length, 2);
    });

    test('undefined 字段被跳过', () => {
      const fm = md.stringifyFrontmatter({ name: '丙', aliases: ['x', 'y'], firstAppear: 3, skip: undefined });
      assert.ok(!fm.includes('skip'));
    });
  });
});
