/**
 * 独立版标题栏 File / Edit / Help：结构、点开、悬停切隔壁。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('独立版标题栏菜单', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView'],
    });
  });

  test('有菜单栏和三个菜单按钮', () => {
    const bar = ui.doc.getElementById('wbMenubar');
    assert.ok(bar);
    const btns = [...bar.querySelectorAll('.wb-menu-btn')];
    assert.equal(btns.length, 3);
    assert.deepEqual(
      btns.map((b) => b.textContent),
      ['File', 'Edit', 'Help']
    );
  });

  test('标题栏带版本号', () => {
    const title = ui.doc.getElementById('wbTitle');
    assert.ok(title?.dataset.version);
  });

  test('点 File 打开下拉', () => {
    const file = ui.doc.querySelector('[data-menu="file"]');
    ui.clickEl(file);
    const drop = ui.doc.querySelector('.wb-menu-drop');
    assert.ok(drop);
    const labels = [...drop.querySelectorAll('.wb-menu-item')].map((b) => b.textContent);
    assert.ok(labels.some((t) => t.includes('打开文件夹')));
    assert.ok(labels.some((t) => t.includes('关闭文件夹')));
  });

  test('已打开时悬停 Help 切过去', () => {
    const help = ui.doc.querySelector('[data-menu="help"]');
    help.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    const drop = ui.doc.querySelector('.wb-menu-drop');
    assert.ok(drop);
    const labels = [...drop.querySelectorAll('.wb-menu-item')].map((b) => b.textContent);
    assert.ok(labels.some((t) => t.includes('欢迎')));
    assert.ok(labels.some((t) => t.includes('关于')));
  });
});
