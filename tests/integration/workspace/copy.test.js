/**
 * 网关的复制（`Workspace.copy`）与文件页的「复制 → 粘贴」（`files/projectFiles.ts` 的 `copyInto`）。
 *
 * 从前粘贴的复制变体直接 `fs.cp`，**不过守卫**：能把文件复制进 `.trash/`、`sessions/`、`.novelforge/history/`，
 * 也能把会话文件、工程库从内部目录里复制出来；复制细纲时连定稿记下的指纹一起抄过去。现在走网关（AGENTS 第 7 条）：
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 复制进回收站、会话目录、历史版本一律拒绝，什么都不建 | 那三处不是作者的操作对象：回收站里躺着删掉的东西，会话是内部文件，历史版本是网关自己存的副本 |
 * | 会话文件、工程库复制不出来 | 内部文件读当不存在（守卫 `isInternalPath`） |
 * | 从回收站、历史版本里复制出来可以（⚑），原件一字不动 | 读得到就复制得出来：这是在工程里找回一份的唯一入口，回收站与历史都不被改 |
 * | 同名不覆盖 | 第 3 条 |
 * | 复制章节：manifest 同步；草稿与细纲**不跟**（⚑） | 副本是一章新的（第 8 条：按路径认细纲，旧细纲不冒认）；草稿是作者对原章的笔记 |
 * | 复制细纲：去掉定稿那一侧的指纹（`writtenFrom` / `sourceHash` / `cast`），`upstreamHash` 原样不刷新，换了章号就去掉 | 第 18 条：副本没写过、没定稿过；大纲指纹不该被复制顺手刷新成新鲜 |
 * | 字节原样（GBK、二进制都不转码），不存历史版本 | 复制不是「读出来再写一份」；没覆盖任何东西 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

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

const bytes = (rel) => fs.readFileSync(t.rel(rel));

/** 一份定稿过的细纲（frontmatter 带齐三环指纹与出场）。 */
function finalizedPlot(no, title, { upstreamHash, writtenFrom, sourceHash }) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    `upstreamHash: ${upstreamHash}`,
    `writtenFrom: ${writtenFrom}`,
    `sourceHash: ${sourceHash}`,
    'cast: [林昭, 老周]',
    'preflightOk: [老周：回忆里的一场]',
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 梗概',
    '',
    `${title}的计划。`,
    '',
    '## 出场人物',
    '',
    '林昭、老周',
    '',
    '## 关键事件',
    '',
    '- 林昭回到镇上',
    '',
  ].join('\n');
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    ws: './src/core/workspace/index.ts',
    projectFiles: './src/core/files/projectFiles.ts',
    pipe: './src/core/views/pipeline.ts',
    cast: './src/core/views/cast.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wscopy', title: '复制测试' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  t.write('notes/备忘.txt', '随便记的。\n');
  t.write('.novelforge/sessions/会话甲.json', '{"id":"会话甲"}\n');
  t.write('.novelforge/novelforge.db', 'SQLite format 3\0');
  t.write('.novelforge/.trash/chapters/009-删过的.md', '# 删过的\n\n找回来的那一章。\n');
  t.write('.novelforge/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt', '旧稿\n');
  fs.mkdirSync(t.rel('archive'), { recursive: true });
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

// ---------------------------------------------------------------- 复制进受保护的地方

describe('粘贴（复制）进回收站、会话目录、历史版本：一律拒绝', () => {
  const cases = [
    ['回收站根', '.novelforge/.trash', '.novelforge/.trash/备忘.txt'],
    ['回收站里的子目录', '.novelforge/.trash/chapters', '.novelforge/.trash/chapters/备忘.txt'],
    ['会话目录', '.novelforge/sessions', '.novelforge/sessions/备忘.txt'],
    ['历史版本根', '.novelforge/history', '.novelforge/history/备忘.txt'],
    ['历史版本里某份文件的快照目录', '.novelforge/history/chapters/001-楔子.md', '.novelforge/history/chapters/001-楔子.md/备忘.txt'],
  ];
  const results = {};
  let dirIntoTrash;
  let toastsAfter;

  before(async () => {
    h.expect();
    for (const [name, dest] of cases) {
      results[name] = (await bundle.projectFiles.copyInto(project, ['notes/备忘.txt'], dest))[0];
    }
    // 整个目录复制进回收站。
    dirIntoTrash = (await bundle.projectFiles.copyInto(project, ['notes'], '.novelforge/.trash'))[0];
    toastsAfter = [...h.toasts];
  });

  for (const [name, , landed] of cases) {
    test(`${name}：拒绝，没有落下文件`, () => {
      assert.equal(results[name].ok, false, JSON.stringify(results[name]));
      assert.equal(t.has(landed), false, landed);
    });
  }

  test('整个目录复制进回收站：拒绝，一个文件都没建', () => {
    assert.equal(dirIntoTrash.ok, false, JSON.stringify(dirIntoTrash));
    assert.equal(t.has('.novelforge/.trash/notes'), false);
  });

  test('拒绝的原因说得出来（回收站 / 内部文件 / 历史版本）', () => {
    assert.match(results['回收站根'].error, /回收站/);
    assert.match(results['会话目录'].error, /内部文件/);
    assert.match(results['历史版本根'].error, /历史版本/);
  });

  test('toast 报了没复制成', () => {
    assert.ok(toastsAfter.some((x) => x.startsWith('error:') && x.includes('未复制')), toastsAfter.join(' | '));
  });

  test('网关直接调也一样：copy 到这几处抛守卫的错', async () => {
    assert.equal(await codeOf(() => ws.copy('notes/备忘.txt', '.novelforge/.trash/x.txt')), 'inTrash');
    assert.equal(await codeOf(() => ws.copy('notes/备忘.txt', '.novelforge/sessions/x.json')), 'protected');
    assert.equal(await codeOf(() => ws.copy('notes/备忘.txt', '.novelforge/history/x.txt')), 'inHistory');
    assert.equal(await codeOf(() => ws.copy('notes/备忘.txt', '.novelforge/novelforge.db-wal')), 'protected');
  });
});

// ---------------------------------------------------------------- 从受保护的地方复制出来

describe('从受保护的地方复制出来', () => {
  let fromTrash;
  let fromHistory;
  let fromSession;
  let fromDb;
  let fromSessionsDir;
  let manifestFiles;

  before(async () => {
    fromTrash = (await bundle.projectFiles.copyInto(project, ['.novelforge/.trash/chapters/009-删过的.md'], 'chapters'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);
    fromHistory = (
      await bundle.projectFiles.copyInto(project, ['.novelforge/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt'], 'notes')
    )[0];
    fromSession = (await bundle.projectFiles.copyInto(project, ['.novelforge/sessions/会话甲.json'], 'notes'))[0];
    fromDb = (await bundle.projectFiles.copyInto(project, ['.novelforge/novelforge.db'], 'notes'))[0];
    fromSessionsDir = (await bundle.projectFiles.copyInto(project, ['.novelforge/sessions'], 'notes'))[0];
  });

  test('⚑ 回收站里的一章复制得出来（找回一份），回收站里那份一字不动', () => {
    assert.equal(fromTrash.ok, true, JSON.stringify(fromTrash));
    assert.equal(t.read('chapters/009-删过的.md'), '# 删过的\n\n找回来的那一章。\n');
    assert.equal(t.read('.novelforge/.trash/chapters/009-删过的.md'), '# 删过的\n\n找回来的那一章。\n');
  });

  test('找回进 chapters/ 的那一章进了 manifest', () => {
    assert.ok(manifestFiles.includes('chapters/009-删过的.md'), JSON.stringify(manifestFiles));
  });

  test('⚑ 历史版本里的一份快照复制得出来，快照本身一字不动', () => {
    assert.equal(fromHistory.ok, true, JSON.stringify(fromHistory));
    assert.equal(t.read('notes/2026-10-18_14-32-05+0800.txt'), '旧稿\n');
    assert.equal(t.read('.novelforge/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt'), '旧稿\n');
  });

  test('会话文件复制不出来（内部文件）', () => {
    assert.equal(fromSession.ok, false, JSON.stringify(fromSession));
    assert.equal(t.has('notes/会话甲.json'), false);
  });

  test('工程库复制不出来（内部文件）', () => {
    assert.equal(fromDb.ok, false, JSON.stringify(fromDb));
    assert.equal(t.has('notes/novelforge.db'), false);
  });

  test('整个会话目录复制不出来（固定目录）', () => {
    assert.equal(fromSessionsDir.ok, false, JSON.stringify(fromSessionsDir));
    assert.equal(t.has('notes/sessions'), false);
  });
});

// ---------------------------------------------------------------- 同名不覆盖

describe('同名不覆盖（第 3 条）', () => {
  let sameDir;
  let clash;
  let wsClash;

  before(async () => {
    t.write('archive/备忘.txt', '先来的，不能被盖掉。\n');
    project.invalidate();
    sameDir = (await bundle.projectFiles.copyInto(project, ['notes/备忘.txt'], 'notes'))[0];
    clash = (await bundle.projectFiles.copyInto(project, ['notes/备忘.txt'], 'archive'))[0];
    wsClash = await codeOf(() => ws.copy('notes/备忘.txt', 'archive/备忘.txt'));
  });

  test('粘贴回原目录：拒绝（已经在这个目录里），不加序号另起一份', () => {
    assert.equal(sameDir.ok, false, JSON.stringify(sameDir));
    assert.deepEqual(fs.readdirSync(t.rel('notes')).filter((n) => n.startsWith('备忘')), ['备忘.txt']);
  });

  test('目标已有同名：拒绝并说同名，已有那份一字不动', () => {
    assert.equal(clash.ok, false, JSON.stringify(clash));
    assert.match(clash.error, /同名/);
    assert.equal(t.read('archive/备忘.txt'), '先来的，不能被盖掉。\n');
  });

  test('网关直接调：exists', () => {
    assert.equal(wsClash, 'exists');
  });

  test('目录不能复制进自己里面', async () => {
    fs.mkdirSync(t.rel('notes/子目录'), { recursive: true });
    assert.equal(await codeOf(() => ws.copy('notes', 'notes/子目录/notes')), 'intoSelf');
    assert.equal(t.has('notes/子目录/notes'), false);
  });

  test('固定目录不能整个复制', async () => {
    assert.equal(await codeOf(() => ws.copy('chapters', 'archive/chapters')), 'protected');
  });
});

// ---------------------------------------------------------------- 复制章节

describe('复制一章正文', () => {
  const CH = 'chapters/第一卷/003-夜访.md';
  const BODY = '# 夜访\n\n夜里有人敲门，三下，停一停，又是两下。\n';
  const DRAFT = 'drafts/第一卷/003-夜访.md';
  const PLOT = '.novelforge/summaries/第一卷/003-夜访.md';
  let plotBefore;
  let castBefore;
  let result;
  let manifestFiles;
  let castAfter;

  before(async () => {
    t.write(CH, BODY);
    t.write(DRAFT, '# 夜访 · 草稿\n\n作者对原章的笔记。\n');
    project.invalidate();
    const chapter = (await project.listChapters()).find((c) => c.relPath === CH);
    t.write(PLOT, finalizedPlot(3, '夜访', { upstreamHash: 'aaaaaaaaaaaaaaaa', writtenFrom: 'bbbbbbbbbbbbbbbb', sourceHash: chapter.contentHash }));
    fs.mkdirSync(t.rel('chapters/第二卷'), { recursive: true });
    project.invalidate();
    plotBefore = t.read(PLOT);
    castBefore = (await bundle.cast.buildCastIndex(project)).summaryCount;

    result = (await bundle.projectFiles.copyInto(project, [CH], 'chapters/第二卷'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);
    project.invalidate();
    castAfter = (await bundle.cast.buildCastIndex(project)).summaryCount;
  });

  test('复制出来了，字节一样，原章还在', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read('chapters/第二卷/003-夜访.md'), BODY);
    assert.equal(t.read(CH), BODY);
  });

  test('manifest 同步：副本像新建的一章一样进了索引', () => {
    assert.ok(manifestFiles.includes('chapters/第二卷/003-夜访.md'), JSON.stringify(manifestFiles));
    assert.ok(manifestFiles.includes(CH), JSON.stringify(manifestFiles));
  });

  test('⚑ 细纲不跟着复制（副本是一章新的，旧细纲不冒认），原细纲一字不动', () => {
    assert.equal(t.has('.novelforge/summaries/第二卷/003-夜访.md'), false);
    assert.equal(t.read(PLOT), plotBefore);
  });

  test('草稿不跟着复制', () => {
    assert.equal(t.has('drafts/第二卷/003-夜访.md'), false);
  });

  test('副本不算定稿过：出场统计不多数一章（第 14 条）', () => {
    assert.equal(castBefore, 1);
    assert.equal(castAfter, 1);
  });

  test('副本照实是「待定稿」的一章', async () => {
    project.invalidate();
    const stale = (await project.staleChapters()).map((c) => c.relPath);
    assert.ok(stale.includes('chapters/第二卷/003-夜访.md'), JSON.stringify(stale));
    assert.ok(!stale.includes(CH), JSON.stringify(stale));
  });

  test('没覆盖任何东西，不存历史版本', () => {
    assert.equal(t.has('.novelforge/history/chapters/第二卷'), false);
  });
});

// ---------------------------------------------------------------- 复制细纲

describe('复制一份细纲：指纹不带着把副本标成新鲜或定稿过（第 18 条）', () => {
  const PLOT = '.novelforge/summaries/005-回乡.md';
  const OUTLINE = outlineOf(10, { text: { 5: '林昭回乡，镇上的人都变了。' } });
  const STALE_UP = 'deadbeefdeadbeef';
  let original;
  let origPlot;
  let result;
  let copy;
  let copyText;
  let currentUp;
  let pipeOriginal;
  let pipeCopy;

  before(async () => {
    t.write('.novelforge/outline.md', OUTLINE);
    // 大纲在这份细纲之后改过：原件挂着 ⟳（upstreamHash 对不上大纲此刻的那一节）。
    t.write(PLOT, finalizedPlot(5, '回乡', { upstreamHash: STALE_UP, writtenFrom: '1111111111111111', sourceHash: '2222222222222222' }));
    fs.mkdirSync(t.rel('.novelforge/summaries/备份'), { recursive: true });
    project.invalidate();
    original = t.read(PLOT);
    currentUp = bundle.outlineFile.outlineUpstreamHash(OUTLINE, 5);

    result = (await bundle.projectFiles.copyInto(project, [PLOT], '.novelforge/summaries/备份'))[0];
    project.invalidate();
    copyText = t.read('.novelforge/summaries/备份/005-回乡.md');
    copy = await project.readPlot('.novelforge/summaries/备份/005-回乡.md');
    origPlot = await project.readPlot(PLOT);
    pipeOriginal = await bundle.pipe.buildPlotPipeline(project, { no: 5, plot: origPlot });
    pipeCopy = await bundle.pipe.buildPlotPipeline(project, { no: 5, plot: copy });
  });

  test('复制出来了，原件一字不动', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read(PLOT), original);
  });

  test('定稿那一侧的指纹去掉了：writtenFrom / sourceHash / cast', () => {
    assert.equal(copy.writtenFrom, '');
    assert.equal(copy.sourceHash, '');
    assert.doesNotMatch(copyText, /^(writtenFrom|sourceHash|cast):/m);
  });

  test('upstreamHash 原样留着，没被刷新成大纲此刻的指纹', () => {
    assert.notEqual(currentUp, STALE_UP);
    assert.equal(copy.upstreamHash, STALE_UP);
  });

  test('所以原件挂 ⟳ 的，副本照样挂 ⟳（不被复制顺手标成新鲜）', () => {
    assert.equal(pipeOriginal.plot.upstreamStale, true);
    assert.equal(pipeCopy.plot.upstreamStale, true);
  });

  test('副本不算定稿过', () => {
    assert.equal(pipeOriginal.summary.exists, true);
    assert.equal(pipeCopy.summary.exists, false);
  });

  test('作者写的部分原样：七节、标题、预检放行', () => {
    assert.deepEqual(copy.sections, origPlot.sections);
    assert.match(copyText, /^title: 回乡$/m);
    assert.match(copyText, /^preflightOk:/m);
    assert.equal(copyText.slice(copyText.indexOf('# 第5章')), original.slice(original.indexOf('# 第5章')));
  });

  test('网关直接复制成另一个章号：大纲指纹也去掉（那是另一章的那一节，不再适用）', async () => {
    await ws.copy(PLOT, '.novelforge/summaries/备份/007-回乡.md');
    project.invalidate();
    const renumbered = await project.readPlot('.novelforge/summaries/备份/007-回乡.md');
    assert.equal(renumbered.upstreamHash, '');
    assert.equal(renumbered.sourceHash, '');
  });

  test('没有 frontmatter 的手写细纲复制过去一字不动（不补指纹）', async () => {
    const HAND = '# 第6章 手写\n\n## 梗概\n\n作者自己写的。\n';
    t.write('.novelforge/summaries/006-手写.md', HAND);
    await ws.copy('.novelforge/summaries/006-手写.md', '.novelforge/summaries/备份/006-手写.md');
    assert.equal(t.read('.novelforge/summaries/备份/006-手写.md'), HAND);
  });
});

// ---------------------------------------------------------------- 复制目录

describe('复制整个目录：逐个文件过守卫，字节原样', () => {
  // 「卷稿」：GBK 编码的 .txt 章节（第 9 条：章节不认扩展名）、一张图、一份 markdown 章节。
  const GBK = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // 「你好」+ 换行，GBK
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  let result;
  let manifestFiles;
  let summariesDir;

  before(async () => {
    t.write('卷稿/020-甲.md', '# 甲\n\n第二十章。\n');
    fs.writeFileSync(t.rel('卷稿/021-乙.txt'), GBK);
    fs.mkdirSync(t.rel('卷稿/图'), { recursive: true });
    fs.writeFileSync(t.rel('卷稿/图/封面.png'), PNG);
    project.invalidate();
    result = (await bundle.projectFiles.copyInto(project, ['卷稿'], 'chapters'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);

    // 细纲目录整个复制：里面的每一份都去掉定稿那一侧的指纹。
    summariesDir = (await bundle.projectFiles.copyInto(project, ['.novelforge/summaries/第一卷'], '.novelforge/summaries/备份'))[0];
  });

  test('整棵复制过去', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read('chapters/卷稿/020-甲.md'), '# 甲\n\n第二十章。\n');
  });

  test('GBK 的章节、二进制的图字节原样，不转码', () => {
    assert.deepEqual(bytes('chapters/卷稿/021-乙.txt'), GBK);
    assert.deepEqual(bytes('chapters/卷稿/图/封面.png'), PNG);
  });

  test('复制进 chapters/ 的两章都进了 manifest', () => {
    assert.ok(manifestFiles.includes('chapters/卷稿/020-甲.md'), JSON.stringify(manifestFiles));
    assert.ok(manifestFiles.includes('chapters/卷稿/021-乙.txt'), JSON.stringify(manifestFiles));
  });

  test('目录里的细纲同样去掉了定稿那一侧的指纹', async () => {
    assert.equal(summariesDir.ok, true, JSON.stringify(summariesDir));
    project.invalidate();
    const copied = await project.readPlot('.novelforge/summaries/备份/第一卷/003-夜访.md');
    assert.equal(copied.sourceHash, '');
    assert.equal(copied.writtenFrom, '');
    assert.equal(copied.upstreamHash, 'aaaaaaaaaaaaaaaa');
  });

  test('网关复制会补齐落点的父目录（与 move 一样）', async () => {
    await ws.copy('notes/备忘.txt', '新目录/深处/备忘.txt');
    assert.equal(t.read('新目录/深处/备忘.txt'), '随便记的。\n');
  });

  test('符号链接不跟进去，跳过并说出来', { skip: process.platform === 'win32' }, async () => {
    fs.mkdirSync(t.rel('带链接'), { recursive: true });
    t.write('带链接/正常.txt', '正常\n');
    fs.symlinkSync('/etc/hostname', t.rel('带链接/外面'));
    const r = await ws.copy('带链接', 'archive/带链接');
    assert.equal(t.read('archive/带链接/正常.txt'), '正常\n');
    assert.equal(fs.existsSync(t.rel('archive/带链接/外面')), false);
    assert.ok((r.side ?? []).some((s) => s.includes('外面')), JSON.stringify(r));
  });
});
