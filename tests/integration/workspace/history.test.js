/**
 * 历史版本的落盘一半（`src/core/workspace/history.ts` + 网关里那几处调用）：真临时工程。
 *
 * 守的是「凡是走网关覆盖一份创作产物，旧内容都先留一版」，以及几条不能出错的边：新建不存、相同不存、
 * 节流、大改总存、只留 50 个、存不下也照常写盘、`.gitignore` 只放一次、`other` 与还不是工程的目录不存、
 * 不进检索、监听挡掉、类文件操作删不掉这个目录。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
const dirs = [];

const MIN = 60_000;
const BIG = '正文'.repeat(600);

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    kind: './src/core/workspace/kind.ts',
    guard: './src/core/workspace/guard.ts',
    history: './src/core/workspace/history.ts',
    ws: './src/core/workspace/index.ts',
    fileEditing: './src/core/files/fileEditing.ts',
    fileOps: './src/core/files/fileOps.ts',
    logger: './src/core/runtime/logger.ts',
    watch: './src/core/watchPolicy.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  return { t, ws: new bundle.ws.Workspace(t.project) };
}

/** 这份文件的快照文件名，新的在前。 */
function snaps(t, rel) {
  const dir = t.rel('.novelforge/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

function snapText(t, rel, name) {
  return fs.readFileSync(t.rel('.novelforge/history', rel, name), 'utf8');
}

/** 把这份文件的快照整体往前挪 `minutes` 分钟（改文件名里的时间），模拟「最新快照已经是一阵子之前的了」。 */
function age(t, rel, minutes) {
  const dir = t.rel('.novelforge/history', rel);
  for (const name of fs.readdirSync(dir)) {
    const at = bundle.history.parseSnapshotFileName(name);
    if (at) {
      fs.renameSync(path.join(dir, name), path.join(dir, bundle.history.snapshotFileName(new Date(at.time - minutes * MIN), at.dup)));
    }
  }
}

const overwrite = (ws, rel, text) => ws.write(rel, { text }, { mode: 'overwrite', review: false });

describe('网关覆盖一份创作产物之前存旧版', () => {
  let t;
  let ws;
  const rel = 'chapters/001-雪夜.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-basic'));
    await ws.write(rel, { text: `# 雪夜\n\n${BIG}` }, { mode: 'create' });
  });

  test('新建不存（没有被覆盖的东西）', () => {
    assert.equal(fs.existsSync(t.rel('.novelforge/history')), false);
  });

  test('覆盖：存下磁盘上的旧内容，新内容照常落盘', async () => {
    await overwrite(ws, rel, '# 雪夜\n\n全换了。');
    const names = snaps(t, rel);
    assert.equal(names.length, 1);
    assert.equal(snapText(t, rel, names[0]), `# 雪夜\n\n${BIG}`);
    assert.equal(t.read(rel), '# 雪夜\n\n全换了。');
  });

  test('快照目录镜像原文件的路径，快照名是时间 + .txt', () => {
    assert.match(snaps(t, rel)[0], /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}[+-]\d{4}\.txt$/);
  });

  test('第一次存时放一个 .gitignore（内容 *）', () => {
    assert.equal(t.read('.novelforge/history/.gitignore'), '*\n');
  });

  test('写一样的内容不存', async () => {
    await overwrite(ws, rel, '# 雪夜\n\n全换了。');
    assert.equal(snaps(t, rel).length, 1);
  });

  test('列得出来（新的在前，带字数与字节数）、读得回全文', async () => {
    const list = await bundle.history.listSnapshots(t.project, rel);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, snaps(t, rel)[0]);
    assert.equal(list[0].words, 1202);
    assert.equal(list[0].bytes, Buffer.byteLength(`# 雪夜\n\n${BIG}`));
    assert.equal(await bundle.history.readSnapshot(t.project, rel, list[0].id), `# 雪夜\n\n${BIG}`);
  });

  test('读快照只认快照文件名：../ 与认不出的名字给 notFound', async () => {
    for (const id of ['../../config.md', '.gitignore', '2026-10-18_14-32-05+0800.txt']) {
      await assert.rejects(bundle.history.readSnapshot(t.project, rel, id), (e) => e.code === 'notFound', id);
    }
  });
});

describe('节流：10 分钟内的零星小改并成一版，大改总存', () => {
  let t;
  let ws;
  const rel = 'chapters/002-风起.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-throttle'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    await overwrite(ws, rel, `${BIG}一`);
  });

  test('起点：一版', () => {
    assert.equal(snaps(t, rel).length, 1);
  });

  test('自动保存那样连着存几次小改：不再多存', async () => {
    for (const tail of ['一二', '一二三', '一二三四', '一二三四五']) {
      await overwrite(ws, rel, `${BIG}${tail}`);
    }
    assert.equal(snaps(t, rel).length, 1);
  });

  test('最新一版超过 10 分钟之后，小改也存', async () => {
    age(t, rel, 11);
    await overwrite(ws, rel, `${BIG}一二三四五六`);
    const names = snaps(t, rel);
    assert.equal(names.length, 2);
    assert.equal(snapText(t, rel, names[0]), `${BIG}一二三四五`);
  });

  test('不到 10 分钟的大改（整章重写）：存，存的是重写之前那一份', async () => {
    await overwrite(ws, rel, '重写'.repeat(500));
    const names = snaps(t, rel);
    assert.equal(names.length, 3);
    assert.equal(snapText(t, rel, names[0]), `${BIG}一二三四五六`);
  });

  test('追加（接着写）也算覆盖：追加得多就存', async () => {
    await ws.write(rel, { text: '续'.repeat(400) }, { mode: 'append' });
    const names = snaps(t, rel);
    assert.equal(names.length, 4);
    assert.equal(snapText(t, rel, names[0]), '重写'.repeat(500));
  });
});

describe('每份文件最多留 50 个，多的删掉最旧的', () => {
  let t;
  const rel = 'chapters/003-远行.md';

  before(async () => {
    let ws;
    ({ t, ws } = await fresh('hist-keep'));
    await ws.write(rel, { text: '起点' }, { mode: 'create' });
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 55; i++) {
      t.write(rel, `第 ${i} 版`);
      await bundle.history.snapshotBeforeWrite(t.project, rel, undefined, { force: true, now: base + i * 1000 });
    }
  });

  test('只剩 50 个', () => {
    assert.equal(snaps(t, rel).length, 50);
  });

  test('删掉的是最旧的 5 个，最新的那个在', () => {
    const names = snaps(t, rel);
    assert.equal(snapText(t, rel, names[0]), '第 54 版');
    assert.equal(snapText(t, rel, names[names.length - 1]), '第 5 版');
  });

  test('.gitignore 不算在 50 个里，也不被裁掉', () => {
    assert.equal(t.read('.novelforge/history/.gitignore'), '*\n');
  });
});

describe('存快照失败绝不挡住保存', () => {
  let t;
  let ws;
  let result;
  const rel = 'chapters/004-残灯.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-fail'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    // 历史根被一个同名文件占了：mkdir 必然失败。
    t.write('.novelforge/history', '不是目录');
    bundle.logger.clearLogs();
    result = await overwrite(ws, rel, '照样写进去了。');
  });

  test('照常写盘', () => {
    assert.equal(t.read(rel), '照样写进去了。');
    assert.equal(result.skipped, undefined);
  });

  test('记一条 warn，说清照常写盘了', () => {
    const warn = bundle.logger.recentLogs().find((e) => e.level === 'warn' && e.message.includes('历史版本'));
    assert.ok(warn, JSON.stringify(bundle.logger.recentLogs().map((e) => e.message)));
    assert.ok(warn.message.includes(rel) && warn.message.includes('照常写盘'), warn.message);
  });

  test('占位的那个文件原样没动', () => {
    assert.equal(t.read('.novelforge/history'), '不是目录');
  });
});

describe('.gitignore 只在建出历史目录那一次放', () => {
  let t;
  const rel = 'chapters/005-夜雨.md';

  before(async () => {
    let ws;
    ({ t, ws } = await fresh('hist-gitignore'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    await overwrite(ws, rel, '第二版');
    fs.rmSync(t.rel('.novelforge/history/.gitignore'));
    await overwrite(ws, rel, BIG + BIG);
  });

  test('作者删掉之后不再补回来（他想让 Git 收这些快照）', () => {
    assert.equal(snaps(t, rel).length, 2);
    assert.equal(fs.existsSync(t.rel('.novelforge/history/.gitignore')), false);
  });
});

describe('范围：只管创作产物', () => {
  let t;
  let ws;

  before(async () => {
    ({ t, ws } = await fresh('hist-scope'));
  });

  test('other（工程根的随手记）不存', async () => {
    await ws.write('随手记.md', { text: '一' }, { mode: 'create' });
    await overwrite(ws, '随手记.md', '二');
    assert.equal(fs.existsSync(t.rel('.novelforge/history')), false);
  });

  test('不存的文件，historyUnavailable 说得出为什么', async () => {
    assert.match(await bundle.history.historyUnavailable(t.project, '随手记.md'), /不是工程里的创作产物/);
    assert.equal(await bundle.history.historyUnavailable(t.project, 'chapters/001.md'), undefined);
  });

  test('细纲、角色卡、设定、大纲、草稿都存（各在自己的镜像目录里）', async () => {
    const files = [
      '.novelforge/summaries/001-雪夜.md',
      '.novelforge/characters/林昭.md',
      '.novelforge/lore/青云宗.md',
      '.novelforge/outline.md',
      'drafts/001-雪夜.md',
    ];
    for (const rel of files) {
      t.write(rel, `${rel} 的旧内容`);
      await overwrite(ws, rel, `${rel} 的新内容`);
      assert.equal(snaps(t, rel).length, 1, rel);
      assert.equal(snapText(t, rel, snaps(t, rel)[0]), `${rel} 的旧内容`, rel);
    }
  });

  test('还不是小说工程（没有 .novelforge/）的目录里不存，也不替作者建出历史目录', async () => {
    const d = makeTempDir('hist-noproject');
    dirs.push(d.dir);
    const project = bundle.project.NovelProject.open(d.dir);
    const plain = new bundle.ws.Workspace(project);
    d.write('chapters/001-雪夜.md', '旧的');
    assert.match(await bundle.history.historyUnavailable(project, 'chapters/001-雪夜.md'), /还不是小说工程/);
    await overwrite(plain, 'chapters/001-雪夜.md', '新的');
    assert.equal(d.read('chapters/001-雪夜.md'), '新的');
    assert.equal(fs.existsSync(d.rel('.novelforge/history')), false);
  });
});

describe('各条覆盖路径都存：编辑器保存、MCP 的 edit、领域写入器、定稿写回', () => {
  let t;
  let ws;

  before(async () => {
    ({ t, ws } = await fresh('hist-paths'));
  });

  test('内置编辑器保存（writeFileFromEditor）', async () => {
    const rel = 'chapters/010-编辑器.md';
    t.write(rel, BIG);
    await bundle.fileEditing.writeFileFromEditor(t.dir, rel, '编辑器里存的新版');
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), BIG);
  });

  test('MCP 的 edit（定点替换，走 write）', async () => {
    const rel = 'chapters/011-替换.md';
    t.write(rel, '他走进了院子。');
    await ws.edit(rel, [{ old: '走进', new: '冲进' }]);
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), '他走进了院子。');
  });

  test('领域写入器：重写角色卡、文风、叙事线', async () => {
    t.write('.novelforge/characters/林昭.md', '# 林昭\n\n旧卡。');
    await ws.writeCharacter({ slug: '林昭', name: '林昭', aliases: [], tags: [], sections: {} });
    assert.equal(snapText(t, '.novelforge/characters/林昭.md', snaps(t, '.novelforge/characters/林昭.md')[0]), '# 林昭\n\n旧卡。');

    t.write('.novelforge/style.md', '# 文风指南\n\n旧的文风。');
    await ws.writeStyleGuide('新的文风。');
    assert.equal(snaps(t, '.novelforge/style.md').length, 1);

    t.write('.novelforge/threads.md', '# 叙事线\n\n旧的。');
    await ws.updateThreads((raw) => `${raw}\n- 新的一条\n`);
    assert.equal(snapText(t, '.novelforge/threads.md', snaps(t, '.novelforge/threads.md')[0]), '# 叙事线\n\n旧的。');
  });

  test('写细纲覆盖已有那份', async () => {
    const plot = {
      no: 12,
      title: '入宗',
      targetWords: 3000,
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '旧的梗概。', 关键事件: '旧的事件。' },
    };
    const rel = await ws.writePlot(plot);
    const before1 = t.read(rel);
    await ws.writePlot({ ...plot, sections: { ...plot.sections, 梗概: '新的梗概。'.repeat(80) } });
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), before1);
  });

  test('定稿写回细纲：回收站那一份照旧，历史版本里也有一版', async () => {
    await ws.createChapter(20, '山门', '他在山门外蹲了两个时辰。');
    t.project.invalidate();
    const chapter = await t.project.getChapter(20);
    const plotRel = t.project.plotPathForChapter(chapter.relPath);
    t.write(plotRel, '---\nno: 20\ntitle: 山门\n---\n\n## 梗概\n\n计划里的梗概。\n');
    const plan = t.read(plotRel);
    t.project.invalidate();
    const r = await ws.finalizePlot(
      chapter,
      { ...bundle.plotFile.emptyPlotSections(), 梗概: '他在山门外蹲了两个时辰。', 关键事件: '林昭在山门外等到天黑。' },
      [{ name: '林昭', aliases: [] }]
    );
    assert.ok(r.trashed, JSON.stringify(r));
    assert.equal(t.read(r.trashed), plan);
    assert.equal(snapText(t, plotRel, snaps(t, plotRel)[0]), plan);
  });

  test('只改 frontmatter 一个键的记账（recordWrittenFrom）不存', async () => {
    const plotRel = '.novelforge/summaries/030-记账.md';
    t.write(plotRel, '---\nno: 30\ntitle: 记账\n---\n\n## 梗概\n\n梗概。\n');
    await ws.recordWrittenFrom(plotRel, 'abcdef0123456789');
    assert.equal(snaps(t, plotRel).length, 0);
  });

  test('字节原样拷贝（CRLF 不被改成 LF）', async () => {
    const rel = 'chapters/012-换行.txt';
    fs.writeFileSync(t.rel(rel), Buffer.from('第一行\r\n第二行\r\n', 'utf8'));
    await overwrite(ws, rel, '全换了。'.repeat(100));
    assert.deepEqual(fs.readFileSync(t.rel('.novelforge/history', rel, snaps(t, rel)[0])), Buffer.from('第一行\r\n第二行\r\n', 'utf8'));
  });
});

describe('不进上下文、不触发重扫、删不掉', () => {
  let t;
  let ws;
  const rel = 'chapters/001-青铜灯.md';
  let snapRel;

  before(async () => {
    ({ t, ws } = await fresh('hist-isolate'));
    await ws.write(rel, { text: `那盏灯的铜绿斑驳了一层。${BIG}` }, { mode: 'create' });
    await overwrite(ws, rel, '灯灭了。');
    snapRel = `.novelforge/history/${rel}/${snaps(t, rel)[0]}`;
  });

  test('kindOfPath 把历史目录里的东西判成 other（装配器只按种类读，碰不到它）', () => {
    assert.equal(bundle.kind.kindOfPath(t.project, snapRel).kind, 'other');
    assert.equal(bundle.kind.kindOfPath(t.project, '.novelforge/history/.novelforge/summaries/001-雪夜.md/x.txt').kind, 'other');
  });

  test('全文检索跳过历史版本（搜出来的不是现在的书）', async () => {
    assert.ok(t.read(snapRel).includes('铜绿斑驳'));
    const r = await ws.search('铜绿斑驳');
    assert.deepEqual(r.hits.map((x) => x.rel), []);
  });

  test('watchPolicy 挡掉历史目录的变动', () => {
    assert.equal(bundle.watch.shouldIgnoreChange(snapRel), true);
  });

  test('历史目录是固定目录：网关删不掉、搬不走', async () => {
    assert.equal(bundle.guard.isProtectedPath(t.project, '.novelforge/history'), true);
    await assert.rejects(ws.remove('.novelforge/history'), (e) => e.code === 'protected');
    await assert.rejects(ws.move('.novelforge/history', '旧稿'), (e) => e.code === 'protected');
    assert.equal(fs.existsSync(t.rel(snapRel)), true);
  });

  test('工程页的类文件操作删不到它（不在三个区里）', async () => {
    h.expect('删除');
    assert.equal(await bundle.fileOps.deleteEntry(t.project, '.novelforge/history'), false);
    assert.equal(fs.existsSync(t.rel(snapRel)), true);
  });

  test('「文件」页照常列得出来', async () => {
    const names = (await ws.list('.novelforge')).map((e) => e.name);
    assert.ok(names.includes('history'), names.join('、'));
  });
});
