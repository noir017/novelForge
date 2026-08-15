/**
 * 示例工程 `sample-novel/` 的数据一致性——夹具本身是不是自洽的。
 * 迁自 scripts/smoke.js 的 `== 示例工程数据一致性 ==` 一节。
 *
 * 这是**只读**断言：任何写入类用例都不许碰 sample-novel（写了这里就会红），
 * 需要写盘的先经 helpers/tmpProject.js 的 copyFixture 复制一份。
 *
 * 指纹链的轴是**剧情段**：`plots/NNN-标题.md` 是身份，正文与摘要按同一个
 * 词干镜像到 `manuscripts/` 与 `summaries/`。`chapters/` 是作者的发布区，
 * 不进 manifest、不参与任何指纹——这里连它「没被算进去」一起验。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, loadModule } = require('../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

/** 与 project.ts 一致的指纹算法：去 BOM → trim → 归一 CRLF → sha1 → 前 16 位。 */
function contentHash(raw) {
  return crypto
    .createHash('sha1')
    .update(raw.replace(/^﻿/, '').trim().replace(/\r\n/g, '\n'))
    .digest('hex')
    .slice(0, 16);
}

const read = (rel) => fs.readFileSync(path.join(SAMPLE, rel), 'utf8');

/** 剧情段清单要在收集用例时就读到（每段生成好几条用例），所以放在模块顶层。 */
const manifest = JSON.parse(read('.novelforge/project.json'));

/** 段路径 → 镜像词干（`.novelforge/plots/001-楔子.md` → `001-楔子`）。 */
const stemOf = (file) => path.basename(file, path.extname(file));

describe('示例工程数据一致性', () => {
  let md;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
  });

  test('manifest 段数与磁盘一致', () => {
    const files = fs.readdirSync(path.join(SAMPLE, '.novelforge/plots')).filter((f) => f.endsWith('.md'));
    assert.equal(manifest.plots.length, files.length);
  });

  // 版本号跟着 manifest 结构走：读到旧版本号的代码会重扫一遍磁盘，
  // 而不是拿着 `chapters` 字段当剧情段用。
  test('manifest 是新版结构', () => {
    assert.equal(manifest.version, 2, JSON.stringify(manifest.version));
    assert.ok(Array.isArray(manifest.plots), typeof manifest.plots);
    assert.equal(manifest.chapters, undefined);
  });

  // 发布区不进 manifest：章节是作者从 manuscripts/ 切出来的成品，
  // 工具不分析它的内容，也就没有指纹可言。示例工程里那一份 README.md
  // 没有数字前缀，按章节判定规则本来就不算章节。
  test('发布区不参与指纹链', () => {
    const chapterFile = loadModule('src/core/model/chapterFile.ts');
    const chapters = fs
      .readdirSync(path.join(SAMPLE, 'chapters'))
      .filter((f) => chapterFile.isChapterFileName(f));
    assert.deepEqual(chapters, [], chapters.join('|'));
  });

  describe('每段的指纹链', () => {
    for (const entry of manifest.plots) {
      const stem = stemOf(entry.file);
      const manuscriptRel = `.novelforge/manuscripts/${stem}.md`;
      const summaryRel = `.novelforge/summaries/${stem}.md`;

      test(`第 ${entry.no} 段有剧情文件`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, entry.file)), entry.file);
      });

      test(`第 ${entry.no} 段有正文`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, manuscriptRel)), manuscriptRel);
      });

      // 哈希的是**正文本身**：不含 frontmatter、不含标题行——与
      // `readManuscript` 一字对齐（写一次 beatsHash 不该让摘要立刻过期）。
      test(`第 ${entry.no} 段 contentHash 正确`, () => {
        const body = md.parseMarkdown(read(manuscriptRel).trim()).body;
        assert.equal(contentHash(md.stripH1(body)), entry.contentHash);
      });

      test(`第 ${entry.no} 段摘要标记为最新`, () => {
        assert.equal(entry.summaryHash, entry.contentHash);
      });

      test(`第 ${entry.no} 段摘要文件存在`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, summaryRel)), summaryRel);
      });

      test(`第 ${entry.no} 段摘要 sourceHash 匹配正文`, () => {
        const sumFm = md.parseMarkdown(read(summaryRel)).frontmatter;
        assert.equal(sumFm.sourceHash, entry.contentHash);
      });

      // 正文的 frontmatter 指回它属于哪一段：改名时靠它认亲。
      test(`第 ${entry.no} 段正文指回剧情段`, () => {
        const fm = md.parseMarkdown(read(manuscriptRel)).frontmatter;
        assert.equal(fm.plot, entry.file, JSON.stringify(fm.plot));
      });
    }
  });

  test('示例纲要能命中 3 个角色（林昭/沈氏/年轻守卫）', () => {
    // 角色卡的 aliases 应能在示例纲要中被命中（验证角色筛选可用）
    const outline = '林昭带年轻守卫去见他母亲，沈氏在暗处跟着。';
    const cards = fs.readdirSync(path.join(SAMPLE, '.novelforge/characters'));
    let hitCount = 0;
    for (const f of cards) {
      const fm = md.parseMarkdown(
        fs.readFileSync(path.join(SAMPLE, '.novelforge/characters', f), 'utf8')
      ).frontmatter;
      const names = [fm.name, ...(Array.isArray(fm.aliases) ? fm.aliases : [])];
      if (names.some((n) => n && n.length >= 2 && outline.includes(n))) hitCount++;
    }
    assert.equal(hitCount, 3);
  });
});
