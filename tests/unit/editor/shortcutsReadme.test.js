/**
 * README「内置编辑器 → 快捷键一览」那张表与代码里的快捷键表（`media/src/editor/shortcuts.ts`）逐条对得上：
 * 改了 shortcuts.ts（加键、改说法、改生效范围）就得照着改 README，反过来也一样。表本身的口径在 shortcuts.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModule } = require('../../helpers/load');

const { SHORTCUTS, formatKey, groupShortcuts, scopeText } = loadModule('media/src/editor/shortcuts.ts');

/**
 * README「内置编辑器」一节里的快捷键表（`#### 快捷键一览` 底下第一张表）：一行一条，五格——分组（只在每组第一行写）、按键、
 * 做什么、在哪儿管用、说明。按键照 README 的写法（`Ctrl` + `Shift` + `F`，几种按法「 / 」隔开），做什么与代码表的 `label`
 * 一字不差，在哪儿管用就是 `scopeText`，说明是 `note`。行的顺序也与代码表一样（分组按 `SHORTCUT_GROUPS`）。
 */
function readmeRows() {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('\n#### 快捷键一览\n');
  assert.ok(at >= 0, 'README 里找不到「#### 快捷键一览」');
  const lines = text.slice(at).split('\n');
  const start = lines.findIndex((l) => l.startsWith('| 分组 |'));
  assert.ok(start >= 0, '「快捷键一览」底下找不到表头「| 分组 | …」');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    rows.push(line);
  }
  return rows;
}

const readmeKey = (spec) =>
  formatKey(spec, false)
    .split('+')
    .map((part) => `\`${part}\``)
    .join(' + ');

const readmeRow = (s, first) =>
  `| ${first ? s.group : ''} | ${s.keys.map(readmeKey).join(' / ')} | ${s.label} | ${scopeText(s)} | ${s.note ?? ''} |`;

describe('README 的快捷键表与代码表一致', () => {
  test('一条一行、顺序一样、五格逐字对得上（改了 shortcuts.ts 就照着改 README）', () => {
    const want = groupShortcuts(SHORTCUTS).flatMap((g) => g.items.map((s, i) => readmeRow(s, i === 0)));
    assert.deepEqual(readmeRows(), want);
  });
});
