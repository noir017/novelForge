/**
 * 架构不变式：`src/core/` 永不 import vscode——双形态架构的硬约束。
 * 迁自 scripts/check-core-purity.js。
 *
 * 这条也是测试基建的地基：正因为 core 纯净，helpers/load.js 里的
 * `external: ['vscode']` 才是安全的。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const CORE = path.join(ROOT, 'src', 'core');

/** 递归列出 src/core/ 下所有 .ts 文件。 */
function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('src/core 零 vscode 依赖', () => {
  const files = listTsFiles(CORE);

  test('至少扫到了文件（防止路径写错导致空跑通过）', () => {
    assert.ok(files.length > 0, CORE);
  });

  test('没有直接 import / require vscode', () => {
    const bad = files.filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return /from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(text);
    });
    assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), [], 'core 层发现 vscode 依赖');
  });

  test('没有跨层引用 vscode 壳', () => {
    const bad = files.filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return /from\s+['"]\.{1,2}\/.*vscode/.test(text);
    });
    assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), [], 'core 层跨层引用了 vscode 壳');
  });
});
