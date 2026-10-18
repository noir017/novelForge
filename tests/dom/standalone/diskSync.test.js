/**
 * 内置编辑器：磁盘上的改动同步到已开的标签（`editor/diskSync.ts` + `Pane.applyDiskChange` / `markGone`）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 收到 `state` 去抖之后、窗口拿回焦点 / 页面重新可见时，把两块编辑区里开着的文件报给后端 | 定稿写回细纲、批量写章、外部 agent 的 edit、外部编辑器改了文件，从前编辑器里还是旧的 |
 * | 没改过的标签就地换、不切标签、不抢焦点、记一步撤销、光标夹进新长度 | 与「再次打开时磁盘有新版」同一处理，但不能像 editorOpen 那样把标签切过去 |
 * | 改过的标签一个字不动、挂冲突条、标签上标「!」、同一份新版不报第二次 | 不静默覆盖（第 3 条），也别刷屏 |
 * | 磁盘上没了：标成已删除；保存先问、不静默在原路径重建 | 网关对「带了基线、文件却不在」是当新建处理的 |
 * | 自己保存之后不误报 | `editorSaved` 先到、`state` 后到，核对时带的是新 hash；自己那次保存在路上时收到的「变了」不认 |
 * | 别的窗口存了同一份：不把基线悄悄换成别人的 | 从前那条 `editorSaved` 会让下一次保存把别人的改动盖掉 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const A = 'chapters/001-雨夜.md';
const B = '.novelforge/summaries/001-雨夜.md';
const C = 'drafts/001-雨夜.md';

function setup() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'fakeTimers'] });
  // 编辑器里不许再用 window.confirm：用到了就当场炸。
  ui.window.confirm = () => {
    throw new Error('不该调 window.confirm');
  };
  const toasts = [];
  ui.window.__nfToast = (message, isError) => toasts.push({ message, isError: !!isError });
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = (name, paneIndex = 0) =>
    [...ui.panes()[paneIndex].querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const activeTab = (paneIndex = 0) =>
    ui.panes()[paneIndex].querySelector('.ed-tab.active .ed-tab-name')?.textContent;
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const key = (k, extra = {}) =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const checks = () => ui.sent.filter((m) => m.type === 'checkEditorFiles');
  const lastCheck = () => checks().at(-1);
  const hashIn = (msg, path) => msg?.files.find((f) => f.path === path)?.hash;
  const sync = () => {
    ui.post({ type: 'state', state: viewState() });
    ui.window.__clock.tick(400);
    return lastCheck();
  };
  const changed = (path, text, hash, extra) =>
    ui.post({ type: 'editorDiskChanged', file: file(path, text, { hash, kind: 'chapter', ...extra }) });
  const status = () => ui.doc.getElementById('edStatusSave').textContent;
  const bar = () => ui.doc.getElementById('edConflict');
  return { ui, toasts, area, tabEl, activeTab, type, key, checks, lastCheck, hashIn, sync, changed, status, bar };
}

describe('磁盘上的改动：什么时候核对', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.post({ type: 'editorOpen', pane: 'draft', file: file(C, '草稿', { kind: 'draft' }) });
    s.ui.window.__clock.tick(1000);
  });

  test('收到 state 之后等一会儿，把两块编辑区里开着的文件连同 hash 报给后端', () => {
    const before = s.checks().length;
    s.ui.post({ type: 'state', state: viewState() });
    s.ui.window.__clock.tick(399);
    assert.equal(s.checks().length, before, '去抖还没到点就发了');
    s.ui.window.__clock.tick(1);
    assert.equal(s.checks().length, before + 1);
    // 消息是页面那一边造的对象（另一个 realm），按 JSON 比。
    assert.deepEqual(JSON.parse(JSON.stringify(s.lastCheck().files)), [
      { path: A, hash: `h-${A}` },
      { path: B, hash: `h-${B}` },
      { path: C, hash: `h-${C}` },
    ]);
  });

  test('连着几条 state 只核对一次', () => {
    const before = s.checks().length;
    for (let i = 0; i < 3; i++) {
      s.ui.post({ type: 'state', state: viewState() });
      s.ui.window.__clock.tick(100);
    }
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('窗口重新拿到焦点时也核对', () => {
    const before = s.checks().length;
    s.ui.window.dispatchEvent(new s.ui.window.Event('focus'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('页面重新可见时也核对，藏起来时不核对', () => {
    let state = 'hidden';
    Object.defineProperty(s.ui.doc, 'visibilityState', { configurable: true, get: () => state });
    const before = s.checks().length;
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before, '藏起来时不该核对');
    state = 'visible';
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('一个标签都没开时不发', () => {
    const empty = setup();
    empty.ui.post({ type: 'state', state: viewState() });
    empty.ui.window.__clock.tick(1000);
    assert.equal(empty.checks().length, 0);
  });
});

describe('磁盘上变了：没改过的标签', { skip: JSDOM_SKIP }, () => {
  let s;
  let outside;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。\n林昭推门。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    // 焦点在页面别处（比如对话输入框）：磁盘同步不许把它抢走。
    outside = s.ui.doc.createElement('input');
    s.ui.doc.body.appendChild(outside);
    outside.focus();
  });

  test('不是当前的那一份：就地换成新内容，当前标签不变', () => {
    assert.equal(s.activeTab(), '001-雨夜.md');
    s.changed(A, '雨夜。\n林昭推门，又退了出来。', 'h-A2');
    assert.equal(s.activeTab(), '001-雨夜.md', '当前标签还是细纲那一份');
    assert.equal(s.area().value, '# 梗概');
    assert.equal(s.ui.doc.activeElement, outside, '焦点没被抢走');
    assert.equal(s.toasts.length, 0, '不弹 toast');
  });

  test('切过去看到的是磁盘上的新版，仍是没改过的', () => {
    s.ui.clickEl(s.tabEl('001-雨夜.md'));
    // 正文与细纲同名，按顺序第一个是正文。
    assert.equal(s.area().value, '雨夜。\n林昭推门，又退了出来。');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });

  test('换进来的那一下记一步撤销', () => {
    s.key('z', { ctrlKey: true });
    assert.equal(s.area().value, '雨夜。\n林昭推门。');
    s.key('y', { ctrlKey: true });
    assert.equal(s.area().value, '雨夜。\n林昭推门，又退了出来。');
  });

  test('正看着的那一份：光标留在原处，焦点不动，状态栏说一句', () => {
    outside.focus();
    s.area().setSelectionRange(3, 3);
    s.changed(A, '雨夜。\n林昭推门，又退了出来，雨更大了。', 'h-A3');
    assert.equal(s.area().value, '雨夜。\n林昭推门，又退了出来，雨更大了。');
    assert.equal(s.area().selectionStart, 3);
    assert.equal(s.ui.doc.activeElement, outside);
    assert.equal(s.status(), '磁盘上有新版本，已载入');
    assert.equal(s.toasts.length, 0);
  });

  test('那一句过一会儿退回保存状态', () => {
    s.ui.window.__clock.tick(4000);
    assert.equal(s.status(), '已保存');
  });

  test('光标夹进新长度', () => {
    s.area().setSelectionRange(s.area().value.length, s.area().value.length);
    s.changed(A, '短了', 'h-A4');
    assert.equal(s.area().value, '短了');
    assert.equal(s.area().selectionStart, 2);
  });

  test('之后核对时带的是新版的 hash', () => {
    assert.equal(s.hashIn(s.sync(), A), 'h-A4');
  });
});

describe('磁盘上变了：改过的标签', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.type('雨夜。林昭来了。');
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
  });

  test('编辑器里的修改一个字不动，不切标签，标签上挂「!」', () => {
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.activeTab(), '001-雨夜.md');
    assert.equal(s.area().value, '# 梗概', '当前还是细纲');
    const tab = s.ui.panes()[0].querySelector('.ed-tab.conflict');
    assert.ok(tab, '改过的那个标签要标出来');
    assert.ok(tab.querySelector('.ed-tab-flag'), '标签上要有「!」');
    assert.equal(s.toasts.length, 1);
    assert.equal(s.toasts[0].isError, true);
  });

  test('切过去：修改还在，冲突条说磁盘上被改了、没有覆盖', () => {
    s.ui.clickEl(s.ui.panes()[0].querySelector('.ed-tab.conflict'));
    assert.equal(s.area().value, '雨夜。林昭来了。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    const text = s.ui.doc.getElementById('edConflictText').textContent;
    assert.match(text, /没有覆盖/);
    assert.doesNotMatch(text, /保存已取消/);
  });

  test('同一份新版再报一次不再弹提示', () => {
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.toasts.length, 1);
  });

  test('核对时带上见过的那份磁盘新版的 hash（同一个新版后端就不再回话）', () => {
    assert.equal(s.hashIn(s.sync(), A), 'h-A2');
  });

  test('接着打字冲突条收起，同一份新版也不再报', () => {
    s.type('雨夜。林昭来了。又一笔。');
    assert.equal(s.bar().classList.contains('hidden'), true);
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.toasts.length, 1);
    assert.equal(s.bar().classList.contains('hidden'), true);
  });

  test('磁盘上又变了一次：再挂冲突条', () => {
    s.changed(A, '雨夜。（又改了）', 'h-A3');
    assert.equal(s.toasts.length, 2);
    assert.equal(s.bar().classList.contains('hidden'), false);
    assert.equal(s.area().value, '雨夜。林昭来了。又一笔。');
  });

  test('「用磁盘版本覆盖编辑器」之后基线换成那一份', () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictTake'));
    assert.equal(s.area().value, '雨夜。（又改了）');
    assert.equal(s.hashIn(s.sync(), A), 'h-A3');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.conflict'), null);
  });

  test('磁盘上的正好是编辑器里这一份：认下来，不算冲突', () => {
    s.type('两边一样');
    const before = s.toasts.length;
    s.changed(A, '两边一样', 'h-same');
    assert.equal(s.toasts.length, before);
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });
});

describe('磁盘上没了', { skip: JSDOM_SKIP }, () => {
  let s;
  const goneTab = () => s.ui.panes()[0].querySelector('.ed-tab.gone');

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.type('雨夜。改了一笔。');
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
  });

  test('标签标成已删除，不切过去', () => {
    s.ui.post({ type: 'editorDiskGone', path: A });
    assert.ok(goneTab(), '没标成已删除');
    assert.ok(goneTab().querySelector('.ed-tab-flag'));
    assert.equal(s.area().value, '# 梗概');
  });

  test('切过去：冲突条那一格说磁盘上已经没有这个文件，没有「用磁盘版本覆盖」', () => {
    s.ui.clickEl(goneTab());
    assert.equal(s.area().value, '雨夜。改了一笔。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    assert.match(s.ui.doc.getElementById('edConflictText').textContent, /磁盘上已经没有.*（被删或改名）/);
    assert.equal(s.ui.doc.getElementById('edConflictTake').classList.contains('hidden'), true);
  });

  test('打字不让这条说明收起', () => {
    s.type('雨夜。改了两笔。');
    assert.equal(s.bar().classList.contains('hidden'), false);
  });

  test('核对时给空 hash：磁盘上又出现了后端就会回话', () => {
    assert.equal(s.hashIn(s.sync(), A), '');
  });

  test('按保存先问要不要在原路径重建，取消就什么都不发', async () => {
    const before = s.ui.sent.filter((m) => m.type === 'saveFile').length;
    s.key('s', { ctrlKey: true });
    assert.ok(s.ui.dialog(), '没有弹对话框');
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路径重建']);
    await s.ui.answer('取消');
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.sent.filter((m) => m.type === 'saveFile').length, before);
  });

  test('冲突条上的「强制保存」也走这一问', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路径重建']);
    await s.ui.answer('取消');
  });

  test('答应了才发，带着 recreate 与基线', async () => {
    s.key('s', { ctrlKey: true });
    await s.ui.answer('在原路径重建');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, true);
    assert.equal(msg.baseHash, `h-${A}`);
    assert.equal(msg.text, '雨夜。改了两笔。');
  });

  test('存成了：已删除的标记清掉', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。改了两笔。', { hash: 'h-A2', kind: 'chapter' }) });
    assert.equal(goneTab(), null);
    assert.equal(s.bar().classList.contains('hidden'), true);
  });

  test('普通保存撞上「磁盘上没了」：提示没有保存，标成已删除，不再「保存中」', () => {
    s.type('雨夜。改了三笔。');
    s.key('s', { ctrlKey: true });
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, undefined);
    assert.equal(s.status(), '保存中…');
    s.ui.post({ type: 'editorDiskGone', path: A });
    assert.match(s.toasts.at(-1).message, /没有保存/);
    assert.ok(goneTab());
    assert.match(s.status(), /未保存/);
  });

  test('磁盘上又出现了同一份：已删除的标记清掉', () => {
    s.changed(A, '雨夜。改了两笔。', 'h-A2');
    assert.equal(goneTab(), null);
    assert.equal(s.area().value, '雨夜。改了三笔。');
  });
});

describe('磁盘上没了：没改过的那一份', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorDiskGone', path: A });
  });

  test('「全部保存」扫到它不弹框、不发保存', () => {
    s.ui.window.dispatchEvent(new s.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'saveAll' } }));
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.last('saveFile'), undefined);
  });

  test('冲突条上的「强制保存」是明说要存：照样问，答应了带着基线重建', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路径重建']);
    await s.ui.answer('在原路径重建');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, true);
    assert.equal(msg.baseHash, `h-${A}`, '重建也带基线：期间原路径又有了别的内容照样撞冲突');
  });
});

describe('自己保存之后不误报', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter', hash: 'h0' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.clickEl(s.tabEl('001-雨夜.md'));
    s.type('雨夜。林昭来了。');
    s.key('s', { ctrlKey: true });
  });

  test('保存带着原来的基线发出去', () => {
    assert.equal(s.ui.last('saveFile').baseHash, 'h0');
  });

  test('保存还在路上时核对不带这一份', () => {
    const msg = s.sync();
    assert.equal(s.hashIn(msg, A), undefined);
    assert.equal(s.hashIn(msg, B), `h-${B}`);
  });

  test('路上收到的「磁盘上变了」（读到了自己刚写下去的那份）不认', () => {
    s.changed(A, '雨夜。林昭来了。', 'h1');
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.toasts.length, 0);
    assert.equal(s.status(), '保存中…');
  });

  test('回执先到、state 后到：之后核对时带的就是新 hash', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。林昭来了。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.hashIn(s.sync(), A), 'h1');
  });

  test('迟到的「变了」报的就是自己存下去的那份：什么都不动', () => {
    s.changed(A, '雨夜。林昭来了。', 'h1');
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.conflict'), null);
    assert.equal(s.toasts.length, 0);
    assert.match(s.status(), /^已保存/);
  });
});

describe('别的窗口存了同一份（回执是广播的）', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter', hash: 'h0' }) });
  });

  test('这边没改过：就地换成那一份', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。别处写的。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.area().value, '雨夜。别处写的。');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });

  test('这边改过：挂冲突条，基线不悄悄换成别人的', () => {
    s.type('雨夜。别处写的。这边又写了。');
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。另一个窗口又存了。', { kind: 'chapter', hash: 'h2' }) });
    assert.equal(s.area().value, '雨夜。别处写的。这边又写了。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    s.key('s', { ctrlKey: true });
    assert.equal(s.ui.last('saveFile').baseHash, 'h1', '保存仍带这边的基线，撞上冲突而不是盖掉别人的');
  });
});

describe('再次打开（生成落盘后 openFile → editorOpen）那条路不变', { skip: JSDOM_SKIP }, () => {
  test('editorOpen 照旧把那个标签切成当前的', () => {
    const s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。新写的。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.area().value, '雨夜。新写的。');
  });
});
