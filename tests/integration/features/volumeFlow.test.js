/**
 * 分卷层的整条链，以及两个最容易安静坏掉的回归点。
 *
 * 别处的用例各守一段（拆卷/拆段在 creation.test.js，拆章在 splitChapter.test.js，
 * 索引在 pipelineData.test.js）。这里走一遍**完整的链**，因为这次改动真正的风险
 * 不在任何单独一段，而在几段接起来之后：
 *
 * 1. **位次**（界面上那个「剧情 N」）要跨「拆段 → 写正文 → 拆成三章 → 再拆段」
 *    始终等于「最新章号 + 在未交付的段里排第几」。
 * 2. **老工程**（`plots/` 扁平、段与章同号、一份卷纲都没有）打开后必须照旧：
 *    拆过的显示成章，没拆的显示成剧情段，而且不被拉回「先把大纲拆成卷」。
 * 3. **卷改名要搬三棵目录树**。只搬 `plots/` 那一棵的话，一卷改名之后每一段都会
 *    显示「还没拆场景」，而那些场景就躺在旁边一个孤儿目录里——界面上完全看不出。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
const dirs = [];

const wsOf = (project) => new bundle.ws.Workspace(project);
const acceptOn = (project) => (target, artifact) =>
  bundle.accept.acceptArtifact(project, target, artifact);

/** 一份「排过剧情」的四节（剧情脉络非空，isPlotFilled 才认）。 */
const filled = (goal) => ({ ...bundle.plotFile.emptyPlotSections(), 目标: goal, 剧情脉络: '甲、乙、丙。' });

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    accept: './src/core/generation/accept.ts',
    tree: './src/core/views/projectView.ts',
    split: './src/core/features/splitChapter.ts',
    plotFile: './src/core/model/plotFile.ts',
    volumeFile: './src/core/model/volumeFile.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
});

after(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
});

describe('分卷层 · 大纲 → 卷 → 段 → 章 走一遍', () => {
  const V = '.novelforge/volumes/01-觉醒之日.md';
  const P1 = '.novelforge/plots/01-觉醒之日/001-高烧.md';
  let t;
  let project;
  let created;
  let tree;
  let treeAfter;

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'volflow', title: '端到端' });
    dirs.push(t.dir);
    project = t.project;
    const accept = acceptOn(project);

    await accept({ kind: 'outline' }, { kind: 'outlineDoc', text: '赤星临近，全球异变。' });
    await accept(
      { kind: 'outline' },
      {
        kind: 'volumeList',
        volumes: [
          { title: '觉醒之日', goal: '活着走出青云镇', arc: '从客栈发烧醒来，到决定往北走。' },
          { title: '北行', goal: '找到第三块令牌', arc: '' },
        ],
      }
    );
    // 一次一段，拆两段。
    for (const [title, goal] of [['高烧', '第一次用出能力'], ['楼道', '拿到三楼那把钥匙']]) {
      await accept({ kind: 'volume', volumeRelPath: V }, {
        kind: 'plotSegment',
        segment: { title, goal, arc: '第一幕' },
      });
    }
    // 第一段写三次正文（每次追加之间自动插一行 `---` 当断点候选）。
    for (const text of ['她在高烧里醒来。', '窗外的城市在变。', '门被敲响了。']) {
      await accept({ kind: 'manuscript', plotRelPath: P1 }, { kind: 'manuscript', text });
    }

    h.expect('拆分');
    created = await bundle.split.splitManuscript(project, P1);
    project.invalidate();
    tree = await bundle.tree.buildProjectTree(project);

    // 再拆一段：位次应该接着往下数，而不是回到 2。
    await accept({ kind: 'volume', volumeRelPath: V }, {
      kind: 'plotSegment',
      segment: { title: '街口', goal: '逃出公寓楼', arc: '' },
    });
    project.invalidate();
    treeAfter = await bundle.tree.buildProjectTree(project);
  });

  test('段落进这一卷的目录', () => {
    assert.ok(t.has(P1), P1);
  });

  test('一段拆成三章', () => {
    assert.deepEqual(created, ['chapters/001-高烧.md', 'chapters/002.md', 'chapters/003.md']);
  });

  test('卷行报「拆出/交付了几段」', () => {
    const first = tree.volumes.find((v) => v.no === 1);
    assert.equal(first.segmentCount, 2, JSON.stringify(first));
    assert.equal(first.deliveredCount, 1, JSON.stringify(first));
  });

  test('还没排走向的第二卷是空壳', () => {
    assert.equal(tree.volumes.find((v) => v.no === 2).filled, false);
  });

  // 时间线：已发布的章在前，还没交付的段在后。
  test('章节组是三章 + 一个剧情段', () => {
    assert.deepEqual(
      tree.plots.map((p) => `${p.kind}:${p.label}`),
      ['chapter:第 1 章《高烧》', 'chapter:第 2 章', 'chapter:第 3 章', 'segment:剧情 4《楼道》']
    );
  });

  // 这就是位次的全部意义：一段拆成三章之后，剩下的段自动从 4 开始。
  test('剩下那一段的位次自动从 4 开始', () => {
    assert.equal(tree.plots.at(-1).no, 4);
  });

  // 「段 → 章」的链：拆出来的三章都指得回那一份规划稿。
  test('三章都指得回它们的来源段', () => {
    for (const row of tree.plots.filter((p) => p.kind === 'chapter')) {
      assert.equal(row.plotPath, P1, JSON.stringify(row));
    }
  });

  test('已交付的那一段不再单独占一行', () => {
    assert.ok(
      !tree.plots.some((p) => p.kind === 'segment' && p.title === '高烧'),
      JSON.stringify(tree.plots.map((p) => p.label))
    );
  });

  test('再拆一段时位次接着往下数', () => {
    assert.deepEqual(
      treeAfter.plots.filter((p) => p.kind === 'segment').map((p) => p.label),
      ['剧情 4《楼道》', '剧情 5《街口》']
    );
  });

  // 段号跨 `plots/` 与 `chapters/` 取最大号 +1（好让新建的段在文件名上排在最后），
  // 所以三章落盘之后新建的段是 `004`，而它显示成「剧情 5」——两者本来就不是一回事。
  // 段号从此可能与章号撞车，正因如此「老口径同号兜底」只对 `plots/` 根下的段生效。
  test('段号（文件名前缀）与位次是两回事', () => {
    assert.ok(
      t.has('.novelforge/plots/01-觉醒之日/004-街口.md'),
      '第三段的文件名前缀该接在最大号（章号 3）之后'
    );
    assert.equal(treeAfter.plots.at(-1).label, '剧情 5《街口》');
  });
});

/**
 * 老工程：`plots/` 扁平、段与章同号、一份卷纲都没有。**一个字节都不用改就得能用。**
 */
describe('分卷层 · 老工程照旧', () => {
  let t;
  let tree;

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'legacy', title: '老工程' });
    dirs.push(t.dir);
    const project = t.project;
    const ws = wsOf(project);
    t.write('.novelforge/outline.md', '# 大纲\n\n有内容。\n');
    // 五段扁平细纲，其中前三段早就拆成章发布了（老口径：段与章同号）。
    for (let no = 1; no <= 5; no++) {
      await ws.writePlot({
        no,
        title: `第${no}段`,
        arc: '',
        upstreamHash: '',
        done: false,
        chapters: [],
        sections: filled('x'),
      });
    }
    for (let no = 1; no <= 3; no++) {
      t.write(`chapters/00${no}-第${no}段.md`, `# 第${no}段\n\n正文。\n`);
    }
    project.invalidate();
    tree = await bundle.tree.buildProjectTree(project);
  });

  // 老口径的兜底：没有 `chapters` 记录、段又在 `plots/` 根下时按同号认。
  test('拆过的三段显示成已发布的章', () => {
    assert.deepEqual(
      tree.plots.filter((p) => p.kind === 'chapter').map((p) => p.label),
      ['第 1 章《第1段》', '第 2 章《第2段》', '第 3 章《第3段》']
    );
  });

  test('没拆的两段显示成剧情段，位次从 4 起', () => {
    assert.deepEqual(
      tree.plots.filter((p) => p.kind === 'segment').map((p) => p.label),
      ['剧情 4《第4段》', '剧情 5《第5段》']
    );
  });

  // 一份卷纲都没有，但它写了 99 章——把它拉回「先把大纲拆成卷」是荒唐的。
  test('有章就算在写，不被拉回拆卷', () => {
    assert.equal(tree.bookStage, 'working');
  });

  test('卷那一组是空的，但不报错', () => {
    assert.deepEqual(tree.volumes, []);
  });
});

/**
 * 卷改名：卷词干是它收纳的段、那些段的场景与中转站正文**三处的第一级目录名**，
 * 所以三棵树都得跟着走。只搬 `plots/` 那一棵的话，界面上会说每一段都「还没拆场景」，
 * 而那些场景就躺在旁边一个孤儿目录里。
 */
describe('分卷层 · 卷改名搬三棵目录树', () => {
  let t;
  let project;
  let plot;

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'volrename', title: '改名' });
    dirs.push(t.dir);
    project = t.project;
    const ws = wsOf(project);

    const V = await ws.writeVolume({
      no: 1,
      title: '觉醒',
      upstreamHash: '',
      done: false,
      sections: { ...bundle.volumeFile.emptyVolumeSections(), 剧情走向: '甲、乙。' },
    });
    const P = await ws.writePlot(
      { no: 1, title: '高烧', arc: '', upstreamHash: '', done: false, chapters: [], sections: filled('x') },
      undefined,
      project.plotsMirrorRelPathForVolume(V)
    );
    await ws.appendToManuscript(P, '正文一段。');

    const volume = await project.readVolume(V);
    await ws.writeVolume({ ...volume, title: '觉醒之日' });
    project.invalidate();
    plot = await project.readPlot('.novelforge/plots/01-觉醒之日/001-高烧.md');
  });

  for (const rel of [
    '.novelforge/volumes/01-觉醒之日.md',
    '.novelforge/plots/01-觉醒之日/001-高烧.md',
    '.novelforge/manuscripts/01-觉醒之日/001-高烧.md',
  ]) {
    test(`改名后 ${rel} 在新位置`, () => {
      assert.ok(t.has(rel), rel);
    });
  }

  for (const rel of [
    '.novelforge/volumes/01-觉醒.md',
    '.novelforge/plots/01-觉醒',
    '.novelforge/manuscripts/01-觉醒',
  ]) {
    test(`旧的 ${rel} 不再留下孤儿`, () => {
      assert.ok(!t.has(rel), rel);
    });
  }

  test('段的内容没丢', () => {
    assert.equal(plot?.title, '高烧', JSON.stringify(plot?.title));
  });
});
