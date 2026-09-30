/**
 * 示例工程 `sample-novel/` 的数据一致性——夹具本身是不是自洽的。
 * 迁自 scripts/smoke.js 的 `== 示例工程数据一致性 ==` 一节。
 *
 * 这是**只读**断言：任何写入类用例都不许碰 sample-novel（写了这里就会红），
 * 需要写盘的先经 helpers/tmpProject.js 的 copyFixture 复制一份。
 *
 * 一条轴：细纲号 = 章号。`chapters/NNN-标题.md` 是正文，摘要按同一个词干镜像到
 * `summaries/`，细纲（`plots/`）与它同号。指纹链的三环都在这里验：大纲那一节 →
 * 细纲（`upstreamHash`）、细纲 → 正文（`writtenFrom`）、正文 → 摘要（`sourceHash`）。
 * 架构三件（config / premise / world）都要是填过的——示例工程是一份走完整条
 * 链路、写到第 3 章的书。
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

/** 章节清单要在收集用例时就读到（每章生成好几条用例），所以放在模块顶层。 */
const manifest = JSON.parse(read('.novelforge/project.json'));

/** 章节路径 → 镜像词干（`chapters/001-楔子.md` → `001-楔子`）。 */
const stemOf = (file) => path.basename(file, path.extname(file));

describe('示例工程数据一致性', () => {
  let md;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
  });

  test('manifest 章数与磁盘一致', () => {
    const chapterFile = loadModule('src/core/model/chapterFile.ts');
    const files = fs
      .readdirSync(path.join(SAMPLE, 'chapters'))
      .filter((f) => chapterFile.isChapterFileName(f));
    assert.equal(manifest.chapters.length, files.length);
  });

  test('manifest 索引的是章节', () => {
    assert.equal(manifest.version, 1, JSON.stringify(manifest.version));
    assert.ok(Array.isArray(manifest.chapters), typeof manifest.chapters);
    assert.equal(manifest.plots, undefined);
  });

  /** 卷与中转站两层都删了：示例工程里不该再出现它们。 */
  test('没有 volumes/ 与 manuscripts/', () => {
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelforge/volumes')));
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelforge/manuscripts')));
  });

  /** 每一章都有同号的细纲：示例工程是走完整条流水线写出来的。 */
  test('每一章都有同号的细纲（细纲号 = 章号）', () => {
    const plotFile = loadModule('src/core/model/plotFile.ts');
    const plots = fs.readdirSync(path.join(SAMPLE, '.novelforge/plots')).filter((f) => f.endsWith('.md'));
    const nos = plots.map((f) => plotFile.parsePlotFileName(f).no).sort((a, b) => a - b);
    assert.deepEqual(nos, manifest.chapters.map((c) => c.order).sort((a, b) => a - b));
  });

  test('架构三件都填过，配置能解析出规模参数', () => {
    const setting = loadModule('src/core/model/settingFile.ts');
    for (const doc of setting.SETTING_FILE_DOCS) {
      const parsed = setting.parseSettingDoc(doc, read(`.novelforge/${doc}.md`), doc);
      assert.ok(setting.isSettingFilled(doc, parsed.sections), doc);
    }
    const config = setting.parseBookConfig(read('.novelforge/config.md'), 'config');
    assert.equal(config.totalChapters, 30);
    assert.equal(config.wordsPerChapter, 400);
    assert.equal(config.structure, 'three_act');
  });

  test('情节大纲按章号区间分节，覆盖到总章数', () => {
    const outline = loadModule('src/core/model/outlineFile.ts');
    assert.equal(outline.outlineCoverage(read('.novelforge/outline.md')), 30);
  });

  describe('每章的指纹链', () => {
    for (const entry of manifest.chapters) {
      const stem = stemOf(entry.file);
      const summaryRel = `.novelforge/summaries/${stem}.md`;
      const plotRel = `.novelforge/plots/${stem}.md`;

      test(`第 ${entry.order} 章有正文`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, entry.file)), entry.file);
      });

      test(`第 ${entry.order} 章有细纲`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, plotRel)), plotRel);
      });

      // 细纲的两个指纹都对得上：它依据的那一节大纲没改过，正文依据的细纲也没改过。
      test(`第 ${entry.order} 章细纲的 upstreamHash / writtenFrom 都是新鲜的`, () => {
        const plotFile = loadModule('src/core/model/plotFile.ts');
        const outlineFile = loadModule('src/core/model/outlineFile.ts');
        const fsm = loadModule('src/core/model/fs.ts');
        const plot = plotFile.parsePlotFile(read(plotRel), plotRel);
        const outline = md.stripH1(md.parseMarkdown(read('.novelforge/outline.md')).body);
        assert.equal(plot.upstreamHash, outlineFile.outlineUpstreamHash(outline, plot.no));
        const content = fsm.hash(plotFile.PLOT_SECTION_KEYS.map((k) => plot.sections[k]).join('\n---\n'));
        assert.equal(plot.writtenFrom, content);
      });

      // 哈希的是**整份正文**（含标题行）：与 `listChapters` 一字对齐。
      test(`第 ${entry.order} 章 contentHash 正确`, () => {
        assert.equal(contentHash(read(entry.file)), entry.contentHash);
      });

      test(`第 ${entry.order} 章摘要标记为最新`, () => {
        assert.equal(entry.summaryHash, entry.contentHash);
      });

      test(`第 ${entry.order} 章摘要文件存在`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, summaryRel)), summaryRel);
      });

      test(`第 ${entry.order} 章摘要 sourceHash 匹配正文`, () => {
        const sumFm = md.parseMarkdown(read(summaryRel)).frontmatter;
        assert.equal(sumFm.sourceHash, entry.contentHash);
      });

      // 摘要的 frontmatter 指回它属于哪一章。
      // frontmatter 解析出来一律是字符串，`readSummary` 用 asNumber 收口，
      // 这里比字符串即可——要验的是「指回去了」，不是解析器的类型。
      test(`第 ${entry.order} 章摘要指回章号`, () => {
        const fm = md.parseMarkdown(read(summaryRel)).frontmatter;
        assert.equal(String(fm.chapter), String(entry.order), JSON.stringify(fm.chapter));
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
