/**
 * 审稿在编辑器那一侧的两件事（五期，独立版）：章节条上的「审稿」、点引文之后选中那一句。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 有正文的章 | 「审稿」亮，提示里写调用次数；点了发 `chapterAction` |
 * | 没有正文的章 | 「审稿」不亮 |
 * | `editorReveal` | 选区落在那一句上（标点、空白不同也认），切到那份文件 |
 * | 找不到那一句 | 不动选区，提示一句 |
 * | 滚到哪里 | 按高亮镜像层量出来的位置滚，那一句停在视口偏上三分之一（不再按字符位置占全文的比例估） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, sampleTree, sampleChapterIndex } = require('../../helpers/dom');

const BODY = '# 入镇\n\n雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。\n\n沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。\n';

describe('章节条「审稿」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const btn = () => ui.doc.getElementById('edChapterBar').querySelector('button[data-action="review"]');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex() });
  });

  test('有正文的章：亮，提示里写调用次数，点了发 chapterAction', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/002-入镇.md', BODY) });
    assert.equal(btn().disabled, false);
    // 2026-10-25 起审稿多一次转写：审 1 次、转写 1 次，最多 7 次。
    assert.match(btn().title, /只出报告，不改文件。预计 2 次调用，最多 7 次/);
    ui.clickEl(btn());
    const sent = ui.last('chapterAction');
    assert.equal(sent.action, 'review');
  });

  test('没有正文的章：不亮', () => {
    const tree = sampleTree();
    const plot = tree.plots.find((p) => p.plotExists && !p.chapterPath);
    ui.post({ type: 'editorOpen', file: file(plot.plotPath, '# 细纲') });
    assert.equal(btn().disabled, true);
  });
});

describe('点引文：编辑区选中那一句', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/002-入镇.md', BODY) });
    ui.post({ type: 'editorOpen', file: file('.novelforge/characters/林昭.md', '# 林昭') });
  });

  test('切回那一章，选区落在那一句上（标点不同也认）', () => {
    ui.post({ type: 'editorReveal', path: 'chapters/002-入镇.md', quote: '她把那块残令，收进了袖中' });
    const a = area();
    assert.equal(a.value, BODY);
    assert.equal(a.value.slice(a.selectionStart, a.selectionEnd), '她把那块残令收进了袖中');
    const active = ui.doc.querySelector('.ed-tab.active .ed-tab-name');
    assert.equal(active.textContent, '002-入镇.md');
  });

  test('找不到那一句：不动选区，提示一句', () => {
    const a = area();
    const before = [a.selectionStart, a.selectionEnd];
    ui.post({ type: 'editorReveal', path: 'chapters/002-入镇.md', quote: '根本没有这一句话' });
    assert.deepEqual([a.selectionStart, a.selectionEnd], before);
    assert.match(ui.doc.getElementById('toast').textContent, /找不到了/);
  });
});

describe('点引文：按镜像层量出来的位置滚', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  // 第一行很长、后面都很短：按字符位置占全文的比例估，会把第 30 行估到很靠前的地方。
  const LINES = [`${'序'.repeat(4000)}。`, ...Array.from({ length: 39 }, (_, i) => `第${i + 2}行的字。`)];
  const TEXT = LINES.join('\n');

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'mirrorLayout'],
    });
    ui.post({ type: 'editorOpen', file: file('chapters/002-入镇.md', TEXT) });
  });

  test('那一句停在视口偏上三分之一处', () => {
    ui.post({ type: 'editorReveal', path: 'chapters/002-入镇.md', quote: '第30行的字' });
    const { line, pad, viewport } = MIRROR_LAYOUT;
    const top = pad + 29 * line;
    assert.equal(area().scrollTop, top - viewport / 3);
  });

  test('量的是那一句的第一个字，量完标记就撤掉', () => {
    assert.equal(ui.window.__measured.at(-1), '第');
    const probe = ui.doc.querySelector('#wbEditor .ed-mirror-probe .ed-mirror-content');
    assert.equal(probe.childNodes.length, 0);
  });
});
