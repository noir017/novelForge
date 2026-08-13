const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

describe('model/fs.ts · 磁盘与字符串工具', () => {
  let utils;
  let tempDir;

  before(() => {
    utils = loadModule('src/core/model/fs.ts');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-fs-'));
  });

  after(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('hash 统一 CRLF 与 LF', () => {
    assert.equal(utils.hash('第一行\r\n第二行'), utils.hash('第一行\n第二行'));
  });

  test('countWords 对中文按字、英文按词计数', () => {
    assert.equal(utils.countWords('林昭 meets Alice 2'), 5);
  });

  test('sanitizeFileName 剥除非法字符', () => {
    assert.equal(utils.sanitizeFileName(' 章:一/夜? '), '章一夜');
  });

  test('slugify 将 ASCII 转成小写', () => {
    assert.equal(utils.slugify('Hero Name'), 'hero-name');
  });

  test('isIgnoredDir 忽略 .trash 与 node_modules', () => {
    assert.equal(utils.isIgnoredDir('.trash'), true);
    assert.equal(utils.isIgnoredDir('node_modules'), true);
    assert.equal(utils.isIgnoredDir('卷一'), false);
  });

  test('uniqueSlug 在文件名冲突时追加 -2', async () => {
    fs.writeFileSync(path.join(tempDir, 'hero.md'), '');
    assert.equal(await utils.uniqueSlug(tempDir, 'hero'), 'hero-2');
  });
});
