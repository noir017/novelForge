/**
 * 架构不变式：**工具层与 MCP 端口互不缠绕，MCP 端口不伸手进别的层。**
 *
 * 工具（`src/core/tools/`）是 Novel Forge 对外的那一份能力：全部工具的契约、注册表、实现。
 * MCP（`src/core/mcp/`）只是把这份契约端出去的一个传输——它认识工具的形状（`ToolSpec`），
 * 真正执行交给壳注入的 `McpBackend`（由 `controller/mcp.ts` 拼出来）。从前工具体里
 * `ctx.budget.calls += 1`、闸门反过来 import `tools/write`，谁都搬不动；这里守的就是
 * 别再长回去。
 *
 * 三条：
 *
 * 1. `src/core/tools/` **一行都不 import `mcp/` 或 `controller/`**。反过来会成环，也会让
 *    「另起一个调用方」变成一件要先读懂 MCP 或 controller 的事。
 * 2. `src/core/mcp/` 只认 `../tools/`（契约、注册表、那一套工具）与 `../runtime/`（日志）。
 *    controller、workspace、generation 这些由 backend 注入，不直接 import——否则端口就
 *    钉死在某一个宿主上了。
 * 3. 工具体不认识预算：**`budget` 这个词在 `tools/novel/` 里不该出现**
 *    （工具只 `usage.record(n)` 报数，上限是调用方的事）。
 *
 * 谁绑工具、谁接调用，见 `src/core/tools/README.md` 的那张分层图。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const TOOLS = path.join(ROOT, 'src', 'core', 'tools');
const MCP = path.join(ROOT, 'src', 'core', 'mcp');

function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
/** 每一条 import 语句（含它是不是 `import type`）。 */
function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    out.push({ typeOnly: !!m[1], from: m[2] });
  }
  for (const m of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    out.push({ typeOnly: false, from: m[1] });
  }
  return out;
}

describe('tools 不认识调用方', () => {
  const files = listTsFiles(TOOLS);

  test('至少扫到了文件（防止路径写错导致空跑通过）', () => {
    assert.ok(files.length > 0, TOOLS);
  });

  test('没有任何一处 import mcp/ 或 controller/', () => {
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (/(^|\/)(mcp|controller)(\/|$)/.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'tools 层反向依赖了调用方');
  });

  // 工具只会说「我调了 2 次模型」，连上限是多少都不知道。
  test('工具体不认识预算', () => {
    const bad = listTsFiles(path.join(TOOLS, 'novel')).filter((f) =>
      /ctx\.budget|ToolBudget|limits\.calls/.test(fs.readFileSync(f, 'utf8'))
    );
    assert.deepEqual(bad.map(rel), [], '工具体伸手拿了调用方的预算');
  });
});

describe('mcp 只认工具契约与运行时', () => {
  const files = listTsFiles(MCP);

  test('至少扫到了文件', () => {
    assert.ok(files.length > 0, MCP);
  });

  // 同目录（./）、node 内建（node:）、../tools/、../runtime/ 之外一律不许。
  test('import 只来自 ./、node:、../tools/、../runtime/', () => {
    const ok = /^(\.\/|node:|\.\.\/tools(\/|$)|\.\.\/runtime(\/|$))/;
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (!ok.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'mcp 层直接伸手进了别的层');
  });

  // 具体执行由壳注入的 backend 做；端口本身不认识哪一个宿主。
  test('不碰 controller / workspace / generation', () => {
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (/(^|\/)(controller|workspace|generation)(\/|$)/.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'mcp 层钉死在某个宿主上了');
  });
});
