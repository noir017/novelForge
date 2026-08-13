/**
 * 创作流水线的数据层：镜像路径、细纲与场景读写、改名跟随、新鲜度链、工作区卡。
 * 迁自 scripts/smoke-pipeline.js 第 433–765 行（`// ====== 数据层（要落盘）` 以下，64 条断言）。
 * 该文件 433 行以上的纯函数部分不在这里。
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

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    planFile: './src/core/model/planFile.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    fileOps: './src/core/files/fileOps.ts',
    pipe: './src/core/views/pipeline.ts',
    workbench: './src/core/views/workbench.ts',
  });
  // 原脚本的假宿主没有 reviewReplace，摘掉它才与原行为一致。
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  // 原脚本没有删 initialize() 撒下的两个示例文件，这里保持一致。
  t = await makeTempProject(bundle.project, {
    prefix: 'pipeline',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('数据层 · 目录与镜像路径', () => {
  test('初始化建出 plans/', () => {
    assert.ok(t.has('.novelforge/plans'));
  });

  test('初始化建出 scenes/', () => {
    assert.ok(t.has('.novelforge/scenes'));
  });

  // 分卷收纳：目录层级只是收纳，镜像规则要原样跟着走。
  test('细纲路径镜像章节', () => {
    const ch = 'chapters/卷一/012-夜入青云.md';
    assert.equal(
      project.relPath(project.planPathForChapter(ch)),
      '.novelforge/plans/卷一/012-夜入青云.md',
      project.relPath(project.planPathForChapter(ch))
    );
  });

  test('场景目录镜像章节（去掉扩展名再开一层）', () => {
    const ch = 'chapters/卷一/012-夜入青云.md';
    assert.equal(
      project.relPath(project.sceneDirForChapter(ch)),
      '.novelforge/scenes/卷一/012-夜入青云',
      project.relPath(project.sceneDirForChapter(ch))
    );
  });

  // 章节不认扩展名，细纲/场景照样要对得上。
  test('.txt 章节的细纲也是 .md', () => {
    assert.equal(
      project.relPath(project.planPathForChapter('chapters/005-手记.txt')),
      '.novelforge/plans/005-手记.md'
    );
  });

  test('无扩展名章节的细纲', () => {
    assert.equal(
      project.relPath(project.planPathForChapter('chapters/006-无扩展名')),
      '.novelforge/plans/006-无扩展名.md'
    );
  });

  // 同序号不同文件名的两章各有独立细纲——这正是不能用 order 当键的理由。
  test('同序号不同文件的细纲互不覆盖', () => {
    assert.notEqual(
      project.planPathForChapter('chapters/001 序.txt'),
      project.planPathForChapter('chapters/001 正文.txt')
    );
  });

  // 不在 chapters/ 之下时不落到「按序号命名」的位置，而是明确说没有。
  test('章节不在 chapters/ 下时没有细纲路径', () => {
    assert.equal(project.planPathForChapter('别处/012-夜入青云.md'), undefined);
  });

  test('章节不在 chapters/ 下时没有场景目录', () => {
    assert.equal(project.sceneDirForChapter('别处/012.md'), undefined);
  });

  test('目录的细纲镜像原样映射', () => {
    assert.equal(project.planMirrorRelPath('chapters/卷一', true), '.novelforge/plans/卷一');
  });

  test('目录的场景镜像原样映射', () => {
    assert.equal(project.sceneMirrorRelPath('chapters/卷一', true), '.novelforge/scenes/卷一');
  });
});

describe('数据层 · 细纲与场景读写', () => {
  const ch = 'chapters/卷一/012-夜入青云.md';
  let noPlan;
  let noScenes;
  let planRel;
  let planBack;
  let hadScene02;
  let scenes;
  let sceneTwo;
  let oldFileGone;
  let newFileThere;
  let countAfterRename;
  let deleted3;
  let countAfterDelete;
  let inTrash;
  let deleted9;

  before(async () => {
    t.write(ch, '# 夜入青云\n\n');
    project.invalidate();

    noPlan = await project.readPlan(ch);
    noScenes = await project.listScenes(ch);

    planRel = await project.writePlan(ch, {
      chapterRelPath: ch, order: 12, title: '夜入青云', arc: '第一幕', targetWords: 3000,
      upstreamHash: 'OUTLINE_A', done: false,
      sections: { ...bundle.planFile.emptyPlanSections(), 本章目标: '林昭成功进入青云宗。' },
    });
    planBack = await project.readPlan(ch);

    for (const [no, title] of [[1, '山门观察'], [2, '翻越侧峰'], [3, '初见沈月']]) {
      await project.writeScene(ch, {
        chapterRelPath: ch, no, title, place: '青云宗', time: '子时', characters: ['林昭'],
        upstreamHash: 'PLAN_A', status: 'ready',
        sections: { ...bundle.sceneFile.emptySceneSections(), 必须发生: '- 甲\n- 乙' },
      });
    }
    // 下面的改名会删掉这个文件，所以在原脚本断言的那一刻就抓下来。
    hadScene02 = t.has('.novelforge/scenes/卷一/012-夜入青云/02-翻越侧峰.md');
    scenes = await project.listScenes(ch);
    sceneTwo = await project.readScene(ch, 2);

    // 改标题会改文件名——旧文件必须删掉，否则一场变两场。
    await project.writeScene(ch, {
      chapterRelPath: ch, no: 2, title: '翻墙', place: '', time: '', characters: [],
      upstreamHash: 'PLAN_A', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 必须发生: '- 甲' },
    });
    oldFileGone = !t.has('.novelforge/scenes/卷一/012-夜入青云/02-翻越侧峰.md');
    newFileThere = t.has('.novelforge/scenes/卷一/012-夜入青云/02-翻墙.md');
    countAfterRename = (await project.listScenes(ch)).length;

    // 删除是搬进 .trash/，不真删（第 6 条）。
    deleted3 = await project.deleteScene(ch, 3);
    countAfterDelete = (await project.listScenes(ch)).length;
    inTrash = t.has('.novelforge/.trash/.novelforge/scenes/卷一/012-夜入青云/03-初见沈月.md');
    deleted9 = await project.deleteScene(ch, 9);
  });

  test('没写过时读不出细纲', () => {
    assert.equal(noPlan, undefined);
  });

  test('没写过时场景列表为空', () => {
    assert.equal(noScenes.length, 0);
  });

  test('细纲落在镜像路径', () => {
    assert.equal(planRel, '.novelforge/plans/卷一/012-夜入青云.md', planRel);
  });

  test('细纲读得回来', () => {
    assert.equal(planBack.sections.本章目标, '林昭成功进入青云宗。');
  });

  test('场景落在镜像目录', () => {
    assert.ok(hadScene02);
  });

  test('列出三场', () => {
    assert.equal(scenes.length, 3, String(scenes.length));
  });

  test('场景按号排序', () => {
    assert.equal(scenes.map((s) => s.no).join(','), '1,2,3');
  });

  test('按号取单场', () => {
    assert.equal(sceneTwo.title, '翻越侧峰');
  });

  test('改标题后旧文件被删', () => {
    assert.ok(oldFileGone);
  });

  test('改标题后新文件在', () => {
    assert.ok(newFileThere);
  });

  test('改标题后仍是三场', () => {
    assert.equal(countAfterRename, 3);
  });

  test('删掉第 3 场', () => {
    assert.equal(deleted3, true);
  });

  test('删后只剩两场', () => {
    assert.equal(countAfterDelete, 2);
  });

  test('被删的场景进了回收站', () => {
    assert.ok(inTrash);
  });

  test('删不存在的场景返回 false', () => {
    assert.equal(deleted9, false);
  });
});

describe('数据层 · 章节改名时细纲与场景跟随', () => {
  let next;
  let planRead;
  let sceneCount;
  let planText;
  let sceneText;
  let planHashBefore;
  let planHashAfter;
  let beatsBefore;
  let beatsAfter;

  before(async () => {
    const from = 'chapters/卷一/012-夜入青云.md';
    // 改名前的两个上游指纹。改名**绝不能**动它们：`carryChapterRefs` 要改
    // 细纲与场景的 frontmatter，一旦哪个字段进了哈希，改个名就会让这一章
    // 的下游全部凭空标脏（AGENTS.md 第 18 条 (b)）。
    planHashBefore = bundle.pipe.planContentHash(await project.readPlan(from));
    beatsBefore = await project.beatsHashFor(from);

    h.answers.length = 0;
    // renameEntry 问的是**去掉序号前缀**的词干，序号由它自己接回去。
    h.answers.push('夜入');
    next = await bundle.fileOps.renameEntry(project, from);
    // 不跟随的话这里会读出 undefined，而界面只会说「这一章还没规划过」。
    planRead = await project.readPlan('chapters/卷一/012-夜入.md');
    sceneCount = (await project.listScenes('chapters/卷一/012-夜入.md')).length;

    planText = t.read('.novelforge/plans/卷一/012-夜入.md');
    sceneText = t.read('.novelforge/scenes/卷一/012-夜入/01-山门观察.md');
    planHashAfter = bundle.pipe.planContentHash(planRead);
    beatsAfter = await project.beatsHashFor('chapters/卷一/012-夜入.md');
  });

  test('改名成功', () => {
    assert.equal(next, 'chapters/卷一/012-夜入.md', String(next));
  });

  test('细纲跟着改名', () => {
    assert.ok(t.has('.novelforge/plans/卷一/012-夜入.md'));
  });

  test('旧细纲不再存在', () => {
    assert.ok(!t.has('.novelforge/plans/卷一/012-夜入青云.md'));
  });

  test('场景目录跟着改名', () => {
    assert.ok(t.has('.novelforge/scenes/卷一/012-夜入/01-山门观察.md'));
  });

  test('旧场景目录不再存在', () => {
    assert.ok(!t.has('.novelforge/scenes/卷一/012-夜入青云'));
  });

  test('改名后细纲仍读得到', () => {
    assert.notEqual(planRead, undefined);
  });

  test('改名后场景仍读得到', () => {
    assert.equal(sceneCount, 2);
  });

  // 文件搬对了还不够：它们**内容里**写着的旧路径与旧标题也得跟上，
  // 否则作者打开细纲一看，chapter: 指向一个已经不存在的文件。
  test('细纲的 chapter: 指向新路径', () => {
    assert.equal(planRead.chapterRelPath, 'chapters/卷一/012-夜入.md', planRead.chapterRelPath);
  });

  test('细纲的 title: 跟着改', () => {
    assert.equal(planRead.title, '夜入', planRead.title);
  });

  test('细纲的 H1 跟着改', () => {
    assert.ok(planText.includes('# 第12章 夜入 · 细纲'), planText.slice(0, 300));
  });

  test('场景的 chapter: 指向新路径', () => {
    assert.ok(sceneText.includes('chapter: chapters/卷一/012-夜入.md'), sceneText.slice(0, 200));
  });

  // 这两条是防「改个名把全章标脏」的回归线。
  test('细纲的内容指纹没变', () => {
    assert.equal(planHashAfter, planHashBefore);
  });

  test('场景的 beatsHash 没变', () => {
    assert.equal(beatsAfter, beatsBefore);
  });
});

/**
 * 流水线新建那条路的主流程：建出来只有序号（`030.md`），先写细纲，写完了
 * 才给它起名。此时细纲里记的 `title` 是回落值「第 30 章」——拿文件名词干
 * （空串）去比永远不匹配，起名之后细纲里就会一直写着「第 30 章」。
 */
describe('数据层 · 给未命名的章节起名', () => {
  const bare = 'chapters/030.md';
  let named;
  let planRead;
  let planText;
  let handwritten;

  before(async () => {
    await project.createChapter(30, '', '');
    project.invalidate();
    const chapter = (await project.listChapters()).find((c) => c.relPath === bare);
    // 未命名时写下的细纲：title 是「第 30 章」，H1 的标题位置摆的也是它。
    await project.writePlan(bare, {
      chapterRelPath: bare, order: 30, title: chapter.title, arc: '', upstreamHash: '',
      done: false,
      sections: { ...bundle.planFile.emptyPlanSections(), 本章目标: '起个名字。' },
    });

    h.answers.length = 0;
    h.answers.push('风起');
    named = await bundle.fileOps.renameEntry(project, bare);
    planRead = await project.readPlan(named);
    planText = t.read('.novelforge/plans/030-风起.md');

    // 作者手工改过的标题行不该被改名动。
    await project.createChapter(31, '', '');
    project.invalidate();
    t.write(
      '.novelforge/plans/031.md',
      '---\nchapter: chapters/031.md\norder: 31\ntitle: 我自己起的\n---\n\n# 第31章 我自己写的标题 · 细纲\n\n## 本章目标\n\n略。\n'
    );
    h.answers.length = 0;
    h.answers.push('别的名字');
    await bundle.fileOps.renameEntry(project, 'chapters/031.md');
    handwritten = t.read('.novelforge/plans/031-别的名字.md');
  });

  test('起名成功，序号后补上分隔符', () => {
    assert.equal(named, 'chapters/030-风起.md', String(named));
  });

  test('细纲的 title: 从回落值换成真标题', () => {
    assert.equal(planRead.title, '风起', planRead.title);
  });

  test('细纲的 H1 从回落值换成真标题', () => {
    assert.ok(planText.includes('# 第30章 风起 · 细纲'), planText.slice(0, 300));
  });

  test('手写过的 title: 不被覆盖', () => {
    assert.ok(handwritten.includes('title: 我自己起的'), handwritten.slice(0, 200));
  });

  // 少了「后面必须紧跟 ·」那道锚，这里会变成「# 第31章 别的名字 我自己写的标题」。
  test('手写过的 H1 不被覆盖，也不会插进第二个标题', () => {
    assert.ok(handwritten.includes('# 第31章 我自己写的标题 · 细纲'), handwritten.slice(0, 300));
    assert.ok(!handwritten.includes('别的名字 我自己写的标题'), handwritten.slice(0, 300));
  });
});

describe('新鲜度链', () => {
  const ch = 'chapters/卷一/012-夜入.md';
  let pFresh;
  let pOutlineChanged;
  let pScenesFresh;
  let pPlanChanged;
  let beatsBefore;
  let beatsAfterStatus;
  let pManuscriptFresh;
  let pManuscriptStale;

  before(async () => {
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局');
    const outlineHash = bundle.fs.hash(await project.readOutline());

    // 细纲记下当时的大纲指纹。
    await project.writePlan(ch, {
      chapterRelPath: ch, order: 12, title: '夜入', arc: '', upstreamHash: outlineHash, done: false,
      sections: { ...bundle.planFile.emptyPlanSections(), 本章目标: '进入青云宗', 冲突与节奏: '四拍推进' },
    });
    pFresh = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));

    // 改大纲 → 细纲标脏。零模型调用。
    t.write('.novelforge/outline.md', '# 大纲\n\n第一幕：入局（改了）');
    pOutlineChanged = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));

    // 场景记下当时的细纲指纹。
    const planHash = bundle.pipe.planContentHash(await project.readPlan(ch));
    for (const no of [1, 2]) {
      await project.writeScene(ch, {
        chapterRelPath: ch, no, title: `场景${no}`, place: '', time: '', characters: [],
        upstreamHash: planHash, status: 'ready',
        sections: { ...bundle.sceneFile.emptySceneSections(), 必须发生: '- 甲' },
      });
    }
    pScenesFresh = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));

    // 改细纲 → 该章全部场景标脏。
    const plan = await project.readPlan(ch);
    plan.sections.冲突与节奏 = '改成三拍';
    await project.writePlan(ch, { ...plan, chapterRelPath: ch });
    pPlanChanged = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));

    // 只改 status 不该让下游标脏——采纳正文时会把场景标 written。
    beatsBefore = await project.beatsHashFor(ch);
    await project.writeScene(ch, {
      ...(await project.readScene(ch, 1)), chapterRelPath: ch, status: 'written',
    });
    beatsAfterStatus = await project.beatsHashFor(ch);

    // 写正文 → 记下场景指纹 → 改场景 → 正文标脏。
    t.write('chapters/卷一/012-夜入.md', '# 夜入\n\n正文若干字。');
    project.invalidate();
    await project.markBeatsWritten(ch, await project.beatsHashFor(ch));
    pManuscriptFresh = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));

    const s2 = await project.readScene(ch, 2);
    s2.sections.必须发生 = '- 甲\n- 乙\n- 丙';
    await project.writeScene(ch, { ...s2, chapterRelPath: ch });
    pManuscriptStale = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(12));
  });

  test('刚生成的细纲不脏', () => {
    assert.equal(pFresh.plan.upstreamStale, false);
  });

  test('改大纲后细纲标脏', () => {
    assert.equal(pOutlineChanged.plan.upstreamStale, true);
  });

  test('刚生成的场景不脏', () => {
    assert.ok(pScenesFresh.scenes.every((s) => !s.upstreamStale));
  });

  test('改细纲后场景全部标脏', () => {
    assert.equal(pPlanChanged.scenes.length, 2);
    assert.ok(pPlanChanged.scenes.every((s) => s.upstreamStale));
  });

  test('只改场景状态不改变 beats 指纹', () => {
    assert.equal(beatsAfterStatus, beatsBefore);
  });

  test('刚写完的正文不脏', () => {
    assert.equal(pManuscriptFresh.manuscript.beatsStale, false);
  });

  test('改场景后正文标脏', () => {
    assert.equal(pManuscriptStale.manuscript.beatsStale, true);
  });

  // 上游一变，状态就退回「待写正文」——这就是变更影响在状态机上的落法。
  test('正文标脏后阶段退回待写正文', () => {
    assert.equal(pManuscriptStale.stage, 'manuscript', pManuscriptStale.stage);
  });
});

describe('新鲜度链 · 手写产物不标脏', () => {
  let p;

  before(async () => {
    // 作者手写的细纲没有 upstreamHash。拿一个凭空的过期标记去催他重做，
    // 比不标更糟——他会学会无视所有标记。
    t.write('chapters/020-手写.md', '# 手写\n\n正文');
    t.write('.novelforge/plans/020-手写.md', '## 本章目标\n\n我自己写的\n\n## 冲突与节奏\n\nx');
    project.invalidate();
    p = await bundle.pipe.buildChapterPipeline(project, await project.getChapter(20));
  });

  test('手写细纲（无 upstreamHash）不标脏', () => {
    assert.equal(p.plan.upstreamStale, false);
  });

  test('从没记过 beatsHash 的正文不标脏', () => {
    assert.equal(p.manuscript.beatsStale, false);
  });
});

describe('流水线索引', () => {
  let index;
  let chapterCount;
  let handwritten;

  before(async () => {
    index = await bundle.pipe.buildPipelineIndex(project);
    chapterCount = (await project.listChapters()).length;
    handwritten = index.get('chapters/020-手写.md');
  });

  test('索引按 relPath 索引', () => {
    assert.ok(index.has('chapters/卷一/012-夜入.md'));
  });

  test('索引覆盖全部章节', () => {
    assert.equal(index.size, chapterCount);
  });

  test('没拆场景的章节停在待拆场景', () => {
    assert.equal(handwritten.stage, 'scene', handwritten.stage);
  });

  test('没拆场景时场景完成度为 0', () => {
    assert.equal(handwritten.progress.scene, 0);
  });
});

describe('工作区卡', () => {
  const ch = 'chapters/卷一/012-夜入.md';
  let plan;
  let scene;
  let withMeta;
  let meta;
  let ms;
  let none;
  let empty;
  let skeleton;
  let shell;
  let gone;
  let outline;

  before(async () => {
    const wb = (target) => bundle.workbench.buildWorkbench(project, target);

    plan = await wb({ kind: 'plan', chapterRelPath: ch });
    scene = await wb({ kind: 'scene', chapterRelPath: ch, sceneNo: 2 });

    // 填了地点时间就该合成一行「这一幕」——那是这一层最要紧的三样元信息。
    await project.writeScene(ch, {
      chapterRelPath: ch, no: 2, title: '翻墙', place: '青云宗侧峰', time: '子时，暴雨',
      characters: ['林昭'], upstreamHash: 'X', status: 'ready',
      sections: { ...bundle.sceneFile.emptySceneSections(), 必须发生: '- 甲' },
    });
    withMeta = await wb({ kind: 'scene', chapterRelPath: ch, sceneNo: 2 });
    meta = withMeta.sections.find((s) => s.key === '这一幕');

    // 正文层只给统计。三千字摊进一张常驻卡片既读不下去，又把消息流挤没了。
    ms = await wb({ kind: 'manuscript', chapterRelPath: ch });

    // 这一层还没有产物时说清缺什么，不要给一张空卡。
    none = await wb({ kind: 'plan', chapterRelPath: 'chapters/030-没细纲.md' });
    t.write('chapters/030-没细纲.md', '# 没细纲\n\n正文');
    project.invalidate();
    empty = await wb({ kind: 'plan', chapterRelPath: 'chapters/030-没细纲.md' });

    // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
    // 只判文件在不在的话，一份全是占位符的骨架会渲染成一张只有标题的空卡。
    await project.writePlan('chapters/030-没细纲.md', {
      chapterRelPath: 'chapters/030-没细纲.md', order: 30, title: '没细纲', arc: '',
      upstreamHash: '', done: false, sections: bundle.planFile.emptyPlanSections(),
    });
    skeleton = await wb({ kind: 'plan', chapterRelPath: 'chapters/030-没细纲.md' });

    // 刚拆出来的场景只有元信息，七节全空。这时用 warning 而不是 empty——
    // empty 会连「这一幕」一起藏掉，而地点时间恰恰是这时唯一有的东西。
    await project.writeScene(ch, {
      chapterRelPath: ch, no: 5, title: '空壳', place: '山门', time: '黄昏',
      characters: [], upstreamHash: '', status: 'draft',
      sections: bundle.sceneFile.emptySceneSections(),
    });
    shell = await wb({ kind: 'scene', chapterRelPath: ch, sceneNo: 5 });

    // 章节刚被改名/删除时给一张说得清情况的空卡，而不是让整条推送失败。
    gone = await wb({ kind: 'scene', chapterRelPath: 'chapters/不存在.md', sceneNo: 1 });
    outline = await wb({ kind: 'outline' });
  });

  test('细纲卡摊开小节', () => {
    assert.ok(plan.sections.length > 0, JSON.stringify(plan.sections));
  });

  test('细纲卡标题带章号', () => {
    assert.ok(plan.title.includes('第 12 章'), plan.title);
  });

  test('细纲卡指向细纲文件', () => {
    assert.ok(plan.relPath.includes('plans/'), plan.relPath);
  });

  // 空小节不进卡片：卡片是给人看的，不是一张待填表格。
  test('空小节不显示', () => {
    assert.ok(
      plan.sections.every((s) => s.text.trim() && s.text !== '（待补充）'),
      JSON.stringify(plan.sections)
    );
  });

  test('场景卡带必须发生', () => {
    assert.ok(
      scene.sections.some((s) => s.key === '必须发生'),
      JSON.stringify(scene.sections.map((s) => s.key))
    );
  });

  // 这一场的 place/time/characters 都是空的 → 不画那一行，而不是画一行空的。
  test('没有地点时间时不画「这一幕」', () => {
    assert.ok(
      !scene.sections.some((s) => s.key === '这一幕'),
      JSON.stringify(scene.sections.map((s) => s.key))
    );
  });

  // 上一段刚改过场景的「必须发生」，但没重算 upstreamHash → 与细纲对不上。
  test('场景卡说出上游变更', () => {
    assert.ok(!!scene.warning, scene.warning);
  });

  test('有地点时间时合成「这一幕」', () => {
    assert.ok(
      meta && meta.text.includes('侧峰') && meta.text.includes('子时') && meta.text.includes('林昭'),
      JSON.stringify(withMeta.sections.map((s) => s.key))
    );
  });

  test('正文卡只给统计', () => {
    assert.ok(
      ms.sections.every((s) => s.key === '篇幅' || s.key === '场景'),
      JSON.stringify(ms.sections.map((s) => s.key))
    );
  });

  test('正文卡不摊全文', () => {
    assert.ok(ms.sections.every((s) => s.text.length < 60), JSON.stringify(ms.sections));
  });

  test('没有章节时也不抛', () => {
    assert.ok(!!none, JSON.stringify(none));
  });

  test('没有细纲时说明缺什么', () => {
    assert.ok(!!empty.empty && empty.sections.length === 0, JSON.stringify(empty));
  });

  test('空骨架细纲也说「还是空的」', () => {
    assert.ok(
      skeleton.sections.length === 0 && skeleton.empty?.includes('空'),
      JSON.stringify(skeleton)
    );
  });

  test('空壳场景仍显示元信息', () => {
    assert.ok(
      shell.sections.some((s) => s.key === '这一幕'),
      JSON.stringify(shell.sections.map((s) => s.key))
    );
  });

  test('空壳场景提示还没设计', () => {
    assert.ok(shell.warning?.includes('必须发生'), shell.warning);
  });

  test('章节不存在时给空卡而非抛', () => {
    assert.ok(!!gone.empty, JSON.stringify(gone));
  });

  test('大纲卡指向 outline.md', () => {
    assert.ok(outline.relPath.endsWith('outline.md'), outline.relPath);
  });
});
