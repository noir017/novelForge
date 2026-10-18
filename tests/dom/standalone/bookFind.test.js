/**
 * 全书查找替换面板（`media/src/editor/bookFind.ts`）与「编辑 → 全书查找替换…」（`media/src/view/bookFindMenu.ts`）。
 * 结果由后端推来（`bookFindResult` / `bookReplaceDone`），这里按消息造；纯函数的口径在 tests/unit/editor/bookFindCore.test.js，
 * 后端在 tests/integration/views/bookFind.test.js 与 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 打开 / 收起 | Ctrl+Shift+F 打开、压在侧栏上（编辑区不挡）、焦点进查找框；Ctrl+Shift+H 焦点进替换框；不开本文件的查找条；Esc、×、点活动栏页签收起；编辑区里的选区预填 |
 * | 菜单 | 「编辑」菜单「替换」后面紧跟「全书查找替换…」、写着 Ctrl+Shift+F、点了打开；没开工程置灰、不开 |
 * | 停顿再搜 | 停顿 300ms 才发 `bookFind`（缺省只勾正文）；组字中途不发；新的一次之前先 `cancelBookFind` 上一次；Enter 当场搜；别人的 requestId 不认 |
 * | 结果 | 按范围分组、文件的称呼与处数、每一处一行上下文（命中的字高亮）、到了上限与没搜的说明、正则写错 |
 * | 点一处 | 没开着的开成正常标签（不带 preview）、到了之后选中那一处（按行列认、本文件查找条亮着同一个查找串）、焦点进编辑区；开着的直接切过去 |
 * | 未保存 | 编辑器里有未保存修改的文件标「未保存」；预览里勾不了；替换请求里列进 `dirty` |
 * | 预览 | 「预览替换」发带 replacement 的 `bookFind`；旧字划掉、新字跟着；每一处、每个文件都能勾掉；计数跟着变 |
 * | 替换所选 | 两段式：第一下只换字，第二下才发 `bookReplace`（勾掉的不带、每份带预览时的 hash）；改了勾选退回第一段 |
 * | 汇总 | 替换了几个文件几处、历史版本、跳过了哪些与为什么；之后自动再搜一次 |
 * | 磁盘同步 | 已打开的干净标签：替换完 `state` 一到就核对，后端说磁盘上变了就地换成新内容 |
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const URL = 'http://localhost/?project=%2Ftmp%2F%E9%9D%92%E4%BA%91';
const C1 = 'chapters/001-入宗.md';
const C2 = 'chapters/002-下山.md';
const P1 = '.novelforge/summaries/001-入宗.md';
const T1 = '# 入宗\n\n林晚推开山门。\n山风里林晚站了很久。\n';
const T2 = '# 下山\n\n林晚下山去了。\n';

const hit = (text, line, col, extra = {}) => {
  const lines = text.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col;
  return { start, end: start + 2, line, col, before: lines[line - 1].slice(0, col), text: '林晚', after: lines[line - 1].slice(col + 2), ...extra };
};

/** 一份结果：第 1 章两处、第 2 章一处、第 1 章细纲一处。 */
function result(extra = {}, replacement) {
  const r = (h) => (replacement === undefined ? h : { ...h, replacement });
  return {
    files: [
      { path: C1, scope: 'chapter', label: '第 1 章 入宗', hash: 'h1', count: 2, hits: [r(hit(T1, 3, 0)), r(hit(T1, 4, 3))] },
      { path: C2, scope: 'chapter', label: '第 2 章 下山', hash: 'h2', count: 1, hits: [r(hit(T2, 3, 0))] },
      { path: P1, scope: 'plot', label: '细纲 · 第 1 章 入宗', hash: 'hp', count: 1, hits: [r({ start: 60, end: 62, line: 9, col: 0, before: '', text: '林晚', after: '入宗' })] },
    ],
    listed: 4,
    scanned: 6,
    skipped: [],
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({
    body: 'standalone',
    scripts: ['view.js', 'editor.js'],
    shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard', 'fakeTimers'],
    url: URL,
    ...opts,
  });
  const toasts = [];
  ui.window.__nfToast = (m, isError) => toasts.push({ m, isError: !!isError });
  if (!opts.empty) {
    ui.post({ type: 'state', state: viewState() });
  }
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    toasts,
    tick: (ms) => window.__clock.tick(ms),
    panel: () => doc.querySelector('.bf-panel'),
    isOpen: () => !!h.panel() && !h.panel().classList.contains('hidden'),
    q: (cls) => doc.querySelector(`.bf-panel .${cls}`),
    all: (cls) => [...doc.querySelectorAll(`.bf-panel .${cls}`)],
    area: () => doc.getElementById('edArea'),
    key(target, key, init = {}) {
      const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    ctrlShift(letter, target = doc.body) {
      return h.key(target, letter.toUpperCase(), { ctrlKey: true, shiftKey: true, code: `Key${letter.toUpperCase()}` });
    },
    type(input, value, init = {}) {
      input.value = value;
      input.dispatchEvent(new window.InputEvent('input', { bubbles: true, ...init }));
    },
    /** 第 n 条之后发出去的某种消息（拷成本 realm 的普通对象）。 */
    sent: (type) => JSON.parse(JSON.stringify(ui.sent.filter((m) => m.type === type))),
    last: (type) => h.sent(type).at(-1),
    /** 打开、输入、等停顿、回结果。 */
    search(query = '林晚', r = result()) {
      if (!h.isOpen()) {
        h.ctrlShift('f');
      }
      h.type(h.q('bf-query'), query);
      h.tick(300);
      h.respond(r);
    },
    respond(r = result()) {
      const req = h.last('bookFind');
      assert.ok(req, '没发 bookFind');
      ui.post({ type: 'bookFindResult', requestId: req.requestId, result: r });
    },
    status: () => h.q('bf-status').textContent,
    open: (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, { kind: 'chapter', ...extra }) }),
  };
  return h;
}

describe('全书查找替换 · 打开与收起', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('Ctrl+Shift+F 打开、压在侧栏上、焦点进查找框；不开本文件的查找条', () => {
    h.open(C1, T1);
    const ev = h.ctrlShift('f', h.area());
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.panel().parentElement, h.doc.getElementById('wbSide'));
    assert.equal(h.doc.getElementById('wbSide').classList.contains('bf-open'), true);
    assert.equal(h.doc.activeElement, h.q('bf-query'));
    assert.equal(h.doc.querySelector('#wbEditor .ed-find:not(.hidden)'), null, 'Ctrl+Shift+F 不该开本文件的查找条');
    // 编辑区没被挡：面板不在编辑器里，也不是遮罩。
    assert.equal(h.doc.getElementById('wbEditor').contains(h.panel()), false);
    assert.equal(h.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('Ctrl+F 仍是本文件的查找条，不开全书面板', () => {
    h.open(C1, T1);
    h.key(h.area(), 'f', { ctrlKey: true });
    assert.equal(h.isOpen(), false);
    assert.ok(h.doc.querySelector('#wbEditor .ed-find:not(.hidden)'));
  });

  test('Ctrl+Shift+H：查找框有字时焦点进替换框', () => {
    h.ctrlShift('f');
    h.type(h.q('bf-query'), '林晚');
    h.q('bf-query').blur();
    h.ctrlShift('h');
    assert.equal(h.doc.activeElement, h.q('bf-replace'));
  });

  test('编辑区里选着一行之内的几个字：预填进查找框、当场搜', () => {
    h.open(C1, T1);
    h.area().focus();
    h.area().setSelectionRange(T1.indexOf('林晚'), T1.indexOf('林晚') + 2);
    h.ctrlShift('f', h.area());
    assert.equal(h.q('bf-query').value, '林晚');
    assert.equal(h.last('bookFind').query.query, '林晚');
  });

  test('Esc 收起、侧栏原来那一页露出来、焦点还回去；结果留着，再打开还在', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ctrlShift('f', chat);
    h.search();
    const ev = h.key(h.q('bf-query'), 'Escape');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), false);
    assert.equal(h.doc.getElementById('wbSide').classList.contains('bf-open'), false);
    assert.equal(h.doc.activeElement, chat);
    h.ctrlShift('f');
    assert.equal(h.all('bf-file').length, 3);
  });

  test('× 与点活动栏页签都收起', () => {
    h.ctrlShift('f');
    h.ui.clickEl(h.q('bf-close'));
    assert.equal(h.isOpen(), false);
    h.ctrlShift('f');
    h.ui.clickEl(h.doc.querySelector('.tabbar .tab[data-tab="project"]'));
    assert.equal(h.isOpen(), false);
  });
});

describe('全书查找替换 · 菜单与没开工程', { skip: JSDOM_SKIP }, () => {
  test('「编辑」菜单「替换」后面紧跟「全书查找替换…」，写着 Ctrl+Shift+F，点了打开', () => {
    const h = harness();
    h.ui.clickEl(h.doc.querySelector('[data-menu="edit"]'));
    const items = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
    const labels = items.map((b) => b.querySelector('.wb-menu-label').textContent);
    const at = labels.indexOf('替换');
    assert.equal(labels[at + 1], '全书查找替换…');
    assert.equal(items[at + 1].querySelector('.wb-menu-kbd').textContent, 'Ctrl+Shift+F');
    assert.equal(items[at + 1].disabled, false);
    h.ui.clickEl(items[at + 1]);
    assert.equal(h.isOpen(), true);
  });

  test('没开工程：菜单项置灰、提示原因；快捷键不开面板、说一句', () => {
    const h = harness({ empty: true });
    h.ui.clickEl(h.doc.querySelector('[data-menu="edit"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '全书查找替换…'
    );
    assert.equal(item.disabled, true);
    assert.match(item.title, /先打开一个工程/);
    h.ctrlShift('f');
    assert.equal(h.isOpen(), false);
    assert.equal(h.sent('bookFind').length, 0);
    assert.match(h.toasts.at(-1).m, /先打开一个工程/);
  });
});

describe('全书查找替换 · 停顿再搜与结果', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.ctrlShift('f');
  });

  test('停顿 300ms 才发；缺省只勾正文、两颗开关关着', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(299);
    assert.equal(h.sent('bookFind').length, 0);
    h.tick(1);
    const req = h.last('bookFind');
    assert.deepEqual(req.query, { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter'] });
    assert.match(h.status(), /正在搜/);
    assert.equal(h.q('bf-stop').classList.contains('hidden'), false);
  });

  test('组字中途不发，上屏之后再算', () => {
    h.type(h.q('bf-query'), 'lin', { isComposing: true });
    h.tick(500);
    assert.equal(h.sent('bookFind').length, 0);
    h.q('bf-query').value = '林';
    h.q('bf-query').dispatchEvent(new h.ui.window.Event('compositionend', { bubbles: true }));
    h.tick(300);
    assert.equal(h.last('bookFind').query.query, '林');
  });

  test('新的一次发出之前先叫停上一次；Enter 当场搜', () => {
    h.type(h.q('bf-query'), '林');
    h.tick(300);
    const first = h.last('bookFind').requestId;
    h.type(h.q('bf-query'), '林晚');
    h.key(h.q('bf-query'), 'Enter');
    assert.deepEqual(h.last('cancelBookFind'), { type: 'cancelBookFind', requestId: first });
    assert.equal(h.last('bookFind').query.query, '林晚');
    assert.notEqual(h.last('bookFind').requestId, first);
  });

  test('开关、范围一换就当场搜（带上新的条件）', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(300);
    h.ui.clickEl(h.q('bf-regex'));
    assert.equal(h.last('bookFind').query.regex, true);
    const plotBox = h.doc.querySelector('.bf-scope input[data-scope="plot"]');
    plotBox.checked = true;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.deepEqual(h.last('bookFind').query.scopes, ['chapter', 'plot']);
  });

  test('结果：按范围分组、文件的称呼与处数、每一处一行上下文，命中的字高亮', () => {
    h.search();
    assert.deepEqual(h.all('bf-group').map((g) => g.textContent), ['正文 · 2 个文件 3 处', '细纲 · 1 个文件 1 处']);
    assert.deepEqual(h.all('bf-file-label').map((n) => n.textContent), ['第 1 章 入宗', '第 2 章 下山', '细纲 · 第 1 章 入宗']);
    assert.deepEqual(h.all('bf-file-count').map((n) => n.textContent), ['2', '1', '1']);
    const row = h.all('bf-hit')[1];
    assert.equal(row.querySelector('.bf-line').textContent, '4');
    assert.equal(row.querySelector('.bf-ctx').textContent, '山风里林晚站了很久。');
    assert.equal(row.querySelector('mark.bf-mark').textContent, '林晚');
    assert.equal(h.status(), '3 个文件，4 处');
  });

  test('用户内容不当 HTML：上下文里的 <script> 只是字', () => {
    h.search('林晚', result({ files: [{ ...result().files[0], hits: [{ ...hit(T1, 3, 0), before: '<b>粗</b>', after: '<script>x</script>' }] }] }));
    assert.equal(h.doc.querySelector('.bf-ctx b'), null);
    assert.equal(h.doc.querySelector('.bf-ctx script'), null);
    assert.match(h.q('bf-ctx').textContent, /<script>x<\/script>/);
  });

  test('到了上限、有文件没搜：说出来；这一份没列全的写「列了几处 / 一共几处」', () => {
    const r = result({ truncated: { limit: 3, at: '细纲 · 第 1 章 入宗' }, skipped: [{ path: 'chapters/009.md', label: '第 9 章', reason: '超过 2 MB，没有搜' }] });
    r.files[0].count = 5;
    h.search('林晚', r);
    const notes = h.all('bf-note').map((n) => n.textContent);
    assert.match(notes[0], /只列了前 3 处：搜到「细纲 · 第 1 章 入宗」就停了/);
    assert.match(notes[1], /第 9 章（超过 2 MB，没有搜）/);
    assert.equal(h.all('bf-file-count')[0].textContent, '2/5');
  });

  test('正则写错：说一句、查找框标红', () => {
    h.search('(', { files: [], listed: 0, scanned: 0, skipped: [], error: 'Unterminated group' });
    assert.equal(h.status(), '正则写错了');
    assert.equal(h.q('bf-query').classList.contains('invalid'), true);
  });

  test('别的窗口的 requestId 不认；停止之后回来的也不认', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(300);
    h.ui.post({ type: 'bookFindResult', requestId: 'someone-else', result: result() });
    assert.equal(h.all('bf-file').length, 0);
    const req = h.last('bookFind');
    h.ui.clickEl(h.q('bf-stop'));
    assert.deepEqual(h.last('cancelBookFind'), { type: 'cancelBookFind', requestId: req.requestId });
    assert.equal(h.status(), '已停止');
    h.ui.post({ type: 'bookFindResult', requestId: req.requestId, result: result() });
    assert.equal(h.all('bf-file').length, 0);
  });

  test('点文件那一行收起 / 展开它的那几处', () => {
    h.search();
    const head = h.all('bf-file-head')[0];
    h.ui.clickEl(head);
    assert.equal(h.all('bf-file')[0].classList.contains('collapsed'), true);
    h.ui.clickEl(head);
    assert.equal(h.all('bf-file')[0].classList.contains('collapsed'), false);
  });
});

describe('全书查找替换 · 点一处跳过去', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('没开着的：开成正常标签（不带 preview），到了之后选中那一处、焦点进编辑区，本文件的查找条亮着同一个查找串', () => {
    h.search();
    const before = h.ui.sent.length;
    h.ui.clickEl(h.all('bf-hit')[1]);
    const opened = JSON.parse(JSON.stringify(h.ui.sent.slice(before))).filter((m) => m.type === 'openEditor');
    assert.deepEqual(opened, [{ type: 'openEditor', path: C1, pane: 'main' }]);
    h.open(C1, T1);
    const a = h.area();
    assert.equal(a.value.slice(a.selectionStart, a.selectionEnd), '林晚');
    assert.equal(a.selectionStart, T1.lastIndexOf('林晚'));
    assert.equal(h.doc.activeElement, a);
    assert.equal(h.doc.querySelector('#wbEditor .ed-find .ed-find-input').value, '林晚');
    assert.equal(h.doc.querySelector('#wbEditor .ed-find').classList.contains('hidden'), false);
  });

  test('已经开着的：直接切过去选中，不发 openEditor', () => {
    h.open(C2, T2);
    h.open(C1, T1);
    h.search();
    const before = h.sent('openEditor').length;
    h.ui.clickEl(h.all('bf-hit')[2]);
    assert.equal(h.sent('openEditor').length, before);
    const a = h.area();
    assert.equal(h.doc.querySelector('#wbEditor .ed-tab.active .ed-tab-name').textContent.includes('002'), true);
    assert.equal(a.selectionStart, T2.indexOf('林晚'));
  });

  test('按行列认位置：磁盘上是 \\r\\n、编辑区里是 \\n 也选得准', () => {
    const crlf = T1.replace(/\n/g, '\r\n');
    const r = result();
    // 后端按磁盘那一份算的下标比编辑区里多出几个 \r，行列不变。
    r.files[0].hits[1] = { ...hit(T1, 4, 3), start: crlf.lastIndexOf('林晚'), end: crlf.lastIndexOf('林晚') + 2 };
    h.open(C1, T1);
    h.search('林晚', r);
    h.ui.clickEl(h.all('bf-hit')[1]);
    assert.equal(h.area().selectionStart, T1.lastIndexOf('林晚'));
  });

  test('编辑区里那几个字已经改掉了：照实说一句', () => {
    h.open(C1, '# 入宗\n\n什么都没有。\n');
    h.search();
    h.ui.clickEl(h.all('bf-hit')[0]);
    assert.match(h.toasts.at(-1).m, /找不到了/);
  });

  test('键盘：在一处上按 Enter 也跳', () => {
    h.open(C1, T1);
    h.search();
    h.key(h.all('bf-hit')[0], 'Enter');
    assert.equal(h.area().selectionStart, T1.indexOf('林晚'));
  });
});

describe('全书查找替换 · 预览、勾选、替换所选、汇总', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    // 第 2 章开着、有未保存的修改；第 1 章开着、没改过。
    h.open(C2, T2);
    h.area().value = `${T2}还没存。`;
    h.area().dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.open(C1, T1);
    h.search();
  });

  test('只查找时：未保存的那一份标出来（列的是磁盘上的内容）', () => {
    const dirty = h.doc.querySelector(`.bf-file[data-path="${C2}"] .bf-dirty`);
    assert.ok(dirty);
    assert.match(dirty.title, /磁盘上的内容/);
    assert.equal(h.doc.querySelector(`.bf-file[data-path="${C1}"] .bf-dirty`), null);
  });

  test('「预览替换」发带 replacement 的请求；回来之后旧字划掉、新字跟着，每一处、每个文件都有勾选框', () => {
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    const req = h.last('bookFind');
    assert.equal(req.query.replacement, '林婉');
    assert.match(h.status(), /正在预览/);
    h.respond(result({}, '林婉'));
    const row = h.all('bf-hit')[0];
    assert.equal(row.querySelector('del.bf-old').textContent, '林晚');
    assert.equal(row.querySelector('ins.bf-new').textContent, '林婉');
    assert.equal(h.all('bf-hit-check').length, 4);
    assert.equal(h.all('bf-file-check').length, 3);
  });

  test('未保存的那一份勾不了；按钮与状态行上的数不算它', () => {
    const block = h.doc.querySelector(`.bf-file[data-path="${C2}"]`);
    assert.equal(block.querySelector('.bf-file-check').disabled, true);
    assert.equal(block.querySelector('.bf-hit-check').disabled, true);
    assert.equal(h.q('bf-replace-selected').textContent, '替换所选（2 个文件 3 处）');
    assert.match(h.status(), /勾着 2 个文件 3 处；1 个文件有未保存的修改，会跳过/);
  });

  test('勾掉一处：计数跟着变，文件那一格成了「勾了一部分」', () => {
    const box = h.doc.querySelectorAll(`.bf-file[data-path="${C1}"] .bf-hit-check`)[1];
    box.checked = false;
    box.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.equal(h.q('bf-replace-selected').textContent, '替换所选（2 个文件 2 处）');
    assert.equal(h.doc.querySelector(`.bf-file[data-path="${C1}"] .bf-file-check`).indeterminate, true);
  });

  test('替换所选是两段式：第一下只换字、不发；改了勾选退回第一段', () => {
    h.ui.clickEl(h.q('bf-replace-selected'));
    assert.equal(h.sent('bookReplace').length, 0);
    assert.equal(h.q('bf-replace-selected').textContent, '再点一下：替换 2 个文件 2 处');
    const plotBox = h.doc.querySelector(`.bf-file[data-path="${P1}"] .bf-file-check`);
    plotBox.checked = false;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.equal(h.q('bf-replace-selected').textContent, '替换所选（1 个文件 1 处）');
    plotBox.checked = true;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
  });

  test('第二下才发：勾掉的不带、每份带预览时的 hash、未保存的列进 dirty', () => {
    h.ui.clickEl(h.q('bf-replace-selected'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    const req = h.last('bookReplace');
    assert.ok(req);
    assert.deepEqual(req.request.files, [
      { path: C1, hash: 'h1', hits: [{ start: hit(T1, 3, 0).start, end: hit(T1, 3, 0).end }] },
      { path: C2, hash: 'h2', hits: [{ start: hit(T2, 3, 0).start, end: hit(T2, 3, 0).end }] },
      { path: P1, hash: 'hp', hits: [{ start: 60, end: 62 }] },
    ]);
    assert.deepEqual(req.request.dirty, [C2]);
    assert.equal(req.request.replacement, '林婉');
    assert.deepEqual(req.request.scopes, ['chapter']);
    assert.match(h.status(), /正在替换/);
  });

  test('汇总：替换了几个文件几处、历史版本是退路、跳过了哪些与为什么；之后自动再搜一次（只查找）', () => {
    const req = h.last('bookReplace');
    const searches = h.sent('bookFind').length;
    h.ui.post({
      type: 'bookReplaceDone',
      requestId: req.requestId,
      summary: {
        files: 2,
        hits: 2,
        replaced: [{ path: C1, label: '第 1 章 入宗', count: 1 }, { path: P1, label: '细纲 · 第 1 章 入宗', count: 1 }],
        skipped: [{ path: C2, label: '第 2 章 下山', reason: 'dirty', message: '编辑器里有未保存的修改：先保存（或放弃修改），再替换一次。' }],
        chainKept: [],
        plotOnly: [],
        bodyOnly: [],
        outlineOnly: [],
        renamedCards: [],
      },
    });
    const lines = h.all('bf-summary-line').map((n) => n.textContent);
    assert.equal(lines[0], '替换了 2 个文件、共 2 处。');
    assert.match(lines[1], /「历史」里找回替换前那一版/);
    assert.match(lines[1], /没有一步撤销/);
    assert.ok(lines.includes('跳过了 1 个文件：'));
    assert.ok(lines.some((l) => /第 2 章 下山——编辑器里有未保存的修改/.test(l)));
    assert.equal(h.sent('bookFind').length, searches + 1);
    assert.equal(h.last('bookFind').query.replacement, undefined);
    assert.equal(h.q('bf-actions').classList.contains('hidden'), true);
  });

  test('已打开的干净标签：替换完 state 一到就核对，后端说磁盘上变了就地换成新内容', () => {
    const checks = h.sent('checkEditorFiles').length;
    h.ui.post({ type: 'state', state: viewState() });
    h.tick(400);
    const check = h.last('checkEditorFiles');
    assert.equal(h.sent('checkEditorFiles').length, checks + 1);
    assert.ok(check.files.some((f) => f.path === C1));
    const replaced = T1.replace('林晚', '林婉');
    h.ui.post({ type: 'editorDiskChanged', file: file(C1, replaced, { hash: 'h1-new', kind: 'chapter' }) });
    assert.equal(h.area().value, replaced);
    assert.equal(h.doc.querySelector('#wbEditor .ed-tab.active').classList.contains('dirty'), false);
  });
});

describe('全书查找替换 · 预览之后又改了输入框', { skip: JSDOM_SKIP }, () => {
  test('新的预览回来之前「替换所选」不能点（不拿旧预览去换）', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    assert.equal(h.q('bf-replace-selected').disabled, false);
    h.type(h.q('bf-replace'), '林苑');
    assert.equal(h.q('bf-replace-selected').disabled, true);
    h.tick(300);
    assert.equal(h.last('bookFind').query.replacement, '林苑');
    assert.equal(h.q('bf-replace-selected').disabled, true);
    h.respond(result({}, '林苑'));
    assert.equal(h.q('bf-replace-selected').disabled, false);
  });

  test('「退出预览」回到只查找', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    h.ui.clickEl(h.q('bf-exit-preview'));
    assert.equal(h.last('bookFind').query.replacement, undefined);
    h.respond();
    assert.equal(h.all('bf-hit-check').length, 0);
    assert.equal(h.q('bf-actions').classList.contains('hidden'), true);
  });

  test('替换没做成（上一次还没换完）：预览留着、说一句', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    const req = h.last('bookReplace');
    h.ui.post({
      type: 'bookReplaceDone',
      requestId: req.requestId,
      summary: { files: 0, hits: 0, replaced: [], skipped: [], chainKept: [], plotOnly: [], bodyOnly: [], outlineOnly: [], renamedCards: [], error: '上一次全书替换还没换完，等它换完再来。' },
    });
    assert.match(h.q('bf-summary').textContent, /还没换完/);
    assert.equal(h.all('bf-hit-check').length, 4);
  });
});

describe('全书查找替换 · 页面模板与插件形态', { skip: JSDOM_SKIP }, () => {
  test('页面模板里没有面板（由脚本现造）', () => {
    const { standaloneBodyHtml } = require('../../helpers/dom');
    assert.equal(standaloneBodyHtml().includes('bf-panel'), false);
  });

  test('插件形态（没有 #wbEditor）：不装、Ctrl+Shift+F 不拦', () => {
    const ui = mount({ body: 'webview', scripts: ['view.js', 'editor.js'] });
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    ui.doc.body.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.doc.querySelector('.bf-panel'), null);
  });
});

describe('全书查找替换 · 与名词补全互不打扰', { skip: JSDOM_SKIP }, () => {
  const NAMES = {
    initialized: true,
    names: [{ name: '林晚', aliases: ['阿晚'], source: 'character', category: '', brief: '', path: '.novelforge/characters/林晚.md' }],
  };
  const box = (h) => h.doc.querySelector('.nc-box');
  const boxShown = (h) => !!box(h) && !box(h).classList.contains('hidden');
  const altSlash = (h, target) => h.key(target, '/', { code: 'Slash', altKey: true });
  const serveNames = (h) => {
    const req = h.last('requestNameIndex');
    if (req) {
      h.ui.post({ type: 'nameIndex', requestId: req.requestId, sig: 'n1', index: NAMES });
    }
  };

  test('面板里的输入框打字、按 Alt+/：不弹名词补全（补全只认编辑区的 textarea）', () => {
    const h = harness();
    h.open(C1, T1);
    serveNames(h);
    h.ctrlShift('f');
    for (const cls of ['bf-query', 'bf-replace']) {
      h.q(cls).focus();
      h.type(h.q(cls), '林', { inputType: 'insertText', data: '林' });
      altSlash(h, h.q(cls));
      h.tick(500);
      serveNames(h);
      assert.equal(boxShown(h), false, `${cls} 里弹了名词补全`);
    }
    assert.equal(h.isOpen(), true, 'Alt+/ 不该收起面板');
  });

  test('编辑区里 Alt+/ 是名词补全、不开全书面板；Ctrl+Shift+F / Ctrl+Shift+H 是全书面板、不弹补全', () => {
    const h = harness();
    h.open(C1, '# 入宗\n\n林');
    const a = h.area();
    a.focus();
    a.setSelectionRange(a.value.length, a.value.length);
    altSlash(h, a);
    serveNames(h);
    assert.equal(boxShown(h), true, 'Alt+/ 应该弹名词补全');
    assert.equal(h.isOpen(), false, 'Alt+/ 不该开全书面板');
    const asked = h.sent('requestNameIndex').length;
    const ev = h.ctrlShift('f', a);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    h.key(h.q('bf-query'), 'Escape');
    a.focus();
    h.ctrlShift('h', a);
    assert.equal(h.isOpen(), true);
    assert.equal(h.sent('requestNameIndex').length, asked, 'Ctrl+Shift+F / H 不该去要名词表');
  });
});
