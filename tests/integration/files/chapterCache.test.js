/**
 * 章节列表缓存的并发语义。
 *
 * `listChapters()` 会读**每一章的正文**（要算字数与 contentHash），所以它是全书
 * 刷新里最贵的一步，缓存不是锦上添花。但缓存只在扫完之后才填得上，于是有两条
 * 容易长回来的坑：
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

let bundle;
let t;
let project;

/** 本轮读了多少个章节正文文件。 */
let chapterReads;
let restore;

before(async () => {
  const original = fsp.readFile;
  restore = () => {
    fsp.readFile = original;
  };
  fsp.readFile = async (...args) => {
    if (String(args[0]).includes('chapters')) {
      chapterReads++;
    }
    return original.apply(fsp, args);
  };

  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'chapter-cache', title: '缓存' });
  project = t.project;

  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(3, '0');
    t.write(`chapters/${n}-第${i}章.md`, `# 第${i}章\n\n${'正文。'.repeat(20)}`);
  }
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

beforeEach(() => {
  project.invalidate();
  chapterReads = 0;
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
