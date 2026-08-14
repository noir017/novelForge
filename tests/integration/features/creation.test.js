/**
 * 创作编排层：产物解析的三层降级 + 六条采纳落盘路径。
 * 迁自 scripts/smoke-creation.js（73 条断言）。
 *
 * 这一层最贵的失败方式不是崩溃，而是**静默写错地方或静默覆盖**——
 * 拆场景把作者攒了三天的场景素材抹掉、采纳细纲把手写的那份顶掉。
 * 所以这里的重点不是「能不能写进去」，而是「不该写的时候有没有拦住」。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let A;
let sceneFile;
let h;
let t;
let project;
let session;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    artifact: './src/core/features/artifact.ts',
    creation: './src/core/features/creation.ts',
    sceneFile: './src/core/model/sceneFile.ts',
    pipe: './src/core/views/pipeline.ts',
  });
  A = bundle.artifact;
  sceneFile = bundle.sceneFile;
  // 原脚本的假宿主**没有** reviewReplace，于是 acceptArtifact 走 confirm 那条分支
  // （creation.ts:611 `host.reviewReplace ? … : host.confirm(…)`）。helper 默认带
  // reviewReplace，不摘掉的话「保留原样」这条路根本走不到。
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  // 原脚本没有删 initialize() 撒下的两个示例文件，这里保持一致。
  t = await makeTempProject(bundle.project, {
    prefix: 'creation',
    title: '青云剑录',
    keepExamples: true,
  });
  project = t.project;
  session = new bundle.creation.CreationSession(project);
});

after(() => {
  if (t) cleanup(t.dir);
});

// ================================================================ 产物解析

describe('artifact.ts · 细纲三层降级', () => {
  const act = { stage: 'plan', capability: 'generate' };
  let json;
  let md;
  let plain;
  let irrelevant;

  before(() => {
    json = A.parseArtifact(act, JSON.stringify({
      本章目标: '林昭进入青云宗',
      开头: '雨里的山门',
      结尾: '他站在藏书阁前',
      冲突与节奏: '三拍：踩点、失手、翻墙',
      伏笔与回收: '埋下第三块令牌',
    }));
    // 模型忘了 JSON，改回 Markdown 小节——这是最常见的不听话方式。
    md = A.parseArtifact(act, '## 本章目标\n\n林昭进入青云宗\n\n## 冲突与节奏\n\n三拍推进');
    // 什么结构都没有：全文塞进主字段，好过整次生成作废。
    plain = A.parseArtifact(act, '这一章讲林昭翻墙进宗门。');
    // 语法合法但完全不相干的 JSON 不能认下来——认了会得到一份空细纲**且不再降级**。
    irrelevant = A.parseArtifact(act, '{"text":"林昭翻墙进宗门"}');
  });

  test('第一层 JSON', () => {
    assert.equal(json.kind, 'plan');
    assert.equal(json.sections.本章目标, '林昭进入青云宗');
  });

  test('JSON 五节都收下', () => {
    assert.equal(json.sections.伏笔与回收, '埋下第三块令牌');
  });

  test('第二层 Markdown 小节', () => {
    assert.equal(md.sections.本章目标, '林昭进入青云宗');
  });

  test('Markdown 路径也收其余节', () => {
    assert.equal(md.sections.冲突与节奏, '三拍推进');
  });

  test('第三层全文兜底', () => {
    assert.equal(plain.sections.本章目标, '这一章讲林昭翻墙进宗门。');
  });

  // 严格解析不做全文兜底。批量路径（工程页一次给几十章生成细纲）用它：
  // 那里没有人逐份过目，兜底会把模型的一句「我不太确定」变成一份「已规划」
  // 的细纲，紧接着的批量拆场景还会照着它往下拆。
  test('严格解析不兜底', () => {
    assert.equal(A.parsePlanStrict('这一章讲林昭翻墙进宗门。'), undefined);
  });

  test('严格解析仍认 JSON', () => {
    assert.equal(A.parsePlanStrict('{"本章目标":"进宗门"}')?.本章目标, '进宗门');
  });

  test('严格解析仍认 Markdown 小节', () => {
    assert.equal(A.parsePlanStrict('## 本章目标\n\n进宗门')?.本章目标, '进宗门');
  });

  test('不相干的 JSON 退到全文兜底', () => {
    assert.ok(irrelevant.sections.本章目标.includes('林昭翻墙'), JSON.stringify(irrelevant.sections));
  });

  test('代码块包裹能剥掉', () => {
    assert.equal(
      A.parseArtifact(act, '```json\n{"本章目标":"进宗门"}\n```').sections.本章目标,
      '进宗门'
    );
  });

  test('JSON 前后的废话不影响解析', () => {
    assert.equal(
      A.parseArtifact(act, '好的，以下是细纲：\n{"本章目标":"进宗门"}\n希望有帮助').sections.本章目标,
      '进宗门'
    );
  });
});

describe('artifact.ts · 场景卡', () => {
  const act = { stage: 'scene', capability: 'generate' };
  let scene;
  let md;

  before(() => {
    scene = A.parseArtifact(act, JSON.stringify({
      place: '青云宗侧峰',
      time: '子时，暴雨',
      characters: ['林昭', '守卫'],
      targetWords: 1200,
      目的: '进入宗门',
      环境: '雨下了两个时辰，墙头的灯只剩一团黄。',
      动作: ['第一次翻墙失手', '守卫换岗', '林昭翻过去'],
      对话: '守卫：「这雨下得，鬼都不来。」',
    }));
    md = A.parseArtifact(act, '## 目的\n\n进入宗门\n\n## 动作\n\n翻墙，落地时崴了脚');
  });

  test('场景 frontmatter 字段', () => {
    assert.equal(scene.place, '青云宗侧峰');
    assert.equal(scene.time, '子时，暴雨');
  });

  test('在场人物成数组', () => {
    assert.ok(Array.isArray(scene.characters), JSON.stringify(scene.characters));
    assert.equal(scene.characters.length, 2);
  });

  test('目标字数取整数', () => {
    assert.equal(scene.targetWords, 1200);
  });

  test('散文小节原样收下', () => {
    assert.ok(scene.sections.环境.includes('只剩一团黄'), scene.sections.环境);
    assert.ok(scene.sections.对话.includes('鬼都不来'), scene.sections.对话);
  });

  // 模型爱给数组。小节存的是 Markdown，所以数组归一成列表行而不是 `[object]`。
  test('数组小节归一成 Markdown 列表', () => {
    assert.equal(
      scene.sections.动作,
      '- 第一次翻墙失手\n- 守卫换岗\n- 林昭翻过去',
      JSON.stringify(scene.sections.动作)
    );
  });

  test('场景卡也能走 Markdown 路径', () => {
    assert.equal(md.sections.目的, '进入宗门');
    assert.equal(md.sections.动作, '翻墙，落地时崴了脚');
  });

  test('Markdown 路径没有 frontmatter 字段也不炸', () => {
    assert.equal(md.place, '');
    assert.equal(md.characters.length, 0);
  });

  // 第三层兜底不能落在「目的」上：那一节不算 ready（拆场景时就填上了），
  // 兜底进去的话这一场采纳后会显示成「还没有素材」的空壳。
  test('无结构散文兜底进算 ready 的小节', () => {
    const prose = A.parseArtifact(act, '雨下了两个时辰，墙头的灯只剩一团黄。');
    assert.ok(sceneFile.isSceneReady(prose.sections), JSON.stringify(prose.sections));
  });
});

describe('artifact.ts · 拆分清单', () => {
  const outlineSplit = { stage: 'outline', capability: 'split' };
  let list;
  let bare;
  let mdList;
  let prose;
  let longTitle;
  let sceneSplit;

  before(() => {
    list = A.parseArtifact(outlineSplit, JSON.stringify({
      chapters: [
        { order: 12, title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕 · 入局' },
        { title: '藏书阁', goal: '找到第三块令牌' },
      ],
    }));
    // 模型漏掉外层键，直接给数组。
    bare = A.parseArtifact(outlineSplit, '[{"title":"夜入青云","goal":"进宗门"}]');
    // 模型整个忘了 JSON，列了一串 Markdown。
    mdList = A.parseArtifact(outlineSplit, '1. 夜入青云\n2. 藏书阁夜谈\n3. 沈氏来访');
    // 一段说明文字不该被拆成几十项「章节」。
    prose = A.parseArtifact(outlineSplit, '这本书大致分三幕。\n第一幕讲入局。\n第二幕讲反转。');
    // 标题会变成文件名，模型很爱把一整句梗概当标题。
    longTitle = A.parseArtifact(outlineSplit,
      '[{"title":"林昭在暴雨的深夜翻越青云宗的侧峰围墙并且成功进入了藏书阁"}]');
    sceneSplit = A.parseArtifact({ stage: 'plan', capability: 'split' }, JSON.stringify({
      scenes: [{ title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], targetWords: 1000 }],
    }));
  });

  test('拆章走 chapters 键', () => {
    assert.equal(list.kind, 'chapterList');
    assert.equal(list.chapters.length, 2);
  });

  test('带序号的保留序号', () => {
    assert.equal(list.chapters[0].order, 12);
  });

  test('不带序号的留空由调用方续号', () => {
    assert.equal(list.chapters[1].order, undefined);
  });

  test('裸数组也认', () => {
    assert.equal(bare.chapters.length, 1);
    assert.equal(bare.chapters[0].title, '夜入青云');
  });

  test('Markdown 列表兜底', () => {
    assert.equal(mdList.chapters.length, 3, JSON.stringify(mdList.chapters));
  });

  test('列表项的序号前缀被剥掉', () => {
    assert.equal(mdList.chapters[0].title, '夜入青云', mdList.chapters[0].title);
  });

  test('散文不被误拆成章节清单', () => {
    assert.equal(prose.chapters.length, 0, JSON.stringify(prose.chapters));
  });

  test('过长的标题被收口', () => {
    assert.ok(longTitle.chapters[0].title.length <= 18, longTitle.chapters[0].title);
  });

  test('拆场景走 scenes 键', () => {
    assert.equal(sceneSplit.kind, 'sceneList');
    assert.equal(sceneSplit.scenes.length, 1);
  });

  test('场景清单带上地点时间', () => {
    assert.equal(sceneSplit.scenes[0].place, '侧峰');
    assert.equal(sceneSplit.scenes[0].time, '子时');
  });
});

describe('artifact.ts · 空产物与描述', () => {
  test('正文原样收下', () => {
    assert.equal(
      A.parseArtifact({ stage: 'manuscript', capability: 'generate' }, '雨下了三天。').text,
      '雨下了三天。'
    );
  });

  test('空正文算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'manuscript', text: '   ' }));
  });

  test('空清单算空产物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'chapterList', chapters: [] }));
  });

  test('有内容的不算空', () => {
    assert.ok(!A.isArtifactEmpty(A.parseArtifact({ stage: 'plan', capability: 'generate' }, '{"本章目标":"x"}')));
  });

  test('描述带得出条数', () => {
    assert.equal(A.describeArtifact({ kind: 'chapterList', chapters: [1, 2, 3] }), '3 章');
  });
});

// ================================================================ 采纳落盘

describe('采纳 · 大纲拆章', () => {
  let result;
  let again;
  let chapterCount;

  before(async () => {
    result = await session.acceptArtifact(
      { kind: 'outline' },
      {
        kind: 'chapterList',
        chapters: [
          { title: '夜入青云', goal: '林昭进入宗门', arc: '第一幕' },
          { title: '藏书阁', goal: '找到令牌', arc: '第一幕' },
        ],
      }
    );
    chapterCount = (await project.listChapters()).length;
    // 已存在的序号一律跳过，绝不覆盖。
    again = await session.acceptArtifact(
      { kind: 'outline' },
      { kind: 'chapterList', chapters: [{ order: 1, title: '换个名', goal: '不该写进去', arc: '' }] }
    );
  });

  test('建出两章', () => {
    assert.equal(chapterCount, 2, result.message);
  });

  test('章节文件按序号命名', () => {
    assert.ok(t.has('chapters/001-夜入青云.md') && t.has('chapters/002-藏书阁.md'));
  });

  // 建空章节而不是只建细纲：四套镜像路径全都挂在章节的 relPath 上。
  test('同时建出细纲', () => {
    assert.ok(t.has('.novelforge/plans/001-夜入青云.md'));
  });

  test('细纲里带上了大纲给的目标', () => {
    assert.ok(t.read('.novelforge/plans/001-夜入青云.md').includes('林昭进入宗门'));
  });

  // 细纲记下了大纲的指纹——改了大纲，这份细纲才标得出脏。
  test('细纲记下上游指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(t.read('.novelforge/plans/001-夜入青云.md')));
  });

  test('已存在的序号被跳过', () => {
    assert.ok(again.message.includes('跳过'), again.message);
  });

  test('原章节没被改名', () => {
    assert.ok(t.has('chapters/001-夜入青云.md') && !t.has('chapters/001-换个名.md'));
  });

  test('原细纲没被覆盖', () => {
    assert.ok(!t.read('.novelforge/plans/001-夜入青云.md').includes('不该写进去'));
  });
});

describe('采纳 · 细纲（覆盖要审阅）', () => {
  let kept;
  let afterKept;
  let written;
  let same;

  before(async () => {
    const target = { kind: 'plan', chapterRelPath: 'chapters/001-夜入青云.md' };
    const sections = {
      本章目标: '林昭进入青云宗',
      开头: '雨里的山门',
      结尾: '藏书阁前',
      冲突与节奏: '三拍推进',
      伏笔与回收: '第三块令牌',
    };

    // 已有一份（拆章时建的），内容不同 → 必须问。答「保留原样」就不能写。
    h.answers.push('保留原样');
    kept = await session.acceptArtifact(target, { kind: 'plan', sections });
    // 原脚本在这一刻读盘断言，下一步就会把内容覆盖掉，所以先抓快照。
    afterKept = t.read('.novelforge/plans/001-夜入青云.md');

    h.answers.push('覆盖');
    written = await session.acceptArtifact(target, { kind: 'plan', sections });

    // 一字未变时不该弹框——弹了只会让人以为自己点错了。answers 空着，
    // 真弹框的话 confirm 返回 undefined，会被当成取消而 skipped。
    same = await session.acceptArtifact(target, { kind: 'plan', sections });
  });

  test('拒绝覆盖时不写盘', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('拒绝后磁盘上还是旧的', () => {
    assert.ok(!afterKept.includes('三拍推进'));
  });

  test('确认后才写', () => {
    assert.equal(written.relPath, '.novelforge/plans/001-夜入青云.md', written.message);
  });

  test('新内容已落盘', () => {
    assert.ok(t.read('.novelforge/plans/001-夜入青云.md').includes('三拍推进'));
  });

  test('内容相同不弹框直接通过', () => {
    assert.notEqual(same.skipped, true, same.message);
    assert.ok(!!same.relPath, same.message);
  });
});

describe('采纳 · 细纲拆场景', () => {
  let result;
  let first;
  let again;

  before(async () => {
    const target = { kind: 'plan', chapterRelPath: 'chapters/001-夜入青云.md' };
    result = await session.acceptArtifact(target, {
      kind: 'sceneList',
      scenes: [
        { title: '踩点', place: '山门外', time: '戌时', characters: ['林昭'], goal: '摸清换岗' },
        { title: '翻越侧峰', place: '侧峰', time: '子时', characters: ['林昭'], goal: '进入宗门' },
      ],
    });
    first = t.read('.novelforge/scenes/001-夜入青云/01-踩点.md');

    // 再拆一次：已有的两场绝不覆盖，新的接着往后排。
    again = await session.acceptArtifact(target, {
      kind: 'sceneList',
      scenes: [{ title: '追兵', place: '后山', time: '丑时', characters: [], goal: '甩掉追兵' }],
    });
  });

  test('拆出两场', () => {
    assert.ok(result.message.includes('2 场'), result.message);
  });

  test('场景文件两位数前缀', () => {
    assert.ok(t.has('.novelforge/scenes/001-夜入青云/01-踩点.md'));
  });

  test('第二场按序排下去', () => {
    assert.ok(t.has('.novelforge/scenes/001-夜入青云/02-翻越侧峰.md'));
  });

  test('场景卡带上地点时间', () => {
    assert.ok(first.includes('place: 山门外') && first.includes('time: 戌时'));
  });

  // 刚拆出来的是壳，还没有素材——status 得如实说 draft。
  test('新拆的场景是 draft', () => {
    assert.ok(first.includes('status: draft'));
  });

  test('场景记下细纲指纹', () => {
    assert.ok(/upstreamHash: \w+/.test(first));
  });

  test('二次拆分不动原有场景', () => {
    assert.ok(again.message.includes('原有 2 场未动'), again.message);
  });

  test('新场景排在后面', () => {
    assert.ok(t.has('.novelforge/scenes/001-夜入青云/03-追兵.md'));
  });

  test('原场景内容还在', () => {
    assert.ok(t.read('.novelforge/scenes/001-夜入青云/01-踩点.md').includes('摸清换岗'));
  });
});

describe('采纳 · 单张场景卡', () => {
  let result;
  let text;

  before(async () => {
    const target = { kind: 'scene', chapterRelPath: 'chapters/001-夜入青云.md', sceneNo: 1 };
    h.answers.push('覆盖');
    result = await session.acceptArtifact(target, {
      kind: 'scene',
      place: '山门外',
      time: '戌时，小雨',
      characters: ['林昭', '守卫甲'],
      targetWords: 900,
      sections: {
        目的: '摸清换岗',
        环境: '戌时的小雨，巷口的灯笼被风吹得晃。',
        人物状态: '他还不知道令牌在藏书阁',
        动作: '蹲在巷口数换岗的人数，被狗叫惊动，退回墙根',
        对话: '守卫甲：「谁在那儿？」',
        细节与意象: '那条拴在门柱上的黄狗',
      },
    });
    text = t.read('.novelforge/scenes/001-夜入青云/01-踩点.md');
  });

  test('场景卡写回原文件', () => {
    assert.equal(result.relPath, '.novelforge/scenes/001-夜入青云/01-踩点.md', result.message);
  });

  // 有素材就是可以开写——状态由内容推，不靠调用方记得传。
  test('有素材就转 ready', () => {
    assert.ok(text.includes('status: ready'));
  });

  test('在场人物写进 frontmatter', () => {
    assert.ok(text.includes('林昭') && text.includes('守卫甲'));
  });

  test('改写不改文件名', () => {
    assert.ok(!t.has('.novelforge/scenes/001-夜入青云/01-摸清换岗.md'));
  });
});

describe('采纳 · 正文', () => {
  const chapterRelPath = 'chapters/001-夜入青云.md';
  let beatsBefore;
  let result;
  let entry;
  let scene;
  let pipe;

  before(async () => {
    const target = { kind: 'manuscript', chapterRelPath, sceneNo: 1 };
    beatsBefore = await project.beatsHashFor(chapterRelPath);

    result = await session.acceptArtifact(target, {
      kind: 'manuscript',
      text: '雨下了三天，青云宗的石阶泡得发白。',
    });

    // 写完要记一笔 beatsHash，否则这一章会永远显示（或永远不显示）「与场景对不上」。
    const manifest = await project.readManifest();
    entry = manifest.chapters.find((c) => c.file === chapterRelPath);
    // 写的是某一场 → 那一场标 written，流水线进度才走得动。
    scene = await project.readScene(chapterRelPath, 1);

    pipe = await bundle.pipe.buildChapterPipeline(
      project,
      (await project.listChapters()).find((c) => c.relPath === chapterRelPath)
    );
  });

  test('场景齐了就算得出 beatsHash', () => {
    assert.ok(beatsBefore.length > 0);
  });

  test('正文追加到章节', () => {
    assert.equal(result.relPath, chapterRelPath, result.message);
  });

  test('正文确实写进去了', () => {
    assert.ok(t.read(chapterRelPath).includes('石阶泡得发白'));
  });

  test('manifest 记下 beatsHash', () => {
    assert.equal(entry?.beatsHash, beatsBefore, entry?.beatsHash);
  });

  test('对应场景标记为 written', () => {
    assert.equal(scene.status, 'written', scene.status);
  });

  test('刚写完的正文不标脏', () => {
    assert.equal(pipe.manuscript.beatsStale, false);
  });

  test('流水线看得见 1/3 场写完', () => {
    assert.ok(Math.abs(pipe.progress.manuscript - 1 / 3) < 1e-9, String(pipe.progress.manuscript));
  });
});

describe('采纳 · 新建章节', () => {
  let result;

  before(async () => {
    const order = await project.nextChapterOrder();
    result = await session.acceptAsNewChapter('林昭推开门。', order, '');
  });

  test('空标题时用首句兜底', () => {
    assert.ok(result.relPath.includes('林昭推开门'), result.relPath);
  });

  test('新章节已落盘', () => {
    assert.ok(fs.existsSync(t.rel(result.relPath)));
  });
});

describe('采纳 · 大纲整篇替换', () => {
  let result;
  let outline;

  before(async () => {
    h.answers.push('覆盖');
    result = await session.acceptArtifact(
      { kind: 'outline' },
      { kind: 'outlineDoc', text: '## 第一幕 · 入局\n\n- 林昭进宗门' }
    );
    outline = await project.readOutline();
  });

  test('大纲写回 outline.md', () => {
    assert.ok(result.relPath.endsWith('outline.md'), result.message);
  });

  test('大纲内容已换', () => {
    assert.ok(outline.includes('林昭进宗门'));
  });
});

describe('采纳 · 目标不存在时报错而不是乱写', () => {
  let message = '';

  before(async () => {
    try {
      await session.acceptArtifact(
        { kind: 'manuscript', chapterRelPath: 'chapters/999-不存在.md' },
        { kind: 'manuscript', text: 'x' }
      );
    } catch (err) {
      message = String(err.message ?? err);
    }
  });

  test('找不到章节时抛错', () => {
    assert.ok(message.includes('找不到章节'), message);
  });

  test('没有凭空造出章节', () => {
    assert.ok(!t.has('chapters/999-不存在.md'));
  });
});
