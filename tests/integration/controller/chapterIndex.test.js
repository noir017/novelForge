/**
 * 内置编辑器的章节索引（`chapterIndex` 消息）的后端一半。
 *
 * 章节条上的字数、状态与上一章 / 下一章的章节顺序从前只靠工程树（`project` 消息），而工程树**只在「工程」页签
 * 开着时才推**——作者大多待在对话页，章节条因此是旧的，从没打开过工程页时干脆没有数据。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 连上就推一份（`init` 之后），哪个页签都推 | 编辑器不必等作者切到工程页 |
 * | 一章一行、按章号升序，字段与工程树那一行一字不差 | 同一个函数算的；章节条与工程页不许说两样 |
 * | 存了正文（`pushState`）就推新的，字数跟着变 | 数据要随时是新的 |
 * | 内容没变的 `pushState` 不推 | 作者每存一次盘就跑一次 `pushState`，绝大多数时候章节没动 |
 * | 新连上的前端（`ready`）照样推，哪怕没变 | 它手上什么都没有 |
 * | 还不是小说工程：空的 | 第 1 条：不崩 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let controller;
let posted = [];
/** 最近一次推出去的那份章节索引（不论这一轮推没推）。 */
let latest = [];

const all = (type) => posted.filter((m) => m.type === type);
const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  bundle.host.initHost(makeFakeHost({ name: 'standalone', settings: () => settings }).host);
  t = await makeTempProject(bundle.project, { prefix: 'chapter-index', title: '青云剑录' });
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推开门。\n');
  t.write('chapters/第一卷/002-入镇.md', '# 入镇\n\n镇上起了雾。\n');
  t.write('.novelforge/summaries/003-北行.md', '---\ntargetWords: 3000\n---\n# 第3章 北行\n\n## 关键事件\n\n- 出城\n');
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'chapterIndex') {
        latest = m.chapters;
      }
    },
    reveal() {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('chapterIndex：连上就推，哪个页签都推', () => {
  before(async () => {
    // 文件是建好工程之后才写的：章节 / 细纲列表的缓存要失效（真实环境里由文件监听触发的 pushState 做）。
    t.project.invalidate();
    posted = [];
    await controller.handle({ type: 'ready' });
  });

  test('ready 之后推了一份，排在 init 后面', () => {
    const types = posted.map((m) => m.type);
    assert.ok(types.includes('chapterIndex'), types.join(','));
    assert.ok(types.indexOf('init') < types.indexOf('chapterIndex'), types.join(','));
  });

  test('在对话页（没开过工程页）：没推工程树，章节索引照样在', () => {
    assert.equal(controller.tab, 'chat');
    assert.equal(all('project').length, 0);
    assert.equal(lastOf('chapterIndex').chapters.length, 3);
  });

  test('一章一行、按章号升序，正文与细纲的路径都在', () => {
    const rows = lastOf('chapterIndex').chapters;
    assert.deepEqual(rows.map((r) => r.no), [1, 2, 3]);
    assert.deepEqual(
      rows.map((r) => [r.chapterPath, r.plotPath, r.plotExists]),
      [
        ['chapters/001-雨夜.md', '.novelforge/summaries/001-雨夜.md', false],
        // 分卷的正文：细纲镜像它的相对路径（第 8 条）。
        ['chapters/第一卷/002-入镇.md', '.novelforge/summaries/第一卷/002-入镇.md', false],
        ['', '.novelforge/summaries/003-北行.md', true],
      ]
    );
  });

  test('只排了细纲的那一章：主路径是细纲、目标字数取细纲的', () => {
    const row = lastOf('chapterIndex').chapters[2];
    assert.equal(row.relPath, '.novelforge/summaries/003-北行.md');
    assert.equal(row.targetWords, 3000);
    assert.equal(row.wordCount, 0);
    assert.equal(row.label, '第 3 章《北行》');
  });

  test('字段与工程树那一行一字不差', async () => {
    t.project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(t.project);
    const keys = ['no', 'label', 'title', 'relPath', 'plotPath', 'plotExists', 'chapterPath', 'wordCount', 'targetWords', 'stage'];
    const pick = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    assert.deepEqual(lastOf('chapterIndex').chapters.map(pick), tree.plots.map(pick));
  });
});

describe('chapterIndex：变了才推', () => {
  test('什么都没变的 pushState：不推', async () => {
    posted = [];
    await controller.pushState();
    assert.ok(lastOf('state'), '连 state 都没推');
    assert.equal(all('chapterIndex').length, 0);
  });

  test('正文多写了几个字：推新的，字数跟着变', async () => {
    const before = latest.find((r) => r.no === 1).wordCount;
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推开门。门外的雨下了一整夜。\n');
    posted = [];
    await controller.pushState();
    const row = lastOf('chapterIndex').chapters.find((r) => r.no === 1);
    assert.ok(row.wordCount > before, `${before} → ${row.wordCount}`);
  });

  test('新写了第 3 章正文：那一行有了正文路径', async () => {
    t.write('chapters/003-北行.md', '# 北行\n\n出了城。\n');
    posted = [];
    await controller.pushState();
    const row = lastOf('chapterIndex').chapters.find((r) => r.no === 3);
    assert.equal(row.chapterPath, 'chapters/003-北行.md');
    assert.equal(row.relPath, 'chapters/003-北行.md');
  });

  test('新连上的前端：没变也推', async () => {
    posted = [];
    await controller.handle({ type: 'ready' });
    assert.equal(all('chapterIndex').length, 1);
  });

  // 编辑器状态栏的「距目标」只认这个字段：它必须与写正文时判「写够没有」的目标是同一个数——
  // 细纲的 targetWords，没写就是 config.md 的每章字数（controller/chat.ts 的 targetWordsOf 同一个式子）。
  test('细纲没写目标字数的章：目标取小说配置的每章字数；细纲写了的照旧取细纲的', async () => {
    t.write('.novelforge/config.md', '---\nwordsPerChapter: 2500\n---\n# 小说配置\n');
    posted = [];
    await controller.pushState();
    const rows = lastOf('chapterIndex').chapters;
    assert.deepEqual(rows.map((r) => [r.no, r.targetWords]), [[1, 2500], [2, 2500], [3, 3000]]);
  });
});

describe('chapterIndex：还不是小说工程', () => {
  let dir;
  let bare;
  const got = [];

  before(async () => {
    dir = makeTempDir('chapter-index-bare');
    bare = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    bare.attach({ kind: 'sidebar', post: (m) => got.push(m), reveal() {} });
    await bare.handle({ type: 'ready' });
  });

  after(() => {
    bare?.dispose();
    if (dir) cleanup(dir.dir, bundle?.db);
  });

  test('推一份空的，不崩', () => {
    const msg = got.find((m) => m.type === 'chapterIndex');
    assert.ok(msg, got.map((m) => m.type).join(','));
    assert.deepEqual(msg.chapters, []);
  });
});
