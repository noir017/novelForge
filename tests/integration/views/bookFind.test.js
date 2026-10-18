/**
 * 全书查找（`src/core/views/bookFind.ts`），真临时工程。一份文件里的口径（护住的字、上下文）在
 * tests/unit/model/bookFind.test.js，替换在 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 按范围 | 只搜勾着的范围；范围按面板顺序、正文 / 细纲 / 草稿按章号；二进制草稿不读 |
 * | 称呼 | 「第 3 章 夜访」「细纲 · 第 1 章 楔子」「草稿 · …」「角色 · 林晚」「设定 · 青云宗」「情节大纲」 |
 * | 每份文件 | hash 与编辑器的乐观锁同一个算法；一共几处；每一处的行、列、上下文 |
 * | 护住的字 | 细纲 frontmatter 里的指纹不搜 |
 * | 预览 | 带 replacement 时每一处带换成什么（正则 `$1` 逐处展开） |
 * | 上限 | 列满就停：多出来的不列、后面的文件不读、说停在哪一份上 |
 * | 叫停 | 叫停了就不往下读、返回 undefined；controller 上叫停的请求不回话（先到的叫停也认） |
 * | 跳过 | 超过 2 MB 的不读、列进 skipped |
 * | 正则写错 | 一份都不读，给 error |
 * | 读盘 | 每份文件读一次（列表借工程上的缓存） |
 * | controller | `bookFind` 回 `bookFindResult`，带同一个 requestId |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plotText = (no, title, extra = '') =>
  `---\nno: ${no}\ntitle: ${title}\nsourceHash: 1a1a1a\ncast: [林晚]\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n林晚${extra}\n\n## 关键事件\n- 事件\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    bookFind: './src/core/views/bookFind.ts',
    workspace: './src/core/workspace/index.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'book-find', title: '青云剑录' });
  project = t.project;

  t.write('chapters/001-楔子.md', '# 楔子\n\n林晚推开门。\n林晚没有说话。\n');
  t.write('chapters/第一卷/002-入镇.md', '# 入镇\n\n镇上没人认得林晚。\n');
  t.write('chapters/第一卷/003-夜访.txt', '夜里，林晚敲了敲门。');
  t.write('chapters/010-远行.md', '# 远行\n\n一个人走了。\n');
  t.write('.novelforge/summaries/001-楔子.md', plotText(1, '楔子'));
  t.write('.novelforge/summaries/第一卷/002-入镇.md', plotText(2, '入镇', '进镇'));
  t.write('drafts/001-楔子.md', '草稿里的林晚');
  t.write('drafts/封面.png', '林晚');
  t.write('.novelforge/characters/林晚.md', '---\nname: 林晚\naliases: [阿晚]\n---\n\n# 林晚\n\n## 身份\n林晚是主角。\n');
  t.write('.novelforge/lore/门派/青云宗.md', '---\ntitle: 青云宗\n---\n\n# 青云宗\n\n林晚拜入的门派。\n');
  t.write('.novelforge/outline.md', '# 情节大纲\n\n## 第1–5章：林晚入宗\n林晚拜入青云宗。\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

const search = (q, opts) => bundle.bookFind.searchBook(project, { query: '林晚', scopes: ['chapter'], ...q }, opts);

describe('views/bookFind › 按范围', () => {
  test('只搜正文：按章号，分卷的、.txt 的都在；没有命中的不列', async () => {
    const r = await search({});
    assert.deepEqual(r.files.map((f) => f.path), ['chapters/001-楔子.md', 'chapters/第一卷/002-入镇.md', 'chapters/第一卷/003-夜访.txt']);
    assert.deepEqual(r.files.map((f) => f.count), [2, 1, 1]);
    assert.equal(r.listed, 4);
    assert.equal(r.scanned, 4);
    assert.equal(r.truncated, undefined);
    assert.deepEqual(r.skipped, []);
  });

  test('称呼与编辑器标签、面包屑同一套', async () => {
    const r = await search({ scopes: ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'] });
    assert.deepEqual(r.files.map((f) => [f.scope, f.label]), [
      ['chapter', '第 1 章 楔子'],
      ['chapter', '第 2 章 入镇'],
      ['chapter', '第 3 章 夜访'],
      ['plot', '细纲 · 第 1 章 楔子'],
      ['plot', '细纲 · 第 2 章 入镇'],
      ['draft', '草稿 · 第 1 章 楔子'],
      ['character', '角色 · 林晚'],
      ['lore', '设定 · 青云宗'],
      ['doc', '情节大纲'],
    ]);
  });

  test('二进制扩展名的草稿不读', async () => {
    const r = await search({ scopes: ['draft'] });
    assert.deepEqual(r.files.map((f) => f.path), ['drafts/001-楔子.md']);
  });

  test('一个范围都没勾：什么都不搜', async () => {
    const r = await search({ scopes: [] });
    assert.deepEqual(r, { files: [], listed: 0, scanned: 0, skipped: [] });
  });
});

describe('views/bookFind › 每份文件', () => {
  test('hash 与编辑器打开它时拿到的一样（替换时的乐观锁基线）', async () => {
    const r = await search({});
    const ws = new bundle.workspace.Workspace(project);
    for (const f of r.files) {
      assert.equal(f.hash, (await ws.read(f.path)).hash, f.path);
    }
  });

  test('每一处：行、列、同一行的上下文', async () => {
    const r = await search({});
    assert.deepEqual(
      r.files[0].hits.map((h) => ({ line: h.line, col: h.col, before: h.before, text: h.text, after: h.after })),
      [
        { line: 3, col: 0, before: '', text: '林晚', after: '推开门。' },
        { line: 4, col: 0, before: '', text: '林晚', after: '没有说话。' },
      ]
    );
  });

  test('细纲 frontmatter 里的指纹不搜，cast 照搜', async () => {
    const digits = await search({ query: '1a', scopes: ['plot'] });
    assert.deepEqual(digits.files, []);
    const cast = await search({ scopes: ['plot'] });
    assert.equal(cast.files[0].count, 2, 'cast 里一处、梗概里一处');
  });

  test('预览：每一处带换成什么，正则 $1 逐处展开', async () => {
    const lit = await search({ replacement: '林婉' });
    assert.ok(lit.files.every((f) => f.hits.every((h) => h.replacement === '林婉')));
    const re = await search({ query: '(林)晚', regex: true, replacement: '$1婉' });
    assert.ok(re.files.every((f) => f.hits.every((h) => h.replacement === '林婉')));
  });
});

describe('views/bookFind › 上限、叫停、跳过、坏正则', () => {
  test('列满就停：这一份多出来的不列，后面的文件不读，说停在哪一份上', async () => {
    const r = await search({}, { limit: 1 });
    assert.equal(r.listed, 1);
    assert.deepEqual(r.files.map((f) => [f.path, f.count, f.hits.length]), [['chapters/001-楔子.md', 2, 1]]);
    assert.deepEqual(r.truncated, { limit: 1, at: '第 1 章 楔子' });
    assert.equal(r.scanned, 1);
  });

  test('正好列满：下一份有命中才说到了上限，停在那一份上（那一份不列）', async () => {
    const r = await search({}, { limit: 2 });
    assert.equal(r.listed, 2);
    assert.deepEqual(r.files.map((f) => f.path), ['chapters/001-楔子.md']);
    assert.deepEqual(r.truncated, { limit: 2, at: '第 2 章 入镇' });
  });

  test('叫停：不往下读，返回 undefined', async () => {
    let asked = 0;
    const r = await search({}, { cancelled: () => ++asked > 1 });
    assert.equal(r, undefined);
  });

  test('超过 2 MB 的不读，列进 skipped', async () => {
    t.write('chapters/020-巨章.md', `林晚${'字'.repeat(1024 * 1024)}`);
    project.invalidate();
    try {
      const r = await search({});
      assert.deepEqual(r.skipped.map((s) => [s.path, s.label]), [['chapters/020-巨章.md', '第 20 章 巨章']]);
      assert.match(r.skipped[0].reason, /2 MB/);
      assert.ok(!r.files.some((f) => f.path === 'chapters/020-巨章.md'));
    } finally {
      t.remove('chapters/020-巨章.md');
      project.invalidate();
    }
  });

  test('正则写错：一份都不读，给 error', async () => {
    const r = await search({ query: '(', regex: true });
    assert.ok(r.error);
    assert.equal(r.scanned, 0);
  });
});

describe('views/bookFind › 读盘', () => {
  test('列表借工程上的缓存：热的时候每份文件读一次', async () => {
    project.invalidate();
    await Promise.all([project.listChapters(), project.listPlots()]);
    const original = fsp.readFile;
    const reads = new Map();
    fsp.readFile = async (...args) => {
      const key = path.relative(t.dir, path.resolve(String(args[0]))).replace(/\\/g, '/');
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return original.apply(fsp, args);
    };
    try {
      await search({ scopes: ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'] });
    } finally {
      fsp.readFile = original;
    }
    assert.deepEqual([...reads].filter(([, n]) => n > 1), []);
    assert.equal(reads.get('chapters/010-远行.md'), 1, '没有命中的也读了一次');
    assert.equal(reads.has('drafts/封面.png'), false);
  });
});

describe('controller › bookFind', () => {
  function attach() {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    return { controller, posted };
  }

  test('回 bookFindResult，带同一个 requestId', async () => {
    const { controller, posted } = attach();
    try {
      await controller.handle({ type: 'bookFind', requestId: 'bf-1', query: { query: '林晚', scopes: ['chapter'] } });
      const reply = posted.find((m) => m.type === 'bookFindResult');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'bf-1');
      assert.equal(reply.result.listed, 4);
    } finally {
      controller.dispose();
    }
  });

  test('叫停的请求不回话：搜到一半叫停的，与叫停先到的', async () => {
    const { controller, posted } = attach();
    try {
      const running = controller.handle({ type: 'bookFind', requestId: 'bf-2', query: { query: '林晚', scopes: ['chapter', 'plot'] } });
      await controller.handle({ type: 'cancelBookFind', requestId: 'bf-2' });
      await running;
      await controller.handle({ type: 'cancelBookFind', requestId: 'bf-3' });
      await controller.handle({ type: 'bookFind', requestId: 'bf-3', query: { query: '林晚', scopes: ['chapter'] } });
      assert.deepEqual(posted.filter((m) => m.type === 'bookFindResult'), []);
    } finally {
      controller.dispose();
    }
  });
});
