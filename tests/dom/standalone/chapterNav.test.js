/**
 * 上一章 / 下一章（独立版内置编辑器，`editor/chapterNav.ts` + 章节条）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 数据 | 只靠 `chapterIndex`（对话页开着、从没推过工程树）也有章节条、能翻章 |
 * | 到头了 | 章节条上那一颗禁用；快捷键说一句 |
 * | 正文跟正文、细纲跟细纲 | 当前标签是哪一面就换成相邻那一章的哪一面；顺序按章号（分卷目录里的照样排进来） |
 * | 没改过 | 在原位置换掉（打开请求带 `replace`，收到时占它的位置） |
 * | 改过了 | 另开一个标签，改过的那一份留着 |
 * | 相邻那一章已经开着 | 直接切过去，不发打开请求 |
 * | 相邻那一章没有这一面 | 照实说，不打开不存在的文件 |
 * | 另一块开着配对文件 | 同样换成相邻那一章的配对文件，不抢焦点；相邻那一章没有配对的那一面时说一句、旁边那份不动 |
 * | 快捷键 Alt+PageUp / Alt+PageDown | 焦点在对话输入框里不拦；输入法组字中途不拦 |
 * | 章节条在左侧，当前文件在右侧 | 在条上按下去不把「当前这一块」抢到左侧，翻的是右侧那一份 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const S = '.novelforge/summaries';
const row = (no, title, chapterPath, plotPath, plotExists, stage, wordCount = 0) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: chapterPath || plotPath,
  plotPath,
  plotExists,
  chapterPath,
  wordCount,
  targetWords: 3000,
  stage,
});
/** 六章：第 2 章在卷目录里；第 5 章只有正文、第 6 章只有细纲。 */
const INDEX = [
  row(1, '雨夜', 'chapters/001-雨夜.md', `${S}/001-雨夜.md`, true, 'done', 3000),
  row(2, '入镇', 'chapters/第一卷/002-入镇.md', `${S}/第一卷/002-入镇.md`, true, 'finalize', 2980),
  row(3, '夜访', 'chapters/003-夜访.md', `${S}/003-夜访.md`, true, 'done', 3100),
  row(4, '北行', 'chapters/004-北行.md', `${S}/004-北行.md`, true, 'finalize', 2900),
  row(5, '赤星', 'chapters/005-赤星.md', `${S}/005-赤星.md`, false, 'finalize', 2500),
  row(6, '归途', '', `${S}/006-归途.md`, true, 'manuscript'),
];

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView'];

function setup() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
  ui.post({ type: 'chapterIndex', chapters: INDEX });
  return ui;
}
const open = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的内容`), ...extra });
const echo = (ui, msg) => open(ui, msg.path, { pane: msg.pane, ...(msg.replace ? { replace: msg.replace } : {}) });
const key = (ui, k, extra) =>
  ui.doc.activeElement.dispatchEvent(
    new ui.window.KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true, ...extra })
  );
const opens = (ui) => ui.sent.filter((m) => m.type === 'openEditor');
const tabPaths = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.dataset.path);
const toastText = (ui) => ui.doc.getElementById('toast').textContent;
const bar = (ui) => ui.doc.getElementById('edChapterBar');
const nav = (ui, which) => bar(ui).querySelector(`button[data-nav="${which}"]`);

describe('上一章 / 下一章：在原位置换、改过另开', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];

  before(() => {
    ui = setup();
    open(ui, 'notes/a.md');
    open(ui, 'chapters/001-雨夜.md');
    open(ui, 'notes/b.md');
    ui.clickEl(main().querySelector('.ed-tab[data-path="chapters/001-雨夜.md"]'));
  });

  test('没推过工程树（对话页）也有章节条，两颗按钮夹着这一章的说明', () => {
    assert.ok(!bar(ui).classList.contains('hidden'));
    assert.deepEqual(
      [...bar(ui).children].slice(0, 3).map((n) => n.textContent),
      ['‹ 上一章', '第 1 章《雨夜》 · 已完成 · 3000 / 3000 字', '下一章 ›']
    );
  });

  test('第一章：「上一章」禁用，提示说到头了', () => {
    assert.equal(nav(ui, 'prev').disabled, true);
    assert.match(nav(ui, 'prev').title, /已经是第一章了/);
    assert.equal(nav(ui, 'next').disabled, false);
    assert.match(nav(ui, 'next').title, /第 2 章《入镇》的正文（Alt\+PageDown）/);
  });

  test('第一章按 Alt+PageUp：说一句，不发打开请求', () => {
    ui.sent.length = 0;
    key(ui, 'PageUp');
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /已经是第一章了/);
  });

  test('没改过：请后端打开第 2 章的正文（卷目录里的照样排在第 2），带 replace', () => {
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const msg = opens(ui).pop();
    assert.deepEqual(
      { path: msg.path, pane: msg.pane, replace: msg.replace },
      { path: 'chapters/第一卷/002-入镇.md', pane: 'main', replace: 'chapters/001-雨夜.md' }
    );
    echo(ui, msg);
  });

  test('收到之后占第 1 章原来的位置，第 1 章不在了', () => {
    assert.deepEqual(tabPaths(main()), ['notes/a.md', 'chapters/第一卷/002-入镇.md', 'notes/b.md']);
    assert.equal(main().querySelector('.ed-tab.active').dataset.path, 'chapters/第一卷/002-入镇.md');
  });

  test('改过了：点「下一章 ›」另开一个标签，改过的那一份留着', () => {
    const area = ui.doc.getElementById('edArea');
    area.value += '，又写了一句';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'next'));
    const msg = opens(ui).pop();
    assert.equal(msg.path, 'chapters/003-夜访.md');
    assert.equal('replace' in msg, false);
    echo(ui, msg);
    assert.deepEqual(tabPaths(main()), ['notes/a.md', 'chapters/第一卷/002-入镇.md', 'notes/b.md', 'chapters/003-夜访.md']);
    assert.ok(main().querySelector('.ed-tab[data-path="chapters/第一卷/002-入镇.md"]').classList.contains('dirty'));
  });

  test('相邻那一章已经开着：直接切过去，不发打开请求', () => {
    ui.sent.length = 0;
    key(ui, 'PageUp');
    assert.equal(opens(ui).length, 0);
    assert.equal(main().querySelector('.ed-tab.active').dataset.path, 'chapters/第一卷/002-入镇.md');
  });

  test('相邻那一章没有正文：照实说，不打开', () => {
    open(ui, 'chapters/005-赤星.md');
    ui.sent.length = 0;
    key(ui, 'PageDown');
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /第 6 章《归途》还没有正文/);
    assert.match(nav(ui, 'next').title, /还没有正文/);
  });

  test('焦点在对话输入框里：Alt+PageDown 不拦', () => {
    ui.doc.getElementById('input').focus();
    ui.sent.length = 0;
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'PageUp', altKey: true, bubbles: true, cancelable: true });
    ui.doc.getElementById('input').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(opens(ui).length, 0);
  });

  test('输入法组字中途：不拦', () => {
    ui.doc.getElementById('edArea').focus();
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'PageUp', altKey: true, isComposing: true, bubbles: true, cancelable: true });
    ui.doc.getElementById('edArea').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('上一章 / 下一章：细纲跟细纲，最后一章禁用', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = setup();
    open(ui, `${S}/004-北行.md`, { pane: 'draft' });
  });

  test('当前是细纲：下一章找细纲——第 5 章没有细纲，照实说', () => {
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'next'));
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /第 5 章《赤星》还没有细纲/);
  });

  test('上一章：第 3 章的细纲，开在它自己那一块', () => {
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'prev'));
    const msg = opens(ui).pop();
    assert.deepEqual({ path: msg.path, pane: msg.pane, replace: msg.replace }, { path: `${S}/003-夜访.md`, pane: 'draft', replace: `${S}/004-北行.md` });
  });

  test('最后一章：「下一章」禁用', () => {
    open(ui, `${S}/006-归途.md`, { pane: 'draft' });
    assert.equal(nav(ui, 'next').disabled, true);
    assert.match(nav(ui, 'next').title, /已经是最后一章了/);
  });
});

describe('上一章 / 下一章：另一块的配对文件跟着走', { skip: JSDOM_SKIP }, () => {
  let ui;
  const active = [];
  const main = () => ui.panes()[0];
  const right = () => ui.panes()[1];

  before(() => {
    ui = setup();
    ui.window.addEventListener('nf-editor-active', (e) => active.push(e.detail.path));
    open(ui, `${S}/003-夜访.md`, { pane: 'draft' });
    open(ui, 'chapters/003-夜访.md');
  });

  test('两份请求：配对的那一份先发、带 replace，再发这一块的', () => {
    ui.doc.getElementById('edArea').focus();
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const [pair, own] = opens(ui);
    assert.deepEqual(
      [pair, own].map((m) => [m.path, m.pane, m.replace]),
      [
        [`${S}/004-北行.md`, 'draft', `${S}/003-夜访.md`],
        ['chapters/004-北行.md', 'main', 'chapters/003-夜访.md'],
      ]
    );
  });

  test('配对那一份先到：换掉右边的，但「当前这一块」还是左边', () => {
    const [pair] = opens(ui);
    active.length = 0;
    echo(ui, pair);
    assert.deepEqual(tabPaths(right()), [`${S}/004-北行.md`]);
    assert.ok(!active.includes(`${S}/004-北行.md`), JSON.stringify(active));
  });

  test('这一块的到了：左边换成第 4 章正文，当前是它', () => {
    const [, own] = opens(ui);
    echo(ui, own);
    assert.deepEqual(tabPaths(main()), ['chapters/004-北行.md']);
    assert.equal(active.pop(), 'chapters/004-北行.md');
  });

  test('相邻那一章没有配对的那一面：这一块照翻，旁边那份不动，说一句', () => {
    ui.doc.getElementById('edArea').focus();
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const sent = opens(ui);
    assert.deepEqual(sent.map((m) => [m.path, m.pane]), [['chapters/005-赤星.md', 'main']]);
    assert.match(toastText(ui), /第 5 章《赤星》还没有细纲，旁边那一份没换/);
  });

  test('当前文件在右边、在左边的章节条上点按钮：翻的是右边那一份', () => {
    echo(ui, opens(ui)[0]);
    // 切到右边的细纲（第 4 章）。
    ui.clickEl(right().querySelector('.ed-tab'));
    assert.match(bar(ui).querySelector('.ed-chapter-info').textContent, /第 4 章/);
    ui.sent.length = 0;
    const prev = nav(ui, 'prev');
    prev.dispatchEvent(new ui.window.Event('pointerdown', { bubbles: true }));
    prev.dispatchEvent(new ui.window.FocusEvent('focusin', { bubbles: true }));
    ui.clickEl(nav(ui, 'prev'));
    const msg = opens(ui).pop();
    assert.deepEqual([msg.path, msg.pane], [`${S}/003-夜访.md`, 'draft']);
  });
});
