/**
 * 新建一本书时文件夹叫什么（`src/core/model/bookDir.ts`）。表单上预览的路径与后端真建的是同一个名字，
 * 建书本身在 tests/integration/workspace/newProject.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 照抄书名 | 中文、空格原样留着（书名里的空格是作者的） |
 * | 删字 | 各平台文件名里不许有的字删掉；开头的点、结尾的点与空格去掉 |
 * | 空串 | 删完什么都不剩时是空串，调用方据此报错 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { bookDirName } = loadModule('src/core/model/bookDir.ts');

describe('bookDirName', () => {
  test('照抄书名：中文、中间的空格原样留着，两头空白去掉', () => {
    assert.equal(bookDirName('青云剑录'), '青云剑录');
    assert.equal(bookDirName('  The Long Night  '), 'The Long Night');
  });

  test('文件名里不许有的字删掉', () => {
    assert.equal(bookDirName('青云/剑录:卷一?'), '青云剑录卷一');
    assert.equal(bookDirName('a\\b*c"d<e>f|g'), 'abcdefg');
  });

  test('开头的点（隐藏文件夹）、结尾的点与空格（Windows 不认）去掉', () => {
    assert.equal(bookDirName('..雪夜'), '雪夜');
    assert.equal(bookDirName('雪夜...'), '雪夜');
    assert.equal(bookDirName('雪夜. .'), '雪夜');
  });

  test('删完什么都不剩：空串', () => {
    assert.equal(bookDirName('???'), '');
    assert.equal(bookDirName('..'), '');
    assert.equal(bookDirName('   '), '');
  });
});
