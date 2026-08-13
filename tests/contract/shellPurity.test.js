/**
 * 壳的契约（[src/shells/README.md](../../src/shells/README.md)）里那几条，逐条钉住。
 * 与 corePurity.test.js 并列：都是架构不变式，靠断言而不是靠人记得。
 *
 * 为什么值得写成测试：这三条都是**能悄悄长回来**的。
 * - 共享骨架里一旦有人 `import * as fs`，它就不再是「任何壳都能用」的东西了，
 *   而当下不会有任何报错。
 * - 桌面壳复用独立版靠的是「当子进程起起来」，一旦哪天有人图省事直接 import
 *   独立版的模块，Rust 那边的进程边界就成了假的。
 * - `host.name === 'x'` 这种按身份分支的写法删过一次了（那次它已经把插件设置页
 *   的存储说明说错了很久），没有断言的话下一个人还会再写一遍。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const SHELLS = path.join(ROOT, 'src', 'shells');

/** 递归列出某目录下所有 .ts 文件（相对仓库根的路径）。 */
function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(p));
    } else if (/\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/**
 * 只扫代码，不扫注释。
 *
 * 这几条约束在注释里是要被**引用**的——host.ts 上就写着「禁止 host.name === …」
 * 并举了反例，扫注释会把说明文字本身判成违规，逼着人不敢把理由写清楚。
 */
function code(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** 生成文件不算源码：mediaAssets.ts 是 base64 资源表。 */
const GENERATED = /mediaAssets\.ts$/;

function sourcesOf(...segments) {
  return listTsFiles(path.join(SHELLS, ...segments)).filter((p) => !GENERATED.test(p));
}

describe('shells/shared 零宿主依赖', () => {
  const files = sourcesOf('shared');

  test('至少扫到了文件（防止路径写错导致空跑通过）', () => {
    assert.ok(files.length > 0, SHELLS);
  });

  test('不 import 任何宿主/运行时模块', () => {
    const bad = [];
    for (const p of files) {
      const text = code(p);
      // vscode、node: 内置、bun: 内置——三者都会把这份骨架钉死在某一个宿主上。
      const m = /from\s+['"](vscode|node:[^'"]+|bun:[^'"]+)['"]/.exec(text);
      if (m) {
        bad.push(`${rel(p)} → ${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], '共享骨架里出现了宿主依赖');
  });

  test('不反向依赖任何一个具体的壳', () => {
    const bad = files.filter((p) => /from\s+['"]\.\.\/(vscode|standalone|desktop)\//.test(code(p)));
    assert.deepEqual(bad.map(rel), [], '共享骨架反过来依赖了某个壳');
  });
});

describe('壳与壳之间不互相 import', () => {
  const shells = ['vscode', 'standalone'];

  test('列得出两个 TS 壳的源码', () => {
    for (const shell of shells) {
      assert.ok(sourcesOf(shell).length > 0, shell);
    }
  });

  for (const shell of shells) {
    const others = shells.filter((s) => s !== shell);
    test(`${shell} 不 import ${others.join(' / ')}`, () => {
      const bad = [];
      for (const p of sourcesOf(shell)) {
        const text = code(p);
        for (const other of others) {
          if (new RegExp(`from\\s+['"]\\.\\./${other}/`).test(text)) {
            bad.push(`${rel(p)} → ${other}`);
          }
        }
      }
      assert.deepEqual(bad, [], '壳之间出现了直接依赖');
    });
  }

  test('桌面壳里没有 TS——它复用独立版靠的是把它当 sidecar 起，不是 import', () => {
    assert.deepEqual(sourcesOf('desktop').map(rel), []);
  });
});

describe('没有「我是哪个壳」的分支', () => {
  /** core 与两个 TS 壳的全部源码。 */
  const files = [...listTsFiles(path.join(ROOT, 'src', 'core')), ...sourcesOf()];

  test('全仓库没有 host.name === / name === 这类身份判断', () => {
    const bad = [];
    for (const p of files) {
      const text = code(p);
      // 只认对 Host 那个 name 的比较：`host.name ===`、`getHost().name ===`、
      // `this.host.name !==` 都算。别的 `.name`（角色名、模型名）不受影响。
      const m = /\bhost\(\)?\.name\s*[!=]==/i.exec(text) ?? /\bhost\.name\s*[!=]==/i.exec(text);
      if (m) {
        bad.push(`${rel(p)} → ${m[0]}`);
      }
    }
    assert.deepEqual(bad, [], 'Host.name 只能用于日志与诊断，能力差异请走可选方法或渲染期选项');
  });

  test('ViewState 里没有按壳命名的开关', () => {
    const protocolDir = path.join(ROOT, 'src', 'core', 'protocol');
    const protocol = listTsFiles(protocolDir).map(code).join('\n');
    for (const word of ['standalone?:', 'vscode?:', 'desktop?:']) {
      assert.ok(!protocol.includes(word), `protocol/ 里出现了 ${word}`);
    }
  });
});
