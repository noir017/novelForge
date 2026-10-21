/**
 * 把内置写作技能（`src/core/skills/builtin/<名字>/`，常规的技能目录：`SKILL.md` 加它引用的
 * `references/…` 等文件）内嵌成一个生成文件 `src/core/skills/builtin/embedded.ts`。
 *
 * 为什么要内嵌：三个壳的产物都是单文件（VS Code 是 esbuild 的 bundle，独立版 / 桌面 sidecar /
 * Docker 是 `bun build --compile`），运行时旁边没有仓库，读不到这些目录。与 embed-media.js
 * 同一个道理。生成文件不入库：内置技能的唯一真相是那些目录。
 *
 * 谁调它（每一条要用到 core 的路都先过一处）：
 * - `scripts/embed-media.js`：typecheck、e2e、独立版、单文件、sidecar、Dockerfile、release；
 * - `esbuild.js`：VS Code 插件的 compile / watch / package；
 * - `tests/helpers/load.js`：node 测试（单跑一条也算）。
 *
 * node 测试是多进程并发跑的，几个进程会同时调到这里：内容没变就不写，要写也先写临时文件再
 * rename，读的一方永远读到一份完整的。
 *
 * 换行一律收成 `\n`：仓库没有 .gitattributes，Windows 上检出的是 CRLF。
 *
 * 用法：node scripts/embed-skills.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'src', 'core', 'skills', 'builtin');
const OUT = path.join(SKILLS_DIR, 'embedded.ts');

/** 与 `model/writingSkill.ts` 的技能名同一条规则：目录名就是 `builtin:<名字>` 里的名字。 */
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
/** 一份内置技能的目录（全部文件合计）最多多大。注入的上限另算（64 KiB，见 writingSkill.ts）。 */
const MAX_DIR_BYTES = 256 * 1024;

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(abs, relPath, out);
    } else if (entry.isFile()) {
      out.push([relPath, abs]);
    } else {
      throw new Error(`内置技能里不收链接与特殊文件：${path.relative(ROOT, abs)}`);
    }
  }
  return out;
}

function readText(abs) {
  const buf = fs.readFileSync(abs);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    throw new Error(`内置技能里只收 UTF-8 文本：${path.relative(ROOT, abs)}`);
  }
}

function render() {
  const skills = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const lines = [
    '// 由 scripts/embed-skills.js 从 src/core/skills/builtin/<名字>/ 生成，勿手改。',
    '',
    '/** 内置技能：目录名 → 技能目录里的全部文件（相对路径 → 文本）。 */',
    'export const BUILTIN_SKILL_DIRS: Readonly<Record<string, Readonly<Record<string, string>>>> = {',
  ];
  for (const name of skills) {
    if (!SKILL_NAME.test(name)) {
      throw new Error(`内置技能的目录名不合法：${name}`);
    }
    const dir = path.join(SKILLS_DIR, name);
    const files = walk(dir, '', []).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!files.some(([rel]) => rel === 'SKILL.md')) {
      throw new Error(`内置技能 ${name} 里没有 SKILL.md`);
    }
    let bytes = 0;
    lines.push(`  ${JSON.stringify(name)}: {`);
    for (const [rel, abs] of files) {
      const text = readText(abs);
      bytes += Buffer.byteLength(text, 'utf8');
      lines.push(`    ${JSON.stringify(rel)}: ${JSON.stringify(text)},`);
    }
    if (bytes > MAX_DIR_BYTES) {
      throw new Error(`内置技能 ${name} 合计 ${bytes} 字节，超过 ${MAX_DIR_BYTES}`);
    }
    lines.push('  },');
  }
  lines.push('};', '');
  return { text: lines.join('\n'), count: skills.length };
}

/** 生成（内容没变就不写）。返回生成文件的路径。 */
function embedSkills({ quiet = false } = {}) {
  const { text, count } = render();
  let current;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== text) {
    const tmp = `${OUT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, OUT);
    if (!quiet) {
      console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${count} 份内置技能）`);
    }
  }
  return OUT;
}

module.exports = { embedSkills, SKILLS_DIR };

if (require.main === module) {
  try {
    embedSkills();
  } catch (e) {
    console.error(e.message ?? e);
    process.exit(1);
  }
}
