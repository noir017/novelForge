/**
 * 独立版「文件」页（资源管理器）：懒加载目录树、打开文件的分流、
 * 截断与读失败的降级，以及剪贴板与右键菜单。
 *
 * 迁自 scripts/smoke-view.js 的这两节：
 *   == 资源管理器（独立版「文件」页）==（1640） == 文件页：剪贴板与右键菜单 ==（2379）
 *
 * explorer.js 只在有 `#filesBody` 时才跑，所以必须用 html.ts 的 body；
 * view.js 也一起装上——右键菜单引擎在那边，`window.__nfContextMenu`
 * 是两个文件之间的唯一接口，测试要覆盖到它真的被接上了。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, listing } = require('../../helpers/dom');

const EXPLORER = {
  body: 'standalone',
  scripts: ['view.js', 'editor.js', 'explorer.js'],
  shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
};

describe('资源管理器（独立版「文件」页）', { skip: JSDOM_SKIP }, () => {
  let ui;
  let expanded;
  let collapsed;
  let menu;

  before(() => {
    ui = mount(EXPLORER);
  });

  // 挂载即要一份工程根：切到「文件」页时树已经在了，不必等一次往返。
  test('挂载后请求工程根', () => {
    const first = ui.last('listDir');
    assert.ok(first, '没发出 listDir');
    assert.ok(first.dirs.includes(''), JSON.stringify(first));
  });

  // 这一条是这个功能存在的理由：工程页永远看不见 .novelforge。
  test('点开头的文件夹列得出来', () => {
    ui.post({
      type: 'dirListings',
      listings: [listing('', { '.novelforge': 'dir', chapters: 'dir', 'README.md': 'file' })],
    });
    assert.ok(ui.names().includes('.novelforge'), ui.names().join(','));
  });

  test('点开头的行压暗显示', () => {
    assert.ok(ui.rows().some((r) => r.textContent.includes('.novelforge') && r.classList.contains('fx-dotted')));
  });

  test('目录在文件之前', () => {
    assert.equal(ui.names().join(','), '.novelforge,chapters,README.md', ui.names().join(','));
  });

  // ---- 展开一个目录：懒加载，展开哪个才要哪个
  test('展开后请求那个目录', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('.novelforge')));
    expanded = ui.last('listDir');
    assert.ok(expanded, '没发出 listDir');
    assert.ok(expanded.dirs.includes('.novelforge'), JSON.stringify(expanded));
  });

  test('请求带的是全量展开集合', () => {
    assert.ok(expanded.dirs.includes(''), JSON.stringify(expanded));
  });

  test('还没回数据时显示载入中', () => {
    assert.ok(ui.names().some((n) => n === '载入中…'), ui.names().join(','));
  });

  test('子项挂在父目录下', () => {
    ui.post({
      type: 'dirListings',
      listings: [listing('.novelforge', { summaries: 'dir', 'project.json': 'file' })],
    });
    assert.equal(ui.names().join(','), '.novelforge,summaries,project.json,chapters,README.md',
      ui.names().join(','));
  });

  test('子项有缩进', () => {
    assert.notEqual(ui.rows()[1].style.paddingLeft, ui.rows()[0].style.paddingLeft,
      `${ui.rows()[0].style.paddingLeft} vs ${ui.rows()[1].style.paddingLeft}`);
  });

  // ---- 折叠：子目录一并收起，再展开时不该凭空还开着
  test('折叠后不再关注该目录', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('summaries')));
    ui.click(ui.rows().find((r) => r.textContent.includes('.novelforge')));
    collapsed = ui.last('listDir');
    assert.ok(collapsed, '没发出 listDir');
    assert.ok(!collapsed.dirs.includes('.novelforge'), JSON.stringify(collapsed));
  });

  test('子目录跟着一起收起', () => {
    assert.ok(!collapsed.dirs.includes('.novelforge/summaries'), JSON.stringify(collapsed));
  });

  // ---- 点文件：可编辑的进内置编辑器
  test('点文本文件发 openEditor', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('README.md')));
    assert.ok(ui.last('openEditor'), JSON.stringify(ui.sent));
    assert.equal(ui.last('openEditor').path, 'README.md', JSON.stringify(ui.sent));
  });

  // ---- 二进制文件：不撞一个必然失败的 openEditor，直接交系统程序
  test('点不可编辑的文件走 openExternal', () => {
    ui.post({
      type: 'dirListings',
      listings: [
        Object.assign(listing('', { '封面.png': 'file' }), {
          entries: [{ kind: 'file', name: '封面.png', relPath: '封面.png', editable: false, bytes: 9, modified: 0 }],
        }),
      ],
    });
    ui.sent.length = 0;
    ui.click(ui.rows()[0]);
    assert.ok(ui.last('openExternal'), JSON.stringify(ui.sent));
    assert.equal(ui.last('openExternal').path, '封面.png', JSON.stringify(ui.sent));
  });

  test('不可编辑的行置灰', () => {
    assert.ok(ui.rows()[0].classList.contains('fx-binary'));
  });

  // ---- 高亮跟着编辑器走（点章节、采纳写入也会开文件，不只这棵树）
  test('编辑器打开谁就高亮谁', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file', 'b.md': 'file' })] });
    ui.post({ type: 'editorOpen', file: { path: 'b.md', name: 'b.md', text: '', hash: 'h', bytes: 0 } });
    assert.ok(
      ui.rows().filter((r) => r.classList.contains('active')).map((r) => r.textContent.trim()).join(',').includes('b.md'),
      ui.names().join(','));
  });

  // ---- 不静默截断
  test('截断时如实告知', () => {
    ui.post({
      type: 'dirListings',
      listings: [Object.assign(listing('', { 'a.md': 'file' }), { truncated: 3000 })],
    });
    assert.ok(ui.names().some((n) => n.includes('未列出')), ui.names().join(','));
  });

  // ---- 读不动的目录降级成一行提示，不炸整页
  test('读失败显示原因', () => {
    ui.post({
      type: 'dirListings',
      listings: [{ relPath: '', entries: [], truncated: 0, error: '目录不存在（可能刚被删除或改名）' }],
    });
    assert.ok(ui.names().some((n) => n.includes('目录不存在')), ui.names().join(','));
  });

  test('读失败不抛异常把树清空', () => {
    assert.equal(ui.rows().length, 1, `${ui.rows().length}`);
  });

  // ---- 右键复用 view.js 的菜单引擎（另起一套会两层菜单一起弹）
  test('右键弹出菜单', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file' })] });
    ui.rows()[0].dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true }));
    menu = ui.doc.querySelector('.ctx-menu');
    assert.ok(menu);
  });

  test('菜单里有「打开」', () => {
    assert.ok(menu && [...menu.querySelectorAll('button')].some((b) => b.textContent === '打开'),
      menu && [...menu.querySelectorAll('button')].map((b) => b.textContent).join(','));
    ui.closeMenu();
  });
});

describe('文件页：剪贴板与右键菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  let written;
  let fileItems;
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  // render() 会整批重建行，每次操作后都要重新按名字找行。
  const fileRowOf = (name) => ui.rows().find((r) => r.textContent.includes(name));

  before(() => {
    ui = mount(EXPLORER);
    written = [];
    ui.window.navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
    ui.doc.getElementById('pane-files').classList.add('active');
    ui.post({ type: 'dirListings', listings: [listing('', { 子目录: 'dir', 'a.md': 'file' })] });
  });

  test('文件行菜单含剪切/复制/粘贴/重命名', () => {
    fileItems = ui.itemsOf(ui.rightClick(fileRowOf('a.md')));
    assert.ok(['剪切', '复制', '粘贴', '重命名'].every((l) => fileItems.includes(l)), JSON.stringify(fileItems));
  });

  test('没有剪贴板时粘贴置灰', () => {
    assert.ok(btn(ui.rightClick(fileRowOf('a.md')), '粘贴').disabled);
    ui.closeMenu();
  });

  // 复制：内部登记 + 路径外送系统剪贴板。
  test('复制把路径写进系统剪贴板', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '复制'));
    assert.ok(written.includes('a.md'), JSON.stringify(written));
  });

  test('粘贴变为可用', () => {
    assert.ok(!btn(ui.rightClick(fileRowOf('a.md')), '粘贴').disabled);
    ui.closeMenu();
  });

  // 在文件夹行上粘贴：落点是该文件夹。
  test('粘贴发 fileAction', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('子目录')), '粘贴'));
    const pasteMsg = ui.last('fileAction');
    assert.ok(pasteMsg, '没发出 fileAction');
    assert.equal(pasteMsg.action, 'paste', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.op, 'copy', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.relPaths.join(','), 'a.md', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.targetDir, '子目录', JSON.stringify(pasteMsg));
  });

  // 复制态在粘贴后保留（可再粘）；重命名走 renameAny。
  test('复制态粘贴后保留', () => {
    assert.ok(!btn(ui.rightClick(fileRowOf('子目录')), '粘贴').disabled);
    ui.closeMenu();
  });

  test('重命名发 renameAny', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '重命名'));
    const ren = ui.last('fileAction');
    assert.ok(ren, '没发出 fileAction');
    assert.equal(ren.action, 'renameAny', JSON.stringify(ren));
    assert.equal(ren.relPath, 'a.md', JSON.stringify(ren));
  });

  // 剪切 + move 完成后清除剪切态。
  test('剪切后行带 fx-cut 标记', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '剪切'));
    assert.ok(ui.rows().some((r) => r.classList.contains('fx-cut')));
  });

  test('move 完成后剪切态清除', () => {
    ui.post({ type: 'filesOpDone', op: 'move', results: [{ from: 'a.md', to: '子目录/a.md', ok: true }] });
    assert.ok(btn(ui.rightClick(fileRowOf('子目录')), '粘贴').disabled);
    ui.closeMenu();
  });

  // 快捷键：焦点行上 Ctrl+C。
  test('Ctrl+C 复制焦点行', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'b.md': 'file' })] });
    const bRow = fileRowOf('b.md');
    bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    assert.ok(written.includes('b.md'), JSON.stringify(written));
  });
});
