/**
 * 章节条（W6 章节工作台，独立版）：编辑区里正开着某一章的正文或细纲时，主区顶上一条——
 * 这一章在哪一步、写了多少，以及对这一章能做的几件事。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 开着角色卡、大纲这类文件 | 不出现（它说的是「这一章」） |
 * | 开着某一章的正文 | 出现，写「第 2 章《入镇》 · 待定稿 · 2980 / 3000 字」 |
 * | 按钮亮灭 | 按这一章的状态：没正文只亮「写这一章」，有正文亮「接着写 / 重写 / 定稿」 |
 * | 点按钮 | 发 `chapterAction`，带这一行的主路径与动作 |
 * | 提示里写调用次数 | 与主按钮同一个数（D16） |
 * | 另一份没开着 | 「并排看细纲 / 正文」把它开到另一块 |
 * | 开着细纲 | 同样认得出是哪一章 |
 *
 * 数据只来自工程树（`project` 消息）与编辑器自己的「正在编辑哪个文件」，不新增推送。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, sampleTree } = require('../../helpers/dom');

describe('章节条', { skip: JSDOM_SKIP }, () => {
  let ui;
  const bar = () => ui.doc.getElementById('edChapterBar');
  const info = () => bar().querySelector('.ed-chapter-info').textContent;
  const btn = (action) => bar().querySelector(`button[data-action="${action}"]`);
  const pair = () => bar().querySelector('.ed-chapter-pair');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('一开始没有开着章节：不出现', () => {
    assert.ok(bar(), '没有章节条的 DOM');
    assert.ok(bar().classList.contains('hidden'));
  });

  test('开着角色卡：不出现', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭') });
    assert.ok(bar().classList.contains('hidden'));
  });

  test('开着第 2 章的正文：写这一章在哪一步、写了多少', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/002-入镇.md', '# 入镇\n\n正文') });
    assert.ok(!bar().classList.contains('hidden'));
    assert.equal(info(), '第 2 章《入镇》 · 待定稿 · 2980 / 3000 字');
  });

  test('有正文：接着写、重写（要有细纲）、定稿按状态亮灭；写这一章不亮', () => {
    assert.equal(btn('write').disabled, true);
    assert.equal(btn('continue').disabled, false);
    // 第 2 章是老工程里的章，没有细纲：重写没有依据。
    assert.equal(btn('rewrite').disabled, true);
    assert.equal(btn('finalize').disabled, false);
  });

  test('提示里写调用次数（与主按钮同一个数）', () => {
    assert.match(btn('continue').title, /预计 1 次调用，最多 8 次/);
    // 四期：定稿 = 摘要 + 出场角色的当前状态（D17）；七期再加一次判叙事线。
    assert.match(btn('finalize').title, /预计 1–3 次调用/);
  });

  test('点「接着写」发 chapterAction', () => {
    ui.clickEl(btn('continue'));
    const sent = ui.last('chapterAction');
    assert.deepEqual({ plotRelPath: sent.plotRelPath, action: sent.action }, { plotRelPath: 'chapters/002-入镇.md', action: 'continue' });
  });

  test('这一章没有细纲：不给「并排看细纲」', () => {
    assert.equal(pair(), null);
  });

  test('开着第 4 章的细纲（还没有正文）：认得出是哪一章，只亮「写这一章」', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/plots/004-北行.md', '# 第4章 北行') });
    assert.equal(info(), '第 4 章《北行》 · 待写正文 · 还没有正文');
    assert.equal(btn('write').disabled, false);
    assert.equal(btn('continue').disabled, true);
    assert.equal(btn('finalize').disabled, true);
    ui.clickEl(btn('write'));
    assert.equal(ui.last('chapterAction').action, 'write');
  });

  test('第 5 章细纲只是骨架：写这一章不亮，提示说先排细纲', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/plots/005-赤星.md', '# 第5章 赤星') });
    assert.equal(btn('write').disabled, true);
    assert.match(btn('write').title, /先把这一章的细纲排好/);
  });

  test('开着第 3 章正文、细纲没开：「并排看细纲」开到第二块', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/003-夜访.md', '# 夜访\n\n正文') });
    assert.equal(pair().textContent, '并排看细纲');
    ui.clickEl(pair());
    const open = ui.last('openEditor');
    assert.deepEqual({ path: open.path, pane: open.pane }, { path: '.novelforge/plots/003-夜访.md', pane: 'draft' });
  });

  test('细纲已经并排开着：不再给这颗按钮', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/plots/003-夜访.md', '# 第3章 夜访'), pane: 'draft' });
    ui.post({ type: 'editorOpen', file: file('chapters/003-夜访.md', '# 夜访\n\n正文') });
    assert.equal(pair(), null);
  });

  test('工程树更新（写完了一章）：条上的字数跟着变', () => {
    const tree = sampleTree();
    tree.plots[2].wordCount = 3100;
    tree.plots[2].targetWords = 3000;
    ui.post({ type: 'project', tree });
    assert.equal(info(), '第 3 章《夜访》 · 已完成 · 3100 / 3000 字');
  });
});
