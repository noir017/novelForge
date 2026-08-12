/**
 * 示例工程 `sample-novel/` 的数据一致性——夹具本身是不是自洽的。
 * 迁自 scripts/smoke.js 的 `== 示例工程数据一致性 ==` 一节。
 *
 * 这是**只读**断言：任何写入类用例都不许碰 sample-novel（写了这里就会红），
 * 需要写盘的先经 helpers/tmpProject.js 的 copyFixture 复制一份。
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

/** 章节清单要在收集用例时就读到（每章生成四条用例），所以放在模块顶层。 */
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE, '.novelforge/project.json'), 'utf8'));

describe('示例工程数据一致性', () => {
  let md;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
  });

  test('manifest 章节数与磁盘一致', () => {
    // 用真实的章节判定规则过滤，而不是写死 .md——章节可以是任意非二进制扩展名，
    // 这条断言要跟着规则走，不然示例工程里加一份 .txt 章节它就误报。
    const chapterFile = loadModule('src/core/model/chapterFile.ts');
    const files = fs
      .readdirSync(path.join(SAMPLE, 'chapters'))
      .filter((f) => chapterFile.isChapterFileName(f));
    assert.equal(manifest.chapters.length, files.length);
  });

  describe('每章的指纹链', () => {
    for (const entry of manifest.chapters) {
      test(`第 ${entry.order} 章 contentHash 正确`, () => {
        const h = contentHash(fs.readFileSync(path.join(SAMPLE, entry.file), 'utf8'));
        assert.equal(h, entry.contentHash);
      });

      test(`第 ${entry.order} 章摘要标记为最新`, () => {
        const h = contentHash(fs.readFileSync(path.join(SAMPLE, entry.file), 'utf8'));
        assert.equal(entry.summaryHash, h);
      });

      test(`第 ${entry.order} 章摘要文件存在`, () => {
        const sumPath = path.join(
          SAMPLE, '.novelforge/summaries', `${String(entry.order).padStart(3, '0')}.md`
        );
        assert.ok(fs.existsSync(sumPath), sumPath);
      });

      test(`第 ${entry.order} 章摘要 sourceHash 匹配正文`, () => {
        const h = contentHash(fs.readFileSync(path.join(SAMPLE, entry.file), 'utf8'));
        const sumPath = path.join(
          SAMPLE, '.novelforge/summaries', `${String(entry.order).padStart(3, '0')}.md`
        );
        const sumFm = md.parseMarkdown(fs.readFileSync(sumPath, 'utf8')).frontmatter;
        assert.equal(sumFm.sourceHash, h);
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
