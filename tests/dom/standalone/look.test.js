/**
 * 外观（`media/src/editor/look.ts` / `lookPanel.ts`，菜单那一半在 `view/lookMenu.ts`）：字号快捷键、外观面板、
 * 排版变量、护眼主题。取值的校验与上下限在 tests/unit/editor/lookCore.test.js。
 *
 * jsdom 没有排版，也不解析 `var()`：「镜像层与 textarea 读同一组变量」那一组把构建出来的 standalone.css 塞进页面，
 * 看两边算出来的是不是同一个 `var(--nf-ed-…)`，并按 CSSOM 核对那几条规则写在一起。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 「视图」菜单 | 第二组是「外观」：放大 / 缩小 / 还原字号（写着快捷键）与「外观设置…」；点了就变；到头置灰 |
 * | 字号快捷键 | Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 **只在焦点在编辑区里时拦**；对话输入框、页面上、组字中途一律放行给浏览器 |
 * | 外观面板 | 页面模板里没有；打开时焦点进面板、不是遮罩（`.modal-overlay`）；字体 / 字号 / 行距 / 版心改了当场换变量；字号越界夹回去；恢复默认；Esc 关、焦点回编辑区；只开一个 |
 * | 同一组变量 | textarea 与镜像层算出来是同一组 `var(--nf-ed-…)`；CSS 里同一条规则；版心的居中算式三处同一条；预览也读它；不往元素上单写字号 |
 * | 护眼主题 | 标题栏按钮深 → 浅 → 护眼 → 深；面板里挑「护眼」；记在 `novelforge.theme`；theme.css 里那一套变量与浅色一样全 |
 * | 记在本地 | 记进 `novelforge.editor.prefs`、同一处的成对符号开关不丢；刷新时坏值回落缺省、越界夹回去 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, MEDIA, file, standaloneBodyHtml } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const SONG = "'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif";

/** 一个装好编辑器、开着一章正文的页面，外加几样小工具。 */
function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, ...opts });
  ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。\n\n林昭推门。', { kind: 'chapter' }) });
  const area = () => ui.doc.getElementById('edArea');
  /** `<html>` 上那组变量的当前值。 */
  const v = (name) => ui.doc.documentElement.style.getPropertyValue(name).trim();
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
  const item = (label) => [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label')?.textContent === label);
  const pickMenu = (label) => {
    const btn = item(label);
    assert.ok(btn, `「视图」里没有「${label}」`);
    ui.clickEl(btn);
  };
  const panel = () => ui.doc.querySelector('.ed-look');
  const part = (cls) => panel()?.querySelector(`.${cls}`);
  const change = (input, value, type = 'change') => {
    input.value = String(value);
    input.dispatchEvent(new ui.window.Event(type, { bubbles: true }));
  };
  return { ui, area, v, key, viewMenu, closeBar, item, pickMenu, panel, part, change };
}

/** 「视图」菜单拆成组（分隔线隔开），每一项「名字|快捷键」。 */
function menuGroups(drop) {
  const groups = [[]];
  for (const node of drop.children) {
    if (node.classList.contains('wb-menu-sep')) {
      groups.push([]);
    } else {
      const label = node.querySelector('.wb-menu-label').textContent;
      const kbd = node.querySelector('.wb-menu-kbd')?.textContent;
      groups[groups.length - 1].push(kbd ? `${label}|${kbd}` : label);
    }
  }
  return groups;
}

describe('外观：「视图」菜单那一组', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('第一组仍是「单击打开为临时标签」，第二组是「外观」', () => {
    const groups = menuGroups(h.viewMenu());
    h.closeBar();
    assert.deepEqual(groups.slice(0, 2), [
      ['单击打开为临时标签'],
      ['放大字号|Ctrl+=', '缩小字号|Ctrl+-', '还原字号|Ctrl+0', '外观设置…'],
    ]);
  });

  test('点「放大字号」：字号变量变成 16px', () => {
    h.pickMenu('放大字号');
    assert.equal(h.v('--nf-ed-font-size'), '16px');
  });

  test('提示里写着当前字号与缺省字号', () => {
    const tip = h.item('还原字号').title;
    h.closeBar();
    assert.match(tip, /当前 16px，缺省 15px/);
  });

  test('点「还原字号」：回到 15px', () => {
    h.pickMenu('还原字号');
    assert.equal(h.v('--nf-ed-font-size'), '15px');
  });

  test('点「缩小字号」：14px', () => {
    h.pickMenu('缩小字号');
    assert.equal(h.v('--nf-ed-font-size'), '14px');
  });

  test('缩到最小（12px）：「缩小字号」置灰、「放大字号」照常', () => {
    h.pickMenu('缩小字号');
    h.pickMenu('缩小字号');
    const drop = h.viewMenu();
    const find = (label) => [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    const [dec, inc] = [find('缩小字号'), find('放大字号')];
    h.closeBar();
    assert.deepEqual([h.v('--nf-ed-font-size'), dec.disabled, inc.disabled], ['12px', true, false]);
  });
});

describe('外观：字号快捷键只在焦点在编辑区时拦', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('编辑区里 Ctrl+=：拦下，字号 16px', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '16px']);
  });

  test('Ctrl++（Shift+=）也放大', () => {
    const ev = h.key(h.area(), { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '17px']);
  });

  test('Ctrl+-：缩小', () => {
    h.key(h.area(), { key: '-', code: 'Minus', ctrlKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
  });

  test('Ctrl+0：还原', () => {
    const ev = h.key(h.area(), { key: '0', code: 'Digit0', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '15px']);
  });

  test('Mac 的 Cmd 也认', () => {
    h.key(h.area(), { key: '=', code: 'Equal', metaKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
    h.key(h.area(), { key: '0', code: 'Digit0', metaKey: true });
  });

  test('焦点在对话输入框里：不拦（浏览器照常缩放整页），字号不变', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    const ev = h.key(input, { key: '=', code: 'Equal', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('焦点在页面上（没在任何输入框里）：不拦', () => {
    h.ui.doc.activeElement?.blur();
    const ev = h.key(h.ui.doc.body, { key: '-', code: 'Minus', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('输入法组字中途：放行', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true, isComposing: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('不带 Ctrl 的 = 照常是打字', () => {
    const ev = h.key(h.area(), { key: '=', code: 'Equal' });
    assert.equal(ev.defaultPrevented, false);
  });

  test('按字认、不按位置认：德语布局上 Ctrl+ß（主键盘 - 那个位置）不算缩小', () => {
    const ev = h.key(h.area(), { key: 'ß', code: 'Minus', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('小键盘的 + 也认', () => {
    h.key(h.area(), { key: '+', code: 'NumpadAdd', ctrlKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
    h.key(h.area(), { key: '0', code: 'Numpad0', ctrlKey: true });
  });
});

describe('外观：外观面板', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('页面模板里没有它（DOM 现造现拆）', () => {
    assert.equal(standaloneBodyHtml().includes('ed-look'), false);
    assert.equal(h.panel(), null);
  });

  test('「视图 → 外观设置…」打开面板，焦点落在字体下拉框', () => {
    h.area().focus();
    h.pickMenu('外观设置…');
    assert.equal(h.panel().getAttribute('role'), 'dialog');
    assert.equal(h.ui.doc.activeElement, h.part('ed-look-font'));
  });

  test('不是遮罩：外面那一层不是 .modal-overlay（不挡 Ctrl+P、不拦点击）', () => {
    assert.equal(h.ui.doc.querySelector('.modal-overlay:not(.hidden)'), null);
    assert.ok(h.panel().closest('.ed-look-overlay'));
  });

  test('面板上的值是当前的：宋体、15、1.95、铺满', () => {
    assert.deepEqual(
      [h.part('ed-look-font').value, h.part('ed-look-size').value, h.part('ed-look-line').value, h.part('ed-look-measure').value],
      ['song', '15', '1.95', '0']
    );
  });

  test('改字体：当场换字体变量', () => {
    h.change(h.part('ed-look-font'), 'kai');
    assert.match(h.v('--nf-ed-font-family'), /^'LXGW WenKai'/);
  });

  test('字号输入框：当场换，越界夹进上下限、输入框写回夹过的值', () => {
    h.change(h.part('ed-look-size'), 99);
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['32px', '32']);
  });

  test('字号输入框清空了不算数：写回当前字号', () => {
    h.change(h.part('ed-look-size'), '');
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['32px', '32']);
  });

  test('到最大时「+」置灰', () => {
    assert.equal(h.part('ed-look-size-inc').disabled, true);
  });

  test('「−」缩一档', () => {
    h.ui.clickEl(h.part('ed-look-size-dec'));
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['31px', '31']);
  });

  test('行距滑块：拖的时候就换，旁边写着当前值', () => {
    h.change(h.part('ed-look-line'), 2.2, 'input');
    assert.deepEqual([h.v('--nf-ed-line-height'), h.part('ed-look-line-value').textContent], ['2.2', '2.20']);
  });

  test('版心：挑「一行最多 40 字」，变量按 em 写', () => {
    const select = h.part('ed-look-measure');
    const opt = [...select.options].find((o) => o.textContent === '一行最多 40 字');
    h.change(select, opt.value);
    assert.equal(h.v('--nf-ed-measure'), '40em');
  });

  test('不往 textarea 上单写字号、字体、行距（只认那组变量）', () => {
    const s = h.area().style;
    assert.deepEqual([s.fontSize, s.fontFamily, s.lineHeight], ['', '', '']);
  });

  test('段间距不单列一项：面板上说清跟着分段格式走', () => {
    assert.match(h.panel().textContent, /段间距跟着分段格式走/);
  });

  test('恢复默认：四项回到缺省，面板上的值跟着变', () => {
    h.ui.clickEl(h.part('ed-look-reset'));
    assert.deepEqual(
      [h.v('--nf-ed-font-family'), h.v('--nf-ed-font-size'), h.v('--nf-ed-line-height'), h.v('--nf-ed-measure')],
      [SONG, '15px', '1.95', '100cqi']
    );
    assert.deepEqual([h.part('ed-look-font').value, h.part('ed-look-size').value, h.part('ed-look-measure').value], ['song', '15', '0']);
  });

  test('开着时用快捷键改字号，面板上的值跟着变', () => {
    h.area().focus();
    h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.equal(h.part('ed-look-size').value, '16');
    h.key(h.area(), { key: '0', code: 'Digit0', ctrlKey: true });
  });

  test('再打开一次：还是那一个，焦点放回面板', () => {
    h.area().focus();
    h.pickMenu('外观设置…');
    assert.deepEqual([h.ui.doc.querySelectorAll('.ed-look').length, h.ui.doc.activeElement], [1, h.part('ed-look-font')]);
  });

  test('Esc 关掉，焦点回到打开之前的地方（编辑区）', () => {
    const ev = h.key(h.part('ed-look-font'), { key: 'Escape' });
    assert.deepEqual([ev.defaultPrevented, h.panel(), h.ui.doc.activeElement], [true, null, h.area()]);
  });

  test('「关闭」按钮也关', () => {
    h.pickMenu('外观设置…');
    h.ui.clickEl(h.part('ed-look-close'));
    assert.equal(h.panel(), null);
  });
});

describe('外观：镜像层与 textarea 读同一组变量', { skip: JSDOM_SKIP }, () => {
  let h;
  let sheet;
  const css = fs.readFileSync(path.join(MEDIA, 'standalone.css'), 'utf8');
  /** 选择器列表里同时有这几个的那几条规则（顶层的，不含 @supports / @media 里的）。 */
  const rulesWith = (rules, ...sels) =>
    [...rules].filter((r) => r.selectorText && sels.every((s) => r.selectorText.split(',').map((x) => x.trim()).includes(s)));

  before(() => {
    h = harness();
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    sheet = style.sheet;
    // 打开查找、找一个字：镜像层（.ed-mirror-content）造出来，样式从 textarea 抄过去。
    h.area().focus();
    h.key(h.area(), { key: 'f', ctrlKey: true });
    const input = h.ui.doc.querySelector('.ed-find-input');
    input.value = '林';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
  });

  test('textarea 的字体、字号、行距算出来是那组变量', () => {
    const cs = h.ui.window.getComputedStyle(h.area());
    assert.deepEqual(
      [cs.fontFamily, cs.fontSize, cs.lineHeight],
      ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']
    );
  });

  test('镜像层抄过去的是同一组变量', () => {
    const content = h.ui.doc.querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.deepEqual(
      [content.style.fontFamily, content.style.fontSize, content.style.lineHeight],
      ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']
    );
  });

  test('CSS 里 textarea 与镜像层是同一条规则：字体、字号、行距、内边距都读变量', () => {
    const [rule] = rulesWith(sheet.cssRules, '.ed-area', '.ed-mirror-content');
    assert.ok(rule, '找不到 .ed-area 与 .ed-mirror-content 写在一起的那条规则');
    assert.deepEqual(
      ['font-family', 'font-size', 'line-height', 'padding'].map((p) => rule.style.getPropertyValue(p)),
      [
        'var(--nf-ed-font-family)',
        'var(--nf-ed-font-size)',
        'var(--nf-ed-line-height)',
        'var(--nf-ed-pad-y) var(--nf-ed-pad-x) var(--nf-ed-pad-bottom)',
      ]
    );
  });

  test('版心的居中算式：@supports 里 textarea、镜像层、预览三处同一条', () => {
    const supports = [...sheet.cssRules].find((r) => r.conditionText === '(width: 1cqi)');
    const [rule] = rulesWith(supports.cssRules, '.ed-area', '.ed-mirror-content', '.ed-preview');
    assert.match(rule.style.getPropertyValue('padding-left'), /100cqi - var\(--nf-ed-measure\)/);
    assert.equal(rule.style.getPropertyValue('padding-left'), rule.style.getPropertyValue('padding-right'));
  });

  test('居中按容器宽算：.ed-stage 是容器', () => {
    const supports = [...sheet.cssRules].find((r) => r.conditionText === '(width: 1cqi)');
    const [stage] = rulesWith(supports.cssRules, '.ed-stage');
    assert.equal(stage.style.getPropertyValue('container-type'), 'inline-size');
  });

  test('预览读同一组变量', () => {
    const cs = h.ui.window.getComputedStyle(h.ui.doc.getElementById('edPreview'));
    assert.deepEqual([cs.fontFamily, cs.fontSize, cs.lineHeight], ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']);
  });

  test('别处不再写死正文字号（15px）与行距（1.95）', () => {
    const literal = [...sheet.cssRules].filter(
      (r) =>
        r.selectorText &&
        /\.ed-(area|preview|mirror-content)\b/.test(r.selectorText) &&
        (r.style.getPropertyValue('font-size') === '15px' || r.style.getPropertyValue('line-height') === '1.95')
    );
    assert.deepEqual(literal.map((r) => r.selectorText), []);
  });

  test('窄屏收窄内边距改的是变量，不是元素上的 padding', () => {
    const narrow = [...sheet.cssRules].find((r) => r.conditionText === '(max-width: 900px)');
    const padded = rulesWith(narrow.cssRules, '.ed-area').filter((r) => r.style.getPropertyValue('padding'));
    const root = rulesWith(narrow.cssRules, ':root')[0];
    assert.deepEqual([padded.length, root?.style.getPropertyValue('--nf-ed-pad-x').trim()], [0, '16px']);
  });

  test('改了字号：镜像层当场重抄一遍样式（不等尺寸变化）', () => {
    const content = h.ui.doc.querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    content.style.removeProperty('font-size');
    h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.equal(content.style.fontSize, 'var(--nf-ed-font-size)');
  });
});

describe('外观：护眼主题', { skip: JSDOM_SKIP }, () => {
  let h;
  const theme = () => h.ui.doc.documentElement.dataset.theme;
  before(() => {
    h = harness({ url: 'http://localhost/?project=a' });
    // 编辑器启动时按记下的（或系统的）主题定；从深色起测。
    h.ui.window.localStorage.removeItem('novelforge.theme');
  });

  test('标题栏按钮：深色 → 浅色 → 护眼 → 深色轮着换', () => {
    const btn = h.ui.doc.getElementById('wbThemeBtn');
    const seen = [theme()];
    for (let i = 0; i < 3; i++) {
      h.ui.clickEl(btn);
      seen.push(theme());
    }
    assert.deepEqual(seen, ['dark', 'light', 'sepia', 'dark']);
  });

  test('按钮上写的是下一套：深色时提示切到浅色', () => {
    assert.match(h.ui.doc.getElementById('wbThemeBtn').title, /切换到浅色/);
  });

  test('外观面板里挑「护眼」：当场换，记在 novelforge.theme', () => {
    h.pickMenu('外观设置…');
    const sepia = h.panel().querySelector('.ed-look-theme input[value="sepia"]');
    sepia.checked = true;
    sepia.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.deepEqual([theme(), h.ui.window.localStorage.getItem('novelforge.theme')], ['sepia', 'sepia']);
  });

  test('「恢复默认」不动主题', () => {
    h.ui.clickEl(h.part('ed-look-reset'));
    assert.equal(theme(), 'sepia');
  });

  test('面板上那一组单选跟着当前主题', () => {
    const checked = h.panel().querySelector('.ed-look-theme input:checked');
    assert.equal(checked.value, 'sepia');
  });

  test('theme.css 里护眼那一套的变量与浅色一样全', () => {
    const css = fs.readFileSync(path.join(MEDIA, 'standalone.css'), 'utf8');
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    const names = (theme) => {
      const rule = [...style.sheet.cssRules].find((r) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(r.selectorText)?.[1] === theme);
      assert.ok(rule, `找不到 ${theme} 那一套`);
      return [...rule.style].filter((n) => n.startsWith('--')).sort();
    };
    assert.deepEqual(names('sepia'), names('light'));
  });
});

describe('外观：记在本地', { skip: JSDOM_SKIP }, () => {
  test('改了记进 novelforge.editor.prefs，同一处的成对符号开关不丢', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ autoPair: false }) } });
    h.pickMenu('放大字号');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([saved.autoPair, saved.fontSize], [false, 16]);
  });

  test('别的开关存一下也不冲掉外观那几项', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ fontSize: 20 }) } });
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const toggle = [...h.ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('成对符号'));
    h.ui.clickEl(toggle);
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([saved.autoPair, saved.fontSize], [false, 20]);
  });

  test('外观与码字统计的 stats 子对象互不冲掉：改字号留着 stats，改统计开关留着字号', () => {
    const h = harness({
      storage: { 'novelforge.editor.prefs': JSON.stringify({ stats: { goal: true, session: true, today: false } }) },
    });
    h.pickMenu('放大字号');
    const afterZoom = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    // 「视图 → 统计 ›」子菜单里打开「今日码字」。
    const stats = [...h.viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === '统计');
    stats.dispatchEvent(new h.ui.window.MouseEvent('mouseenter'));
    const today = [...h.ui.doc.querySelectorAll('.wb-menu-drop.submenu .wb-menu-item')].find((b) => b.textContent.includes('今日码字'));
    h.ui.clickEl(today);
    const afterStats = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual(
      [afterZoom.fontSize, afterZoom.stats, afterStats.fontSize, afterStats.stats],
      [16, { goal: true, session: true, today: false }, 16, { goal: true, session: true, today: true }]
    );
  });

  test('写坏了（不是 JSON）：全当缺省，下一次写把它整份换掉', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': '{坏了' } });
    const before = h.v('--nf-ed-font-size');
    h.pickMenu('放大字号');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([before, saved.fontSize, saved.autoPair], ['15px', 16, true]);
  });

  test('刷新时坏值回落缺省、越界的夹回去，好的照用', () => {
    const h = harness({
      storage: {
        'novelforge.editor.prefs': JSON.stringify({ fontFamily: 'comic', fontSize: '大', lineHeight: 2.2, measure: 999 }),
      },
    });
    assert.deepEqual(
      [h.v('--nf-ed-font-family'), h.v('--nf-ed-font-size'), h.v('--nf-ed-line-height'), h.v('--nf-ed-measure')],
      [SONG, '15px', '2.2', '80em']
    );
  });

  test('恢复默认从偏好里删掉那几项（以后缺省改了也跟着走）', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ fontSize: 20, autoSave: true }) } });
    h.pickMenu('外观设置…');
    h.ui.clickEl(h.part('ed-look-reset'));
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([('fontSize' in saved), saved.autoSave], [false, true]);
  });
});
