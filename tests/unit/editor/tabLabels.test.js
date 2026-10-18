/**
 * 标签上的名字（`media/src/editor/tabLabels.ts`，纯函数）：短标记 + 名字，仍然同名的加最短的区分目录。
 * 编辑器里的整条链路（两块编辑区放在一起比、关掉一个之后收起）在 tests/dom/standalone/tabs.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { tabNames, distinguish } = loadModule('media/src/editor/tabLabels.ts');

const f = (path, tag, title) => ({
  path,
  name: path.split('/').pop(),
  ...(title !== undefined ? { label: { tag, title, crumbs: [] } } : {}),
});

describe('tabNames', () => {
  test('后端给了称呼：用它的短标记与名字', () => {
    const names = tabNames([f('.novelforge/summaries/003-夜访.md', '细纲', '003-夜访')]);
    assert.deepEqual(names.get('.novelforge/summaries/003-夜访.md'), { tag: '细纲', title: '003-夜访', desc: '' });
  });

  test('没给称呼：名字是文件名、不带短标记', () => {
    assert.deepEqual(tabNames([f('notes.txt')]).get('notes.txt'), { tag: '', title: 'notes.txt', desc: '' });
  });

  test('名字一样、短标记不一样：不算同名', () => {
    const names = tabNames([f('chapters/003-夜访.md', '', '003-夜访'), f('drafts/003-夜访.md', '草稿', '003-夜访')]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['', '']);
  });

  test('同一种、不同目录：各写紧挨着它的那一级目录', () => {
    const names = tabNames([f('chapters/第一卷/003-夜访.md', '', '003-夜访'), f('chapters/第二卷/003-夜访.md', '', '003-夜访')]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['第一卷', '第二卷']);
  });

  test('三份撞名只撞了一部分：只有撞上的那几份加', () => {
    const names = tabNames([
      f('chapters/第一卷/003-夜访.md', '', '003-夜访'),
      f('chapters/第二卷/003-夜访.md', '', '003-夜访'),
      f('chapters/004-北行.md', '', '004-北行'),
    ]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['第一卷', '第二卷', '']);
  });
});

describe('distinguish', () => {
  test('紧挨着的那一级一样：往上加一级', () => {
    assert.equal(distinguish('甲/卷一/003.md', ['乙/卷一/003.md']), '甲/卷一');
  });

  test('一个在工程根、一个在子目录：根下那个写「工程根」', () => {
    assert.equal(distinguish('003.md', ['chapters/003.md']), '工程根');
    assert.equal(distinguish('chapters/003.md', ['003.md']), 'chapters');
  });

  test('目录完全一样（扩展名不同）：退到文件名本身', () => {
    assert.equal(distinguish('chapters/003-夜访.md', ['chapters/003-夜访.txt']), '003-夜访.md');
  });
});
