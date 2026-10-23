/**
 * 工程页「章节」页签的分卷（2026-10-23 作者要求：按卷分类、右键新建卷、新建的默认放进最新一卷）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 分卷画法 | 一卷一个标题行（`📂 第一卷`），后面跟这一卷的章、缩一层；副标题写章号区间与字数，空卷写「空」；新章的落点那一卷多一句「新章落这里」，空着的话卷里那一行也这么说；「去写这一章」照旧挂在下一章上 |
 * | 折叠 | 点卷名折起 / 展开，只折这一卷；重推树还折着 |
 * | 卷的右键 | 「在此卷新建章节文件」带这一卷的目录、「新建卷…」落在章节根、重命名 / 删除带卷目录，没有「移动到…」 |
 * | 未分卷 | 直接放在章节根下的章叫「未分卷」，右键新建落在章节根、不给重命名与删除 |
 * | 没分卷 | `volumes` 空：照旧平铺，没有卷标题 |
 * | 空书 | 一章都没有、只建了一卷：画出那一卷与空卷提示，下面照旧写下一步 |
 *
 * 卷的先后、哪一卷是落点都是后端排好的（`views/projectView.ts` 的 `buildVolumes`，见 integration/files/volumes.test.js）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

/**
 * sampleTree 的五章分进两卷，另有一卷刚建、还空着（新章落进它）：
 *
 * | 卷 | 章 | 字数 |
 * |---|---|---|
 * | 第一卷 | 1–3 | 3580 |
 * | 第二卷 | 4–5 | 0 |
 * | 第三卷 | — | — |
 */
const volumeTree = (extra) => {
  const base = sampleTree();
  return {
    ...base,
    plots: base.plots.map((p) => ({ ...p, volume: p.no <= 3 ? '第一卷' : '第二卷' })),
    volumes: [
      { name: '第一卷', relPath: 'chapters/第一卷', from: 1, to: 3, words: 3580, latest: false },
      { name: '第二卷', relPath: 'chapters/第二卷', from: 4, to: 5, words: 0, latest: false },
      { name: '第三卷', relPath: 'chapters/第三卷', words: 0, latest: true },
    ],
    ...extra,
  };
};

const chaptersGroup = (ui) => ui.doc.querySelector('#projectBody [data-group="plots"]');
const volumeRow = (ui, relPath) => chaptersGroup(ui).querySelector(`.row-volume[data-volume="${relPath}"]`);
/** 章节组里从上到下画了什么：卷标题写卷名，章写章号，空提示写原文。 */
const layout = (ui) =>
  [...chaptersGroup(ui).querySelector('.group-body').children].map((r) =>
    r.classList.contains('row-volume')
      ? `卷:${r.querySelector('.row-label').textContent.replace(/^\S+ /, '')}`
      : r.classList.contains('row-plot') && r.dataset.plot
        ? `章:${r.querySelector('.row-label').textContent}`
        : r.textContent
  );

describe('分卷画法', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
  });

  test('一卷一个标题行，后面跟这一卷的章，空卷说新章落在这里', () => {
    assert.deepEqual(layout(ui), [
      '卷:第一卷', '章:第 1 章《楔子》', '章:第 2 章《入镇》', '章:第 3 章《夜访》',
      '卷:第二卷', '章:第 4 章《北行》', '章:第 5 章《赤星》',
      '卷:第三卷', '（空卷：接下来新建的章落在这里）',
    ]);
  });

  test('卷标题默认展开，带打开的文件夹图标', () => {
    const row = volumeRow(ui, 'chapters/第一卷');
    assert.equal(row.querySelector('.caret').textContent, '▾');
    assert.equal(row.querySelector('.row-label').textContent, '📂 第一卷');
  });

  test('副标题写章号区间与字数，没写正文不报字数，空卷写「空」', () => {
    const meta = (rel) => volumeRow(ui, rel).querySelector('.meta').textContent;
    assert.equal(meta('chapters/第一卷'), '第 1–3 章 · 3580 字');
    assert.equal(meta('chapters/第二卷'), '第 4–5 章');
    assert.equal(meta('chapters/第三卷'), '空 · 新章落这里');
  });

  test('只有落点那一卷标着', () => {
    const latest = [...chaptersGroup(ui).querySelectorAll('.row-volume.is-latest')].map((r) => r.dataset.volume);
    assert.deepEqual(latest, ['chapters/第三卷']);
  });

  test('卷里的章缩进一层', () => {
    const row = chaptersGroup(ui).querySelector('.row-plot[data-plot="chapters/001-楔子.md"]');
    assert.equal(row.style.paddingLeft, '30px');
    assert.equal(volumeRow(ui, 'chapters/第一卷').style.paddingLeft, '16px');
  });

  test('「去写这一章」照旧挂在下一章上', () => {
    const go = [...chaptersGroup(ui).querySelectorAll('.row-go')];
    assert.equal(go.length, 1);
    assert.equal(go[0].closest('.row-plot').dataset.plot, '.novelforge/summaries/004-北行.md');
  });
});

describe('卷的折叠', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
    ui.clickEl(volumeRow(ui, 'chapters/第一卷').querySelector('.row-label'));
  });

  test('点卷名只折这一卷', () => {
    assert.deepEqual(layout(ui), [
      '卷:第一卷',
      '卷:第二卷', '章:第 4 章《北行》', '章:第 5 章《赤星》',
      '卷:第三卷', '（空卷：接下来新建的章落在这里）',
    ]);
    const row = volumeRow(ui, 'chapters/第一卷');
    assert.equal(row.querySelector('.caret').textContent, '▸');
    assert.equal(row.querySelector('.row-label').textContent, '📁 第一卷');
  });

  test('重推树还折着', () => {
    ui.post({ type: 'project', tree: volumeTree() });
    assert.equal(layout(ui)[1], '卷:第二卷');
  });

  test('右键「展开」再打开', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第一卷')), '展开');
    assert.equal(layout(ui)[1], '章:第 1 章《楔子》');
  });
});

describe('卷的右键', { skip: JSDOM_SKIP }, () => {
  let ui;
  let items;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
    items = ui.itemsOf(ui.rightClick(volumeRow(ui, 'chapters/第二卷')));
    ui.closeMenu();
  });

  test('折叠、新建、重命名、删除，没有移动', () => {
    assert.deepEqual(items, ['折叠', '在此卷新建章节文件', '新建卷…', '重命名', '删除（移到回收站）']);
  });

  test('「在此卷新建章节文件」带这一卷的目录', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), '在此卷新建章节文件');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newChapter', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters/第二卷', JSON.stringify(msg));
  });

  test('「新建卷…」落在章节根', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), '新建卷…');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newFolder', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters', JSON.stringify(msg));
  });

  for (const [label, action] of [['重命名', 'rename'], ['删除（移到回收站）', 'delete']]) {
    test(`「${label}」带卷目录`, () => {
      ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), label);
      const msg = ui.last('fileAction');
      assert.deepEqual({ ...msg }, { type: 'fileAction', action, relPath: 'chapters/第二卷' });
    });
  }
});

describe('未分卷', { skip: JSDOM_SKIP }, () => {
  let ui;

  // 第 1 章是序章，直接放在章节根下；2–5 章在第一卷，新章跟着进第一卷。
  before(() => {
    ui = mount();
    const base = sampleTree();
    ui.post({
      type: 'project',
      tree: {
        ...base,
        plots: base.plots.map((p) => ({ ...p, volume: p.no === 1 ? '' : '第一卷' })),
        volumes: [
          { name: '', relPath: 'chapters', from: 1, to: 1, words: 300, latest: false },
          { name: '第一卷', relPath: 'chapters/第一卷', from: 2, to: 5, words: 3280, latest: true },
        ],
      },
    });
  });

  test('根下的章叫「未分卷」，照章号排在前面', () => {
    assert.deepEqual(layout(ui).slice(0, 3), ['卷:未分卷', '章:第 1 章《楔子》', '卷:第一卷']);
    assert.equal(volumeRow(ui, 'chapters/第一卷').querySelector('.meta').textContent, '第 2–5 章 · 3280 字 · 新章落这里');
  });

  test('右键新建落在章节根，不给重命名与删除', () => {
    const menu = ui.rightClick(volumeRow(ui, 'chapters'));
    assert.deepEqual(ui.itemsOf(menu), ['折叠', '新建章节文件（不放进卷里）', '新建卷…']);
    ui.pick(menu, '新建章节文件（不放进卷里）');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newChapter', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters', JSON.stringify(msg));
  });
});

describe('没分卷照旧平铺', { skip: JSDOM_SKIP }, () => {
  test('没有卷标题，章不缩进', () => {
    const ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    assert.equal(chaptersGroup(ui).querySelectorAll('.row-volume').length, 0);
    assert.equal(layout(ui).filter((x) => x.startsWith('章:')).length, 5);
    assert.equal(chaptersGroup(ui).querySelector('.row-plot').style.paddingLeft, '16px');
  });
});

describe('空书只建了一卷', { skip: JSDOM_SKIP }, () => {
  test('画出那一卷与空卷提示，下面照旧写下一步', () => {
    const ui = mount();
    ui.post({
      type: 'project',
      tree: {
        ...sampleTree(),
        plots: [], plotCount: 0, chapterCount: 0, totalWords: 0, nextChapterNo: 1,
        volumes: [{ name: '第一卷', relPath: 'chapters/第一卷', words: 0, latest: true }],
      },
    });
    const rows = layout(ui);
    assert.equal(rows[0], '卷:第一卷');
    assert.equal(rows[1], '（空卷：接下来新建的章落在这里）');
    assert.ok(rows[2]?.startsWith('还没有章节'), JSON.stringify(rows));
  });
});
