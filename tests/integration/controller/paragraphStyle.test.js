/**
 * 切换分段格式（`setParagraphStyle`，内置编辑器「编辑 → 段落格式」）的后端一半。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只改 `config.md` frontmatter 的这一个键，别的字节一个不动 | 作者手排的配置不该因为点了一下菜单就被整份重渲染（第 3 条） |
 * | 正文一个字节不动 | 切格式只是换个设置；要把已写的正文排成新格式，是作者自己点「一键排版」 |
 * | 写完 `pushState`：`state` 与工程树都带新值 | 编辑器的回车、菜单上的勾跟着它走（前端无状态） |
 * | 没有 `config.md` 时新建一份最小的，「小说配置」仍算没填、主按钮与架构那一行的 ●/○ 都不变 | 第 20 条：只推一个下一步，不能因为多了一个文件就跳过「生成小说配置」 |
 * | 之后重写配置（生成链落盘）把它带过去 | 绝不静默丢掉作者的设置 |
 * | 认不出的值、还不是小说工程：不写 | 第 1 条；写一份 config.md 也不会让它变成工程 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CONFIG = '.novelforge/config.md';
const CHAPTER = 'chapters/001-雨夜.md';
const CHAPTER_TEXT = '# 雨夜\n\n他推开门。\n她笑了。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];

const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

async function setStyle(style) {
  posted = [];
  await controller.handle({ type: 'setParagraphStyle', style });
}

/** 工程页的架构那一行（小说配置）与全书下一步，外加对话页主按钮在全书那一档给的。 */
async function bookView() {
  t.project.invalidate();
  const tree = await bundle.projectView.buildProjectTree(t.project);
  const chat = await bundle.chat.bookNextStep({ project: t.project });
  return {
    configFilled: tree.architecture.find((r) => r.key === 'config').filled,
    next: tree.next?.label,
    chat: chat?.label,
    paragraphStyle: tree.paragraphStyle,
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    chat: './src/core/controller/chat.ts',
    controller: './src/core/controller/index.ts',
    workspace: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'paragraph-style', title: '青云剑录' });
  t.write(CHAPTER, CHAPTER_TEXT);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('setParagraphStyle：只改 config.md 的这一个键', () => {
  let before;

  test('新工程的配置模板：只多出 paragraphStyle 这一行，别的字节一个不动', async () => {
    before = t.read(CONFIG);
    await setStyle('indent');
    const after = t.read(CONFIG);
    assert.equal(after.replace(/^paragraphStyle: indent\r?\n/m, ''), before);
    assert.match(after, /^---\r?\n[\s\S]*^paragraphStyle: indent\r?\n---/m, 'frontmatter 里多了这一行');
  });

  test('正文一个字节不动', () => {
    assert.equal(t.read(CHAPTER), CHAPTER_TEXT);
  });

  test('写完推 state，带着新值', () => {
    assert.equal(lastOf('state')?.state.paragraphStyle, 'indent');
  });

  test('工程树也带着新值', async () => {
    posted = [];
    await controller.handle({ type: 'switchTab', tab: 'project' });
    assert.equal(lastOf('project')?.tree.paragraphStyle, 'indent');
  });

  test('再切一次：只换值', async () => {
    await setStyle('both');
    assert.equal(t.read(CONFIG), before.replace(/^(---\r?\n[\s\S]*?)(---)/m, '$1paragraphStyle: both\n$2'));
    assert.equal(lastOf('project')?.tree.paragraphStyle, 'both', '在工程页签上时工程树跟着推');
  });

  test('已经是这个值：不写', async () => {
    const stat = fs.statSync(t.rel(CONFIG)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await setStyle('both');
    assert.equal(fs.statSync(t.rel(CONFIG)).mtimeMs, stat);
  });

  test('认不出的值：忽略，不写', async () => {
    const text = t.read(CONFIG);
    await setStyle('tab');
    assert.equal(t.read(CONFIG), text);
  });

  test('之后重写配置（生成链的落盘）把它带过去', async () => {
    const ws = new bundle.workspace.Workspace(t.project);
    await ws.write(
      CONFIG,
      { artifact: { kind: 'settingDoc', doc: 'config', sections: { 核心梗概: '少年入宗。' }, config: { totalChapters: 40 } } },
      { mode: 'overwrite', review: false }
    );
    const text = t.read(CONFIG);
    assert.match(text, /^paragraphStyle: both$/m);
    assert.match(text, /少年入宗。/);
  });
});

describe('setParagraphStyle：没有 config.md 时', () => {
  let beforeView;

  before(async () => {
    t.remove(CONFIG);
    beforeView = await bookView();
    await setStyle('indent');
  });

  test('新建一份最小的：只有这一段 frontmatter', () => {
    assert.equal(t.read(CONFIG), '---\nparagraphStyle: indent\n---\n');
  });

  test('「小说配置」仍算没填（工程页架构那一行的 ●/○ 不变）', async () => {
    const view = await bookView();
    assert.equal(beforeView.configFilled, false);
    assert.equal(view.configFilled, false);
  });

  test('主按钮不变：工程页与对话页都还是同一步', async () => {
    const view = await bookView();
    assert.equal(view.next, beforeView.next);
    assert.equal(view.chat, beforeView.chat);
    assert.ok(view.next, '全书那一档有下一步');
    assert.notEqual(view.next, '生成故事前提', '没有把配置当成填过而跳到下一件');
  });

  test('工程树带着新值', async () => {
    assert.equal((await bookView()).paragraphStyle, 'indent');
  });
});

describe('setParagraphStyle：还不是小说工程', () => {
  let dir;
  let bare;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-paragraph-bare-'));
    const project = bundle.project.NovelProject.open(dir);
    bare = new bundle.controller.ChatController(project);
    bare.attach({ kind: 'sidebar', post() {}, reveal() {} });
    fakeHost.toasts.length = 0;
    await bare.handle({ type: 'setParagraphStyle', style: 'indent' });
  });

  after(() => {
    bare?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('不写任何文件，说一句为什么', () => {
    assert.equal(fs.existsSync(path.join(dir, '.novelforge')), false);
    assert.ok(fakeHost.toasts.some((m) => /还不是小说工程/.test(m)), fakeHost.toasts.join('\n'));
  });
});
