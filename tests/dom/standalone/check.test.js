/**
 * 写作体检（独立版内置编辑器，`media/src/editor/check.ts` / `checkPanel.ts`，「视图 → 体检」在 `view/checkMenu.ts`）。
 * 口径（四类怎么认、比喻词超限、英文大小写、与生成链对拍）在 tests/unit/editor/checkCore.test.js 钉着，这里钉整条链路
 * （jsdom 没有排版，镜像层测 DOM 内容不测像素）：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 只看正文 | 章节、草稿上画 `check` 图层，角色卡、敏感词表本身、没给 `kind` 的不画、状态栏那一格藏起来；词表换了当场重画 |
 * | 与别的图层共存 | 查找、段落聚焦开着时三层的 class 落在同一段字上，收起查找体检照旧；样式不碰排版、比查找低一级，三套主题都有颜色 |
 * | 打字 | 改了字之后同一轮里重查（新词标上、旧的挪到新位置）；输入法组字中途不重查、不乱跳，上屏之后再查 |
 * | 状态栏与面板 | 「体检 N」「体检 ✓」、悬停提示；点开按类别列词与次数，Esc / 点外面 / 再点一下收起，按下鼠标不夺焦点 |
 * | 点词跳转 | 依次跳到每一处并选中、焦点进正文、到底绕回 |
 * | 替换 | 「替换本处」先选中再换、换完选下一处，一步撤销；「全部替换」一次换完、一步撤销 |
 * | 「视图 → 体检」 | 两个开关缺省开、关掉高亮 / 那一格、记进 `novelforge.editor.prefs` 不冲掉别的、刷新照旧；「编辑敏感词表…」 |
 * | 编辑敏感词表 | 面板里与菜单里都发 `editSensitiveWords`，后端打开的那一份进编辑器（不体检它）；没开工程置灰 |
 * | 大章节 | 两万字以上节流到定时器里，其间旧的跟着挪；面板上的动作先当场重查 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const PREFS_KEY = 'novelforge.editor.prefs';
const SENSITIVE = '.novelforge/sensitive.txt';
const CH = 'chapters/003-夜访.md';
/** 等微任务跑完（体检在微任务里重查）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 等两帧（jsdom 没有 rAF，镜像层退回 16ms 定时器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

const TERMS = {
  banned: ['能量', '神经'],
  sensitive: [{ term: '赌博', replacement: '博戏' }, { term: 'SB' }],
  sensitivePath: SENSITIVE,
  sensitiveExists: true,
  sensitiveBad: [],
};
/** 敏感词「赌博」、敏感词「SB」（小写的 sb）、禁用词「能量」、英文缩写「PTSD」：四个问题。 */
const TEXT = '林昭赌博输光了，能量耗尽。\n\nPTSD 又犯了，sb 才信。';

function harness(opts = {}) {
  const { shims = SHIMS, terms = TERMS, ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims, ...rest });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  if (terms) {
    ui.post({ type: 'checkTerms', terms });
  }
  const main = () => ui.doc.getElementById('wbEditor');
  const area = () => ui.doc.getElementById('edArea');
  const h = {
    ui,
    toasts,
    main,
    area,
    open(p, text, extra) {
      ui.post({ type: 'editorOpen', file: file(p, text, extra) });
      const a = area();
      a.setSelectionRange(0, 0);
    },
    /** 镜像层里某一层的 `<mark>`（`cls` 给类名，不给就是 check 那四类）。 */
    marks(cls) {
      const all = [...main().querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')];
      return all.filter((m) => (cls ? m.classList.contains(cls) : [...m.classList].some((c) => c.startsWith('ed-hl-chk-'))));
    },
    /** 每一段 check 标记：[字, 类别]。 */
    checkMarks() {
      return h.marks().map((m) => [m.textContent, [...m.classList].filter((c) => c.startsWith('ed-hl-chk-')).map((c) => c.slice(10)).join('+')]);
    },
    cell: () => main().querySelector('.ed-status .ed-check'),
    cellShown: () => !!h.cell() && !h.cell().classList.contains('hidden'),
    panel: () => ui.doc.querySelector('.ed-check-panel'),
    clickCell() {
      ui.clickEl(h.cell());
      return h.panel();
    },
    /** 面板上某个词那一行。 */
    row(term) {
      return [...(h.panel()?.querySelectorAll('.ed-check-row') ?? [])].find((r) => r.querySelector('.ed-check-term').textContent === term);
    },
    clickWord(term) {
      ui.clickEl(h.row(term).querySelector('.ed-check-word'));
    },
    times: (term) => h.row(term)?.querySelector('.ed-check-times').textContent,
    selected: () => [area().selectionStart, area().selectionEnd],
    /** 在选区处打进去（键盘）。 */
    type(text) {
      const a = area();
      const s = a.selectionStart;
      a.value = a.value.slice(0, s) + text + a.value.slice(a.selectionEnd);
      a.setSelectionRange(s + text.length, s + text.length);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    },
    /** 输入法：`steps` 是组字中途显示的拼音，返回上屏 `commit` 的那一下。 */
    compose(steps, commit) {
      const a = area();
      const base = a.value;
      const at = a.selectionStart;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of steps) {
        a.value = base.slice(0, at) + step + base.slice(at);
        a.setSelectionRange(at + step.length, at + step.length);
        a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
      }
      return () => {
        a.value = base.slice(0, at) + commit + base.slice(at);
        a.setSelectionRange(at + commit.length, at + commit.length);
        a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
      };
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    undo: () => h.key({ key: 'z', ctrlKey: true }),
    redo: () => h.key({ key: 'y', ctrlKey: true }),
    viewMenu() {
      ui.closeMenu();
      ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
      return ui.doc.querySelector('.wb-menu-drop');
    },
    menuItem(label) {
      return [...h.viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    },
    pickMenu(label) {
      const btn = h.menuItem(label);
      assert.ok(btn, `「视图」里没有「${label}」`);
      ui.clickEl(btn);
      ui.closeMenu();
    },
    storedPrefs: () => JSON.parse(ui.window.localStorage.getItem(PREFS_KEY)),
  };
  return h;
}

describe('写作体检：只看正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('章节：四类各自标出来（敏感词英文不分大小写）', () => {
    assert.deepEqual(h.checkMarks(), [
      ['赌博', 'sensitive'],
      ['能量', 'banned'],
      ['PTSD', 'acronym'],
      ['sb', 'sensitive'],
    ]);
  });

  test('镜像层里的文字与 textarea 一字不差（标记只是包住那几个字）', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, TEXT);
  });

  test('状态栏一格「体检 4」，挨着字数那一格、在 spacer 之前', () => {
    assert.equal(h.cell().textContent, '体检 4');
    assert.equal(h.cell().classList.contains('has-issues'), true);
    assert.equal(h.cell().previousElementSibling.id, 'edStatusWords');
    assert.equal(h.cell().nextElementSibling.classList.contains('spacer'), true);
  });

  test('悬停提示：各类几个', () => {
    assert.match(h.cell().title, /敏感词 2 处 · 禁用词 1 处 · 英文缩写 1 处/);
  });

  test('草稿也是正文：照样查', () => {
    h.open('drafts/003-夜访.md', '能量。', { kind: 'draft' });
    assert.deepEqual(h.checkMarks(), [['能量', 'banned']]);
    assert.equal(h.cell().textContent, '体检 1');
  });

  test('角色卡（不是正文）：不画、那一格藏起来', () => {
    h.open('.novelforge/characters/林昭.md', TEXT, { kind: 'character' });
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('没给 kind（没打开工程）：当非正文', () => {
    h.open('notes.md', TEXT);
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('切回章节：当场画回来', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.title.includes(CH) || t.textContent.includes('003-夜访') && !t.textContent.includes('草稿')));
    assert.equal(h.area().value, TEXT);
    assert.equal(h.checkMarks().length, 4);
    assert.equal(h.cell().textContent, '体检 4');
  });

  test('没有问题：「体检 ✓」', () => {
    h.open('chapters/004.md', '雨停了。', { kind: 'chapter' });
    assert.equal(h.cell().textContent, '体检 ✓');
    assert.equal(h.cell().classList.contains('has-issues'), false);
  });

  test('比喻词没超上限（3 次）：不画、不算', () => {
    h.open('chapters/005.md', '仿佛、犹如、宛如。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cell().textContent, '体检 ✓');
  });

  test('超了：每一处都画，算超出的那几个', () => {
    h.open('chapters/006.md', '仿佛、犹如、宛如、如同、好似。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks().map(([, c]) => c), ['simile', 'simile', 'simile', 'simile', 'simile']);
    assert.equal(h.cell().textContent, '体检 2');
  });

  test('后端推来新的词表：当场重查重画', () => {
    h.open('chapters/007.md', '他的神经绷紧了，刹那间。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks(), [['神经', 'banned']]);
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, banned: ['刹那'] } });
    assert.deepEqual(h.checkMarks(), [['刹那', 'banned']]);
    h.ui.post({ type: 'checkTerms', terms: TERMS });
  });
});

describe('写作体检：与查找、段落聚焦同时开着', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('查找「能量」：同一段字上既有查找的 class 也有体检的', () => {
    h.key({ key: 'f', ctrlKey: true });
    const input = h.main().querySelector('.ed-find-input');
    input.value = '能量';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    const both = h.marks('ed-hl-find-current');
    assert.equal(both.length, 1);
    assert.equal(both[0].textContent, '能量');
    assert.equal(both[0].classList.contains('ed-hl-chk-banned'), true);
    // 别的体检标记不受影响。
    assert.equal(h.checkMarks().length, 4);
    h.key({ key: 'Escape' }, input);
  });

  test('收起查找：查找的标记没了，体检的照旧', () => {
    assert.equal(h.marks('ed-hl-find').length + h.marks('ed-hl-find-current').length, 0);
    assert.equal(h.checkMarks().length, 4);
  });

  test('段落聚焦：focus 图层与 check 图层落在同一段字上', () => {
    const a = h.area();
    a.focus();
    a.setSelectionRange(3, 3);
    h.pickMenu('段落聚焦');
    const inFocus = h.marks('ed-hl-focus');
    assert.equal(inFocus.map((m) => m.textContent).join(''), '林昭赌博输光了，能量耗尽。');
    const both = inFocus.filter((m) => m.classList.contains('ed-hl-chk-sensitive'));
    assert.deepEqual(both.map((m) => m.textContent), ['赌博']);
    // 不在当前段的体检标记照样画着。
    assert.ok(h.checkMarks().some(([t]) => t === 'PTSD'));
    h.pickMenu('段落聚焦');
  });

  test('样式：check 图层只画下划线（不碰排版、不改字色），选择器比查找低一级', () => {
    const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*ed-hl-chk-[^{}]*)\{([^}]*)\}/g)];
    assert.equal(rules.length, 4);
    for (const [, selector, body] of rules) {
      assert.match(selector.trim(), /^:where\(\.ed-mirror\) mark\.ed-hl-chk-\w+$/);
      assert.doesNotMatch(body, /(^|[;\s])(padding|margin|border|font-weight|color)\s*:/);
      assert.match(body, /text-decoration:/);
    }
    // 查找的底色仍是 `.ed-mirror mark.ed-hl-find`（比 :where 那一条高一级，敏感词的淡底色盖不过它）。
    assert.match(css, /\.ed-mirror mark\.ed-hl-find\s*\{/);
  });

  test('深 / 浅 / 护眼三套主题都给了体检的五个颜色', () => {
    const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    const isTheme = (sel, theme) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(sel.trim())?.[1] === theme;
    const vars = (theme) =>
      [...style.sheet.cssRules]
        .filter((r) => r.selectorText && r.selectorText.split(',').some((sel) => isTheme(sel, theme)))
        .flatMap((r) => [...r.style].filter((n) => n.startsWith('--nf-chk-')))
        .sort();
    const want = ['--nf-chk-acronym', '--nf-chk-banned', '--nf-chk-sensitive', '--nf-chk-sensitive-bg', '--nf-chk-simile'];
    for (const theme of ['dark', 'light', 'sepia']) {
      assert.deepEqual(vars(theme), want, theme);
    }
    style.remove();
  });
});

describe('写作体检：打字与输入法', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('在最前面打字：旧的标记挪到新位置（字还是那几个字），同一轮里就对', async () => {
    h.area().setSelectionRange(0, 0);
    h.type('雨夜，');
    await flush();
    await frames();
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['赌博', '能量', 'PTSD', 'sb']);
    assert.equal(h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content').textContent, h.area().value);
  });

  test('打出一个禁用词：同一轮里标上、计数跟着涨', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('神经');
    await flush();
    assert.equal(h.cell().textContent, '体检 5');
    assert.deepEqual(h.checkMarks().at(-1), ['神经', 'banned']);
  });

  test('删掉它：标记没了、计数回去', async () => {
    const a = h.area();
    const at = a.value.length;
    a.value = a.value.slice(0, at - 2);
    a.setSelectionRange(at - 2, at - 2);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    await flush();
    // 重查的结果与镜像层平移之后的一样：不再画一遍，镜像层自己下一帧重画。
    await frames();
    assert.equal(h.cell().textContent, '体检 4');
    assert.equal(h.checkMarks().some(([t]) => t === '神经'), false);
  });

  test('撤销 / 重做（没有改动可用）：先挪、再查，计数跟着', async () => {
    h.undo();
    await flush();
    assert.equal(h.cell().textContent, '体检 5');
    h.undo();
    await flush();
    assert.equal(h.cell().textContent, '体检 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['赌博', '能量', 'PTSD', 'sb']);
    h.redo();
    await flush();
    assert.equal(h.cell().textContent, '体检 5');
    h.undo();
    await flush();
  });

  test('输入法组字中途：拼音「sb」不当成敏感词、计数不跳，旧标记挪到拼音后面', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    const commit = h.compose(['s', 'sb'], '傻');
    await flush();
    await frames();
    assert.equal(h.cell().textContent, '体检 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['赌博', '能量', 'PTSD', 'sb']);
    assert.equal(h.marks().filter((m) => m.textContent === 'sb').length, 1);
    commit();
    await flush();
    await frames();
    assert.equal(h.area().value.startsWith('傻雨夜，'), true);
    assert.equal(h.cell().textContent, '体检 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['赌博', '能量', 'PTSD', 'sb']);
  });

  test('上屏的字是敏感词：上屏之后才标出来', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    const commit = h.compose(['du', 'dubo'], '赌博');
    await flush();
    assert.equal(h.cell().textContent, '体检 4');
    commit();
    await flush();
    assert.equal(h.cell().textContent, '体检 5');
    assert.deepEqual(h.checkMarks()[0], ['赌博', 'sensitive']);
  });
});

describe('写作体检：面板', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('按下鼠标不夺编辑区的焦点', () => {
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.cell().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('点开：挂在 body 上、那一格 aria-expanded', () => {
    const panel = h.clickCell();
    assert.ok(panel);
    assert.equal(panel.parentElement, h.ui.doc.body);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'true');
    assert.match(panel.querySelector('.ed-check-aside').textContent, /4 个问题/);
  });

  test('按类别列：敏感词 → 禁用词 → 英文缩写，每一类几处', () => {
    const secs = [...h.panel().querySelectorAll('.ed-check-sec')].map((s) => [
      s.querySelector('.ed-check-sec-label').textContent,
      s.querySelector('.ed-check-sec-count').textContent,
    ]);
    assert.deepEqual(secs, [
      ['敏感词', '2 处'],
      ['禁用词', '1 处'],
      ['英文缩写', '1 处'],
    ]);
  });

  test('词与次数；有替换词的那一个带「替换本处」「全部替换」，别的没有', () => {
    assert.equal(h.times('赌博'), '×1');
    assert.equal(h.row('赌博').querySelector('.ed-check-replacement').textContent, '博戏');
    assert.ok(h.row('赌博').querySelector('.ed-check-replace-one'));
    assert.ok(h.row('赌博').querySelector('.ed-check-replace-all'));
    assert.equal(h.row('SB').querySelector('.ed-check-replace-one'), null);
    assert.equal(h.row('能量').querySelector('.ed-check-replace-all'), null);
  });

  test('说清禁用词与写正文时数的是同一份、敏感词表在哪', () => {
    const text = h.panel().textContent;
    assert.match(text, /与写正文时写完数的是同一份/);
    assert.match(text, /\.novelforge\/sensitive\.txt/);
    assert.match(text, /不调模型/);
  });

  test('开着打字：跟着变', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.times('能量'), '×2');
    h.undo();
    await flush();
    assert.equal(h.times('能量'), '×1');
  });

  test('Esc 收起（捕获阶段吞掉，不往下传）', () => {
    const ev = h.key({ key: 'Escape' }, h.ui.doc.body);
    assert.equal(h.panel(), null);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'false');
    assert.equal(ev.defaultPrevented, false);
  });

  test('点外面收起；点面板里面不收', () => {
    h.clickCell();
    h.panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.ui.doc.body.dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('再点一下那一格收起', () => {
    h.clickCell();
    h.clickCell();
    assert.equal(h.panel(), null);
  });

  test('不是正文时那一格藏起来，开着的面板跟着收', () => {
    h.clickCell();
    h.open('.novelforge/characters/林昭.md', '主角。', { kind: 'character' });
    assert.equal(h.panel(), null);
  });

  test('敏感词表还没建、有坏行：面板里说一句', () => {
    h.ui.post({
      type: 'checkTerms',
      terms: { ...TERMS, sensitiveExists: false, sensitive: [], sensitiveBad: [{ line: 3, reason: '「=>」前面没有词' }, { line: 7, reason: '太长了' }] },
    });
    h.open(CH, TEXT, { kind: 'chapter' });
    h.clickCell();
    const text = h.panel().textContent;
    assert.match(text, /还没有敏感词表/);
    assert.match(text, /敏感词表第 3、7 行没看懂，已跳过/);
    assert.match(h.panel().querySelector('.ed-check-bad').title, /第 3 行：「=>」前面没有词/);
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.post({ type: 'checkTerms', terms: TERMS });
  });
});

describe('写作体检：点词跳转选中', { skip: JSDOM_SKIP }, () => {
  let h;
  const text = '能量一，能量二，能量三。';
  before(() => {
    h = harness();
    h.open(CH, text, { kind: 'chapter' });
    h.ui.doc.body.focus();
    h.clickCell();
  });

  test('点一下：光标之后的第一处被选中，焦点进正文，面板上写「1/3」', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [0, 2]);
    assert.equal(h.ui.doc.activeElement, h.area());
    assert.equal(h.times('能量'), '1/3');
    assert.ok(h.panel(), '面板还开着');
  });

  test('再点：下一处', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [4, 6]);
    assert.equal(h.times('能量'), '2/3');
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [8, 10]);
  });

  test('到底了绕回第一处', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [0, 2]);
    assert.equal(h.times('能量'), '1/3');
  });

  test('面板上的按钮按下鼠标不夺焦点（选区留着）', () => {
    const btn = h.row('能量').querySelector('.ed-check-word');
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('预览里点词：先切回编辑再选中', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.clickCell();
    h.clickWord('能量');
    assert.equal(h.area().classList.contains('hidden'), false);
    const [s, e] = h.selected();
    assert.equal(h.area().value.slice(s, e), '能量');
  });
});

describe('写作体检：替换本处与本文件全部替换', { skip: JSDOM_SKIP }, () => {
  let h;
  const text = '赌博，赌博，赌博。';
  before(() => {
    h = harness();
    h.open(CH, text, { kind: 'chapter' });
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.clickCell();
  });

  test('没选中这个词时「替换本处」只选中下一处（到底绕回第一处），一个字不改', () => {
    h.ui.clickEl(h.row('赌博').querySelector('.ed-check-replace-one'));
    assert.equal(h.area().value, text);
    assert.deepEqual(h.selected(), [0, 2]);
  });

  test('再按一下：换掉选中的这一处，接着选中下一处', () => {
    h.ui.clickEl(h.row('赌博').querySelector('.ed-check-replace-one'));
    assert.equal(h.area().value, '博戏，赌博，赌博。');
    assert.deepEqual(h.selected(), [3, 5]);
    assert.equal(h.cell().textContent, '体检 2');
  });

  test('Ctrl+Z 一步退回', async () => {
    h.undo();
    await flush();
    assert.equal(h.area().value, text);
    assert.equal(h.cell().textContent, '体检 3');
  });

  test('「全部替换」：一次换完、说替换了几处', () => {
    h.ui.clickEl(h.row('赌博').querySelector('.ed-check-replace-all'));
    assert.equal(h.area().value, '博戏，博戏，博戏。');
    assert.match(h.toasts.at(-1), /替换了 3 处/);
    assert.equal(h.cell().textContent, '体检 ✓');
    assert.equal(h.row('赌博'), undefined);
  });

  test('Ctrl+Z 一步全部退回，Ctrl+Y 再来', async () => {
    h.undo();
    await flush();
    assert.equal(h.area().value, text);
    assert.equal(h.cell().textContent, '体检 3');
    h.redo();
    await flush();
    assert.equal(h.area().value, '博戏，博戏，博戏。');
  });

  test('替换之后是未保存（不写盘、不发 saveFile）', () => {
    assert.equal(h.ui.sent.some((m) => m.type === 'saveFile'), false);
    assert.match(h.ui.doc.getElementById('edStatusSave').textContent, /未保存/);
  });

  test('大小写不同的几处一起换（敏感词英文不分大小写）', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, sensitive: [{ term: 'sb', replacement: '某人' }] } });
    h.open('chapters/008.md', 'SB 说 sb 不对。', { kind: 'chapter' });
    h.clickCell();
    h.ui.clickEl(h.row('sb').querySelector('.ed-check-replace-all'));
    assert.equal(h.area().value, '某人 说 某人 不对。');
  });
});

describe('写作体检：「视图 → 体检」', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    // 段落那几项与码字统计先记着非缺省值：体检写偏好时不许把它们冲掉。
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false, stats: { goal: false, session: true, today: false } }) } });
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('「视图」最后一组：体检高亮、状态栏显示体检（缺省都开）、编辑敏感词表…', () => {
    const labels = [...h.viewMenu().querySelectorAll('.wb-menu-item')].map((b) => b.querySelector('.wb-menu-label').textContent);
    assert.deepEqual(labels.slice(-3), ['体检高亮', '状态栏显示体检', '编辑敏感词表…']);
    assert.equal(h.menuItem('体检高亮').getAttribute('aria-checked'), 'true');
    assert.equal(h.menuItem('状态栏显示体检').getAttribute('aria-checked'), 'true');
    assert.equal(h.menuItem('编辑敏感词表…').disabled, false);
    h.ui.closeMenu();
  });

  test('关掉体检高亮：正文里的标记没了，那一格照旧数', () => {
    h.pickMenu('体检高亮');
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cell().textContent, '体检 4');
    assert.match(h.cell().title, /体检高亮关着/);
    assert.equal(h.menuItem('体检高亮').getAttribute('aria-checked'), 'false');
    h.ui.closeMenu();
  });

  test('记进 novelforge.editor.prefs，不冲掉段落与码字统计那几项', () => {
    const prefs = h.storedPrefs();
    assert.deepEqual(prefs.check, { highlight: false, status: true });
    assert.equal(prefs.autoPair, false);
    assert.deepEqual(prefs.stats, { goal: false, session: true, today: false });
  });

  test('关掉状态栏那一格：藏起来', () => {
    h.pickMenu('状态栏显示体检');
    assert.equal(h.cellShown(), false);
    assert.deepEqual(h.storedPrefs().check, { highlight: false, status: false });
  });

  test('刷新之后照旧', () => {
    const again = harness({ storage: { [PREFS_KEY]: h.ui.window.localStorage.getItem(PREFS_KEY) } });
    again.open(CH, TEXT, { kind: 'chapter' });
    assert.deepEqual(again.checkMarks(), []);
    assert.equal(again.cellShown(), false);
  });

  test('都打开回来：标记与那一格都回来', () => {
    h.pickMenu('体检高亮');
    h.pickMenu('状态栏显示体检');
    assert.equal(h.checkMarks().length, 4);
    assert.equal(h.cell().textContent, '体检 4');
  });

  test('写坏了的偏好（不是对象）：两个都按缺省开', () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ check: 'yes' }) } });
    again.open(CH, TEXT, { kind: 'chapter' });
    assert.equal(again.checkMarks().length, 4);
    assert.equal(again.cellShown(), true);
  });
});

describe('写作体检：编辑敏感词表…', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ terms: { ...TERMS, sensitive: [], sensitiveExists: false } });
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('面板里点它：发 editSensitiveWords、面板收起', () => {
    h.clickCell();
    h.ui.clickEl(h.panel().querySelector('.ed-check-edit'));
    assert.equal(h.ui.last('editSensitiveWords')?.type, 'editSensitiveWords');
    assert.equal(h.panel(), null);
  });

  test('「视图」里点它：同样发 editSensitiveWords', () => {
    h.ui.sent.length = 0;
    h.pickMenu('编辑敏感词表…');
    assert.equal(h.ui.sent.filter((m) => m.type === 'editSensitiveWords').length, 1);
  });

  test('后端建好打开的那一份进编辑器、成了当前标签；它不是正文，不体检它', () => {
    h.ui.post({ type: 'editorOpen', file: file(SENSITIVE, '# 敏感词表\n赌博 => 博戏\n', { kind: 'sensitive' }) });
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, sensitive: [{ term: '赌博', replacement: '博戏' }] } });
    assert.equal(h.area().value, '# 敏感词表\n赌博 => 博戏\n');
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('词表到了：回到正文就按新词表标', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('003')));
    assert.ok(h.checkMarks().some(([t, c]) => t === '赌博' && c === 'sensitive'));
  });

  test('没打开工程：菜单项置灰', () => {
    const empty = harness({ empty: true, terms: null });
    const btn = empty.menuItem('编辑敏感词表…');
    assert.equal(btn.disabled, true);
    empty.ui.closeMenu();
  });
});

describe('写作体检：大章节节流', { skip: JSDOM_SKIP }, () => {
  let h;
  const big = '雨'.repeat(30_000) + '能量';
  before(() => {
    h = harness({ shims: [...SHIMS, 'fakeTimers'] });
    h.open(CH, big, { kind: 'chapter' });
  });

  test('打开时当场查一遍', () => {
    assert.equal(h.cell().textContent, '体检 1');
    assert.deepEqual(h.checkMarks(), [['能量', 'banned']]);
  });

  test('打出新的禁用词：不当场重查（节流到定时器里），拨过 300ms 才标上', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.cell().textContent, '体检 1');
    h.ui.window.__clock.tick(300);
    assert.equal(h.cell().textContent, '体检 2');
    assert.equal(h.checkMarks().length, 2);
  });

  test('节流的空档里在前面打字：旧标记跟着挪（镜像层自己平移），字还是那几个字', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    h.type('夜');
    await flush();
    h.ui.window.__clock.tick(16);
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['能量', '能量']);
    h.ui.window.__clock.tick(300);
  });

  test('面板上点词之前先当场重查：位置是此刻的', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.cell().textContent, '体检 2');
    h.clickCell();
    h.clickWord('能量');
    assert.equal(h.times('能量'), '1/3');
    const [s, e] = h.selected();
    assert.equal(h.area().value.slice(s, e), '能量');
    h.key({ key: 'Escape' }, h.ui.doc.body);
  });
});
