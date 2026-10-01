/**
 * 工程页刷新的读盘次数。
 *
 * `buildProjectTree` 由文件监听触发（两个壳各去抖 250ms），**作者每存一次盘就跑一次**。
 * 它一次要把全书的产物聚合出来，所以「每章多读一个文件」在五百章工程上就是
 * 多五百次读盘——这条路上的浪费不会报错、不会变红，只会让工程页越用越慢。
 *
 * 因此这里断言的不是耗时（机器一换就飘），而是**读盘次数**：
 *
 * 1. 同一个文件在一次刷新里至多读一次——重复读盘一律是取数方各读各的，
 *    而不是真的需要读两遍；
 * 2. 每章的 fs 调用数有上限——挡住「新加一层产物顺手每章多扫一个目录」。
 *
 * 计数靠替换 `node:fs/promises` 上的方法。core 的读盘全部经 `model/fs.ts`，
 * 而那里只用 `fs.readFile` / `fs.stat` / `fs.readdir`，所以替换这三个就够。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/** 造多少章。够大到能把「每章 +1」与常数项区分开，又不至于让用例变慢。 */
const PLOTS = 40;

let bundle;
let t;
let project;

/** 本轮记到的读盘：绝对路径 → 次数。 */
let reads;
/** 本轮 fs 调用总数（含 readdir / stat）。 */
let calls;
let counting = false;
let restore;

/** 把三个读方法换成会计数的版本，返回还原函数。 */
function instrument() {
  const original = { readFile: fsp.readFile, stat: fsp.stat, readdir: fsp.readdir };
  fsp.readFile = async (...args) => {
    if (counting) {
      calls++;
      const key = path.resolve(String(args[0]));
      reads.set(key, (reads.get(key) ?? 0) + 1);
    }
    return original.readFile.apply(fsp, args);
  };
  fsp.stat = async (...args) => {
    if (counting) calls++;
    return original.stat.apply(fsp, args);
  };
  fsp.readdir = async (...args) => {
    if (counting) calls++;
    return original.readdir.apply(fsp, args);
  };
  return () => Object.assign(fsp, original);
}

/** 跑一次全量刷新并统计。`project.invalidate()` 模拟「磁盘变过了」。 */
async function measure() {
  project.invalidate();
  reads = new Map();
  calls = 0;
  counting = true;
  try {
    return await bundle.projectView.buildProjectTree(project);
  } finally {
    counting = false;
  }
}

/**
 * 一章「全都齐了」的内容：细纲 + 同号章节 + 摘要，三条取数路径都会走到。
 * 一章一纲之后没有中转站那一份了，正文就是章节。
 */
async function writePlot(i, { full = true } = {}) {
  const n = String(i).padStart(3, '0');
  const stem = `${n}-第${i}章`;
  const plotRel = `.novelforge/plots/${stem}.md`;
  t.write(
    plotRel,
    `---\nno: ${i}\ntitle: 第${i}章\nupstreamHash: h\n---\n\n# 第${i}章\n\n## 本章目的\n目的\n\n## 关键事件\n事件\n` +
      (full ? '\n## 章末钩子\n钩子\n' : '')
  );
  // 不写 writtenFrom：随手写一个就会让它永远显示「细纲在正文之后改过」，这一章于是
  // 卡在 manuscript 阶段——那样摘要那条取数路径的回潮就测不出来了。从没记录过
  // 指纹的正文永不标脏（第 18a 条）。
  const chapterRel = `chapters/${stem}.md`;
  t.write(chapterRel, `# 第${i}章\n\n${'正文。'.repeat(50)}`);
  project.invalidate();
  // 摘要的 sourceHash 要对上章节，否则停在「待定稿」，同样走不到「已完成」。
  const sourceHash =
    (await project.listChapters()).find((c) => c.relPath === chapterRel)?.contentHash ?? '';
  t.write(
    `.novelforge/summaries/${stem}.md`,
    `---\nsourceHash: ${sourceHash}\ncast: []\n---\n\n## 梗概\n梗概\n`
  );
}

before(async () => {
  restore = instrument();
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'tree-reads', title: '读盘计数' });
  project = t.project;

  for (let i = 1; i <= PLOTS; i++) {
    await writePlot(i);
  }
  // 叙事线（七期）：有这份文件，下面「至多读一次」那条才管得到它。
  t.write('.novelforge/threads.md', '# 叙事线\n\n## 玉佩\n- 计划：第 1–2 章\n- 第 1 章 · 埋下：「玉佩」\n');
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

describe('工程页刷新 · 读盘次数', () => {
  test('夹具确实建出了全部章（否则下面的计数没有意义）', async () => {
    const tree = await measure();
    assert.equal(tree.plotCount, PLOTS);
    assert.deepEqual(tree.threads, { exists: true, total: 1, open: 1, closed: 0, overdue: 1 });
  });

  // 全齐了才说明各条取数路径都真的走到了：只建细纲不写正文的话，
  // 摘要那一层会被跳过，这份计数就挡不住它回潮。
  test('夹具的各层都齐了', async () => {
    const tree = await measure();
    assert.ok(
      tree.plots.every((p) => p.stage === 'done'),
      tree.plots.map((p) => `${p.no}:${p.stage}`).join('|')
    );
  });

  const repeatedReads = () =>
    [...reads.entries()]
      .filter(([, n]) => n > 1)
      .map(([p, n]) => [path.relative(t.dir, p).replace(/\\/g, '/'), n]);

  // 一期大切换曾让 `config.md` 读两次：`buildPipelineIndex` 读一次，`buildBookFacts`
  // 的 `settingFilled()` 又读一次。现在后者吃索引里那一份。
  test('同一个文件在一次刷新里至多读一次（含 config.md）', async () => {
    await measure();
    const repeated = repeatedReads().map(([rel, n]) => `${rel} ×${n}`);
    assert.deepEqual(
      repeated,
      [],
      `这些文件被读了不止一次（取数方各读各的，摊一次给所有人即可）：\n  ${repeated.join('\n  ')}`
    );
  });

  test('每章的 fs 调用数不超过 4 次', async () => {
    await measure();
    // 一章的下限是 3：细纲 1 + 同号章节 1 + 摘要 1，每份文件恰好读一次，再少就得
    // 砍功能了。
    //
    // 从前是 4（还有中转站那一份正文），再往前有场景层时是 9。一章一纲之后正文
    // 就是章节，每章少读一个文件——这份用例正是那笔收益的度量。
    //
    // 上限 4 是给全书那几次常数开销（大纲、配置与架构三件、manifest、角色/设定/
    // 草稿目录）摊下来的余量，它们不随章数增长，章数越多这个比值越贴近 3。
    // 真正要挡的是「每章再多读一个文件」那类回潮：那会让这个数直接跳过 4。
    // （从前上限是 5、下限是 4；下限掉到 3 之后上限跟着收紧，否则多读一个文件
    // 也还在余量里，这条就挡不住了。）
    const perPlot = calls / PLOTS;
    assert.ok(
      perPlot <= 4,
      `每章 ${perPlot.toFixed(1)} 次 fs 调用（共 ${calls} 次 / ${PLOTS} 章），上限 4`
    );
  });

  test('章数翻倍时读盘次数不超过线性增长', async () => {
    const before = calls;
    for (let i = PLOTS + 1; i <= PLOTS * 2; i++) {
      await writePlot(i, { full: false });
    }
    await measure();
    // 二次项（每章都去扫一遍全书）会让这个比值远超 2。
    assert.ok(
      calls <= before * 2.2,
      `${PLOTS} 章 ${before} 次 → ${PLOTS * 2} 章 ${calls} 次，超出线性增长`
    );
  });
});
