/**
 * 名词补全（独立版内置编辑器，`media/src/editor/names.ts`；匹配与排序的口径在 tests/unit/editor/namesCore.test.js）。
 *
 * jsdom 没有排版：弹出框贴不贴着光标测不了像素，只测它挂在 body 上、给了 left / top。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 按键弹出 | Alt+/ 发 `requestNameIndex`、表到了才弹；光标前「林」列出以它开头的；高亮、类型、一句话；Esc 收起且不往下传 |
 * | 选与插入 | ↑↓ 绕着选、Enter / Tab 插入、点一行插入；换掉打过的字、光标落在后面；**一步撤销** |
 * | 别名 | 「阿昭 → 林昭」，插入的是阿昭 |
 * | 空查询 | 什么都匹配不上就列全部，最近在本文件出现的排前面 |
 * | 接着打字 | 跟着筛；打了标点收起 |
 * | 收起 | 点外面（框里按下不收）、切标签、滚轮 |
 * | 名词表 | 再要时带着 `have`；没变只回指纹照样能弹；变了按新的列；别的页面的 requestId 不认 |
 * | 不弹 | 配置这类文件（`kind: setting`）说一句、不发请求；输入法组字中的 Alt+/ 放行 |
 * | 边打边弹 | 上屏「沈怀」弹、Tab 接受、一步撤销；**回车不被抢**（照常换段、框收起）；继续打字收起；打完整了、一个字、组字中途不弹；开着框又组字先藏起来、上屏再筛；键盘打字也弹；配置文件不弹 |
 * | 「视图 → 补全」 | 「名词补全 Alt+/」（不能补全的文件上置灰、点了弹出）与「边打边弹名词补全」（缺省关、记进 `novelforge.editor.prefs` 不冲掉别的、再点关掉删掉那一项） |
 * | 码字统计 | 补上的字算作者码的字，撤销那一步减回去 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const URL = `http://localhost/?project=${encodeURIComponent('/书/青云剑录')}`;
const PREFS_KEY = 'novelforge.editor.prefs';
const CH = 'chapters/001-楔子.md';

const NAMES = {
  initialized: true,
  names: [
    { name: '林昭', aliases: ['阿昭', '小林'], source: 'character', category: '', brief: '青云宗外门弟子。', path: '.novelforge/characters/林昭.md' },
    { name: '林昭阳', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/林昭阳.md' },
    { name: '沈怀山', aliases: ['老沈'], source: 'character', category: '', brief: '', path: '.novelforge/characters/沈怀山.md' },
    { name: '青云宗', aliases: ['青云门'], source: 'lore', category: '门派', brief: '正道第一大宗', path: '.novelforge/lore/门派/青云宗.md' },
    { name: '青崖镇', aliases: [], source: 'lore', category: '地点', brief: '', path: '.novelforge/lore/地点/青崖镇.md' },
    { name: '黑水河', aliases: [], source: 'unfiled', category: '地点', brief: '河上起了雾' },
    { name: 'Lin Zhao', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/lin.md' },
    { name: 'Lindy', aliases: [], source: 'character', category: '', brief: '', path: '.novelforge/characters/lindy.md' },
  ],
};

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const fire = (inputType, extra) => area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  const h = {
    ui,
    toasts,
    area,
    open(path, text, kind = 'chapter') {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
      h.end();
    },
    end() {
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    caret: () => area().selectionStart,
    /** 键盘打字：一下一个字。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire('insertText', { data: ch });
      }
    },
    /** 输入法：组字几步（拼音），返回上屏的函数。 */
    compose(steps) {
      const a = area();
      const base = a.value;
      const at = a.selectionStart;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of steps) {
        a.value = base.slice(0, at) + step + base.slice(at);
        a.setSelectionRange(at + step.length, at + step.length);
        fire('insertCompositionText', { isComposing: true });
      }
      return (commit) => {
        a.value = base.slice(0, at) + commit + base.slice(at);
        a.setSelectionRange(at + commit.length, at + commit.length);
        a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
      };
    },
    /** 输入法一下上屏。 */
    ime(commit, steps = ['x']) {
      h.compose(steps)(commit);
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    trigger: () => h.key({ key: '/', code: 'Slash', altKey: true }),
    undo: () => h.key({ key: 'z', ctrlKey: true }),
    /** 最近一次名词表请求。 */
    request: () => ui.last('requestNameIndex'),
    /** 回最近那一次请求。 */
    serve(index = NAMES, sig = 's1') {
      const req = h.request();
      assert.ok(req, '应该发过 requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig, ...(index ? { index } : {}) });
    },
    box: () => ui.doc.querySelector('.nc-box'),
    shown: () => !!h.box() && !h.box().classList.contains('hidden'),
    rows: () => [...ui.doc.querySelectorAll('.nc-box .nc-item')],
    /** 每一行的名字那一格（别名行带「 → 正名」）。 */
    names: () => h.rows().map((r) => r.querySelector('.nc-name').textContent),
    active: () => h.rows().findIndex((r) => r.classList.contains('active')),
    mousedown(target) {
      target.dispatchEvent(new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    },
  };
  return h;
}

describe('名词补全：按键弹出', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, '他看见林');
  });

  test('Alt+/：发 requestNameIndex（第一次不带 have），表到之前不弹', () => {
    const ev = h.trigger();
    assert.equal(ev.defaultPrevented, true, 'Mac 上 Option+/ 会打出 ÷，拦下');
    const req = h.request();
    assert.ok(req && typeof req.requestId === 'string');
    assert.equal('have' in req, false);
    assert.equal(h.box(), null);
  });

  test('表到了：在光标处弹出，挂在 body 上、给了位置', () => {
    h.serve();
    assert.equal(h.shown(), true);
    assert.equal(h.box().parentElement, h.ui.doc.body);
    assert.match(h.box().style.left, /px$/);
    assert.match(h.box().style.top, /px$/);
  });

  test('光标前「林」：列出以它开头的名字，第一条选中，打过的字高亮', () => {
    assert.deepEqual(h.names(), ['林昭', '林昭阳']);
    assert.equal(h.active(), 0);
    assert.equal(h.rows()[0].querySelector('mark').textContent, '林');
    assert.equal(h.rows()[0].getAttribute('aria-selected'), 'true');
  });

  test('每条写类型与一句话', () => {
    const row = h.rows()[0];
    assert.equal(row.querySelector('.nc-badge').textContent, '角色');
    assert.equal(row.querySelector('.nc-brief').textContent, '青云宗外门弟子。');
    assert.match(h.box().querySelector('.nc-foot').textContent, /Enter \/ Tab 插入/);
  });

  test('Esc 收起，正文不动，这一下不往下传（查找条、专注模式不再收一遍）', () => {
    let reached = false;
    const spy = (e) => {
      if (e.key === 'Escape') reached = true;
    };
    h.ui.doc.addEventListener('keydown', spy);
    const ev = h.key({ key: 'Escape' });
    h.ui.doc.removeEventListener('keydown', spy);
    assert.equal(h.box(), null);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(reached, false);
    assert.equal(h.area().value, '他看见林');
  });

  test('↑↓ 绕着选：↓ 到第二条，↑↑ 绕回第二条', () => {
    h.trigger();
    h.key({ key: 'ArrowDown' });
    assert.equal(h.active(), 1);
    h.key({ key: 'ArrowUp' });
    h.key({ key: 'ArrowUp' });
    assert.equal(h.active(), 1);
  });

  test('Enter 插入：换掉打过的「林」、补成「林昭阳」，光标落在后面，框收起', () => {
    const ev = h.key({ key: 'Enter' });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '他看见林昭阳');
    assert.equal(h.caret(), 6);
    assert.equal(h.box(), null);
  });

  test('一步撤销：回到「他看见林」', () => {
    h.undo();
    assert.equal(h.area().value, '他看见林');
  });

  test('Tab 也插入', () => {
    h.end();
    h.trigger();
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, '他看见林昭');
  });

  test('别名命中：写「阿昭 → 林昭」，插入的是阿昭', () => {
    h.open('chapters/002-入镇.md', '他喊：阿');
    h.trigger();
    assert.deepEqual(h.names(), ['阿昭 → 林昭']);
    h.key({ key: 'Enter' });
    assert.equal(h.area().value, '他喊：阿昭');
  });

  test('什么都匹配不上：列全部，最近在本文件出现的排前面', () => {
    h.open('chapters/003-夜访.md', '沈怀山推门进来。青崖镇下着雨。他说');
    h.trigger();
    assert.equal(h.rows().length, NAMES.names.length);
    assert.deepEqual(h.names().slice(0, 2), ['青崖镇', '沈怀山']);
  });

  test('未建条目写「未建条目」与那一句说明', () => {
    const row = h.rows().find((r) => r.querySelector('.nc-name').textContent === '黑水河');
    assert.equal(row.querySelector('.nc-badge').textContent, '地点');
    assert.equal(row.querySelector('.nc-brief').textContent, '未建条目 · 河上起了雾');
  });

  test('接着打字跟着筛：打「青」剩下青云宗、青崖镇，打了标点就收起', () => {
    h.type('青');
    assert.deepEqual(h.names().sort(), ['青崖镇', '青云宗'].sort());
    h.type('崖');
    assert.deepEqual(h.names(), ['青崖镇']);
    h.type('，');
    assert.equal(h.box(), null);
  });

  test('点一行插入；框里按下鼠标不收起', () => {
    h.open('chapters/004-北行.md', '林');
    h.trigger();
    h.mousedown(h.rows()[1]);
    assert.equal(h.shown(), true);
    h.ui.clickEl(h.rows()[1]);
    assert.equal(h.area().value, '林昭阳');
  });

  test('点外面收起', () => {
    h.open('chapters/005-雨.md', '林');
    h.trigger();
    h.mousedown(h.ui.doc.body);
    assert.equal(h.box(), null);
  });

  test('切标签收起', () => {
    h.trigger();
    assert.equal(h.shown(), true);
    h.open('chapters/006-别处.md', '雨');
    assert.equal(h.box(), null);
  });

  test('滚轮收起', () => {
    h.open('chapters/007-风.md', '林');
    h.trigger();
    h.area().dispatchEvent(new h.ui.window.WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    assert.equal(h.box(), null);
  });

  test('磁盘上变过之后再要：带着手上那份的 have；没变只回指纹也照样弹', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    const req = h.request();
    assert.equal(req.have, 's1');
    assert.equal(h.shown(), true, '问的工夫里先拿手上那份弹');
    h.serve(undefined, 's1');
    assert.deepEqual(h.names(), ['林昭', '林昭阳']);
    h.key({ key: 'Escape' });
  });

  test('表变了：按新的列', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    h.serve({ initialized: true, names: [...NAMES.names, { name: '林间', aliases: [], source: 'lore', category: '地点', brief: '' }] }, 's2');
    assert.ok(h.names().includes('林间'));
    h.key({ key: 'Escape' });
  });

  test('别的页面的 requestId 不认', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    h.key({ key: 'Escape' });
    h.ui.post({ type: 'nameIndex', requestId: 'someone-else', sig: 's9', index: { initialized: true, names: [] } });
    h.trigger();
    assert.ok(h.rows().length > 0, '别人的空表没换掉这边的');
    h.key({ key: 'Escape' });
  });

  test('配置这类文件（kind: setting）：不弹、不发请求，说一句', () => {
    h.open('.novelforge/config.md', '林', 'setting');
    const before = h.ui.sent.filter((m) => m.type === 'requestNameIndex').length;
    h.trigger();
    assert.equal(h.box(), null);
    assert.equal(h.ui.sent.filter((m) => m.type === 'requestNameIndex').length, before);
    assert.match(h.toasts.at(-1), /只在正文/);
  });

  test('没给 kind（没打开工程）也不弹', () => {
    h.open('notes.md', '林', null);
    h.trigger();
    assert.equal(h.box(), null);
  });

  test('输入法组字中的 Alt+/：放行，不弹', () => {
    h.open('chapters/008-组字.md', '林');
    const ev = h.key({ key: '/', code: 'Slash', altKey: true, isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.box(), null);
  });

  test('细纲、角色卡、设定也能补全', () => {
    for (const [path, kind] of [
      ['.novelforge/summaries/009-x.md', 'plot'],
      ['.novelforge/characters/林昭.md', 'character'],
      ['.novelforge/lore/地点/青崖镇.md', 'lore'],
    ]) {
      h.open(path, '林', kind);
      h.trigger();
      assert.equal(h.shown(), true, kind);
      h.key({ key: 'Escape' });
    }
  });
});

describe('名词补全：边打边弹', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameAutoPopup: true }) } });
    h.open(CH, '他看见');
    // 开着边打边弹、对着一份能补全的文件：表先要一份。
    h.serve();
  });

  test('打开能补全的文件就先要名词表', () => {
    assert.ok(h.request());
  });

  test('输入法上屏「沈怀」：弹出，只列没打完的', () => {
    h.ime('沈怀');
    assert.equal(h.shown(), true);
    assert.deepEqual(h.names(), ['沈怀山']);
    assert.match(h.box().querySelector('.nc-foot').textContent, /回车照常换段/);
  });

  test('回车不被抢：照常换段，框收起，名字没补', () => {
    h.key({ key: 'Enter' });
    assert.equal(h.box(), null);
    assert.ok(h.area().value.startsWith('他看见沈怀\n'), JSON.stringify(h.area().value));
    assert.ok(!h.area().value.includes('沈怀山'));
  });

  test('Tab 接受：补成「青崖镇」，一步撤销回到「青崖」', () => {
    h.open('chapters/002-入镇.md', '');
    h.ime('青崖');
    assert.deepEqual(h.names(), ['青崖镇']);
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, '青崖镇');
    h.undo();
    assert.equal(h.area().value, '青崖');
  });

  test('↑↓ 在框里选，Tab 插入选中的那一条', () => {
    h.open('chapters/003-夜访.md', '');
    h.type('Li');
    assert.deepEqual(h.names(), ['Lindy', 'Lin Zhao']);
    h.key({ key: 'ArrowDown' });
    assert.equal(h.active(), 1);
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, 'Lin Zhao');
  });

  test('「林昭」打完整了不弹（哪怕还有「林昭阳」）', () => {
    h.open('chapters/004-北行.md', '');
    h.ime('林昭');
    assert.equal(h.box(), null);
  });

  test('继续打别的字：收起', () => {
    h.open('chapters/005-雨.md', '');
    h.ime('沈怀');
    assert.equal(h.shown(), true);
    h.ime('了');
    assert.equal(h.box(), null);
  });

  test('打完整了不弹', () => {
    h.open('chapters/006-风.md', '');
    h.ime('沈怀山');
    assert.equal(h.box(), null);
  });

  test('一个字不弹', () => {
    h.open('chapters/007-云.md', '');
    h.ime('沈');
    assert.equal(h.box(), null);
  });

  test('组字中途不弹（拼音还没上屏），上屏才弹', () => {
    h.open('chapters/008-组字.md', '');
    const commit = h.compose(['s', 'shen', 'shenhuai']);
    assert.equal(h.box(), null);
    commit('沈怀');
    assert.equal(h.shown(), true);
  });

  test('框开着又开始组字：先藏起来、键不接管；上屏之后按新的文字再筛', () => {
    const commit = h.compose(['q']);
    assert.equal(h.shown(), false);
    const ev = h.key({ key: 'Enter', isComposing: true });
    assert.equal(ev.defaultPrevented, false, '组字中的回车是输入法的');
    commit('了');
    assert.equal(h.box(), null, '上屏了别的字，收起');
  });

  test('键盘打字也弹（英文名，不分大小写）', () => {
    h.open('chapters/009-en.md', '');
    h.type('li');
    assert.deepEqual(h.names(), ['Lindy', 'Lin Zhao']);
    h.key({ key: 'Escape' });
  });

  test('配置这类文件不弹', () => {
    h.open('.novelforge/config.md', '', 'setting');
    h.ime('沈怀');
    assert.equal(h.box(), null);
  });

  test('删字不弹', () => {
    h.open('chapters/010-删.md', '沈怀山');
    const a = h.area();
    a.value = '沈怀';
    a.setSelectionRange(2, 2);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    assert.equal(h.box(), null);
  });
});

describe('「视图 → 补全」', { skip: JSDOM_SKIP }, () => {
  let h;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (label) =>
    [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    h.open(CH, '他看见林');
  });

  test('「视图」最后一组：「名词补全」写着 Alt+/，「边打边弹名词补全」缺省没打 ✓', () => {
    const trigger = item('名词补全');
    assert.ok(trigger);
    assert.equal(trigger.querySelector('.wb-menu-kbd').textContent, 'Alt+/');
    assert.equal(trigger.disabled, false);
    assert.equal(item('边打边弹名词补全').getAttribute('aria-checked'), 'false');
    h.ui.closeMenu();
  });

  test('点「名词补全」：在光标处弹出', () => {
    h.ui.clickEl(item('名词补全'));
    h.serve();
    assert.equal(h.shown(), true);
    assert.deepEqual(h.names(), ['林昭', '林昭阳']);
    h.key({ key: 'Escape' });
  });

  test('打开「边打边弹」：打 ✓，记进偏好且不冲掉别的', () => {
    h.ui.clickEl(item('边打边弹名词补全'));
    assert.equal(item('边打边弹名词补全').getAttribute('aria-checked'), 'true');
    assert.equal(storedPrefs().nameAutoPopup, true);
    assert.equal(storedPrefs().autoPair, false, '成对符号那一项没被冲掉');
    h.ui.closeMenu();
  });

  test('开着之后打字就弹', () => {
    h.end();
    h.ime('，沈怀');
    assert.deepEqual(h.names(), ['沈怀山']);
    h.key({ key: 'Escape' });
  });

  test('再点关掉：偏好里删掉那一项，打字不再弹', () => {
    h.ui.clickEl(item('边打边弹名词补全'));
    assert.equal('nameAutoPopup' in storedPrefs(), false);
    assert.equal(storedPrefs().autoPair, false);
    h.ui.closeMenu();
    h.ime('，青崖');
    assert.equal(h.box(), null);
  });

  test('配置文件上「名词补全」置灰，提示说为什么', () => {
    h.open('.novelforge/config.md', '', 'setting');
    const trigger = item('名词补全');
    assert.equal(trigger.disabled, true);
    assert.match(trigger.title, /只在正文/);
    h.ui.closeMenu();
  });

  test('刷新之后边打边弹的开关照旧', () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameAutoPopup: true }) } });
    again.open(CH, '');
    again.serve();
    again.ime('沈怀');
    assert.equal(again.shown(), true);
  });
});

describe('名词补全：码字统计', { skip: JSDOM_SKIP }, () => {
  let h;
  const session = () => /本次 ([+-]?[\d,]+) 字/.exec(h.ui.doc.getElementById('edStatusWords').textContent)?.[1];
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ stats: { goal: true, session: true, today: false } }) } });
    h.open(CH, '');
  });

  test('输入法打「沈」算 1 个字', () => {
    h.ime('沈');
    assert.equal(session(), '+1');
  });

  test('补成「沈怀山」：补上的两个字也算（⚑），本次 +3', () => {
    h.trigger();
    h.serve();
    assert.deepEqual(h.names(), ['沈怀山']);
    h.key({ key: 'Enter' });
    assert.equal(h.area().value, '沈怀山');
    assert.equal(session(), '+3');
  });

  test('撤销补全那一步：减回去，本次 +1', () => {
    h.undo();
    assert.equal(h.area().value, '沈');
    assert.equal(session(), '+1');
  });
});
