/**
 * 触屏与手机窄屏（2026-10-24，Android 壳实测之后）：样式里那几条能力探测的规矩、右键菜单与标题栏下拉整个落在可视区里、
 * 工程页三只悬停浮窗在手指下的入口（长按菜单最前面的「看一眼」、点感叹号）、窄屏上把欢迎页翻上来。
 * 摆位置的几何本身在 tests/unit/view/menuPlace.test.js；名词浮窗与叙事线总览的触屏交互在 nameMarks.test.js / threadsOverview.test.js；
 * 标题栏的书名在 welcome.test.js；窄屏底栏、标题栏「⋯」、返回键与编辑区顶上两行的交互在 mobileNav.test.js。真浏览器（360×640 触屏、1440×860 桌面）与 Android 真机的核对见 media/README.md「触屏与窄屏」。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 样式 | 整页的列不被 min-content 撑开；`(hover: none)` 里整页不选字、正文与要复制的那几样照常能选、悬停才露的东西常显、不提快捷键、不显示「外部打开」；`(pointer: coarse)`（与没登记指针的 `(pointer: none)`）里点击目标放大、文字按钮的点击区往四周借；窄屏上活动栏成了底栏（文件 / 历史 / 日志 / 设置收进「更多」）、标题栏藏菜单栏、编辑区顶上只留标签条与章节条、提示条浮在底栏上；软键盘弹着（kb-open）或可视高度很矮时、正在打字就让出底栏与流水线条 / 章节条；宽屏上窄屏那几颗不出来；区分只用媒体查询，不认 UA；页头声明了 `interactive-widget=resizes-content` 与 `theme-color` |
 * | 右键菜单 | 下半屏放不下：往上翻 / 平移贴底；比可视区还高：压 max-height；桌面上右下角照旧往左上翻 |
 * | 标题栏下拉与子菜单 | 「帮助」的下拉伸出右边就往左收（与按钮右沿对齐）；子菜单右边放不下翻到左边、贴边；点一下父菜单项也展开子菜单；手指点之前补发的 mouseenter / mouseover 不展开子菜单、不换菜单（实机上一点父项就打开了最近的书、点「编辑」把菜单全关了） |
 * | 工程页的「看一眼」 | 手指长按章节行：最前面「细纲速览」（挂着失败的还有「看失败原因」），点了钉住浮窗、按在外面才收；鼠标右键没有这几项；手指点之后补发的 mouseover 不弹浮窗；手指点感叹号钉住失败浮窗，鼠标点不弹；说明被截断的行长按有「看完整说明」 |
 * | 窄屏的欢迎页 | 空窗口与「帮助 → 欢迎页面」把编辑区那层覆盖翻上来；打开一本书之后收起；宽屏不碰 |
 * | 不顺手聚焦 | 手指点「对话」页签、手机上一载入、手指点编辑器页签切文件：都不把焦点放进输入框 / 正文区（一聚焦就弹软键盘）；鼠标照旧聚焦 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, sampleTree, viewState, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 产物里某个 @media 块的内容（按花括号配对）。 */
function mediaBlocks(css, query) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at < 0) {
      return out;
    }
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i;
  }
}

describe('触屏与窄屏：样式', { skip: JSDOM_SKIP }, () => {
  const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
  const hoverNone = mediaBlocks(css, '(hover: none)').join('\n');
  const coarse = mediaBlocks(css, '(pointer: coarse)').join('\n');
  const narrow = mediaBlocks(css, '(max-width: 900px)').join('\n');

  test('整页的列写死成 minmax(0, 1fr)、高度跟布局视口（100%），不被标题栏里不折行的路径撑宽', () => {
    const rule = /body\.workbench\s*\{[^}]*\}/.exec(css)[0];
    assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(rule, /height:\s*100%/);
    assert.doesNotMatch(rule, /100vh/);
  });

  test('(hover: none)：整页不选字；输入框、编辑区、预览、对话正文、浮窗、日志这些照常能选', () => {
    assert.match(hoverNone, /body\.workbench\s*\{[^}]*user-select:\s*none/);
    const reopen = /body\.workbench :is\(([^)]*)\)\s*\{[^}]*user-select:\s*text/.exec(hoverNone);
    assert.ok(reopen, '没有重新打开选字的那一条');
    for (const sel of ['input', 'textarea', '.ed-preview', '.msg-body', '.gen-body', '.summary-tip', '.failure-tip', '.log-msg']) {
      assert.ok(reopen[1].includes(sel), `${sel} 应该能选字`);
    }
  });

  test('(hover: none)：悬停才露出来的行内按钮、⋯、标签上的 × 常显', () => {
    assert.match(hoverNone, /\.row-actions\s*\{[^}]*opacity:\s*1/);
    assert.match(hoverNone, /\.msg-menu-btn\s*\{[^}]*opacity/);
    assert.match(hoverNone, /\.ed-tab \.ed-tab-close\s*\{[^}]*opacity/);
  });

  test('(pointer: coarse)：菜单项、树的行、页签、图标按钮放大到 40px 上下；标题栏加高（窄屏覆盖层跟着它的变量走）', () => {
    assert.match(coarse, /\.wb-menu-item\s*\{[^}]*height:\s*40px/);
    assert.match(coarse, /\.ctx-menu button,\s*\.msg-menu button\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.row\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.fx-row\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.icon-btn\s*\{[^}]*min-width:\s*40px/);
    assert.match(coarse, /--nf-title-height:\s*44px/);
    assert.match(narrow, /inset:\s*var\(--nf-title-height\) 0 var\(--nf-nav-height\)/);
  });

  test('放大点击目标那一段也认 (pointer: none)（Android 模拟器 / 容器里没有登记触屏）', () => {
    assert.match(css, /@media \(pointer: coarse\),\s*\(pointer: none\)/);
  });

  test('窄屏 + 可视高度很矮（横屏或软键盘弹出来）：焦点在对话输入框里收起底栏、流水线条、下一步、输入框底下那行小字；在编辑区里收起章节条、工具栏与底栏', () => {
    const short = mediaBlocks(css, '(max-width: 900px) and (max-height: 480px)').join('\n');
    assert.match(short, /body\.workbench:has\(#input:focus\) :is\(\.tabbar, \.pipeline, \.nextstep, \.composer-meta\)\s*\{[^}]*display:\s*none/);
    assert.match(short, /body\.workbench:has\(\.ed-area:focus\) :is\(\.ed-chapter-bar, \.ed-toolbar, \.tabbar\)\s*\{[^}]*display:\s*none/);
    assert.match(short, /--nf-nav-height:\s*0px/);
  });

  test('窄屏 + 软键盘弹着（kb-open）：底栏让出来、编辑区落到底；在正文里打字时标题栏、章节条也让出来，编辑区顶到最上面；对话页让出流水线条', () => {
    assert.match(narrow, /body\.kb-open\s*\{[^}]*--nf-nav-height:\s*0px/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\)\s*\{[^}]*--nf-title-height:\s*0px/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\) \.wb-title,/);
    assert.match(narrow, /body\.kb-open \.tabbar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\) \.ed-chapter-bar,\s*body\.kb-open:has\(#input:focus\) :is\(\.pipeline, \.nextstep, \.composer-meta\)\s*\{[^}]*display:\s*none/);
  });

  test('窄屏：活动栏成了底栏（排到侧栏下面），文件 / 历史 / 日志 / 设置收进「更多」；标题栏藏菜单栏、露书名；编辑区顶上只留标签条与章节条', () => {
    assert.match(narrow, /\.workbench \.tabbar\s*\{[^}]*order:\s*1[^}]*height:\s*var\(--nf-nav-height\)/);
    // 构建会把属性值的引号去掉。
    assert.match(narrow, /\.workbench \.tab:is\(\[data-tab='?files'?\], \[data-tab='?history'?\], \[data-tab='?logs'?\], \[data-tab='?settings'?\]\)\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-menubar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-title-full\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-title-short\s*\{[^}]*display:\s*inline/);
    assert.match(narrow, /\.ed-toolbar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.ed-chapter-actions,\s*\.ed-chapter-nav-word\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.workbench \.toast\s*\{[^}]*bottom:\s*calc\(var\(--nf-nav-height\)/);
    assert.match(css, /\.wb-menu-btn\s*\{[^}]*white-space:\s*nowrap/);
    // 宽屏上这几颗都不出来。
    const wide = mediaBlocks(css, '(min-width: 901px)').join('\n');
    // 按钮要写成 button.…：button.primary / button.chip-btn 自带 display，只写类名压不过（桌面上露出来过）。
    assert.match(wide, /\.tab\[data-nav\],\s*#wbMoreBtn,\s*button\.ed-tabs-icon,\s*button\.ed-tabs-save,\s*button\.ed-tabs-tools,\s*button\.ed-chapter-menu\s*\{[^}]*display:\s*none/);
  });

  test('(hover: none)：能打字的框把整页关掉的长按 callout 还回来（走系统的选字菜单）', () => {
    assert.match(hoverNone, /body\.workbench :is\(input, textarea, \[contenteditable\]\)\s*\{[^}]*-webkit-touch-callout:\s*default/);
  });

  test('(hover: none)：快捷键提示与「外部打开」不显示；(pointer: coarse)：文字按钮的点击区往四周借', () => {
    assert.match(hoverNone, /\.wb-menu-kbd,\s*\.kbd-hint,[^{]*\{[^}]*display:\s*none/);
    assert.match(hoverNone, /\.ed-external-btn\s*\{[^}]*display:\s*none/);
    assert.match(coarse, /button\.link\s*\{[^}]*padding:\s*10px 4px;[^}]*margin:\s*-10px -2px/);
  });

  test('区分形态只用能力探测：样式里没有按 UA、按壳分的选择器；页面声明了键盘弹出时缩布局视口', () => {
    assert.doesNotMatch(css, /android|user-agent|data-shell/i);
    const { standalonePage } = require('../../helpers/load').loadModule('src/shells/standalone/page.ts');
    assert.match(standalonePage(), /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/);
    // 系统栏的颜色：手机浏览器与 Android 壳都按它染，换主题时页面改它（look.test.js「护眼主题」）
    assert.match(standalonePage(), /<meta name="theme-color" content="#[0-9a-f]{6}">/);
  });
});

/** 给右键菜单与标题栏的下拉装上尺寸：jsdom 里全是 0。 */
function sized(ui, sizes) {
  Object.defineProperty(ui.window, 'innerWidth', { get: () => 360, configurable: true });
  Object.defineProperty(ui.window, 'innerHeight', { get: () => 640, configurable: true });
  const pick = (node) => Object.entries(sizes).find(([cls]) => node.classList?.contains(cls))?.[1];
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return pick(this)?.w ?? 0;
    },
  });
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return pick(this)?.h ?? 0;
    },
  });
}

describe('触屏与窄屏：菜单整个落在可视区里（360×640）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const size = { w: 150, h: 476 };
  const menu = () => ui.doc.querySelector('.ctx-menu');
  const box = () => ({ left: parseFloat(menu().style.left), top: parseFloat(menu().style.top), maxHeight: menu().style.maxHeight });
  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
    sized(ui, { 'ctx-menu': size, submenu: { w: 260, h: 80 }, 'wb-menu-drop': { w: 220, h: 300 } });
  });

  test('下半屏长按、菜单比剩下的高：先往上翻；翻不下就平移到贴着底边，整个看得见', () => {
    size.h = 300;
    ui.rightClick(ui.doc.getElementById('messages'), 40, 560);
    assert.deepEqual(box(), { left: 40, top: 260, maxHeight: '' });
    ui.closeMenu();
    size.h = 476;
    ui.rightClick(ui.doc.getElementById('messages'), 40, 300);
    assert.deepEqual(box(), { left: 40, top: 640 - 4 - 476, maxHeight: '' });
    ui.closeMenu();
  });

  test('比整个可视区还高：从顶上开始、压 max-height（菜单里滚）；右边放不下往左翻', () => {
    size.h = 900;
    ui.rightClick(ui.doc.getElementById('messages'), 300, 400);
    assert.deepEqual(box(), { left: 150, top: 4, maxHeight: '632px' });
    ui.closeMenu();
  });

  test('「帮助」的下拉伸出右边就往左收；「打开最近打开的」子菜单右边放不下翻到左边、再不行贴边；点一下父项也展开', () => {
    const help = ui.doc.querySelector('[data-menu="help"]');
    help.getBoundingClientRect = () => ({ left: 300, right: 340, top: 0, bottom: 44, width: 40, height: 44 });
    ui.clickEl(help);
    const drop = ui.doc.querySelector('.wb-menu-drop');
    // 右边伸出去：与按钮右沿对齐（往左收）
    assert.equal(drop.style.left, `${340 - 220}px`);
    assert.equal(drop.style.top, '44px');
    ui.clickEl(help);

    ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
    const parent = [...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('打开最近打开的'));
    parent.getBoundingClientRect = () => ({ left: 4, right: 224, top: 200, bottom: 240, width: 220, height: 40 });
    ui.clickEl(parent);
    const sub = ui.doc.querySelector('.wb-menu-drop.submenu');
    assert.ok(sub, '点一下父菜单项就该展开子菜单（手指没有悬停）');
    assert.equal(sub.style.left, `${360 - 4 - 260}px`);
    assert.equal(sub.style.top, '200px');
    ui.closeMenu();
  });

  test('手指点子菜单的父项：点之前补发的 mouseenter 不展开（不然紧跟的 click 落到盖过来的子菜单项上），靠 click 展开', () => {
    const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
    const parent = [...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('打开最近打开的'));
    finger(parent);
    parent.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
    assert.equal(ui.doc.querySelector('.wb-menu-drop.submenu'), null);
    ui.clickEl(parent);
    assert.ok(ui.doc.querySelector('.wb-menu-drop.submenu'));
    ui.closeMenu();
  });

  test('开着「文件」时手指点「编辑」：换成「编辑」的下拉，不是全关掉；鼠标移过去照旧换', () => {
    const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const mouse = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    const file = ui.doc.querySelector('[data-menu="file"]');
    const edit = ui.doc.querySelector('[data-menu="edit"]');
    const dropText = () => ui.doc.querySelector('.wb-menu-drop')?.textContent ?? '';
    ui.clickEl(file);
    assert.match(dropText(), /新建一本书/);
    finger(edit);
    edit.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    ui.clickEl(edit);
    assert.match(dropText(), /撤销/);
    mouse(file);
    file.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(dropText(), /新建一本书/);
    ui.closeMenu();
  });
});

describe('触屏与窄屏：工程页浮窗在手指下的入口', { skip: JSDOM_SKIP }, () => {
  let ui;
  const CHAPTER = 'chapters/002-入镇.md';
  const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  const mouse = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const rowWith = (text) => [...ui.doc.querySelectorAll('#projectBody .row-plot[data-plot]')].find((n) => n.textContent.includes(text));
  const castRow = (text) => [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.querySelector('.row-label')?.textContent.includes(text) && n.querySelector('.row-detail'));
  const summaryTip = () => ui.doc.querySelector('.summary-tip');
  const failureTip = () => ui.doc.querySelector('.failure-tip');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
    const tree = sampleTree();
    tree.failures = { [CHAPTER]: [{ at: '2026-10-24T08:00:00.000Z', severity: 'error', message: '同步失败：模型返回无法解析' }] };
    ui.post({ type: 'state', state: viewState() });
    ui.post({ type: 'project', tree });
  });

  test('手指长按章节行：菜单最前面「细纲速览」，挂着失败的还有「看失败原因」；鼠标右键没有这几项', () => {
    finger(rowWith('入镇'));
    let menu = ui.rightClick(rowWith('入镇').querySelector('.row-label'));
    const items = ui.itemsOf(menu);
    assert.deepEqual(items.slice(0, 2), ['细纲速览', '看失败原因']);
    ui.closeMenu();
    mouse(rowWith('入镇'));
    menu = ui.rightClick(rowWith('入镇').querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu).includes('细纲速览'), false);
    assert.equal(ui.itemsOf(menu).includes('看失败原因'), false);
    ui.closeMenu();
  });

  test('「细纲速览」：钉住这一章的细纲浮窗、去要细纲；按在浮窗里不收，按在外面才收', async () => {
    ui.sent.length = 0;
    finger(rowWith('楔子'));
    ui.pick(ui.rightClick(rowWith('楔子').querySelector('.row-label')), '细纲速览');
    assert.ok(summaryTip());
    assert.equal(ui.last('requestSummary').plotRelPath, rowWith('楔子').dataset.plot);
    await wait(5);
    // 补发的兼容鼠标事件（移开）不收钉住的浮窗
    summaryTip().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
    ui.doc.getElementById('projectBody').dispatchEvent(new ui.window.MouseEvent('mouseleave'));
    await wait(400);
    assert.ok(summaryTip());
    finger(summaryTip());
    assert.ok(summaryTip(), '按在浮窗里（滚动、选字）不收');
    finger(ui.doc.body);
    assert.equal(summaryTip(), null);
  });

  test('手指点一下之后补发的 mouseover 不当悬停：过了延迟也不弹细纲浮窗', async () => {
    finger(rowWith('楔子'));
    rowWith('楔子').dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    await wait(600);
    assert.equal(summaryTip(), null);
    // 换回鼠标：照旧悬停就弹
    mouse(rowWith('楔子'));
    rowWith('楔子').dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    await wait(600);
    assert.ok(summaryTip());
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(summaryTip(), null);
  });

  test('手指点感叹号：钉住失败浮窗（不打开这一章）；鼠标点不弹', async () => {
    const mark = rowWith('入镇').querySelector('.row-failure');
    assert.ok(mark);
    ui.sent.length = 0;
    mouse(mark);
    ui.clickEl(mark);
    assert.equal(failureTip(), null);
    finger(mark);
    ui.clickEl(mark);
    assert.ok(failureTip());
    assert.match(failureTip().textContent, /同步失败：模型返回无法解析/);
    assert.equal(ui.last('openChapter'), undefined);
    await wait(5);
    finger(ui.doc.body);
    assert.equal(failureTip(), null);
  });

  test('说明被截断的行：长按有「看完整说明」，点了钉住那一行说明；没截断的没有', async () => {
    const row = castRow('林昭');
    assert.ok(row, '要一行带说明的角色行');
    const detail = row.querySelector('.row-detail');
    finger(row);
    let menu = ui.rightClick(row.querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu).includes('看完整说明'), false);
    ui.closeMenu();
    Object.defineProperty(detail, 'scrollWidth', { value: 300, configurable: true });
    Object.defineProperty(detail, 'clientWidth', { value: 100, configurable: true });
    finger(row);
    menu = ui.rightClick(row.querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu)[0], '看完整说明');
    ui.pick(menu, '看完整说明');
    assert.equal(ui.doc.querySelector('.detail-tip')?.textContent, detail.textContent);
    await wait(5);
    finger(ui.doc.body);
    assert.equal(ui.doc.querySelector('.detail-tip'), null);
  });
});

describe('触屏与窄屏：切页、打开文件不顺手聚焦输入框（手机上一聚焦就弹软键盘）', { skip: JSDOM_SKIP }, () => {
  const finger = (ui, node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  const mouse = (ui, node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const chatTab = (ui) => ui.doc.querySelector('.tab[data-tab="chat"]');
  const otherTab = (ui) => ui.doc.querySelector('.tab[data-tab="project"]');

  test('手指点「对话」页签：不聚焦输入框；鼠标点照旧聚焦', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'] });
    ui.post({ type: 'state', state: viewState() });
    const input = ui.doc.getElementById('input');
    ui.clickEl(otherTab(ui));
    input.blur();
    finger(ui, chatTab(ui));
    ui.clickEl(chatTab(ui));
    assert.notEqual(ui.doc.activeElement, input);
    ui.clickEl(otherTab(ui));
    mouse(ui, chatTab(ui));
    ui.clickEl(chatTab(ui));
    assert.equal(ui.doc.activeElement, input);
  });

  test('主指针不能悬停的设备（手机）：一载入停在对话页也不聚焦输入框', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'] });
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none/.test(q), addEventListener() {}, removeEventListener() {} });
    ui.doc.getElementById('input').blur();
    ui.post({ type: 'state', state: viewState() });
    ui.clickEl(otherTab(ui));
    ui.clickEl(chatTab(ui));
    assert.notEqual(ui.doc.activeElement, ui.doc.getElementById('input'));
  });

  test('手指点编辑器页签切文件：不把焦点放进正文区（点进正文才打字）；鼠标照旧', () => {
    const ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
      url: `http://localhost/?project=${encodeURIComponent('/书/青云剑录')}`,
    });
    const open = (p, text) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'chapter' }) });
    open('chapters/001-楔子.md', '第一章');
    open('chapters/002-入镇.md', '第二章');
    const area = ui.doc.getElementById('edArea');
    const tabOf = (name) => [...ui.doc.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
    area.blur();
    finger(ui, tabOf('楔子'));
    ui.clickEl(tabOf('楔子'));
    assert.equal(area.value, '第一章');
    assert.notEqual(ui.doc.activeElement, area);
    mouse(ui, tabOf('入镇'));
    ui.clickEl(tabOf('入镇'));
    assert.equal(area.value, '第二章');
    assert.equal(ui.doc.activeElement, area);
  });
});

describe('触屏与窄屏：窄屏上把欢迎页翻上来', { skip: JSDOM_SKIP }, () => {
  const open = (ui, id) =>
    ui.post({ type: 'workspaces', currentId: id, items: id ? [{ id, root: id, name: path.basename(id) }] : [], recents: [] });
  const editorOpen = (ui) => ui.doc.body.classList.contains('editor-open');

  test('窄屏：一打开就是空窗口——编辑区那层覆盖翻上来（欢迎页在里面）；打开一本书之后收起，露出侧栏', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], empty: true, shims: ['clipboard', 'scrollIntoView', 'narrow'] });
    assert.equal(editorOpen(ui), true, '装载时就是空窗口');
    open(ui, null);
    assert.equal(editorOpen(ui), true);
    open(ui, '/tmp/my-book');
    assert.equal(editorOpen(ui), false);
  });

  test('窄屏：「帮助 → 欢迎页面」也翻上来', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], shims: ['clipboard', 'scrollIntoView', 'narrow'] });
    open(ui, '/tmp/my-book');
    assert.equal(editorOpen(ui), false);
    ui.clickEl(ui.doc.querySelector('[data-menu="help"]'));
    ui.clickEl([...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('欢迎页面')));
    assert.equal(ui.doc.body.classList.contains('show-welcome'), true);
    assert.equal(editorOpen(ui), true);
  });

  test('宽屏：不碰 editor-open（编辑区常驻）', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], empty: true });
    ui.window.matchMedia = () => ({ matches: false });
    open(ui, null);
    assert.equal(editorOpen(ui), false);
  });
});
