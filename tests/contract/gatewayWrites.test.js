/**
 * AGENTS 第 7 条的普查固化下来：**工程里的写盘只经 `core/workspace/` 这一个网关**。
 *
 * 扫 `src/core/` 下除 `workspace/` 之外的每一份 `.ts`，找直接动磁盘的调用（`fs.writeFile` / `mkdir` / `rename` /
 * `copyFile` / `cp` / `rm` / `unlink`……，以及 `model/fs.ts` 的 `writeText`）。剩下的每一处都是**按设计不走网关**的，
 * 在下面这张表里逐个文件写明数量与理由；多出一处就红——要么改走网关，要么把理由补进这张表（并同步
 * `src/core/workspace/README.md`「哪些写入存」那一段）。
 *
 * 2026-10 那次普查之后收掉的：文件页粘贴的复制（`fs.cp` → `Workspace.copy`）、新建文件夹（`fs.mkdir` →
 * `Workspace.mkdir`）、设定名录按目录整理先建目录（删掉，`ws.move` 自己补父目录）、新工程的空模板（`writeIfAbsent`
 * → `Workspace.initializeProject`），以及角色卡的清理别名 / 合并重复卡（`features/characterMaintenance.ts`：
 * `writeText` → `write`、`fs.rename` 进回收站 → `remove`）。最后这一处上一次普查没扫到：那份源文件里有 NUL 字符
 * （拼键用的分隔符），`grep -r` 把它当二进制跳过了——所以这里用 Node 读全文，不靠 grep。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const CORE = path.join(ROOT, 'src', 'core');

/** 按设计不走网关的写盘：文件 → [处数, 理由]。 */
const ALLOWED = {
  'src/core/model/fs.ts': [2, '`writeText` 的实现本身（补父目录 + 写）'],
  'src/core/model/project.ts': [3, '元数据与脚手架：`.novel/` → `.novelforge/` 迁移、新工程建固定目录、写 manifest（`project.json`）'],
  'src/core/model/session.ts': [3, '会话文件（内部文件，网关拒写 `sessions/`）：落盘、删会话搬进回收站（共用 `trashPathFor` 落点）'],
  'src/core/stores.ts': [5, '工程外：`~/.novelforge/` 的设置与 API Key'],
  'src/core/skills/library.ts': [5, '工程外：我的技能库 `~/.novelforge/skills/`（装、卸载进它自己的回收站）'],
};

/**
 * 直接动磁盘的调用。`writeText` 的定义（`function writeText(`）不算；`ws.mkdir(` / `ws.copy(` 这种网关方法前面
 * 不是 `fs` / `fsp`，也不算。SQLite（`runtime/db.ts`，第 17 条：只放可丢弃的痕迹）经驱动写库文件，不在这张表里。
 */
const CALL =
  /(?<![\w$])(?:fs\.promises|fs|fsp|fsSync)\.(?:writeFile|appendFile|mkdir|rename|copyFile|cp|rm|rmdir|unlink|truncate|symlink|link|createWriteStream)(?:Sync)?\s*\(|(?<![\w$.])(?<!function\s)(?:writeText|writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync|cpSync|rmSync|rmdirSync|unlinkSync)\s*\(/g;

function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 去掉注释：块注释整段、行尾 `//`。字符串里的 `//`（网址）不影响计数——那几行本来就没有写盘调用。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('第 7 条：网关之外没有新的直接写盘', () => {
  const files = listTsFiles(CORE).filter((p) => !p.startsWith(path.join(CORE, 'workspace') + path.sep));
  const found = {};
  for (const p of files) {
    const hits = stripComments(fs.readFileSync(p, 'utf8')).match(CALL);
    if (hits) {
      found[path.relative(ROOT, p).replace(/\\/g, '/')] = hits.length;
    }
  }

  test('扫到了文件（防止路径写错空跑通过）', () => {
    assert.ok(files.length > 50, String(files.length));
  });

  test('只有表里那几处，数量对得上', () => {
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, [n]]) => [f, n]));
    assert.deepEqual(found, expected);
  });
});
