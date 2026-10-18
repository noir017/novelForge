/**
 * 码字统计（独立版内置编辑器，`media/src/editor/stats.ts` / `statsPanel.ts` / `statsDaily.ts`，「视图 → 统计」在
 * `view/statsMenu.ts`）。口径（一处改动算几个字、哪些算码字、时长、今日记录怎么合）在
 * tests/unit/editor/writingStats.test.js 钉着，这里钉整条链路：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 全文与选中 | 「全文 N 字」；有选区「选中 N 字 / 全文 M 字」；字符数在悬停提示里 |
 * | 距目标 | 章节正文「3,120 / 4,000 字，还差 880」＋细进度条、实时跟着打字变、超了说超出、开头的 `# 标题` 不算；细纲、草稿、没目标、索引里没有的不显示；章节索引更新了跟着变 |
 * | 本次码字 | 打字、输入法上屏涨，退格倒扣；粘贴、一键排版、全部替换不涨；撤销替换不动、撤销自己打的减回去、重做加回来；组字中途不算 |
 * | 面板 | 点那一格弹出（本章、本次、今日、按文件、重新开始计时），开着打字跟着变，Esc / 点外面 / 再点一下收起，按下鼠标不夺焦点 |
 * | 时长与速度 | 停笔超过 2 分钟那段不算；写够 1 分钟才报速度 |
 * | 重新开始计时 | 本次归零，今日不动；面板里与「视图」菜单里都有 |
 * | 「视图 → 统计」 | 三个开关缺省值与 ✓、关掉距目标就不显示、记进 `novelforge.editor.prefs` 而不冲掉段落那几项（反过来也一样） |
 * | 今日码字 | 刷新后还在、别的窗口记的（`storage` 事件）加进来且不被这边覆盖、过了午夜换新的一天、坏值回落、记不了只算这一页 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const PROJECT = '/书/青云剑录';
const URL = `http://localhost/?project=${encodeURIComponent(PROJECT)}`;
const DAILY_KEY = `novelforge.editor.stats.daily@${PROJECT}`;
const PREFS_KEY = 'novelforge.editor.prefs';
/** 状态栏把本次 / 今日也显示出来（缺省关）。 */
const SHOW_ALL = JSON.stringify({ stats: { goal: true, session: true, today: true } });

/** 章节索引里的第 3 章（目标 10 字）与第 4 章（没写目标）。 */
const CH3 = 'chapters/003-夜访.md';
const CH4 = 'chapters/004-北行.md';
const PLOT3 = '.novelforge/summaries/003-夜访.md';
const entry = (no, title, extra) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: `chapters/00${no}-${title}.md`,
  plotPath: `.novelforge/summaries/00${no}-${title}.md`,
  plotExists: true,
  chapterPath: `chapters/00${no}-${title}.md`,
  wordCount: 0,
  stage: 'finalize',
  ...extra,
});
const INDEX = [entry(3, '夜访', { targetWords: 10 }), entry(4, '北行')];

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const cell = () => ui.doc.getElementById('edStatusWords');
  const h = {
    ui,
    toasts,
    area,
    cell,
    words: () => cell().textContent,
    bar: () => cell().querySelector('.ed-words-bar'),
    open(path, text, extra) {
      ui.post({ type: 'editorOpen', file: file(path, text, extra) });
      h.end();
    },
    index(chapters = INDEX) {
      ui.post({ type: 'chapterIndex', chapters });
    },
    /** 光标挪到末尾。 */
    end() {
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    select(start, end) {
      area().setSelectionRange(start, end);
      area().dispatchEvent(new ui.window.Event('select', { bubbles: true }));
    },
    /** 在选区处打进去（键盘），`inputType` 换成 insertFromPaste 就是粘贴。 */
    type(text, inputType = 'insertText') {
      const a = area();
      const s = a.selectionStart;
      const e = a.selectionEnd;
      a.value = a.value.slice(0, s) + text + a.value.slice(e);
      a.setSelectionRange(s + text.length, s + text.length);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType }));
    },
    paste(text) {
      h.type(text, 'insertFromPaste');
    },
    backspace(n) {
      const a = area();
      const p = a.selectionStart;
      a.value = a.value.slice(0, p - n) + a.value.slice(p);
      a.setSelectionRange(p - n, p - n);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    },
    /** 输入法：`steps` 是组字中途显示的拼音，最后上屏 `commit`。 */
    compose(steps, commit) {
      const a = area();
      const base = a.value;
      const at = a.selectionStart;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of steps) {
        a.value = base.slice(0, at) + step + base.slice(at);
        a.setSelectionRange(at + step.length, at + step.length);
        a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
      }
      return () => {
        a.value = base.slice(0, at) + commit + base.slice(at);
        a.setSelectionRange(at + commit.length, at + commit.length);
        a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
      };
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    undo: () => h.key({ key: 'z', ctrlKey: true }),
    redo: () => h.key({ key: 'y', ctrlKey: true }),
    /** 状态栏上的「本次 ±N 字」那几个字。 */
    session: () => /本次 ([+-]?[\d,]+) 字/.exec(h.words())?.[1],
    today: () => /今日 (-?[\d,]+) 字/.exec(h.words())?.[1],
    panel: () => ui.doc.querySelector('.ed-stats-panel'),
    clickCell() {
      ui.clickEl(cell());
      return h.panel();
    },
    sec: (cls) => h.panel()?.querySelector(`.${cls}`),
    flushDaily() {
      ui.window.dispatchEvent(new ui.window.Event('pagehide'));
    },
    daily: () => JSON.parse(ui.window.localStorage.getItem(DAILY_KEY) || 'null'),
    /** 把窗口里的 `Date.now` 钉在某一刻（时长、跨午夜）。 */
    clock(at) {
      ui.window.Date.now = () => at;
    },
  };
  return h;
}

/** 本地日期的 `YYYY-MM-DD`（与 `writingStats.dayKey` 同一个算法，测的是「今天」是哪个键）。 */
function dayOf(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('状态栏字数那一格：全文与选中', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('notes.md', 'hello world 林昭。');
  });

  test('没有选区：全文 N 字（中文按字、英文按词）', () => {
    assert.equal(h.words(), '全文 4 字');
  });

  test('有选区：选中 N 字 / 全文 M 字', () => {
    h.select(0, 5);
    assert.equal(h.words(), '选中 1 字 / 全文 4 字');
    h.select(12, 14);
    assert.equal(h.words(), '选中 2 字 / 全文 4 字');
  });

  test('选区收起：只写全文', () => {
    h.select(3, 3);
    assert.equal(h.words(), '全文 4 字');
  });

  test('字符数（含标点与空白）在悬停提示里', () => {
    assert.match(h.cell().title, /15 字符/);
  });

  test('没有目标时不画进度条', () => {
    assert.equal(h.bar().classList.contains('hidden'), true);
  });

  test('上千的字数带千分位', () => {
    h.open('long.md', '林'.repeat(3120));
    assert.equal(h.words(), '全文 3,120 字');
  });
});

describe('状态栏字数那一格：距目标（只对章节正文）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.index();
    h.open(CH3, '# 夜访\n\n林昭推开门。', { kind: 'chapter' });
  });

  test('本章字数 / 目标，还差多少；开头的「# 标题」那一行不算（与工程页同一个数法）', () => {
    assert.equal(h.words(), '5 / 10 字，还差 5');
  });

  test('一条细进度条，宽度是写了几成', () => {
    assert.equal(h.bar().classList.contains('hidden'), false);
    assert.equal(h.bar().querySelector('.ed-words-fill').style.width, '50%');
    assert.equal(h.bar().classList.contains('enough'), false);
  });

  test('打字实时跟着变，不等保存；到了八成进度条换色', () => {
    h.type('雨下了');
    assert.equal(h.words(), '8 / 10 字，还差 2');
    assert.equal(h.bar().classList.contains('enough'), true);
    h.type('三天');
    assert.equal(h.words(), '10 / 10 字，正好写够');
  });

  test('超了说超出多少，进度条停在满格', () => {
    h.type('又');
    assert.equal(h.words(), '11 / 10 字，超出 1');
    assert.equal(h.bar().querySelector('.ed-words-fill').style.width, '100%');
    assert.equal(h.bar().classList.contains('over'), true);
  });

  test('有选区时前面加选中字数', () => {
    h.select(6, 8);
    assert.equal(h.words(), '选中 2 字 · 11 / 10 字，超出 1');
    h.end();
  });

  test('悬停提示说目标从哪来', () => {
    assert.match(h.cell().title, /本章目标 10 字（细纲的目标字数，没写就是小说配置的每章字数）/);
  });

  test('章节索引里的目标变了：跟着变', () => {
    h.index([entry(3, '夜访', { targetWords: 20 }), entry(4, '北行')]);
    assert.equal(h.words(), '11 / 20 字，还差 9');
  });

  test('细纲不显示目标', () => {
    h.open(PLOT3, '## 梗概\n\n林昭夜访。', { kind: 'plot' });
    assert.equal(h.words(), '全文 6 字');
    assert.equal(h.bar().classList.contains('hidden'), true);
  });

  test('草稿不显示目标', () => {
    h.open('drafts/003-夜访.md', '草稿里的字', { kind: 'draft' });
    assert.equal(h.words(), '全文 5 字');
  });

  test('这一章没写目标（细纲与小说配置都没有）：不显示', () => {
    h.open(CH4, '出了城。', { kind: 'chapter' });
    assert.equal(h.words(), '全文 3 字');
  });

  test('章节索引里还没有这一章：不显示', () => {
    h.open('chapters/005-新章.md', '新的一章', { kind: 'chapter' });
    assert.equal(h.words(), '全文 4 字');
  });

  test('「视图 → 统计」关掉「距目标」：章节正文也只写全文', () => {
    h.open(CH3, '# 夜访\n\n林昭推开门。', { kind: 'chapter' });
    assert.match(h.words(), /\/ 20 字/);
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-stats-command', { detail: { name: 'toggleGoal' } }));
    assert.equal(h.words(), '全文 11 字');
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-stats-command', { detail: { name: 'toggleGoal' } }));
    assert.match(h.words(), /11 \/ 20 字/);
  });
});

describe('本次码字：只算亲手打的字', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.index();
    h.open(CH3, '林昭。\n\n\n她笑了。  ', { kind: 'chapter' });
  });

  test('开着之后还没动笔：本次 0 字', () => {
    assert.equal(h.session(), '0');
  });

  test('键盘打字：涨', () => {
    h.type('推开门');
    assert.equal(h.session(), '+3');
  });

  test('粘贴大段文字：全文涨、本次不涨', () => {
    h.paste('门外的雨下了一整夜');
    assert.match(h.words(), /^1[0-9] \/ 10 字/);
    assert.equal(h.session(), '+3');
  });

  test('一键排版：不涨', () => {
    const before = h.area().value;
    h.ui.clickEl(h.ui.doc.querySelector('#edToolbar .ed-format-btn'));
    assert.notEqual(h.area().value, before, '夹具要让排版真的改点什么');
    assert.equal(h.session(), '+3');
  });

  test('全部替换（替换之后字多了）：不涨', () => {
    h.key({ key: 'h', ctrlKey: true });
    const part = (cls) => h.ui.doc.querySelector(`#wbEditor .ed-find .${cls}`);
    part('ed-replace-input').value = '林昭昭';
    part('ed-find-input').value = '林昭';
    part('ed-find-input').dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(part('ed-replace-all'));
    assert.match(h.area().value, /林昭昭/);
    assert.equal(h.session(), '+3');
    h.key({ key: 'Escape' }, part('ed-find-input'));
  });

  test('撤销替换、排版、粘贴：不动；再撤销自己打的那三个字：减回去', () => {
    h.undo();
    h.undo();
    h.undo();
    assert.equal(h.session(), '+3');
    h.undo();
    assert.equal(h.session(), '0');
    assert.equal(h.area().value, '林昭。\n\n\n她笑了。  ');
  });

  test('重做：自己打的加回来，粘贴的照样不算', () => {
    h.redo();
    assert.equal(h.session(), '+3');
    h.redo();
    assert.equal(h.session(), '+3');
  });

  test('退格删字：倒扣', () => {
    h.end();
    h.type('一二三四');
    assert.equal(h.session(), '+7');
    h.backspace(2);
    assert.equal(h.session(), '+5');
  });

  test('输入法组字中途（拼音还没上屏）不算，上屏那一下算', () => {
    const commit = h.compose(['y', 'ye'], '夜');
    assert.equal(h.session(), '+5');
    commit();
    assert.equal(h.session(), '+6');
  });

  test('今日码字与本次同一个口径', () => {
    assert.equal(h.today(), '6');
  });
});

describe('码字统计面板', { skip: JSDOM_SKIP }, () => {
  let h;
  const t0 = new Date(2026, 9, 18, 14, 2).getTime();
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.clock(t0);
    h.index();
    h.open(CH3, '# 夜访\n\n林昭', { kind: 'chapter' });
  });

  test('按下鼠标不夺编辑区的焦点', () => {
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.cell().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('点那一格：弹出面板（本章、本次码字、今日码字、按文件、重新开始计时）', () => {
    const panel = h.clickCell();
    assert.ok(panel, '面板没出来');
    assert.equal(panel.parentElement, h.ui.doc.body);
    const heads = [...panel.querySelectorAll('.ed-stats-head')].map((n) => n.firstChild.textContent);
    assert.deepEqual(heads, ['本章', '本次码字', '今日码字', '本次按文件']);
    assert.ok(panel.querySelector('.ed-stats-restart'));
    assert.equal(h.cell().getAttribute('aria-expanded'), 'true');
  });

  test('本章：标题、字数与目标', () => {
    assert.equal(h.sec('ed-stats-file').querySelector('.ed-stats-title').textContent, '第 3 章《夜访》');
    assert.equal(h.sec('ed-stats-file').querySelector('.ed-stats-big').textContent, '2 / 10 字，还差 8');
  });

  test('还没动笔：按文件那一节照实说', () => {
    assert.match(h.sec('ed-stats-files').textContent, /还没有动笔/);
  });

  test('开着时接着打字：数跟着变；时长只算两下之间、速度写够 1 分钟才报', () => {
    h.type('推');
    h.clock(t0 + 30_000);
    h.type('开');
    assert.equal(h.sec('ed-stats-session').querySelector('.ed-stats-big').textContent, '+2 字');
    assert.match(h.sec('ed-stats-session').textContent, /写了 不到 1 分钟 · 写够 1 分钟才算速度/);
    h.clock(t0 + 120_000);
    h.type('门');
    assert.match(h.sec('ed-stats-session').textContent, /写了 2 分钟 · 每小时约 90 字/);
  });

  test('停笔超过 2 分钟的那段不算时长', () => {
    h.clock(t0 + 120_000 + 10 * 60_000);
    h.type('。');
    h.clock(t0 + 120_000 + 10 * 60_000 + 60_000);
    h.type('雨');
    assert.match(h.sec('ed-stats-session').textContent, /写了 3 分钟/);
  });

  test('按文件：这一章一行，写了多少、多久', () => {
    const rows = [...h.sec('ed-stats-files').querySelectorAll('.ed-stats-row')];
    assert.deepEqual(
      rows.map((r) => [...r.children].map((c) => c.textContent)),
      [['第 3 章《夜访》', '+4 字', '3 分钟']]
    );
    assert.equal(rows[0].title, CH3);
  });

  test('今日码字：同一个数，说清跨刷新、跨窗口累计', () => {
    assert.equal(h.sec('ed-stats-today').querySelector('.ed-stats-big').textContent, '4 字');
    assert.match(h.sec('ed-stats-today').textContent, /刷新、几个窗口都累计/);
  });

  test('Esc 收起', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    assert.equal(h.panel(), null);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'false');
  });

  test('点面板外面收起；点面板里面不收', () => {
    h.clickCell();
    h.panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.ui.doc.body.dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('再点一下那一格收起', () => {
    h.clickCell();
    assert.ok(h.panel());
    h.clickCell();
    assert.equal(h.panel(), null);
  });

  test('面板里的「重新开始计时」：本次归零、明细清空，今日不动', () => {
    h.clickCell();
    h.ui.clickEl(h.panel().querySelector('.ed-stats-restart'));
    assert.equal(h.sec('ed-stats-session').querySelector('.ed-stats-big').textContent, '0 字');
    assert.match(h.sec('ed-stats-files').textContent, /还没有动笔/);
    assert.equal(h.sec('ed-stats-today').querySelector('.ed-stats-big').textContent, '4 字');
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '4');
    assert.match(h.toasts.at(-1), /重新算/);
  });

  test('重新开始计时之后撤销之前打的字：不倒扣这一次', () => {
    h.undo();
    assert.equal(h.session(), '0');
    h.key({ key: 'Escape' }, h.ui.doc.body);
  });
});

describe('「视图 → 统计」', { skip: JSDOM_SKIP }, () => {
  let h;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (drop, label) =>
    [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  /** 悬停「统计」，返回子菜单里那几项。 */
  const statsItems = () => {
    item(viewMenu(), '统计').dispatchEvent(new h.ui.window.MouseEvent('mouseenter'));
    return [...h.ui.doc.querySelectorAll('.wb-menu-drop.submenu .wb-menu-item')];
  };
  const sub = (label) => statsItems().find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(() => {
    // 段落那几项先记着一个非缺省值：统计写偏好时不许把它冲掉。
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    h.index();
    h.open(CH3, '林昭推开门。', { kind: 'chapter' });
  });

  test('「视图」里有「统计 ›」与「重新开始计时」', () => {
    const drop = viewMenu();
    assert.ok(item(drop, '统计'));
    assert.ok(item(drop, '重新开始计时'));
    assert.equal(item(drop, '统计').disabled, false);
    h.ui.closeMenu();
  });

  test('三个开关：距目标缺省开，本次 / 今日缺省关', () => {
    const states = statsItems().map((b) => [b.querySelector('.wb-menu-label').textContent, b.getAttribute('aria-checked')]);
    assert.deepEqual(states, [
      ['状态栏显示距目标', 'true'],
      ['状态栏显示本次码字', 'false'],
      ['状态栏显示今日码字', 'false'],
    ]);
    h.ui.closeMenu();
  });

  test('缺省的状态栏：只有全文 / 选中与距目标', () => {
    assert.equal(h.words(), '5 / 10 字，还差 5');
  });

  test('打开「本次码字」：状态栏多一项，记进偏好且不冲掉段落那几项', () => {
    h.ui.clickEl(sub('状态栏显示本次码字'));
    assert.equal(h.words(), '5 / 10 字，还差 5 · 本次 0 字');
    assert.deepEqual(storedPrefs(), { autoPair: false, stats: { goal: true, session: true, today: false } });
    assert.equal(sub('状态栏显示本次码字').getAttribute('aria-checked'), 'true');
    h.ui.closeMenu();
  });

  test('打开「今日码字」、关掉「距目标」', () => {
    h.ui.clickEl(sub('状态栏显示今日码字'));
    h.ui.clickEl(sub('状态栏显示距目标'));
    assert.equal(h.words(), '全文 5 字 · 本次 0 字 · 今日 0 字');
    assert.equal(storedPrefs().stats.goal, false);
  });

  test('反过来：「编辑」菜单切成对符号，统计的偏好还在', () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const pair = [...h.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '成对符号自动补全'
    );
    h.ui.clickEl(pair);
    const prefs = storedPrefs();
    assert.equal(prefs.autoPair, true);
    assert.deepEqual(prefs.stats, { goal: false, session: true, today: true });
  });

  test('刷新之后开关照旧', () => {
    const again = harness({ storage: { [PREFS_KEY]: h.ui.window.localStorage.getItem(PREFS_KEY) } });
    again.open('notes.md', '林昭');
    assert.equal(again.words(), '全文 2 字 · 本次 0 字 · 今日 0 字');
  });

  test('菜单里的「重新开始计时」：本次归零、说一句', () => {
    h.type('雨');
    assert.equal(h.session(), '+1');
    h.ui.clickEl(item(viewMenu(), '重新开始计时'));
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '1');
    assert.match(h.toasts.at(-1), /重新算/);
  });
});

describe('大章节：每敲一下不整份重数', { skip: JSDOM_SKIP }, () => {
  // 定时器换成手拨的：整份重数是节流到定时器里的，不拨就不会发生——显示对了，说明走的是只数改动那一段。
  let h;
  const big = '林'.repeat(30_000);
  before(() => {
    h = harness({ shims: [...SHIMS, 'fakeTimers'] });
    h.open('big.md', big);
  });

  test('打开时数一遍', () => {
    assert.equal(h.words(), '全文 30,000 字');
  });

  test('打字、粘贴、退格：当场就对（只数改动那一段，不等重数）', () => {
    h.type('昭');
    assert.equal(h.words(), '全文 30,001 字');
    h.paste(' and more');
    assert.equal(h.words(), '全文 30,003 字');
    h.backspace(4);
    assert.equal(h.words(), '全文 30,002 字');
  });

  test('英文词中间打字：词数照对', () => {
    h.backspace(1);
    assert.equal(h.words(), '全文 30,002 字');
    h.type('x');
    assert.equal(h.words(), '全文 30,002 字', '「and」接成「andx」还是一个词');
    h.type(' y');
    assert.equal(h.words(), '全文 30,003 字');
  });

  test('撤销（没有改动可用）：先显示上一次的数，节流的那一下到了再整份重数', () => {
    h.undo();
    assert.equal(h.area().value, `${big}昭 and`);
    assert.equal(h.words(), '全文 30,003 字');
    h.ui.window.__clock.tick(300);
    assert.equal(h.words(), '全文 30,002 字');
  });
});

describe('今日码字：按工程、按本地日期，跨刷新、跨窗口', { skip: JSDOM_SKIP }, () => {
  const t0 = new Date(2026, 9, 18, 21, 0).getTime();
  const today = dayOf(t0);
  let first;
  let saved;

  test('码了字、页面藏起来（或关掉）时写进 localStorage，键里带工程', () => {
    first = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    first.clock(t0);
    first.open('notes.md', '');
    first.type('林昭推开门');
    first.flushDaily();
    saved = first.ui.window.localStorage.getItem(DAILY_KEY);
    assert.deepEqual(JSON.parse(saved), { v: 1, days: { [today]: { words: 5, ms: 0 } } });
  });

  test('刷新之后今日码字还在，本次从 0 起', () => {
    const second = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: saved } });
    second.clock(t0 + 60_000);
    second.open('notes.md', '林昭推开门');
    assert.equal(second.today(), '5');
    assert.equal(second.session(), '0');
  });

  test('别的窗口记了（storage 事件）：加进来；这边再写时只加自己的增量，不覆盖别人的', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: saved } });
    h.clock(t0 + 120_000);
    h.open('notes.md', '');
    // 另一个窗口把今天记成了 12 字（它自己又码了 7 个）。
    const other = JSON.stringify({ v: 1, days: { [today]: { words: 12, ms: 0 } } });
    h.ui.window.localStorage.setItem(DAILY_KEY, other);
    h.ui.window.dispatchEvent(new h.ui.window.StorageEvent('storage', { key: DAILY_KEY, newValue: other }));
    assert.equal(h.today(), '12');
    h.type('雨夜');
    assert.equal(h.today(), '14');
    h.flushDaily();
    assert.equal(h.daily().days[today].words, 14);
  });

  test('过了午夜：换新的一天，前一天的照样记在前一天', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    const late = new Date(2026, 9, 18, 23, 59).getTime();
    h.clock(late);
    h.open('notes.md', '');
    h.type('林昭');
    assert.equal(h.today(), '2');
    h.clock(late + 2 * 60_000);
    h.type('夜');
    assert.equal(h.today(), '1');
    assert.equal(h.session(), '+3', '本次不分日子');
    h.flushDaily();
    assert.deepEqual(
      Object.fromEntries(Object.entries(h.daily().days).map(([k, v]) => [k, v.words])),
      { [dayOf(late)]: 2, [dayOf(late + 2 * 60_000)]: 1 }
    );
  });

  test('localStorage 里那份写坏了：当没有，从零记，写回去的是好的', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: '{不是 JSON' } });
    h.clock(t0);
    h.open('notes.md', '');
    assert.equal(h.today(), '0');
    h.type('林昭推');
    h.flushDaily();
    assert.deepEqual(h.daily(), { v: 1, days: { [today]: { words: 3, ms: 0 } } });
  });

  test('换了工程：没写进去的按原来那个工程记，本次从头算', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.clock(t0);
    h.open('notes.md', '');
    h.type('林昭');
    const url = new h.ui.window.URL(h.ui.window.location.href);
    url.searchParams.set('project', '/书/另一本');
    h.ui.window.history.replaceState(null, '', url.toString());
    h.ui.window.dispatchEvent(new h.ui.window.Event('nf-workspace-reset'));
    assert.equal(h.daily().days[today].words, 2);
    assert.equal(h.ui.window.localStorage.getItem('novelforge.editor.stats.daily@/书/另一本'), null);
    h.open('other.md', '');
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '0');
  });

  test('记不下来（没有工程标识）：只算这一页，面板上照实说', () => {
    const h = harness({ url: undefined, storage: { [PREFS_KEY]: SHOW_ALL } });
    h.open('notes.md', '');
    h.type('林昭');
    assert.equal(h.today(), '2');
    h.flushDaily();
    const keys = Object.keys(h.ui.window.localStorage).filter((k) => k.startsWith('novelforge.editor.stats.daily'));
    assert.deepEqual(keys, [], '一条今日码字都没往 localStorage 里写');
    h.clickCell();
    assert.match(h.sec('ed-stats-today').textContent, /只算这一页/);
  });
});
