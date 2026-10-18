/**
 * 临时标签（独立版内置编辑器，缺省开，「视图 → 单击打开为临时标签」可关）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 单击打开（`editorOpen` 带 `preview`） | 名字斜体；下一次单击打开别的文件**在原位置换掉它**，每块最多一个 |
 * | 编辑 / 保存 / 双击标签 / 「固定」 | 转正；之后单击打开的另开一个 |
 * | 被别的路子正常打开一次（落盘后自动打开、双击那一行） | 转正；单击打开一份已经固定的不把它降回临时 |
 * | 两块编辑区 | 各自最多一个 |
 * | 改过的标签 | 永远不会被换掉（一改就转正） |
 * | 开关关掉 | 现有的临时标签转正，之后单击打开的都是正常标签；再打开恢复 |
 * | 「视图」菜单 | 在「编辑」与「帮助」之间，第一项「单击打开为临时标签」，缺省打 ✓ |
 * | 文件页 / 工程页 | 单击发 `preview`，双击（第二下点击）不带——转正 |
 * | 刷新恢复 | 临时的那一个记着（⚑），刷新后还是临时的 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing, sampleTree } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];

const names = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.querySelector('.ed-tab-name').textContent);
const previews = (pane) => [...pane.querySelectorAll('.ed-tab.preview')].map((t) => t.querySelector('.ed-tab-name').textContent);
const openPreview = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的内容`), preview: true, ...extra });
const openNormal = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的内容`), ...extra });

describe('临时标签：复用与转正', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const area = () => ui.doc.getElementById('edArea');
  const tab = (name) => [...main().querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
    openNormal(ui, 'a.md');
    openPreview(ui, 'b.md');
  });

  test('单击打开的是临时标签：名字斜体那一格', () => {
    assert.deepEqual(previews(main()), ['b.md']);
  });

  test('悬停提示说它是临时的', () => {
    assert.match(tab('b.md').title, /临时标签/);
  });

  test('再单击打开别的文件：在原位置换掉它，标签数不变', () => {
    openNormal(ui, 'z.md');
    ui.clickEl(tab('b.md'));
    openPreview(ui, 'c.md');
    assert.deepEqual(names(main()), ['a.md', 'c.md', 'z.md']);
    assert.deepEqual(previews(main()), ['c.md']);
  });

  test('换掉的那一份进不了「最近关闭」', () => {
    const items = ui.itemsOf(ui.rightClick(tab('c.md')));
    assert.ok(items.includes('重新打开刚关闭的'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('在里面打字：转正', () => {
    area().value += '，改了一笔';
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('改过的标签不会被换掉：下一次单击打开另开一个', () => {
    openPreview(ui, 'd.md');
    assert.deepEqual(names(main()), ['a.md', 'c.md', 'z.md', 'd.md']);
    assert.ok(tab('c.md').classList.contains('dirty'));
    assert.deepEqual(previews(main()), ['d.md']);
  });

  test('双击标签（第二下点击）：转正', () => {
    tab('d.md').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail: 1 }));
    tab('d.md').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail: 2 }));
    assert.deepEqual(previews(main()), []);
  });

  test('dblclick 落在标签上也转正', () => {
    openPreview(ui, 'e.md');
    tab('e.md').dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('保存（Ctrl+S）：转正，哪怕没有可存的', () => {
    openPreview(ui, 'f.md');
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('被别的路子正常打开一次（落盘后自动打开、双击那一行）：转正', () => {
    openPreview(ui, 'g.md');
    openNormal(ui, 'g.md');
    assert.deepEqual(previews(main()), []);
  });

  test('单击打开一份已经固定的：不把它降回临时', () => {
    openPreview(ui, 'g.md');
    assert.deepEqual(previews(main()), []);
  });

  test('右键「固定」：只有临时标签有这一项，点了转正', () => {
    openPreview(ui, 'h.md');
    assert.ok(!ui.itemsOf(ui.rightClick(tab('a.md'))).includes('固定'));
    ui.closeMenu();
    const menu = ui.rightClick(tab('h.md'));
    ui.pick(menu, '固定');
    assert.deepEqual(previews(main()), []);
  });

  test('两块编辑区各自最多一个', () => {
    openPreview(ui, 'p1.md');
    openPreview(ui, 'q1.md', { pane: 'draft' });
    openPreview(ui, 'q2.md', { pane: 'draft' });
    assert.deepEqual([previews(main()), previews(ui.panes()[1])], [['p1.md'], ['q2.md']]);
    assert.deepEqual(names(ui.panes()[1]), ['q2.md']);
  });
});

describe('临时标签：「视图」菜单的开关', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const viewMenu = () => {
    ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
    return ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (drop) => [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('单击打开为临时标签'));
  const closeBar = () => ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
    openPreview(ui, 'a.md');
  });

  test('「视图」第一项是「单击打开为临时标签」，缺省打 ✓', () => {
    const drop = viewMenu();
    const first = drop.querySelector('.wb-menu-item');
    assert.match(first.textContent, /单击打开为临时标签/);
    assert.equal(first.getAttribute('aria-checked'), 'true');
    assert.equal(first.querySelector('.wb-menu-check').textContent, '✓');
    closeBar();
  });

  test('关掉：现有的临时标签转正，勾去掉', () => {
    ui.clickEl(item(viewMenu()));
    assert.deepEqual(previews(main()), []);
    assert.equal(item(viewMenu()).getAttribute('aria-checked'), 'false');
    closeBar();
  });

  test('关着时单击打开的都是正常标签，不换掉别的', () => {
    openPreview(ui, 'b.md');
    openPreview(ui, 'c.md');
    assert.deepEqual(names(main()), ['a.md', 'b.md', 'c.md']);
    assert.deepEqual(previews(main()), []);
  });

  test('再打开：又打 ✓，单击打开的又是临时标签', () => {
    ui.clickEl(item(viewMenu()));
    assert.equal(item(viewMenu()).getAttribute('aria-checked'), 'true');
    closeBar();
    openPreview(ui, 'd.md');
    assert.deepEqual(previews(main()), ['d.md']);
  });
});

describe('临时标签：文件页与工程页的单击 / 双击', { skip: JSDOM_SKIP }, () => {
  let ui;
  const row = (name) => ui.rows().find((r) => r.querySelector('.fx-name')?.textContent === name);
  const click = (node, detail) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js', 'explorer.js'], shims: SHIMS });
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file' })] });
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('文件页单击一行：openEditor 带 preview', () => {
    click(row('a.md'), 1);
    assert.equal(ui.last('openEditor').preview, true);
  });

  test('文件页双击（第二下点击）：不带 preview', () => {
    click(row('a.md'), 2);
    const msg = ui.last('openEditor');
    assert.equal(msg.path, 'a.md');
    assert.equal('preview' in msg, false);
  });

  test('工程页单击章节名：openChapter 带 preview，双击不带', () => {
    const label = [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-label')]
      .find((l) => l.textContent.includes('夜访'));
    click(label, 1);
    assert.equal(ui.last('openChapter').preview, true);
    click(label, 2);
    assert.equal('preview' in ui.last('openChapter'), false);
  });

  test('工程页单击角色卡：openEditor 带 preview', () => {
    const label = [...ui.doc.querySelectorAll('#projectBody .row-label')].find((l) => l.textContent === '林昭');
    click(label, 1);
    const msg = ui.last('openEditor');
    assert.deepEqual({ path: msg.path, preview: msg.preview }, { path: '.novelforge/characters/林昭.md', preview: true });
  });
});

describe('临时标签：刷新恢复（⚑ 记着）', { skip: JSDOM_SKIP }, () => {
  test('存下来的快照里标着哪一个是临时的；刷新后它还是临时的', () => {
    const first = mount({ body: 'standalone', scripts: ['editor.js'], shims: SHIMS, storage: {} });
    openNormal(first, 'a.md');
    openPreview(first, 'b.md');
    const saved = first.window.localStorage.getItem('novelforge.editor.v1');
    const data = JSON.parse(saved);
    assert.deepEqual(data.panes.main.open.map((o) => [o.path, !!o.preview]), [['a.md', false], ['b.md', true]]);

    const second = mount({ body: 'standalone', scripts: ['editor.js'], shims: SHIMS, storage: { 'novelforge.editor.v1': saved } });
    const reopen = second.sent.filter((m) => m.type === 'openEditor');
    assert.deepEqual(reopen.map((m) => m.path), ['a.md', 'b.md']);
    // 打开请求上不带标记（只记在前端，不随广播出去）。
    assert.ok(reopen.every((m) => !('preview' in m)));
    openNormal(second, 'a.md');
    openNormal(second, 'b.md');
    assert.deepEqual(previews(second.panes()[0]), ['b.md']);
  });
});
