/**
 * 一键排版、半角标点转全角（`media/src/editor/layout.ts`），以及标题栏「编辑」菜单里段落那一组
 * （`media/src/view/paragraphMenu.ts`）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 工具栏「排版」 | 只对正文显示、挨着「预览」；整份按分段格式排、一步撤销、报改了几处；没变化说「已经是这个格式了」 |
 * | 有选区 | 只排 / 只转选区碰到的那几行 |
 * | 半角标点转全角 | 经菜单，一步撤销、报改了几处 |
 * | 「段落格式 ▸」 | 三项、当前那项打 ✓、点了发 `setParagraphStyle`；没开工程 / 还不是小说工程时置灰、不展开 |
 * | 「成对符号自动补全」 | 缺省打 ✓，点了关掉之后敲左半边不补 |
 * | 「一键排版」「半角标点转全角」 | 当前文件不是正文时置灰 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const W = '　　';

function harness(opts = {}) {
  const ui = mount({
    body: 'standalone',
    scripts: ['view.js', 'editor.js'],
    shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    ...opts,
  });
  const toasts = [];
  // 编辑器经 window.__nfToast 报话；换成记下来的，好断言说了什么。
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const h = {
    ui,
    toasts,
    area,
    open(path, text, kind) {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
    },
    state(extra) {
      ui.post({ type: 'state', state: viewState(extra) });
    },
    select(start, end = start) {
      area().setSelectionRange(start, end);
    },
    undo() {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    },
    formatBtn: () => ui.doc.querySelector('#edToolbar .ed-format-btn'),
    /** 打开「编辑」菜单，按标签找一项。 */
    menuItem(label) {
      ui.closeMenu();
      ui.clickEl(ui.doc.querySelector('[data-menu="edit"]'));
      return [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
        (b) => b.querySelector('.wb-menu-label').textContent === label
      );
    },
    /** 悬停「段落格式」，返回子菜单里的三项。 */
    styleItems() {
      const parent = h.menuItem('段落格式');
      parent.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
      return [...ui.doc.querySelectorAll('.wb-menu-drop.submenu .wb-menu-item')];
    },
  };
  return h;
}

describe('一键排版', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.state({ paragraphStyle: 'indent' });
  });

  test('「排版」按钮只对正文显示，挨着「预览」', () => {
    h.open('.novelforge/characters/林昭.md', '# 林昭', 'character');
    assert.equal(h.formatBtn().classList.contains('hidden'), true, '角色卡不显示');
    h.open('chapters/001-雨夜.md', '他推开门。\n\n\n她笑了。  ', 'chapter');
    assert.equal(h.formatBtn().classList.contains('hidden'), false);
    assert.equal(h.formatBtn().previousElementSibling.id, 'edPreviewBtn');
  });

  test('点一下：整份按分段格式排，报改了几处', () => {
    h.select(2);
    h.ui.clickEl(h.formatBtn());
    assert.equal(h.area().value, `${W}他推开门。\n${W}她笑了。\n`);
    // 两行各缩进一处、两段之间的空行收掉一处、文末补换行一处。
    assert.equal(h.toasts.at(-1), '排版完成，改了 4 处');
    assert.equal(h.area().selectionStart, 4, '光标还在原来那个字后面');
  });

  test('一步撤销', () => {
    h.undo();
    assert.equal(h.area().value, '他推开门。\n\n\n她笑了。  ');
  });

  test('已经是这个格式：不动，说一句', () => {
    h.open('chapters/002-入镇.md', `${W}他推开门。\n${W}她笑了。\n`, 'chapter');
    h.ui.clickEl(h.formatBtn());
    assert.equal(h.area().value, `${W}他推开门。\n${W}她笑了。\n`);
    assert.equal(h.toasts.at(-1), '已经是这个格式了');
  });

  test('有选区：只排选区碰到的那几行', () => {
    h.open('chapters/003-夜访.md', '甲\n\n乙\n\n丙\n\n丁', 'chapter');
    h.select(3, 7);
    h.ui.clickEl(h.formatBtn());
    assert.equal(h.area().value, `甲\n\n${W}乙\n${W}丙\n\n丁`);
  });

  test('草稿区里的正文也有这颗按钮', () => {
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const btn = draft.querySelector('.ed-format-btn');
    assert.ok(btn);
    assert.equal(btn.classList.contains('hidden'), false);
    h.ui.clickEl(btn);
    assert.equal(draft.querySelector('textarea').value, `${W}草稿\n`);
  });
});

describe('「编辑」菜单：半角标点转全角与一键排版', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.state({ paragraphStyle: 'blank' });
  });

  test('非正文时两项置灰', () => {
    h.open('.novelforge/characters/林昭.md', '# 林昭', 'character');
    h.area().focus();
    assert.equal(h.menuItem('一键排版').disabled, true);
    assert.equal(h.menuItem('半角标点转全角').disabled, true);
  });

  test('正文：半角标点转全角，一步撤销，报改了几处', () => {
    h.open('chapters/001-雨夜.md', '他说:"走吧."然后走了,头也不回', 'chapter');
    h.area().focus();
    const item = h.menuItem('半角标点转全角');
    assert.equal(item.disabled, false);
    h.ui.clickEl(item);
    assert.equal(h.area().value, '他说：“走吧。”然后走了，头也不回');
    assert.equal(h.toasts.at(-1), '半角标点转全角：改了 5 处');
    h.undo();
    assert.equal(h.area().value, '他说:"走吧."然后走了,头也不回');
  });

  test('有选区：只转选区碰到的那几行', () => {
    h.open('chapters/002-入镇.md', '第一行,\n第二行,\n第三行,', 'chapter');
    h.area().focus();
    h.select(6, 8);
    h.ui.clickEl(h.menuItem('半角标点转全角'));
    assert.equal(h.area().value, '第一行,\n第二行，\n第三行,');
  });

  test('没有要转的：说一句，不动', () => {
    h.open('chapters/003-夜访.md', '他走了。', 'chapter');
    h.area().focus();
    h.ui.clickEl(h.menuItem('半角标点转全角'));
    assert.equal(h.area().value, '他走了。');
    assert.equal(h.toasts.at(-1), '没有要转的半角标点。');
  });

  test('菜单里的「一键排版」与按钮同一件事', () => {
    h.open('chapters/004-北行.md', '甲\n乙', 'chapter');
    h.area().focus();
    h.ui.clickEl(h.menuItem('一键排版'));
    assert.equal(h.area().value, '甲\n\n乙\n');
  });
});

describe('「编辑」菜单：段落格式与成对符号开关', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.state({ paragraphStyle: 'indent' });
    h.open('chapters/001-雨夜.md', '他说：', 'chapter');
  });

  test('「段落格式 ▸」三项，当前那项打 ✓', () => {
    const items = h.styleItems();
    assert.deepEqual(
      items.map((b) => b.querySelector('.wb-menu-label').textContent),
      ['空行分段', '段首缩进', '缩进加空行']
    );
    assert.deepEqual(
      items.map((b) => b.querySelector('.wb-menu-check').textContent),
      ['', '✓', '']
    );
  });

  test('点一项发 setParagraphStyle', () => {
    const items = h.styleItems();
    h.ui.clickEl(items[2]);
    assert.equal(h.ui.last('setParagraphStyle')?.style, 'both');
  });

  test('后端推回新值之后 ✓ 跟着挪', () => {
    h.state({ paragraphStyle: 'both' });
    const checks = h.styleItems().map((b) => b.getAttribute('aria-checked'));
    assert.deepEqual(checks, ['false', 'false', 'true']);
  });

  test('还不是小说工程：「段落格式」置灰、悬停不展开', () => {
    h.state({ initialized: false, paragraphStyle: 'blank' });
    const parent = h.menuItem('段落格式');
    assert.equal(parent.disabled, true);
    parent.dispatchEvent(new h.ui.window.MouseEvent('mouseenter'));
    assert.equal(h.ui.doc.querySelector('.wb-menu-drop.submenu'), null);
    h.state({ paragraphStyle: 'both' });
  });

  test('「成对符号自动补全」缺省打 ✓', () => {
    const item = h.menuItem('成对符号自动补全');
    assert.equal(item.getAttribute('aria-checked'), 'true');
    assert.equal(item.querySelector('.wb-menu-check').textContent, '✓');
  });

  test('点了关掉：之后敲左半边不补', () => {
    h.ui.clickEl(h.menuItem('成对符号自动补全'));
    assert.equal(h.menuItem('成对符号自动补全').getAttribute('aria-checked'), 'false');
    h.ui.closeMenu();
    const a = h.area();
    a.setSelectionRange(3, 3);
    a.value = '他说：“';
    a.setSelectionRange(4, 4);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '“' }));
    assert.equal(a.value, '他说：“');
  });

  test('再点一下打开', () => {
    h.ui.clickEl(h.menuItem('成对符号自动补全'));
    assert.equal(h.menuItem('成对符号自动补全').getAttribute('aria-checked'), 'true');
    h.ui.closeMenu();
  });
});

describe('「编辑」菜单：空窗口', { skip: JSDOM_SKIP }, () => {
  test('没开工程：「段落格式」置灰', () => {
    const h = harness({ empty: true });
    h.state({ paragraphStyle: 'blank' });
    h.ui.post({ type: 'workspaces', currentId: null, items: [], recents: [] });
    assert.equal(h.menuItem('段落格式').disabled, true);
  });
});
