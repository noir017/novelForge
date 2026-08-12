/**
 * 模型输出清洗与标题推断（纯函数部分）。
 * 迁自 scripts/smoke.js 的 `== creation.ts · cleanOutput ==` 一节。
 * 创作编排层的落盘行为在 tests/integration/features/creation.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('creation.ts · cleanOutput', () => {
  let cw;
  let cleanOutput;

  before(() => {
    cw = loadModule('src/core/features/creation.ts');
    ({ cleanOutput } = cw);
  });

  test('去掉代码块包裹', () => {
    assert.equal(cleanOutput('```\n正文内容\n```'), '正文内容');
  });

  test('去掉「好的，以下是」开场白', () => {
    assert.equal(cleanOutput('好的，以下是续写内容：\n\n正文内容'), '正文内容');
  });

  test('去掉「以下是」开场白', () => {
    assert.equal(cleanOutput('以下是第四章：\n\n正文内容'), '正文内容');
  });

  test('去掉 markdown 章节标题', () => {
    assert.equal(cleanOutput('## 第四章 灯下\n\n正文内容'), '正文内容');
  });

  test('去掉裸章节标题行', () => {
    assert.equal(cleanOutput('第四章 灯下\n\n正文内容'), '正文内容');
  });

  test('去掉结尾字数统计', () => {
    assert.equal(cleanOutput('正文内容\n\n（本章约 2000 字）'), '正文内容');
  });

  test('正常正文不被误伤', () => {
    assert.equal(
      cleanOutput('雨下了三天，青崖镇的石板路泡得发白。'),
      '雨下了三天，青崖镇的石板路泡得发白。'
    );
  });

  test('正文中的「第三章」不被误删', () => {
    assert.ok(cleanOutput('他想起第三章那件事，于是停下。').includes('第三章'));
  });

  describe('suggestTitle', () => {
    test('suggestTitle 取纲要首句', () => {
      const title = cw.suggestTitle('1. 林昭带年轻守卫去见他母亲，第三块令牌出现。\n2. 沈氏尾随。', 4);
      assert.equal(title, '林昭带年轻守卫去见他母亲');
    });

    test('suggestTitle 空纲要有兜底', () => {
      assert.equal(cw.suggestTitle('', 4), '第4章');
    });
  });
});
