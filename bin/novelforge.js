#!/usr/bin/env node
// npm 包形态：优先用 bun 跑源码入口；没有 bun 时提示用编译好的可执行文件。
const { spawnSync } = require('child_process');
const path = require('path');
const entry = path.join(__dirname, '..', 'src', 'standalone', 'main.ts');
const bun = spawnSync('bun', ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (bun.status === null) {
  console.error('需要安装 Bun（https://bun.sh），或直接使用编译好的单文件可执行文件。');
  process.exit(1);
}
process.exit(bun.status ?? 0);
