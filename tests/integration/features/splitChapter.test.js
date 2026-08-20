/**
 * 「拆成章节」：把中转站正文按单独一行 `---` 切成 `chapters/` 下的发布章。
 *
 * 这是整条流水线上唯一一道**人工闸口**，也是唯一一个花零 token 的编排动作。
 * 要守的东西有四样：
 *
 * 1. 切出来的章确实落进了 `chapters/`，中转站原件进了 `.trash/`（不真删）；
 * 2. 第一章沿用原标题，其余留纯序号名——**不调模型拟标题**；
 * 3. 章号接在**现有最后一章**之后（`nextChapterNo`），与这一段的段号无关；
 * 4. **一个别的文件都不动**：后面还没拆的剧情段不改名、不挪场景目录；
 * 5. 落点记进这一段的 frontmatter（`chapters:`）——那是「段 → 章」唯一的链。
 *
 * 第 3、4 条是这次改动的落点。从前章号从段号起排，于是「一段拆成三章」必须把
 * 后面几十份细纲整体改名让路，连带搬走各自的场景目录与中转站正文。段号与章号
 * 现在是两条轴（界面上的「剧情 N」是推导出来的位次），那一步整个不需要了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

let bundle;
let h;
let t;
let project;

/** 一份「排过剧情」的细纲（剧情脉络非空，isPlotFilled 才认）。 */
const filled = (goal) => ({
  ...bundle.plotFile.emptyPlotSections(),
  目标: goal,
  剧情脉络: '甲、乙、丙。',
});

/** 建一段的细纲（可选带一场景），返回细纲相对路径。 */
async function makePlot(no, title, { scene = false } = {}) {
  const relPath = await wsOf(project).writePlot({
    no,
    title,
    arc: '',
    upstreamHash: '',
    done: false,
    chapters: [],
    sections: filled(`第 ${no} 段要达成的事。`),
  });
  if (scene) {
    await wsOf(project).writeScene(relPath, {
      plotRelPath: relPath,
      no: 1,
      title: '开场',
      place: '',
      time: '',
      characters: [],
      upstreamHash: '',
      status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 动作: '甲' },
    });
  }
  return relPath;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    split: './src/core/features/splitChapter.ts',
  });
  wsMod = bundle.ws;
  h = makeFakeHost();
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'split', title: '拆分测试' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir);
});

/**
 * 主路径：一段正文里插了两条 `---`，拆成三章。后面两段一个字节都不动。
 */
describe('拆成三章', () => {
  const plotRel = '.novelforge/plots/010-归山.md';
  let created;
  let chapters;
  let plots;

  before(async () => {
    await makePlot(10, '归山');
    // 后面两段已经规划过（其中一段拆过场景）。从前它们要整体让路，现在不必。
    await makePlot(11, '风起', { scene: true });
    await makePlot(12, '雪落');

    await wsOf(project).appendToManuscript(plotRel, '他回到山门。');
    await wsOf(project).appendToManuscript(plotRel, '师父在等他。');
    await wsOf(project).appendToManuscript(plotRel, '雪落了一夜。');

    h.expect('拆分');
    created = await bundle.split.splitManuscript(project, plotRel);
    project.invalidate();
    chapters = await project.listChapters();
    plots = await project.listPlots();
  });

  // appendToManuscript 在每次追加之间插一行 `---` 当默认候选断点，
  // 所以三次追加天然就是三章——这正是「场景边界最可能是章节边界」那条。
  test('切成三章', () => {
    assert.equal(created.length, 3, created.join('|'));
  });

  test('章节落在 chapters/ 下', () => {
    assert.ok(
      created.every((rel) => rel.startsWith('chapters/')),
      created.join('|')
    );
  });

  test('第一章沿用原标题', () => {
    assert.equal(created[0], 'chapters/001-归山.md', created[0]);
  });

  // **不调模型拟标题**：那要么多花一次调用，要么在一个纯机械的动作里
  // 插进一次可能失败的网络请求。作者右键重命名一下就好。
  test('其余章落成纯序号名', () => {
    assert.deepEqual(created.slice(1), ['chapters/002.md', 'chapters/003.md']);
  });

  // 章号接在**现有最后一章**之后，与这一段的段号（10）无关：段号只是
  // `plots/` 里的排序键，一段可以拆成三章，两条轴各排各的。
  test('章号从现有最后一章往后接', () => {
    assert.deepEqual(
      chapters.map((c) => c.order),
      [1, 2, 3]
    );
  });

  test('每一章拿到自己那一片正文', async () => {
    const texts = await Promise.all(chapters.map((c) => project.readChapterText(c)));
    assert.ok(texts[0].includes('回到山门') && !texts[0].includes('师父'), texts[0]);
    assert.ok(texts[1].includes('师父在等他'), texts[1]);
    assert.ok(texts[2].includes('雪落了一夜'), texts[2]);
  });

  test('分隔线不留在正文里', async () => {
    const texts = await Promise.all(chapters.map((c) => project.readChapterText(c)));
    assert.ok(!texts.some((x) => /^\s*-{3,}\s*$/m.test(x)), texts.join('|'));
  });

  // 中转站是临时的：拆完那份就该消失，否则同一批文字有了两个真相。
  test('中转站原件不在了', () => {
    assert.ok(!t.has('.novelforge/manuscripts/010-归山.md'));
  });

  test('中转站原件进了回收站（不真删）', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/manuscripts/010-归山.md'));
  });

  // 这是这次改动最要紧的一条：段号不再让路，所以**一个文件都不改名**。
  // 从前这里会把 11、12 整体 +2，连带搬走它们的场景目录与中转站正文——
  // 一次几十份文件的重命名风暴，只为维持「细纲与章同号」那条已经不存在的
  // 不变量。
  test('后面待写的段号不动', () => {
    assert.deepEqual(
      plots.map((p) => p.no),
      [10, 11, 12]
    );
  });

  test('后面那段的内容与路径都没动', async () => {
    const untouched = await project.readPlot('.novelforge/plots/011-风起.md');
    assert.equal(untouched?.sections.目标, '第 11 段要达成的事。', JSON.stringify(untouched?.sections));
  });

  test('场景目录没被搬走', () => {
    assert.ok(t.has('.novelforge/scenes/011-风起/01-开场.md'));
  });

  // 「段 → 章」的链现在是显式的：`chapters/` 下的文件是作者的东西，
  // 拆分之后插件一个字节都不往里改，所以这条链只能记在段这一侧。
  test('落点记进了这一段的 frontmatter', async () => {
    const plot = await project.readPlot(plotRel);
    assert.deepEqual(plot.chapters, created, JSON.stringify(plot.chapters));
  });

  test('拆成多章要先弹确认', () => {
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
  });

  test('确认框说清落到哪几章', () => {
    assert.ok(h.confirms[0].detail.includes('第 1 章'), h.confirms[0].detail);
  });

  test('确认框说清后面的段不受影响', () => {
    assert.ok(h.confirms[0].detail.includes('一个文件都不会改名'), h.confirms[0].detail);
  });

  test('没有报错', () => {
    assert.ok(!h.erred(), h.toasts.join('|'));
  });
});

/**
 * 不标断点 = 「把这一段原样发布出去」。没有可商量的取舍，所以不弹确认。
 */
describe('只切出一章', () => {
  const plotRel = '.novelforge/plots/020-独章.md';
  let created;
  let plotsAfter;

  before(async () => {
    await makePlot(20, '独章');
    await makePlot(21, '后一章');
    await wsOf(project).appendToManuscript(plotRel, '整章一气呵成，没有断点。');

    h.expect(); // 一个答案都不排：真弹了确认就会当成取消，用例随即变红
    created = await bundle.split.splitManuscript(project, plotRel);
    project.invalidate();
    plotsAfter = await project.listPlots();
  });

  // 章号接在上一组拆出来的第 3 章之后。
  test('只建一章', () => {
    assert.deepEqual(created, ['chapters/004-独章.md']);
  });

  test('不弹确认框', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  test('后面的段号不动', () => {
    assert.ok(
      plotsAfter.some((p) => p.no === 21),
      plotsAfter.map((p) => p.no).join('|')
    );
  });

  test('中转站原件仍然删掉了', () => {
    assert.ok(!t.has('.novelforge/manuscripts/020-独章.md'));
  });
});

/** 取消 = 一个字节都不动。确认框里说了要建文件、要删原件，反悔就得全反悔。 */
describe('用户取消', () => {
  const plotRel = '.novelforge/plots/030-反悔.md';
  let created;

  before(async () => {
    await makePlot(30, '反悔');
    await makePlot(31, '不该被挪');
    await wsOf(project).appendToManuscript(plotRel, '甲。');
    await wsOf(project).appendToManuscript(plotRel, '乙。');

    h.expect(undefined); // 用户按了 Esc
    created = await bundle.split.splitManuscript(project, plotRel);
    project.invalidate();
  });

  test('什么都没建', () => {
    assert.deepEqual(created, []);
  });

  test('中转站原件还在', () => {
    assert.ok(t.has('.novelforge/manuscripts/030-反悔.md'));
  });

  test('后面的段号没被挪', () => {
    assert.ok(t.has('.novelforge/plots/031-不该被挪.md'));
  });
});

/**
 * 已经发布的章一个字节都不动。它是成品，作者已经发出去了；因为别处拆了几章
 * 就给它改号，等于打乱读者看到的顺序。
 */
describe('已发布的章不受影响', () => {
  const plotRel = '.novelforge/plots/040-插队.md';
  let published;
  let publishedText;

  before(async () => {
    await makePlot(40, '插队');
    await makePlot(41, '已发布');
    t.write('chapters/041-已发布.md', '# 已发布\n\n早就发出去的文字。\n');
    project.invalidate();

    await wsOf(project).appendToManuscript(plotRel, '甲。');
    await wsOf(project).appendToManuscript(plotRel, '乙。');

    h.expect('拆分');
    await bundle.split.splitManuscript(project, plotRel);
    project.invalidate();
    published = await project.readPlot('.novelforge/plots/041-已发布.md');
    publishedText = t.read('chapters/041-已发布.md');
  });

  test('那一段的段号没变', () => {
    assert.equal(published?.no, 41, JSON.stringify(published?.no));
  });

  test('它的成品文件也没被改名', () => {
    assert.ok(t.has('chapters/041-已发布.md'));
  });

  test('成品内容一个字节都没动', () => {
    assert.ok(publishedText.includes('早就发出去的文字'), publishedText);
  });
});

/** 错误路径：说清楚为什么拆不了，而不是默默不动或建一批空文件。 */
describe('拆不动的情况', () => {
  test('没有正文时报错且不建章节', async () => {
    await makePlot(50, '空章');
    h.expect('拆分');
    const created = await bundle.split.splitManuscript(project, '.novelforge/plots/050-空章.md');
    assert.deepEqual(created, []);
    assert.ok(h.erred(), h.toasts.join('|'));
  });

  test('正文里只有分隔线时报错', async () => {
    await makePlot(51, '只有线');
    t.write('.novelforge/manuscripts/051-只有线.md', '# 只有线\n\n---\n\n---\n');
    h.expect('拆分');
    const created = await bundle.split.splitManuscript(project, '.novelforge/plots/051-只有线.md');
    assert.deepEqual(created, []);
    assert.ok(h.erred(), h.toasts.join('|'));
  });

  test('段不存在时报错', async () => {
    h.expect('拆分');
    const created = await bundle.split.splitManuscript(project, '.novelforge/plots/999-查无此章.md');
    assert.deepEqual(created, []);
    assert.ok(h.erred(), h.toasts.join('|'));
  });
});
