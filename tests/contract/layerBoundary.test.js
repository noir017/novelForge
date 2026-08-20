/**
 * 架构不变式：**工具层与 agent 层互不缠绕。**
 *
 * 这条守的是「工具将来能端出去（MCP）、agent 是可换的轻量实现」这两件事。
 * 从前两层互相伸手——工具体里 `ctx.budget.calls += 1`，闸门反过来按工具名
 * switch 还 import 了 `tools/write`——于是**谁都搬不动**：想把工具端出去，
 * 得先把 agent 的预算对象一起端出去。
 *
 * 三条：
 *
 * 1. `src/core/tools/` **一行都不 import `agent/`**。反过来会成环，也会让
 *    「另起一个调用方」变成一件要先读懂 agent 的事。
 * 2. `src/core/agent/` 只 `import type` 那一份契约（`tools/types.ts`）。
 *    拿到运行时的东西（具体工具、注册表）就等于又把工具集钉死在循环里了。
 * 3. 工具体不认识预算：**`budget` 这个词在 `tools/novel/` 里不该出现**
 *    （工具只 `usage.record(n)` 报数，上限是调用方的事）。
 *
 * 谁绑工具、谁跑循环，见 `src/core/tools/README.md` 的那张分层图。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const TOOLS = path.join(ROOT, 'src', 'core', 'tools');
const AGENT = path.join(ROOT, 'src', 'core', 'agent');

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

describe('tools 不认识 agent', () => {
  const files = listTsFiles(TOOLS);

  test('至少扫到了文件（防止路径写错导致空跑通过）', () => {
    assert.ok(files.length > 0, TOOLS);
  });

  test('没有任何一处 import agent/', () => {
    const bad = files.filter((f) => imports(f).some((i) => /(^|\/)agent\//.test(i.from)));
    assert.deepEqual(bad.map(rel), [], 'tools 层反向依赖了 agent');
  });

  // 工具只会说「我调了 2 次模型」，连上限是多少都不知道。
  test('工具体不认识预算', () => {
    const bad = listTsFiles(path.join(TOOLS, 'novel')).filter((f) =>
      /ctx\.budget|ToolBudget|limits\.calls/.test(fs.readFileSync(f, 'utf8'))
    );
    assert.deepEqual(bad.map(rel), [], '工具体伸手拿了调用方的预算');
  });
});

describe('agent 只认那一份契约', () => {
  const files = listTsFiles(AGENT);

  test('至少扫到了文件', () => {
    assert.ok(files.length > 0, AGENT);
  });

  test('引用 tools/ 的地方一律是 import type', () => {
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (/(^|\/)tools\//.test(i.from) && !i.typeOnly) {
          bad.push(`${rel(f)} → ${i.from}`);
        }
      }
    }
    assert.deepEqual(bad, [], 'agent 层拿了工具层的运行时代码');
  });

  // 具体是哪七个工具是调用方（controller）的选择，不是循环的。
  test('不 import 任何一个具体工具', () => {
    const bad = files.filter((f) => imports(f).some((i) => /tools\/novel/.test(i.from)));
    assert.deepEqual(bad.map(rel), [], 'agent 层把某一套工具钉死了');
  });
});
