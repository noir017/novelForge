/**
 * 历史版本面板（`media/src/editor/versions.ts`）与标题栏「文件 → 历史版本…」（`media/src/view/versionsMenu.ts`）。
 * 快照的列表、全文、对比结果都由后端推来（`versions` / `versionText` / `editorReplace`），这里按消息造。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 工具栏「历史」 | 插在「保存」前面；章节可用；不是创作产物 / 没打开工程 / 还不是小说工程时置灰并说为什么 |
 * | 「文件」菜单 | 「历史版本…」紧跟「另存为…」，置灰与否、原因同上；点了打开面板 |
 * | 列表 | 打开就发 `listVersions`；新的在前「3 分钟前 · 14:32」、字数、比当前多 / 少几个字；空的照实说什么时候会存 |
 * | 选中 | 发 `readVersion`、收到全文给预览，「恢复这一版」这才能点 |
 * | 恢复 | 编辑区换成快照：一步撤销、成为未保存、**不写盘**（不发 saveFile） |
 * | 对比 | 发 `compareVersion`（带编辑器当前内容），收到 `editorReplace`（不带 base）换进来，基线不变 |
 * | 现在存一版 | 发 `saveVersion`，提示里说清存的是磁盘上的那一份 |
 * | 跟着当前文件走 | 换了文件重拉列表；换到不存历史版本的文件照实说；后端说不存时也照实说 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';
const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');

/** 与面板上同一种说法（只用在「几分钟前」这档；跨了午夜就是「昨天」）。 */
function whenOf(time, now = Date.now()) {
  const d = new Date(time);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const minutes = Math.floor((now - time) / MIN);
  return sameDay
    ? `${minutes} 分钟前 · ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `昨天 · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'] });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  const area = () => ui.doc.getElementById('edArea');
  const drawer = () => ui.doc.querySelector('#wbEditor .ed-versions');
  const h = {
    ui,
    toasts,
    area,
    drawer,
    btn: () => ui.doc.querySelector('#edToolbar .ed-versions-btn'),
    rows: () => [...drawer().querySelectorAll('.ed-version')],
    open(path, text, extra = {}) {
      ui.post({ type: 'editorOpen', file: file(path, text, { kind: 'chapter', ...extra }) });
    },
    type(text) {
      area().value = text;
      area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    },
    key(key) {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
    },
    /** 打开「文件」菜单，按标签找一项。 */
    fileItem(label) {
      ui.closeMenu();
      ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
      return [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
        (b) => b.querySelector('.wb-menu-label').textContent === label
      );
    },
    fileLabels() {
      ui.closeMenu();
      ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
      const labels = [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item .wb-menu-label')].map((n) => n.textContent);
      ui.closeMenu();
      return labels;
    },
  };
  return h;
}

describe('「历史」按钮与「文件 → 历史版本…」', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('没开文件：菜单项置灰，提示说没有打开的文件', () => {
    const item = h.fileItem('历史版本…');
    assert.ok(item, '「文件」菜单里没有「历史版本…」');
    assert.equal(item.disabled, true);
    assert.match(item.title, /没有打开的文件/);
    h.ui.closeMenu();
  });

  test('「历史版本…」紧跟在「另存为…」后面', () => {
    const labels = h.fileLabels();
    assert.equal(labels[labels.indexOf('另存为…') + 1], '历史版本…');
  });

  test('章节：工具栏「历史」插在「保存」前面、可以点', () => {
    h.open(PATH, '他推开门。');
    assert.ok(h.btn());
    assert.equal(h.btn().nextElementSibling.id, 'edSaveBtn');
    assert.equal(h.btn().disabled, false);
    assert.equal(h.fileItem('历史版本…').disabled, false);
    h.ui.closeMenu();
  });

  test('不是创作产物（kind 是 other）：两处都置灰，说为什么', () => {
    h.open('笔记.md', '随手记', { kind: 'other' });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /不是工程里的创作产物/);
    const item = h.fileItem('历史版本…');
    assert.equal(item.disabled, true);
    assert.match(item.title, /不是工程里的创作产物/);
    h.ui.closeMenu();
  });

  test('没打开工程（后端没给 kind）：置灰', () => {
    h.ui.post({ type: 'editorOpen', file: file('杂项.md', '一') });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /没打开工程/);
  });

  test('还不是小说工程：置灰；变成工程之后放开', () => {
    h.open(PATH, '他推开门。');
    h.ui.post({ type: 'state', state: viewState({ initialized: false }) });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /还不是小说工程/);
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.btn().disabled, false);
  });

  test('点菜单项打开面板、发 listVersions', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.fileItem('历史版本…'));
    assert.ok(!h.drawer().classList.contains('hidden'));
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    assert.match(h.drawer().textContent, /载入中/);
  });
});

describe('历史版本面板', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 12, bytes: 40 },
    { id: 'a.txt', time: now - 30 * MIN, words: 3, bytes: 12 },
  ];

  before(() => {
    h = harness();
    h.open(PATH, '他推开门，雨下了三天。', { hash: 'h-base' });
  });

  test('点「历史」打开面板，编辑区让出右边那一截（同时看得见）', () => {
    h.ui.clickEl(h.btn());
    assert.ok(!h.drawer().classList.contains('hidden'));
    assert.ok(h.drawer().parentElement.classList.contains('ed-stage-versions'));
    assert.ok(!h.area().classList.contains('hidden'));
    assert.equal(h.ui.last('listVersions').path, PATH);
  });

  test('没有快照：照实说，并说明什么时候会存', () => {
    h.ui.post({ type: 'versions', path: PATH, entries: [] });
    assert.match(h.drawer().textContent, /还没有历史版本/);
    assert.match(h.drawer().textContent, /覆盖保存这份文件时/);
  });

  test('别的文件的列表不画到这里来', () => {
    h.ui.post({ type: 'versions', path: 'chapters/009-别处.md', entries });
    assert.equal(h.rows().length, 0);
  });

  test('列表：新的在前，「3 分钟前 · 14:32」、字数、比当前多 / 少几个字', () => {
    h.ui.post({ type: 'versions', path: PATH, entries });
    const rows = h.rows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('.ed-version-when').textContent, whenOf(entries[0].time, now));
    // 编辑区里当前 9 个字（countWords 只数汉字，标点不算）。
    assert.match(rows[0].querySelector('.ed-version-meta').textContent, /^12 字 · 比当前多 3 字/);
    assert.match(rows[1].querySelector('.ed-version-meta').textContent, /^3 字 · 比当前少 6 字/);
  });

  test('打字之后「比当前」跟着变', async () => {
    h.type('他推开门，雨下了三天三夜。');
    await new Promise((r) => setTimeout(r, 350));
    assert.match(h.rows()[0].querySelector('.ed-version-meta').textContent, /比当前多 1 字/);
  });

  test('选中一个：发 readVersion；全文没到之前「恢复这一版」点不了', () => {
    h.ui.clickEl(h.rows()[1].querySelector('.ed-version-pick'));
    const req = h.ui.last('readVersion');
    assert.equal(req.path, PATH);
    assert.equal(req.id, 'a.txt');
    assert.ok(req.requestId);
    const row = h.rows()[1];
    assert.ok(row.classList.contains('selected'));
    assert.equal(row.querySelector('.ed-version-restore').disabled, true);
  });

  test('全文到了：给预览，「恢复这一版」可以点', () => {
    const req = h.ui.last('readVersion');
    h.ui.post({ type: 'versionText', requestId: req.requestId, path: PATH, id: 'a.txt', text: '旧的那一版。' });
    const row = h.rows()[1];
    assert.equal(row.querySelector('.ed-version-preview').textContent, '旧的那一版。');
    assert.equal(row.querySelector('.ed-version-restore').disabled, false);
  });

  test('恢复这一版：编辑区换成快照、成为未保存、不写盘', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.rows()[1].querySelector('.ed-version-restore'));
    assert.equal(h.area().value, '旧的那一版。');
    assert.ok(h.ui.doc.querySelector('#edTabs .ed-tab').classList.contains('dirty'));
    assert.equal(h.ui.last('saveFile'), undefined, '恢复不该写盘');
    assert.match(h.toasts.at(-1), /还没保存/);
  });

  test('一步撤销退回恢复之前', () => {
    h.key('z');
    assert.equal(h.area().value, '他推开门，雨下了三天三夜。');
  });

  test('对比…：发 compareVersion，带编辑器当前的内容', () => {
    h.ui.clickEl(h.rows()[1].querySelector('.ed-version-compare'));
    const req = h.ui.last('compareVersion');
    assert.equal(req.path, PATH);
    assert.equal(req.id, 'a.txt');
    assert.equal(req.text, '他推开门，雨下了三天三夜。');
    assert.ok(req.requestId);
  });

  test('采纳之后的 editorReplace（不带 base）：换进编辑区，基线不变', () => {
    const req = h.ui.last('compareVersion');
    h.ui.post({ type: 'editorReplace', requestId: req.requestId, path: PATH, text: '挑过的那一份。' });
    assert.equal(h.area().value, '挑过的那一份。');
    h.key('s');
    const save = h.ui.last('saveFile');
    assert.equal(save.text, '挑过的那一份。');
    assert.equal(save.baseHash, 'h-base');
  });

  test('保存回执到了（hash 变了）：重拉一次列表', () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, '挑过的那一份。', { kind: 'chapter', hash: 'h-saved' }) });
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
  });

  test('连着几次保存回执（自动保存那样）：一秒之内只重拉一次，最后那次挪到一秒之后', async () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, '挑过的那一份。', { kind: 'chapter', hash: 'h-saved-2' }) });
    h.ui.post({ type: 'editorSaved', file: file(PATH, '挑过的那一份。', { kind: 'chapter', hash: 'h-saved-3' }) });
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 0, '上一次刚拉过，先攒着');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 1);
  });

  test('现在存一版：发 saveVersion，按钮上说清存的是磁盘上的那一份', () => {
    const save = h.drawer().querySelector('.ed-versions-save');
    assert.match(save.title, /磁盘上当前这一份/);
    assert.match(save.title, /没保存的修改不算/);
    h.ui.clickEl(save);
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH });
  });

  test('换到另一份文件：重拉那一份的列表', () => {
    h.ui.sent.length = 0;
    h.open('chapters/002-风起.md', '风起了。');
    assert.equal(h.ui.last('listVersions').path, 'chapters/002-风起.md');
    assert.equal(h.rows().length, 0);
  });

  test('换到不存历史版本的文件：照实说，不发请求', () => {
    h.ui.sent.length = 0;
    h.open('笔记.md', '随手记', { kind: 'other' });
    assert.equal(h.ui.last('listVersions'), undefined);
    assert.match(h.drawer().textContent, /不是工程里的创作产物/);
    assert.ok(h.drawer().querySelector('.ed-versions-save').classList.contains('hidden'));
  });

  test('后端说不存（unavailable）：照实说', () => {
    h.open('chapters/003-夜雨.md', '夜雨。');
    h.ui.post({ type: 'versions', path: 'chapters/003-夜雨.md', entries: [], unavailable: '这个目录还不是小说工程（没有 .novelforge/），不存历史版本。' });
    assert.match(h.drawer().textContent, /还不是小说工程/);
  });

  test('关掉：× 收起抽屉，编辑区收回宽度', () => {
    h.ui.clickEl(h.drawer().querySelector('.ed-versions-close'));
    assert.ok(h.drawer().classList.contains('hidden'));
    assert.ok(!h.drawer().parentElement.classList.contains('ed-stage-versions'));
  });
});

describe('草稿区也有自己的「历史」', { skip: JSDOM_SKIP }, () => {
  test('按钮在那一块的「保存」前面，面板开在那一块里', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿。', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const btn = draft.querySelector('.ed-versions-btn');
    assert.ok(btn);
    assert.ok(btn.nextElementSibling.classList.contains('primary'));
    h.ui.clickEl(btn);
    assert.ok(draft.querySelector('.ed-versions:not(.hidden)'));
    assert.equal(h.ui.last('listVersions').path, 'drafts/001-雨夜.md');
  });
});
