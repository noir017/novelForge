/**
 * 中转站正文 / 章节 / 摘要 / 草稿四个 handler，以及拆分那条路。
 *
 * 拆分是指纹链上**唯一的人工闸口**（AGENTS 第 18 / 23 条）：中转站那份拆完就
 * 删了，所以已发布的章不会被拉回「待写正文」。这一组守的是它的顺序——
 * **先移号再落盘**，反过来会留下「章节已建但细纲还撞着号」的中间态。
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

function fm(relPath, key) {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(t.read(relPath));
  return m ? m[1].trim() : undefined;
}

const filled = () => ({
  ...bundle.plotFile.emptyPlotSections(),
  目标: '进宗门。',
  剧情脉络: '甲乙丙。',
});

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipe: './src/core/views/pipeline.ts',
    ws: './src/core/workspace/index.ts',
    split: './src/core/features/splitChapter.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wssplit' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('中转站正文 · 追加与 upstreamHash', () => {
  const plotRel = '.novelforge/plots/012-入宗.md';
  const msRel = '.novelforge/manuscripts/012-入宗.md';

  before(async () => {
    await ws.writePlot({
      no: 12, title: '入宗', arc: '', upstreamHash: '', done: false, sections: filled(),
    });
    await ws.appendToManuscript(plotRel, '他在山门外等到天黑。');
  });

  test('落在中转站，不是 chapters/', () => {
    assert.ok(t.has(msRel));
    assert.ok(!t.has('chapters/012-入宗.md'));
  });

  test('首次写入带 frontmatter', () => {
    assert.equal(fm(msRel, 'plot'), plotRel);
  });

  test('首次写入带标题行', () => {
    assert.ok(t.read(msRel).includes('# 第12章 入宗 · 正文'), t.read(msRel));
  });

  // **记账下沉**：从前只在 acceptManuscript 里记。上游是这一段的细纲
  // （从前是它的场景集合，那一层已经删掉）。
  test('写正文就记细纲指纹', async () => {
    assert.equal(
      fm(msRel, 'upstreamHash'),
      bundle.pipe.plotContentHash(await project.readPlot(plotRel))
    );
  });

  // 那一行是默认的拆分候选点（第 23 条）：一次写作的边界最可能就是章节边界。
  test('两次追加之间插一行 ---', async () => {
    await ws.appendToManuscript(plotRel, '墙那边有人说话。');
    assert.ok(/\n---\n/.test(t.read(msRel)), t.read(msRel));
  });

  test('追加不覆盖，前一段还在', () => {
    const text = t.read(msRel);
    assert.ok(text.includes('等到天黑') && text.includes('有人说话'), text);
  });

  // 第 18b 条：contentHash 只哈希正文本身，写一次 upstreamHash 不该让摘要立刻过期。
  test('contentHash 不含 frontmatter 与标题行', async () => {
    const before = (await project.readManuscript(plotRel)).contentHash;
    const hashBefore = fm(msRel, 'upstreamHash');
    const p = await project.readPlot(plotRel);
    p.sections.剧情脉络 = '改成三拍：等、翻、被撞见。';
    await ws.writePlot(p);
    // 正文原样重写一遍：handler 会把新的 upstreamHash 记进 frontmatter，
    // 而正文一个字节没动。
    await ws.write(msRel, { text: t.read(msRel) }, { mode: 'overwrite', review: false });
    assert.notEqual(fm(msRel, 'upstreamHash'), hashBefore, '前置：细纲指纹确实变了');
    assert.equal((await project.readManuscript(plotRel)).contentHash, before);
  });

  // 手写的正文（作者自己贴进来的）没有指纹，不该被凭空补一个。
  test('没有 frontmatter 的正文不被补指纹', async () => {
    const bare = '.novelforge/manuscripts/099-手贴.md';
    t.write(bare, '我自己贴进来的正文。\n');
    project.invalidate();
    await ws.write(bare, { text: '我自己贴进来的正文，改过。\n' }, {
      mode: 'overwrite', review: false,
    });
    assert.ok(!t.read(bare).includes('upstreamHash'), t.read(bare));
  });
});

describe('章节 · 新建与 manifest 同步', () => {
  let created;

  before(async () => {
    created = await ws.createChapter(1, '楔子', '雨下了三天。');
  });

  test('落在 chapters/ 下，带三位序号', () => {
    assert.equal(created, 'chapters/001-楔子.md', created);
  });

  test('markdown 家族写标题行', () => {
    assert.ok(t.read(created).includes('# 楔子'), t.read(created));
  });

  test('非 markdown 不写标题行', async () => {
    const txt = await ws.createChapter(2, '手记', '正文', undefined, '.txt');
    assert.ok(!t.read(txt).includes('#'), t.read(txt));
  });

  // 空标题是合法的：拆分出来的第 2 章往后就是纯序号名。
  test('空标题落成纯序号名', async () => {
    assert.equal(await ws.createChapter(3, ''), 'chapters/003.md');
  });

  test('同名一律报错退出，不覆盖', async () => {
    assert.equal(await codeOf(() => ws.createChapter(1, '楔子')), 'exists');
  });

  test('manifest 跟着同步', async () => {
    const manifest = await project.readManifest();
    assert.ok(manifest.chapters.some((c) => c.file === created), JSON.stringify(manifest.chapters));
  });
});

describe('章节改名 · 草稿跟随，删章节不删草稿', () => {
  before(async () => {
    t.write('drafts/001-楔子.md', '# 楔子 · 草稿\n\n我的笔记。\n');
    project.invalidate();
    await ws.move('chapters/001-楔子.md', 'chapters/001-序.md');
  });

  test('章节改名了', () => {
    assert.ok(t.has('chapters/001-序.md'));
  });

  test('草稿跟着搬', () => {
    assert.ok(t.has('drafts/001-序.md'));
  });

  test('旧草稿没了', () => {
    assert.ok(!t.has('drafts/001-楔子.md'));
  });

  // 第 10 条：删章节不删草稿——那是作者另写的东西。
  test('删章节不删草稿', async () => {
    await ws.remove('chapters/001-序.md');
    assert.ok(!t.has('chapters/001-序.md'));
    assert.ok(t.has('drafts/001-序.md'), '草稿应该还在');
  });
});

describe('草稿 · 按需创建，已存在绝不覆盖', () => {
  let first;
  let second;

  before(async () => {
    await ws.createChapter(5, '夜访', '正文。');
    const chapter = (await project.listChapters()).find((c) => c.order === 5);
    first = await ws.ensureDraft(chapter);
    t.write(first, '我改过的草稿。');
    second = await ws.ensureDraft(chapter);
  });

  test('落在 drafts/ 下的镜像位置', () => {
    assert.equal(first, 'drafts/005-夜访.md', first);
  });

  test('第二次返回同一个路径', () => {
    assert.equal(second, first);
  });

  // 第二次点「打开草稿」不能把上次写的东西抹掉。
  test('第二次不覆盖已有内容', () => {
    assert.equal(t.read(first), '我改过的草稿。');
  });
});

describe('摘要 · sourceHash 记的是成品的 contentHash', () => {
  let chapter;
  let summaryRel;

  before(async () => {
    chapter = (await project.listChapters()).find((c) => c.order === 5);
    summaryRel = await ws.writeSummary(
      chapter,
      chapter.contentHash,
      { 梗概: '他去了。', 出场人物: '林昭', 时间地点: '', 关键事件: '', 新增伏笔: '', 状态变更: '' },
      [{ name: '林昭', aliases: [] }]
    );
  });

  test('落在 summaries/ 的镜像位置', () => {
    assert.equal(summaryRel, '.novelforge/summaries/005-夜访.md', summaryRel);
  });

  test('sourceHash 就是成品的 contentHash', () => {
    assert.equal(fm(summaryRel, 'sourceHash'), chapter.contentHash);
  });

  test('cast 落进 frontmatter', () => {
    assert.ok(t.read(summaryRel).includes('cast:'), t.read(summaryRel));
  });

  test('manifest 记下这一章已总结', async () => {
    const manifest = await project.readManifest();
    const entry = manifest.chapters.find((c) => c.file === chapter.relPath);
    assert.equal(entry.summaryHash, chapter.contentHash);
  });

  test('刚写完的摘要不算过期', async () => {
    assert.ok(!(await project.staleChapters()).some((c) => c.order === 5));
  });
});

describe('拆分 · 只拆自己，不动别人', () => {
  const plotRel = '.novelforge/plots/012-入宗.md';
  let created;
  let startNo;

  before(async () => {
    // 后面还有两段已规划、没拆分的。从前它们要整体顺延 2 位（连带搬走中转站
    // 正文）；段号与章号成了两条轴之后，那一步整个不需要了。
    for (const [no, title] of [[13, '甲'], [14, '乙']]) {
      const rel = await ws.writePlot({
        no, title, arc: '', upstreamHash: '', done: false, chapters: [], sections: filled(),
      });
      await ws.appendToManuscript(rel, `第 ${no} 段的正文。`);
    }
    // 第 12 段此刻已有两段正文，再补一段，拆出来就是三章。
    await ws.appendToManuscript(plotRel, '他推开了藏书阁的门。');
    project.invalidate();
    // 章号接在**最大章号**之后（`nextChapterNo`），不是「章数 + 1」——
    // 老工程里章号可能本来就不连续。
    startNo = await project.nextChapterNo();

    h.expect('拆分');
    created = await bundle.split.splitManuscript(project, plotRel);
  });

  test('拆出三章', () => {
    assert.equal(created.length, 3, JSON.stringify(created));
  });

  // 章号接在**现有最后一章**之后，与这一段的段号（12）无关。
  test('章号接在现有最后一章之后', () => {
    assert.equal(created[0], `chapters/${String(startNo).padStart(3, '0')}-入宗.md`, created[0]);
  });

  // 不调模型拟标题：那要么多花一次调用，要么在纯机械的动作里插一次网络请求。
  test('其余落成纯序号名', () => {
    assert.equal(created[1], `chapters/${String(startNo + 1).padStart(3, '0')}.md`, created[1]);
    assert.equal(created[2], `chapters/${String(startNo + 2).padStart(3, '0')}.md`, created[2]);
  });

  test('中转站那份进了回收站', () => {
    assert.ok(!t.has('.novelforge/manuscripts/012-入宗.md'));
    assert.ok(t.has('.novelforge/.trash/.novelforge/manuscripts/012-入宗.md'));
  });

  // 这是这次改动的落点：**一个别的文件都不动**。
  test('后面已规划的段号没被挪', async () => {
    const nos = (await project.listPlots()).map((p) => p.no).sort((a, b) => a - b);
    assert.ok(nos.includes(13) && nos.includes(14), nos.join('|'));
  });

  test('它们的细纲还在原路径上', () => {
    assert.ok(t.has('.novelforge/plots/013-甲.md'));
    assert.ok(t.has('.novelforge/plots/014-乙.md'));
  });

  test('它们的中转站正文没被搬走', () => {
    assert.ok(t.has('.novelforge/manuscripts/013-甲.md'));
    assert.ok(t.has('.novelforge/manuscripts/014-乙.md'));
  });

  // 「段 → 章」的链是显式的：拆完把落点记进这一段的 frontmatter。
  test('落点记进了这一段的 frontmatter', async () => {
    const plot = await project.readPlot(plotRel);
    assert.deepEqual(plot.chapters, created, JSON.stringify(plot.chapters));
  });

  test('拆出来的章进了 manifest', async () => {
    const manifest = await project.readManifest();
    const files = manifest.chapters.map((c) => c.file);
    for (const rel of created) {
      assert.ok(files.includes(rel), `${rel} 不在 ${files.join('|')}`);
    }
  });

  // 拆分是这条链上唯一的人工闸口：拆完之后这一章不该被拉回「待写正文」。
  test('拆完之后成品在 chapters/ 里', () => {
    for (const rel of created) {
      assert.ok(t.has(rel), rel);
    }
  });
});

describe('拆分 · 零次模型调用', () => {
  // 整组跑下来一次 provider 都没构造过——拆分是纯机械动作。
  test('没有任何模型请求', () => {
    assert.equal(h.toasts.filter((s) => s.includes('API Key')).length, 0, h.toasts.join('|'));
  });
});
