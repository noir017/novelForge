/**
 * 专注（`media/src/editor/focus.ts` / `typewriter.ts` / `paragraphFocus.ts`，菜单那一半在 `view/lookMenu.ts`）：
 * 专注模式、全屏、打字机滚动、段落聚焦。认段落、算滚动目标的纯函数在 tests/unit/editor/focusCore.test.js。
 *
 * jsdom 没有排版：打字机滚动用 `mirrorLayout` 那份假排版（量位置那一份镜像里第 k 行的顶 = 18 + 30k，视口 300），
 * 只验「调了没有、滚到的目标对不对」；段落聚焦验镜像层上那一层 `<mark>` 包的是不是光标那一段。
 * jsdom 也没有 Fullscreen API——正好验「不支持就置灰」，支持的那一面在页面上补一个假的。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 「视图」菜单 | 第三组「专注」：专注模式（F8）/ 全屏 / 打字机滚动 / 段落聚焦，开着的打 ✓ |
 * | 全屏 | 不支持时置灰、提示说不支持；支持时点了请求全屏、全屏中打 ✓、再点退出 |
 * | 专注模式 | 进出（菜单、F8、Esc）；Esc 先收查找条；组字中的 F8 不算；两块编辑区只专注当前那一块、当前那一块换了跟过去；记在偏好里、刷新还在 |
 * | 打字机滚动 | 打字、回车、方向键之后把光标那一行滚到视口中间；组字中途不滚、上屏才滚；滚轮翻看与点击不拉回、下一次打字才回来；关着不滚；底下垫半屏 |
 * | 段落聚焦 | 开了 textarea 调淡、镜像层 focus 图层包着光标那一段；换段跟着换；打字之后包进新字；按三种分段格式认；非正文不做；与查找高亮叠得上；关掉撤干净 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, viewState } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
/** 等两帧（jsdom 没有 rAF，退回 16ms 定时器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

function harness(opts = {}) {
  const { shims = SHIMS, ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims, ...rest });
  const main = () => ui.doc.getElementById('wbEditor');
  const draft = () => ui.doc.querySelector('.wb-editor-draft');
  const area = (root = main()) => root.querySelector('textarea.ed-area');
  const open = (p, text, extra, msg) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'chapter', ...extra }), ...msg });
  const key = (target, init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const viewMenu = () => {
    ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
    return ui.doc.querySelector('.wb-menu-drop');
  };
  const closeBar = () => ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  /** 「视图」里那一项（开着菜单拿完就收）。 */
  const entry = (label) => {
    const btn = [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    closeBar();
    return btn;
  };
  const pickMenu = (label) => {
    const btn = [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    assert.ok(btn, `「视图」里没有「${label}」`);
    ui.clickEl(btn);
  };
  const focusOn = () => ui.doc.body.classList.contains('nf-focus');
  /** 在光标处打一个字（与真的打字一样：先改 value、落光标，再发 input）。 */
  const type = (a, text, init = {}) => {
    const at = a.selectionStart;
    a.value = a.value.slice(0, at) + text + a.value.slice(a.selectionEnd);
    a.setSelectionRange(at + text.length, at + text.length);
    a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', ...init }));
  };
  return { ui, main, draft, area, open, key, viewMenu, closeBar, entry, pickMenu, focusOn, type };
}

describe('专注：「视图」菜单那一组', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。');
  });

  test('第三组「专注」：专注模式（F8）、全屏、打字机滚动、段落聚焦，缺省都没打 ✓', () => {
    const drop = h.viewMenu();
    const groups = [[]];
    for (const node of drop.children) {
      if (node.classList.contains('wb-menu-sep')) {
        groups.push([]);
      } else {
        const kbd = node.querySelector('.wb-menu-kbd')?.textContent;
        groups[groups.length - 1].push(`${node.querySelector('.wb-menu-label').textContent}${kbd ? `|${kbd}` : ''}|${node.getAttribute('aria-checked')}`);
      }
    }
    h.closeBar();
    assert.deepEqual(groups[2], ['专注模式|F8|false', '全屏|false', '打字机滚动|false', '段落聚焦|false']);
  });

  test('jsdom 没有 Fullscreen API：「全屏」置灰，提示说不支持', () => {
    const btn = h.entry('全屏');
    assert.deepEqual([btn.disabled, btn.title], [true, '这个浏览器（或窗口）不支持全屏。']);
  });

  test('点「打字机滚动」：打 ✓', () => {
    h.pickMenu('打字机滚动');
    assert.equal(h.entry('打字机滚动').getAttribute('aria-checked'), 'true');
  });

  test('点「段落聚焦」：打 ✓', () => {
    h.pickMenu('段落聚焦');
    assert.equal(h.entry('段落聚焦').getAttribute('aria-checked'), 'true');
  });
});

describe('专注：全屏（能力探测）', { skip: JSDOM_SKIP }, () => {
  let h;
  const calls = [];
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。');
    // 补一个假的 Fullscreen API：浏览器支持全屏的那一面。
    const { doc } = h.ui;
    let element = null;
    Object.defineProperty(doc, 'fullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => element });
    doc.documentElement.requestFullscreen = () => {
      calls.push('request');
      element = doc.documentElement;
      return Promise.resolve();
    };
    doc.exitFullscreen = () => {
      calls.push('exit');
      element = null;
      return Promise.resolve();
    };
  });

  test('支持时「全屏」不置灰', () => {
    assert.equal(h.entry('全屏').disabled, false);
  });

  test('点了请求整个页面全屏', () => {
    h.pickMenu('全屏');
    assert.deepEqual(calls, ['request']);
  });

  test('全屏中打 ✓', () => {
    assert.equal(h.entry('全屏').getAttribute('aria-checked'), 'true');
  });

  test('再点一次退出全屏', () => {
    h.pickMenu('全屏');
    assert.deepEqual([calls, h.entry('全屏').getAttribute('aria-checked')], [['request', 'exit'], 'false']);
  });

  test('全屏不记进偏好（刷新回到窗口）', () => {
    // 内存里那份偏好：专注那三项都还是关的，没有 fullscreen 这一项。
    assert.equal(h.focusOn(), false);
  });
});

describe('专注：专注模式进出', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。\n\n林昭推门。');
  });

  test('「视图 → 专注模式」：body 挂 nf-focus，当前那一块挂 ed-focused', () => {
    h.pickMenu('专注模式');
    assert.deepEqual([h.focusOn(), h.main().classList.contains('ed-focused')], [true, true]);
  });

  test('菜单上打 ✓', () => {
    assert.equal(h.entry('专注模式').getAttribute('aria-checked'), 'true');
  });

  test('编辑区里按 Esc：退出', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([ev.defaultPrevented, h.focusOn(), h.main().classList.contains('ed-focused')], [true, false, false]);
  });

  test('F8 进、再按 F8 出', () => {
    const ev = h.key(h.area(), { key: 'F8' });
    const entered = h.focusOn();
    h.key(h.area(), { key: 'F8' });
    assert.deepEqual([ev.defaultPrevented, entered, h.focusOn()], [true, true, false]);
  });

  test('焦点在对话输入框里也认 F8（那里它没有别的用处）', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    h.key(input, { key: 'F8' });
    const on = h.focusOn();
    h.key(input, { key: 'F8' });
    assert.equal(on, true);
  });

  test('从被藏起来的地方（对话输入框）进专注模式：焦点放进正文，不落在看不见的框里', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    h.key(input, { key: 'F8' });
    const focused = h.ui.doc.activeElement;
    h.key(h.area(), { key: 'F8' });
    assert.equal(focused, h.area());
  });

  test('输入法组字中的 F8 不算', () => {
    h.area().focus();
    h.key(h.area(), { key: 'F8', isComposing: true });
    assert.equal(h.focusOn(), false);
  });

  test('带修饰键的 F8 不算', () => {
    h.key(h.area(), { key: 'F8', ctrlKey: true });
    assert.equal(h.focusOn(), false);
  });

  test('Esc 先收查找条：查找条开着时只收它，再按一次才退出专注模式', () => {
    h.key(h.area(), { key: 'F8' });
    h.key(h.area(), { key: 'f', ctrlKey: true });
    h.area().focus();
    h.key(h.area(), { key: 'Escape' });
    const bar = h.main().querySelector('.ed-find');
    const after1 = [bar.classList.contains('hidden'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [true, true, false]);
  });

  test('菜单开着时 Esc 只收菜单，不连带退出专注模式', () => {
    h.key(h.area(), { key: 'F8' });
    h.viewMenu();
    h.key(h.area(), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.wb-menu-drop'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('外观面板开着时 Esc 只收面板', () => {
    h.key(h.area(), { key: 'F8' });
    h.pickMenu('外观设置…');
    h.key(h.ui.doc.querySelector('.ed-look-font'), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.ed-look'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('专注模式下状态栏淡成一行，码字统计那一格照样点得开面板', () => {
    h.key(h.area(), { key: 'F8' });
    const status = h.main().querySelector('.ed-status');
    h.ui.clickEl(h.ui.doc.getElementById('edStatusWords'));
    const panel = h.ui.doc.querySelector('.ed-stats-panel');
    assert.deepEqual([h.focusOn(), status.classList.contains('hidden'), !!panel, panel?.parentElement], [true, false, true, h.ui.doc.body]);
  });

  test('码字统计面板开着时 Esc 先收面板，再按一次才退出专注模式', () => {
    h.area().focus();
    h.key(h.area(), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.ed-stats-panel'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('没开专注模式时 Esc 什么都不拦', () => {
    const ev = h.key(h.area(), { key: 'Escape' });
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('专注：两块编辑区只专注当前那一块', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '正文。');
    h.open('.novelforge/summaries/001.md', '细纲。', { kind: 'plot' }, { pane: 'draft' });
  });

  test('右边那一块是当前的：专注它，左边那块不挂', () => {
    h.key(h.area(h.draft()), { key: 'F8' });
    assert.deepEqual(
      [h.draft().classList.contains('ed-focused'), h.main().classList.contains('ed-focused')],
      [true, false]
    );
  });

  test('当前那一块换了（从别处打开了左边的文件）：专注跟过去', () => {
    h.open('chapters/002.md', '第二章。');
    assert.deepEqual(
      [h.main().classList.contains('ed-focused'), h.draft().classList.contains('ed-focused')],
      [true, false]
    );
  });

  test('退出之后两块都不挂', () => {
    h.key(h.area(), { key: 'F8' });
    assert.equal(h.ui.doc.querySelectorAll('.ed-focused').length, 0);
  });
});

describe('专注：开关记在偏好里', { skip: JSDOM_SKIP }, () => {
  test('三个开关记进 novelforge.editor.prefs（与成对符号同一处）', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ autoPair: false }) } });
    h.open('chapters/001.md', '雨夜。');
    h.pickMenu('专注模式');
    h.pickMenu('打字机滚动');
    h.pickMenu('段落聚焦');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual(
      [saved.autoPair, saved.focusMode, saved.typewriter, saved.paragraphFocus, 'fullscreen' in saved],
      [false, true, true, true, false]
    );
  });

  test('关掉就从偏好里删掉那一项', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: true }) } });
    h.open('chapters/001.md', '雨夜。');
    h.pickMenu('专注模式');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.equal('focusMode' in saved, false);
  });

  test('刷新之后还在专注模式里', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: true, typewriter: true }) } });
    h.open('chapters/001.md', '雨夜。');
    assert.deepEqual(
      [h.focusOn(), h.main().classList.contains('ed-focused'), h.ui.doc.body.classList.contains('nf-typewriter')],
      [true, true, true]
    );
  });

  test('写坏的值（"true"）当关', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: 'true' }) } });
    assert.equal(h.focusOn(), false);
  });
});

describe('专注：打字机滚动', { skip: JSDOM_SKIP }, () => {
  let h;
  const { line, pad, viewport } = MIRROR_LAYOUT;
  /** 第 k 行（从 0 起）的中线滚到视口中间时的 scrollTop。 */
  const centered = (k) => Math.max(0, Math.round(pad + k * line + line / 2 - viewport / 2));
  const TEXT = Array.from({ length: 60 }, (_, i) => `第${i}行。`).join('\n');
  /** 编辑区里**当下**第 k 行（从 0 起）的行首（打过回车之后行号会挪）。 */
  const lineStart = (k) => {
    const lines = h.area().value.split('\n');
    return lines.slice(0, k).join('\n').length + (k > 0 ? 1 : 0);
  };

  before(() => {
    h = harness({ shims: [...SHIMS, 'mirrorLayout'] });
    h.open('chapters/001.md', TEXT);
    h.pickMenu('打字机滚动');
  });

  test('开着时 body 挂 nf-typewriter（编辑区底下垫半屏）', () => {
    assert.equal(h.ui.doc.body.classList.contains('nf-typewriter'), true);
  });

  test('打字之后：光标那一行滚到视口中间', async () => {
    const a = h.area();
    a.focus();
    a.setSelectionRange(lineStart(20) + 2, lineStart(20) + 2);
    a.scrollTop = 0;
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, centered(20));
  });

  test('回车之后：新的那一段滚到中间（空行分段：回车另起一段，中间空一行）', async () => {
    const a = h.area();
    h.key(a, { key: 'Enter' });
    await frames();
    assert.equal(a.scrollTop, centered(22));
  });

  test('方向键挪了光标：下一帧滚过去', async () => {
    const a = h.area();
    // keydown 时浏览器还没挪光标（jsdom 不挪）：先把光标放到第 30 行，再发那一下方向键。
    a.setSelectionRange(lineStart(30), lineStart(30));
    h.key(a, { key: 'ArrowDown' });
    await frames();
    assert.equal(a.scrollTop, centered(30));
  });

  test('组字中途不滚，上屏那一下才滚', async () => {
    const a = h.area();
    a.setSelectionRange(lineStart(40), lineStart(40));
    a.scrollTop = 7;
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    h.type(a, 'lin', { inputType: 'insertCompositionText', isComposing: true });
    h.key(a, { key: 'ArrowDown', isComposing: true });
    await frames();
    const during = a.scrollTop;
    a.value = a.value.replace('lin', '林');
    a.setSelectionRange(lineStart(40) + 1, lineStart(40) + 1);
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林' }));
    await frames();
    assert.deepEqual([during, a.scrollTop], [7, centered(40)]);
  });

  test('用滚轮翻看前文：不拉回来（点一下也不）', async () => {
    const a = h.area();
    a.scrollTop = 0;
    a.dispatchEvent(new h.ui.window.Event('scroll'));
    a.dispatchEvent(new h.ui.window.WheelEvent('wheel', { bubbles: true, deltaY: -300 }));
    a.dispatchEvent(new h.ui.window.MouseEvent('mouseup', { bubbles: true }));
    a.dispatchEvent(new h.ui.window.MouseEvent('click', { bubbles: true }));
    await frames();
    assert.equal(a.scrollTop, 0);
  });

  test('下一次打字才回到光标那里', async () => {
    const a = h.area();
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, centered(40));
  });

  test('焦点不在编辑区（别处改写了正文）：不滚', async () => {
    const a = h.area();
    a.scrollTop = 3;
    h.ui.doc.getElementById('input').focus();
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, 3);
  });

  test('关掉之后：打字不滚', async () => {
    h.pickMenu('打字机滚动');
    const a = h.area();
    a.focus();
    a.setSelectionRange(lineStart(50), lineStart(50));
    a.scrollTop = 5;
    h.type(a, '字');
    await frames();
    assert.deepEqual([a.scrollTop, h.ui.doc.body.classList.contains('nf-typewriter')], [5, false]);
  });
});

describe('专注：段落聚焦', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '第一段。\n\n第二段前半，\n续行。\n\n第三段。';
  /** 镜像层上 focus 那一层包着的字（可能被查找高亮切成几截，拼起来）。 */
  const focused = (root = h.main()) =>
    [...root.querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark.ed-hl-focus')].map((m) => m.textContent).join('');
  const dimmed = (root = h.main()) => h.area(root).classList.contains('ed-para-dim');
  const moveTo = (a, at) => {
    a.setSelectionRange(at, at);
    a.dispatchEvent(new h.ui.window.KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  before(() => {
    h = harness();
    h.open('chapters/001.md', TEXT);
    const a = h.area();
    a.focus();
    a.setSelectionRange(TEXT.indexOf('续行'), TEXT.indexOf('续行'));
  });

  test('关着时：不调淡、镜像层上没有这一层', () => {
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('打开：textarea 的字调淡，镜像层用实色画光标那一段', () => {
    h.pickMenu('段落聚焦');
    assert.deepEqual([dimmed(), focused()], [true, '第二段前半，\n续行。']);
  });

  test('光标换到别的段：图层跟着换', () => {
    moveTo(h.area(), TEXT.indexOf('第三段'));
    assert.equal(focused(), '第三段。');
  });

  test('鼠标点过去也换', () => {
    const a = h.area();
    a.setSelectionRange(1, 1);
    a.dispatchEvent(new h.ui.window.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(focused(), '第一段。');
  });

  test('打字之后：新打的字也在这一段里（同一轮就画好，不闪）', async () => {
    const a = h.area();
    a.setSelectionRange(4, 4);
    h.type(a, '雨');
    await flush();
    assert.equal(focused(), '第一段。雨');
  });

  test('输入法组字中途：拼音也算在这一段里', async () => {
    const a = h.area();
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    h.type(a, 'xia', { inputType: 'insertCompositionText', isComposing: true });
    await flush();
    const during = focused();
    a.value = a.value.replace('xia', '下');
    a.setSelectionRange(6, 6);
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '下' }));
    await flush();
    assert.deepEqual([during, focused()], ['第一段。雨xia', '第一段。雨下']);
  });

  test('光标在空行上（新起的一段还没有字）：哪一段都不画实色', () => {
    moveTo(h.area(), h.area().value.indexOf('\n\n') + 1);
    assert.deepEqual([dimmed(), focused()], [true, '']);
  });

  test('与查找高亮叠得上：两层的 class 落在同一段字上', async () => {
    const a = h.area();
    moveTo(a, a.value.indexOf('第三段'));
    h.key(a, { key: 'f', ctrlKey: true });
    const input = h.main().querySelector('.ed-find-input');
    input.value = '三';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    const both = [...h.main().querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')].find(
      (m) => m.classList.contains('ed-hl-focus') && m.classList.contains('ed-hl-find-current')
    );
    assert.deepEqual([both?.textContent, focused()], ['三', '第三段。']);
    h.key(input, { key: 'Escape' });
  });

  test('按工程的分段格式认：段首缩进时，有缩进的那一行另起一段', () => {
    h.ui.post({ type: 'state', state: viewState({ paragraphStyle: 'indent' }) });
    const text = '　　甲段，\n续行。\n　　乙段。';
    h.open('chapters/002.md', text);
    const a = h.area();
    a.focus();
    moveTo(a, text.indexOf('续行'));
    const first = focused();
    moveTo(a, text.indexOf('乙段'));
    assert.deepEqual([first, focused()], ['　　甲段，\n续行。', '　　乙段。']);
  });

  test('非正文（角色卡、细纲）不做：不调淡、没有这一层', () => {
    h.open('.novelforge/characters/林昭.md', '# 林昭\n\n主角。', { kind: 'character' });
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('切回正文又有了', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('002')));
    assert.deepEqual([dimmed(), focused() !== ''], [true, true]);
  });

  test('预览里不画（textarea 藏着）', () => {
    h.open('chapters/003.md', '甲。\n\n乙。');
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    const inPreview = [dimmed(), focused()];
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.deepEqual([...inPreview, dimmed()], [false, '', true]);
  });

  test('超过 30 万字不画，也不调淡（不至于整篇都是淡字）', () => {
    h.open('chapters/004.md', `${'字'.repeat(300_001)}`);
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('关掉：调淡撤掉、图层清掉', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('003')));
    h.pickMenu('段落聚焦');
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('右边那一块各认各的光标', () => {
    h.pickMenu('段落聚焦');
    h.open('drafts/001.md', '草稿甲。\n\n草稿乙。', { kind: 'draft' }, { pane: 'draft' });
    const a = h.area(h.draft());
    a.focus();
    moveTo(a, a.value.indexOf('草稿乙'));
    assert.deepEqual([focused(h.draft()), dimmed(h.draft())], ['草稿乙。', true]);
  });
});
