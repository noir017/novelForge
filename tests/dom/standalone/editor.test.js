/**
 * 独立版内置编辑器：主区/草稿区两块编辑区，以及标签右键菜单与文件搬家。
 *
 * 迁自 scripts/smoke-view.js 的这两节：
 *   == 内置编辑器：两块编辑区 ==（1390） == 内置编辑器：右键菜单与标签搬家 ==（2441）
 *
 * 走的是 html.ts 的 body：editor.js 只在有 `#wbEditor` 时才跑，插件形态的
 * body 里没有那块 DOM，它会直接退出——所以覆盖它必须用独立版的结构。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

describe('内置编辑器：两块编辑区', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tabsOf = (pane) => [...pane.querySelectorAll('.ed-tab-name')].map((n) => n.textContent);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('一开始只有主区一块', () => {
    assert.equal(ui.panes().length, 1, `${ui.panes().length} 块`);
  });

  test('草稿分隔条藏着', () => {
    assert.ok(ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });

  // ---- 主区打开正文
  test('正文开在主区', () => {
    ui.post({
      type: 'editorOpen',
      file: file('chapters/001-楔子.md', '# 楔子\n\n正文', { draftPath: 'drafts/001-楔子.md' }),
    });
    assert.equal(tabsOf(ui.panes()[0]).join(','), '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('是章节时显示「草稿」按钮', () => {
    assert.ok(!ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
  });

  test('点「草稿」发 openDraft，带的是章节路径', () => {
    ui.clickEl(ui.doc.getElementById('edDraftBtn'));
    const req = ui.last('openDraft');
    assert.ok(req, '没发出 openDraft');
    assert.equal(req.path, 'chapters/001-楔子.md', JSON.stringify(req));
  });

  // ---- 后端回一份草稿，开在第二块
  test('草稿区被创建出来', () => {
    ui.post({
      type: 'editorOpen',
      pane: 'draft',
      file: file('drafts/001-楔子.md', '# 楔子 · 草稿\n\n'),
    });
    assert.equal(ui.panes().length, 2, `${ui.panes().length} 块`);
  });

  test('第二块带 wb-editor-draft', () => {
    assert.ok(ui.panes()[1].classList.contains('wb-editor-draft'));
  });

  test('草稿分隔条露出来', () => {
    assert.ok(!ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });

  test('正文仍在主区', () => {
    assert.equal(tabsOf(ui.panes()[0]).join(','), '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('草稿在草稿区', () => {
    assert.equal(tabsOf(ui.panes()[1]).join(','), '001-楔子.md', tabsOf(ui.panes()[1]).join(','));
  });

  // ---- 保存回执按 path 找对应的那一块，别把 draftPath 冲掉
  test('保存后「草稿」按钮还在', () => {
    ui.post({
      type: 'editorSaved',
      file: file('chapters/001-楔子.md', '# 楔子\n\n改过了', { draftPath: 'drafts/001-楔子.md' }),
    });
    assert.ok(!ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
  });

  // ---- 非章节文件不显示「草稿」按钮
  test('非章节不显示「草稿」按钮', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/style.md', '# 文风指南') });
    assert.ok(ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
  });

  // ---- 一个路径只属于一块：把主区的正文改开到草稿区
  test('主区交出了这个路径，只剩另一份文件', () => {
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('chapters/001-楔子.md', '# 楔子\n\n改过了') });
    assert.equal(tabsOf(ui.panes()[0]).join(','), 'style.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('草稿区现在有两个标签', () => {
    assert.equal(ui.panes()[1].querySelectorAll('.ed-tab').length, 2, tabsOf(ui.panes()[1]).join(','));
  });
});

describe('内置编辑器：右键菜单与标签搬家', { skip: JSDOM_SKIP }, () => {
  let ui;
  let tabItems;
  let area;
  let areaMenu;
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);

  before(() => {
    // 原脚本这一节用的是 mountExplorer（view.js + editor.js + explorer.js）：
    // 右键菜单引擎在 view.js 里，`window.__nfContextMenu` 是两边的唯一接口。
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    ui.post({ type: 'editorOpen', file: file('a.md', '甲的内容') });
    ui.post({ type: 'editorOpen', file: file('b.md', '乙的内容') });
  });

  test('打开了两个标签', () => {
    assert.equal(tabs().length, 2, String(tabs().length));
  });

  // ---- 标签菜单
  test('标签菜单含关闭/关闭右侧/关闭其它', () => {
    tabItems = ui.itemsOf(ui.rightClick(tabs()[0]));
    assert.ok(
      tabItems.includes('关闭') &&
      tabItems.some((l) => l.startsWith('关闭右侧')) &&
      tabItems.some((l) => l.startsWith('关闭其它')),
      JSON.stringify(tabItems));
  });

  test('关闭其它后只剩一个标签', () => {
    ui.clickEl(btn(ui.rightClick(tabs()[0]), tabItems.find((l) => l.startsWith('关闭其它'))));
    assert.equal(tabs().length, 1, String(tabs().length));
    ui.closeMenu();
  });

  // ---- 正文区菜单
  test('正文区菜单含剪切/复制/粘贴/全选', () => {
    area = ui.doc.getElementById('edArea');
    areaMenu = ui.rightClick(area);
    assert.ok(['剪切', '复制', '粘贴', '全选'].every((l) => ui.itemsOf(areaMenu).includes(l)),
      JSON.stringify(ui.itemsOf(areaMenu)));
  });

  test('无选中时剪切/复制置灰', () => {
    assert.ok(btn(areaMenu, '剪切').disabled && btn(areaMenu, '复制').disabled);
    ui.closeMenu();
  });

  test('全选选中全文', () => {
    ui.clickEl(btn(ui.rightClick(area), '全选'));
    assert.equal(area.selectionStart, 0, `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
    assert.equal(area.selectionEnd, area.value.length,
      `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
    ui.closeMenu();
  });

  // ---- 标签搬家：未保存草稿原样带走
  test('搬家后请求打开新路径', () => {
    area.value = '甲的内容，改了一半';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-files-moved', { detail: { from: 'a.md', to: 'sub/a.md' } }));
    const reopen = [...ui.sent].reverse().find((m) => m.type === 'openEditor' && m.path === 'sub/a.md');
    assert.ok(reopen, JSON.stringify(reopen));
    assert.equal(reopen.pane, 'main', JSON.stringify(reopen));
  });

  // hash 变了也没关系：moved 标记豁免基线检查。
  test('搬家后只剩一个标签且是新路径', () => {
    ui.post({ type: 'editorOpen', file: Object.assign(file('sub/a.md', '甲的内容'), { hash: 'h-other' }) });
    assert.equal(tabs().length, 1, tabs().map((t) => t.textContent).join(','));
    assert.ok(tabs()[0].textContent.includes('a'), tabs().map((t) => t.textContent).join(','));
  });

  test('未保存草稿跟着搬', () => {
    assert.equal(ui.doc.getElementById('edArea').value, '甲的内容，改了一半',
      ui.doc.getElementById('edArea').value);
  });

  test('草稿仍是脏标记', () => {
    assert.ok(tabs()[0].classList.contains('dirty'));
  });
});
