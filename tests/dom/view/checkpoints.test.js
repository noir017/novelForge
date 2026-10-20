/**
 * 工程页「存档点…」弹窗（`media/src/view/checkpoints.ts`，2026-10-20）。列表与比较结果都由后端推来（`checkpoints` /
 * `checkpointDiff`），这里按消息造；前端只发消息，什么都不写。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 页签条 | 存档点是工程页页签条上刷新左边的一个图标（⚑）；点了开弹窗、发 `listCheckpoints`、说「正在读…」 |
 * | 列表 | 时刻「10-20 22:30」（不是今年的带年份）、手动 / 自动、备注或「（没写备注）」、「正文 N 章 · X 字 · F 份文件」、超过 2 MB 没存的说出来；空列表说什么时候会自动存；`unavailable` 照实说、输入框与按钮置灰 |
 * | 存一个 | 发 `createCheckpoint`（备注去掉首尾空白）、清空输入框、列表回来之前「正在存…」且按钮置灰；回车也存 |
 * | 留住 | 只有自动的有「留住…」；摊开一格（填着原来那句），「留住」发 `noteCheckpoint` |
 * | 跟现在比 | 发 `checkpointDiff`、先说「正在比…」、标题「时刻「备注」 ↔ 现在」；三组按 改过的 / 之后删掉的 / 之后新建的 排、带份数；种类、字数（「3,011 → 2,870 字」「当时」「现在」）；一样的只报个数；别的 id 不认；出错、一模一样照实说；「← 返回列表」 |
 * | 对比 | 只有页面上有 `#mergeModal`（独立版）才有、只给改过的与删掉的，发 `compareCheckpointFile` |
 * | 退回 | 点两下才发：第一下只换字（`is-armed`），点别处退回第一段；单份的 `expect` 是这一份的 `hashNow`、删掉的是 `null`；整本的 `paths` 是改过的 + 删掉的，勾了才带 `trash`；退回期间按钮置灰，后端重推之后停在这一页重画、勾选框回到不勾 |
 * | 未保存的文件 | 独立版经 `nf-dirty-query` 问内置编辑器，开着、改过没存的那一份进 `dirty`；插件形态没人回答，是空的 |
 * | 关 | Esc / × 关、面板上的一切丢掉，之后再到的消息不画；合并视图盖在上面时 Esc 不关底下的面板；后端的 prompt 中途占了这一层时，推来的列表不往上画 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree, viewState, file } = require('../../helpers/dom');

/** 页面里造的对象原型在 jsdom 那一边，deepStrictEqual 认原型：比之前先拍平。 */
const plain = (x) => JSON.parse(JSON.stringify(x));

const YEAR = new Date().getFullYear();
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

const MANUAL_ID = '2026-10-20_22-30-05+0800';
const AUTO_ID = '2026-10-19_09-05-00+0800';
const OLD_ID = '2025-03-04_08-00-00+0800';

/** 三个存档点（新的在前）：手动带备注、自动（有两份超过 2 MB 没存）、去年的手动没写备注。 */
const CHECKPOINTS = [
  { id: MANUAL_ID, time: at(YEAR, 10, 20, 22, 30), note: '第一卷写完', auto: false, files: 40, chapters: 12, chapterWords: 36000, skipped: [] },
  {
    id: AUTO_ID, time: at(YEAR, 10, 19, 9, 5), note: '批量写章之前（第 12–20 章）', auto: true,
    files: 38, chapters: 11, chapterWords: 3011, skipped: ['chapters/超大的一章.txt', 'drafts/超大的草稿.txt'],
  },
  { id: OLD_ID, time: at(YEAR - 1, 3, 4, 8, 0), note: '', auto: false, files: 2, chapters: 1, chapterWords: 900, skipped: [] },
];

const CH3 = 'chapters/第一卷/003-深处.txt';
const PLOT3 = '.novelforge/summaries/第一卷/003-深处.md';
const LIN = '.novelforge/characters/林昭.md';
const CH13 = 'chapters/第一卷/013-新章.txt';
const DRAFT13 = 'drafts/013-新章.txt';

/** 手动那个跟现在比：改过两份、删掉一份、新建两份，另有 37 份一样。 */
const DIFF = {
  id: MANUAL_ID,
  unchanged: 37,
  entries: [
    { path: PLOT3, kind: 'plot', status: 'changed', wordsThen: 800, wordsNow: 820, hashNow: 'h-plot3' },
    { path: LIN, kind: 'character', status: 'deleted', wordsThen: 1200 },
    { path: CH3, kind: 'chapter', status: 'changed', wordsThen: 3011, wordsNow: 2870, hashNow: 'h-ch3' },
    { path: CH13, kind: 'chapter', status: 'added', wordsNow: 2870, hashNow: 'h-ch13' },
    { path: DRAFT13, kind: 'draft', status: 'added', wordsNow: 120, hashNow: 'h-draft13' },
  ],
};

function harness(opts = {}) {
  const ui = mount(opts);
  const $ = (sel) => ui.doc.querySelector(sel);
  const $$ = (sel) => [...ui.doc.querySelectorAll(sel)];
  const modal = () => ui.doc.getElementById('providerModal');
  const h = {
    ui,
    $,
    $$,
    modal,
    isOpen: () => !modal().classList.contains('hidden') && !!$('#providerModalBody .cp-panel'),
    toolbarBtn: () => $('#projectTabs [data-form="checkpoints"]'),
    open() {
      ui.clickEl(h.toolbarBtn());
    },
    list(entries = CHECKPOINTS, extra = {}) {
      ui.post({ type: 'checkpoints', entries, ...extra });
    },
    rows: () => $$('.cp-list .cp-row'),
    row: (id) => $(`.cp-row[data-id="${id}"]`),
    btn(root, label) {
      return [...root.querySelectorAll('button')].find((b) => b.textContent === label);
    },
    status: () => $('.cp-list-view .cp-status'),
    groups: () => $$('.cp-diff-view .cp-group').map((g) => g.querySelector('.cp-group-head').textContent),
    fileRow: (path) => $(`.cp-file[data-path="${path}"]`),
    esc() {
      ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    },
    /** 开弹窗、收列表、点手动那一行的「跟现在比」、收比较结果。 */
    openDiff(diff = DIFF) {
      h.open();
      h.list();
      ui.clickEl(h.btn(h.row(diff.id), '跟现在比'));
      ui.post({ type: 'checkpointDiff', id: diff.id, diff });
    },
    lastRestore: () => plain(ui.last('restoreCheckpoint')?.request),
  };
  ui.post({ type: 'state', state: viewState() });
  ui.post({ type: 'project', tree: sampleTree() });
  return h;
}

describe('存档点 · 工具栏与列表', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('工程页页签条最右边、刷新的左边是存档点（⚑，只放图标）', () => {
    const btn = h.toolbarBtn();
    assert.ok(btn, '页签条上没有存档点');
    assert.equal(btn.textContent, '⚑');
    assert.equal(btn.getAttribute('aria-label'), '存档点');
    assert.match(btn.title, /^存档点：/);
    assert.ok(btn.previousElementSibling.classList.contains('spacer'));
    assert.equal(btn.nextElementSibling.dataset.action, 'refresh');
  });

  test('点了开弹窗、发 listCheckpoints、先说「正在读…」', () => {
    const before = h.ui.sent.length;
    h.open();
    assert.ok(h.isOpen());
    assert.equal(h.$('#providerModalTitle').textContent, '存档点');
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'listCheckpoints' }]);
    assert.equal(h.status().textContent, '正在读…');
    assert.equal(h.rows().length, 0);
  });

  test('一行：时刻、手动 / 自动、备注、正文与文件数；不是今年的带年份', () => {
    h.list();
    assert.equal(h.status().classList.contains('hidden'), true);
    const texts = (id) => {
      const row = h.row(id);
      return {
        time: row.querySelector('.cp-time').textContent,
        badge: row.querySelector('.cp-badge').textContent,
        note: row.querySelector('.cp-note').textContent,
        meta: row.querySelector('.cp-row-meta').textContent,
      };
    };
    assert.deepEqual(h.rows().map((r) => r.dataset.id), [MANUAL_ID, AUTO_ID, OLD_ID]);
    assert.deepEqual(texts(MANUAL_ID), { time: '10-20 22:30', badge: '手动', note: '第一卷写完', meta: '正文 12 章 · 3.6 万字 · 40 份文件' });
    assert.deepEqual(texts(AUTO_ID), {
      time: '10-19 09:05', badge: '自动', note: '批量写章之前（第 12–20 章）',
      meta: '正文 11 章 · 3011 字 · 38 份文件 · 2 份超过 2 MB 没存',
    });
    assert.deepEqual(texts(OLD_ID), { time: `${YEAR - 1}-03-04 08:00`, badge: '手动', note: '（没写备注）', meta: '正文 1 章 · 900 字 · 2 份文件' });
    assert.ok(h.row(OLD_ID).querySelector('.cp-note').classList.contains('is-empty'));
  });

  test('超过 2 MB 没存的那几份挂在提示上', () => {
    const skipped = h.row(AUTO_ID).querySelector('.cp-skipped');
    assert.equal(skipped.title, 'chapters/超大的一章.txt\ndrafts/超大的草稿.txt');
    assert.equal(h.row(MANUAL_ID).querySelector('.cp-skipped'), null);
  });

  test('只有自动的有「留住…」，提示里说写了备注就不会被裁掉', () => {
    assert.ok(!h.btn(h.row(MANUAL_ID), '留住…'));
    assert.ok(!h.btn(h.row(OLD_ID), '留住…'));
    const keep = h.btn(h.row(AUTO_ID), '留住…');
    assert.ok(keep);
    assert.match(keep.title, /写了备注就不会被自动裁掉/);
  });

  test('「留住…」摊开一格（填着原来那句），「留住」发 noteCheckpoint', () => {
    h.ui.clickEl(h.btn(h.row(AUTO_ID), '留住…'));
    const input = h.row(AUTO_ID).querySelector('.cp-keep-input');
    assert.ok(input, '没摊开');
    assert.equal(input.value, '批量写章之前（第 12–20 章）');
    input.value = '  第二卷开写前  ';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(h.btn(h.row(AUTO_ID), '留住'));
    assert.deepEqual(plain(h.ui.last('noteCheckpoint')), { type: 'noteCheckpoint', id: AUTO_ID, note: '第二卷开写前' });
    assert.equal(h.row(AUTO_ID).querySelector('.cp-keep-input'), null, '发了之后收起');
  });

  test('「存一个存档点」发 createCheckpoint、清空输入框；列表回来之前「正在存…」、按钮置灰', () => {
    const input = h.$('.cp-note-input');
    const save = h.$('.cp-save');
    assert.equal(input.placeholder, '备注（可以空着），比如：第一卷写完');
    input.value = '  第一卷写完  ';
    h.ui.clickEl(save);
    assert.deepEqual(plain(h.ui.last('createCheckpoint')), { type: 'createCheckpoint', note: '第一卷写完' });
    assert.equal(input.value, '');
    assert.equal(h.status().textContent, '正在存…');
    assert.equal(save.disabled, true);
    h.list();
    assert.equal(save.disabled, false);
    assert.equal(h.status().classList.contains('hidden'), true);
  });

  test('输入框里回车也存（备注可以空着）', () => {
    const before = h.ui.sent.length;
    h.$('.cp-note-input').dispatchEvent(new h.ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'createCheckpoint', note: '' }]);
    h.list();
  });

  test('空列表：说什么时候会自动存', () => {
    h.list([]);
    assert.equal(h.rows().length, 0);
    assert.equal(
      h.$('.cp-list .cp-empty').textContent,
      '还没有存档点。批量写章、全书替换这类批量动作之前会自动存一个；也可以现在存一个。'
    );
  });

  test('unavailable：照实说，输入框与按钮置灰，点了不发', () => {
    h.list([], { unavailable: '还不是小说工程：先初始化。' });
    assert.equal(h.status().textContent, '还不是小说工程：先初始化。');
    assert.equal(h.$('.cp-note-input').disabled, true);
    assert.equal(h.$('.cp-save').disabled, true);
    assert.equal(h.$('.cp-list .cp-empty'), null);
    h.list();
    assert.equal(h.$('.cp-save').disabled, false);
  });

  test('Esc 关：弹窗藏起、面板丢掉；之后再到的列表不画', () => {
    h.esc();
    assert.equal(h.modal().classList.contains('hidden'), true);
    assert.equal(h.$('#providerModalBody').children.length, 0);
    h.list();
    assert.equal(h.modal().classList.contains('hidden'), true);
    assert.equal(h.$('.cp-panel'), null);
  });

  test('× 也关；再打开从头要一次', () => {
    h.open();
    h.list();
    h.ui.clickEl(h.$('#providerModalClose'));
    assert.equal(h.isOpen(), false);
    const before = h.ui.sent.length;
    h.open();
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'listCheckpoints' }]);
    assert.equal(h.status().textContent, '正在读…');
    h.esc();
  });

  test('后端的 prompt 中途占了这一层：推来的列表不往上画，Esc 交给 prompt', () => {
    h.open();
    h.ui.post({ type: 'prompt', requestId: 'p1', kind: 'confirm', title: '继续吗？', actions: ['继续'] });
    h.list();
    assert.equal(h.$('#providerModalTitle').textContent, '继续吗？');
    assert.equal(h.$('.cp-panel'), null);
    h.esc();
    // 取消回的是 `value: undefined`（拍平之后没有这个键）。
    assert.deepEqual(plain(h.ui.last('promptResult')), { type: 'promptResult', requestId: 'p1' });
    assert.equal(h.modal().classList.contains('hidden'), true);
  });
});

describe('存档点 · 跟现在比（插件形态：没有合并视图）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('「跟现在比」发 checkpointDiff、先说「正在比…」，标题写时刻与备注', () => {
    h.open();
    h.list();
    const before = h.ui.sent.length;
    h.ui.clickEl(h.btn(h.row(MANUAL_ID), '跟现在比'));
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'checkpointDiff', id: MANUAL_ID }]);
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), true);
    assert.equal(h.$('.cp-diff-title').textContent, '10-20 22:30「第一卷写完」 ↔ 现在');
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在比…');
  });

  test('别的存档点的比较结果不认', () => {
    h.ui.post({ type: 'checkpointDiff', id: AUTO_ID, diff: { ...DIFF, id: AUTO_ID } });
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在比…');
  });

  test('三组按 改过的 / 之后删掉的 / 之后新建的 排、带份数；一样的只报个数', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.deepEqual(h.groups(), ['改过的 · 2 份', '之后删掉的 · 1 份', '之后新建的 · 2 份']);
    assert.equal(h.$('.cp-unchanged').textContent, '另有 37 份跟现在一模一样，不列。');
  });

  test('每份：路径、种类、字数', () => {
    const cells = (path) => {
      const row = h.fileRow(path);
      return [row.querySelector('.cp-path').textContent, row.querySelector('.cp-kind').textContent, row.querySelector('.cp-words').textContent];
    };
    assert.deepEqual(cells(CH3), [CH3, '章节', '3,011 → 2,870 字']);
    assert.deepEqual(cells(PLOT3), [PLOT3, '细纲', '800 → 820 字']);
    assert.deepEqual(cells(LIN), [LIN, '角色卡', '当时 1,200 字']);
    assert.deepEqual(cells(CH13), [CH13, '章节', '现在 2,870 字']);
    assert.deepEqual(cells(DRAFT13), [DRAFT13, '草稿', '现在 120 字']);
  });

  test('页面上没有 #mergeModal：没有「对比」；改过的、删掉的能退回，新建的没有按钮', () => {
    assert.equal(h.ui.doc.getElementById('mergeModal'), null);
    assert.equal(h.$$('.cp-diff-view .cp-compare').length, 0);
    assert.ok(h.btn(h.fileRow(CH3), '退回这一份'));
    assert.ok(h.btn(h.fileRow(LIN), '退回这一份'));
    assert.equal(h.fileRow(CH13).querySelectorAll('button').length, 0);
  });

  test('退回这一份：第一下只换字，点别处退回第一段', () => {
    const btn = () => h.btn(h.fileRow(CH3), '退回这一份') ?? h.btn(h.fileRow(CH3), '确定退回这一份？');
    const before = h.ui.sent.length;
    h.ui.clickEl(btn());
    assert.equal(btn().textContent, '确定退回这一份？');
    assert.ok(btn().classList.contains('is-armed'));
    assert.equal(h.ui.sent.length, before, '第一下不该发');
    h.ui.clickEl(h.$('.cp-diff-title'));
    assert.equal(btn().textContent, '退回这一份');
    assert.ok(!btn().classList.contains('is-armed'));
    // 点另一份的「退回这一份」：前一份退回第一段，这一份换字。
    h.ui.clickEl(btn());
    h.ui.clickEl(h.btn(h.fileRow(LIN), '退回这一份'));
    assert.equal(btn().textContent, '退回这一份');
    assert.ok(h.btn(h.fileRow(LIN), '确定退回这一份？'));
    assert.equal(h.ui.sent.length, before);
    h.ui.clickEl(h.$('.cp-diff-title'));
  });

  test('退回这一份：第二下发 restoreCheckpoint，乐观锁是这一份的 hashNow；插件形态 dirty 是空的', () => {
    h.ui.clickEl(h.btn(h.fileRow(CH3), '退回这一份'));
    h.ui.clickEl(h.btn(h.fileRow(CH3), '确定退回这一份？'));
    assert.deepEqual(h.lastRestore(), { id: MANUAL_ID, paths: [CH3], trash: [], expect: { [CH3]: 'h-ch3' }, dirty: [] });
  });

  test('退回期间说「正在退回…」、按钮全置灰；后端重推之后停在这一页重画', () => {
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在退回…');
    assert.ok(h.$$('.cp-diff-view .cp-file button, .cp-restore-all').every((b) => b.disabled));
    // 后端：先重推列表（多了「退回之前」那一个），再重推这个存档点的比较。
    const before = { id: '2026-10-20_23-00-00+0800', time: at(YEAR, 10, 20, 23, 0), note: '退回到「10-20 22:30」之前', auto: true, files: 40, chapters: 12, chapterWords: 36000, skipped: [] };
    h.list([before, ...CHECKPOINTS]);
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), true, '不该跳回列表');
    const rest = { ...DIFF, unchanged: 38, entries: DIFF.entries.filter((e) => e.path !== CH3) };
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: rest });
    assert.deepEqual(h.groups(), ['改过的 · 1 份', '之后删掉的 · 1 份', '之后新建的 · 2 份']);
    assert.equal(h.$('.cp-diff-view .cp-status'), null);
    assert.ok(!h.$('.cp-restore-all').disabled);
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
  });

  test('删掉的那一份退回：乐观锁是 null（当时磁盘上没有它）', () => {
    h.ui.clickEl(h.btn(h.fileRow(LIN), '退回这一份'));
    h.ui.clickEl(h.btn(h.fileRow(LIN), '确定退回这一份？'));
    assert.deepEqual(h.lastRestore(), { id: MANUAL_ID, paths: [LIN], trash: [], expect: { [LIN]: null }, dirty: [] });
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
  });

  test('整本退回（不勾）：改过的 + 删掉的，新建的不动', () => {
    const box = h.$('.cp-trash input');
    assert.equal(h.$('.cp-trash').textContent, '也把存档点之后新建的 2 份搬进回收站');
    assert.equal(box.checked, false);
    const whole = h.$('.cp-restore-all');
    assert.equal(whole.textContent, '整本退回');
    h.ui.clickEl(whole);
    assert.equal(whole.textContent, '确定整本退回（3 份）');
    assert.ok(whole.classList.contains('is-armed'));
    h.ui.clickEl(whole);
    const req = h.lastRestore();
    assert.deepEqual([...req.paths].sort(), [CH3, LIN, PLOT3].sort());
    assert.deepEqual(req.trash, []);
    assert.deepEqual(req.expect, { [PLOT3]: 'h-plot3', [LIN]: null, [CH3]: 'h-ch3' });
    assert.deepEqual(req.dirty, []);
    assert.equal(req.id, MANUAL_ID);
    assert.equal(h.$('.cp-foot-hint').textContent, '退回之前会先自动存一个存档点，退回也能撤回；编辑器里没保存的文件会跳过。');
  });

  test('整本退回（勾上）：新建的那几份进 trash，乐观锁一起带；重推之后勾选框回到不勾', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    const box = h.$('.cp-trash input');
    h.ui.clickEl(h.$('.cp-restore-all'));
    // 勾一下：点在别处，已经换了字的整本退回退回第一段（份数要变）。
    box.click();
    assert.equal(box.checked, true);
    assert.equal(h.$('.cp-restore-all').textContent, '整本退回');
    h.ui.clickEl(h.$('.cp-restore-all'));
    assert.equal(h.$('.cp-restore-all').textContent, '确定整本退回（5 份）');
    h.ui.clickEl(h.$('.cp-restore-all'));
    const req = h.lastRestore();
    assert.deepEqual([...req.paths].sort(), [CH3, LIN, PLOT3].sort());
    assert.deepEqual([...req.trash].sort(), [CH13, DRAFT13].sort());
    assert.deepEqual(req.expect, { [PLOT3]: 'h-plot3', [LIN]: null, [CH3]: 'h-ch3', [CH13]: 'h-ch13', [DRAFT13]: 'h-draft13' });
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.equal(h.$('.cp-trash input').checked, false);
  });

  test('只剩新建的：不勾时整本退回置灰', () => {
    const onlyAdded = { ...DIFF, entries: DIFF.entries.filter((e) => e.status === 'added') };
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: onlyAdded });
    assert.equal(h.$('.cp-restore-all').disabled, true);
    h.$('.cp-trash input').click();
    assert.equal(h.$('.cp-restore-all').disabled, false);
  });

  test('出错、一模一样照实说', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, error: '这个存档点不在了（可能被裁掉了）。' });
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '这个存档点不在了（可能被裁掉了）。');
    assert.ok(h.$('.cp-diff-view .cp-status').classList.contains('is-error'));
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: { id: MANUAL_ID, unchanged: 40, entries: [] } });
    assert.equal(h.$('.cp-same').textContent, '跟现在一模一样（40 份），没有可退回的。');
    assert.equal(h.$('.cp-restore-all'), null);
  });

  test('「← 返回列表」：回到列表，之后到的比较结果不认', () => {
    h.ui.clickEl(h.btn(h.$('.cp-diff-head'), '← 返回列表'));
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), false);
    assert.equal(h.$('.cp-diff-view').classList.contains('hidden'), true);
    assert.equal(h.rows().length, 4);
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.equal(h.$('.cp-diff-view').classList.contains('hidden'), true);
    assert.equal(h.$$('.cp-diff-view .cp-file').length, 0);
  });
});

describe('存档点 · 独立版（有合并视图与内置编辑器）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    });
    h.ui.window.__nfToast = () => {};
  });

  test('「对比」只给改过的与删掉的，发 compareCheckpointFile', () => {
    h.openDiff();
    assert.ok(h.ui.doc.getElementById('mergeModal'));
    assert.ok(h.btn(h.fileRow(CH3), '对比'));
    assert.ok(h.btn(h.fileRow(LIN), '对比'));
    assert.ok(!h.btn(h.fileRow(CH13), '对比'));
    const before = h.ui.sent.length;
    h.ui.clickEl(h.btn(h.fileRow(CH3), '对比'));
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'compareCheckpointFile', id: MANUAL_ID, path: CH3 }]);
  });

  test('合并视图盖在上面时 Esc 不关底下的面板', () => {
    const merge = h.ui.doc.getElementById('mergeModal');
    merge.classList.remove('hidden');
    h.esc();
    assert.ok(h.isOpen(), '面板不该被关');
    merge.classList.add('hidden');
  });

  test('内置编辑器里开着、改过没存的那一份进 dirty（nf-dirty-query）', () => {
    // 细纲开着、没改；正文开着、改了没存。
    h.ui.post({ type: 'editorOpen', file: file(PLOT3, '细纲', { kind: 'plot' }) });
    h.ui.post({ type: 'editorOpen', file: file(CH3, '旧的正文', { kind: 'chapter' }) });
    const area = h.ui.doc.getElementById('edArea');
    assert.equal(area.value, '旧的正文');
    area.value = '旧的正文，又写了一句';
    area.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(h.$('.cp-restore-all'));
    h.ui.clickEl(h.$('.cp-restore-all'));
    assert.deepEqual(h.lastRestore().dirty, [CH3]);
  });

  test('Esc 关', () => {
    h.esc();
    assert.equal(h.isOpen(), false);
  });
});
