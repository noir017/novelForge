/**
 * 远程风目录选择器：hostDir 列出名字、点目录再列举、确定发 openFolder。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('独立版目录选择器', { skip: JSDOM_SKIP }, () => {
  let ui;
  let prompted;

  before(() => {
    ui = mount({
      body: 'standalone',
      empty: true,
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView', 'confirm'],
    });
    prompted = false;
    ui.window.prompt = () => {
      prompted = true;
      return '';
    };
  });

  test('点打开文件夹出现选择器，不走 prompt', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="openFolder"]'));
    assert.equal(prompted, false);
    const picker = ui.doc.querySelector('.nf-picker');
    assert.ok(picker?.classList.contains('open'));
    const req = ui.last('listHostDir');
    assert.equal(req.path, '~');
  });

  test('hostDir 列出名字', () => {
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: 'note.txt', kind: 'file', absPath: '/home/me/note.txt' },
      ],
      truncated: 0,
    });
    const labels = [...ui.doc.querySelectorAll('.nf-picker-row')].map((r) => r.textContent);
    assert.ok(labels.some((t) => t.includes('..')));
    assert.ok(labels.some((t) => t.includes('books')));
    assert.ok(labels.some((t) => t.includes('note.txt')));
  });

  test('点目录发出新的 listHostDir', () => {
    ui.sent.length = 0;
    const row = [...ui.doc.querySelectorAll('.nf-picker-row')].find((r) =>
      r.textContent.includes('books')
    );
    ui.clickEl(row);
    const req = ui.last('listHostDir');
    assert.equal(req.path, '/home/me/books');
  });

  test('确定发出 openFolder 当前路径', () => {
    ui.post({
      type: 'hostDir',
      path: '/home/me/books',
      parent: '/home/me',
      entries: [],
      truncated: 0,
    });
    ui.sent.length = 0;
    const ok = [...ui.doc.querySelectorAll('.nf-picker-actions button')].find(
      (b) => b.textContent === '确定'
    );
    ui.clickEl(ok);
    const msg = ui.last('openFolder');
    assert.ok(msg);
    assert.equal(msg.path, '/home/me/books');
    assert.equal(msg.mode, 'replace');
  });
});
