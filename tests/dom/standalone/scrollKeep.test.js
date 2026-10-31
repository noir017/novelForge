/**
 * 切换文件时光标与滚动各记各的（独立版内置编辑器，`media/src/editor/pane.ts` 的 `renderAll` / `stashView` / `restoreView`，
 * 关掉之后的那一份在 `store.ts` 的 `rememberView` / `takeView`）。
 *
 * jsdom 没有排版：`scrollTop` 写什么读回什么，滚动事件不会自己来——这里直接写 textarea 的 `scrollTop` 当「滚到了这里」。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 新开一份 | 从顶上开始，不沿用上一份的滚动偏移 |
 * | 从别处再打开一份开着的（工程页、文件页、「转到…」） | 回到它自己的光标与滚动；切走的那一份的也留住，点标签回去还在 |
 * | 临时标签被换掉、再单击打开 | 回到换掉时的位置 |
 * | 关掉再打开 | 回到关掉时的位置；只放回一次（之后由开着的那一份自己记） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const TEXT = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段。`).join('\n\n');
const A = 'chapters/001-楔子.md';
const B = 'chapters/002-客栈.md';
const C = 'chapters/003-夜访.md';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
  ui.window.__nfToast = () => {};
  const doc = ui.doc;
  const h = {
    ui,
    area: () => doc.getElementById('edArea'),
    open: (p, extra) => ui.post({ type: 'editorOpen', file: file(p, TEXT, { kind: 'chapter' }), ...extra }),
    tab: (p) => [...doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
    /** 滚到 `top`、光标放在 `caret`（作者在这一份里看到这儿、点在这儿）。 */
    at(top, caret) {
      h.area().setSelectionRange(caret, caret);
      h.area().scrollTop = top;
    },
    where: () => ({ top: h.area().scrollTop, caret: h.area().selectionStart }),
  };
  return h;
}

describe('切换文件：光标与滚动各记各的', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.at(300, 120);
  });

  test('新开一份：从顶上开始，不沿用上一份的偏移', () => {
    h.open(B);
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.at(900, 400);
  });

  test('从别处再打开一份开着的：回到它自己的位置', () => {
    h.open(A);
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });

  test('切走的那一份也留住了：点标签回去还在', () => {
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(h.where(), { top: 900, caret: 400 });
    h.ui.clickEl(h.tab(A));
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });
});

describe('关掉 / 换掉之后再打开：回到原处', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('临时标签被换掉、再单击打开：回到换掉时的位置', () => {
    h.open(A, { preview: true });
    h.at(450, 200);
    h.open(B, { preview: true });
    assert.equal(h.tab(A), undefined, '临时标签被换掉了');
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.open(A, { preview: true });
    assert.deepEqual(h.where(), { top: 450, caret: 200 });
  });

  test('关掉再打开：回到关掉时的位置', () => {
    h.open(C);
    h.at(600, 300);
    h.ui.clickEl(h.tab(C).querySelector('.ed-tab-close'));
    assert.equal(h.tab(C), undefined, '关掉了');
    h.open(C);
    assert.deepEqual(h.where(), { top: 600, caret: 300 });
  });

  test('只放回一次：开着时由它自己记，换个位置再切回来是新的位置', () => {
    h.at(60, 10);
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(C));
    assert.deepEqual(h.where(), { top: 60, caret: 10 });
  });
});
