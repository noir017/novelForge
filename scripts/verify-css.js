/*
 * 比对重构前后的 CSS 是否等价。用法：
 *   node scripts/verify-css.js <旧文件> <新文件>
 *
 * 拆分 CSS 时最怕两件事：漏掉某条规则，以及把两条会互相覆盖的规则调换顺序。
 * 这个脚本各查一遍：
 *   ① 规则集合是否一条不多一条不少；
 *   ② 「同选择器 + 同属性」的相对顺序有没有被改变（那才影响层叠）。
 *
 * esbuild 会顺手规范化引号、把非 ASCII 字符转义，这些不影响渲染，
 * 比对前统一抹平。
 */
const fs = require('node:fs');

/** 抹平 esbuild 的规范化：引号、属性选择器里的引号、`\258c` 这类转义。 */
function norm(s) {
  return s
    .replace(/\\([0-9a-fA-F]{2,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 CSS 拆成 [选择器, 声明块] 的序列。@media 之类的块整体当一条。 */
function parse(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let buf = '';
  let sel = '';
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) {
        sel = buf.trim();
        buf = '';
      } else {
        buf += ch;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules.push([norm(sel), norm(buf)]);
        buf = '';
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
  }
  return rules;
}

const key = ([sel, block]) => `${sel}{${block}}`;
const propsOf = (block) =>
  block.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);

const [oldFile, newFile] = process.argv.slice(2);
const before = parse(fs.readFileSync(oldFile, 'utf8'));
const after = parse(fs.readFileSync(newFile, 'utf8'));

let failed = false;
console.log(`${newFile}：旧 ${before.length} 条 / 新 ${after.length} 条`);

// ---- ① 规则集合
const countBefore = new Map();
const countAfter = new Map();
for (const r of before) countBefore.set(key(r), (countBefore.get(key(r)) || 0) + 1);
for (const r of after) countAfter.set(key(r), (countAfter.get(key(r)) || 0) + 1);

const lost = [...countBefore].filter(([k, n]) => countAfter.get(k) !== n);
const added = [...countAfter].filter(([k, n]) => countBefore.get(k) !== n);
if (lost.length || added.length) {
  failed = true;
  console.log('  ✗ 规则集合不一致');
  for (const [k] of lost.slice(0, 8)) console.log('    只在旧文件：', k.slice(0, 140));
  for (const [k] of added.slice(0, 8)) console.log('    只在新文件：', k.slice(0, 140));
} else {
  console.log('  ✓ 规则集合完全一致');
}

// ---- ② 层叠顺序
const posAfter = new Map();
after.forEach((r, i) => posAfter.set(key(r), i));
let flipped = 0;
for (let i = 0; i < before.length; i++) {
  for (let j = i + 1; j < before.length; j++) {
    if (before[i][0] !== before[j][0]) {
      continue;
    }
    const shared = propsOf(before[i][1]).filter((p) => propsOf(before[j][1]).includes(p));
    if (shared.length === 0) {
      continue;
    }
    if (posAfter.get(key(before[i])) > posAfter.get(key(before[j]))) {
      flipped++;
      console.log(`  ✗ 顺序翻转且属性冲突：${before[i][0]} — ${shared.join(', ')}`);
    }
  }
}
if (flipped === 0) {
  console.log('  ✓ 没有「同选择器 + 同属性」的相对顺序被改变');
} else {
  failed = true;
}

process.exit(failed ? 1 : 0);
