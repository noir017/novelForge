/**
 * 工程页刷新的读盘次数。
 *
 * `buildProjectTree` 由文件监听触发（两个壳各去抖 250ms），**作者每存一次盘就跑一次**。
 * 它一次要把全书的四层产物聚合出来，所以「每段多读一个文件」在五百段工程上就是
 * 多五百次读盘——这条路上的浪费不会报错、不会变红，只会让工程页越用越慢。
 *
 * 因此这里断言的不是耗时（机器一换就飘），而是**读盘次数**：
 *
 * 1. 同一个文件在一次刷新里至多读一次——重复读盘一律是取数方各读各的，
 *    而不是真的需要读两遍；
 * 2. 每段的 fs 调用数有上限——挡住「新加一层产物顺手每段多扫一个目录」。
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

/** 造多少段。够大到能把「每段 +1」与常数项区分开，又不至于让用例变慢。 */
const PLOTS = 40;
/** 每段几场。 */
const SCENES = 4;

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
 * 一章「全都齐了」的内容：细纲 + 场景 + 中转站正文 + 成品 + 摘要，
 * 五条取数路径都会走到。
 */
async function writePlot(i, { full = true } = {}) {
  const n = String(i).padStart(3, '0');
  const stem = `${n}-第${i}章`;
  const plotRel = `.novelforge/plots/${stem}.md`;
  t.write(
    plotRel,
    `---\nno: ${i}\ntitle: 第${i}章\nupstreamHash: h\n---\n\n## 目标\n目标\n\n## 剧情脉络\n脉络\n` +
      (full ? '\n## 冲突与转折\n冲突\n\n## 伏笔与回收\n伏笔\n' : '')
  );
  for (let s = 1; s <= SCENES; s++) {
    t.write(
      `.novelforge/scenes/${stem}/0${s}-场景${s}.md`,
      `---\nno: ${s}\nstatus: written\n${full ? 'upstreamHash: p\n' : ''}---\n\n## 目的\n目的\n` +
        (full ? '\n## 环境\n环境\n' : '')
    );
  }
  // beatsHash 用真的算法算：随手写一个 `b` 会让正文永远显示「上游已变更」，
  // 这一章就卡在 manuscript 阶段，后面几条取数路径根本走不到——那样这份
  // 读盘计数就挡不住它回潮了。
  const beatsHash = await project.beatsHashFor(plotRel);
  t.write(
    `.novelforge/manuscripts/${stem}.md`,
    `---\nplot: ${plotRel}\nbeatsHash: ${beatsHash}\n---\n\n# 第${i}章 · 正文\n\n${'正文。'.repeat(50)}`
  );
  // 成品：拆分之后才有。没有它这一章停在 split，摘要那条路走不到。
  const chapterRel = `chapters/${stem}.md`;
  t.write(chapterRel, `# 第${i}章\n\n${'正文。'.repeat(50)}`);
  project.invalidate();
  // 摘要的 sourceHash 要对上**成品**，否则停在 review，同样走不到「已完成」。
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
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

describe('工程页刷新 · 读盘次数', () => {
  test('夹具确实建出了全部章（否则下面的计数没有意义）', async () => {
    const tree = await measure();
    assert.equal(tree.plotCount, PLOTS);
  });

  // 全齐了才说明各条取数路径都真的走到了：只建细纲不发布的话，
  // 摘要那一层会被跳过，这份计数就挡不住它回潮。
  test('夹具的各层都齐了', async () => {
    const tree = await measure();
    assert.ok(
      tree.plots.every((p) => p.stage === 'done'),
      tree.plots.map((p) => `${p.no}:${p.stage}`).join('|')
    );
  });

  test('同一个文件在一次刷新里至多读一次', async () => {
    await measure();
    const repeated = [...reads.entries()]
      .filter(([, n]) => n > 1)
      .map(([p, n]) => `${path.relative(t.dir, p)} ×${n}`);
    assert.deepEqual(
      repeated,
      [],
      `这些文件被读了不止一次（取数方各读各的，摊一次给所有人即可）：\n  ${repeated.join('\n  ')}`
    );
  });

  test('每章的 fs 调用数不超过 10 次', async () => {
    await measure();
    // 一章的下限是 9：细纲 1 + 成品 1 + 中转站正文 1 + 摘要 1 + 场景 4 +
    // 场景目录 readdir 1，每份文件恰好读一次，再少就得砍功能了。
    //
    // 这个夹具把中转站那份也留着（真实工程里拆分之后就删了，那时是 8）——
    // 留着才测得到「两侧都读到了」。上限留 10 是给全书那几次常数开销
    // （大纲、manifest、角色/设定/草稿目录）摊下来的余量，它们不随章数增长，
    // 章数越多这个比值越贴近 9。
    //
    // 真正要挡的是「每章再多读一个文件」那类回潮：那会让这个数直接跳过 10。
    const perPlot = calls / PLOTS;
    assert.ok(
      perPlot <= 10,
      `每章 ${perPlot.toFixed(1)} 次 fs 调用（共 ${calls} 次 / ${PLOTS} 章），上限 10`
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
