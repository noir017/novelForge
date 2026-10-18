/**
 * 功能层里从前绕过网关、直接 `writeText` 的几处，改走 `workspace.write` 之后（AGENTS 第 7 条）：
 *
 * - **覆盖之前旧内容进历史版本**（`.novelforge/history/`）：作者手写的角色卡、改名前的正文被换掉之后找得回来（第 3 条）；
 * - **审阅只问一次**：功能自己弹过审阅（或作者在确认框里选了「全部直接采纳」），写盘时传 `review: false`，网关不再问第二次；
 * - **新建设定条目同名不覆盖**：已有的条目原样留着，新的加序号；
 * - **章节改名时同步 `# 标题` 行不碰细纲的 `writtenFrom`**：挂着 ⟳ 的章改名之后照样挂着、没挂的照样不挂（第 18 条）。
 *
 * 每张卡只在一节里被第一次覆盖：历史版本的节流（10 分钟内的小改并成一版）只在「第一次」上没有歧义。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const settings = makeSettings();

/** 网关自己那张覆盖确认的问法（`guard.ts` 的 `reviewOverwrite`）：功能层问过之后不该再出现。 */
const GATE_ASK = '已经有内容了，用新版本覆盖？';

function cardJson(overrides) {
  return JSON.stringify({
    aliases: [],
    tags: [],
    身份: '模型写的身份',
    外貌: '',
    性格: '模型写的性格',
    语言习惯: '',
    人物关系: '',
    当前状态: '',
    未收伏笔: '',
    ...overrides,
  });
}

const authorCard = (name) =>
  `---\nname: ${name}\naliases: []\ntags: []\n---\n\n# ${name}\n\n## 身份\n\n作者亲手写的${name}的身份，一个字都不能丢。\n`;

/** 一章正文 + 一份定稿过的细纲：出场统计只认定稿过的（第 14 条）。 */
function makeChapter(no, title, cast) {
  const stem = `${String(no).padStart(3, '0')}-${title}`;
  t.write(`chapters/${stem}.md`, `# ${title}\n\n${'雨下了三天，石板路泡得发白。'.repeat(20)}\n`);
  t.write(
    `.novelforge/summaries/${stem}.md`,
    `---\nno: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n# 第${no}章 ${title}\n\n` +
      `## 梗概\n\n略。\n\n## 出场人物\n\n${cast.join('、')}\n\n## 关键事件\n\n甲乙丙。\n`
  );
}

/** 这份文件的快照文件名，新的在前。 */
function snaps(rel) {
  const dir = t.rel('.novelforge/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

const snapTexts = (rel) => snaps(rel).map((name) => fs.readFileSync(t.rel('.novelforge/history', rel, name), 'utf8'));

/** 正文挂不挂 ⟳：与工程页同一个判据（`views/pipeline.ts`：细纲的 `writtenFrom` 记过、而且对不上内容指纹）。 */
async function staleOf(no) {
  project.invalidate();
  const plot = await project.getPlot(no);
  return (await bundle.pipe.buildPlotPipeline(project, { no, plot })).chapter.upstreamStale;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    history: './src/core/workspace/history.ts',
    characterCard: './src/core/features/characterCard.ts',
    characters: './src/core/features/characters.ts',
    fileOps: './src/core/files/fileOps.ts',
    pipe: './src/core/views/pipeline.ts',
    registry: './src/core/llm/registry.ts',
    // 更新角色卡会记 / 清失败标记，落进工程库；收尾要先关库。
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { repeatLast: true, fallback: cardJson() });

  t = await makeTempProject(bundle.project, { prefix: 'featwrites', title: '功能层写盘' });
  project = t.project;
  makeChapter(1, '楔子', ['林昭', '沈氏', '老周']);
  makeChapter(2, '入镇', ['林昭', '老周']);
  makeChapter(3, '夜谈', ['沈氏', '韩七']);
  for (const name of ['林昭', '沈氏', '老周', '阿蘅']) {
    t.write(`.novelforge/characters/${name}.md`, authorCard(name));
  }
  // 扩展名大写的卡：角色区认它（`.md` 不分大小写），写回去得还是这一份。
  t.write('.novelforge/characters/韩七.MD', authorCard('韩七'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('更新角色卡：作者在 diff 审阅里点了采纳', () => {
  const CARD = '.novelforge/characters/林昭.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    h.expect('开始');
    fake.reset([cardJson({ 身份: '林昭：模型写的身份' })]);
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('写进了模型给的新版', () => {
    assert.match(written, /林昭：模型写的身份/);
  });

  test('作者手写的旧版在历史版本里留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('审阅只弹一次，是功能自己那张（不请求合并）；网关没有再问', () => {
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].merge, false);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('完成提示照旧', () => {
    assert.ok(toasts.some((x) => x.includes('「林昭」已更新，覆盖至第 2 章')), toasts.join(' | '));
  });
});

describe('更新角色卡：审阅里放弃', () => {
  const CARD = '.novelforge/characters/林昭.md';
  let before_;
  let after_;
  let snapCount;

  before(async () => {
    before_ = t.read(CARD);
    h.setReviewVerdict('discard');
    try {
      h.expect('开始');
      fake.reset([cardJson({ 身份: '不该写进去' })]);
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      h.setReviewVerdict('apply');
    }
    after_ = t.read(CARD);
    snapCount = snaps(CARD).length;
  });

  test('卡一个字不动', () => {
    assert.equal(after_, before_);
  });

  test('没写就不多存一版历史', () => {
    assert.equal(snapCount, 1);
  });
});

describe('更新角色卡：宿主没有 diff 审阅，退回确认框', () => {
  const CARD = '.novelforge/characters/老周.md';
  let original;
  let written;
  let confirms;

  before(async () => {
    original = t.read(CARD);
    const saved = h.host.reviewReplace;
    h.host.reviewReplace = undefined;
    try {
      // 只排两个答案：网关要是再问一次覆盖，就没有答案可取，等于作者取消——卡不会被写。
      h.expect('开始', '采纳');
      fake.reset([cardJson({ 身份: '老周：模型写的身份' })]);
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      h.host.reviewReplace = saved;
    }
    written = t.read(CARD);
    confirms = h.confirms.map((c) => c.message);
  });

  test('只问了一次「采纳？」，网关没有再弹覆盖确认', () => {
    assert.equal(confirms.filter((m) => m.includes('的新版角色卡。采纳？')).length, 1, confirms.join(' | '));
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('写进了新版，旧版进了历史', () => {
    assert.match(written, /老周：模型写的身份/);
    assert.deepEqual(snapTexts(CARD), [original]);
  });
});

describe('更新角色卡：扩展名大写的卡写回原文件', () => {
  const CARD = '.novelforge/characters/韩七.MD';
  let original;
  let written;
  let siblings;

  before(async () => {
    original = t.read(CARD);
    h.expect('开始');
    fake.reset([cardJson({ 身份: '韩七：模型写的身份' })]);
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    written = t.read(CARD);
    siblings = fs.readdirSync(t.rel('.novelforge/characters')).filter((n) => n.startsWith('韩七'));
  });

  test('写的是作者那一份，旁边没有另起一张 `韩七.md`', () => {
    assert.match(written, /韩七：模型写的身份/);
    assert.deepEqual(siblings, ['韩七.MD']);
  });

  test('旧版照样进了历史', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });
});

describe('提取角色：已有的卡逐个对比后采纳', () => {
  const CARD = '.novelforge/characters/阿蘅.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    // 第一个答案给「从哪几章提取」的输入框，第二个给「要逐个对比确认吗」。
    h.expect('1', '逐个对比');
    fake.reset([JSON.stringify([{ name: '阿蘅', 性格: '阿蘅：模型说的性格' }])]);
    await bundle.characters.extractCharacters(project);
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('写进了合并后的新版：模型给了的节换新，没给的节留着作者写的', () => {
    assert.match(written, /阿蘅：模型说的性格/);
    assert.match(written, /作者亲手写的阿蘅的身份/);
  });

  test('作者手写的旧版在历史版本里留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('审阅只弹一次，是功能自己那张；网关没有再问', () => {
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].merge, false);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('提示照旧', () => {
    assert.ok(toasts.includes('info: 已更新「阿蘅」。'), toasts.join(' | '));
  });
});

describe('批量更新角色卡：作者在确认框里选了「全部直接采纳」', () => {
  const CARD = '.novelforge/characters/沈氏.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    h.expect('全部直接采纳并开始');
    fake.reset([cardJson({ 身份: '批量重建的身份' })]);
    await bundle.characterCard.updateAllCharacterCards(project, 'full');
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('一张审阅都不弹（作者已经在确认框里选过），网关也不问', () => {
    assert.equal(reviewed.length, 0);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('写进了新版', () => {
    assert.match(written, /批量重建的身份/);
  });

  test('作者手写的旧版在历史版本里留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('完成提示照旧报数', () => {
    assert.ok(toasts.some((x) => x.includes('角色卡从头重建完成：已更新 4 张')), toasts.join(' | '));
  });
});

describe('新建设定条目', () => {
  const MINE = '.novelforge/lore/势力/玄门.md';
  const AUTHOR = '---\ntitle: 玄门\nkeywords: [玄门]\n---\n\n# 玄门\n\n作者写好的玄门。\n';
  let mineAfter;
  let created;
  let opened;
  let named;
  let namedInputs;

  before(async () => {
    t.write(MINE, AUTHOR);
    project.invalidate();
    h.expect('玄门');
    await bundle.characters.newLore(project, '.novelforge/lore/势力');
    mineAfter = t.read(MINE);
    created = t.has('.novelforge/lore/势力/玄门-2.md') ? t.read('.novelforge/lore/势力/玄门-2.md') : undefined;
    opened = [...h.opened];

    // 工程页「出现过 · 未建条目」那一行右键新建：带着名字，不再问。
    h.expect();
    await bundle.characters.newLore(project, undefined, '青崖镇');
    named = t.has('.novelforge/lore/青崖镇.md') ? t.read('.novelforge/lore/青崖镇.md') : undefined;
    namedInputs = h.inputs.length;
  });

  test('同名的已有条目一个字不动，新的那份加序号落在旁边', () => {
    assert.equal(mineAfter, AUTHOR);
    assert.ok(created !== undefined);
  });

  test('新条目的内容与从前一样：标题、关键词、一段写什么的说明', () => {
    assert.ok(created.startsWith('---\ntitle: 玄门\nkeywords: [玄门]\n---\n\n# 玄门\n\n（在这里写这条设定'), created);
  });

  test('建完打开它', () => {
    assert.deepEqual(opened, ['.novelforge/lore/势力/玄门-2.md']);
  });

  test('没有覆盖任何东西，也就不存历史版本', () => {
    assert.equal(snaps(MINE).length, 0);
    assert.equal(snaps('.novelforge/lore/势力/玄门-2.md').length, 0);
  });

  test('带着名字新建：不问标题，落在设定根下', () => {
    assert.equal(namedInputs, 0);
    assert.ok(named && named.startsWith('---\ntitle: 青崖镇\n'), named);
  });
});

describe('章节改名：同步正文的 # 标题 行', () => {
  const OLD = 'chapters/010-旧名.md';
  const NEW = 'chapters/010-新名.md';
  const BODY = `# 旧名\n\n${'山雨欲来风满楼。'.repeat(10)}\n`;
  const STALE_MARK = 'deadbeefdeadbeef';
  let staleBefore;
  let renamed;
  let newText;
  let oldGone;
  let history;
  let reviewedCount;
  let confirmCount;
  let toasts;
  let plotMoved;
  let writtenFromAfter;
  let staleAfter;
  let freshBefore;
  let freshWrittenFrom;
  let freshWrittenFromAfter;
  let freshAfter;

  before(async () => {
    const { renderPlotFile, emptyPlotSections, plotContentHash } = bundle.plotFile;
    t.write(OLD, BODY);
    // 细纲在正文之后改过：`writtenFrom` 对不上现在的内容指纹 → 正文挂 ⟳。
    t.write(
      '.novelforge/summaries/010-旧名.md',
      renderPlotFile({
        no: 10,
        title: '旧名',
        upstreamHash: '',
        writtenFrom: STALE_MARK,
        done: false,
        sections: { ...emptyPlotSections(), 梗概: '改过的计划', 关键事件: '甲' },
      })
    );
    // 对照：一章没挂 ⟳ 的（`writtenFrom` 正对得上）。
    const freshSections = { ...emptyPlotSections(), 梗概: '没改过的计划', 关键事件: '乙' };
    freshWrittenFrom = plotContentHash({ sections: freshSections });
    t.write('chapters/011-次章.md', '# 次章\n\n正文。\n');
    t.write(
      '.novelforge/summaries/011-次章.md',
      renderPlotFile({ no: 11, title: '次章', upstreamHash: '', writtenFrom: freshWrittenFrom, done: false, sections: freshSections })
    );
    staleBefore = await staleOf(10);
    freshBefore = await staleOf(11);

    h.expect('新名');
    renamed = await bundle.fileOps.renameEntry(project, OLD);
    reviewedCount = h.reviewed.length;
    confirmCount = h.confirms.length;
    toasts = [...h.toasts];
    newText = t.has(NEW) ? t.read(NEW) : undefined;
    oldGone = !t.has(OLD);
    history = snapTexts(OLD);
    project.invalidate();
    const plot = await project.readPlot('.novelforge/summaries/010-新名.md');
    plotMoved = !!plot && !t.has('.novelforge/summaries/010-旧名.md');
    writtenFromAfter = plot && plot.writtenFrom;
    staleAfter = await staleOf(10);

    h.expect('再改');
    await bundle.fileOps.renameEntry(project, 'chapters/011-次章.md');
    project.invalidate();
    freshWrittenFromAfter = (await project.readPlot('.novelforge/summaries/011-再改.md'))?.writtenFrom;
    freshAfter = await staleOf(11);
  });

  test('改名成功：文件名与正文的 # 标题 一起换成新名字', () => {
    assert.equal(renamed, NEW);
    assert.ok(oldGone);
    assert.equal(newText, BODY.replace('# 旧名', '# 新名'));
  });

  test('改名之前的正文在历史版本里留了一份（挂在旧路径下）', () => {
    assert.deepEqual(history, [BODY]);
  });

  test('不弹审阅也不弹确认：新名字是作者刚在输入框里起的', () => {
    assert.equal(reviewedCount, 0);
    assert.equal(confirmCount, 0);
  });

  test('提示照旧', () => {
    assert.ok(toasts.includes(`info: 已重命名为 ${NEW}`), toasts.join(' | '));
  });

  test('第 18 条：挂着 ⟳ 的章改名之后照样挂着——writtenFrom 原样跟着细纲搬过去，没被刷成当前细纲的指纹', () => {
    assert.equal(staleBefore, true);
    assert.ok(plotMoved);
    assert.equal(writtenFromAfter, STALE_MARK);
    assert.equal(staleAfter, true);
  });

  test('没挂 ⟳ 的章改名之后也不挂', () => {
    assert.equal(freshBefore, false);
    assert.equal(freshWrittenFromAfter, freshWrittenFrom);
    assert.equal(freshAfter, false);
  });
});

describe('章节改名：正文超过网关的大小上限', () => {
  const HUGE = 'chapters/012-巨章.md';
  // 「字」在 UTF-8 里三个字节：七十万字过了 2 MB。
  const BODY = `# 巨章\n\n${'字'.repeat(700_000)}\n`;
  let result;
  let toasts;
  let kept;
  let movedTo;

  before(async () => {
    t.write(HUGE, BODY);
    project.invalidate();
    h.expect('改不动');
    result = await bundle.fileOps.renameEntry(project, HUGE);
    toasts = [...h.toasts];
    kept = t.has(HUGE) && t.read(HUGE) === BODY;
    movedTo = t.has('chapters/012-改不动.md');
  });

  test('网关拒写标题行，整个改名不做（不留下标题改了、文件名没改的半截）', () => {
    assert.equal(result, undefined);
    assert.ok(kept);
    assert.equal(movedTo, false);
  });

  test('说出来为什么', () => {
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('大小上限')), toasts.join(' | '));
  });
});
