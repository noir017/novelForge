// 保证 src/core/ 永不 import vscode。用法：node scripts/check-core-purity.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src', 'core');
let bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name)) {
      const text = fs.readFileSync(p, 'utf8');
      if (/from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(text)) bad.push(p);
      if (/from\s+['"]\.{1,2}\/.*vscode/.test(text)) bad.push(`${p} (跨层引用 vscode 壳)`);
    }
  }
})(ROOT);
if (bad.length) { console.error('✗ core 层发现 vscode 依赖：\n' + bad.join('\n')); process.exit(1); }
console.log('✓ src/core 无 vscode 依赖');
