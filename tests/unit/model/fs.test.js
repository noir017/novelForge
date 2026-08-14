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

  // readTextIfExists 取代了「exists() 再 readText()」两步走：省一次 stat，
  // 也堵掉「查到了、读之前文件被删掉」的竞态（作者随时在手改文件）。
  test('readTextIfExists 读得到已有文件', async () => {
    const p = path.join(tempDir, '有的.md');
    fs.writeFileSync(p, '内容', 'utf8');
    assert.equal(await utils.readTextIfExists(p), '内容');
  });

  test('readTextIfExists 对不存在的文件给 undefined 而不抛', async () => {
    assert.equal(await utils.readTextIfExists(path.join(tempDir, '没有的.md')), undefined);
  });

  test('readTextIfExists 把目录当读不到，不把异常漏给调用方', async () => {
    // 「不存在」与「这不是个文件」对调用方是同一件事：这一章没有细纲。
    const dir = path.join(tempDir, '一个目录');
    fs.mkdirSync(dir, { recursive: true });
    await assert.doesNotReject(() => utils.readTextIfExists(dir));
  });
});
