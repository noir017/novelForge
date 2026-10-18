/**
 * 标签分得清、路径看得懂（独立版内置编辑器）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 同一章的正文 / 细纲 / 草稿 | 名字一样，前面的短标记各不相同（正文不带）；悬停是完整相对路径 |
 * | 两卷里各一个「003-夜访」 | 同一种、不同目录的再加最短的区分目录；只剩一个时不再加 |
 * | 两块编辑区各开一份同名的 | 放在一起比，也加区分目录 |
 * | 后端没给称呼 | 标签写文件名、工具栏写原始路径（一段，不能点） |
 * | 面包屑 | 「细纲 › 第一卷 › 第 3 章 夜访」，原始路径在悬停提示上；目录段是按钮，文件段不是 |
 * | 点面包屑的目录段 | 「文件」页切出来、展开到那个目录、那一行标出来 |
 * | 标签条 | 滚轮横着滚；激活的那个滚进视野；重画不把滚动位置归零 |
 * | 「▾」 | 两块编辑区开着的全部文件按块分组、标出没保存的；点了切过去；关掉的列在「最近关闭」，点了重新打开 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');

/** 后端 `views/editorLabel.ts` 给的称呼（这里手写，形状一样）。 */
const L = {
  ch3: { tag: '', title: '003-夜访', crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 3 章 夜访' }] },
  plot3: {
    tag: '细纲',
    title: '003-夜访',
    crumbs: [
      { label: '细纲', dir: '.novelforge/summaries' },
      { label: '第一卷', dir: '.novelforge/summaries/第一卷' },
      { label: '第 3 章 夜访' },
    ],
  },
  draft3: { tag: '草稿', title: '003-夜访', crumbs: [{ label: '草稿', dir: 'drafts' }, { label: '第 3 章 夜访' }] },
  vol1: {
    tag: '',
    title: '003-夜访',
    crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第一卷', dir: 'chapters/第一卷' }, { label: '第 3 章 夜访' }],
  },
  vol2: {
    tag: '',
    title: '003-夜访',
    crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第二卷', dir: 'chapters/第二卷' }, { label: '第 3 章 夜访' }],
  },
};

const open = (ui, path, label, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的内容`, { label }), ...extra });

describe('标签：同一章的三份分得清', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];
  const shown = (tab) => [tab.querySelector('.ed-tab-tag')?.textContent ?? '', tab.querySelector('.ed-tab-name').textContent];

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/003-夜访.md', L.ch3);
    open(ui, '.novelforge/summaries/第一卷/003-夜访.md', L.plot3);
    open(ui, 'drafts/003-夜访.md', L.draft3);
  });

  test('名字都去掉了扩展名，正文不带短标记、细纲与草稿各带一个', () => {
    assert.deepEqual(tabs().map(shown), [
      ['', '003-夜访'],
      ['细纲', '003-夜访'],
      ['草稿', '003-夜访'],
    ]);
  });

  test('短标记不同就不算同名：不加区分目录', () => {
    assert.equal(ui.doc.querySelectorAll('.ed-tab-desc').length, 0);
  });

  test('悬停提示是完整的相对路径', () => {
    assert.deepEqual(
      tabs().map((t) => t.title),
      ['chapters/003-夜访.md', '.novelforge/summaries/第一卷/003-夜访.md', 'drafts/003-夜访.md']
    );
  });

  test('后端没给称呼：标签写文件名', () => {
    ui.post({ type: 'editorOpen', file: file('notes.txt', '随手记') });
    assert.deepEqual(shown(tabs()[3]), ['', 'notes.txt']);
  });
});

describe('标签：同名的加最短的区分目录', { skip: JSDOM_SKIP }, () => {
  let ui;
  const descs = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.querySelector('.ed-tab-desc')?.textContent ?? '');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/第一卷/003-夜访.md', L.vol1);
    open(ui, 'chapters/第二卷/003-夜访.md', L.vol2);
  });

  test('两卷里各一个「003-夜访」：后面写卷名', () => {
    assert.deepEqual(descs(ui.panes()[0]), ['第一卷', '第二卷']);
  });

  test('关掉一个：剩下那个不再加', () => {
    ui.clickEl(ui.doc.querySelectorAll('.ed-tab-close')[1]);
    assert.deepEqual(descs(ui.panes()[0]), ['']);
  });

  test('两块编辑区各开一份同名的：放在一起比，两边都加', () => {
    open(ui, 'chapters/第二卷/003-夜访.md', L.vol2, { pane: 'draft' });
    assert.deepEqual([descs(ui.panes()[0]), descs(ui.panes()[1])], [['第一卷'], ['第二卷']]);
  });

  test('右边那一份关掉：左边那份的区分目录跟着收起', () => {
    ui.clickEl(ui.panes()[1].querySelector('.ed-tab-close'));
    assert.deepEqual(descs(ui.panes()[0]), ['']);
  });
});

describe('工具栏面包屑', { skip: JSDOM_SKIP }, () => {
  let ui;
  const path = () => ui.doc.getElementById('edPath');
  const segs = () => [...path().children].map((n) => n.textContent);

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    });
    open(ui, '.novelforge/summaries/第一卷/003-夜访.md', L.plot3);
  });

  test('写成「细纲 › 第一卷 › 第 3 章 夜访」', () => {
    assert.deepEqual(segs(), ['细纲', '›', '第一卷', '›', '第 3 章 夜访']);
  });

  test('原始相对路径在悬停提示上', () => {
    assert.equal(path().title, '.novelforge/summaries/第一卷/003-夜访.md');
  });

  test('目录段是按钮，文件那一段不是', () => {
    const buttons = [...path().querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['细纲', '第一卷']);
  });

  test('点目录段：切到「文件」页、展开到那个目录', () => {
    ui.sent.length = 0;
    ui.clickEl([...path().querySelectorAll('button')].find((b) => b.textContent === '第一卷'));
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'), '没切到文件页');
    assert.equal(ui.last('switchTab')?.tab, 'files');
    const dirs = ui.last('listDir')?.dirs ?? [];
    for (const dir of ['.novelforge', '.novelforge/summaries', '.novelforge/summaries/第一卷']) {
      assert.ok(dirs.includes(dir), `${dir} 没展开：${JSON.stringify(dirs)}`);
    }
  });

  test('目录列出来之后那一行标出来', () => {
    ui.post({ type: 'dirListings', listings: [
      listing('', { '.novelforge': 'dir' }),
      listing('.novelforge', { summaries: 'dir' }),
      listing('.novelforge/summaries', { 第一卷: 'dir' }),
      listing('.novelforge/summaries/第一卷', { '003-夜访.md': 'file' }),
    ] });
    const row = ui.doc.querySelector('#filesBody .fx-row.fx-revealed');
    assert.ok(row, '没有标出来的行');
    assert.equal(row.dataset.path, '.novelforge/summaries/第一卷');
  });

  test('后端没给称呼：只写原始路径一段，不能点', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/project.json', '{}') });
    assert.deepEqual(segs(), ['.novelforge/project.json']);
    assert.equal(path().querySelectorAll('button').length, 0);
  });
});

describe('标签条：横着滚、当前那个滚进视野', { skip: JSDOM_SKIP }, () => {
  let ui;
  const list = () => ui.panes()[0].querySelector('.ed-tabs-list');
  const TAB_WIDTH = 100;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    // 假排版：标签一个 100px 宽、一个挨一个；标签条的可见宽度 250px。
    const { HTMLElement } = ui.window;
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tab') ? [...this.parentNode.children].indexOf(this) * TAB_WIDTH : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tab') ? TAB_WIDTH : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tabs-list') ? 250 : 0;
      },
    });
    for (let i = 1; i <= 6; i++) {
      ui.post({ type: 'editorOpen', file: file(`notes/${i}.md`, `第 ${i} 份`) });
    }
  });

  test('标签在可滚动的那一格里，末尾一颗「▾」', () => {
    assert.equal(list().querySelectorAll('.ed-tab').length, 6);
    assert.equal(ui.panes()[0].querySelector('.ed-tabs-more').textContent, '▾');
  });

  test('新开的（最后一个）滚进视野：右边贴齐', () => {
    assert.equal(list().scrollLeft, 6 * TAB_WIDTH - 250);
  });

  test('切到第一个：左边贴齐', () => {
    ui.clickEl(list().querySelectorAll('.ed-tab')[0]);
    assert.equal(list().scrollLeft, 0);
  });

  test('竖着拨滚轮：横着滚，并且拦下默认动作', () => {
    const ev = new ui.window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list().dispatchEvent(ev);
    assert.equal(list().scrollLeft, 120);
    assert.equal(ev.defaultPrevented, true);
  });

  test('重画标签（切到一个已在视野里的）不把滚动位置归零', () => {
    // 视野是 120–370：第 3 个（200–300）在里面。
    ui.clickEl(list().querySelectorAll('.ed-tab')[2]);
    assert.equal(list().scrollLeft, 120);
  });
});

describe('「▾」：两块编辑区开着的文件与最近关闭', { skip: JSDOM_SKIP }, () => {
  let ui;
  const more = () => ui.panes()[0].querySelector('.ed-tabs-more');
  const openMenu = () => {
    ui.clickEl(more());
    return ui.doc.querySelector('.ctx-menu');
  };
  const btn = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.includes(prefix));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/003-夜访.md', L.ch3);
    open(ui, 'notes.txt', undefined);
    open(ui, '.novelforge/summaries/第一卷/003-夜访.md', L.plot3, { pane: 'draft' });
    // 左边的正文改一笔：列表里要标出来。
    ui.clickEl(ui.panes()[0].querySelectorAll('.ed-tab')[0]);
    const area = ui.doc.getElementById('edArea');
    area.value += '，又写了一句';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  });

  test('点「▾」弹出列表：按块分组，两块的文件都在', () => {
    const menu = openMenu();
    assert.ok(menu, '没弹出菜单');
    const labels = ui.itemsOf(menu);
    assert.equal(labels[0], '左侧编辑区');
    assert.ok(labels.indexOf('右侧编辑区') > labels.findIndex((l) => l.includes('notes.txt')), JSON.stringify(labels));
    assert.ok(labels.some((l) => l.includes('细纲 003-夜访')), JSON.stringify(labels));
    ui.closeMenu();
  });

  test('没保存的那一份标出来', () => {
    const menu = openMenu();
    const dirty = btn(menu, '003-夜访（未保存）');
    assert.ok(dirty?.textContent.startsWith('●'), dirty?.textContent);
    assert.ok(!btn(menu, 'notes.txt').textContent.includes('未保存'));
    ui.closeMenu();
  });

  test('分组的标题点不了', () => {
    const menu = openMenu();
    assert.equal(btn(menu, '左侧编辑区').disabled, true);
    ui.closeMenu();
  });

  test('点右边那一份：切过去，当前那一块换成右边', () => {
    const events = [];
    ui.window.addEventListener('nf-editor-active', (e) => events.push(e.detail.path));
    ui.clickEl(btn(openMenu(), '细纲 003-夜访'));
    assert.equal(events.pop(), '.novelforge/summaries/第一卷/003-夜访.md');
    assert.equal(ui.doc.querySelector('.ctx-menu'), null, '菜单没收起');
  });

  test('关掉一个：列在「最近关闭」，点了按原来那一块重新打开', () => {
    const notes = [...ui.panes()[0].querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('notes.txt'));
    ui.clickEl(notes.querySelector('.ed-tab-close'));
    const menu = openMenu();
    const labels = ui.itemsOf(menu);
    assert.ok(labels.includes('最近关闭'), JSON.stringify(labels));
    ui.sent.length = 0;
    ui.clickEl(btn(menu, 'notes.txt · 左侧'));
    assert.deepEqual(
      (({ path, pane }) => ({ path, pane }))(ui.last('openEditor')),
      { path: 'notes.txt', pane: 'main' }
    );
  });

  test('再点一下「▾」收起', () => {
    openMenu();
    // 菜单开着时这一下点击冒到 document 上去，由菜单引擎收起。
    more().dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
  });
});
