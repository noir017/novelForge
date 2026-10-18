/**
 * 内置编辑器的查找替换条与高亮镜像层（`media/src/editor/find.ts` / `highlight.ts`）。
 *
 * jsdom 没有排版：镜像层只测 DOM 内容（`<mark>` 与匹配一一对得上、class 分得出当前那一处），不测像素。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | DOM 只有一份 | 页面模板里没有查找条；打开时现造、插在 `.ed-stage` 前面；草稿区有自己的那一条 |
 * | 从光标往后找 | 打字时从光标往后最近一处选中，计数「k/N」，焦点留在查找框 |
 * | 上一个 / 下一个 | Enter / Shift+Enter / F3 / Shift+F3、按钮，到头绕回；组字中途的 Enter 不算 |
 * | 预填 | Ctrl+F 时一行之内的短选区填进查找框 |
 * | Aa / .* | 区分大小写、正则；正则写错了说一句、不抛 |
 * | 镜像层 | `<mark>` 与匹配一致、当前那一处另一种 class；文字一变下一帧重算；换文件清掉旧的；超大文件不画并说一句 |
 * | Esc | 关掉、清高亮、焦点回编辑区 |
 * | 替换 | Ctrl+H 展开替换行；选区正好是当前那一处才换、换完跳下一处；替换框 Enter；一处一步撤销；`$1` |
 * | 全部替换 | 一次改完、提示替换了 N 处、Ctrl+Z 一步退回 |
 * | 快捷键的边界 | 焦点在对话输入框时 Ctrl+F 不拦；预览模式下先切回编辑；「编辑」菜单「查找」后面紧跟「替换」 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, standaloneBodyHtml } = require('../../helpers/dom');

/** 等两帧：文字变了之后查找条下一帧重算，镜像层随之重画（jsdom 没有 rAF，退回 16ms 定时器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

function harness(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['pointerCapture', 'confirm'] });
  const main = () => ui.doc.getElementById('wbEditor');
  const draft = () => ui.doc.querySelector('.wb-editor-draft');
  const area = (root = main()) => root.querySelector('textarea.ed-area');
  const bar = (root = main()) => root.querySelector('.ed-find');
  const part = (cls, root = main()) => root.querySelector(`.ed-find .${cls}`);
  const press = (target, init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const ctrl = (key, target = area()) => press(target, { key, ctrlKey: true });
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const open = (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, extra) });
  const marks = (root = main()) => [...root.querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')];
  const selected = (a = area()) => a.value.slice(a.selectionStart, a.selectionEnd);
  const count = (root = main()) => part('ed-find-count', root).textContent;
  const isOpen = (root = main()) => !!bar(root) && !bar(root).classList.contains('hidden');
  return { ui, main, draft, area, bar, part, press, ctrl, type, open, marks, selected, count, isOpen };
}

describe('查找条：打开、从光标往后找、上一个 / 下一个', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('chapters/001.md', '甲乙甲丙甲');
  });

  test('页面模板里没有查找条（两块编辑区都由脚本现造，DOM 只有一份）', () => {
    assert.equal(standaloneBodyHtml().includes('ed-find'), false);
    assert.equal(h.bar(), null);
  });

  test('Ctrl+F 打开这一块的查找条，插在正文区前面，焦点落在查找框', () => {
    const ev = h.ctrl('f');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.bar().nextElementSibling.classList.contains('ed-stage'), true);
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
    assert.equal(h.ui.doc.querySelectorAll('#wbEditor .ed-find').length, 1);
  });

  test('打字时从光标往后找最近的一处并选中，计数写第几处', () => {
    h.area().setSelectionRange(1, 1);
    h.type(h.part('ed-find-input'), '甲');
    assert.deepEqual([h.area().selectionStart, h.area().selectionEnd], [2, 3]);
    assert.equal(h.count(), '2/3');
  });

  test('选中时焦点仍留在查找框里（接着打字不会打进正文）', () => {
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
  });

  test('Enter 下一处，到最后一处之后绕回第一处', () => {
    const input = h.part('ed-find-input');
    h.press(input, { key: 'Enter' });
    assert.deepEqual([h.area().selectionStart, h.count()], [4, '3/3']);
    h.press(input, { key: 'Enter' });
    assert.deepEqual([h.area().selectionStart, h.count()], [0, '1/3']);
  });

  test('Shift+Enter 上一处，到第一处之前绕回最后一处', () => {
    h.press(h.part('ed-find-input'), { key: 'Enter', shiftKey: true });
    assert.deepEqual([h.area().selectionStart, h.count()], [4, '3/3']);
  });

  test('「上一个」「下一个」按钮', () => {
    h.ui.clickEl(h.part('ed-find-prev'));
    assert.equal(h.count(), '2/3');
    h.ui.clickEl(h.part('ed-find-next'));
    assert.equal(h.count(), '3/3');
  });

  test('输入法组字中途的 Enter 不跳', () => {
    const before = h.area().selectionStart;
    h.press(h.part('ed-find-input'), { key: 'Enter', isComposing: true });
    assert.equal(h.area().selectionStart, before);
  });

  test('编辑区里 F3 下一处、Shift+F3 上一处', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    const ev = h.press(h.area(), { key: 'F3' });
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual([h.area().selectionStart, h.count()], [0, '1/3']);
    h.press(h.area(), { key: 'F3' });
    assert.equal(h.count(), '2/3');
    h.press(h.area(), { key: 'F3', shiftKey: true });
    assert.equal(h.count(), '1/3');
  });

  test('找不到时写「无结果」，选区不动', () => {
    h.area().setSelectionRange(1, 1);
    h.type(h.part('ed-find-input'), '丁');
    assert.equal(h.count(), '无结果');
    assert.deepEqual([h.area().selectionStart, h.area().selectionEnd], [1, 1]);
  });

  test('Ctrl+F 时一行之内的短选区预填进查找框，它就是当前那一处', () => {
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    h.area().setSelectionRange(1, 3);
    h.ctrl('f');
    assert.equal(h.part('ed-find-input').value, '乙甲');
    assert.equal(h.count(), '1/1');
  });

  test('跨行的选区不预填，查找框留着上一次的字', () => {
    h.open('chapters/002.md', '甲\n乙');
    h.area().setSelectionRange(0, 3);
    h.ctrl('f');
    assert.equal(h.part('ed-find-input').value, '乙甲');
  });
});

describe('查找条：区分大小写、正则', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('notes/a.md', 'Abc abc 第3章 第12章');
    h.ctrl('f');
  });

  test('缺省不区分大小写；按下「Aa」之后区分', () => {
    h.area().setSelectionRange(0, 0);
    h.type(h.part('ed-find-input'), 'abc');
    assert.equal(h.count(), '1/2');
    h.ui.clickEl(h.part('ed-find-case'));
    assert.equal(h.part('ed-find-case').getAttribute('aria-pressed'), 'true');
    assert.equal(h.count(), '1/1');
    assert.equal(h.selected(), 'abc');
    h.ui.clickEl(h.part('ed-find-case'));
  });

  test('按下「.*」之后按正则找', () => {
    h.ui.clickEl(h.part('ed-find-regex'));
    h.area().setSelectionRange(0, 0);
    h.type(h.part('ed-find-input'), '第\\d+章');
    assert.equal(h.count(), '1/2');
    assert.equal(h.selected(), '第3章');
  });

  test('正则写错了：不抛，查找条上说一句，没有高亮', () => {
    h.type(h.part('ed-find-input'), '第(\\d+章');
    assert.equal(h.part('ed-find-note').textContent, '正则写错了');
    assert.equal(h.part('ed-find-note').classList.contains('hidden'), false);
    assert.equal(h.count(), '');
    assert.equal(h.marks().length, 0);
  });

  test('改对了，提示收起', () => {
    h.type(h.part('ed-find-input'), '第(\\d+)章');
    assert.equal(h.part('ed-find-note').classList.contains('hidden'), true);
    assert.equal(h.count(), '1/2');
  });
});

describe('高亮镜像层', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '林昭推开门。林昭没有说话。\n沈氏看着林昭。';

  before(() => {
    h = harness();
    h.open('chapters/001-入镇.md', TEXT, { kind: 'chapter' });
    h.area().setSelectionRange(0, 0);
    h.ctrl('f');
    h.type(h.part('ed-find-input'), '林昭');
  });

  test('镜像层与 textarea 在同一格里、排在它前面（背后），读屏不读它', () => {
    const mirror = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe)');
    assert.equal(mirror.parentElement, h.area().parentElement);
    assert.ok(mirror.compareDocumentPosition(h.area()) & h.ui.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(mirror.getAttribute('aria-hidden'), 'true');
    assert.equal(mirror.classList.contains('hidden'), false);
  });

  test('镜像里的文字与 textarea 一字不差，<mark> 与每一处匹配一一对应', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, TEXT);
    assert.deepEqual(h.marks().map((m) => m.textContent), ['林昭', '林昭', '林昭']);
  });

  test('当前那一处另一种 class，其余是普通匹配', () => {
    assert.deepEqual(
      h.marks().map((m) => m.classList.contains('ed-hl-find-current')),
      [true, false, false]
    );
    assert.ok(h.marks().every((m) => m.classList.contains('ed-hl')));
    h.press(h.part('ed-find-input'), { key: 'Enter' });
    assert.deepEqual(
      h.marks().map((m) => m.classList.contains('ed-hl-find-current')),
      [false, true, false]
    );
  });

  test('镜像层随 textarea 的计算样式排版（字号、断行规则都抄过去）', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    const cs = h.ui.window.getComputedStyle(h.area());
    assert.equal(content.style.getPropertyValue('font-size'), cs.getPropertyValue('font-size'));
    assert.equal(content.style.getPropertyValue('white-space'), cs.getPropertyValue('white-space'));
  });

  test('正文里改了字：下一帧重算，计数与高亮跟上', async () => {
    const a = h.area();
    a.focus();
    a.value = `${TEXT}林昭`;
    a.setSelectionRange(a.value.length, a.value.length);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    await frames();
    assert.equal(h.marks().length, 4);
    assert.equal(h.count(), '2/4', '当前序号留在原处');
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, `${TEXT}林昭`);
  });

  test('换了文件：旧文件的高亮当场清掉，按新文件重算', async () => {
    h.open('chapters/002-别处.md', '这里没有那个名字。', { kind: 'chapter' });
    assert.equal(h.marks().length, 0);
    await frames();
    assert.equal(h.marks().length, 0);
    assert.equal(h.count(), '无结果');
    h.open('chapters/003-再见.md', '林昭，林昭。', { kind: 'chapter' });
    await frames();
    assert.deepEqual(h.marks().map((m) => m.textContent), ['林昭', '林昭']);
    assert.equal(h.count(), '共 2 处');
  });

  test('Esc 关掉：高亮清掉，焦点回编辑区，选区停在当前那一处', () => {
    h.press(h.part('ed-find-input'), { key: 'Enter' });
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    assert.equal(h.isOpen(), false);
    assert.equal(h.marks().length, 0);
    assert.equal(h.ui.doc.activeElement, h.area());
    assert.equal(h.selected(), '林昭');
  });

  test('编辑区里按 Esc 也收起查找条', () => {
    h.ctrl('f');
    assert.equal(h.isOpen(), true);
    const ev = h.press(h.area(), { key: 'Escape' });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), false);
  });

  test('超过 30 万字的文件不画高亮，查找条上说一句（查找照常）', () => {
    h.open('chapters/004-长.md', `${'甲'.repeat(300000)}乙`, { kind: 'chapter' });
    h.area().setSelectionRange(0, 0);
    h.ctrl('f');
    h.type(h.part('ed-find-input'), '乙');
    assert.equal(h.count(), '1/1');
    assert.equal(h.area().selectionStart, 300000);
    assert.equal(h.marks().length, 0);
    assert.match(h.part('ed-find-note').textContent, /超过 30 万字，不画高亮/);
  });
});

describe('替换', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '林昭推门。林昭坐下。林昭笑了。';

  before(() => {
    h = harness(['view.js', 'editor.js']);
    h.open('chapters/001.md', TEXT, { kind: 'chapter' });
  });

  test('Ctrl+H 打开查找条并展开替换行', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    const ev = h.ctrl('h');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
    assert.equal(h.part('ed-find-toggle').getAttribute('aria-expanded'), 'true');
  });

  test('小三角收起 / 展开替换行', () => {
    h.ui.clickEl(h.part('ed-find-toggle'));
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), true);
    h.ui.clickEl(h.part('ed-find-toggle'));
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
  });

  test('选区不是当前那一处时，「替换」这一下只选中下一处', () => {
    h.part('ed-replace-input').value = '沈氏';
    h.type(h.part('ed-find-input'), '林昭');
    h.area().setSelectionRange(1, 1);
    h.ui.clickEl(h.part('ed-replace-one'));
    assert.equal(h.area().value, TEXT);
    assert.deepEqual([h.area().selectionStart, h.selected()], [5, '林昭']);
  });

  test('选区正好是当前那一处：换掉它，跳到下一处', () => {
    h.ui.clickEl(h.part('ed-replace-one'));
    assert.equal(h.area().value, '林昭推门。沈氏坐下。林昭笑了。');
    assert.deepEqual([h.area().selectionStart, h.selected()], [10, '林昭']);
    assert.equal(h.count(), '2/2');
  });

  test('替换框里 Enter：替换当前这一处并绕回下一处', () => {
    h.press(h.part('ed-replace-input'), { key: 'Enter' });
    assert.equal(h.area().value, '林昭推门。沈氏坐下。沈氏笑了。');
    assert.deepEqual([h.area().selectionStart, h.selected()], [0, '林昭']);
  });

  test('一处一步撤销', () => {
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, '林昭推门。沈氏坐下。林昭笑了。');
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT);
  });

  test('全部替换：一次改完，提示替换了 N 处', () => {
    h.type(h.part('ed-find-input'), '林昭');
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '沈氏推门。沈氏坐下。沈氏笑了。');
    assert.match(h.ui.doc.getElementById('toast').textContent, /替换了 3 处/);
    assert.equal(h.count(), '无结果');
  });

  test('全部替换只记一步：Ctrl+Z 一下全部退回', () => {
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT);
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT, '再往前没有了');
  });

  test('正则替换支持 $1（逐处算）', () => {
    h.open('chapters/002.md', '林昭说：好。沈氏说：走。', { kind: 'chapter' });
    h.ctrl('h');
    if (h.part('ed-find-regex').getAttribute('aria-pressed') !== 'true') {
      h.ui.clickEl(h.part('ed-find-regex'));
    }
    h.type(h.part('ed-find-input'), '(\\S{2})说：');
    h.part('ed-replace-input').value = '$1道：';
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '林昭道：好。沈氏道：走。');
  });

  test('一处都没有时全部替换不动文字，说一句', () => {
    h.type(h.part('ed-find-input'), '不存在');
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '林昭道：好。沈氏道：走。');
    assert.match(h.ui.doc.getElementById('toast').textContent, /没有可替换的/);
  });
});

describe('查找快捷键的边界', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['view.js', 'editor.js']);
    h.ui.post({
      type: 'workspaces',
      currentId: '/tmp/book',
      items: [{ id: '/tmp/book', root: '/tmp/book', name: 'book' }],
      recents: [],
    });
    h.open('chapters/001.md', '# 第一章\n\n雨夜。');
  });

  test('焦点在左侧对话输入框时 Ctrl+F 不拦，留给浏览器', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    const ev = h.ctrl('f', input);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.isOpen(), false);
  });

  test('Ctrl+H 同样不拦', () => {
    const ev = h.ctrl('h', h.ui.doc.getElementById('input'));
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.isOpen(), false);
  });

  test('焦点不在任何输入框里时 Ctrl+F 打开当前那块编辑区的查找条', () => {
    h.ui.doc.getElementById('input').blur();
    const ev = h.ctrl('f', h.ui.doc.body);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('预览模式下按 Ctrl+F：先切回编辑再打开', () => {
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.ctrl('f', h.ui.doc.body);
    assert.equal(h.area().classList.contains('hidden'), false);
    assert.equal(h.ui.doc.getElementById('edPreview').classList.contains('hidden'), true);
    assert.equal(h.isOpen(), true);
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('查找条开着时切到预览，再在查找框里打字：切回编辑，焦点留在查找框', () => {
    h.ctrl('f', h.ui.doc.body);
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.part('ed-find-input').focus();
    h.type(h.part('ed-find-input'), '雨');
    assert.equal(h.area().classList.contains('hidden'), false);
    assert.equal(h.selected(), '雨');
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('「编辑」菜单：「查找」后面紧跟着「替换」，点了打开并展开替换行', () => {
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const items = [...h.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
    const labels = items.map((b) => b.querySelector('.wb-menu-label').textContent);
    const at = labels.indexOf('查找');
    assert.equal(labels[at + 1], '替换');
    assert.equal(items[at + 1].querySelector('.wb-menu-kbd').textContent, 'Ctrl+H');
    h.ui.clickEl(items[at + 1]);
    assert.equal(h.isOpen(), true);
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
  });

  test('草稿区有自己的查找条，与主区互不相干', () => {
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001.md', '草稿甲，草稿乙。') });
    const root = h.draft();
    h.ctrl('f', h.area(root));
    assert.equal(h.isOpen(root), true);
    assert.equal(h.isOpen(h.main()), false);
    h.type(h.part('ed-find-input', root), '草稿');
    assert.equal(h.count(root), '1/2');
    assert.equal(h.marks(root).length, 2);
    assert.equal(h.marks(h.main()).length, 0);
  });
});

describe('查找跳转的滚动', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const input = () => ui.doc.querySelector('#wbEditor .ed-find-input');
  const enter = () =>
    input().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  // 「甲」在第 2 行和第 35 行（下标 1 与 34）。
  const TEXT = Array.from({ length: 40 }, (_, i) => (i === 1 || i === 34 ? `甲${i}` : `行${i}`)).join('\n');
  const topOf = (lineIndex) => MIRROR_LAYOUT.pad + lineIndex * MIRROR_LAYOUT.line;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm', 'mirrorLayout'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001.md', TEXT) });
    area().setSelectionRange(0, 0);
    area().scrollTop = 0;
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    input().value = '甲';
    input().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  });

  test('目标已经在视口里：不滚', () => {
    assert.equal(area().selectionStart, TEXT.indexOf('甲'));
    assert.equal(area().scrollTop, 0);
  });

  test('目标在视口外：滚到让它停在视口偏上三分之一处', () => {
    enter();
    assert.equal(area().selectionStart, TEXT.lastIndexOf('甲'));
    assert.equal(area().scrollTop, topOf(34) - MIRROR_LAYOUT.viewport / 3);
  });

  test('绕回第一处也照样滚回去', () => {
    enter();
    assert.equal(area().scrollTop, 0);
  });
});

describe('查找条：再按 Ctrl+F、Esc 的落点', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('notes/a.md', '第3章 第12章');
    h.ctrl('f');
    h.ui.clickEl(h.part('ed-find-regex'));
    h.type(h.part('ed-find-input'), '第(\\d+)章');
  });

  test('焦点已在查找框里再按 Ctrl+F：不拿选区盖掉写好的正则', () => {
    assert.equal(h.selected(), '第3章');
    h.part('ed-find-input').focus();
    h.ctrl('f', h.part('ed-find-input'));
    assert.equal(h.part('ed-find-input').value, '第(\\d+)章');
  });

  test('焦点在查找条的按钮上按 Esc 也是关掉', () => {
    const next = h.part('ed-find-next');
    next.focus();
    h.press(next, { key: 'Escape' });
    assert.equal(h.isOpen(), false);
  });
});
