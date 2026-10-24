/**
 * 欢迎页的新手上手（2026-10-24）：「新建一本书」「导入写好的书（txt）」各一张表单，建好就打开、切到「工程 → 章节」。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 欢迎页 | 开始三条路、最近、怎么上手 |
 * | 新建一本书 | 一张表单：书名必填、作者可空、「放在」缺省是后端给的目录、「选…」开目录选择器填回来；说明写出会建在哪；Enter 提交发 `createProject`；建好照常 `openFolder`，打开之后切到「工程 → 章节」，不导入任何东西 |
 * | 导入写好的书 | 先挑一本 txt（选择器只列目录与 .txt）→ `inspectBook`；别人的回答不认；认不出章只说为什么、不开表单；认得出就开同一张表单，说明写认出几章、丢掉了什么，书名缺省取文件名；提交带 `importFrom`，打开之后带着 `hostPath` 发 `importManuscript` |
 * | 新窗口中打开项目 | 这个窗口开着别的书：建好的开在新窗口，网址带 `book` / `import`；新窗口读了就摘掉，打开之后接着导入 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

/** jsdom 那边造的对象原型不同，比内容先转成普通对象。 */
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const formOpen = (ui) => !ui.doc.getElementById('providerModal').classList.contains('hidden');
const formTitle = (ui) => ui.doc.getElementById('providerModalTitle').textContent;
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const note = (ui) => ui.doc.querySelector('.nf-form .form-note');
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot .primary');
const pickerOpen = (ui) => ui.doc.querySelector('.nf-picker').classList.contains('open');
const pickerTitle = (ui) => ui.doc.querySelector('.nf-picker h2').textContent;
const pickerBtn = (ui, label) => [...ui.doc.querySelectorAll('.nf-picker-actions button')].find((b) => b.textContent === label);
const pickerRow = (ui, name) => [...ui.doc.querySelectorAll('.nf-picker-row')].find((r) => r.textContent.includes(name));

function type(ui, key, value) {
  const input = field(ui, key);
  input.value = value;
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}

function enter(ui, key) {
  field(ui, key).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function emptyWindow(extra = {}) {
  const ui = mount({ body: 'standalone', empty: true, scripts: ['view.js'], shims: ['clipboard', 'scrollIntoView'], ...extra });
  return ui;
}

describe('欢迎页：开始 / 最近 / 怎么上手', { skip: JSDOM_SKIP }, () => {
  test('开始三条路，「怎么上手」写着新书、写好的书与整理', () => {
    const ui = emptyWindow();
    const welcome = ui.doc.getElementById('nfWelcome');
    assert.deepEqual([...welcome.querySelectorAll('h2')].map((h) => h.textContent), ['开始', '最近', '怎么上手']);
    assert.deepEqual(
      [...welcome.querySelectorAll('[data-welcome]')].map((b) => b.textContent),
      ['新建一本书…', '导入写好的书（txt）…', '打开文件夹…']
    );
    const steps = welcome.querySelector('.nf-welcome-steps').textContent;
    for (const word of ['新建一本书', '导入写好的书', '新建第 1 章', '从已写正文补齐', '同步', '不需要模型']) {
      assert.ok(steps.includes(word), word);
    }
  });
});

describe('新建一本书', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [], newProjectParent: '/home/me/小说' });
  });

  test('一张表单：书名、作者、放在；「放在」缺省是后端给的目录，书名空着不能提交', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="newProject"]'));
    assert.ok(formOpen(ui));
    assert.equal(formTitle(ui), '新建一本书');
    assert.equal(field(ui, 'title').value, '');
    assert.equal(field(ui, 'author').value, '');
    assert.equal(field(ui, 'parent').value, '/home/me/小说');
    assert.equal(submitBtn(ui).textContent, '新建');
    assert.equal(submitBtn(ui).disabled, true);
    assert.equal(note(ui).textContent, '「书名」还空着。');
  });

  test('说明写出会建在哪；书名里的字都不能当文件夹名时不让提交', () => {
    type(ui, 'title', '???');
    assert.equal(submitBtn(ui).disabled, true);
    assert.match(note(ui).textContent, /都不能当文件夹名/);
    type(ui, 'title', '雪夜');
    assert.equal(submitBtn(ui).disabled, false);
    assert.equal(note(ui).textContent, '会新建文件夹 /home/me/小说/雪夜，书就放在里面。');
  });

  test('「选…」开目录选择器，从框里那个目录起；确定之后填回来，表单还开着', () => {
    ui.sent.length = 0;
    const browse = [...ui.doc.querySelectorAll('.nf-form .field-row button')].find((b) => b.textContent === '选…');
    ui.clickEl(browse);
    assert.ok(pickerOpen(ui));
    assert.equal(pickerTitle(ui), '放在哪个文件夹里');
    assert.equal(ui.last('listHostDir').path, '/home/me/小说');
    // 选目录：「新建文件夹」在。
    assert.equal(pickerBtn(ui, '新建文件夹').hidden, false);
    ui.post({ type: 'hostDir', path: '/data/books', parent: '/data', entries: [], truncated: 0 });
    ui.clickEl(pickerBtn(ui, '确定'));
    assert.equal(pickerOpen(ui), false);
    assert.ok(formOpen(ui));
    assert.equal(field(ui, 'parent').value, '/data/books');
    assert.equal(note(ui).textContent, '会新建文件夹 /data/books/雪夜，书就放在里面。');
    assert.equal(ui.last('openFolder'), undefined);
  });

  test('从「选…」开出来的选择器上按 Esc：只关选择器，表单与填好的字都在', () => {
    const browse = [...ui.doc.querySelectorAll('.nf-form .field-row button')].find((b) => b.textContent === '选…');
    ui.clickEl(browse);
    assert.ok(pickerOpen(ui));
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(pickerOpen(ui), false);
    assert.ok(formOpen(ui));
    assert.equal(field(ui, 'title').value, '雪夜');
    assert.equal(field(ui, 'parent').value, '/data/books');
  });

  test('在书名框里按 Enter 就提交：发 createProject，不带 importFrom', () => {
    ui.sent.length = 0;
    type(ui, 'author', '某某');
    enter(ui, 'title');
    assert.equal(formOpen(ui), false);
    assert.deepEqual(plain(ui.last('createProject')), { type: 'createProject', parent: '/data/books', title: '雪夜', author: '某某' });
  });

  test('建好了：照常打开；打开之后切到「工程 → 章节」，不导入任何东西', () => {
    ui.sent.length = 0;
    ui.post({ type: 'projectCreated', root: '/data/books/雪夜' });
    assert.deepEqual(plain(ui.last('openFolder')), { type: 'openFolder', path: '/data/books/雪夜', mode: 'replace' });
    ui.post({
      type: 'workspaces',
      currentId: '/data/books/雪夜',
      items: [{ id: '/data/books/雪夜', root: '/data/books/雪夜', name: '雪夜' }],
      recents: [],
    });
    assert.ok(ui.doc.getElementById('pane-project').classList.contains('active'));
    assert.equal(ui.last('switchTab')?.tab, 'project');
    assert.ok(ui.doc.querySelector('[data-project-tab="chapters"]').classList.contains('active'));
    assert.equal(ui.last('projectAction'), undefined);
  });
});

describe('导入写好的书', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [], newProjectParent: '/home/me' });
  });

  const pickBook = (name) => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('[data-welcome="importBook"]'));
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: '原稿.txt', kind: 'file', absPath: '/home/me/原稿.txt' },
        { name: '散文.txt', kind: 'file', absPath: '/home/me/散文.txt' },
        { name: '笔记.md', kind: 'file', absPath: '/home/me/笔记.md' },
      ],
      truncated: 0,
    });
    ui.clickEl(pickerRow(ui, name));
    ui.clickEl(pickerBtn(ui, '确定'));
  };

  test('先挑一本 txt：选择器只列目录与 .txt，没点中一本不能确定，不给「新建文件夹」', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="importBook"]'));
    assert.ok(pickerOpen(ui));
    assert.ok(pickerTitle(ui).startsWith('导入写好的书：选一本 txt'), pickerTitle(ui));
    assert.equal(ui.last('listHostDir').path, '~');
    assert.equal(pickerBtn(ui, '新建文件夹').hidden, true);
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: '原稿.txt', kind: 'file', absPath: '/home/me/原稿.txt' },
        { name: '笔记.md', kind: 'file', absPath: '/home/me/笔记.md' },
      ],
      truncated: 0,
    });
    assert.ok(pickerRow(ui, 'books'));
    assert.ok(pickerRow(ui, '原稿.txt'));
    assert.equal(pickerRow(ui, '笔记.md'), undefined);
    assert.equal(pickerBtn(ui, '确定').disabled, true);
    ui.clickEl(pickerBtn(ui, '取消'));
  });

  test('挑好一本：发 inspectBook，等后端看切得出几章', () => {
    pickBook('散文.txt');
    assert.equal(pickerOpen(ui), false);
    assert.deepEqual(plain(ui.last('inspectBook')), { type: 'inspectBook', path: '/home/me/散文.txt' });
    assert.equal(formOpen(ui), false);
  });

  test('认不出章：只说为什么，不开表单', () => {
    ui.post({ type: 'bookInspected', path: '/home/me/散文.txt', title: '散文', chapters: 0, detail: [], error: '《散文》里认不出章节标题。' });
    assert.equal(formOpen(ui), false);
    const toast = ui.doc.getElementById('toast');
    assert.ok(toast.classList.contains('error'));
    assert.equal(toast.textContent, '《散文》里认不出章节标题。');
  });

  test('别的那一本的回答不认', () => {
    pickBook('原稿.txt');
    ui.post({ type: 'bookInspected', path: '/home/me/别的.txt', title: '别的', chapters: 3, headline: 'x', detail: [] });
    assert.equal(formOpen(ui), false);
  });

  test('认得出：同一张表单，说明写认出几章、丢掉了什么，书名缺省取文件名', () => {
    ui.post({
      type: 'bookInspected',
      path: '/home/me/原稿.txt',
      title: '原稿',
      chapters: 3,
      headline: '从《原稿》认出 3 章（120 字），导入为第 1–3 章',
      detail: ['文件：/home/me/原稿.txt（UTF-8）。', '2 行卷标题（第一卷 少年游、第二卷 江湖远）不算章，丢掉。'],
    });
    assert.ok(formOpen(ui));
    assert.equal(formTitle(ui), '导入写好的书');
    assert.equal(ui.doc.querySelector('.nf-form .form-lead').textContent, '从《原稿》认出 3 章（120 字），导入为第 1–3 章。这一步不调用模型。');
    assert.equal(ui.doc.querySelectorAll('.nf-form .form-details li').length, 2);
    assert.equal(field(ui, 'title').value, '原稿');
    assert.equal(field(ui, 'parent').value, '/home/me');
    assert.equal(submitBtn(ui).textContent, '导入');
    assert.equal(note(ui).textContent, '会新建文件夹 /home/me/原稿，书就放在里面。');
  });

  test('点「导入」：createProject 带 importFrom；建好打开之后带着 hostPath 接着导入', () => {
    type(ui, 'title', '青云剑录');
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    assert.deepEqual(plain(ui.last('createProject')), {
      type: 'createProject',
      parent: '/home/me',
      title: '青云剑录',
      author: '',
      importFrom: '/home/me/原稿.txt',
    });
    ui.post({ type: 'projectCreated', root: '/home/me/青云剑录', importFrom: '/home/me/原稿.txt' });
    assert.equal(ui.last('openFolder')?.path, '/home/me/青云剑录');
    // 还没打开就不导入。
    assert.equal(ui.last('projectAction'), undefined);
    ui.post({
      type: 'workspaces',
      currentId: '/home/me/青云剑录',
      items: [{ id: '/home/me/青云剑录', root: '/home/me/青云剑录', name: '青云剑录' }],
      recents: [],
    });
    assert.deepEqual(plain(ui.last('projectAction')), { type: 'projectAction', action: 'importManuscript', hostPath: '/home/me/原稿.txt' });
    assert.ok(ui.doc.querySelector('[data-project-tab="chapters"]').classList.contains('active'));
  });

  test('之后再推 workspaces 不再导入一遍', () => {
    ui.sent.length = 0;
    ui.post({
      type: 'workspaces',
      currentId: '/home/me/青云剑录',
      items: [{ id: '/home/me/青云剑录', root: '/home/me/青云剑录', name: '青云剑录' }],
      recents: [],
    });
    assert.equal(ui.last('projectAction'), undefined);
  });
});

describe('新窗口中打开项目', { skip: JSDOM_SKIP }, () => {
  test('这个窗口开着别的书：建好的开在新窗口，网址带 book 与 import，这个窗口不动', () => {
    const ui = emptyWindow({ url: 'http://localhost/?project=%2Fbooks%2F旧书' });
    const opened = [];
    ui.window.open = (url) => {
      opened.push(url);
      return {};
    };
    ui.post({
      type: 'workspaces',
      currentId: '/books/旧书',
      items: [{ id: '/books/旧书', root: '/books/旧书', name: '旧书' }],
      recents: [],
      openInNewWindow: true,
    });
    ui.sent.length = 0;
    ui.post({ type: 'projectCreated', root: '/books/新书', importFrom: '/x/原稿.txt' });
    assert.equal(opened.length, 1);
    const url = new URL(opened[0]);
    assert.equal(url.searchParams.get('project'), '/books/新书');
    assert.equal(url.searchParams.get('book'), '1');
    assert.equal(url.searchParams.get('import'), '/x/原稿.txt');
    assert.equal(ui.last('openFolder'), undefined);
  });

  test('新窗口读了网址上的 book / import 就摘掉，打开之后接着导入', () => {
    const ui = emptyWindow({ url: `http://localhost/?project=${encodeURIComponent('/books/新书')}&book=1&import=${encodeURIComponent('/x/原稿.txt')}` });
    const search = new URL(ui.window.location.href).searchParams;
    assert.equal(search.has('book'), false);
    assert.equal(search.has('import'), false);
    ui.post({
      type: 'workspaces',
      currentId: '/books/新书',
      items: [{ id: '/books/新书', root: '/books/新书', name: '新书' }],
      recents: [],
    });
    assert.deepEqual(plain(ui.last('projectAction')), { type: 'projectAction', action: 'importManuscript', hostPath: '/x/原稿.txt' });
    assert.equal(ui.last('switchTab')?.tab, 'project');
  });
});

describe('建好的书没打开成', { skip: JSDOM_SKIP }, () => {
  test('窗口换成了别的书：作废，不把 txt 导进那一本，之后再换回来也不补', () => {
    const ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [] });
    ui.post({ type: 'projectCreated', root: '/books/新书', importFrom: '/x/原稿.txt' });
    ui.sent.length = 0;
    // 空窗口那一条不算，接着等。
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [] });
    ui.post({ type: 'workspaces', currentId: '/books/别的书', items: [{ id: '/books/别的书', root: '/books/别的书', name: '别的书' }], recents: [] });
    assert.equal(ui.last('projectAction'), undefined);
    ui.post({ type: 'workspaces', currentId: '/books/新书', items: [{ id: '/books/新书', root: '/books/新书', name: '新书' }], recents: [] });
    assert.equal(ui.last('projectAction'), undefined);
  });
});
