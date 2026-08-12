/**
 * token 估算与按预算截取。迁自 scripts/smoke.js 的 `== tokenizer.ts ==` 一节。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

describe('tokenizer.ts', () => {
  let tk;
  let chapter;

  before(() => {
    tk = loadModule('src/core/context/tokenizer.ts');
    chapter = fs.readFileSync(path.join(SAMPLE, 'chapters/002-客栈里的女人.md'), 'utf8');
  });

  test('空串为 0', () => {
    assert.equal(tk.estimateTokens(''), 0);
  });

  test('中文按 1.5x 估算', () => {
    assert.equal(tk.estimateTokens('雨下了三天'), Math.ceil(5 * 1.5));
  });

  test('英文按 4 字符估算', () => {
    assert.equal(tk.estimateTokens('abcdefgh'), 2);
  });

  test('中文估算高于英文同长度', () => {
    assert.ok(tk.estimateTokens('一二三四') > tk.estimateTokens('abcd'));
  });

  test('示例章节 token 数量级合理（500~2000）', () => {
    const full = tk.estimateTokens(chapter);
    assert.ok(full > 500 && full < 2000, `got ${full}`);
  });

  describe('takeTail', () => {
    test('takeTail 不超预算', () => {
      const tail = tk.takeTail(chapter, 100);
      assert.ok(tk.estimateTokens(tail) <= 100, `got ${tk.estimateTokens(tail)}`);
    });

    test('takeTail 取的是结尾', () => {
      const tail = tk.takeTail(chapter, 100);
      assert.ok(chapter.trimEnd().endsWith(tail.trimEnd().slice(-20)));
    });

    test('takeTail 不足预算时原样返回', () => {
      assert.equal(tk.takeTail('短文本', 1000), '短文本');
    });
  });

  describe('takeHead', () => {
    test('takeHead 带截断标记', () => {
      // 不静默截断：降级/丢弃必须留下痕迹。
      assert.ok(tk.takeHead(chapter, 100).includes('因上下文预算截断'));
    });

    test('takeHead 取的是开头', () => {
      assert.ok(tk.takeHead(chapter, 100).startsWith('# 客栈里的女人'));
    });

    test('takeHead 不足预算时原样返回', () => {
      assert.equal(tk.takeHead('短文本', 1000), '短文本');
    });
  });
});
