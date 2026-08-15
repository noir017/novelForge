/**
 * 章节与细纲两份列表缓存的并发语义。
 *
 * 两者都会读**每一份文件**（章节要算字数与 contentHash，细纲要解析四个小节），
 * 所以它们是全书刷新里最贵的两步，缓存不是锦上添花。但缓存只在扫完之后才填得上，
 * 于是有两条容易长回来的坑：
 *
 * 1. **并发击穿**——两个调用方同时进来都看到空缓存，各扫一遍全书。
 *    `buildProjectTree` 的 `Promise.all` 正是这个形状。
 * 2. **过期回填**——扫到一半作者改了文件（`invalidate()`），扫描却在结束时
 *    把变更之前的结果写进缓存，之后所有人都读到旧数据，直到下一次 invalidate。
 *
 * 两条都不会抛错、不会变红：第一条只是慢，第二条只是界面上的字数与「过期」
 * 标记停在上一版。只能靠断言守。
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 细纲与场景的写入搬进了 `core/workspace/`：改名要连带搬走场景目录与中转站
 * 正文、写入要记上游指纹、删除要进 `.trash/`，那些是网关的活。`NovelProject`
 * 这一层只留领域查询。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

/** 造多少段。与章节数分开，断言里就看得出读的是哪一批。 */
const PLOTS = 7;

let bundle;
let t;
let project;

/** 本轮读了多少个章节正文文件。 */
let chapterReads;
/** 本轮读了多少个细纲文件。 */
let plotReads;
let restore;

before(async () => {
  const original = fsp.readFile;
  restore = () => {
    fsp.readFile = original;
  };
  fsp.readFile = async (...args) => {
    const p = String(args[0]).replace(/\\/g, '/');
    if (p.includes('/chapters/')) {
      chapterReads++;
    } else if (p.includes('/plots/')) {
      plotReads++;
    }
    return original.apply(fsp, args);
  };

  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
  });

  wsMod = bundle.ws;
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'chapter-cache', title: '缓存' });
  project = t.project;

  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(3, '0');
    t.write(`chapters/${n}-第${i}章.md`, `# 第${i}章\n\n${'正文。'.repeat(20)}`);
  }
  for (let i = 1; i <= PLOTS; i++) {
    const n = String(i).padStart(3, '0');
    t.write(`.novelforge/plots/${n}-第${i}段.md`, `---\nno: ${i}\n---\n\n## 剧情脉络\n脉络。\n`);
  }
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

beforeEach(() => {
  project.invalidate();
  chapterReads = 0;
  plotReads = 0;
});

describe('章节列表缓存', () => {
  test('串行的第二次调用不读盘', async () => {
    await project.listChapters();
    const afterFirst = chapterReads;
    await project.listChapters();
    assert.equal(chapterReads, afterFirst, '第二次应当直接命中缓存');
  });

  test('并发的两次调用只扫一遍全书', async () => {
    const [a, b] = await Promise.all([project.listChapters(), project.listChapters()]);
    assert.equal(chapterReads, 12, `并发时读了 ${chapterReads} 个正文文件，应当只读 12 个`);
    // 搭同一班车，拿到的自然是同一份结果。
    assert.equal(a, b);
  });

  test('并发调用拿到的内容与串行一致', async () => {
    const [concurrent] = await Promise.all([project.listChapters(), project.listChapters()]);
    project.invalidate();
    const serial = await project.listChapters();
    assert.deepEqual(
      concurrent.map((c) => c.relPath),
      serial.map((c) => c.relPath)
    );
  });

  test('invalidate 之后重新读盘', async () => {
    await project.listChapters();
    project.invalidate();
    chapterReads = 0;
    await project.listChapters();
    assert.equal(chapterReads, 12, '失效之后应当重新扫一遍');
  });

  test('扫描途中 invalidate：新的调用方不搭旧车', async () => {
    const inFlight = project.listChapters();
    project.invalidate();
    // 变更之后进来的人必须自己再扫一遍，否则拿到的是变更之前的全书。
    // 两轮各读 12 个文件：在途那一轮的读盘也落在计数清零之后，所以是 24 而不是 12
    // ——关键在于它确实是**两轮**，而不是第二个调用方搭了第一轮的车。
    chapterReads = 0;
    const [before, after] = await Promise.all([inFlight, project.listChapters()]);
    assert.equal(chapterReads, 24, `读了 ${chapterReads} 个文件，两轮独立扫描应当是 24 个`);
    assert.notEqual(before, after, 'invalidate 之后的调用不该复用在途那一轮的结果');
  });

  test('扫描途中 invalidate：旧结果不回填缓存', async () => {
    const inFlight = project.listChapters();
    project.invalidate();
    await inFlight;
    // 新增一章。若刚才那轮把旧列表写进了缓存，这里就会读到 12 章。
    t.write('chapters/013-新章.md', '# 第13章\n\n新写的。');
    try {
      const chapters = await project.listChapters();
      assert.equal(chapters.length, 13, '缓存里应当没有那份过期结果');
    } finally {
      t.remove('chapters/013-新章.md');
      project.invalidate();
    }
  });
});

/**
 * 细纲列表缓存。与章节那一份同构，但它是**更热的那条路**：
 * 流水线索引与出场索引在同一次 `buildProjectTree` 里都要 `listPlots()`，
 * 不共享的话每次刷新都把 `plots/` 整个读两遍。
 *
 * 另外多一条章节没有的约束：`writePlot` / `deletePlot` 自己会写盘，
 * **它们必须让缓存失效**——否则新建的章不出现在工程页上，改过标题的章
 * 还挂着旧名字，而这两件事都不会报错。
 */
describe('细纲列表缓存', () => {
  test('串行的第二次调用不读盘', async () => {
    await project.listPlots();
    const afterFirst = plotReads;
    await project.listPlots();
    assert.equal(plotReads, afterFirst, '第二次应当直接命中缓存');
  });

  test('并发的两次调用只扫一遍', async () => {
    const [a, b] = await Promise.all([project.listPlots(), project.listPlots()]);
    assert.equal(plotReads, PLOTS, `并发时读了 ${plotReads} 个段文件，应当只读 ${PLOTS} 个`);
    assert.equal(a, b);
  });

  test('invalidate 之后重新读盘', async () => {
    await project.listPlots();
    project.invalidate();
    plotReads = 0;
    await project.listPlots();
    assert.equal(plotReads, PLOTS, '失效之后应当重新扫一遍');
  });

  test('扫描途中 invalidate：旧结果不回填缓存', async () => {
    const inFlight = project.listPlots();
    project.invalidate();
    await inFlight;
    t.write('.novelforge/plots/013-新段.md', '---\nno: 13\n---\n\n## 剧情脉络\n新排的。\n');
    try {
      const plots = await project.listPlots();
      assert.equal(plots.length, PLOTS + 1, '缓存里应当没有那份过期结果');
    } finally {
      t.remove('.novelforge/plots/013-新段.md');
      project.invalidate();
    }
  });

  // 写盘的那两条路自己失效缓存，调用方不必记得调 invalidate()。
  test('writePlot 之后读得到新段', async () => {
    await project.listPlots();
    try {
      await wsOf(project).writePlot({ no: 99, title: '新写的', sections: { 剧情脉络: '脉络' } });
      const plots = await project.listPlots();
      assert.ok(plots.some((p) => p.no === 99), plots.map((p) => p.no).join('|'));
    } finally {
      t.remove('.novelforge/plots/099-新写的.md');
      project.invalidate();
    }
  });

  test('改标题之后读到的是新文件名', async () => {
    try {
      await wsOf(project).writePlot({ no: 99, title: '初名', sections: { 剧情脉络: '脉络' } });
      await project.listPlots();
      await wsOf(project).writePlot({ no: 99, title: '改过的名字', sections: { 剧情脉络: '脉络' } });
      const found = (await project.listPlots()).find((p) => p.no === 99);
      assert.equal(found?.relPath, '.novelforge/plots/099-改过的名字.md', found?.relPath);
    } finally {
      t.remove('.novelforge/plots/099-改过的名字.md');
      project.invalidate();
    }
  });

  test('deletePlot 之后读不到了', async () => {
    await wsOf(project).writePlot({ no: 99, title: '待删', sections: { 剧情脉络: '脉络' } });
    await project.listPlots();
    await wsOf(project).deletePlot('.novelforge/plots/099-待删.md');
    const plots = await project.listPlots();
    assert.ok(!plots.some((p) => p.no === 99), plots.map((p) => p.no).join('|'));
  });
});
