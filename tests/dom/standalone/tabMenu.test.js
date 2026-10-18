/**
 * 标签右键菜单里关闭类之后的那几项（独立版内置编辑器，`editor/tabMenu.ts`）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 菜单项 | 关闭类之后依次是「移到另一侧」「在文件页中定位」「复制相对路径」「重新打开刚关闭的」；「固定」只有临时标签有 |
 * | 移到另一侧 | 连同未保存内容与撤销历史搬过去（Ctrl+Z 在那边退得回去），不经后端（不发 openEditor），原来那块不再有它；保存的基线不变 |
 * | 一个路径只属于一块 | 搬过去之后保存回执、磁盘核对都落在新的那一块 |
 * | 冲突条跟着走 | 搬之前挂着的冲突条搬过去还挂着 |
 * | 搬回来 | 右边空了就整块收起 |
 * | 在文件页中定位 | 切到「文件」页、展开到它、那一行标出来 |
 * | 复制相对路径 | 写进剪贴板 |
 * | 重新打开刚关闭的 | 按块记：右边关掉的只在右边的菜单里，点了按原来那一块重新打开；没有时置灰 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');

describe('标签右键：移到另一侧', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const right = () => ui.panes()[1];
  const tabIn = (pane, name) => [...pane.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
  const areaOf = (pane) => pane.querySelector('textarea');
  /** 粘贴进来一段（粘贴各自一步撤销，不与前后并）。 */
  const type = (area, text) => {
    area.focus();
    area.value = text;
    area.selectionStart = area.selectionEnd = text.length;
    area.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  };
  const menuOf = (tab) => ui.rightClick(tab);
  const itemStartingWith = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith(prefix));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '原文') });
    ui.post({ type: 'editorOpen', file: file('notes.md', '笔记') });
    ui.clickEl(tabIn(main(), '001-楔子'));
    type(areaOf(main()), '原文，改了一笔');
    type(areaOf(main()), '原文，改了一笔，又一笔');
  });

  test('关闭类之后依次是移到另一侧、定位、复制路径、重新打开', () => {
    const items = ui.itemsOf(menuOf(tabIn(main(), '001-楔子')));
    const at = (prefix) => items.findIndex((l) => l.startsWith(prefix));
    assert.ok(at('关闭其它') >= 0, JSON.stringify(items));
    assert.ok(at('关闭其它') < at('移到另一侧'), JSON.stringify(items));
    assert.ok(at('移到另一侧') < at('在文件页中定位'), JSON.stringify(items));
    assert.ok(at('在文件页中定位') < at('复制相对路径'), JSON.stringify(items));
    assert.ok(at('复制相对路径') < at('重新打开刚关闭的'), JSON.stringify(items));
    assert.equal(items[at('移到另一侧')], '移到另一侧（右侧）');
    ui.closeMenu();
  });

  test('没关过东西：「重新打开刚关闭的」置灰', () => {
    const menu = menuOf(tabIn(main(), '001-楔子'));
    assert.equal(itemStartingWith(menu, '重新打开刚关闭的').disabled, true);
    ui.closeMenu();
  });

  test('移到另一侧：右边那一块出来，带着未保存的内容，不经后端', () => {
    ui.sent.length = 0;
    ui.clickEl(itemStartingWith(menuOf(tabIn(main(), '001-楔子')), '移到另一侧'));
    assert.equal(ui.panes().length, 2);
    assert.ok(!right().classList.contains('hidden'));
    assert.equal(areaOf(right()).value, '原文，改了一笔，又一笔');
    assert.ok(tabIn(right(), '001-楔子').classList.contains('dirty'));
    assert.equal(ui.sent.filter((m) => m.type === 'openEditor').length, 0);
  });

  test('原来那一块不再有它（一个路径只属于一块）', () => {
    assert.equal(tabIn(main(), '001-楔子'), undefined);
    assert.ok(tabIn(main(), 'notes.md'));
  });

  test('撤销历史跟着搬：在右边 Ctrl+Z 退回上一步', () => {
    const area = areaOf(right());
    area.focus();
    area.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(area.value, '原文，改了一笔');
  });

  test('保存带的还是原来的基线（不是强制保存）', () => {
    ui.sent.length = 0;
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    const save = ui.last('saveFile');
    assert.deepEqual({ path: save.path, baseHash: save.baseHash }, { path: 'chapters/001-楔子.md', baseHash: 'h-chapters/001-楔子.md' });
  });

  test('保存回执落在右边那一块', () => {
    ui.post({ type: 'editorSaved', file: file('chapters/001-楔子.md', '原文，改了一笔', { hash: 'h-saved' }) });
    assert.ok(!tabIn(right(), '001-楔子').classList.contains('dirty'));
  });

  test('搬回来：右边空了就整块收起', () => {
    ui.clickEl(itemStartingWith(menuOf(tabIn(right(), '001-楔子')), '移到另一侧'));
    assert.ok(tabIn(main(), '001-楔子'));
    assert.ok(right().classList.contains('hidden'));
    assert.ok(ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });
});

describe('标签右键：冲突条跟着搬', { skip: JSDOM_SKIP }, () => {
  test('改过的标签撞上磁盘新版，搬到右边冲突条还挂着', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    ui.post({ type: 'editorOpen', file: file('a.md', '原文') });
    const area = ui.doc.getElementById('edArea');
    area.value = '原文，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.post({ type: 'editorDiskChanged', file: file('a.md', '磁盘上的新版', { hash: 'h-disk' }) });
    const tab = ui.doc.querySelector('.ed-tab');
    assert.ok(tab.classList.contains('conflict'));
    const menu = ui.rightClick(tab);
    ui.clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith('移到另一侧')));
    const right = ui.panes()[1];
    assert.ok(right.querySelector('.ed-tab').classList.contains('conflict'));
    assert.ok(!right.querySelector('.ed-conflict').classList.contains('hidden'));
  });
});

describe('标签右键：定位、复制路径、重新打开', { skip: JSDOM_SKIP }, () => {
  let ui;
  const copied = [];
  const tabIn = (pane, name) => [...pane.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
  const item = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith(prefix));

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView'],
    });
    ui.window.navigator.clipboard = { writeText: (t) => (copied.push(t), Promise.resolve()) };
    ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜访.md', '正文') });
    ui.post({ type: 'editorOpen', file: file('notes.md', '笔记') });
    ui.post({ type: 'editorOpen', file: file('.novelforge/summaries/003-夜访.md', '细纲'), pane: 'draft' });
    ui.post({ type: 'editorOpen', file: file('drafts/003-夜访.md', '草稿'), pane: 'draft' });
  });

  test('在文件页中定位：切到「文件」页，展开到它所在的目录', () => {
    ui.sent.length = 0;
    ui.clickEl(item(ui.rightClick(tabIn(ui.panes()[0], '003-夜访')), '在文件页中定位'));
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'));
    const dirs = ui.last('listDir').dirs;
    assert.ok(dirs.includes('chapters') && dirs.includes('chapters/第一卷'), JSON.stringify(dirs));
    assert.ok(!dirs.includes('chapters/第一卷/003-夜访.md'), '把文件当成目录展开了');
  });

  test('目录列出来之后，那个文件的那一行标出来', () => {
    ui.post({ type: 'dirListings', listings: [
      listing('', { chapters: 'dir' }),
      listing('chapters', { 第一卷: 'dir' }),
      listing('chapters/第一卷', { '003-夜访.md': 'file' }),
    ] });
    const row = ui.doc.querySelector('#filesBody .fx-row.fx-revealed');
    assert.equal(row?.dataset.path, 'chapters/第一卷/003-夜访.md');
  });

  test('复制相对路径：写进剪贴板', () => {
    ui.clickEl(item(ui.rightClick(tabIn(ui.panes()[0], 'notes')), '复制相对路径'));
    assert.deepEqual(copied, ['notes.md']);
  });

  test('重新打开刚关闭的：按块记，带着名字', async () => {
    // 关掉右边的草稿（没改过，直接关）。
    ui.clickEl(ui.panes()[1].querySelector('.ed-tab[data-path="drafts/003-夜访.md"] .ed-tab-close'));
    await ui.flush();
    const leftItem = item(ui.rightClick(tabIn(ui.panes()[0], 'notes')), '重新打开刚关闭的');
    assert.equal(leftItem.disabled, true, '左边没关过东西');
    ui.closeMenu();
    const rightItem = item(ui.rightClick(tabIn(ui.panes()[1], '003-夜访')), '重新打开刚关闭的');
    assert.equal(rightItem.disabled, false);
    assert.match(rightItem.textContent, /003-夜访/);
    ui.sent.length = 0;
    ui.clickEl(rightItem);
    const msg = ui.last('openEditor');
    assert.deepEqual({ path: msg.path, pane: msg.pane }, { path: 'drafts/003-夜访.md', pane: 'draft' });
  });

  test('重新打开之后不再列着它', () => {
    ui.post({ type: 'editorOpen', file: file('drafts/003-夜访.md', '草稿'), pane: 'draft' });
    const rightItem = item(ui.rightClick(tabIn(ui.panes()[1], '003-夜访')), '重新打开刚关闭的');
    assert.equal(rightItem.disabled, true);
    ui.closeMenu();
  });
});
