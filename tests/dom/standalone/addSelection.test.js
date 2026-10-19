/**
 * 对话页「加入选区」在独立版：宿主取不到网页里的选区，从前点它一律弹粘贴框——那颗按钮比内置编辑器早一天写出来，
 * 之后一直没接上。现在前端先问内置编辑器（`nf-selection-query`，回答在 `media/src/editor/index.ts`）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 编辑器里选着字 | `addSelection` 带上 `selection`：路径、去掉首尾空白的文字、1-based 闭区间行号 |
 * | 多选了首尾的换行 | 行号按去掉空白之后的那一段算，不多出一行 |
 * | 没选中 | 照旧发不带选区的 `addSelection`（后端交给宿主弹粘贴框） |
 * | Markdown 预览里 | 藏着的 textarea 的选区作者看不见，不算 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

describe('「加入选区」带上内置编辑器的选区', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const selBtn = () => ui.doc.getElementById('selBtn');
  const tab = (name) =>
    [...ui.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const clickSel = () => {
    ui.clickEl(selBtn());
    return ui.last('addSelection');
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'] });
    ui.post({ type: 'state', state: viewState() });
    ui.post({ type: 'busy', value: false });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '第一行\n雨下了一夜。\n林昭推门进来。\n第四行', { kind: 'chapter' }) });
  });

  test('按钮可点', () => {
    assert.equal(selBtn().disabled, false);
  });

  test('选着字：带上路径、文字与行号', () => {
    const value = area().value;
    const from = value.indexOf('雨下');
    const to = value.indexOf('进来。') + '进来。'.length;
    area().setSelectionRange(from, to);
    const msg = clickSel();
    // 消息对象出自 jsdom 那个 realm，原型对不上 deepStrictEqual，过一道 JSON。
    assert.deepEqual(JSON.parse(JSON.stringify(msg.selection)), {
      relPath: 'chapters/001-雨夜.md',
      text: '雨下了一夜。\n林昭推门进来。',
      start: 2,
      end: 3,
    }, JSON.stringify(msg));
  });

  test('多选了首尾的换行：文字去掉空白，行号不多出一行', () => {
    const value = area().value;
    const from = value.indexOf('雨下') - 1; // 带上第一行末尾的换行
    const to = value.indexOf('第四行'); // 带上第三行末尾的换行
    area().setSelectionRange(from, to);
    const msg = clickSel();
    assert.equal(msg.selection?.text, '雨下了一夜。\n林昭推门进来。', JSON.stringify(msg));
    assert.equal(msg.selection?.start, 2, JSON.stringify(msg));
    assert.equal(msg.selection?.end, 3, JSON.stringify(msg));
  });

  test('没选中：不带选区，交给宿主', () => {
    area().setSelectionRange(2, 2);
    const msg = clickSel();
    assert.ok(msg, '没发出 addSelection');
    assert.equal(msg.selection, undefined, JSON.stringify(msg));
  });

  test('Markdown 预览里：不算选区', () => {
    ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭\n\n主角。', { kind: 'character' }) });
    ui.clickEl(tab('林昭.md'));
    area().setSelectionRange(0, area().value.length);
    ui.clickEl(ui.doc.getElementById('edPreviewBtn'));
    const msg = clickSel();
    assert.equal(msg.selection, undefined, JSON.stringify(msg));
  });
});
