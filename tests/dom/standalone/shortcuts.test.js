/**
 * 快捷键表（`media/src/editor/shortcuts.ts`）守两头，外加「帮助 → 快捷键一览」面板（`editor/shortcutsPanel.ts`）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 菜单上的 kbd | 标题栏四个菜单上写着键的每一项都在表里（`menu`）、字与表一样；表里写了 `menu` 的每一条菜单上都有。Mac 上写 ⌘ / ⌥ |
 * | 表里的每一条都有人处理 | 照它的生效范围摆好场面（正文里 / 页面上 / 对话输入框里 / 某个面板开着时）按一下，得被接走（`defaultPrevented`）；浏览器自己的那几样（剪切、复制……）反过来不许被接走。`where` 没有对应的场面就算没测到，用例失败 |
 * | 被接走的每一下都在表里 | 在正文里、页面上、对话输入框里把几百种按法（字母、数字、标点、F1–F12、方向键这些 × 修饰键组合）挨个按一遍，被接走的每一下都得是表里这一档认的某一条 |
 * | 快捷键一览 | Ctrl+/（对话输入框里也行）与「帮助 → 快捷键一览」打开；按分组列出全部；筛选；Esc / 点外面 / × / 再按 Ctrl+/ 关、焦点还回去；Esc 不连带退出专注模式；别的弹窗开着时不开；组字中途不算；Mac 上写 ⌘ |
 *
 * 「被接走的每一下都在表里」只扫这三处场面：面板里那几个键（查找框里的回车、补全框里的方向键……）各自的面板里就那么几个，
 * 由「表里的每一条都有人处理」那一半按到；对话输入框自己的回车发送、`@`（引用选择器）不是快捷键，不扫。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');
const { loadModule } = require('../../helpers/load');

const { SHORTCUTS, formatKey, matchesKey, parseKey, shortcutLabel } = loadModule('media/src/editor/shortcuts.ts');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const S = '.novelforge/summaries';
const CH = 'chapters/003-夜访.md';
const TEXT = '# 第三章 夜访\n\n雨下了三天。\n\n林昭推门进来。\n\n- 一\n- 二\n';
const chapterRow = (no, title) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: `chapters/00${no}-${title}.md`,
  plotPath: `${S}/00${no}-${title}.md`,
  plotExists: true,
  chapterPath: `chapters/00${no}-${title}.md`,
  wordCount: 100,
  targetWords: 3000,
  stage: 'done',
});
const INDEX = [chapterRow(2, '入镇'), chapterRow(3, '夜访'), chapterRow(4, '北行')];
const NAMES = [{ name: '林昭', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/林昭.md' }];

const SHIFTED = { '/': '?', '=': '+', '-': '_', ',': '<', '.': '>', ';': ':', "'": '"', '[': '{', ']': '}', '\\': '|', '`': '~' };
const DIGIT_SHIFTED = ')!@#$%^&*(';
const CODE = { '/': 'Slash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote' };
const NAMED = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Plus: '+' };

/** 一种按法 → 浏览器发出来的那个 keydown（Linux：Mod 是 Ctrl）。 */
function eventFor(spec) {
  const k = parseKey(spec);
  const init = { ctrlKey: k.mod || k.ctrl, altKey: k.alt, shiftKey: k.shift, metaKey: false };
  if (/^[a-z]$/.test(k.key)) {
    return { ...init, key: k.shift ? k.key.toUpperCase() : k.key, code: `Key${k.key.toUpperCase()}` };
  }
  if (/^\d$/.test(k.key)) {
    return { ...init, key: k.key, code: `Digit${k.key}` };
  }
  if (CODE[k.key]) {
    return { ...init, key: k.key, code: CODE[k.key] };
  }
  return { ...init, key: NAMED[k.key] ?? k.key, code: k.key === 'Plus' ? 'Equal' : undefined };
}

function harness(extraShims = []) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js', 'explorer.js'], shims: [...SHIMS, ...extraShims] });
  ui.doc.execCommand = () => true;
  ui.window.prompt = () => null;
  ui.window.__nfToast = () => {};
  ui.post({ type: 'chapterIndex', chapters: INDEX });
  ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file', 子目录: 'dir' })] });
  const doc = ui.doc;
  const h = {
    ui,
    doc,
    area: () => doc.getElementById('edArea'),
    chat: () => doc.getElementById('input'),
    open: () => ui.post({ type: 'editorOpen', file: file(CH, TEXT, { kind: 'chapter' }) }),
    key(target, init) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    blur() {
      doc.activeElement?.blur?.();
    },
    /** 还有什么开着（面板、浮层、对话框、专注模式、菜单、目录选择器）。 */
    somethingOpen() {
      return !!(
        doc.querySelector('.ed-dialog, .ed-keys-overlay, .qo-panel, .ed-look-overlay, .wb-menu-drop, .ctx-menu, .nf-picker.open') ||
        doc.querySelector('#wbSide.bf-open') ||
        [...doc.querySelectorAll('.ed-find')].some((f) => !f.classList.contains('hidden')) ||
        (doc.querySelector('.nc-box') && !doc.querySelector('.nc-box').classList.contains('hidden')) ||
        doc.body.classList.contains('nf-focus')
      );
    },
    /** 回到起点：什么都没开、正文开着、在编辑（不在预览里）。 */
    reset() {
      for (let i = 0; i < 8 && h.somethingOpen(); i++) {
        const bf = doc.querySelector('#wbSide.bf-open .bf-close');
        if (bf) {
          ui.clickEl(bf);
          continue;
        }
        const focused = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : h.area();
        h.key(focused, { key: 'Escape' });
        if (h.somethingOpen()) {
          h.key(h.area(), { key: 'Escape' });
        }
      }
      if (![...doc.querySelectorAll('#wbEditor .ed-tab')].some((t) => t.dataset.path === CH)) {
        h.open();
      }
      if (!doc.getElementById('edPreview').classList.contains('hidden')) {
        ui.clickEl(doc.getElementById('edPreviewBtn'));
      }
      assert.equal(h.somethingOpen(), false, '回不到起点');
    },
    /** 名词表（补全框要它）。 */
    serveNames() {
      const req = ui.last('requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig: 'n1', index: { initialized: true, names: NAMES } });
    },
  };
  h.open();
  return h;
}

// ---------------------------------------------------------------- 场面

/** 正文里（textarea 有焦点）。 */
const inEditor = (h) => {
  h.area().focus();
  return h.area();
};
/** 页面上（焦点不在任何输入框里）。 */
const onPage = (h) => {
  h.blur();
  return h.doc.body;
};
/** 左边的对话输入框里。 */
const inChat = (h) => {
  h.chat().focus();
  return h.chat();
};

/** 每一档在哪儿按：global 在对话输入框里按（证明哪里都行），workbench 在页面上，editor 在正文里。 */
const BY_SCOPE = { global: inChat, workbench: onPage, editor: inEditor };

/** `context` 那几档：照 `where` 摆好场面，返回在哪儿按。表里新加了一种 `where`，这里也得加。 */
const BY_WHERE = {
  查找条的查找框里: (h) => {
    h.key(inEditor(h), eventFor('Mod+F'));
    return h.doc.querySelector('#wbEditor .ed-find-input');
  },
  查找条的替换框里: (h) => {
    h.key(inEditor(h), eventFor('Mod+H'));
    return h.doc.querySelector('#wbEditor .ed-replace-input');
  },
  补全框开着时: (h) => {
    h.key(inEditor(h), eventFor('Alt+/'));
    h.serveNames();
    assert.ok(h.doc.querySelector('.nc-box:not(.hidden)'), '补全框没弹出来');
    return h.area();
  },
  '「转到…」面板里': (h) => {
    h.key(onPage(h), eventFor('Mod+P'));
    return h.doc.querySelector('.qo-panel .qo-input');
  },
  专注模式里: (h) => {
    h.key(onPage(h), eventFor('F8'));
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    return inEditor(h);
  },
  '面板、弹窗、菜单开着时': (h) => {
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-view-command', { detail: { name: 'openLook' } }));
    assert.ok(h.doc.querySelector('.ed-look-overlay'), '外观面板没开');
    return h.doc.activeElement;
  },
  '「文件」页的树上选中一行时': (h) => {
    h.doc.getElementById('pane-files').classList.add('active');
    const row = [...h.doc.querySelectorAll('#filesBody .fx-row')].find((r) => r.textContent.includes('a.md'));
    row.dispatchEvent(new h.ui.window.FocusEvent('focus', { bubbles: true }));
    row.focus();
    return row;
  },
};

function placeFor(h, s) {
  if (s.scope === 'context') {
    const setup = BY_WHERE[s.where];
    assert.ok(setup, `「${s.where}」（${s.id}）没有探针：在 BY_WHERE 里加一个`);
    return setup(h);
  }
  return BY_SCOPE[s.scope](h);
}

describe('快捷键表：表里的每一条都真的有人处理', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  for (const s of SHORTCUTS) {
    for (const spec of s.keys) {
      const where = s.scope === 'context' ? s.where : { global: '对话输入框里', workbench: '页面上', editor: '正文里' }[s.scope];
      test(`${s.id}：${spec}（${where}）${s.native ? '是浏览器自己的，编辑器不拦' : '被接走'}`, () => {
        h.reset();
        const target = placeFor(h, s);
        const ev = h.key(target, eventFor(spec));
        assert.equal(ev.defaultPrevented, !s.native, `${s.label}`);
        h.doc.getElementById('pane-files').classList.remove('active');
        h.reset();
      });
    }
  }
});

// ---------------------------------------------------------------- 反过来扫

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const PUNCT = Object.keys(SHIFTED);
const NAMED_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', ' '];
const F_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const MODS = [
  {},
  { shiftKey: true },
  { ctrlKey: true },
  { ctrlKey: true, shiftKey: true },
  { altKey: true },
  { altKey: true, shiftKey: true },
  { ctrlKey: true, altKey: true },
  { metaKey: true },
  { metaKey: true, shiftKey: true },
];

/** 几百种按法：字母、数字、标点（按着 Shift 时是美式键盘打出来的那个字）、有名字的键、F1–F12，× 修饰键组合。 */
function* universe({ typing }) {
  for (const mods of MODS) {
    const plain = !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    for (const ch of [...LETTERS, ...DIGITS, ...PUNCT]) {
      if (plain) {
        continue; // 那是打字
      }
      let key = ch;
      if (mods.shiftKey) {
        key = /[a-z]/.test(ch) ? ch.toUpperCase() : /\d/.test(ch) ? DIGIT_SHIFTED[Number(ch)] : SHIFTED[ch];
      }
      if (!typing && key === '@') {
        continue; // 对话输入框自己的 @（打出 @ 就弹引用选择器，带不带修饰键都一样）
      }
      const code = /[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : CODE[ch];
      yield { key, code, ...mods };
    }
    for (const key of [...NAMED_KEYS, ...F_KEYS]) {
      if (!typing && key === 'Enter') {
        continue; // 对话输入框自己的回车发送
      }
      if (!typing && plain && !key.startsWith('F')) {
        continue;
      }
      yield { key, ...mods };
    }
  }
}

const describeKey = (e) =>
  [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key === ' ' ? 'Space' : e.key]
    .filter(Boolean)
    .join('+');

/** 在这一档（`scopes`）里，这一下是不是表里的某一条（浏览器自己的那几样不算：它们不许被接走）。 */
function listed(e, scopes) {
  const like = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e };
  return SHORTCUTS.some(
    (s) => !s.native && scopes.includes(s.scope) && [...s.keys, ...(s.also ?? [])].some((spec) => matchesKey(like, spec))
  );
}

function scan(h, place, scopes, opts) {
  const unlisted = [];
  let prevented = 0;
  for (const init of universe(opts)) {
    const target = place(h);
    const ev = h.key(target, init);
    if (!ev.defaultPrevented) {
      continue;
    }
    prevented++;
    if (!listed(init, scopes)) {
      unlisted.push(describeKey(init));
    }
    h.reset();
  }
  return { unlisted, prevented };
}

describe('快捷键表：被接走的每一下都在表里', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('正文里：被接走的都是「正文里」「编辑区或页面上」「哪里都行」那几档的', () => {
    const { unlisted, prevented } = scan(h, inEditor, ['editor', 'workbench', 'global'], { typing: true });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 25, `才接走 ${prevented} 下，场面没摆对？`);
  });

  test('页面上：被接走的都是「编辑区或页面上」「哪里都行」那两档的', () => {
    const { unlisted, prevented } = scan(h, onPage, ['workbench', 'global'], { typing: true });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 12, `才接走 ${prevented} 下`);
  });

  test('对话输入框里：被接走的组合键都是「哪里都行」那一档的', () => {
    const { unlisted, prevented } = scan(h, inChat, ['global'], { typing: false });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 8, `才接走 ${prevented} 下`);
  });
});

// ---------------------------------------------------------------- 菜单

const MENUS = { file: '文件', edit: '编辑', view: '视图', help: '帮助' };

/** 四个菜单上写着键的每一项：`菜单 › 名字` → 键。 */
function menuKbds(h) {
  const out = new Map();
  for (const [key, name] of Object.entries(MENUS)) {
    h.ui.clickEl(h.doc.querySelector(`[data-menu="${key}"]`));
    for (const item of h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')) {
      const kbd = item.querySelector('.wb-menu-kbd');
      if (kbd) {
        out.set(`${name} › ${item.querySelector('.wb-menu-label').textContent}`, kbd.textContent);
      }
    }
    h.ui.closeMenu();
  }
  return out;
}

describe('快捷键表：菜单上写的键从表里取', { skip: JSDOM_SKIP }, () => {
  test('菜单上写着键的每一项都在表里，字一样；表里写了 menu 的每一条菜单上都有', () => {
    const h = harness();
    const shown = menuKbds(h);
    const want = new Map(SHORTCUTS.filter((s) => s.menu).map((s) => [s.menu, shortcutLabel(s.id, false)]));
    assert.deepEqual([...shown.entries()].sort(), [...want.entries()].sort());
  });

  test('Mac 上写 ⌘ / ⌥：保存 ⌘S、重做 ⇧⌘Z、名词补全 ⌥/、快捷键一览 ⌘/', () => {
    const h = harness(['mac']);
    const shown = menuKbds(h);
    assert.deepEqual(
      ['文件 › 保存', '编辑 › 重做', '视图 › 名词补全', '帮助 › 快捷键一览', '编辑 › 全书查找替换…'].map((p) => shown.get(p)),
      ['⌘S', '⇧⌘Z', '⌥/', '⌘/', '⇧⌘F']
    );
  });
});

// ---------------------------------------------------------------- 快捷键一览

describe('快捷键一览：Ctrl+/ 与「帮助 → 快捷键一览」', { skip: JSDOM_SKIP }, () => {
  let h;
  const panel = () => h.doc.querySelector('.ed-keys');
  const rows = () => [...h.doc.querySelectorAll('.ed-keys .ed-keys-row')];
  const filter = (text) => {
    const input = h.doc.querySelector('.ed-keys-filter');
    input.value = text;
    input.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true }));
  };
  before(() => {
    h = harness();
  });

  test('页面模板里没有它；「帮助」里紧跟「使用说明」，写着 Ctrl+/', () => {
    assert.equal(panel(), null);
    h.ui.clickEl(h.doc.querySelector('[data-menu="help"]'));
    const labels = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].map(
      (b) => `${b.querySelector('.wb-menu-label').textContent}${b.querySelector('.wb-menu-kbd') ? `|${b.querySelector('.wb-menu-kbd').textContent}` : ''}`
    );
    h.ui.closeMenu();
    assert.deepEqual(labels.slice(0, 3), ['欢迎页面', '使用说明', '快捷键一览|Ctrl+/']);
  });

  test('点菜单那一项打开：模态（.modal-overlay）、焦点进筛选框、按分组列出全部', () => {
    h.ui.clickEl(h.doc.querySelector('[data-menu="help"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.textContent.includes('快捷键一览'));
    h.ui.clickEl(item);
    assert.ok(panel());
    assert.ok(panel().closest('.modal-overlay'));
    assert.equal(h.doc.activeElement, h.doc.querySelector('.ed-keys-filter'));
    assert.equal(rows().length, SHORTCUTS.length);
    const groups = [...h.doc.querySelectorAll('.ed-keys-group-title')].map((n) => n.textContent);
    assert.deepEqual(groups, ['文件与标签', '编辑', '段落', '查找替换', '名词补全', '视图', '面板与帮助', '文件页']);
  });

  test('一行三格：键（几种按法各一个 kbd）、做什么（补充说明在下面）、在哪儿管用', () => {
    const redo = rows().find((r) => r.dataset.id === 'redo');
    assert.deepEqual([...redo.querySelectorAll('kbd')].map((k) => k.textContent), ['Ctrl+Y', 'Ctrl+Shift+Z']);
    assert.equal(redo.querySelector('.ed-keys-where').textContent, '光标在编辑区里');
    const close = rows().find((r) => r.dataset.id === 'closeTab');
    assert.match(close.querySelector('.ed-keys-note').textContent, /浏览器多半拦不住/);
  });

  test('筛选：打「撤销」只剩一条，按键的写法也认，打不认识的说没有，清空回到全部', () => {
    filter('撤销');
    assert.deepEqual(rows().map((r) => r.dataset.id), ['undo']);
    assert.match(h.doc.querySelector('.ed-keys-count').textContent, /找到 1 个/);
    filter('ctrl+shift+f');
    assert.deepEqual(rows().map((r) => r.dataset.id), ['bookFind']);
    filter('没有这种键');
    assert.equal(rows().length, 0);
    assert.match(h.doc.querySelector('.ed-keys-list').textContent, /没有匹配的快捷键/);
    filter('');
    assert.equal(rows().length, SHORTCUTS.length);
  });

  test('组字中途不筛（拼音字母不算），上屏再筛', () => {
    const input = h.doc.querySelector('.ed-keys-filter');
    input.value = 'che';
    input.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, isComposing: true }));
    assert.equal(rows().length, SHORTCUTS.length);
    input.value = '撤销';
    input.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true }));
    assert.equal(rows().length, 1);
    filter('');
  });

  test('Esc 关掉，焦点还回打开之前的地方', () => {
    h.key(h.doc.querySelector('.ed-keys-filter'), { key: 'Escape' });
    assert.equal(panel(), null);
  });

  test('Ctrl+/：正文里打开，再按一下关掉、焦点回到正文', () => {
    const area = inEditor(h);
    const ev = h.key(area, eventFor('Mod+/'));
    assert.equal(ev.defaultPrevented, true);
    assert.ok(panel());
    h.key(h.doc.activeElement, eventFor('Mod+/'));
    assert.equal(panel(), null);
    assert.equal(h.doc.activeElement, area);
  });

  test('对话输入框里也开（这个键在那里没有别的用处）；Mac 的 ⌘/ 也认', () => {
    inChat(h);
    h.key(h.chat(), { key: '/', code: 'Slash', metaKey: true });
    assert.ok(panel());
    h.key(h.doc.activeElement, { key: 'Escape' });
    assert.equal(h.doc.activeElement, h.chat());
  });

  test('点外面那一层关掉；点面板里面不关；× 也关', () => {
    h.key(inEditor(h), eventFor('Mod+/'));
    panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.ok(panel());
    h.doc.querySelector('.ed-keys-overlay').dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(panel(), null);
    h.key(inEditor(h), eventFor('Mod+/'));
    h.ui.clickEl(h.doc.querySelector('.ed-keys-x'));
    assert.equal(panel(), null);
  });

  test('专注模式里：面板开着时 Esc 只收面板，不连带退出专注', () => {
    h.key(onPage(h), eventFor('F8'));
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    h.key(inEditor(h), eventFor('Mod+/'));
    h.key(h.doc.activeElement, { key: 'Escape' });
    assert.equal(panel(), null);
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    h.key(onPage(h), eventFor('F8'));
  });

  test('输入法组字中途的 Ctrl+/ 不算；别的弹窗（页内对话框）开着时不开', async () => {
    const ev = h.key(inEditor(h), { ...eventFor('Mod+/'), isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(panel(), null);
    // 改一个字再关标签：弹「保存 / 不保存 / 取消」。
    const area = h.area();
    area.value = `${area.value}改`;
    area.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '改' }));
    h.key(area, eventFor('Mod+W'));
    assert.ok(h.ui.dialog(), '没弹对话框');
    h.ui.window.dispatchEvent(new h.ui.window.Event('nf-shortcuts-command'));
    assert.equal(panel(), null);
    await h.ui.answer('取消');
  });

  test('Mac 上按 ⌘ / ⌥ 写', () => {
    const m = harness(['mac']);
    m.key(m.area(), { key: '/', code: 'Slash', metaKey: true });
    const redo = m.doc.querySelector('.ed-keys-row[data-id="redo"]');
    assert.deepEqual([...redo.querySelectorAll('kbd')].map((k) => k.textContent), ['⌃Y', '⇧⌘Z']);
    assert.equal(m.doc.querySelector('.ed-keys-row[data-id="names"] kbd').textContent, '⌥/');
    assert.match(m.doc.querySelector('.ed-keys-filter').placeholder, /⌘F/);
    assert.equal(formatKey('Mod+/', true), '⌘/');
  });
});
