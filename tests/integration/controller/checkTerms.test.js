/**
 * 内置编辑器「写作体检」的后端一半（`controller/check.ts` + `views/checkTerms.ts`）与敏感词表经网关的读写。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 连上就推一份 `checkTerms`（`init` 之后），哪个页签都推 | 编辑器不必等作者切到别的页 |
 * | 禁用词与写正文时（`planWriting`）用的**一模一样** | 同一个函数、同一份输入：编辑器里标的就是写完数的 |
 * | 内容没变的 `pushState` 不推；`style.md` 改了重推 | 作者每存一次盘就跑一次 `pushState` |
 * | 敏感词表新建 / 修改 / 删除各推一次，坏行带着行号 | 词表变了才推，面板里能说「第 N 行没看懂」 |
 * | 新连上的前端没变也推 | 它手上什么都没有 |
 * | 宿主没有内置编辑器（没有 `openInEditor`）不推 | 插件壳用不上，不为它多读文件 |
 * | 「编辑敏感词表…」：没有就经网关新建模板再打开；有了只打开、不盖掉；还不是小说工程只说一句 | 第 3 条：同名不覆盖 |
 * | `sensitive.txt` 是 `sensitive` 种类、经编辑器保存会留历史版本，不进上下文 | 作者手维护的词表改坏了要找得回来 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const SENSITIVE = '.novelforge/sensitive.txt';

let bundle;
let t;
let fake;
let controller;
let posted = [];
/** 编辑器里打开过的路径（假宿主的 `openInEditor`）。 */
const openedInEditor = [];

const all = (type) => posted.filter((m) => m.type === type);
const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    generate: './src/core/generation/generate.ts',
    checkTerms: './src/core/views/checkTerms.ts',
    kind: './src/core/workspace/kind.ts',
    history: './src/core/workspace/history.ts',
    fileEditing: './src/core/files/fileEditing.ts',
    hash: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fake = makeFakeHost({
    name: 'standalone',
    settings: () => settings,
    overrides: { openInEditor: async (p) => openedInEditor.push(p) },
  });
  bundle.host.initHost(fake.host);
  t = await makeTempProject(bundle.project, { prefix: 'check-terms', title: '青云剑录' });
  t.write(
    '.novelforge/config.md',
    '---\ngenre: 仙侠\nsubGenre: 修真\n---\n# 小说配置\n\n## 全局要求\n\n- 严禁出现「手机」「电脑」，须用「玉简」\n'
  );
  t.write('.novelforge/style.md', '# 文风指南\n\n## 禁用词表\n\n- 不用「不禁」「顿时」\n');
  t.write('.novelforge/summaries/001-雨夜.md', '---\ntargetWords: 3000\n---\n# 第1章 雨夜\n\n## 关键事件\n\n- 出城\n');
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('checkTerms：连上就推，与生成链同一份禁用词', () => {
  before(async () => {
    t.project.invalidate();
    posted = [];
    await controller.handle({ type: 'ready' });
  });

  test('ready 之后推了一份，排在 init 后面', () => {
    const types = posted.map((m) => m.type);
    assert.ok(types.includes('checkTerms'), types.join(','));
    assert.ok(types.indexOf('init') < types.indexOf('checkTerms'), types.join(','));
  });

  test('禁用词：文风禁用词表、全局要求里禁止的那一个分句、古代题材的现代说法', () => {
    const banned = lastOf('checkTerms').terms.banned;
    assert.deepEqual(banned.slice(0, 4), ['不禁', '顿时', '手机', '电脑']);
    assert.ok(banned.includes('能量'), banned.join('、'));
    // 「须用『玉简』」是要用的词，不收。
    assert.equal(banned.includes('玉简'), false);
  });

  test('与写正文时 planWriting 用的一模一样（同一个函数、同一份输入）', async () => {
    const plan = await bundle.generate.planWriting(t.project, {
      target: { kind: 'plot', plotRelPath: '.novelforge/summaries/001-雨夜.md' },
      targetNo: 1,
    });
    assert.deepEqual(lastOf('checkTerms').terms.banned, plan.banned);
    assert.deepEqual(await bundle.checkTerms.readBannedTerms(t.project), plan.banned);
  });

  test('还没有敏感词表：空的、说清不在、路径给出来', () => {
    const terms = lastOf('checkTerms').terms;
    assert.deepEqual(terms.sensitive, []);
    assert.equal(terms.sensitiveExists, false);
    assert.equal(terms.sensitivePath, SENSITIVE);
    assert.deepEqual(terms.sensitiveBad, []);
  });
});

describe('checkTerms：变了才推', () => {
  test('什么都没变的 pushState 不推', async () => {
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 0);
  });

  test('style.md 的禁用词表改了：重推，带着新词', async () => {
    t.write('.novelforge/style.md', '# 文风指南\n\n## 禁用词表\n\n- 不用「不禁」「顿时」「霎时」\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.ok(lastOf('checkTerms').terms.banned.includes('霎时'));
  });

  test('config.md 换成都市题材：现代说法不再算禁用词', async () => {
    t.write('.novelforge/config.md', '---\ngenre: 都市\n---\n# 小说配置\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.equal(lastOf('checkTerms').terms.banned.includes('能量'), false);
  });

  test('敏感词表新建：推一份，词与替换词都在、坏行带着行号与原因', async () => {
    t.write(SENSITIVE, '# 注释\n赌博 => 博戏\nSB\n=> 没词\n');
    posted = [];
    await controller.pushState();
    const terms = lastOf('checkTerms').terms;
    assert.equal(all('checkTerms').length, 1);
    assert.equal(terms.sensitiveExists, true);
    assert.deepEqual(terms.sensitive, [{ term: '赌博', replacement: '博戏' }, { term: 'SB' }]);
    assert.deepEqual(terms.sensitiveBad.map((b) => b.line), [4]);
    assert.match(terms.sensitiveBad[0].reason, /前面没有词/);
  });

  test('敏感词表改了：重推', async () => {
    t.write(SENSITIVE, '赌博 => 博戏\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.deepEqual(lastOf('checkTerms').terms.sensitive, [{ term: '赌博', replacement: '博戏' }]);
    assert.deepEqual(lastOf('checkTerms').terms.sensitiveBad, []);
  });

  test('敏感词表删了：重推，空的、说不在', async () => {
    t.remove(SENSITIVE);
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.deepEqual(lastOf('checkTerms').terms.sensitive, []);
    assert.equal(lastOf('checkTerms').terms.sensitiveExists, false);
  });

  test('新连上的前端：没变也推一份', async () => {
    posted = [];
    await controller.handle({ type: 'ready' });
    assert.equal(all('checkTerms').length, 1);
  });

  test('宿主没有内置编辑器（没有 openInEditor）：不推', async () => {
    const plain = makeFakeHost({ name: 'vscode', settings: () => makeSettings({ contextWindow: 100000 }) });
    bundle.host.initHost(plain.host);
    try {
      t.write('.novelforge/style.md', '# 文风指南\n\n## 禁用词表\n\n- 不用「刹那」\n');
      posted = [];
      await controller.handle({ type: 'ready' });
      await controller.pushState();
      assert.equal(all('checkTerms').length, 0);
    } finally {
      bundle.host.initHost(fake.host);
    }
  });
});

describe('编辑敏感词表…', () => {
  before(() => {
    t.remove(SENSITIVE);
  });

  test('没有：经网关新建一份带说明注释的模板，然后在编辑器里打开它', async () => {
    openedInEditor.length = 0;
    posted = [];
    await controller.handle({ type: 'editSensitiveWords' });
    assert.equal(t.has(SENSITIVE), true);
    const text = t.read(SENSITIVE);
    assert.match(text, /^# 敏感词表/);
    assert.match(text, /=>/);
    assert.deepEqual(openedInEditor, [SENSITIVE]);
  });

  test('新建之后当场推一份词表（文件在了，一个词都还没生效）', () => {
    const terms = lastOf('checkTerms').terms;
    assert.equal(terms.sensitiveExists, true);
    assert.deepEqual(terms.sensitive, []);
  });

  test('已经有了：只打开，一个字都不改', async () => {
    t.write(SENSITIVE, '赌博 => 博戏\n');
    openedInEditor.length = 0;
    await controller.handle({ type: 'editSensitiveWords' });
    assert.equal(t.read(SENSITIVE), '赌博 => 博戏\n');
    assert.deepEqual(openedInEditor, [SENSITIVE]);
  });

  test('还不是小说工程：不建文件、不打开，说一句为什么', async () => {
    const dir = makeTempDir('check-bare');
    const bare = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    const out = [];
    bare.attach({ kind: 'sidebar', post: (m) => out.push(m), reveal() {} });
    openedInEditor.length = 0;
    try {
      await bare.handle({ type: 'editSensitiveWords' });
      assert.equal(dir.has(SENSITIVE), false);
      assert.deepEqual(openedInEditor, []);
      assert.match(out.find((m) => m.type === 'toast')?.message ?? '', /还不是小说工程/);
    } finally {
      bare.dispose();
      cleanup(dir.dir, bundle.db);
    }
  });
});

describe('sensitive.txt 经网关：种类、保存、历史版本', () => {
  test('种类是 sensitive（不是 other）：链外、没有创作阶段', () => {
    const k = bundle.kind.kindOfPath(t.project, SENSITIVE);
    assert.equal(k.kind, 'sensitive');
    assert.equal(k.stage, undefined);
    assert.equal(k.target, undefined);
  });

  test('编辑器保存经网关（乐观锁），旧内容留一版历史', async () => {
    const before = t.read(SENSITIVE);
    const baseHash = bundle.hash.hash(before);
    assert.equal(await bundle.history.historyUnavailable(t.project, SENSITIVE), undefined);
    await bundle.fileEditing.writeFileFromEditor(t.dir, SENSITIVE, '赌博 => 博戏\n杀人\n', baseHash);
    assert.equal(t.read(SENSITIVE), '赌博 => 博戏\n杀人\n');
    const snaps = await bundle.history.listSnapshots(t.project, SENSITIVE);
    assert.equal(snaps.length, 1);
    assert.equal(await bundle.history.readSnapshot(t.project, SENSITIVE, snaps[0].id), before);
  });

  test('磁盘上被别处改过：保存被拒、不覆盖（与别的文件同一套乐观锁）', async () => {
    t.write(SENSITIVE, '别处改的\n');
    await assert.rejects(
      bundle.fileEditing.writeFileFromEditor(t.dir, SENSITIVE, '编辑器里的\n', bundle.hash.hash('赌博 => 博戏\n杀人\n')),
      (err) => err.name === 'FileConflictError'
    );
    assert.equal(t.read(SENSITIVE), '别处改的\n');
  });
});
