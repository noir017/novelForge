/**
 * 窄屏导航（2026-10-31，手机端全面优化）：底栏的「正文」「更多」、标题栏的「⋯」、返回键一层层收、软键盘弹着时底栏让位、
 * 编辑区顶上只留两行（标签条末尾的「保存」「⋯」、章节条的「操作 ▾」）、窄屏上不并排开第二块。
 * 样式那一半（底栏的排布、藏哪几样）在 touch.test.js；后端 `openChapter` 的 `beside: false` 在 integration/generation/chapterWorkbench.test.js。
 * 真浏览器（412×915 触屏）的核对见 media/README.md「触屏与窄屏」。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 页面 | 底栏多「正文」「更多」两颗，是 `data-nav` 不是 `data-tab`；标题栏有「⋯」，没有从前那颗「编辑器」开关 |
 * | 底栏 | 点「正文」翻上编辑区、不发 switchTab；点侧栏的页签、「更多」里挑一页、编辑器要在文件页定位：都先把编辑区收下去；「更多」列文件 / 历史 / 日志 / 设置，日志有没看过的错误时那一项说出来 |
 * | 标题栏「⋯」 | 先列文件 / 编辑 / 视图 / 帮助，点一个换成它的下拉、仍贴着「⋯」，再点「⋯」收起；手机、平板上不列「退出」「打开日志目录」 |
 * | 返回键 | 开着几层就在历史里压几层（浮窗不算一层）；按返回先收菜单、再收编辑区；不是按返回收掉的自己退掉多压的那条；`nfBack()` 收掉一层回 true、没什么可收回 false；宽屏与作者还没碰过页面时不压 |
 * | 软键盘 | 焦点在输入框里、可视高度比没键盘时矮了一截：挂 kb-open；高度回来（按返回收了键盘）就摘掉；不在输入框里不算 |
 * | 编辑区顶上两行 | 标签条末尾「保存」亮灭跟着工具栏那颗、点了就是保存；「↶」「↷」亮灭跟着这份文件的撤销记录、按下不夺焦点；「⋯」列工具栏的按钮（不列保存与面包屑里的目录段），点一项就是点那颗，最后一项「补全名词」；章节条「操作 ▾」列那一排动作、带调用次数、亮灭照旧，点了发 chapterAction 并收起编辑区（生成在对话页） |
 * | 触屏的框 | 手指长按输入框不弹我们的菜单（系统的选字菜单），鼠标右键照旧；状态栏「未保存」不带（Ctrl+S） |
 * | 不并排 | 窄屏上要开在第二块的开在主区；「打开这一章」带 `beside: false` |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, sampleChapterIndex, sampleTree, viewState } = require('../../helpers/dom');

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const URL = `http://localhost/?project=${encodeURIComponent('/书/青云剑录')}`;
const SHIMS = ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm', 'narrow'];

function phone(scripts = ['view.js', 'editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: SHIMS, url: URL });
  ui.post({ type: 'state', state: viewState() });
  return ui;
}

const editorOpen = (ui) => ui.doc.body.classList.contains('editor-open');
const nav = (ui, name) => ui.doc.querySelector(`.tab[data-nav="${name}"]`);
const tab = (ui, name) => ui.doc.querySelector(`.tab[data-tab="${name}"]`);
const depth = (ui) => ui.window.history.state?.nfLayer ?? 0;
const menuItems = (ui) => [...ui.doc.querySelectorAll('.ctx-menu button')].map((b) => b.textContent);
const dropItems = (ui) => [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item .wb-menu-label')].map((n) => n.textContent);
const pickMenu = (ui, label) => ui.clickEl([...ui.doc.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.startsWith(label)));
const pickDrop = (ui, label) =>
  ui.clickEl([...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.querySelector('.wb-menu-label')?.textContent === label));

describe('窄屏导航：页面', { skip: JSDOM_SKIP }, () => {
  test('底栏多「正文」「更多」两颗，是 data-nav 不是 data-tab；标题栏有「⋯」，没有「编辑器」开关', () => {
    const ui = phone(['view.js']);
    assert.ok(nav(ui, 'editor') && nav(ui, 'more'));
    assert.equal(nav(ui, 'editor').dataset.tab, undefined);
    assert.equal(nav(ui, 'more').classList.contains('active'), false);
    assert.ok(ui.doc.getElementById('wbMoreBtn'));
    assert.equal(ui.doc.getElementById('wbEditorToggle'), null);
  });
});

describe('窄屏导航：底栏', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = phone();
  });

  test('点「正文」：编辑区翻上来，不发 switchTab', () => {
    const before = ui.sent.length;
    ui.clickEl(nav(ui, 'editor'));
    assert.equal(editorOpen(ui), true);
    assert.equal(ui.sent.slice(before).some((m) => m.type === 'switchTab'), false);
  });

  test('点侧栏的页签：编辑区收下去、切过去', () => {
    ui.clickEl(tab(ui, 'project'));
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.last('switchTab').tab, 'project');
    assert.ok(ui.doc.getElementById('pane-project').classList.contains('active'));
  });

  test('「更多」：列文件 / 历史 / 日志 / 设置；挑一页切过去、编辑区收下去', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.clickEl(nav(ui, 'more'));
    assert.deepEqual(menuItems(ui), ['文件', '历史', '日志', '设置']);
    pickMenu(ui, '日志');
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.last('switchTab').tab, 'logs');
    assert.ok(ui.doc.getElementById('pane-logs').classList.contains('active'));
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
  });

  test('「更多」：正开着的那一页打 ✓；日志有没看过的错误时那一项说出来', () => {
    ui.clickEl(tab(ui, 'chat'));
    ui.doc.getElementById('logsErrorDot').classList.remove('hidden');
    ui.clickEl(nav(ui, 'more'));
    assert.ok(menuItems(ui).includes('日志（有新的错误）'), menuItems(ui).join(' / '));
    ui.closeMenu();
    ui.doc.getElementById('logsErrorDot').classList.add('hidden');
    pickMenuAfterOpen(ui, '设置');
    ui.clickEl(nav(ui, 'more'));
    assert.ok(menuItems(ui).includes('✓ 设置'), menuItems(ui).join(' / '));
    ui.closeMenu();
  });

  test('编辑器要在文件页定位（面包屑的目录段）：编辑区收下去、切到文件页', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-reveal-in-files', { detail: { path: 'chapters' } }));
    assert.equal(editorOpen(ui), false);
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'));
  });
});

function pickMenuAfterOpen(ui, label) {
  ui.clickEl(nav(ui, 'more'));
  pickMenu(ui, label);
}

describe('窄屏导航：标题栏「⋯」', { skip: JSDOM_SKIP }, () => {
  test('先列文件 / 编辑 / 视图 / 帮助；点一个换成它的下拉，仍贴着「⋯」；再点「⋯」收起', () => {
    const ui = phone(['view.js']);
    const more = ui.doc.getElementById('wbMoreBtn');
    ui.clickEl(more);
    assert.deepEqual(dropItems(ui), ['文件', '编辑', '视图', '帮助']);
    assert.ok(more.classList.contains('open'));
    pickDrop(ui, '文件');
    assert.ok(dropItems(ui).includes('新建文件'), dropItems(ui).join(' / '));
    assert.equal(ui.doc.querySelectorAll('.wb-menu-drop').length, 1);
    assert.ok(more.classList.contains('open'), '换成「文件」之后仍贴着「⋯」');
    ui.clickEl(more);
    assert.equal(ui.doc.querySelector('.wb-menu-drop'), null);
    assert.equal(more.classList.contains('open'), false);
  });

  test('手机、平板（主指针不能悬停）上不列「退出」「打开日志目录」；桌面列', () => {
    const ui = phone(['view.js']);
    const more = ui.doc.getElementById('wbMoreBtn');
    const labels = (key) => {
      ui.clickEl(more);
      pickDrop(ui, key);
      const items = dropItems(ui);
      ui.clickEl(more);
      return items;
    };
    assert.ok(labels('文件').includes('退出'));
    assert.ok(labels('帮助').includes('打开日志目录'));
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none|max-width:\s*900px/.test(q), addEventListener() {}, removeEventListener() {} });
    assert.equal(labels('文件').includes('退出'), false);
    assert.equal(labels('帮助').includes('打开日志目录'), false);
  });
});

describe('窄屏导航：返回键', { skip: JSDOM_SKIP }, () => {
  test('开着编辑区：历史里压一层；按返回收起编辑区，页面还在', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await wait();
    assert.equal(depth(ui), 1);
    ui.window.history.back();
    await wait();
    assert.equal(editorOpen(ui), false);
    assert.equal(depth(ui), 0);
  });

  test('编辑区上再开一个菜单：压两层；按返回先收菜单、编辑区还在，再按才收编辑区', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await wait();
    ui.rightClick(ui.doc.getElementById('wbEditor'));
    await wait();
    assert.ok(ui.doc.querySelector('.ctx-menu'));
    assert.equal(depth(ui), 2);
    ui.window.history.back();
    await wait();
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
    assert.equal(editorOpen(ui), true);
    ui.window.history.back();
    await wait();
    assert.equal(editorOpen(ui), false);
  });

  test('浮窗（细纲速览、名字的一句话之类）不另算一层：一碰就出、一动就收，窄窗口的桌面上鼠标划过就出一个', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await wait();
    const tip = ui.doc.createElement('div');
    tip.className = 'summary-tip';
    ui.doc.body.appendChild(tip);
    await wait();
    assert.equal(depth(ui), 1);
    tip.remove();
  });

  test('弹窗（存档点）开着：按返回收弹窗', async () => {
    const ui = phone();
    ui.clickEl(ui.doc.getElementById('wbMoreBtn'));
    pickDrop(ui, '文件');
    pickDrop(ui, '存档点…');
    await wait();
    assert.ok(ui.doc.querySelector('.modal-overlay:not(.hidden)'));
    assert.equal(depth(ui), 1);
    ui.window.history.back();
    await wait();
    assert.equal(ui.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('不是按返回收掉的（点了底栏「工程」）：多压的那一条自己退掉', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await wait();
    assert.equal(depth(ui), 1);
    ui.clickEl(tab(ui, 'project'));
    await wait(40);
    assert.equal(depth(ui), 0);
    assert.equal(editorOpen(ui), false);
  });

  test('nfBack()（Android 壳的返回键）：收掉一层回 true；什么都没开回 false', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await wait();
    assert.equal(ui.window.nfBack(), true);
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.window.nfBack(), false);
  });

  test('宽屏：不压（编辑区常驻，返回键照浏览器原来的意思）', async () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'], url: URL });
    ui.post({ type: 'state', state: viewState() });
    ui.rightClick(ui.doc.getElementById('wbEditor'));
    await wait();
    assert.ok(ui.doc.querySelector('.ctx-menu'));
    assert.equal(depth(ui), 0);
  });

  test('作者还没碰过页面：不压（Chromium 会跳过这种条目，按返回直接离开页面）', async () => {
    const ui = phone();
    Object.defineProperty(ui.window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
    ui.doc.body.classList.add('editor-open');
    await wait();
    assert.equal(depth(ui), 0);
  });
});

describe('窄屏导航：软键盘弹着时底栏让位', { skip: JSDOM_SKIP }, () => {
  test('焦点在输入框里、可视高度矮了一截：挂 kb-open；高度回来就摘掉；焦点不在输入框里不算', () => {
    const ui = phone(['view.js']);
    let height = 900;
    Object.defineProperty(ui.window, 'innerHeight', { configurable: true, get: () => height });
    const resize = () => ui.window.dispatchEvent(new ui.window.Event('resize'));
    resize();
    const input = ui.doc.getElementById('input');
    input.focus();
    height = 520;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), true);
    height = 900;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), false);
    input.blur();
    height = 520;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), false);
  });
});

describe('窄屏：编辑区顶上两行', { skip: JSDOM_SKIP }, () => {
  let ui;
  const bar = () => ui.doc.getElementById('edChapterBar');
  const save = () => ui.doc.querySelector('#edTabs .ed-tabs-save');
  const tools = () => ui.doc.querySelector('#edTabs .ed-tabs-tools');
  before(() => {
    ui = phone();
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex() });
    // 带上称呼：面包屑的「正文」那一段才是按钮（点了在文件页定位），「⋯」里不该有它。
    const label = { tag: '', title: '002-入镇', crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 2 章 入镇' }] };
    ui.post({ type: 'editorOpen', file: file('chapters/002-入镇.md', '# 入镇\n\n正文', { kind: 'chapter', label }) });
  });

  test('标签条末尾「保存」「⋯」；「保存」亮灭跟着工具栏那颗，点了就是保存', async () => {
    assert.ok(save() && tools());
    assert.equal(save().disabled, true);
    const area = ui.doc.getElementById('edArea');
    area.value = '# 入镇\n\n正文，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(save().disabled, false);
    ui.clickEl(save());
    assert.equal(ui.last('saveFile').text, '# 入镇\n\n正文，改了');
  });

  test('「↶」「↷」：改了一笔之后「↶」亮，点了撤回去、「↷」亮，再点做回来；按下去不夺焦点（打字时软键盘不收）', async () => {
    const undo = ui.doc.querySelector('#edTabs .ed-tabs-undo');
    const redo = ui.doc.querySelector('#edTabs .ed-tabs-redo');
    const area = ui.doc.getElementById('edArea');
    assert.equal(undo.disabled, false, '上一条改过一笔');
    assert.equal(redo.disabled, true);
    const down = new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    undo.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    ui.clickEl(undo);
    await wait();
    assert.equal(area.value, '# 入镇\n\n正文');
    assert.equal(redo.disabled, false);
    ui.clickEl(redo);
    await wait();
    assert.equal(area.value, '# 入镇\n\n正文，改了');
    assert.equal(redo.disabled, true);
  });

  test('「⋯」列工具栏的按钮：不列「保存」，不列面包屑里的目录段；点一项就是点那颗', () => {
    ui.clickEl(tools());
    const items = menuItems(ui);
    assert.ok(items.includes('预览') && items.includes('还原'), items.join(' / '));
    assert.equal(items.includes('保存'), false);
    const crumbs = [...ui.doc.querySelectorAll('#edPath button')].map((b) => b.textContent);
    assert.ok(crumbs.length > 0, '面包屑里没有目录段，这一条测不到');
    for (const c of crumbs) {
      assert.equal(items.includes(c), false, `面包屑的「${c}」混进了菜单`);
    }
    pickMenu(ui, '预览');
    assert.equal(ui.doc.getElementById('edPreview').classList.contains('hidden'), false);
    ui.clickEl(tools());
    pickMenu(ui, '编辑');
  });

  test('「⋯」最后一项「补全名词」：与 Alt+/、「视图 → 名词补全」同一条路', () => {
    ui.clickEl(tools());
    assert.equal(menuItems(ui).at(-1), '补全名词');
    const got = [];
    ui.window.addEventListener('nf-names-command', (e) => got.push(e.detail.name), { once: true });
    pickMenu(ui, '补全名词');
    assert.deepEqual(got, ['trigger']);
  });

  test('章节条「操作 ▾」：列那一排动作、带调用次数、亮灭照旧；上一章 / 下一章的字还在（窄屏只是藏起来）', () => {
    const menuBtn = bar().querySelector('.ed-chapter-menu');
    assert.ok(menuBtn);
    assert.equal(bar().querySelector('[data-nav="prev"]').textContent, '‹ 上一章');
    ui.clickEl(menuBtn);
    const buttons = [...ui.doc.querySelectorAll('.ctx-menu button')];
    const write = buttons.find((b) => b.textContent.startsWith('写这一章'));
    const cont = buttons.find((b) => b.textContent.startsWith('接着写'));
    assert.match(cont.textContent, /^接着写（预计 1–2 次调用）$/);
    assert.equal(write.disabled, true);
    assert.equal(cont.disabled, false);
    ui.closeMenu();
  });

  test('点「接着写」：发 chapterAction，编辑区收下去（生成在对话页）', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.clickEl(bar().querySelector('.ed-chapter-menu'));
    pickMenu(ui, '接着写');
    assert.equal(ui.last('chapterAction').action, 'continue');
    assert.equal(editorOpen(ui), false);
  });

  test('窄屏上要开在第二块的（并排的细纲、草稿）：开在主区，成了另一个标签', () => {
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('.novelforge/summaries/002-入镇.md', '# 细纲', { kind: 'plot' }) });
    assert.equal(ui.doc.querySelector('.wb-editor-draft'), null, '不该造出第二块');
    const tabs = [...ui.doc.querySelectorAll('#edTabs .ed-tab')].map((t) => t.textContent);
    assert.equal(tabs.length, 2, tabs.join(' / '));
  });
});

describe('触屏：能打字的框里长按走系统菜单；状态栏不提 Ctrl+S', { skip: JSDOM_SKIP }, () => {
  test('手指长按对话输入框：不弹我们的菜单、不拦默认动作；鼠标右键照旧是我们的菜单', () => {
    const ui = phone(['view.js']);
    const input = ui.doc.getElementById('input');
    input.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const ev = new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    input.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
    input.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    assert.ok(ui.rightClick(input));
  });

  test('手机、平板上状态栏写「● 未保存」，不带（Ctrl+S）；桌面带', async () => {
    const ui = phone();
    ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '第一章', { kind: 'chapter' }) });
    const area = ui.doc.getElementById('edArea');
    const state = () => ui.doc.getElementById('edStatusSave').textContent;
    area.value = '第一章，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(state(), '● 未保存（Ctrl+S）');
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none|max-width:\s*900px/.test(q), addEventListener() {}, removeEventListener() {} });
    area.value = '第一章，又改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(state(), '● 未保存');
  });
});

describe('窄屏：「打开这一章」不要并排的那一份', { skip: JSDOM_SKIP }, () => {
  test('工程页点章节名：openChapter 带 beside: false；宽屏不带', () => {
    const label = (ui) =>
      [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-label')].find((l) => l.textContent.includes('夜访'));
    const narrowUi = phone(['view.js']);
    narrowUi.post({ type: 'project', tree: sampleTree() });
    narrowUi.clickEl(label(narrowUi));
    assert.equal(narrowUi.last('openChapter').beside, false);

    const wideUi = mount({ body: 'standalone', scripts: ['view.js'], url: URL });
    wideUi.post({ type: 'state', state: viewState() });
    wideUi.post({ type: 'project', tree: sampleTree() });
    wideUi.clickEl(label(wideUi));
    assert.equal('beside' in wideUi.last('openChapter'), false);
  });
});
