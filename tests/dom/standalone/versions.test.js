/**
 * 侧栏「版本」页（`media/src/editor/versions.ts`）、编辑区里的对比标签（`media/src/editor/versionDiff.ts`）与标题栏
 * 「文件 → 历史版本…」（`media/src/view/versionsMenu.ts`）。列表、全文都由后端推来（`versions` / `versionText`），这里按消息造。
 * 比的口径（按行、逐字、用回一处换哪一截）在 tests/unit/editor/versionDiffCore.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 工具栏「历史」与「文件」菜单 | 插在「保存」前面；章节可用；不是创作产物 / 没打开工程 / 还不是小说工程时置灰并说为什么；点了切到「版本」页 |
 * | 活动栏 | 「版本」排在「文件」后面；藏着时不拉列表，切过来拉一次 |
 * | 列表 | 新的在前「3 分钟前 · 14:32」、字数、比现在多 / 少几个字；存档点 ◆ ◇ 带备注；空的照实说；别的文件的不画；没保存时最上面多一行 |
 * | 跟着当前文件走 | 换了文件重拉；不存历史版本的照实说；保存回执到了重拉（一秒最多一次）；对比标签显示着时留在那份文件上 |
 * | 点一行 | 发 `readVersion`，编辑区开「对比 · 名字」（只有一个，再点别的换掉内容）；全文到了画两栏：删的 `<del>`、加的 `<ins>`，没改的折起来；那一行标成选中 |
 * | 上一处 / 下一处 | 一开就停在第一处；到头了按钮置灰 |
 * | 用回这一处 | 编辑区那一处换回左边那样：一步撤销、成为未保存、**不写盘**；先发不说话的 `saveVersion`；对比标签留着、少一处 |
 * | 还没保存的改动 | 磁盘上的 ↔ 编辑器里的；用回一处 = 换回磁盘上那样 |
 * | 跟后一版比 | 两边都是存下的，只能看：没有「用回这一处」「恢复整份」 |
 * | 恢复整份 | 编辑区换成那一版、不写盘，停在那份文件上；开着自动保存时停笔 2 秒照常存，`saveVersion` 排在 `saveFile` 前面 |
 * | 刷新 | 对比标签不进刷新恢复 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';
const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');
const DISK = '他推开门。\n\n雨下了三天。\n\n灯还亮着。\n';
/** 2 小时前那一版：第二段不一样，末尾多一段。比起来两处改动。 */
const OLD = '他推开门。\n\n雨还没有停。\n\n灯还亮着。\n\n远处有人在喊。\n';
const tick = () => new Promise((r) => setImmediate(r));

/** 与侧栏上同一种说法（只用在「几分钟前」这档；跨了午夜就是「昨天」）。 */
function whenOf(time, now = Date.now()) {
  const d = new Date(time);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const minutes = Math.floor((now - time) / MIN);
  return sameDay
    ? `${minutes} 分钟前 · ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `昨天 · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function harness(extraShims = [], opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard', ...extraShims], ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  const doc = ui.doc;
  const area = () => doc.getElementById('edArea');
  const h = {
    ui,
    doc,
    toasts,
    area,
    btn: () => doc.querySelector('#edToolbar .ed-versions-btn'),
    side: () => doc.getElementById('pane-versions'),
    rows: () => [...doc.querySelectorAll('#versionsBody .vs-row')],
    row: (id) => doc.querySelector(`#versionsBody .vs-row[data-id="${id}"]`),
    unsaved: () => doc.querySelector('#versionsBody .vs-unsaved'),
    body: () => doc.getElementById('versionsBody').textContent,
    diff: () => doc.querySelector('.vd'),
    diffTab: () => doc.querySelector('.ed-tab-special[data-special="version-diff"]'),
    changes: () => [...doc.querySelectorAll('.vd .vd-change')],
    fileTab: (path = PATH) => [...doc.querySelectorAll('.ed-tab')].find((t) => t.dataset.path === path),
    open(path, text, extra = {}) {
      ui.post({ type: 'editorOpen', file: file(path, text, { kind: 'chapter', ...extra }) });
    },
    async showSide() {
      ui.clickEl(doc.querySelector('[data-tab="versions"]'));
      await tick();
    },
    async showChat() {
      ui.clickEl(doc.querySelector('[data-tab="chat"]'));
      await tick();
    },
    type(text) {
      area().value = text;
      area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    },
    key(key) {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
    },
    /** 后端回 `readVersion`（最近那一次），等对比标签收下（全文经 Promise 交过去，晚一拍）。 */
    async answerRead(text, id) {
      const req = [...ui.sent].reverse().find((m) => m.type === 'readVersion' && (!id || m.id === id));
      ui.post({ type: 'versionText', requestId: req.requestId, path: req.path, id: req.id, text });
      await tick();
    },
    /** 打开「文件」菜单，按标签找一项。 */
    fileItem(label) {
      ui.closeMenu();
      ui.clickEl(doc.querySelector('[data-menu="file"]'));
      return [...doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    },
    fileLabels() {
      ui.closeMenu();
      ui.clickEl(doc.querySelector('[data-menu="file"]'));
      const labels = [...doc.querySelectorAll('.wb-menu-drop .wb-menu-item .wb-menu-label')].map((n) => n.textContent);
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
    h.open(PATH, DISK);
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
    h.open(PATH, DISK);
    h.ui.post({ type: 'state', state: viewState({ initialized: false }) });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /还不是小说工程/);
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.btn().disabled, false);
  });

  test('点菜单项：切到侧栏「版本」页、发 listVersions', async () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.fileItem('历史版本…'));
    await tick();
    assert.ok(h.side().classList.contains('active'));
    assert.deepEqual({ ...h.ui.last('switchTab') }, { type: 'switchTab', tab: 'versions' });
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    assert.match(h.body(), /载入中/);
  });

  test('点工具栏「历史」：同样切过来', async () => {
    await h.showChat();
    assert.ok(!h.side().classList.contains('active'));
    h.ui.clickEl(h.btn());
    await tick();
    assert.ok(h.side().classList.contains('active'));
  });
});

describe('侧栏「版本」页', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 12, bytes: 40 },
    { id: 'cp:2026-10-20_22-30-05+0800', time: now - 20 * MIN, words: 9, bytes: 30, checkpoint: { note: '第一卷写完', auto: false } },
    { id: 'cp:2026-10-20_21-00-00+0800', time: now - 25 * MIN, words: 9, bytes: 30, checkpoint: { note: '', auto: true } },
    { id: 'a.txt', time: now - 30 * MIN, words: 3, bytes: 12 },
  ];

  before(() => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
  });

  test('活动栏：「版本」排在「文件」后面', () => {
    const tabs = [...h.doc.querySelectorAll('#tabbar .tab')].map((b) => b.dataset.tab);
    assert.equal(tabs[tabs.indexOf('files') + 1], 'versions');
  });

  test('藏着时不拉列表；切过来拉一次', async () => {
    assert.equal(h.ui.last('listVersions'), undefined);
    await h.showSide();
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    assert.equal(h.doc.getElementById('versionsFile').textContent, PATH.split('/').pop());
  });

  test('没有存下的版本：照实说，并说明什么时候会存', () => {
    h.ui.post({ type: 'versions', path: PATH, entries: [] });
    assert.match(h.body(), /还没有存下的版本/);
    assert.match(h.body(), /覆盖保存这份文件时/);
  });

  test('别的文件的列表不画到这里来', () => {
    h.ui.post({ type: 'versions', path: 'chapters/009-别处.md', entries });
    assert.equal(h.rows().length, 0);
  });

  test('列表：新的在前，「3 分钟前 · 14:32」、字数、比现在多 / 少几个字', () => {
    h.ui.post({ type: 'versions', path: PATH, entries });
    const rows = h.rows();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].querySelector('.vs-when').textContent, whenOf(entries[0].time, now));
    // 编辑区里现在 13 个字（countWords 只数汉字，标点不算）。
    assert.equal(rows[0].querySelector('.vs-meta').textContent, '12 字 · 比现在少 1 字');
    assert.equal(rows[3].querySelector('.vs-meta').textContent, '3 字 · 比现在少 10 字');
  });

  test('存档点那几行：◆ 手动、◇ 自动，带备注（自动的没备注写「自动存档点」）', () => {
    const [, manual, auto] = h.rows();
    assert.ok(manual.classList.contains('vs-checkpoint'));
    assert.match(manual.querySelector('.vs-when').textContent, /^◆ /);
    assert.equal(manual.querySelector('.vs-note').textContent, '第一卷写完');
    assert.match(auto.querySelector('.vs-when').textContent, /^◇ /);
    assert.equal(auto.querySelector('.vs-note').textContent, '自动存档点');
  });

  test('打字：最上面多一行「还没保存的改动」，「比现在」跟着变', async () => {
    assert.equal(h.unsaved(), null);
    h.type(`${DISK}风停了。\n`);
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(h.unsaved());
    assert.match(h.unsaved().textContent, /还没保存的改动.*比磁盘上多 3 字/);
    assert.equal(h.row('b.txt').querySelector('.vs-meta').textContent, '12 字 · 比现在少 4 字');
  });

  test('保存回执到了（hash 变了）：重拉一次列表；那一行没了', () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}风停了。\n`, { kind: 'chapter', hash: 'h-saved' }) });
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    h.ui.post({ type: 'versions', path: PATH, entries });
    assert.equal(h.unsaved(), null);
  });

  test('连着几次保存回执（自动保存那样）：一秒之内只重拉一次，最后那次挪到一秒之后', async () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}风停了。\n`, { kind: 'chapter', hash: 'h-saved-2' }) });
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}风停了。\n`, { kind: 'chapter', hash: 'h-saved-3' }) });
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 0, '上一次刚拉过，先攒着');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 1);
  });

  test('「＋」现在存一版：发 saveVersion，提示里说清存的是磁盘上的那一份', () => {
    const save = h.doc.getElementById('versionsSave');
    assert.match(save.title, /磁盘上现在这一份/);
    assert.match(save.title, /没保存的修改不在里面/);
    h.ui.clickEl(save);
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH });
  });

  test('换到另一份文件：重拉那一份的列表', () => {
    h.ui.sent.length = 0;
    h.open('chapters/002-风起.md', '风起了。');
    assert.equal(h.ui.last('listVersions').path, 'chapters/002-风起.md');
    assert.equal(h.rows().length, 0);
  });

  test('换到不存历史版本的文件：照实说，不发请求，「＋」点不了', () => {
    h.ui.sent.length = 0;
    h.open('笔记.md', '随手记', { kind: 'other' });
    assert.equal(h.ui.last('listVersions'), undefined);
    assert.match(h.body(), /不是工程里的创作产物/);
    assert.equal(h.doc.getElementById('versionsSave').disabled, true);
  });

  test('后端说不存（unavailable）：照实说', () => {
    h.open('chapters/003-夜雨.md', '夜雨。');
    h.ui.post({ type: 'versions', path: 'chapters/003-夜雨.md', entries: [], unavailable: '这个目录还不是小说工程（没有 .novelforge/），不存历史版本。' });
    assert.match(h.body(), /还不是小说工程/);
  });

  test('藏着时换了文件：不拉；切回来再拉那一份', async () => {
    await h.showChat();
    h.ui.sent.length = 0;
    h.ui.clickEl(h.fileTab(PATH));
    assert.equal(h.ui.last('listVersions'), undefined);
    await h.showSide();
    assert.equal(h.ui.last('listVersions').path, PATH);
  });
});

describe('对比标签：点一行就看', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 13, bytes: 40 },
    { id: 'a.txt', time: now - 120 * MIN, words: 17, bytes: 60 },
  ];

  before(async () => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries });
  });

  test('点一行：发 readVersion，编辑区开「对比 · 名字」，全文没到之前说载入中', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.row('a.txt'));
    const req = h.ui.last('readVersion');
    assert.equal(req.path, PATH);
    assert.equal(req.id, 'a.txt');
    assert.ok(h.diffTab());
    assert.match(h.diffTab().textContent, /对比 · 001-雨夜\.md/);
    assert.ok(!h.diff().classList.contains('hidden'));
    assert.match(h.diff().querySelector('.vd-body').textContent, /载入中/);
  });

  test('那一行标成选中', () => {
    assert.ok(h.row('a.txt').classList.contains('selected'));
    assert.ok(!h.row('b.txt').classList.contains('selected'));
  });

  test('全文到了：两栏的称呼，「2 处改动」，删的 <del>、加的 <ins>', async () => {
    await h.answerRead(OLD);
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[0], /2 小时前.*的快照/);
    assert.equal(cols[1], '现在');
    assert.match(h.diff().querySelector('.vd-meta').textContent, /^2 处改动/);
    const [first, second] = h.changes();
    assert.equal(first.querySelector('.vd-old').textContent, '雨还没有停。');
    assert.equal(first.querySelector('.vd-new').textContent, '雨下了三天。');
    assert.ok(first.querySelector('.vd-old del'), '左边删掉的标出来');
    assert.ok(first.querySelector('.vd-new ins'), '右边加上的标出来');
    assert.equal(second.querySelector('.vd-old').textContent, '远处有人在喊。');
    assert.match(second.querySelector('.vd-new').textContent, /删掉了/);
  });

  test('一开就停在第一处：「上一处」置灰', () => {
    assert.ok(h.changes()[0].classList.contains('current'));
    assert.equal(h.diff().querySelector('.vd-prev').disabled, true);
    assert.equal(h.diff().querySelector('.vd-next').disabled, false);
  });

  test('下一处：停到第二处，到头了「下一处」置灰', () => {
    h.ui.clickEl(h.diff().querySelector('.vd-next'));
    assert.ok(h.changes()[1].classList.contains('current'));
    assert.equal(h.diff().querySelector('.vd-next').disabled, true);
    assert.equal(h.diff().querySelector('.vd-prev').disabled, false);
  });

  test('对比标签显示着（那一块没有当前文件）：侧栏留在这份文件上', () => {
    assert.equal(h.doc.getElementById('versionsFile').textContent, '001-雨夜.md');
    assert.equal(h.rows().length, 2);
  });

  test('用回这一处：编辑区那一处换回左边那样、成为未保存、不写盘；先发不说话的 saveVersion', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.changes()[0].querySelector('.vd-revert'));
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH, quiet: true });
    assert.equal(h.ui.last('saveFile'), undefined, '不该写盘');
    assert.ok(h.fileTab().classList.contains('dirty'));
  });

  test('对比标签留着，少了一处', () => {
    assert.ok(!h.diff().classList.contains('hidden'));
    assert.equal(h.changes().length, 1);
    assert.equal(h.changes()[0].querySelector('.vd-old').textContent, '远处有人在喊。');
  });

  test('右边写成「现在（编辑器里，还没保存）」；侧栏最上面多一行', () => {
    assert.equal(h.diff().querySelector('.vd-col-right').textContent, '现在（编辑器里，还没保存）');
    assert.ok(h.unsaved());
  });

  test('回到那份文件：内容换了，一步撤销退回', () => {
    h.ui.clickEl(h.fileTab());
    assert.equal(h.area().value, '他推开门。\n\n雨还没有停。\n\n灯还亮着。\n');
    h.key('z');
    assert.equal(h.area().value, DISK);
  });

  test('编辑器里那份变了：切回对比标签时重比', () => {
    h.type(`${DISK}风停了。\n`);
    h.ui.clickEl(h.diffTab());
    assert.equal(h.changes().length, 2);
    assert.equal(h.changes()[1].querySelector('.vd-new').textContent, '风停了。');
  });

  test('还没保存的改动：磁盘上的 ↔ 编辑器里的；用回一处 = 换回磁盘上那样', async () => {
    await new Promise((r) => setTimeout(r, 350));
    h.ui.clickEl(h.unsaved());
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.deepEqual(cols, ['磁盘上的（上次保存的）', '现在（编辑器里，还没保存）']);
    assert.equal(h.changes().length, 1);
    assert.equal(h.diff().querySelector('.vd-restore').classList.contains('hidden'), true, '磁盘那一份用「还原」，这里不给恢复整份');
    h.ui.clickEl(h.changes()[0].querySelector('.vd-revert'));
    assert.match(h.diff().querySelector('.vd-body').textContent, /没有还没保存的改动了/);
  });

  test('只有一个对比标签：再点别的一行换掉里面的内容', () => {
    h.ui.clickEl(h.row('b.txt'));
    assert.equal(h.doc.querySelectorAll('.ed-tab-special[data-special="version-diff"]').length, 1);
    assert.ok(h.row('b.txt').classList.contains('selected'));
  });

  test('只有空白不同：照实说', async () => {
    await h.answerRead('　　他推开门。\n\n\n　　雨下了三天。\n\n　　灯还亮着。\n', 'b.txt');
    assert.match(h.diff().querySelector('.vd-body').textContent, /只有空白不同/);
  });

  test('关掉对比标签：侧栏不再标选中', () => {
    h.ui.clickEl(h.diffTab().querySelector('.ed-tab-close'));
    assert.equal(h.diffTab(), null);
    assert.equal(h.doc.querySelectorAll('#versionsBody .vs-row.selected').length, 0);
  });
});

describe('右键：跟后一版比、恢复整份', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 13, bytes: 40 },
    { id: 'a.txt', time: now - 120 * MIN, words: 17, bytes: 60 },
  ];

  before(async () => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries });
  });

  test('右键一行：跟现在比、跟后一版比、恢复整份到编辑区', () => {
    const menu = h.ui.rightClick(h.row('a.txt'));
    assert.deepEqual(h.ui.itemsOf(menu), ['跟现在比', '跟后一版比（那一次改了什么）', '恢复整份到编辑区']);
    h.ui.closeMenu();
  });

  test('跟后一版比：两边都要全文；只能看，没有「用回这一处」「恢复整份」', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '跟后一版比（那一次改了什么）');
    const ids = h.ui.sent.filter((m) => m.type === 'readVersion').map((m) => m.id);
    assert.deepEqual(ids.sort(), ['a.txt', 'b.txt']);
    await h.answerRead(OLD, 'a.txt');
    await h.answerRead('他推开门。\n\n雨还没有停。\n\n灯还亮着。\n', 'b.txt');
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[0], /2 小时前/);
    assert.match(cols[1], /3 分钟前/);
    assert.equal(h.changes().length, 1);
    assert.equal(h.diff().querySelector('.vd-revert'), null);
    assert.ok(h.diff().querySelector('.vd-restore').classList.contains('hidden'));
  });

  test('恢复整份到编辑区：编辑区换成那一版、未保存、不写盘，停在那份文件上', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢复整份到编辑区');
    await tick();
    // 全文记着（刚才读过），不再要。
    assert.equal(h.ui.last('readVersion'), undefined);
    assert.equal(h.area().value, OLD);
    assert.ok(h.fileTab().classList.contains('dirty'));
    assert.ok(h.diff().classList.contains('hidden'), '停在那份文件上');
    assert.equal(h.ui.last('saveFile'), undefined);
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH, quiet: true });
    assert.match(h.toasts.at(-1), /还没保存/);
  });

});

describe('对比标签不进刷新恢复', { skip: JSDOM_SKIP }, () => {
  test('存下来的快照里没有它；当前那份记的是它后面那份文件，刷新之后回到那份文件', async () => {
    const h = harness([], { storage: {} });
    h.open(PATH, DISK);
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries: [{ id: 'a.txt', time: Date.now() - MIN, words: 2, bytes: 6 }] });
    h.ui.clickEl(h.row('a.txt'));
    assert.ok(h.diffTab());
    const saved = h.ui.window.localStorage.getItem('novelforge.editor.v1');
    assert.ok(saved && !saved.includes('version-diff'), saved);
    assert.equal(JSON.parse(saved).panes.main.active, PATH);
  });
});

describe('草稿区也有自己的「历史」', { skip: JSDOM_SKIP }, () => {
  test('按钮在那一块的「保存」前面；对比标签开在那一块里', async () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿。', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const btn = draft.querySelector('.ed-versions-btn');
    assert.ok(btn);
    assert.ok(btn.nextElementSibling.classList.contains('primary'));
    h.ui.clickEl(btn);
    await tick();
    assert.equal(h.ui.last('listVersions').path, 'drafts/001-雨夜.md');
    h.ui.post({ type: 'versions', path: 'drafts/001-雨夜.md', entries: [{ id: 'a.txt', time: Date.now() - MIN, words: 2, bytes: 6 }] });
    h.ui.clickEl(h.row('a.txt'));
    assert.ok(draft.querySelector('.ed-tab-special[data-special="version-diff"]'));
    assert.ok(draft.querySelector('.vd:not(.hidden)'));
  });
});

describe('开着自动保存时恢复一版', { skip: JSDOM_SKIP }, () => {
  let h;

  before(async () => {
    h = harness(['fakeTimers']);
    h.open(PATH, '现在磁盘上的。', { hash: 'h-disk' });
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries: [{ id: 'a.txt', time: Date.now() - 5 * MIN, words: 4, bytes: 12 }] });
  });

  test('底下说清：放回之后停笔 2 秒就写回磁盘，被盖掉的那一版先进这里', () => {
    assert.match(h.doc.getElementById('versionsFoot').textContent, /自动保存开着.*停笔 2 秒.*先存进这里/);
  });

  test('恢复：先发不说话的 saveVersion，停笔 2 秒照常自动保存，saveFile 排在它后面', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢复整份到编辑区');
    await h.answerRead('旧的那一版。');
    await tick();
    assert.equal(h.area().value, '旧的那一版。');
    assert.equal(h.ui.last('saveFile'), undefined, '当场不写盘');
    h.ui.window.__clock.tick(2000);
    const types = h.ui.sent.map((m) => m.type);
    const snap = types.indexOf('saveVersion');
    const save = types.indexOf('saveFile');
    assert.ok(snap >= 0 && save > snap, types.join(' → '));
    assert.equal(h.ui.sent[save].text, '旧的那一版。');
    assert.equal(h.ui.sent[save].baseHash, 'h-disk');
  });

  test('编辑区里已经是这一版：不发 saveVersion', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢复整份到编辑区');
    await tick();
    assert.equal(h.ui.last('saveVersion'), undefined);
    assert.match(h.toasts.at(-1), /已经是这一版/);
  });

  test('关掉自动保存：那句说明跟着撤掉', () => {
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
    assert.doesNotMatch(h.doc.getElementById('versionsFoot').textContent, /自动保存开着/);
  });
});
