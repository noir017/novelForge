/**
 * 空窗口 Get Started：#nfWelcome、no-workspace、Recent、关闭文件夹。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('独立版空窗口欢迎页', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({
      body: 'standalone',
      empty: true,
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView'],
    });
  });

  test('页面有 Get Started 节点', () => {
    assert.ok(ui.doc.getElementById('nfWelcome'));
    assert.ok(ui.doc.body.classList.contains('no-workspace'));
  });

  test('无工程时输入框禁用', () => {
    assert.equal(ui.doc.getElementById('input').disabled, true);
  });

  // W12：侧栏每一页的遮罩上都看得见下一步，不必先找到欢迎页。
  test('侧栏遮罩上有「打开文件夹…」，与欢迎页那颗同一个动作', () => {
    for (const id of ['pane-chat', 'pane-project', 'pane-files', 'pane-history']) {
      const btn = ui.doc.querySelector(`#${id} .ws-empty button`);
      assert.ok(btn && btn.textContent === '打开文件夹…', id);
    }
    let intent;
    const onPick = (e) => {
      intent = e.detail.intent;
      e.preventDefault();
    };
    ui.window.addEventListener('nf-pick-folder', onPick);
    ui.clickEl(ui.doc.querySelector('#pane-chat .ws-empty button'));
    ui.window.removeEventListener('nf-pick-folder', onPick);
    assert.equal(intent, 'open');
  });

  test('workspaces 带 recents 时画出 Recent', () => {
    ui.post({
      type: 'workspaces',
      currentId: null,
      items: [],
      recents: [{ root: '/tmp/my-book', name: 'my-book' }],
    });
    const list = ui.doc.getElementById('nfRecentList');
    assert.ok(list.textContent.includes('my-book'));
    assert.ok(list.textContent.includes('/tmp/my-book'));
  });

  test('打开工程后去掉 no-workspace 并更新标题', () => {
    ui.post({
      type: 'workspaces',
      currentId: '/tmp/my-book',
      items: [{ id: '/tmp/my-book', root: '/tmp/my-book', name: 'my-book' }],
      recents: [{ root: '/tmp/my-book', name: 'my-book' }],
    });
    assert.equal(ui.doc.body.classList.contains('no-workspace'), false);
    assert.equal(ui.doc.getElementById('wbTitleText').textContent, '/tmp/my-book - Novel Forge');
    assert.equal(ui.doc.title, 'my-book - Novel Forge');
    assert.equal(ui.doc.getElementById('input').disabled, false);
  });

  test('点 Recent 发 openFolder', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('#nfRecentList button'));
    const msg = ui.last('openFolder');
    assert.ok(msg);
    assert.equal(msg.path, '/tmp/my-book');
    assert.equal(msg.mode, 'replace');
  });
});
