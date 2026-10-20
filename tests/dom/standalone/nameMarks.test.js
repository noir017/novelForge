/**
 * 名词高亮与悬停浮窗（独立版内置编辑器，`media/src/editor/nameMarks.ts`；认哪几段是名字的口径在
 * tests/unit/editor/namesCore.test.js，镜像层分块在 find.test.js，真浏览器里对得齐、量得准的核对见文件末尾说明）。
 *
 * jsdom 没有排版：图层只测 DOM（`<mark>` 的字与 class）；浮窗与 Ctrl+点击要「鼠标底下是哪个字」，这里给镜像层装一份
 * 假排版（一行一块、每块 20px 高，每个字 10px 宽），按格子坐标指字。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 名词图层 | 打开正文就要名词表；表到了角色 / 设定 / 未建条目三种 class；打出一个名字同一轮里标上；撤销跟着；角色卡里不标它自己；配置文件不画；与体检叠在同一段字上两层 class 都在 |
 * | 浮窗 | 停够 400ms 才弹：名字、类型、别名命中写「这里写的是」、一句话、底下那一行；没停够就移开不弹；移到别处、打字、换文件就收起；拖选区时不弹 |
 * | Ctrl+点击 | 角色名、设定名在这一块打开卡或条目（按下被拦下）；未建条目说一句；不按 Ctrl 照常放光标；按住 Ctrl 指着能打开的名字时手形 |
 * | 「视图 → 名词高亮」 | 缺省开；关掉清图层、不弹浮窗、记进偏好且不冲掉别的；再开重画、删掉那一项；刷新之后照旧关着、也不去要名词表 |
 * | 样式 | names 图层只碰底色与下划线（不占排版），与体检一样重且排在它前面；三套主题都给了三个颜色 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const URL = `http://localhost/?project=${encodeURIComponent('/书/青云剑录')}`;
const PREFS_KEY = 'novelforge.editor.prefs';
const CH = 'chapters/001-楔子.md';
const CARD = '.novelforge/characters/林昭.md';
/** 等微任务跑完（图层在微任务里重算）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 等一帧多（鼠标在下一帧量；jsdom 没有 rAF，退回 16ms 定时器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));
/** 停够了（400ms）再多一点。 */
const dwell = () => new Promise((resolve) => setTimeout(resolve, 520));

const NAMES = {
  initialized: true,
  names: [
    { name: '林昭', aliases: ['阿昭'], source: 'character', category: '', brief: '青云宗外门弟子。', path: CARD },
    { name: '林昭阳', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/林昭阳.md' },
    { name: '沈怀山', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/沈怀山.md' },
    { name: '青云宗', aliases: ['青云门'], source: 'lore', category: '门派', brief: '正道第一大宗', path: '.novelforge/lore/门派/青云宗.md' },
    { name: '青崖镇', aliases: [], source: 'lore', category: '地点', brief: '', path: '.novelforge/lore/地点/青崖镇.md' },
    { name: '黑水河', aliases: [], source: 'unfiled', category: '地点', brief: '河上起了雾' },
  ],
};

/**
 * 给高亮镜像层（不含量位置用的那一份）一份假排版：镜像框 2000×2000；第 i 块占 y ∈ [20i, 20i+20)；块里第 k 个字占
 * x ∈ [10k, 10k+10)。`at(行, 列)` 给那个字中间的视口坐标。
 */
function fakeLayout(ui) {
  const proto = ui.window.Element.prototype;
  const rect0 = proto.getBoundingClientRect;
  const rects0 = proto.getClientRects;
  const LINE = 20;
  const CHAR = 10;
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const layoutOf = (node) => {
    if (!node.closest?.('.ed-mirror:not(.ed-mirror-probe)')) {
      return undefined;
    }
    if (node.classList.contains('ed-mirror')) {
      return box(0, 0, 2000, 2000);
    }
    const content = node.closest('.ed-mirror-content');
    if (node.parentElement === content) {
      return box(0, [...content.children].indexOf(node) * LINE, 2000, LINE);
    }
    if (node.tagName === 'MARK') {
      const block = node.parentElement;
      let offset = 0;
      for (const n of block.childNodes) {
        if (n === node) {
          break;
        }
        offset += n.textContent.length;
      }
      return box(offset * CHAR, [...content.children].indexOf(block) * LINE, node.textContent.length * CHAR, LINE);
    }
    return undefined;
  };
  proto.getBoundingClientRect = function () {
    return layoutOf(this) ?? rect0.call(this);
  };
  proto.getClientRects = function () {
    const r = layoutOf(this);
    return r ? [r] : rects0.call(this);
  };
  return (line, col) => ({ clientX: col * CHAR + CHAR / 2, clientY: line * LINE + LINE / 2 });
}

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const h = {
    ui,
    toasts,
    area,
    open(p, text, kind = 'chapter') {
      ui.post({ type: 'editorOpen', file: file(p, text, kind ? { kind } : undefined) });
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    /** 回最近那一次名词表请求。 */
    serve(index = NAMES, sig = 's1') {
      const req = ui.last('requestNameIndex');
      assert.ok(req, '应该发过 requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig, ...(index ? { index } : {}) });
    },
    /** names 图层上画着的：[字, 来源]。 */
    marks: () =>
      [...ui.doc.querySelectorAll('#wbEditor .ed-mirror:not(.ed-mirror-probe) mark')]
        .map((m) => [m.textContent, [...m.classList].find((c) => c.startsWith('ed-hl-name-'))])
        .filter(([, cls]) => cls)
        .map(([t, cls]) => [t, cls.replace('ed-hl-name-', '')]),
    /** 在光标处打几个字（一下一个字）。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + 1, s + 1);
        a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      }
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    mouse(type, point, init = {}) {
      const ev = new ui.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...point, ...init });
      area().dispatchEvent(ev);
      return ev;
    },
    tip: () => ui.doc.querySelector('.nm-tip'),
    tipText: (cls) => h.tip()?.querySelector(`.${cls}`)?.textContent,
    count: (type) => ui.sent.filter((m) => m.type === type).length,
  };
  return h;
}

describe('名词高亮：names 图层', { skip: JSDOM_SKIP }, () => {
  let h;
  before(async () => {
    h = harness();
    h.open(CH, '阿昭走进青云门，沈怀山在黑水河边等他。\n林昭阳看着林昭。');
  });

  test('打开一章正文就去要名词表；表到之前什么都不画', () => {
    assert.ok(h.ui.last('requestNameIndex'));
    assert.deepEqual(h.marks(), []);
  });

  test('表到了：角色、设定、未建条目三种 class；长的名字不被认成短的', async () => {
    h.serve();
    await flush();
    assert.deepEqual(h.marks(), [
      ['阿昭', 'character'],
      ['青云门', 'lore'],
      ['沈怀山', 'character'],
      ['黑水河', 'unfiled'],
      ['林昭阳', 'character'],
      ['林昭', 'character'],
    ]);
  });

  test('打出一个名字：同一轮里标上；撤销之后跟着拿掉', async () => {
    h.type('青崖镇');
    await flush();
    assert.deepEqual(h.marks().at(-1), ['青崖镇', 'lore']);
    h.key({ key: 'z', ctrlKey: true });
    await flush();
    await frames();
    assert.equal(h.marks().some(([t]) => t === '青崖镇'), false);
    assert.equal(h.marks().length, 6);
  });

  test('角色卡自己那一份里不标它自己（别名也不标），别的照标', async () => {
    h.open(CARD, '林昭，外号阿昭，青云宗弟子。', 'character');
    await flush();
    assert.deepEqual(h.marks(), [['青云宗', 'lore']]);
  });

  test('配置这类文件不画', async () => {
    h.open('.novelforge/config.md', '主角林昭。', 'setting');
    await flush();
    assert.deepEqual(h.marks(), []);
  });

  test('与写作体检叠在同一段字上：两层的 class 都在那一段上', async () => {
    h.ui.post({
      type: 'checkTerms',
      terms: { banned: ['青云门'], sensitive: [], sensitivePath: '.novelforge/sensitive.txt', sensitiveExists: false, sensitiveBad: [] },
    });
    h.open('chapters/002-下山.md', '他回到青云门。');
    await flush();
    const mark = [...h.ui.doc.querySelectorAll('#wbEditor .ed-mirror:not(.ed-mirror-probe) mark')].find((m) => m.textContent === '青云门');
    assert.ok(mark.classList.contains('ed-hl-name-lore'));
    assert.ok(mark.classList.contains('ed-hl-chk-banned'));
  });
});

describe('名词高亮：悬停浮窗与 Ctrl+点击', { skip: JSDOM_SKIP }, () => {
  let h;
  let at;
  before(async () => {
    h = harness();
    at = fakeLayout(h.ui);
    h.open(CH, '阿昭走进青云门。\n黑水河边。');
    h.serve();
    await flush();
  });

  test('停在名字上够 400ms：浮窗写正名、类型、别名命中、一句话、Ctrl+点击打开什么', async () => {
    h.mouse('mousemove', at(0, 1));
    await frames();
    assert.equal(h.tip(), null, '没停够不弹');
    await dwell();
    assert.ok(h.tip());
    assert.equal(h.tip().parentElement, h.ui.doc.body);
    assert.equal(h.tipText('nm-name'), '林昭');
    assert.equal(h.tipText('nm-badge'), '角色');
    assert.equal(h.tipText('nm-alias'), '这里写的是「阿昭」');
    assert.equal(h.tipText('nm-brief'), '青云宗外门弟子。');
    assert.equal(h.tipText('nm-foot'), 'Ctrl+点击打开角色卡');
  });

  test('在同一个名字里挪：不闪；移到没有名字的字上：收起', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    assert.ok(h.tip());
    h.mouse('mousemove', at(0, 3));
    await frames();
    assert.equal(h.tip(), null);
  });

  test('设定：分类做类型，关键词命中也写「这里写的是」，底下说打开设定条目', async () => {
    h.mouse('mousemove', at(0, 5));
    await frames();
    await dwell();
    assert.equal(h.tipText('nm-name'), '青云宗');
    assert.equal(h.tipText('nm-badge'), '门派');
    assert.equal(h.tipText('nm-alias'), '这里写的是「青云门」');
    assert.equal(h.tipText('nm-brief'), '正道第一大宗');
    assert.equal(h.tipText('nm-foot'), 'Ctrl+点击打开设定条目');
  });

  test('打字收起（光按 Ctrl 不算）', () => {
    assert.ok(h.tip());
    h.key({ key: 'Control', ctrlKey: true });
    assert.ok(h.tip());
    h.key({ key: 'a' });
    assert.equal(h.tip(), null);
  });

  test('未建条目：类型带「未建条目」，底下说还没建条目', async () => {
    h.mouse('mousemove', at(1, 0));
    await frames();
    await dwell();
    assert.equal(h.tipText('nm-name'), '黑水河');
    assert.equal(h.tipText('nm-badge'), '地点 · 未建条目');
    assert.equal(h.tipText('nm-brief'), '河上起了雾');
    assert.equal(h.tipText('nm-foot'), '设定名录里出现过，还没建条目');
  });

  test('移出编辑区：收起', () => {
    h.mouse('mouseleave', at(1, 0));
    assert.equal(h.tip(), null);
  });

  test('没停够就移开：不弹', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    h.mouse('mousemove', at(0, 3));
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('按着鼠标拖选区时不弹', async () => {
    h.mouse('mousemove', at(0, 0), { buttons: 1 });
    await frames();
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('按住 Ctrl 指着能打开的名字：手形；松开、指着未建条目：不是', async () => {
    h.mouse('mousemove', at(0, 0), { ctrlKey: true });
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), true);
    h.mouse('mousemove', at(0, 0));
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), false);
    h.mouse('mousemove', at(1, 0), { ctrlKey: true });
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), false);
  });

  test('Ctrl+点击角色名：在这一块打开角色卡，按下被拦下（不挪光标）', () => {
    const ev = h.mouse('mousedown', at(0, 0), { ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    const msg = h.ui.last('openEditor');
    assert.deepEqual([msg.path, msg.pane, 'preview' in msg], [CARD, 'main', false]);
  });

  test('Ctrl+点击设定名：打开设定条目', () => {
    h.mouse('mousedown', at(0, 4), { ctrlKey: true });
    assert.equal(h.ui.last('openEditor').path, '.novelforge/lore/门派/青云宗.md');
  });

  test('Ctrl+点击未建条目：说一句，不打开', () => {
    const before = h.count('openEditor');
    const ev = h.mouse('mousedown', at(1, 1), { ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.count('openEditor'), before);
    assert.match(h.toasts.at(-1), /「黑水河」还没建条目/);
  });

  test('不按 Ctrl 点名字、Ctrl+点别的字：照常（不拦、不打开）', () => {
    const before = h.count('openEditor');
    assert.equal(h.mouse('mousedown', at(0, 0)).defaultPrevented, false);
    assert.equal(h.mouse('mousedown', at(0, 3), { ctrlKey: true }).defaultPrevented, false);
    assert.equal(h.count('openEditor'), before);
  });

  test('换了文件：浮窗收起', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    await dwell();
    assert.ok(h.tip());
    h.open('chapters/002-别处.md', '这里什么都没有。');
    assert.equal(h.tip(), null);
  });
});

describe('「视图 → 名词高亮」', { skip: JSDOM_SKIP }, () => {
  let h;
  let at;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (label) =>
    [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(async () => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    at = fakeLayout(h.ui);
    h.open(CH, '阿昭走进青云门。');
    h.serve();
    await flush();
  });

  test('缺省开：打 ✓，紧跟在「边打边弹名词补全」后面，说明里写 Ctrl+点击', () => {
    const it = item('名词高亮');
    assert.ok(it);
    assert.equal(it.getAttribute('aria-checked'), 'true');
    assert.equal(it.previousElementSibling.querySelector('.wb-menu-label').textContent, '边打边弹名词补全');
    assert.match(it.title, /Ctrl\+点击/);
    h.ui.closeMenu();
  });

  test('关掉：图层清掉，记进偏好且不冲掉别的；指着名字也不弹', async () => {
    assert.equal(h.marks().length, 2);
    h.ui.clickEl(item('名词高亮'));
    h.ui.closeMenu();
    assert.deepEqual(h.marks(), []);
    assert.equal(storedPrefs().nameHighlight, false);
    assert.equal(storedPrefs().autoPair, false);
    h.mouse('mousemove', at(0, 0));
    await frames();
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('再打开：重画，偏好里删掉那一项', async () => {
    h.ui.clickEl(item('名词高亮'));
    h.ui.closeMenu();
    await flush();
    assert.equal(h.marks().length, 2);
    assert.equal('nameHighlight' in storedPrefs(), false);
    assert.equal(storedPrefs().autoPair, false);
  });

  test('刷新之后照旧关着：不画，也不去要名词表', async () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameHighlight: false }) } });
    again.open(CH, '阿昭走进青云门。');
    await flush();
    assert.equal(again.count('requestNameIndex'), 0);
    assert.deepEqual(again.marks(), []);
  });
});

describe('名词高亮：样式', { skip: JSDOM_SKIP }, () => {
  const css = () => fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');

  test('names 图层只碰底色与下划线（不占排版、不改字色），选择器与体检一样重、排在体检前面', () => {
    const text = css();
    const rules = [...text.matchAll(/([^{}]*ed-hl-name-[^{}]*)\{([^}]*)\}/g)];
    assert.equal(rules.length, 3);
    for (const [, selector, body] of rules) {
      assert.match(selector.trim(), /^:where\(\.ed-mirror\) mark\.ed-hl-name-\w+$/);
      assert.doesNotMatch(body, /(^|[;\s])(padding|margin|border|font-weight|color)\s*:/);
      assert.match(body, /(background|text-decoration):/);
    }
    assert.ok(text.indexOf('ed-hl-name-character') < text.indexOf('ed-hl-chk-sensitive'), 'names 排在 check 前面');
  });

  test('深 / 浅 / 护眼三套主题都给了名词高亮的三个颜色', () => {
    const h = harness();
    const style = h.ui.doc.createElement('style');
    style.textContent = css();
    h.ui.doc.head.appendChild(style);
    const isTheme = (sel, theme) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(sel.trim())?.[1] === theme;
    const vars = (theme) =>
      [...style.sheet.cssRules]
        .filter((r) => r.selectorText && r.selectorText.split(',').some((sel) => isTheme(sel, theme)))
        .flatMap((r) => [...r.style].filter((n) => n.startsWith('--nf-name-')))
        .sort();
    for (const theme of ['dark', 'light', 'sepia']) {
      assert.deepEqual(vars(theme), ['--nf-name-character-bg', '--nf-name-lore-bg', '--nf-name-unfiled'], theme);
    }
  });
});
