/**
 * 全书替换（`src/core/features/bookReplace.ts`），真临时工程：预览（`views/bookFind.ts` 的 `searchBook`）→ 照预览拼请求 →
 * 替换 → 看磁盘、历史版本、指纹链、派生数据。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 经网关写 | 勾着的那几处换了、勾掉的没换；不按预览的那几处（文件里对不上）整份不写 |
 * | 历史版本 | 每个改过的文件都在「历史」里留着替换前那一版——**不受节流**（十分钟内的小改动照样存） |
 * | 乐观锁 | 预览之后磁盘上改过的跳过，磁盘上那份一个字不动（不拿旧的盖新的） |
 * | 未保存 | 编辑器里有未保存修改的那几份跳过 |
 * | 范围 | 不在勾着的范围里的路径、内部文件不写 |
 * | 还不是小说工程 | 存不了历史版本，不换 |
 * | 第 18 条 | 细纲与正文都改了、原本对得上的：`writtenFrom` / `sourceHash` 刷成替换后的（不挂 ⟳、不退回待定稿）；只改细纲：正文挂 ⟳；只改正文：回到待定稿；改之前就对不上的不刷；细纲的 `upstreamHash` 退回替换前的判断（挂着的照挂、没记过的照旧不记）；大纲与细纲一起改的对得上、大纲改了细纲没改的挂 ⟳ |
 * | 角色卡改名 | 汇总里提文件名没跟着改；机器记的 `appearsIn` 不动 |
 * | 派生数据 | 替换角色卡、细纲之后出场索引照新的名字认人 |
 * | controller | `bookReplace` 回 `bookReplaceDone` 之后推 `state`；同一时刻只有一次替换 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
const made = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsm: './src/core/model/fs.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    bookFind: './src/core/views/bookFind.ts',
    bookReplace: './src/core/features/bookReplace.ts',
    history: './src/core/workspace/history.ts',
    workspace: './src/core/workspace/index.ts',
    pipe: './src/core/views/pipeline.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
});

after(() => {
  for (const t of made) cleanup(t.dir, bundle.db);
});

const OUTLINE = '# 情节大纲\n\n## 第1–6章：林晚入宗\n林晚拜入青云宗。\n';

/**
 * 一份细纲：`fresh` 时 `writtenFrom` 记的就是这份的内容指纹；`body` 给了就定稿过（`sourceHash` = 正文指纹）。
 * `upstream`：`'fresh'` 记大纲里覆盖它的那一节，`'none'` 不记，其余原样写进去（对不上的旧指纹）。
 */
function plotFile(no, title, sections, { upstream = 'fresh', written = 'fresh', body, cast } = {}) {
  const { renderPlotFile, parsePlotFile, plotContentHash, emptyPlotSections } = bundle.plotFile;
  const plot = {
    no,
    title,
    upstreamHash: upstream === 'fresh' ? bundle.outlineFile.outlineUpstreamHash(OUTLINE, no) : upstream === 'none' ? '' : upstream,
    done: false,
    sections: { ...emptyPlotSections(), ...sections },
    sourceHash: body !== undefined ? bundle.fsm.hash(body.trim()) : undefined,
    cast: body !== undefined ? cast ?? [] : undefined,
  };
  const rel = `.novelforge/summaries/${String(no).padStart(3, '0')}-${title}.md`;
  const writtenFrom = written === 'fresh' ? plotContentHash(parsePlotFile(renderPlotFile(plot), rel)) : written === 'none' ? '' : written;
  return renderPlotFile({ ...plot, writtenFrom });
}

/**
 * 六章：
 *
 * | 章 | 正文 | 细纲 | 用来测 |
 * |---|---|---|---|
 * | 1 入宗 | 有「林晚」 | 有「林晚」，定稿过、指纹全对得上 | 两头都改了 → 刷新 |
 * | 2 下山 | 有「林晚」 | 有「林晚」，定稿过 | 正文未保存被跳过 → 只改了细纲 |
 * | 3 夜访 | 有「林晚」 | 没有「林晚」，定稿过 | 只改了正文 → 待定稿 |
 * | 4 北行 | — | 有「林晚」，大纲那一节早就改过（⟳） | ⟳ 照挂 |
 * | 5 远行 | — | 有「林晚」，手写的、没记过大纲指纹 | 照旧不记 |
 * | 6 归来 | 有「林晚」 | 有「林晚」，正文写完之后细纲又改过（⟳），没定稿 | 改之前就对不上的不刷 |
 */
async function setup(prefix) {
  const t = await makeTempProject(bundle.project, { prefix: `book-replace-${prefix}`, title: '青云剑录' });
  made.push(t);
  const bodies = {
    1: '# 入宗\n\n林晚推开山门。\n',
    2: '# 下山\n\n林晚下山去了。\n',
    3: '# 夜访\n\n夜里林晚来过。\n',
    6: '# 归来\n\n林晚回来了。\n',
  };
  t.write('.novelforge/outline.md', OUTLINE);
  t.write('chapters/001-入宗.md', bodies[1]);
  t.write('.novelforge/summaries/001-入宗.md', plotFile(1, '入宗', { 梗概: '林晚入宗', 出场人物: '林晚', 关键事件: '- 林晚推开山门' }, { body: bodies[1], cast: [{ name: '林晚', aliases: ['阿晚'] }] }));
  t.write('chapters/002-下山.md', bodies[2]);
  t.write('.novelforge/summaries/002-下山.md', plotFile(2, '下山', { 梗概: '林晚下山', 关键事件: '- 下山' }, { body: bodies[2], cast: [{ name: '林晚', aliases: [] }] }));
  t.write('chapters/003-夜访.md', bodies[3]);
  t.write('.novelforge/summaries/003-夜访.md', plotFile(3, '夜访', { 梗概: '有人夜访', 关键事件: '- 夜访' }, { body: bodies[3] }));
  t.write('.novelforge/summaries/004-北行.md', plotFile(4, '北行', { 梗概: '林晚北行', 关键事件: '- 北行' }, { upstream: 'deadbeef', written: 'none' }));
  t.write('.novelforge/summaries/005-远行.md', '---\nno: 5\ntitle: 远行\n---\n\n# 第5章 远行\n\n## 梗概\n林晚远行\n\n## 关键事件\n- 出发\n');
  t.write('chapters/006-归来.md', bodies[6]);
  t.write('.novelforge/summaries/006-归来.md', plotFile(6, '归来', { 梗概: '林晚归来', 关键事件: '- 归来' }, { written: 'old-plot-hash' }));
  t.write(
    '.novelforge/characters/林晚.md',
    '---\nname: 林晚\naliases: [阿晚]\nappearsIn: [1]\n---\n\n# 林晚\n\n## 身份\n林晚是主角。\n'
  );
  t.project.invalidate();
  return t;
}

/** 预览一次，照预览拼替换请求（缺省全勾）。`pick(file, hit)` 返回 false 的那几处勾掉。 */
async function previewAndRequest(t, q, opts = {}) {
  const query = { query: '林晚', replacement: '林婉', ...q };
  const preview = await bundle.bookFind.searchBook(t.project, query);
  const files = preview.files
    .map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.filter((h) => (opts.pick ? opts.pick(f, h) : true)).map((h) => ({ start: h.start, end: h.end })) }))
    .filter((f) => f.hits.length > 0);
  return { preview, request: { ...query, files, dirty: opts.dirty ?? [] } };
}

const replace = (t, request) => bundle.bookReplace.replaceInBook(t.project, request);

/** 流水线索引里第 no 章那一行。 */
async function row(t, no) {
  t.project.invalidate();
  return (await bundle.pipe.buildPipelineIndex(t.project)).byNo.get(no);
}

describe('features/bookReplace › 经网关写、历史版本', () => {
  let t;
  let summary;
  const originals = {};
  let beforeReplace;

  before(async () => {
    t = await setup('write');
    for (const rel of ['chapters/001-入宗.md', 'chapters/003-夜访.md', '.novelforge/summaries/001-入宗.md']) {
      originals[rel] = t.read(rel);
    }
    // 先经网关存一次小改动：第一版进了历史，最新快照不到十分钟——按节流，再来一次小改动不会存。
    const ws = new bundle.workspace.Workspace(t.project);
    await ws.write('chapters/001-入宗.md', { text: '# 入宗\n\n林晚推开山门。山风很冷。\n' }, { mode: 'overwrite', review: false });
    beforeReplace = t.read('chapters/001-入宗.md');
    const { request } = await previewAndRequest(t, { scopes: ['chapter', 'plot'] }, {
      // 第 6 章正文里那一处勾掉。
      pick: (f) => f.path !== 'chapters/006-归来.md',
    });
    summary = await replace(t, request);
  });

  test('勾着的换了，勾掉的没换', () => {
    assert.match(t.read('chapters/001-入宗.md'), /林婉推开山门/);
    assert.match(t.read('chapters/003-夜访.md'), /夜里林婉来过/);
    assert.match(t.read('chapters/006-归来.md'), /林晚回来了/);
    assert.match(t.read('.novelforge/summaries/006-归来.md'), /林婉归来/);
  });

  test('汇总：几个文件几处', () => {
    assert.equal(summary.error, undefined);
    assert.deepEqual(summary.skipped, []);
    assert.equal(summary.files, summary.replaced.length);
    assert.equal(summary.hits, summary.replaced.reduce((n, r) => n + r.count, 0));
    assert.ok(summary.replaced.some((r) => r.path === 'chapters/001-入宗.md' && r.label === '第 1 章 入宗' && r.count === 1));
    assert.ok(!summary.replaced.some((r) => r.path === 'chapters/006-归来.md'));
  });

  test('每个改过的文件都在「历史」里留着替换前那一版——十分钟内的小改动也存（不受节流）', async () => {
    for (const r of summary.replaced) {
      const snaps = await bundle.history.listSnapshots(t.project, r.path);
      assert.ok(snaps.length > 0, `${r.path} 没有历史版本`);
      const newest = await bundle.history.readSnapshot(t.project, r.path, snaps[0].id);
      const expected = r.path === 'chapters/001-入宗.md' ? beforeReplace : originals[r.path];
      if (expected !== undefined) {
        assert.equal(newest, expected, r.path);
      }
    }
  });

  test('frontmatter 里机器记的账一个字没动', () => {
    const plot = bundle.plotFile.parsePlotFile(t.read('.novelforge/summaries/004-北行.md'), '.novelforge/summaries/004-北行.md');
    assert.equal(plot.upstreamHash, 'deadbeef');
    assert.equal(plot.no, 4);
  });
});

describe('features/bookReplace › 乐观锁、未保存、范围、还不是小说工程', () => {
  test('预览之后磁盘上改过的跳过，磁盘上那份一个字不动', async () => {
    const t = await setup('conflict');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚在别处改过了。\n');
    const summary = await replace(t, request);
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason, s.label]), [['chapters/001-入宗.md', 'changed', '第 1 章 入宗']]);
    assert.match(summary.skipped[0].message, /重新预览/);
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林晚在别处改过了。\n');
    assert.match(t.read('chapters/003-夜访.md'), /林婉/);
  });

  test('编辑器里有未保存修改的跳过（让作者先保存或放弃）', async () => {
    const t = await setup('dirty');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] }, { dirty: ['chapters/002-下山.md'] });
    const summary = await replace(t, request);
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason]), [['chapters/002-下山.md', 'dirty']]);
    assert.match(summary.skipped[0].message, /未保存/);
    assert.match(t.read('chapters/002-下山.md'), /林晚下山/);
  });

  test('不在勾着的范围里的、内部文件：不写', async () => {
    const t = await setup('scope');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    const plotRel = '.novelforge/summaries/001-入宗.md';
    const plotBefore = t.read(plotRel);
    const projectJson = t.read('.novelforge/project.json');
    const extra = [
      { path: plotRel, hash: bundle.fsm.hash(plotBefore), hits: [{ start: plotBefore.indexOf('林晚'), end: plotBefore.indexOf('林晚') + 2 }] },
      { path: '.novelforge/project.json', hash: bundle.fsm.hash(projectJson), hits: [{ start: 0, end: 1 }] },
    ];
    const summary = await replace(t, { ...request, files: [...request.files, ...extra] });
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason]), [[plotRel, 'outOfScope'], ['.novelforge/project.json', 'outOfScope']]);
    assert.equal(t.read(plotRel), plotBefore);
    // project.json 会因为正文换了而重算一次章节清单（manifest），但第一个字没被当成「一处」换掉。
    assert.doesNotThrow(() => JSON.parse(t.read('.novelforge/project.json')));
    assert.equal(t.read('.novelforge/project.json')[0], projectJson[0]);
  });

  test('勾着的那几处对不上（不是一处匹配）：整份不写', async () => {
    const t = await setup('mismatch');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    const first = request.files[0];
    const summary = await replace(t, { ...request, files: [{ ...first, hits: [{ start: 0, end: 2 }] }] });
    assert.deepEqual(summary.skipped.map((s) => s.reason), ['mismatch']);
    assert.match(t.read(first.path), /林晚/);
  });

  test('还不是小说工程（没有 .novelforge/）：存不了历史版本，不换', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-book-replace-bare-'));
    try {
      fs.mkdirSync(path.join(dir, 'chapters'));
      fs.writeFileSync(path.join(dir, 'chapters', '001-楔子.md'), '林晚推门。');
      const bare = bundle.project.NovelProject.open(dir);
      const preview = await bundle.bookFind.searchBook(bare, { query: '林晚', scopes: ['chapter'], replacement: '林婉' });
      assert.equal(preview.listed, 1, '没初始化也搜得到');
      const f = preview.files[0];
      const summary = await bundle.bookReplace.replaceInBook(bare, {
        query: '林晚', replacement: '林婉', scopes: ['chapter'], dirty: [],
        files: [{ path: f.path, hash: f.hash, hits: f.hits.map((h) => ({ start: h.start, end: h.end })) }],
      });
      assert.deepEqual(summary.skipped.map((s) => s.reason), ['noHistory']);
      assert.match(summary.skipped[0].message, /历史版本/);
      assert.equal(fs.readFileSync(path.join(dir, 'chapters', '001-楔子.md'), 'utf8'), '林晚推门。');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('查找串为空、正则写错：整个不做', async () => {
    const t = await setup('bad');
    assert.match((await replace(t, { query: '', replacement: 'x', scopes: ['chapter'], files: [], dirty: [] })).error, /空/);
    assert.match((await replace(t, { query: '(', regex: true, replacement: 'x', scopes: ['chapter'], files: [], dirty: [] })).error, /正则/);
  });
});

describe('features/bookReplace › 第 18 条：指纹链', () => {
  let t;
  let summary;
  const before18 = {};

  before(async () => {
    t = await setup('chain');
    for (const no of [1, 2, 3, 4, 6]) {
      before18[no] = await row(t, no);
    }
    // 正文与细纲一起换，第 2 章正文未保存（被跳过）。
    const { request } = await previewAndRequest(t, { scopes: ['chapter', 'plot'] }, { dirty: ['chapters/002-下山.md'] });
    summary = await replace(t, request);
  });

  test('替换之前：1、2、3 章写完且定稿过、对得上；4 章细纲挂 ⟳；6 章正文挂 ⟳', () => {
    assert.equal(before18[1].chapter.upstreamStale, false);
    assert.equal(before18[1].summary.stale, false);
    assert.equal(before18[2].chapter.upstreamStale, false);
    assert.equal(before18[3].summary.stale, false);
    assert.equal(before18[4].plot.upstreamStale, true);
    assert.equal(before18[6].chapter.upstreamStale, true);
  });

  test('细纲与正文都改了、原本对得上：writtenFrom / sourceHash 刷成替换后的，不挂 ⟳、不退回待定稿', async () => {
    const r = await row(t, 1);
    assert.equal(r.chapter.upstreamStale, false);
    assert.equal(r.summary.stale, false);
    assert.equal(r.plot.upstreamStale, false);
    assert.deepEqual(summary.chainKept, ['第 1 章 入宗']);
    // 定稿那份细纲里的出场（cast）也跟着换了名字。
    assert.match(t.read('.novelforge/summaries/001-入宗.md'), /cast: \[林婉\(阿晚\)\]/);
  });

  test('只改了细纲（正文未保存被跳过）：正文挂 ⟳，汇总里说出来', async () => {
    const r = await row(t, 2);
    assert.equal(r.chapter.upstreamStale, true);
    assert.deepEqual(summary.plotOnly, ['第 2 章 下山']);
  });

  test('只改了正文（细纲里没有这个名字）：定稿过的回到待定稿，汇总里说出来', async () => {
    const r = await row(t, 3);
    assert.equal(r.summary.stale, true);
    assert.equal(r.chapter.upstreamStale, false);
    assert.deepEqual(summary.bodyOnly, ['第 3 章 夜访']);
  });

  test('改之前就对不上的不刷：第 6 章正文照挂 ⟳', async () => {
    assert.equal((await row(t, 6)).chapter.upstreamStale, true);
    assert.ok(!summary.chainKept.includes('第 6 章 归来'));
  });

  test('细纲的上游：挂着 ⟳ 的照挂（旧指纹原样留着），没记过的照旧不记', async () => {
    const r4 = await row(t, 4);
    assert.equal(r4.plot.upstreamStale, true);
    assert.match(t.read('.novelforge/summaries/004-北行.md'), /upstreamHash: deadbeef/);
    assert.match(t.read('.novelforge/summaries/004-北行.md'), /林婉北行/);
    const p5 = t.read('.novelforge/summaries/005-远行.md');
    assert.match(p5, /林婉远行/);
    assert.doesNotMatch(p5, /upstreamHash/);
  });
});

describe('features/bookReplace › 第 18 条：大纲与细纲', () => {
  test('大纲与细纲一起改的对得上；大纲改了、细纲没跟着改的挂 ⟳，汇总里说出来', async () => {
    const t = await setup('outline');
    const { request } = await previewAndRequest(t, { scopes: ['doc', 'plot', 'chapter'] });
    const summary = await replace(t, request);
    assert.match(t.read('.novelforge/outline.md'), /## 第1–6章：林婉入宗/);
    assert.equal((await row(t, 1)).plot.upstreamStale, false);
    assert.equal((await row(t, 2)).plot.upstreamStale, false);
    // 第 3 章的细纲里没有这个名字：大纲那一节变了，它没跟着改。
    assert.equal((await row(t, 3)).plot.upstreamStale, true);
    assert.deepEqual(summary.outlineOnly, ['细纲 · 第 3 章 夜访']);
  });
});

describe('features/bookReplace › 角色卡改名与派生数据', () => {
  let t;
  const cardRel = '.novelforge/characters/林晚.md';
  const tree = async () => {
    t.project.invalidate();
    return bundle.projectView.buildProjectTree(t.project);
  };

  before(async () => {
    t = await setup('cast');
  });

  test('替换之前：卡叫林晚，第 1、2 章的定稿里认得出她', async () => {
    const tr = await tree();
    assert.deepEqual(tr.castByCard[cardRel].plots, [1, 2]);
  });

  test('只换角色卡：汇总里提文件名没跟着改；机器记的 appearsIn 不动；定稿里只写了旧名字的那一章暂时认不出她', async () => {
    const { request } = await previewAndRequest(t, { scopes: ['character'] });
    const summary = await replace(t, request);
    assert.deepEqual(summary.renamedCards, [{ path: cardRel, label: '角色 · 林晚', name: '林婉', nameChanged: true }]);
    assert.ok(t.has(cardRel), '文件名没改');
    assert.match(t.read(cardRel), /appearsIn: \[1\]/);
    const tr = await tree();
    // 第 1 章的定稿记着别名「阿晚」，照样认得出；第 2 章只写了「林晚」，成了没建卡的出场人物。
    assert.deepEqual(tr.castByCard[cardRel].plots, [1]);
    assert.ok(tr.cast.some((c) => c.name === '林晚' && c.plots.includes(2)), JSON.stringify(tr.cast));
  });

  test('再把细纲也换了：出场索引照新的名字认回来（派生数据从磁盘现算）', async () => {
    const { request } = await previewAndRequest(t, { scopes: ['plot'] });
    await replace(t, request);
    const tr = await tree();
    assert.deepEqual(tr.castByCard[cardRel].plots, [1, 2]);
    assert.ok(!tr.cast.some((c) => c.name === '林晚'));
  });

  test('只换了别名：也提一句，nameChanged 是 false', async () => {
    const t2 = await setup('alias');
    const { request } = await previewAndRequest(t2, { query: '阿晚', replacement: '婉儿', scopes: ['character'] });
    const summary = await replace(t2, request);
    assert.deepEqual(summary.renamedCards.map((c) => [c.name, c.nameChanged]), [['林晚', false]]);
  });
});

describe('controller › bookReplace', () => {
  test('回 bookReplaceDone，之后推 state；同一时刻只有一次替换', async () => {
    const t = await setup('controller');
    const posted = [];
    const controller = new bundle.controller.ChatController(t.project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
      const first = controller.handle({ type: 'bookReplace', requestId: 'br-1', request });
      const second = controller.handle({ type: 'bookReplace', requestId: 'br-2', request });
      await Promise.all([first, second]);
      const done = posted.filter((m) => m.type === 'bookReplaceDone');
      const one = done.find((m) => m.requestId === 'br-1');
      const two = done.find((m) => m.requestId === 'br-2');
      assert.ok(one && two, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(one.summary.error, undefined);
      assert.ok(one.summary.files > 0);
      assert.match(two.summary.error, /还没换完/);
      const doneAt = posted.indexOf(one);
      assert.ok(posted.slice(doneAt + 1).some((m) => m.type === 'state'), '替换完没推 state');
    } finally {
      controller.dispose();
    }
  });
});
