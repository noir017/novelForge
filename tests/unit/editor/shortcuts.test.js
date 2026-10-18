/**
 * 快捷键表（`media/src/editor/shortcuts.ts`，纯数据 + 纯函数）：没有撞车的键、每一条都有分组与说明、平台显示
 * （Windows / Linux 写 `Ctrl+Shift+F`，Mac 写 `⇧⌘F`）、按法怎么认（`matchesKey`）、筛选与分组。README 那张快捷键表
 * 与这张表逐条对得上在 shortcutsReadme.test.js。
 *
 * 「表里每一条都真的有人处理、被接走的每一下都在表里」要真的按键，在 tests/dom/standalone/shortcuts.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  filterShortcuts,
  formatKey,
  formatKeys,
  groupShortcuts,
  isMacPlatform,
  keyName,
  matchesKey,
  parseKey,
  primaryKey,
  scopeText,
  shortcutById,
  shortcutLabel,
} = loadModule('media/src/editor/shortcuts.ts');

/** 按法规范化：修饰键排好序（`Shift+Alt+Up` 与 `Alt+Shift+Up` 是同一种）。 */
const norm = (spec) => {
  const k = parseKey(spec);
  return [k.mod && 'Mod', k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.key].filter(Boolean).join('+');
};
/** 同时会收到按键的几档：正文里三档都收得到，页面上收得到 global 与 workbench。 */
const OVERLAPPING = new Set(['global', 'workbench', 'editor']);

describe('快捷键表：每一条都写全了', () => {
  test('id 不重复', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });

  test('每一条都有分组（在分组表里）、说明、至少一种按法', () => {
    const bad = SHORTCUTS.filter(
      (s) => !SHORTCUT_GROUPS.includes(s.group) || !s.label.trim() || s.keys.length === 0
    ).map((s) => s.id);
    assert.deepEqual(bad, []);
  });

  test('「某个面板里」那一档都写了在哪儿；别的档按档说', () => {
    assert.deepEqual(
      SHORTCUTS.filter((s) => !scopeText(s)).map((s) => s.id),
      []
    );
    assert.equal(scopeText(shortcutById('save')), '哪里都行');
    assert.equal(scopeText(shortcutById('find')), '编辑区里或页面上');
    assert.equal(scopeText(shortcutById('undo')), '光标在编辑区里');
    assert.equal(scopeText(shortcutById('findBoxNext')), '查找条的查找框里');
  });

  test('每一种按法都写得对：认得出的修饰键、最后一段是键', () => {
    const bad = [];
    for (const s of SHORTCUTS) {
      for (const spec of [...s.keys, ...(s.also ?? [])]) {
        const parts = spec.split('+');
        const key = parts.pop();
        if (!key || parts.some((m) => !['Mod', 'Ctrl', 'Alt', 'Shift'].includes(m))) {
          bad.push(`${s.id}:${spec}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  test('没有撞车的键：正文里、页面上同时收得到的那几档之间一种按法只归一条；同一个面板里也是', () => {
    const seen = new Map();
    const clashes = [];
    for (const s of SHORTCUTS) {
      const context = OVERLAPPING.has(s.scope) ? '编辑区与页面' : s.where;
      for (const spec of [...s.keys, ...(s.also ?? [])]) {
        const key = `${context}|${norm(spec)}`;
        if (seen.has(key)) {
          clashes.push(`${seen.get(key)} 与 ${s.id}：${spec}`);
        }
        seen.set(key, s.id);
      }
    }
    assert.deepEqual(clashes, []);
  });

  test('浏览器自己的那几样（剪切 / 复制 / 粘贴 / 全选）标着 native；浏览器拦不住的写明了', () => {
    assert.deepEqual(
      SHORTCUTS.filter((s) => s.native).map((s) => s.id),
      ['cut', 'copy', 'paste', 'selectAll']
    );
    for (const id of ['closeTab', 'newFile']) {
      assert.match(shortcutById(id).note, /浏览器多半拦不住/, id);
    }
  });

  test('分组的顺序就是面板与 README 的顺序，组里按表里的先后', () => {
    const groups = groupShortcuts(SHORTCUTS);
    assert.deepEqual(
      groups.map((g) => g.group),
      SHORTCUT_GROUPS.filter((g) => SHORTCUTS.some((s) => s.group === g))
    );
    assert.deepEqual(groups[0].items.map((s) => s.id).slice(0, 2), ['quickOpen', 'save']);
  });
});

describe('快捷键表：按平台写', () => {
  test('Windows / Linux：Ctrl、Shift、Alt 用加号连，Mod 写 Ctrl', () => {
    assert.equal(formatKey('Mod+Shift+F', false), 'Ctrl+Shift+F');
    assert.equal(formatKey('Shift+Alt+Down', false), 'Shift+Alt+↓');
    assert.equal(formatKey('Alt+/', false), 'Alt+/');
    assert.equal(formatKey('Ctrl+Y', false), 'Ctrl+Y');
    assert.equal(formatKey('F8', false), 'F8');
    assert.equal(formatKey('Escape', false), 'Esc');
    assert.equal(formatKey('Mod+Enter', false), 'Ctrl+Enter');
  });

  test('Mac：⌃⌥⇧⌘ 的顺序、不用加号，Mod 写 ⌘、Alt 写 ⌥、Control 写 ⌃，回车写 ↩', () => {
    assert.equal(formatKey('Mod+Shift+F', true), '⇧⌘F');
    assert.equal(formatKey('Shift+Alt+Down', true), '⌥⇧↓');
    assert.equal(formatKey('Alt+/', true), '⌥/');
    assert.equal(formatKey('Ctrl+Y', true), '⌃Y');
    assert.equal(formatKey('Mod+Enter', true), '⌘↩');
    assert.equal(formatKey('F8', true), 'F8');
  });

  test('几种按法「 / 」隔开；菜单上写第一种，Mac 上优先不用 Control 的那一种', () => {
    const redo = shortcutById('redo');
    assert.equal(formatKeys(redo, false), 'Ctrl+Y / Ctrl+Shift+Z');
    assert.equal(primaryKey(redo, false), 'Ctrl+Y');
    assert.equal(primaryKey(redo, true), 'Mod+Shift+Z');
    assert.equal(shortcutLabel('redo', false), 'Ctrl+Y');
    assert.equal(shortcutLabel('redo', true), '⇧⌘Z');
    assert.equal(shortcutLabel('save', true), '⌘S');
    assert.equal(shortcutLabel('names', true), '⌥/');
  });

  test('认 Mac：platform / userAgentData / userAgent 里的 Mac、iPhone、iPad；别的都不是', () => {
    assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
    assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true);
    assert.equal(isMacPlatform({ platform: 'iPad' }), true);
    assert.equal(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' }), true);
    assert.equal(isMacPlatform({ platform: 'Win32' }), false);
    assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
    assert.equal(isMacPlatform(undefined), false);
  });
});

describe('快捷键表：按法怎么认', () => {
  const ev = (key, mods = {}, code) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  test('Mod 认 Ctrl 或 ⌘，两样都没按不算；写了 Ctrl 的只认 Control', () => {
    assert.equal(matchesKey(ev('s', { ctrlKey: true }), 'Mod+S'), true);
    assert.equal(matchesKey(ev('s', { metaKey: true }), 'Mod+S'), true);
    assert.equal(matchesKey(ev('s'), 'Mod+S'), false);
    assert.equal(matchesKey(ev('y', { ctrlKey: true }), 'Ctrl+Y'), true);
    assert.equal(matchesKey(ev('y', { metaKey: true }), 'Ctrl+Y'), false);
  });

  test('没写的修饰键不许按：Ctrl+Shift+S、Ctrl+Alt+S 都不是 Mod+S；F8 带 Shift 不是 F8', () => {
    assert.equal(matchesKey(ev('S', { ctrlKey: true, shiftKey: true }), 'Mod+S'), false);
    assert.equal(matchesKey(ev('s', { ctrlKey: true, altKey: true }), 'Mod+S'), false);
    assert.equal(matchesKey(ev('F8', { shiftKey: true }), 'F8'), false);
    assert.equal(matchesKey(ev('a', { ctrlKey: true }), 'Alt+/'), false);
  });

  test('字母不分大小写（按着 Shift 时 key 是大写）；方向键、Esc 认浏览器的写法', () => {
    assert.equal(matchesKey(ev('F', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+F'), true);
    assert.equal(matchesKey(ev('ArrowUp', { altKey: true }), 'Alt+Up'), true);
    assert.equal(matchesKey(ev('Esc'), 'Escape'), true);
    assert.equal(keyName(ev('ArrowDown')), 'Down');
  });

  test('按着 Alt（Mac 上 ⌥）打出的是特殊字符：看 code（⌥/ 打出 ÷ 也认 Alt+/）', () => {
    assert.equal(matchesKey(ev('÷', { altKey: true }, 'Slash'), 'Alt+/'), true);
    assert.equal(matchesKey(ev('?', { altKey: true, shiftKey: true }, 'Slash'), 'Alt+/'), false);
  });

  test('加号写 Plus：Shift 打出来的「+」与小键盘的加号都认，不看 Shift', () => {
    assert.equal(matchesKey(ev('+', { ctrlKey: true, shiftKey: true }), 'Mod+Plus'), true);
    assert.equal(matchesKey(ev('+', { ctrlKey: true }, 'NumpadAdd'), 'Mod+Plus'), true);
    assert.equal(matchesKey(ev('=', { ctrlKey: true }), 'Mod+='), true);
  });
});

describe('快捷键表：筛选', () => {
  test('空的筛选串给全部', () => {
    assert.equal(filterShortcuts(SHORTCUTS, '  ').length, SHORTCUTS.length);
  });

  test('按说明、在哪儿、补充说明、分组筛，不分大小写；空白隔开的几段都得有', () => {
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '撤销').map((s) => s.id),
      ['undo']
    );
    assert.ok(filterShortcuts(SHORTCUTS, '段落').every((s) => /段/.test(`${s.label}${s.group}${s.note ?? ''}`)));
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '查找 下一处').map((s) => s.id),
      ['findNext', 'findBoxNext', 'replaceBoxEnter']
    );
  });

  test('按键筛：两种平台的写法都认（Ctrl+Shift+F 与 ⇧⌘F）', () => {
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, 'ctrl+shift+f').map((s) => s.id),
      ['bookFind']
    );
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '⇧⌘F').map((s) => s.id),
      ['bookFind']
    );
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, 'F8').map((s) => s.id),
      ['focusMode']
    );
  });
});
