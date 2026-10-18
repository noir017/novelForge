/**
 * 内置编辑器的回车（`media/src/editor/enter.ts`）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 三种分段格式 | 正文回车插的段分隔跟着工程的 `paragraphStyle` 走（`state` 与工程树都认） |
 * | 有选区 / 光标后有空白 | 先替换选区；新段开头不留空格 |
 * | 只有空白的行 | 只换行、不加缩进，并清掉那一行的空白 |
 * | 段首回车 | 整段往下推一行、格式原样 |
 * | 标题行后面回车 | 与段落一样插段分隔（⚑） |
 * | Shift+Enter | 只插 `\n` |
 * | 撤销 | 每次回车一步 |
 * | 输入法组字 | 组字中的回车放行 |
 * | Markdown 列表 | 接着写（`-` / `*` 照抄、`1.` 递增），空的列表项上回车结束列表；其余沿用缩进 |
 * | json / yml | 只沿用缩进 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState, sampleTree } = require('../../helpers/dom');

const W = '　　';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  const area = () => ui.doc.getElementById('edArea');
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  return {
    ui,
    area,
    open(path, text, kind) {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
    },
    style(paragraphStyle) {
      ui.post({ type: 'state', state: viewState({ paragraphStyle }) });
    },
    select(start, end = start) {
      area().setSelectionRange(start, end);
    },
    press,
    enter: (extra) => press({ key: 'Enter', ...extra }),
    undo: () => press({ key: 'z', ctrlKey: true }),
    caret: () => area().selectionStart,
  };
}

describe('回车：正文按分段格式另起一段', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('没收到格式之前按空行分段：插 \\n\\n', () => {
    h.open('chapters/001-雨夜.md', '他推开门。', 'chapter');
    h.select(5);
    const ev = h.enter();
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '他推开门。\n\n');
    assert.equal(h.caret(), 7);
  });

  test('一次回车一步撤销', () => {
    h.undo();
    assert.equal(h.area().value, '他推开门。');
  });

  test('段首缩进：插 \\n + 两个全角空格', () => {
    h.style('indent');
    h.open('chapters/002-入镇.md', `${W}他推开门。`, 'chapter');
    h.select(7);
    h.enter();
    assert.equal(h.area().value, `${W}他推开门。\n${W}`);
    assert.equal(h.caret(), h.area().value.length);
  });

  test('缩进加空行：插 \\n\\n + 两个全角空格（工程树带来的格式也认）', () => {
    h.ui.post({ type: 'project', tree: { ...sampleTree(), paragraphStyle: 'both' } });
    h.open('chapters/003-夜访.md', '他推开门。', 'chapter');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, `他推开门。\n\n${W}`);
  });

  test('草稿也是正文', () => {
    h.style('indent');
    h.open('drafts/001-雨夜.md', '草稿一句。', 'draft');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, `草稿一句。\n${W}`);
  });

  test('段落中间回车：断成两段，光标后面紧跟的空白删掉', () => {
    h.open('chapters/004-北行.md', `${W}他推开门。 　她笑了。`, 'chapter');
    h.select(7);
    h.enter();
    assert.equal(h.area().value, `${W}他推开门。\n${W}她笑了。`);
    assert.equal(h.caret(), 10, '光标停在新段的字前面');
  });

  test('有选区：先替换选区再另起一段', () => {
    h.open('chapters/005-赤星.md', '他推开门，看见她笑了。', 'chapter');
    h.select(4, 7);
    h.enter();
    assert.equal(h.area().value, `他推开门\n${W}她笑了。`);
  });

  test('只有缩进的行：只换行、不加缩进，并清掉这一行的空白', () => {
    h.open('chapters/006-空行.md', `${W}他推开门。\n${W}`, 'chapter');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, `${W}他推开门。\n\n`);
    h.enter();
    assert.equal(h.area().value, `${W}他推开门。\n\n\n`, '连按回车不堆出一串缩进行');
  });

  test('段首回车：整段往下推一行，格式原样，光标仍停在字前面', () => {
    h.open('chapters/007-段首.md', `${W}他推开门。`, 'chapter');
    h.select(0);
    h.enter();
    assert.equal(h.area().value, `\n${W}他推开门。`);
    assert.equal(h.caret(), 3);
  });

  test('标题行后面回车：与段落一样插段分隔，下一行是正文的一段（⚑）', () => {
    h.open('chapters/008-标题.md', '# 第八章 雨夜', 'chapter');
    h.select(8);
    h.enter();
    assert.equal(h.area().value, `# 第八章 雨夜\n${W}`);
  });

  test('Shift+Enter 只插 \\n', () => {
    h.open('chapters/009-诗.md', '床前明月光', 'chapter');
    h.select(5);
    const ev = h.enter({ shiftKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '床前明月光\n');
  });

  test('输入法组字中的回车放行给输入法', () => {
    h.open('chapters/010-组字.md', '他', 'chapter');
    h.select(1);
    const ev = h.enter({ isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.area().value, '他');
  });
});

describe('回车：非正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.style('indent');
  });

  test('Markdown 列表接着写：- 照抄', () => {
    h.open('.novelforge/characters/林昭.md', '- 身份：渔家子', 'character');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '- 身份：渔家子\n- ');
    assert.equal(h.caret(), h.area().value.length);
  });

  test('有序列表递增，缩进照抄', () => {
    h.open('.novelforge/outline.md', '  1. 入宗', 'outline');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '  1. 入宗\n  2. ');
  });

  test('* 列表也接着写', () => {
    h.open('.novelforge/lore/宗门.md', '* 外门', 'lore');
    h.select(4);
    h.enter();
    assert.equal(h.area().value, '* 外门\n* ');
  });

  test('空的列表项上回车：去掉标记、结束列表', () => {
    h.open('.novelforge/characters/苏晚.md', '- 身份\n- ', 'character');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '- 身份\n');
    assert.equal(h.caret(), h.area().value.length);
  });

  test('Markdown 里不是列表的行：沿用行首空白，不按正文缩进', () => {
    h.open('.novelforge/world.md', '  缩进的说明', 'setting');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '  缩进的说明\n  ');
  });

  test('分隔线不是列表', () => {
    h.open('.novelforge/premise.md', '* * *', 'setting');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, '* * *\n');
  });

  test('yml：只沿用缩进', () => {
    h.open('config.yml', 'a:\n  b: 1');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, 'a:\n  b: 1\n  ');
  });

  test('json 里的列表样子不接着写', () => {
    h.open('data.json', '  - x');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, '  - x\n  ');
  });

  test('非正文的 Shift+Enter 交给浏览器', () => {
    h.open('notes.md', '随手记');
    h.select(3);
    const ev = h.enter({ shiftKey: true });
    assert.equal(ev.defaultPrevented, false);
  });

  test('非正文的回车也是一步撤销', () => {
    h.open('.novelforge/characters/陈伯.md', '- 身份：渔家子', 'character');
    h.select(h.area().value.length);
    h.enter();
    h.undo();
    assert.equal(h.area().value, '- 身份：渔家子');
  });
});
