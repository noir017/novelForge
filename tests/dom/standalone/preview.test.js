/**
 * Markdown 预览（`media/src/editor/pane.ts` 的 `setPreviewing`，滚动对应在 `previewSync.ts`，切块与换算在
 * `previewCore.ts`——纯函数那一半在 tests/unit/editor/previewCore.test.js）。
 *
 * jsdom 没有排版：编辑区用 `mirrorLayout`（量位置那一份镜像里第 k 行的顶 = 18 + 30k，视口 300），预览用 `previewLayout`
 * （带 `data-line` 的一块，顶 = 第几行 × 40、高 = 占几行 × 40），只验「按行号找到哪一处、滚到了哪」，不验像素。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 按标签记 | 每个标签各自记着在预览还是在编辑：切走再切回来照旧（预览的滚动也照旧）；状态栏写「预览」、按钮写「编辑」；
 *   从另一块搬过来、刷新恢复也照旧（⚑） |
 * | Ctrl+Shift+V | 正文里、预览里、页面上都切；对话输入框里不拦；不是 Markdown 的文件不拦（照常是粘贴）；按钮提示写着键 |
 * | 滚动对应 | 编辑 → 预览：编辑区视口顶上那一行（带小数）在预览里对应的那一处停在顶上；预览 → 编辑反过来；光标不在视口里就挪到
 *   视口顶上那一行的行首（⚑），在的话不动 |
 * | 重画不弹回顶上 | 预览开着时磁盘上的新版进来、保存回执，预览的滚动位置留着 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, PREVIEW_LAYOUT, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const A = '.novelforge/characters/林昭.md';
const B = '.novelforge/characters/沈青.md';
/** 行：0 标题，2 一段，4–5 一段（两行），7–8 列表两项。 */
const TEXT = '# 林昭\n\n青云宗外门弟子。\n\n性子急，\n话不多。\n\n- 剑\n- 玉佩\n';
const LINES = TEXT.split('\n').length;
const { line: LH } = MIRROR_LAYOUT;
const { line: PH } = PREVIEW_LAYOUT;

function harness(opts = {}) {
  const { shims = [], ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: [...SHIMS, ...shims], ...rest });
  ui.window.__nfToast = () => {};
  const doc = ui.doc;
  const h = {
    ui,
    doc,
    area: () => doc.getElementById('edArea'),
    preview: () => doc.getElementById('edPreview'),
    btn: () => doc.getElementById('edPreviewBtn'),
    previewing: () => !doc.getElementById('edPreview').classList.contains('hidden'),
    open: (p, text = TEXT, extra) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'character', ...extra }) }),
    tab: (p) => [...doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
    key(target, init) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    toggleKey: (target) => h.key(target, { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
  };
  return h;
}

describe('预览：每个标签各自记着', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.open(B);
  });

  test('B 切到预览：按钮写「编辑」、状态栏写「预览」、textarea 藏起来', () => {
    h.ui.clickEl(h.btn());
    assert.equal(h.previewing(), true);
    assert.equal(h.area().classList.contains('hidden'), true);
    assert.equal(h.btn().textContent, '编辑');
    assert.equal(h.doc.getElementById('edStatusPos').textContent, '预览');
  });

  test('切到 A：A 还在编辑；再切回 B：B 照旧在预览里', () => {
    h.ui.clickEl(h.tab(A));
    assert.equal(h.previewing(), false);
    assert.equal(h.btn().textContent, '预览');
    h.ui.clickEl(h.tab(B));
    assert.equal(h.previewing(), true);
    assert.equal(h.btn().textContent, '编辑');
  });

  test('预览的滚动位置也按标签记：B 滚到 120，切走再切回来还是 120', () => {
    h.preview().scrollTop = 120;
    h.preview().dispatchEvent(new h.ui.window.Event('scroll'));
    h.ui.clickEl(h.tab(A));
    h.area().scrollTop = 0;
    h.ui.clickEl(h.tab(B));
    assert.equal(h.preview().scrollTop, 120);
  });

  test('切回来的是预览时焦点进预览（方向键、翻页键滚的是它）', () => {
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(B));
    assert.equal(h.doc.activeElement, h.preview());
  });

  test('已经开着的再被打开一次（工程页再点一下）：照旧在预览里', () => {
    h.open(B);
    assert.equal(h.previewing(), true);
  });

  test('从另一块搬过来（同一个路径在右边打开）：照旧在预览里', () => {
    h.ui.post({ type: 'editorOpen', file: file(B, TEXT, { kind: 'character' }), pane: 'draft' });
    const draft = h.doc.querySelector('.wb-editor-draft');
    assert.equal(draft.querySelector('.ed-preview').classList.contains('hidden'), false);
    assert.equal(draft.querySelector('textarea.ed-area').classList.contains('hidden'), true);
  });

  test('按钮提示写着快捷键', () => {
    assert.match(h.btn().title, /Ctrl\+Shift\+V/);
  });
});

describe('预览：Ctrl+Shift+V', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
  });

  test('正文里按：切到预览、拦下（不当粘贴）、焦点进预览', () => {
    h.area().focus();
    const ev = h.toggleKey(h.area());
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.previewing(), true);
    assert.equal(h.doc.activeElement, h.preview());
  });

  test('预览里再按：切回编辑、焦点回正文', () => {
    h.toggleKey(h.preview());
    assert.equal(h.previewing(), false);
    assert.equal(h.doc.activeElement, h.area());
  });

  test('页面上（焦点不在输入框里）也切', () => {
    h.doc.activeElement.blur();
    h.toggleKey(h.doc.body);
    assert.equal(h.previewing(), true);
    h.toggleKey(h.doc.body);
    assert.equal(h.previewing(), false);
  });

  test('对话输入框里不拦（那里是粘贴为纯文本）', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    const ev = h.toggleKey(chat);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });

  test('不是 Markdown 的文件（.txt 章节）：按钮藏着，这个键不拦', () => {
    h.open('chapters/001-雨夜.txt', '雨下了三天。', { kind: 'chapter' });
    assert.equal(h.btn().classList.contains('hidden'), true);
    h.area().focus();
    const ev = h.toggleKey(h.area());
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });

  test('输入法组字中途不算', () => {
    h.ui.clickEl(h.tab(A));
    const ev = h.key(h.area(), { key: 'V', ctrlKey: true, shiftKey: true, isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });
});

describe('预览：切换时两边滚到同一处', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ shims: ['mirrorLayout', 'previewLayout'] });
    h.open(A);
  });

  test('预览里每一块都记着行号：标题、两段、两个列表项', () => {
    h.ui.clickEl(h.btn());
    const marks = [...h.preview().querySelectorAll('[data-line]')].map((n) => `${n.tagName}:${n.dataset.line}-${n.dataset.lineEnd}`);
    assert.deepEqual(marks, ['H1:0-1', 'P:2-3', 'P:4-6', 'LI:7-8', 'LI:8-9']);
    h.ui.clickEl(h.btn());
  });

  test('编辑 → 预览：编辑区顶上是第 4 行往下一半（4.5），预览里滚到那一段（4–5 行）的四分之一处', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    h.area().scrollTop = 4 * LH + LH / 2;
    h.toggleKey(h.area());
    // 那一段：顶 = 4 × 40、高 = 2 × 40；4.5 行在它的 (4.5 − 4) / 2 处。
    assert.equal(h.preview().scrollTop, 4 * PH + ((4.5 - 4) / 2) * 2 * PH);
  });

  test('预览 → 编辑：预览滚到第 7 行那一项的一半（7.5），编辑区滚到 7.5 行', () => {
    h.preview().scrollTop = 7 * PH + PH / 2;
    h.toggleKey(h.preview());
    assert.equal(h.area().scrollTop, 7.5 * LH);
  });

  test('光标原来在第 0 行、滚完不在视口里了：挪到视口顶上那一行（第 8 行）的行首', () => {
    const starts = [0];
    for (let i = 0; i < TEXT.length; i++) if (TEXT[i] === '\n') starts.push(i + 1);
    assert.equal(h.area().selectionStart, starts[8]);
  });

  test('光标在视口里：切过去再切回来不动它', () => {
    h.area().scrollTop = 0;
    h.area().setSelectionRange(5, 5);
    h.area().dispatchEvent(new h.ui.window.Event('select'));
    h.toggleKey(h.area());
    h.toggleKey(h.preview());
    assert.equal(h.area().selectionStart, 5);
    assert.equal(h.area().scrollTop, 0);
  });

  test('预览开着时磁盘上的新版进来：预览重画，滚动位置留着', () => {
    h.toggleKey(h.area());
    h.preview().scrollTop = 200;
    h.ui.post({ type: 'editorDiskChanged', file: file(A, `${TEXT}\n新加的一行\n`, { kind: 'character', hash: 'h2' }) });
    assert.match(h.preview().textContent, /新加的一行/);
    assert.equal(h.preview().scrollTop, 200);
    h.toggleKey(h.preview());
  });

  test('行数对得上：预览里最后一块的行号在文字的行数之内', () => {
    h.toggleKey(h.area());
    const last = [...h.preview().querySelectorAll('[data-line]')].pop();
    assert.ok(Number(last.dataset.lineEnd) <= h.area().value.split('\n').length);
    assert.ok(LINES > 0);
    h.toggleKey(h.preview());
  });
});

describe('预览：刷新恢复时记着（⚑）', { skip: JSDOM_SKIP }, () => {
  const URL = `http://localhost/?project=${encodeURIComponent('/书/青云剑录')}`;
  const KEY = `novelforge.editor.v1@${'/书/青云剑录'}`;

  test('在预览里的那一份记进快照；刷新后那一份打开时照旧在预览里，别的在编辑', () => {
    const h = harness({ url: URL });
    h.open(A);
    h.open(B);
    h.ui.clickEl(h.btn());
    const saved = JSON.parse(h.ui.window.localStorage.getItem(KEY));
    const open = saved.panes.main.open;
    assert.deepEqual(
      open.map((f) => [f.path, f.markdownPreview === true]),
      [
        [A, false],
        [B, true],
      ]
    );

    const again = harness({ url: URL, storage: { [KEY]: JSON.stringify(saved) } });
    assert.deepEqual(
      again.ui.sent.filter((m) => m.type === 'openEditor').map((m) => [m.path, 'markdownPreview' in m]),
      [
        [A, false],
        [B, false],
      ],
      '标记只记在前端，不随打开请求发出去'
    );
    again.open(A);
    again.open(B);
    assert.equal(again.previewing(), true, '刷新前在预览里的 B');
    again.ui.clickEl(again.tab(A));
    assert.equal(again.previewing(), false);
  });
});
