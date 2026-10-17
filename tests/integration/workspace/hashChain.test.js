/**
 * 指纹链的记账**下沉到写入路径本身**：谁写都记。
 *
 * 一章只有一份细纲（`summaries/NNN-标题.md`），链上三环的上游指纹都记在它的 frontmatter 里：
 *
 * ```
 * outline.md 里覆盖第 N 章那一节 ─▶ summaries/N.md 的 upstreamHash（写细纲时记）
 * summaries/N.md 的八个小节       ─▶ summaries/N.md 的 writtenFrom （写正文时记，定稿时刷新）
 * chapters/N 的正文               ─▶ summaries/N.md 的 sourceHash  （定稿反向更新时记）
 * ```
 *
 * 后两环记在**细纲**上而不是章节上：章节是作者的文件，可以是 `.txt`、没有
 * frontmatter（第 9 条），这条链只能从细纲指过去。定稿从前另写一份单章摘要，
 * 现在是把同一份细纲照正文反向更新，旧版先复制进回收站。
 *
 * 两条不能碰的既有取舍（AGENTS 第 18 条）也在这里守：
 * - `plotContentHash` 只哈希八个小节，不含 frontmatter——记一笔 writtenFrom、
 *   标一次 done、改个标题、定稿记一笔 sourceHash 都不该让正文标脏；
 * - 手写的产物永不标脏。
 *
 * 另外守两条取舍：
 * - **大纲按区间分节，细纲只记覆盖本章那一节的指纹**——续写第 41–60 章不该让前 40 章的
 *   细纲全挂 ⟳；
 * - **定稿时把 writtenFrom 刷成更新后的指纹**——定稿刚改完细纲正文不挂 ⟳，定稿之后作者
 *   再改细纲，正文才挂 ⟳（作者定案 7）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（没抛）';
}

/** 从磁盘上那份文件的 frontmatter 里抠一个字段。 */
function fm(relPath, key) {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(t.read(relPath));
  return m ? m[1].trim() : undefined;
}

/** frontmatter 之后的那一段（`---` 围栏之外的全部字节）。 */
function bodyOf(relPath) {
  return t.read(relPath).replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** 一份排过的细纲（「关键事件」非空，isPlotFilled 才认）。 */
const filled = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '林昭进入青云宗。',
  出场人物: '林昭',
  关键事件: '他在山门外等到天黑，翻过侧峰。',
  看点: '藏书阁里有人在等他。',
  ...extra,
});

/** 一份最小的可写细纲。 */
const writable = (no, title, extra = {}) => ({
  no, title, upstreamHash: '', done: false, sections: filled(), ...extra,
});

/** 定稿时模型答回来的八节（反向更新之后的样子）。 */
const finalized = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '他去了，在山门外蹲了两个时辰。',
  出场人物: '林昭',
  关键事件: '林昭在山门外等到天黑。',
  看点: '- 藏书阁的灯一直亮着。',
  连续性事实: '- 林昭在山门外蹲了两个时辰 〔证据：「他蹲了两个时辰」〕',
  ...extra,
});

/** 按区间分节的大纲。 */
const OUTLINE = [
  '# 大纲',
  '',
  '## 第1–20章：第一幕 · 入局',
  '',
  '林昭进青云宗。',
  '',
  '## 第21–40章：第二幕 · 名册',
  '',
  '名册现世。',
  '',
].join('\n');

const setOutline = (text) => {
  t.write('.novelforge/outline.md', text);
  project.invalidate();
};

/** 第 no 章细纲的上游指纹——与网关记账、流水线判脏用的是同一个函数。 */
const sliceHash = async (no) => bundle.outlineFile.outlineUpstreamHash(await project.readOutline(), no);

/** 按号取这一章的流水线（细纲 + 同号章节）。 */
async function pipelineOf(no) {
  project.invalidate();
  const plot = await project.getPlot(no);
  return bundle.pipe.buildPlotPipeline(project, { no, plot });
}

/** 按号取章节（读盘之前先失效缓存）。 */
async function chapterOf(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
    ws: './src/core/workspace/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wshash' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
  setOutline(OUTLINE);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('细纲 · 写入就记 upstreamHash（大纲里覆盖本章那一节）', () => {
  const rel = '.novelforge/summaries/012-入宗.md';

  before(async () => {
    await ws.writePlot(writable(12, '入宗', { upstreamHash: await sliceHash(12) }));
  });

  test('落在 summaries/ 根下，名字带三位序号', () => {
    assert.ok(t.has(rel), rel);
  });

  test('frontmatter 里有 upstreamHash', async () => {
    assert.equal(fm(rel, 'upstreamHash'), await sliceHash(12));
  });

  // 记的是**那一节**：拿全书的指纹的话，续写一次大纲就让前面所有章挂 ⟳。
  test('记的是覆盖本章那一节的指纹，不是全书的', async () => {
    assert.notEqual(fm(rel, 'upstreamHash'), bundle.fs.hash(await project.readOutline()));
  });

  // **这是记账下沉修的那个缺陷**：改大纲之后作者在编辑器里改细纲，从前 upstreamHash
  // 不会跟着更新，那一章从此永远挂着一个洗不掉的 ⟳。
  test('改了那一节后直接 write 细纲文本，upstreamHash 跟着更新', async () => {
    setOutline(OUTLINE.replace('林昭进青云宗。', '林昭进青云宗（改过）。'));
    const next = await sliceHash(12);
    assert.notEqual(fm(rel, 'upstreamHash'), next, '前置：此刻还是旧的');

    const current = t.read(rel);
    await ws.write(rel, { text: current.replace('翻过侧峰', '翻过后山') }, {
      mode: 'overwrite',
      review: false,
    });
    assert.equal(fm(rel, 'upstreamHash'), next);
  });

  test('正文内容照样写进去了', () => {
    assert.ok(t.read(rel).includes('翻过后山'), t.read(rel));
  });

  // 不经采纳、不经 writePlot，纯 edit 一处也记账。
  test('edit 定点改一处也记 upstreamHash', async () => {
    setOutline(OUTLINE.replace('林昭进青云宗。', '林昭进青云宗（再改）。'));
    const next = await sliceHash(12);
    await ws.edit(rel, [{ old: '翻过后山', new: '绕过前山' }]);
    assert.equal(fm(rel, 'upstreamHash'), next);
  });

  test('H1 写成「第N章 标题」', () => {
    assert.ok(t.read(rel).includes('# 第12章 入宗'), t.read(rel).slice(0, 300));
  });

  test('八节都落盘，空的留占位', () => {
    const text = t.read(rel);
    for (const key of bundle.plotFile.PLOT_SECTION_KEYS) {
      assert.ok(text.includes(`## ${key}`), `缺「${key}」：${text}`);
    }
  });
});

/**
 * 大纲是一段一段续写的，改的也往往只是其中一节。**只有覆盖那几章的细纲标脏**：
 * 从前按全书指纹算，改一句第二幕的走向就换来一屏 ⟳，作者很快学会无视它。
 */
describe('细纲 · 大纲改了哪一节，只标脏那一节覆盖的章', () => {
  let afterAppend;
  let afterSecond;
  let afterFirst;

  before(async () => {
    setOutline(OUTLINE);
    // 第 5 章在第一幕、第 25 章在第二幕、第 50 章哪一节都不覆盖（退回全书指纹）。
    for (const [no, title] of [[5, '入局'], [25, '名册'], [50, '远方']]) {
      await ws.writePlot(writable(no, title, { upstreamHash: await sliceHash(no) }));
    }
    const staleOf = async () =>
      Object.fromEntries(
        await Promise.all([5, 25, 50].map(async (no) => [no, (await pipelineOf(no)).plot.upstreamStale]))
      );

    // 续写一节：第 41–60 章。
    setOutline(`${OUTLINE}## 第41–60章：第三幕 · 火\n\n火灾真相。\n`);
    afterAppend = await staleOf();

    // 只改第二幕那一节。
    setOutline(`${OUTLINE.replace('名册现世。', '名册被烧了一半。')}## 第41–60章：第三幕 · 火\n\n火灾真相。\n`);
    afterSecond = await staleOf();

    // 再改第一幕的标题——区间标题也是那一节的一部分。
    setOutline(
      `${OUTLINE.replace('名册现世。', '名册被烧了一半。').replace('第一幕 · 入局', '第一幕 · 回镇')}` +
        '## 第41–60章：第三幕 · 火\n\n火灾真相。\n'
    );
    afterFirst = await staleOf();
  });

  test('续写新的一节，前两幕的细纲都不挂 ⟳', () => {
    assert.equal(afterAppend[5], false, JSON.stringify(afterAppend));
    assert.equal(afterAppend[25], false, JSON.stringify(afterAppend));
  });

  // 第 50 章从前落在「哪一节都不覆盖」里，记的是全书指纹；新的一节正好覆盖到它，
  // 它的上游从此换成那一节——确实变了，标脏是对的。
  test('从前没有着落的章，被新的一节覆盖之后标脏', () => {
    assert.equal(afterAppend[50], true, JSON.stringify(afterAppend));
  });

  test('只改第二幕：第 25 章标脏', () => {
    assert.equal(afterSecond[25], true, JSON.stringify(afterSecond));
  });

  test('只改第二幕：第 5 章不受牵连', () => {
    assert.equal(afterSecond[5], false, JSON.stringify(afterSecond));
  });

  test('改了第一幕的区间标题：第 5 章也标脏', () => {
    assert.equal(afterFirst[5], true, JSON.stringify(afterFirst));
  });

  after(() => setOutline(OUTLINE));
});

describe('细纲 · 手写的产物永不标脏（第 18a 条）', () => {
  const rel = '.novelforge/summaries/021-手写.md';

  before(async () => {
    // 作者在 vim 里敲出来的细纲：没有 frontmatter，也就没有上游。
    t.write(rel, '## 梗概\n\n我自己写的\n\n## 关键事件\n\n甲乙丙\n');
    project.invalidate();
    await ws.write(rel, { text: '## 梗概\n\n我自己写的\n\n## 关键事件\n\n甲乙丙丁\n' }, {
      mode: 'overwrite',
      review: false,
    });
  });

  test('改了内容', () => {
    assert.ok(t.read(rel).includes('甲乙丙丁'), t.read(rel));
  });

  // 拿一个凭空的过期标记去催作者重做，他会学会无视所有标记。
  test('没有 frontmatter 的细纲不会被凭空补上 upstreamHash', () => {
    assert.ok(!t.read(rel).includes('upstreamHash'), t.read(rel));
  });

  test('视图层照样不标脏', async () => {
    const plot = await project.readPlot(rel);
    const p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
    assert.equal(p.plot.upstreamStale, false);
  });

  // writePlot 是**领域写入器**：调用方把整份 frontmatter 都说全了，
  // 包括「这一章没有上游」。newPlotFlow 正是这样建出手工新章的。
  test('writePlot 传空 upstreamHash 时不被补上', async () => {
    const bare = await ws.writePlot(writable(22, '', { sections: bundle.plotFile.emptyPlotSections() }));
    assert.ok(!t.read(bare).includes('upstreamHash'), t.read(bare));
  });

  // 同一条理由的另一环：手写的细纲不在这条链上，写正文时也不给它补一个 writtenFrom。
  test('没有 frontmatter 的细纲不记 writtenFrom', async () => {
    const before = t.read(rel);
    const ok = await ws.recordWrittenFrom(rel, 'SOME_HASH');
    assert.equal(ok, false);
    assert.equal(t.read(rel), before);
  });

  test('细纲不存在时 recordWrittenFrom 返回 false，不抛', async () => {
    assert.equal(await ws.recordWrittenFrom('.novelforge/summaries/099-不存在.md', 'X'), false);
  });
});

describe('正文 · 落盘时在细纲上记 writtenFrom', () => {
  const plotRel = '.novelforge/summaries/012-入宗.md';
  let chapterRel;
  let plotHash;
  let bodyBefore;
  let recorded;
  let fresh;

  before(async () => {
    // 正文落盘那一步的两件事：写同号章节，再在细纲上记 writtenFrom
    // （generation/accept.ts 与批量写正文都是这两步）。
    plotHash = bundle.plotFile.plotContentHash(await project.readPlot(plotRel));
    bodyBefore = bodyOf(plotRel);
    chapterRel = await ws.createChapter(12, '入宗', '他蹲了两个时辰。');
    recorded = await ws.recordWrittenFrom(plotRel, plotHash);
    fresh = await pipelineOf(12);
  });

  test('正文落在同号的章节上', () => {
    assert.equal(chapterRel, 'chapters/012-入宗.md', chapterRel);
  });

  test('记上了', () => {
    assert.equal(recorded, true);
  });

  test('writtenFrom 是细纲的内容指纹', () => {
    assert.equal(fm(plotRel, 'writtenFrom'), plotHash);
  });

  // 只改 `---` 之间那一段：作者可能在细纲里加过自定义小节，整份重渲染会把它们抹平。
  test('记账只动 frontmatter，细纲正文一个字节不动', () => {
    assert.equal(bodyOf(plotRel), bodyBefore);
  });

  // 章节是作者的文件：这条链上的账一笔都不往它身上记。
  test('章节文件里没有任何指纹', () => {
    const text = t.read(chapterRel);
    assert.ok(!/writtenFrom|upstreamHash|sourceHash/.test(text), text);
  });

  test('刚写完的正文不标脏', () => {
    assert.equal(fresh.chapter.upstreamStale, false, JSON.stringify(fresh.chapter));
  });

  test('同一个指纹再记一次是空操作', async () => {
    const before = t.read(plotRel);
    assert.equal(await ws.recordWrittenFrom(plotRel, plotHash), true);
    assert.equal(t.read(plotRel), before);
  });

  // **第 18b 条**：writtenFrom 自己就在 frontmatter 里，算进内容指纹的话，
  // 记一笔账就会让刚写好的正文立刻过期。
  test('记 writtenFrom 不改变细纲的内容指纹', async () => {
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), plotHash);
  });

  describe('改细纲 → 正文标脏', () => {
    let stale;
    let writtenFromAfterEdit;
    let reWritten;

    before(async () => {
      // 作者在编辑器里改细纲：走 edit，handler 顺手重记 upstreamHash。
      await ws.edit(plotRel, [{ old: '绕过前山', new: '从后山的水道游进去' }]);
      writtenFromAfterEdit = fm(plotRel, 'writtenFrom');
      stale = await pipelineOf(12);

      // 照着新细纲再写一遍正文，重新记账。
      await ws.write(chapterRel, { text: '他从水道游了进去。' }, { mode: 'append' });
      await ws.recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(await project.readPlot(plotRel)));
      reWritten = await pipelineOf(12);
    });

    // 编辑器那条路只记 upstreamHash，**不许**把正文那一侧记的账抹掉——
    // 抹掉了这一章就再也不会标脏（writtenFrom 为空 = 手写的正文）。
    test('编辑器里改细纲不会抹掉 writtenFrom', () => {
      assert.equal(writtenFromAfterEdit, plotHash);
    });

    test('改细纲后正文标脏', () => {
      assert.equal(stale.chapter.upstreamStale, true, JSON.stringify(stale.chapter));
    });

    test('标脏的那一章流水线退回待写正文（重写）', () => {
      assert.equal(stale.stage, 'manuscript', stale.stage);
    });

    test('照着新细纲重写并记账之后不再标脏', () => {
      assert.equal(reWritten.chapter.upstreamStale, false, JSON.stringify(reWritten.chapter));
    });
  });

  describe('改 frontmatter 不动内容指纹（第 18b 条）', () => {
    let hashBefore;

    before(async () => {
      hashBefore = bundle.plotFile.plotContentHash(await project.readPlot(plotRel));
    });

    // 出场人物现在是八节之一（计划出场），改它就是改细纲；目标字数在 frontmatter 里，改它不是。
    test('改目标字数，内容指纹不变', async () => {
      const p = await project.readPlot(plotRel);
      await ws.writePlot({ ...p, targetWords: 4000 });
      assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), hashBefore);
    });

    // writePlot 收整份领域对象：调用方把读回来的那份原样递回来时，正文那一侧记的账
    // 跟着带过去，不在「改个字数」的时候悄悄丢掉。
    test('整份重写细纲时 writtenFrom 跟着带过去', async () => {
      const p = await project.readPlot(plotRel);
      assert.equal(p.writtenFrom, bundle.plotFile.plotContentHash(p));
    });

    test('把细纲标 done 不改变它的内容指纹', async () => {
      const p = await project.readPlot(plotRel);
      await ws.writePlot({ ...p, done: true });
      assert.equal(fm(plotRel, 'status'), 'done');
      assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), hashBefore);
    });

    test('把细纲标 done 之后正文不标脏', async () => {
      const p = await pipelineOf(12);
      assert.equal(p.chapter.upstreamStale, false, JSON.stringify(p.chapter));
    });
  });
});

/**
 * 链的最后一环：定稿记的是**章节**的 contentHash——细纲反向更新成的是写出来的那一章。
 * 定稿只改细纲，章节一个字节不动，否则刚记下的 sourceHash 当场就对不上。
 */
describe('正文 → 定稿 · sourceHash 记的是章节的 contentHash', () => {
  const plotRel = '.novelforge/summaries/012-入宗.md';
  let chapter;
  let chapterTextBefore;
  let chapterTextAfter;
  let result;
  let freshStale;
  let afterAppend;

  before(async () => {
    chapter = await chapterOf(12);
    chapterTextBefore = t.read(chapter.relPath);
    result = await ws.finalizePlot(chapter, finalized(), [{ name: '林昭', aliases: [] }]);
    chapterTextAfter = t.read(chapter.relPath);
    project.invalidate();
    freshStale = (await project.staleChapters()).some((c) => c.order === 12);

    await ws.write(chapter.relPath, { text: '天亮了。' }, { mode: 'append' });
    afterAppend = await pipelineOf(12);
  });

  // 同一章只有一份细纲：定稿改的就是它，不在 summaries/ 里另起一份。
  test('写回同号的那一份细纲', () => {
    assert.equal(result.rel, plotRel, JSON.stringify(result));
  });

  test('sourceHash 就是章节的 contentHash', () => {
    assert.equal(fm(plotRel, 'sourceHash'), chapter.contentHash);
  });

  test('cast 落进 frontmatter', () => {
    assert.equal(fm(plotRel, 'cast'), '[林昭]');
  });

  test('定稿不碰章节文件', () => {
    assert.equal(chapterTextAfter, chapterTextBefore);
  });

  test('刚定稿的章不算过期', () => {
    assert.equal(freshStale, false);
  });

  test('章节追加了正文，定稿过期', () => {
    assert.equal(afterAppend.summary.stale, true, JSON.stringify(afterAppend.summary));
  });
});

/**
 * 定稿是**修改**，不是重写：八节整体换成反向更新后的那一版，作者定的与计划那一侧的账
 * （标题、目标字数、大纲指纹、done、两种放行）原样留着。旧版先复制进回收站——定稿按钮本身就是
 * 作者的确认，所以直接写；但改掉的是一份作者可能逐字推敲过的计划，要找得回来。
 */
describe('定稿 · 保留 frontmatter，旧版进回收站', () => {
  const plotRel = '.novelforge/summaries/060-夜雨.md';
  const trashRel = '.novelforge/.trash/.novelforge/summaries/060-夜雨.md';
  const OLD_SECTIONS = () =>
    filled({
      梗概: '计划：林昭冒雨去青崖镇。',
      关键事件: '计划：他在镇口被拦下，亮出令牌。',
      连续性事实: '- 旧的事实 〔证据：「旧句子」〕',
    });
  const cast = [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈氏', aliases: [] }];
  let chapter;
  let before1;
  let first;
  let afterFirst;
  let second;
  let plot;

  before(async () => {
    t.write(
      plotRel,
      bundle.plotFile.renderPlotFile({
        no: 60,
        title: '夜雨',
        targetWords: 3000,
        upstreamHash: 'UPSTREAM60',
        done: true,
        preflightOk: [{ name: '沈秋', reason: '回忆里的一场' }],
        factCheckOk: true,
        sections: OLD_SECTIONS(),
      })
    );
    // 作者后来把章节改了个名：定稿认的是同号那一份细纲，标题也以细纲为准。
    await ws.createChapter(60, '雨夜', '他蹲了两个时辰，雨一直没停。');
    chapter = await chapterOf(60);
    before1 = t.read(plotRel);
    first = await ws.finalizePlot(chapter, finalized(), cast);
    afterFirst = t.read(plotRel);
    project.invalidate();
    plot = await project.readPlot(plotRel);
    second = await ws.finalizePlot(chapter, finalized({ 梗概: '第二次定稿。' }), cast);
  });

  test('落点仍是原来那份细纲', () => {
    assert.equal(first.rel, plotRel, JSON.stringify(first));
  });

  test('返回旧版在回收站里的位置（保留原相对路径）', () => {
    assert.equal(first.trashed, trashRel, JSON.stringify(first));
  });

  // 是复制不是搬走：搬走的话定稿写入失败时这一章就没有细纲了。
  test('回收站里那份与定稿前一字不差', () => {
    assert.equal(t.read(trashRel), before1);
  });

  test('八节整体换成反向更新后的那一版', () => {
    assert.deepEqual({ ...plot.sections }, finalized());
  });

  test('旧计划的措辞不留在细纲里', () => {
    assert.ok(!afterFirst.includes('计划：'), afterFirst);
  });

  test('标题沿用细纲的，不换成章节的', () => {
    assert.equal(plot.title, '夜雨');
  });

  test('目标字数留着', () => {
    assert.equal(plot.targetWords, 3000);
  });

  test('大纲指纹留着', () => {
    assert.equal(plot.upstreamHash, 'UPSTREAM60');
  });

  test('作者手标的 done 留着', () => {
    assert.equal(plot.done, true);
  });

  test('预检的永久放行留着', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(plot.preflightOk)), [{ name: '沈秋', reason: '回忆里的一场' }]);
  });

  test('写前冲突检查的放行留着', () => {
    assert.equal(plot.factCheckOk, true);
  });

  test('sourceHash 记的是正文的 contentHash', () => {
    assert.equal(plot.sourceHash, chapter.contentHash);
  });

  test('cast 写成一项一人、别名跟在括号里', () => {
    assert.equal(fm(plotRel, 'cast'), '[林昭(阿昭), 沈氏]');
  });

  // 不刷的话，定稿刚改完细纲，正文立刻挂 ⟳（「细纲在正文之后改过」）。
  test('writtenFrom 刷成更新后的内容指纹', () => {
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  // 同名不覆盖之前进回收站的那一份（第 6 条的落点规则）。
  test('再定稿一次，旧版加 -2 序号进回收站', () => {
    assert.equal(second.trashed, '.novelforge/.trash/.novelforge/summaries/060-夜雨-2.md', JSON.stringify(second));
  });

  test('-2 那份是第一次定稿后的内容', () => {
    assert.equal(t.read(second.trashed), afterFirst);
  });

  test('第一次进回收站的那份没被盖掉', () => {
    assert.equal(t.read(trashRel), before1);
  });
});

/**
 * 定稿时旧版进了 `.trash/<原相对路径>`；之后作者删掉这份细纲，删除也落在同一个路径上。
 * 回收站的规矩是同名加序号、不覆盖之前进去的东西（AGENTS 第 6 条）——否则定稿前那一版计划
 * 就被这次删除悄悄盖掉了，作者再也找不回来。
 */
describe('删定稿过的细纲 · 不盖掉定稿时进回收站的旧版', () => {
  const plotRel = '.novelforge/summaries/060-夜雨.md';
  const trashRel = '.novelforge/.trash/.novelforge/summaries/060-夜雨.md';
  let planBefore;
  let current;
  let deleted;

  before(async () => {
    planBefore = t.read(trashRel);
    current = t.read(plotRel);
    deleted = await ws.deletePlot(plotRel);
  });

  test('删掉了', () => {
    assert.equal(deleted, true);
    assert.ok(!t.has(plotRel));
  });

  test('定稿前那一版仍在回收站里', () => {
    assert.equal(t.read(trashRel), planBefore);
  });

  test('删掉的这一版另起序号进回收站', () => {
    assert.equal(t.read('.novelforge/.trash/.novelforge/summaries/060-夜雨-3.md'), current);
  });
});

/**
 * 还没有细纲的章（拆书导入、作者手写的正文）定稿时新建一份：落点按章号与章节标题拼，
 * 回落标题「第 N 章」不进文件名（与 plotPathForNo 同一条规矩）。
 */
describe('定稿 · 没有细纲的章新建一份', () => {
  let titled;
  let bare;

  before(async () => {
    await ws.createChapter(61, '残灯', '灯芯烧到了底。');
    titled = await ws.finalizePlot(await chapterOf(61), finalized(), [{ name: '林昭', aliases: [] }]);
    await ws.createChapter(62, '', '没有名字的一章。');
    bare = await ws.finalizePlot(await chapterOf(62), finalized(), []);
  });

  test('落在 summaries/NNN-<章节标题>.md', () => {
    assert.equal(titled.rel, '.novelforge/summaries/061-残灯.md', JSON.stringify(titled));
  });

  test('原来没有细纲，不报回收站', () => {
    assert.equal(titled.trashed, undefined);
  });

  test('新建的那份定稿过（sourceHash 对得上正文）', async () => {
    const plot = await project.readPlot(titled.rel);
    assert.equal(plot.sourceHash, (await chapterOf(61)).contentHash);
  });

  test('新建的那份没有大纲指纹与目标字数', () => {
    assert.ok(!/upstreamHash|targetWords/.test(t.read(titled.rel)), t.read(titled.rel));
  });

  test('回落标题不进文件名：summaries/NNN.md', () => {
    assert.equal(bare.rel, '.novelforge/summaries/062.md', JSON.stringify(bare));
  });
});

/**
 * 定稿之后又改了细纲：**正文挂 ⟳**，提醒正文可能没跟上（作者定案 7）；这一章仍算写完——
 * 定稿看的是正文有没有改过，不是细纲。反过来定稿之后改了正文，就回到「待定稿」。
 */
describe('定稿之后 · 改细纲正文挂 ⟳，改正文回到待定稿', () => {
  const plotRel = '.novelforge/summaries/070-远行.md';
  let beforeFinalize;
  let done;
  let plotEdited;
  let refinalized;
  let proseEdited;

  before(async () => {
    await ws.writePlot(writable(70, '远行', { targetWords: 8 }));
    await ws.createChapter(70, '远行', '他背上藤箱出了门，一路往北走。');
    await ws.recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(await project.readPlot(plotRel)));
    beforeFinalize = await pipelineOf(70);

    await ws.finalizePlot(await chapterOf(70), finalized({ 关键事件: '他背上藤箱出了门。' }), [
      { name: '林昭', aliases: [] },
    ]);
    done = await pipelineOf(70);

    // 作者在编辑器里改了定稿过的细纲的一节。
    await ws.edit(plotRel, [{ old: '他背上藤箱出了门。', new: '他背上藤箱，天没亮就出了门。' }]);
    plotEdited = await pipelineOf(70);

    // 重新定稿一次（writtenFrom 刷新），再去改正文。
    await ws.finalizePlot(await chapterOf(70), finalized({ 关键事件: '他背上藤箱出了门。' }), [
      { name: '林昭', aliases: [] },
    ]);
    refinalized = await pipelineOf(70);
    await ws.write('chapters/070-远行.md', { text: '走到镇口，天才亮。' }, { mode: 'append' });
    proseEdited = await pipelineOf(70);
  });

  test('前置：正文够了还没定稿，停在待定稿', () => {
    assert.equal(beforeFinalize.stage, 'finalize', beforeFinalize.stage);
  });

  test('定稿之后这一章写完了', () => {
    assert.equal(done.stage, 'done', done.stage);
  });

  // writtenFrom 在定稿时刷成了更新后的指纹，刚改完的细纲不算「在正文之后改过」。
  test('刚定稿完正文不挂 ⟳', () => {
    assert.equal(done.chapter.upstreamStale, false, JSON.stringify(done.chapter));
  });

  test('定稿之后改细纲，正文挂 ⟳', () => {
    assert.equal(plotEdited.chapter.upstreamStale, true, JSON.stringify(plotEdited.chapter));
  });

  // 定稿过的章不被拉回待写，只挂 ⟳（第 18 条）。
  test('定稿之后改细纲，这一章仍算写完', () => {
    assert.equal(plotEdited.stage, 'done', plotEdited.stage);
  });

  test('重新定稿之后 ⟳ 消失', () => {
    assert.equal(refinalized.chapter.upstreamStale, false, JSON.stringify(refinalized.chapter));
  });

  test('定稿之后改正文，回到待定稿', () => {
    assert.equal(proseEdited.stage, 'finalize', proseEdited.stage);
  });

  test('定稿之后改正文，定稿标过期', () => {
    assert.equal(proseEdited.summary.stale, true, JSON.stringify(proseEdited.summary));
  });
});

/** （从 workspace/split.test.js 挪过来）正文新建章节那条路的两条守卫。 */
describe('章节 · 同名一律报错退出，manifest 跟着同步', () => {
  let created;

  before(async () => {
    created = await ws.createChapter(1, '楔子', '雨下了三天。');
  });

  test('落在 chapters/ 下，带三位序号', () => {
    assert.equal(created, 'chapters/001-楔子.md', created);
  });

  test('同名一律报错退出，不覆盖', async () => {
    assert.equal(await codeOf(() => ws.createChapter(1, '楔子', '不该写进去')), 'exists');
    assert.ok(!t.read(created).includes('不该写进去'), t.read(created));
  });

  test('manifest 跟着同步', async () => {
    const manifest = await project.readManifest();
    assert.ok(manifest.chapters.some((c) => c.file === created), JSON.stringify(manifest.chapters));
  });
});

/**
 * 一次新建好几章（导入原稿）：每章照样过网关，manifest 最后同步一次——逐章同步是 O(n²) 次读盘。
 * 撞了同名照样报错退出：前面写好的留着，manifest 也照样同步到它们。
 */
describe('章节 · 一次新建好几章', () => {
  let made;
  let err;

  before(async () => {
    made = await ws.createChapters([
      { order: 41, title: '甲', content: '第四十一章。' },
      { order: 42, title: '', content: '第四十二章。' },
    ]);
    t.write('chapters/044-丁.md', '# 丁\n\n作者先放的。\n');
    project.invalidate();
    try {
      await ws.createChapters([
        { order: 43, title: '丙', content: '第四十三章。' },
        { order: 44, title: '丁', content: '不该写进去' },
        { order: 45, title: '戊', content: '不该写到这里' },
      ]);
    } catch (e) {
      err = e;
    }
  });

  test('一章一个文件，规则与 createChapter 一样', () => {
    assert.deepEqual(made, ['chapters/041-甲.md', 'chapters/042.md']);
    assert.equal(t.read('chapters/041-甲.md'), '# 甲\n\n第四十一章。\n');
    assert.equal(t.read('chapters/042.md'), '第四十二章。\n');
  });

  test('撞了同名报错退出，不覆盖、不往下写', () => {
    assert.equal(err?.code, 'exists');
    assert.ok(!t.read('chapters/044-丁.md').includes('不该写进去'));
    assert.ok(!t.has('chapters/045-戊.md'));
  });

  test('manifest 同步到写好的每一章（包括报错之前那一章）', async () => {
    const files = (await project.readManifest()).chapters.map((c) => c.file);
    for (const rel of ['chapters/041-甲.md', 'chapters/042.md', 'chapters/043-丙.md']) {
      assert.ok(files.includes(rel), rel);
    }
  });
});

/**
 * 细纲改名：正文挂在**章节**上，不跟着细纲走。从前改细纲名要连带搬走中转站里那份正文；
 * 一章一纲之后正文就是章节，细纲改名不必带走任何东西。定稿记的账在细纲自己的 frontmatter 里，
 * 跟着它走。
 */
describe('细纲改名 · 章节不跟着走，定稿的账跟着细纲走', () => {
  const from = '.novelforge/summaries/012-入宗.md';
  const to = '.novelforge/summaries/012-入宗风波.md';
  let hashBefore;
  let sourceHashBefore;
  let renamed;

  before(async () => {
    project.invalidate();
    const plot = await project.readPlot(from);
    hashBefore = bundle.plotFile.plotContentHash(plot);
    sourceHashBefore = plot.sourceHash;
    await ws.writePlot({ ...plot, title: '入宗风波' });
    renamed = await pipelineOf(12);
  });

  test('细纲改名成功', () => {
    assert.ok(t.has(to));
  });

  test('旧细纲没了，不会一章两份', () => {
    assert.ok(!t.has(from));
  });

  test('章节没被改名', () => {
    assert.ok(t.has('chapters/012-入宗.md'));
  });

  test('定稿记的 sourceHash 跟着带过去', () => {
    assert.equal(fm(to, 'sourceHash'), sourceHashBefore);
  });

  // 改个名字不该让这一章的正文凭空标脏：标题不在内容指纹里。
  test('改名不动内容指纹，正文不标脏', async () => {
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(to)), hashBefore);
    assert.equal(renamed.chapter.upstreamStale, false, JSON.stringify(renamed.chapter));
  });

  test('改名之后按号仍认得同号的章节', () => {
    assert.equal(renamed.chapter.relPath, 'chapters/012-入宗.md', JSON.stringify(renamed.chapter));
  });
});

describe('删细纲 · 不碰 chapters/', () => {
  const rel = '.novelforge/summaries/012-入宗风波.md';
  let deleted;
  let missing;

  before(async () => {
    deleted = await ws.deletePlot(rel);
    missing = await ws.deletePlot(rel);
  });

  test('返回 true', () => {
    assert.equal(deleted, true);
  });

  test('细纲进了回收站', () => {
    assert.ok(t.has('.novelforge/.trash/.novelforge/summaries/012-入宗风波.md'));
  });

  // 那是已经写出来的正文。删掉细纲只是放弃这一章的规划稿（定稿过的话连同档案），
  // 不该顺手把正文一起带走。
  test('chapters/ 里的正文没被动', () => {
    assert.ok(t.has('chapters/012-入宗.md'));
  });

  test('删已经删掉的返回 false，不抛', () => {
    assert.equal(missing, false);
  });
});

describe('细纲照样过八条守卫', () => {
  const rel = '.novelforge/summaries/030-占位.md';

  before(async () => {
    await ws.writePlot(writable(30, '占位'));
  });

  test('往越界路径写细纲被拒', async () => {
    assert.equal(await codeOf(() => ws.write('../summaries/001.md', { text: 'x' })), 'outOfRoot');
  });

  test('细纲的乐观锁照常生效', async () => {
    assert.equal(
      await codeOf(() => ws.write(rel, { text: 'x' }, { mode: 'overwrite', baseHash: '旧的' })),
      'conflict'
    );
  });

  test('细纲的覆盖审阅照常生效', async () => {
    const before = t.read(rel);
    h.expect('保留原样');
    const r = await ws.write(rel, { text: '不该写进去' }, { mode: 'overwrite' });
    assert.equal(r.skipped, true);
    assert.equal(t.read(rel), before);
  });

  // summaries/ 子目录（老工程按章节路径镜像的单章摘要）不在这条链上：判成普通文本，
  // 写进去也不记账——它们一个字节都不该被这条链改动。
  test('summaries/ 子目录里的老文件不记账', async () => {
    const legacy = '.novelforge/summaries/卷一/001-高烧.md';
    await ws.write(legacy, { text: '---\nchapter: 1\n---\n\n## 梗概\n\n老摘要\n' });
    assert.ok(!t.read(legacy).includes('upstreamHash'), t.read(legacy));
  });

  // 老工程的 plots/ 同理：代码不再读它，写进去也只是普通文本。
  test('老工程 plots/ 里的细纲不记账', async () => {
    const legacy = '.novelforge/plots/001-高烧.md';
    await ws.write(legacy, { text: '---\nno: 1\n---\n\n## 本章目的\n\n老三节\n\n## 关键事件\n\n甲\n' });
    assert.ok(!t.read(legacy).includes('upstreamHash'), t.read(legacy));
  });
});
