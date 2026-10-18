/**
 * 内置编辑器自己管的撤销 / 重做（每个打开的文件一份）。
 *
 * 一块编辑区的所有标签共用一个 textarea，切标签时整份换 value，浏览器原生的撤销记录随之作废；
 * 所以编辑器自己记差异（`media/src/editor/history.ts`）。jsdom 里没有原生撤销，也没有
 * `execCommand`——这里测的全是编辑器自己的那一份。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 切到别的标签再切回来 | Ctrl+Z 仍退得回去（各管各的历史） |
 * | 连续打字 | 并成一步；回车单独一步，回车之后另起一步 |
 * | Ctrl+Y / Ctrl+Shift+Z | 重做 |
 * | 撤销回原样 | 脏标记、标签圆点、保存按钮跟着变 |
 * | 输入法组字 | 组字中途不记，上屏那一整段一步 |
 * | `beforeinput` 的 historyUndo | 拦下来走编辑器的 |
 * | 「还原」「用磁盘版本覆盖」 | 也记一步，撤销回去又是脏的 |
 * | 右键「粘贴」 | 经唯一的程序改写入口，一步可撤销 |
 * | 搬到另一块编辑区 | 撤销历史跟着搬 |
 * | 标题栏「编辑 → 撤销」 | 焦点在编辑区时走编辑器，在别的输入框时照旧交给浏览器 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

/** 在 jsdom 里模拟真实输入：改 value、挪光标、发一条带 inputType 的 input。 */
function typer(ui, area) {
  const fire = (inputType, extra) =>
    area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  return {
    /** 在光标 / 选区处打出 text（一下一个事件）。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire(ch === '\n' ? 'insertLineBreak' : 'insertText', { data: ch });
      }
    },
    backspace(times = 1) {
      for (let i = 0; i < times; i++) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s - 1) + a.value.slice(s);
        a.setSelectionRange(s - 1, s - 1);
        fire('deleteContentBackward');
      }
    },
    caret(at) {
      area().setSelectionRange(at, at);
    },
  };
}

function keys(ui, area) {
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  return {
    press,
    undo: () => press({ key: 'z', ctrlKey: true }),
    redoY: () => press({ key: 'y', ctrlKey: true }),
    redoShiftZ: () => press({ key: 'Z', ctrlKey: true, shiftKey: true }),
  };
}

describe('撤销 / 重做：每个文件一份', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const tab = (name) =>
    [...ui.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  let t;
  let k;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
    ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    t = typer(ui, area);
    k = keys(ui, area);
  });

  test('切到别的标签再切回来，Ctrl+Z 仍能撤销之前的修改', () => {
    ui.clickEl(tab('001-雨夜.md'));
    t.caret(3);
    t.type('林昭来了');
    assert.equal(area().value, '雨夜。林昭来了');

    ui.clickEl(tab('林昭.md'));
    assert.equal(area().value, '# 林昭');
    t.caret(4);
    t.type('，主角');
    ui.clickEl(tab('001-雨夜.md'));
    assert.equal(area().value, '雨夜。林昭来了');

    const ev = k.undo();
    assert.equal(ev.defaultPrevented, true, 'Ctrl+Z 要拦下来，不交给浏览器');
    assert.equal(area().value, '雨夜。');
    assert.equal(area().selectionStart, 3, '光标回到打字之前的位置');

    // 另一份的历史没被碰。
    ui.clickEl(tab('林昭.md'));
    k.undo();
    assert.equal(area().value, '# 林昭');
  });

  test('撤销回原样：脏标记、标签圆点、保存按钮跟着变', () => {
    ui.clickEl(tab('001-雨夜.md'));
    assert.equal(area().value, '雨夜。');
    assert.equal(tab('001-雨夜.md').classList.contains('dirty'), false);
    assert.equal(ui.doc.getElementById('edSaveBtn').disabled, true);
    assert.equal(ui.doc.getElementById('edStatusSave').textContent, '已保存');
  });

  test('Ctrl+Y 重做', () => {
    k.redoY();
    assert.equal(area().value, '雨夜。林昭来了');
    assert.equal(area().selectionStart, 7, '光标落在重做之后的位置');
    assert.equal(tab('001-雨夜.md').classList.contains('dirty'), true);
    assert.match(ui.doc.getElementById('edStatusSave').textContent, /未保存/);
  });

  test('Ctrl+Shift+Z 也是重做', () => {
    k.undo();
    assert.equal(area().value, '雨夜。');
    k.redoShiftZ();
    assert.equal(area().value, '雨夜。林昭来了');
  });

  test('连续打字并成一步，回车单独一步、回车之后另起一步', () => {
    t.caret(area().value.length);
    t.type('。\n第二段');
    assert.equal(area().value, '雨夜。林昭来了。\n第二段');
    k.undo();
    assert.equal(area().value, '雨夜。林昭来了。\n', '先退回车之后打的字');
    k.undo();
    assert.equal(area().value, '雨夜。林昭来了。', '再退回车');
    k.undo();
    assert.equal(area().value, '雨夜。林昭来了', '回车之前那几下是一步');
  });

  test('连续退格并成一步', () => {
    t.caret(area().value.length);
    t.backspace(2);
    assert.equal(area().value, '雨夜。林昭');
    k.undo();
    assert.equal(area().value, '雨夜。林昭来了');
  });

  test('beforeinput 的 historyUndo / historyRedo 也走编辑器的记录', () => {
    t.type('！');
    const ev = new ui.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' });
    area().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '雨夜。林昭来了');
    area().dispatchEvent(
      new ui.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyRedo' })
    );
    assert.equal(area().value, '雨夜。林昭来了！');
  });

  test('关掉标签，历史随之丢弃：再打开从头记', async () => {
    ui.clickEl(tab('林昭.md'));
    t.caret(4);
    t.type('甲');
    ui.clickEl(tab('林昭.md').querySelector('.ed-tab-close'));
    await ui.answer('不保存');
    ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    assert.equal(area().value, '# 林昭');
    k.undo();
    assert.equal(area().value, '# 林昭', '新打开的文件没有可撤销的');
  });
});

describe('撤销 / 重做：输入法组字', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
  });

  test('组字中途不记，上屏的那一整段算一步', () => {
    const a = area();
    a.setSelectionRange(3, 3);
    a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    for (const step of ['l', 'li', 'lin', '林', '林昭']) {
      a.value = `雨夜。${step}`;
      a.setSelectionRange(3 + step.length, 3 + step.length);
      a.dispatchEvent(
        new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true })
      );
    }
    a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林昭' }));
    assert.equal(a.value, '雨夜。林昭');
    // 组字中途字数照样跟着刷新（只是不记撤销）。
    assert.match(ui.doc.getElementById('edStatusWords').textContent, /5 字符/);

    a.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(a.value, '雨夜。', '一下就退掉整段，不会退出半截拼音');
  });

  test('组字中途按 Ctrl+Z 放行给输入法，不动编辑器的历史', () => {
    const a = area();
    a.value = '雨夜。林昭';
    a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const ev = new ui.window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true,
    });
    a.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(a.value, '雨夜。林昭');
  });
});

describe('撤销 / 重做：整份换内容也记一步', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = () => ui.doc.querySelector('#edTabs .ed-tab');
  const undo = () =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  let t;

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '原文', { kind: 'chapter' }) });
    t = typer(ui, area);
  });

  test('「还原」之后可以撤销回刚才没保存的那份，那时它又是脏的', async () => {
    area().setSelectionRange(2, 2);
    t.type('，改了一半');
    ui.clickEl(ui.doc.getElementById('edRevertBtn'));
    await ui.answer('放弃修改');
    assert.ok(ui.last('reloadFile'), '没发出 reloadFile');
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '原文', { kind: 'chapter' }) });
    assert.equal(area().value, '原文');
    assert.equal(tabEl().classList.contains('dirty'), false);

    undo();
    assert.equal(area().value, '原文，改了一半');
    assert.equal(tabEl().classList.contains('dirty'), true);
  });

  test('「用磁盘版本覆盖编辑器」之后也可以撤销', () => {
    // 保存撞上冲突：磁盘上是别人写的新版。
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(ui.last('saveFile')?.text, '原文，改了一半');
    ui.post({ type: 'editorConflict', path: 'chapters/001-雨夜.md', diskText: '磁盘新版', diskHash: 'h-disk' });
    ui.clickEl(ui.doc.getElementById('edConflictTake'));
    assert.equal(area().value, '磁盘新版');
    undo();
    assert.equal(area().value, '原文，改了一半');
  });

  test('右键「粘贴」经程序改写入口，一步可撤销', async () => {
    ui.window.navigator.clipboard.readText = () => Promise.resolve('贴进来\r\n两行');
    area().setSelectionRange(2, 2);
    const menu = ui.rightClick(area());
    ui.pick(menu, '粘贴');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(area().value, '原文贴进来\n两行，改了一半', '\\r\\n 归一成 \\n');
    assert.equal(area().selectionStart, 8, '光标落在贴进来的文字末尾');
    undo();
    assert.equal(area().value, '原文，改了一半');
  });
});

describe('撤销 / 重做：搬到另一块编辑区历史跟着走', { skip: JSDOM_SKIP }, () => {
  let ui;
  const areaOf = (i) => ui.panes()[i].querySelector('textarea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('.novelforge/summaries/001-雨夜.md', '# 梗概', { kind: 'plot' }) });
  });

  test('主区打的字，搬到草稿区之后 Ctrl+Z 照样退得回去', () => {
    const t = typer(ui, () => areaOf(0));
    areaOf(0).setSelectionRange(4, 4);
    t.type('：林昭');
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('.novelforge/summaries/001-雨夜.md', '# 梗概', { kind: 'plot' }) });
    const a = areaOf(1);
    assert.equal(a.value, '# 梗概：林昭', '未保存的内容跟着搬');
    a.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(a.value, '# 梗概');
  });
});

describe('标题栏「编辑 → 撤销 / 重做」', { skip: JSDOM_SKIP }, () => {
  let ui;
  let execCalls;
  const area = () => ui.doc.getElementById('edArea');
  const menuItem = (label) => {
    ui.clickEl(ui.doc.querySelector('[data-menu="edit"]'));
    return [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === label
    );
  };

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    execCalls = [];
    // jsdom 没有 execCommand：记下调用，好看出菜单把活交给了谁。
    ui.doc.execCommand = (name) => {
      execCalls.push(name);
      return true;
    };
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
  });

  test('焦点在编辑区：「撤销」「重做」走编辑器自己的历史', () => {
    const t = typer(ui, area);
    area().focus();
    area().setSelectionRange(3, 3);
    t.type('林昭');
    ui.clickEl(menuItem('撤销'));
    assert.equal(area().value, '雨夜。');
    ui.clickEl(menuItem('重做'));
    assert.equal(area().value, '雨夜。林昭');
    assert.deepEqual(execCalls, [], '没交给浏览器原生的 execCommand');
  });

  test('按下菜单按钮不夺走焦点', () => {
    area().focus();
    const btn = ui.doc.querySelector('[data-menu="edit"]');
    const ev = new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    ui.closeMenu();
  });

  test('焦点在别的输入框：照旧交给浏览器', () => {
    const input = ui.doc.getElementById('input');
    input.focus();
    ui.clickEl(menuItem('撤销'));
    assert.deepEqual(execCalls, ['undo']);
    assert.equal(area().value, '雨夜。林昭', '编辑区没被动');
  });
});
