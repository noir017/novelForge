/**
 * 编辑区「叙事线总览」的数据（`views/threads.ts` 的 `buildThreadsOverview`，叙事线重做三期），真临时工程：读一遍叙事线目录
 * 与章节、细纲两份列表，交给纯函数 `buildThreadsMatrix`（那一半的细节在 tests/unit/views/threadsOverview.test.js）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 列 | 有细纲或正文的章一章一列：标题（细纲优先，回落标题给空串）、卷目录、四种定稿状态、正文 / 细纲路径；细纲按路径配对 |
 * | 现在 | 「定稿到第 N 章」与工程页「叙事线」页签同一个数 |
 * | 行 | 一条线一个文件读进来，分组与伏笔都在；七期的 `threads.md` 不认 |
 * | 还不是小说工程 | `initialized: false`，其余都是空的 |
 * | 不写盘 | 读完之后工程目录一个字节没变 |
 * | controller | `requestThreadsOverview` 回 `threadsOverview`，带同一个 `requestId` |
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
let t;
let project;

const plot = (no, title, extra = '') => `---\nno: ${no}\ntitle: ${title}\n${extra}---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 关键事件\n事件\n`;

/** 工程目录下全部文件的「路径 → 内容」（看读完之后有没有写盘）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (!/\.(db|sqlite)(-\w+)?$/.test(ent.name)) {
        out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    threads: './src/core/views/threads.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'threads-overview', title: '青云剑录' });
  project = t.project;

  // 第 1 章：根下，定稿过。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelforge/summaries/001-楔子.md', plot(1, '楔子', 'sourceHash: abc\n'));
  // 第 2 章：第一卷里，定稿过；细纲的标题优先。
  t.write('chapters/第一卷/002-入镇.md', '# 入镇\n\n他走进镇子。');
  t.write('.novelforge/summaries/第一卷/002-入镇.md', plot(2, '入镇（改）', 'sourceHash: def\n'));
  // 第 3 章：写了没定稿，没有细纲。
  t.write('chapters/第一卷/003-夜访.txt', '夜里有人敲门。');
  // 第 4 章：只有细纲。
  t.write('.novelforge/summaries/第一卷/004-北行.md', plot(4, '北行'));
  // 第 5 章：正文在外面改了名，旧细纲成了孤儿——不冒认，这一章「写了没定稿」。
  t.write('chapters/第一卷/005-新名.md', '# 新名\n\n正文');
  t.write('.novelforge/summaries/第一卷/005-旧名.md', plot(5, '旧名', 'sourceHash: ghi\n'));

  t.write(
    '.novelforge/threads/林昭与沈青.md',
    [
      '---',
      'kind: 感情线',
      'plan: 1-8',
      '---',
      '',
      '# 林昭与沈青',
      '',
      '## 意图',
      '从互相猜忌到并肩',
      '',
      '## 伏笔',
      '- 玉佩的来历：林昭的玉佩是沈家旧物（计划第 1 章埋、第 6 章前收）',
      '',
      '## 进展',
      '- 第 1 章 · 推进：两人初遇 〔证据：「她的剑停在他喉前三寸」〕',
      '- 第 1 章 · 埋〈玉佩的来历〉：玉佩露面 〔证据：「他摸了摸怀里的玉佩」〕',
      '- 第 2 章 · 计划 · 推进：结盟',
      '- 第 4 章 · 计划 · 收〈玉佩的来历〉：认出云纹',
      '',
    ].join('\n')
  );
  t.write('.novelforge/threads/青崖旧案.md', '---\nkind: 主线\n---\n\n# 青崖旧案\n\n## 进展\n- 第 2 章 · 推进：找到令牌\n');
  t.write('.novelforge/threads/未归属的伏笔.md', '# 未归属的伏笔\n\n## 伏笔\n- 断剑（第 3 章前收）\n');
  // 七期的单文件不认。
  t.write('.novelforge/threads.md', '# 叙事线\n\n## 旧的线\n- 第 1 章 · 推进：不该出现\n');
  // 第 1、2 章定稿时叙事线判过了：水位记在 project.json（四期），偏差只算判过的章。
  await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 2 });
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/threads › buildThreadsOverview', () => {
  test('列：有细纲或正文的章一章一列，标题、卷、定稿状态、两份路径；计划提到的第 6–8 章补 none', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    assert.equal(o.initialized, true);
    assert.deepEqual(
      o.chapters.map((c) => [c.no, c.title, c.volume, c.state]),
      [
        [1, '楔子', '', 'finalized'],
        [2, '入镇（改）', '第一卷', 'finalized'],
        [3, '夜访', '第一卷', 'written'],
        [4, '北行', '第一卷', 'planned'],
        [5, '新名', '第一卷', 'written'],
        [6, '', '第一卷', 'none'],
        [7, '', '第一卷', 'none'],
        [8, '', '第一卷', 'none'],
      ]
    );
    const at = (no) => o.chapters.find((c) => c.no === no);
    assert.equal(at(1).chapterPath, 'chapters/001-楔子.md');
    assert.equal(at(1).plotPath, '.novelforge/summaries/001-楔子.md');
    assert.equal(at(3).plotPath, undefined);
    assert.equal(at(4).chapterPath, undefined);
    assert.equal(at(5).plotPath, undefined, '改了名的正文不冒认旧细纲');
    assert.equal(o.volumes, true);
  });

  test('「现在」与工程页「叙事线」页签同一个数', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.equal(o.current, 2);
    assert.equal(o.current, tree.threads.current);
  });

  test('行：一条线一个文件，按种类分组、伏笔在线下；「未归属的伏笔」在最后；七期的 threads.md 不认', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    assert.deepEqual(o.groups.map((g) => [g.kind, g.lines.map((l) => l.name)]), [
      ['主线', ['青崖旧案']],
      ['感情线', ['林昭与沈青']],
    ]);
    const pair = o.groups[1].lines[0];
    assert.equal(pair.relPath, '.novelforge/threads/林昭与沈青.md');
    // 第 2 章计划结盟、第 2 章定稿了却没发生：偏差。
    assert.equal(pair.cells.find((c) => c.chapter === 2).deviation, true);
    const jade = pair.foreshadowing[0];
    assert.equal(jade.name, '玉佩的来历');
    // 第 4 章计划收、第 4 章没定稿：不是偏差；虚线从第 1 章延到回收章第 6 章。
    assert.equal(jade.cells.find((c) => c.chapter === 4).deviation, false);
    assert.deepEqual(jade.span, { from: 1, to: 6, kind: 'open' });
    assert.deepEqual(o.unfiled.foreshadowing.map((f) => f.name), ['断剑']);
    assert.ok(!JSON.stringify(o).includes('不该出现'));
  });

  test('不写盘：读完之后工程目录一个字节没变', async () => {
    const before = snapshot(t.dir);
    await bundle.threads.buildThreadsOverview(project);
    assert.deepEqual(snapshot(t.dir), before);
  });

  test('还不是小说工程：initialized 为 false，其余都是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-threads-overview-bare-'));
    try {
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.threads.buildThreadsOverview(bare), {
        initialized: false,
        chapters: [],
        current: 0,
        through: 0,
        volumes: false,
        groups: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestThreadsOverview', () => {
  test('回 threadsOverview，带同一个 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestThreadsOverview', requestId: 'tov-1' });
      const reply = posted.find((m) => m.type === 'threadsOverview');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'tov-1');
      assert.equal(reply.overview.initialized, true);
      assert.equal(reply.overview.groups.length, 2);
    } finally {
      controller.dispose();
    }
  });
});
