/**
 * 「转到…」面板（`media/src/editor/quickOpen.ts`）与标题栏「文件 → 转到…」（`media/src/view/quickOpenMenu.ts`）。
 * 索引由后端推来（`quickOpenIndex`），这里按消息造；匹配与排序的口径在 tests/unit/editor/quickOpenCore.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 打开 / 关闭 | Ctrl+P（Mac 的 Cmd+P）打开、拦下「打印」、焦点进输入框、发 `requestQuickOpen`；Esc 关掉且焦点还回去；点外面关；不是全屏遮罩 |
 * | 过滤与选择 | 过滤串从输入框的值算；↑↓ 换选中；匹配的字高亮 |
 * | 打开什么 | 章节发 `openChapter`（与工程页点章节行同一条，没有正文时给细纲路径）；Ctrl+Enter 开到第二块；角色等发 `openEditor`；点一行也能开；之后焦点进编辑区 |
 * | 焦点在别处 | 焦点在对话输入框里时照样打开；输入法组字中不响应（全局与面板里都是） |
 * | 菜单 | 「文件 → 转到…」紧跟「打开文件…」、写着 Ctrl+P、点了打开 |
 * | 没开工程 | 不开、不发请求、说一句；菜单项置灰 |
 * | 最近打开的 | 编辑器里开过的文件按工程记在 localStorage，空输入时列在前面 |
 * | 插件形态 | 没有 `#wbEditor` 就不装 |
 * | 与临时标签 | 从这里打开的不带 `preview`，开成正常标签、不换掉别的临时标签；打开一份已经开成临时标签的，它就此转正 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const URL = 'http://localhost/?project=%2Ftmp%2F%E9%9D%92%E4%BA%91';

/** 一份索引：分卷的章、只有细纲的第 4 章、角色、设定、文档、草稿。 */
function index(extra = {}) {
  return {
    initialized: true,
    chapters: [
      { no: 1, title: '楔子', volume: '', chapterPath: 'chapters/001-楔子.md', plotPath: '.novelforge/summaries/001-楔子.md', words: 300 },
      { no: 2, title: '入镇', volume: '第一卷', chapterPath: 'chapters/第一卷/002-入镇.md', words: 2980 },
      { no: 3, title: '夜访', volume: '第一卷', chapterPath: 'chapters/第一卷/003-夜访.md', plotPath: '.novelforge/summaries/第一卷/003-夜访.md', words: 3100 },
      { no: 4, title: '北行', volume: '第一卷', plotPath: '.novelforge/summaries/第一卷/004-北行.md', words: 0 },
      { no: 12, title: '夜入青云', volume: '第二卷', chapterPath: 'chapters/第二卷/012-夜入青云.md', plotPath: '.novelforge/summaries/第二卷/012-夜入青云.md', words: 3012 },
    ],
    characters: [{ name: '林昭', aliases: ['阿昭'], path: '.novelforge/characters/林昭.md' }],
    lore: [{ title: '青云宗', path: '.novelforge/lore/青云宗.md' }],
    docs: [{ key: 'outline', label: '情节大纲', path: '.novelforge/outline.md' }],
    drafts: [{ path: 'drafts/第一卷/003-夜访.md', name: '003-夜访.md', no: 3 }],
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({
    body: 'standalone',
    scripts: ['view.js', 'editor.js'],
    shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    url: URL,
    ...opts,
  });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  if (!opts.empty) {
    ui.post({ type: 'state', state: viewState() });
  }
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    toasts,
    panel: () => doc.querySelector('.qo-panel'),
    input: () => doc.querySelector('.qo-panel .qo-input'),
    rows: () => [...doc.querySelectorAll('.qo-panel .qo-item')],
    names: () => h.rows().map((r) => r.querySelector('.qo-name').textContent),
    activeName: () => doc.querySelector('.qo-panel .qo-item.active .qo-name')?.textContent,
    sections: () => [...doc.querySelectorAll('.qo-panel .qo-section')].map((n) => n.textContent),
    note: () => {
      const n = doc.querySelector('.qo-panel .qo-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    mainArea: () => doc.getElementById('edArea'),
    /** 按一下键，返回事件（看 defaultPrevented）。 */
    key(target, key, init = {}) {
      const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    ctrlP(target = doc.body, init = {}) {
      return h.key(target, 'p', { ctrlKey: true, code: 'KeyP', ...init });
    },
    type(text) {
      h.input().value = text;
      h.input().dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    /** 后端回索引（回最近那一次请求）。 */
    respond(idx = index()) {
      const req = ui.last('requestQuickOpen');
      assert.ok(req, '没发 requestQuickOpen');
      ui.post({ type: 'quickOpenIndex', requestId: req.requestId, index: idx });
    },
    /** Ctrl+P 打开并回索引。 */
    open(idx) {
      h.ctrlP();
      h.respond(idx);
    },
    /** 第 n 条之后发出去的消息（拷成本 realm 的普通对象，deepStrictEqual 才比得上）。 */
    sentAfter(n) {
      return JSON.parse(JSON.stringify(ui.sent.slice(n)));
    },
  };
  return h;
}

describe('「转到…」面板 · 打开与关闭', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('Ctrl+P 打开面板、拦下「打印」、焦点进输入框、发 requestQuickOpen', () => {
    const ev = h.ctrlP();
    assert.ok(h.panel(), '没开面板');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.input());
    const req = h.ui.last('requestQuickOpen');
    assert.ok(req && typeof req.requestId === 'string' && req.requestId !== '');
  });

  test('Mac 的 Cmd+P 也一样', () => {
    h.key(h.doc.body, 'p', { metaKey: true });
    assert.ok(h.panel());
  });

  test('Ctrl+Shift+P、Ctrl+Alt+P 不开', () => {
    h.ctrlP(h.doc.body, { shiftKey: true });
    h.ctrlP(h.doc.body, { altKey: true });
    assert.equal(h.panel(), null);
  });

  test('索引到之前说在读，到了列出前几章', () => {
    h.ctrlP();
    assert.match(h.note(), /正在读取/);
    assert.deepEqual(h.rows(), []);
    h.respond();
    assert.deepEqual(h.names(), ['楔子', '入镇', '夜访', '北行', '夜入青云']);
    assert.deepEqual(h.sections(), ['章节']);
    assert.equal(h.activeName(), '楔子');
  });

  test('不是全屏遮罩：挂在 body 上的一块，没有 modal-overlay', () => {
    h.open();
    assert.equal(h.panel().parentElement, h.doc.body);
    assert.equal(h.panel().closest('.modal-overlay'), null);
    assert.equal(h.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('Esc 关掉，焦点还回打开之前的地方', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ctrlP(chat);
    h.respond();
    assert.equal(h.doc.activeElement, h.input());
    const ev = h.key(h.input(), 'Escape');
    assert.equal(h.panel(), null);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.doc.activeElement, chat);
  });

  test('点面板外面关掉；点面板里面不关', () => {
    h.open();
    h.input().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.doc.getElementById('wbEditor').dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('开着时再按 Ctrl+P 不另开一个，输入框里的字全选上', () => {
    h.open();
    h.type('夜');
    h.ctrlP(h.input());
    assert.equal(h.doc.querySelectorAll('.qo-panel').length, 1);
    assert.equal(h.input().selectionStart, 0);
    assert.equal(h.input().selectionEnd, 1);
  });

  test('再打开时先拿上一份索引画出来，同时再要一份新的', () => {
    h.open();
    h.key(h.input(), 'Escape');
    const before = h.ui.sent.filter((m) => m.type === 'requestQuickOpen').length;
    h.ctrlP();
    assert.equal(h.ui.sent.filter((m) => m.type === 'requestQuickOpen').length, before + 1);
    assert.equal(h.names().length, 5);
    h.respond(index({ chapters: [index().chapters[0]] }));
    assert.deepEqual(h.names(), ['楔子']);
  });

  test('新的索引到了、输入没变：停在原来选中的那一条上', () => {
    h.open();
    h.key(h.input(), 'Escape');
    h.ctrlP();
    h.key(h.input(), 'ArrowDown');
    h.key(h.input(), 'ArrowDown');
    assert.equal(h.activeName(), '夜访');
    h.respond();
    assert.equal(h.activeName(), '夜访');
  });

  test('别的页面的 requestId 不认', () => {
    h.ctrlP();
    h.ui.post({ type: 'quickOpenIndex', requestId: 'someone-else', index: index() });
    assert.deepEqual(h.rows(), []);
    assert.match(h.note(), /正在读取/);
  });

  test('还不是小说工程：照实说', () => {
    h.open({ initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] });
    assert.match(h.note(), /还不是小说工程/);
  });

  test('页内对话框或弹窗开着时不开', () => {
    const overlay = h.doc.getElementById('providerModal');
    overlay.classList.remove('hidden');
    h.ctrlP();
    assert.equal(h.panel(), null);
    overlay.classList.add('hidden');
  });
});

describe('「转到…」面板 · 过滤与选择', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
  });

  test('输入过滤：标题子串排第一，匹配的字高亮', () => {
    h.type('夜访');
    assert.equal(h.names()[0], '夜访');
    const marks = [...h.rows()[0].querySelectorAll('.qo-name mark')].map((m) => m.textContent);
    assert.deepEqual(marks, ['夜访']);
  });

  test('第十二章直接命中第 12 章，小字写「第 12 章 · 第二卷 · 3012 字」', () => {
    h.type('第十二章');
    assert.equal(h.names()[0], '夜入青云');
    assert.equal(h.rows()[0].querySelector('.qo-detail').textContent, '第 12 章 · 第二卷 · 3012 字');
    assert.equal(h.rows()[0].querySelector('.qo-detail mark').textContent, '第 12 章');
  });

  test('每一条有类型标记与一行小字（角色写别名）', () => {
    h.type('阿昭');
    const row = h.rows()[0];
    assert.equal(row.querySelector('.qo-badge').textContent, '角色');
    assert.equal(row.querySelector('.qo-name').textContent, '林昭');
    assert.equal(row.querySelector('.qo-detail').textContent, '别名 阿昭');
  });

  test('没有匹配的说一句', () => {
    h.type('zzzz');
    assert.deepEqual(h.rows(), []);
    assert.match(h.note(), /没有匹配/);
  });

  test('↓↑ 换选中、到头绕回；改了输入回到第一条', () => {
    assert.equal(h.activeName(), '楔子');
    h.key(h.input(), 'ArrowDown');
    assert.equal(h.activeName(), '入镇');
    h.key(h.input(), 'ArrowUp');
    h.key(h.input(), 'ArrowUp');
    assert.equal(h.activeName(), '夜入青云');
    h.type('夜');
    assert.equal(h.rows()[0].classList.contains('active'), true);
  });

  test('选中的那一条标 aria-selected，输入框指向它', () => {
    h.key(h.input(), 'ArrowDown');
    const active = h.doc.querySelector('.qo-item.active');
    assert.equal(active.getAttribute('aria-selected'), 'true');
    assert.equal(h.input().getAttribute('aria-activedescendant'), active.id);
  });

  test('超过上限只列前 50 条并说一共几条', () => {
    h.key(h.input(), 'Escape');
    const many = Array.from({ length: 120 }, (_, i) => ({
      no: i + 1, title: `风雪${i + 1}`, volume: '', chapterPath: `chapters/${i + 1}.md`, words: 1,
    }));
    h.open(index({ chapters: many }));
    h.type('风雪');
    assert.equal(h.rows().length, 50);
    assert.match(h.note(), /只列出前 50 条（一共 120 条）/);
  });

  test('Tab 不把焦点带出面板', () => {
    const ev = h.key(h.input(), 'Tab');
    assert.equal(ev.defaultPrevented, true);
    assert.ok(h.panel());
  });
});

describe('「转到…」面板 · 打开什么', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
  });

  test('章节：Enter 发 openChapter（与工程页点章节行同一条），面板关掉', () => {
    h.type('夜访');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/第一卷/003-夜访.md' }]);
    assert.equal(h.panel(), null);
  });

  test('只有细纲的章：openChapter 给的是细纲路径', () => {
    h.type('北行');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: '.novelforge/summaries/第一卷/004-北行.md' }]);
  });

  test('章节：Ctrl+Enter 把正文开到第二块编辑区', () => {
    h.type('夜访');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter', { ctrlKey: true });
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: 'chapters/第一卷/003-夜访.md', pane: 'draft' }]);
  });

  test('角色：Enter 发 openEditor 开那张卡（主区），不带别的标记', () => {
    h.type('林昭');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelforge/characters/林昭.md', pane: 'main' }]);
  });

  test('设定、文档、草稿：Ctrl+Enter 开到第二块', () => {
    for (const [q, path] of [
      ['青云宗', '.novelforge/lore/青云宗.md'],
      ['情节大纲', '.novelforge/outline.md'],
      ['003-夜访.md', 'drafts/第一卷/003-夜访.md'],
    ]) {
      if (!h.panel()) {
        h.ctrlP();
      }
      h.type(q);
      const n = h.ui.sent.length;
      h.key(h.input(), 'Enter', { ctrlKey: true });
      assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path, pane: 'draft' }], q);
    }
  });

  test('点一行也能开；Ctrl+点击开到第二块', () => {
    h.type('林昭');
    let n = h.ui.sent.length;
    h.ui.clickEl(h.rows()[0]);
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelforge/characters/林昭.md', pane: 'main' }]);
    h.ctrlP();
    h.type('林昭');
    n = h.ui.sent.length;
    h.rows()[0].dispatchEvent(new h.ui.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelforge/characters/林昭.md', pane: 'draft' }]);
  });

  test('按下鼠标不把焦点从输入框拿走', () => {
    h.type('夜');
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.rows()[0].dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('打开章节之后焦点进正文那一块，并排的细纲随后到了也不把焦点抢走', () => {
    h.doc.getElementById('input').focus();
    h.ctrlP(h.doc.getElementById('input'));
    h.type('夜访');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜访.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, h.mainArea());
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/summaries/第一卷/003-夜访.md', '细纲', { kind: 'plot' }), pane: 'draft' });
    assert.equal(h.doc.activeElement, h.mainArea());
    // 当前那一块（Ctrl+S 存的就是它）也是正文那一块。
    const status = { hasFile: false, path: null };
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-query', { detail: status }));
    assert.equal(status.path, 'chapters/第一卷/003-夜访.md');
  });

  // 后端的 openChapter 在一条消息里先开正文、再开细纲（按顺序推）；就算哪天两份回来的先后反了
  // （独立版对每条 WebSocket 消息并发处理，连发两条打开请求时就是这样），焦点也还是落在正文那一块。
  test('细纲先到、正文后到：焦点照样落在正文那一块', () => {
    h.type('夜访');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/summaries/第一卷/003-夜访.md', '细纲', { kind: 'plot' }), pane: 'draft' });
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜访.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, h.mainArea());
    const status = { hasFile: false, path: null };
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-query', { detail: status }));
    assert.equal(status.path, 'chapters/第一卷/003-夜访.md');
  });

  test('Ctrl+Enter 之后焦点进第二块编辑区', () => {
    h.type('林昭');
    h.key(h.input(), 'Enter', { ctrlKey: true });
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }), pane: 'draft' });
    const draftArea = h.ui.panes()[1].querySelector('textarea');
    assert.equal(h.doc.activeElement, draftArea);
  });

  test('别处打开的文件不抢焦点（只认从面板打开的那一份）', () => {
    h.key(h.input(), 'Escape');
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, chat);
  });
});

describe('「转到…」面板 · 焦点在别处与输入法', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('焦点在左侧对话输入框里时 Ctrl+P 照样打开', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    const ev = h.ctrlP(chat);
    assert.ok(h.panel());
    assert.equal(ev.defaultPrevented, true);
  });

  test('焦点在编辑区里也能打开', () => {
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文', { kind: 'chapter' }) });
    h.mainArea().focus();
    h.ctrlP(h.mainArea());
    assert.ok(h.panel());
  });

  test('输入法组字中的 Ctrl+P 不响应（isComposing / keyCode 229）', () => {
    const chat = h.doc.getElementById('input');
    const ev = h.ctrlP(chat, { isComposing: true });
    assert.equal(h.panel(), null);
    assert.equal(ev.defaultPrevented, false);
    h.ctrlP(chat, { keyCode: 229 });
    assert.equal(h.panel(), null);
  });

  test('面板里组字中的 Enter、↑↓ 交给输入法', () => {
    h.open();
    h.type('夜');
    const n = h.ui.sent.length;
    const ev = h.key(h.input(), 'Enter', { isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.ui.sent.length, n);
    assert.ok(h.panel());
    const down = h.key(h.input(), 'ArrowDown', { isComposing: true });
    assert.equal(down.defaultPrevented, false);
  });

  test('组字中途的 input 不重算，上屏（compositionend）之后再算', () => {
    h.open();
    const before = h.names();
    h.input().value = 'lin';
    h.input().dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, isComposing: true }));
    assert.deepEqual(h.names(), before);
    h.input().value = '林昭';
    h.input().dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林昭' }));
    assert.equal(h.names()[0], '林昭');
  });
});

describe('「文件 → 转到…」', { skip: JSDOM_SKIP }, () => {
  /** 打开「文件」菜单，取一项。 */
  function fileItems(h) {
    h.ui.closeMenu();
    h.ui.clickEl(h.doc.querySelector('[data-menu="file"]'));
    return [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
  }
  const label = (b) => b.querySelector('.wb-menu-label').textContent;

  test('紧跟「打开文件…」，写着 Ctrl+P', () => {
    const h = harness();
    const items = fileItems(h);
    const at = items.findIndex((b) => label(b) === '转到…');
    assert.ok(at > 0, items.map(label).join('、'));
    assert.equal(label(items[at - 1]), '打开文件…');
    assert.equal(items[at].querySelector('.wb-menu-kbd').textContent, 'Ctrl+P');
    assert.equal(items[at].disabled, false);
  });

  test('点了打开面板、发 requestQuickOpen', () => {
    const h = harness();
    const item = fileItems(h).find((b) => label(b) === '转到…');
    h.ui.clickEl(item);
    assert.ok(h.panel());
    assert.equal(h.doc.activeElement, h.input());
    assert.ok(h.ui.last('requestQuickOpen'));
  });
});

describe('「转到…」 · 没开工程', { skip: JSDOM_SKIP }, () => {
  test('Ctrl+P 不开面板、不发请求，说一句；也不弹打印', () => {
    const h = harness({ empty: true });
    const ev = h.ctrlP();
    assert.equal(h.panel(), null);
    assert.equal(h.ui.last('requestQuickOpen'), undefined);
    assert.match(h.toasts.join('\n'), /先打开一个工程/);
    assert.equal(ev.defaultPrevented, true);
  });

  test('「文件 → 转到…」置灰，提示说为什么', () => {
    const h = harness({ empty: true });
    h.ui.clickEl(h.doc.querySelector('[data-menu="file"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '转到…'
    );
    assert.equal(item.disabled, true);
    assert.match(item.title, /先打开一个工程/);
  });
});

describe('「转到…」 · 最近打开的', { skip: JSDOM_SKIP }, () => {
  const KEY = 'novelforge.quickopen.recent@/tmp/青云';

  test('编辑器里开过的文件记在按工程分开的 localStorage 里，新的在前', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜访.md', '正文', { kind: 'chapter' }) });
    assert.deepEqual(JSON.parse(h.ui.window.localStorage.getItem(KEY)), [
      'chapters/第一卷/003-夜访.md',
      '.novelforge/characters/林昭.md',
    ]);
  });

  test('空输入时「最近打开的」列在前面，后面接前几章（已列过的不重复）', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/summaries/第一卷/003-夜访.md', '细纲', { kind: 'plot' }) });
    h.open();
    assert.deepEqual(h.sections(), ['最近打开的', '章节']);
    assert.deepEqual(h.names(), ['夜访', '林昭', '楔子', '入镇', '北行', '夜入青云']);
    assert.equal(h.activeName(), '夜访');
  });

  test('从面板打开的也记下（经编辑器激活那一下），下次排第一', () => {
    const h = harness();
    h.open();
    h.type('林昭');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ctrlP();
    h.respond();
    assert.equal(h.names()[0], '林昭');
    assert.deepEqual(h.sections()[0], '最近打开的');
  });

  test('记不进 localStorage（about:blank）时不报错，只是没有「最近打开的」', () => {
    const h = harness({ url: undefined });
    h.ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.open();
    assert.deepEqual(h.sections(), ['章节']);
  });
});

describe('「转到…」 · 与临时标签', { skip: JSDOM_SKIP }, () => {
  let h;
  const previews = () => [...h.doc.querySelectorAll('.ed-tab.preview')].map((t) => t.dataset.path);
  const tabs = () => [...h.doc.querySelectorAll('.wb-editor')][0].querySelectorAll('.ed-tab');
  /** 后端照请求回 editorOpen（不带 preview——请求上就没有）。 */
  const echo = (msg) =>
    h.ui.post({ type: 'editorOpen', file: file(msg.path ?? msg.plotRelPath, '正文'), ...(msg.pane ? { pane: msg.pane } : {}), ...(msg.preview ? { preview: true } : {}) });

  beforeEach(() => {
    h = harness();
    // 工程页 / 文件页单击打开的：第 1 章正文是临时标签。
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文'), preview: true });
  });

  test('打开章节：openChapter 不带 preview', () => {
    h.open();
    h.key(h.input(), 'Enter');
    const msg = h.ui.last('openChapter');
    assert.equal(msg.plotRelPath, 'chapters/001-楔子.md');
    assert.equal('preview' in msg, false);
  });

  test('打开的正是那个临时标签：它就此转正（被不带 preview 的打开请求打开一次）', () => {
    assert.deepEqual(previews(), ['chapters/001-楔子.md']);
    h.open();
    h.key(h.input(), 'Enter');
    echo({ path: 'chapters/001-楔子.md' });
    assert.deepEqual(previews(), []);
  });

  test('打开别的文件：开成正常标签，不换掉那个临时标签', () => {
    h.open();
    h.type('林昭');
    h.key(h.input(), 'Enter');
    const msg = h.ui.last('openEditor');
    assert.equal(msg.path, '.novelforge/characters/林昭.md');
    assert.equal('preview' in msg, false);
    echo(msg);
    assert.equal(tabs().length, 2);
    assert.deepEqual(previews(), ['chapters/001-楔子.md']);
  });
});

describe('「转到…」 · 插件形态', { skip: JSDOM_SKIP }, () => {
  test('没有 #wbEditor（插件的 webview）就不装：Ctrl+P 什么都不做', () => {
    const ui = mount({ body: 'webview', scripts: ['view.js', 'editor.js'] });
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
    ui.doc.body.dispatchEvent(ev);
    assert.equal(ui.doc.querySelector('.qo-panel'), null);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.last('requestQuickOpen'), undefined);
  });
});
