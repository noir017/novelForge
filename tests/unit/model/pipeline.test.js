/**
 * 创作流水线纯函数：Stage × Capability × Target、细纲与场景的文件格式、章节流水线状态推导。
 * 迁自 scripts/smoke-pipeline.js 第 43-428 行（第 432 行 `====== 数据层（要落盘）` 之前的部分）。
 *
 * 这三个模块是整条流水线的地基，且全部零 I/O——所以它们能被单独 bundle 出来直接调，
 * 不需要建工程、不需要 host、不需要模型。
 *
 * 模块在文件顶层同步加载（而不是在 before() 里）：有四处用例要按模块常量
 * （CREATION_STAGES / CAPABILITIES）展开成一批 test，describe 体在收集阶段就要读到它们。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');
const planFile = loadModule('src/core/model/planFile.ts');
const sceneFile = loadModule('src/core/model/sceneFile.ts');

describe('pipeline.ts · Stage × Capability', () => {
  test('四个阶段', () => {
    assert.equal(pipeline.CREATION_STAGES.length, 4);
  });

  test('每个阶段都有身份', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_ROLE[s]));
  });

  test('每个阶段都有中文名', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_LABEL[s]));
  });

  test('每个能力都有中文名', () => {
    assert.ok(pipeline.CAPABILITIES.every((c) => pipeline.CAPABILITY_LABEL[c]));
  });

  // 每个阶段的可用能力必须是 CAPABILITIES 的子集——前端的按钮组直接读这张表，
  // 混进一个不存在的能力会渲染出一个点了什么都不会发生的按钮。
  for (const stage of pipeline.CREATION_STAGES) {
    test(`${stage} 的能力集非空且合法`, () => {
      const caps = pipeline.STAGE_CAPABILITIES[stage];
      assert.ok(caps.length > 0 && caps.every((c) => pipeline.isCapability(c)), JSON.stringify(caps));
    });

    test(`${stage} 的默认能力在可用集合里`, () => {
      const caps = pipeline.STAGE_CAPABILITIES[stage];
      assert.ok(caps.includes(pipeline.DEFAULT_CAPABILITY[stage]), pipeline.DEFAULT_CAPABILITY[stage]);
    });
  }

  // 默认动作永远是「讨论」——默认就花钱产出一份要不要都不知道的产物，
  // 是「不偷偷烧 token」的反面。
  test('默认能力一律是讨论', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.DEFAULT_CAPABILITY[s] === 'discuss'));
  });

  test('正文阶段不能拆分', () => {
    assert.ok(!pipeline.STAGE_CAPABILITIES.manuscript.includes('split'));
  });

  test('场景阶段不能拆分', () => {
    assert.ok(!pipeline.STAGE_CAPABILITIES.scene.includes('split'));
  });

  test('大纲阶段可以拆分成章', () => {
    assert.ok(pipeline.STAGE_CAPABILITIES.outline.includes('split'));
  });

  test('四个阶段都能讨论', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_CAPABILITIES[s].includes('discuss')));
  });

  test('合法动作', () => {
    assert.ok(pipeline.isValidAction({ stage: 'plan', capability: 'split' }));
  });

  test('非法组合被拒', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'manuscript', capability: 'split' }));
  });

  test('乱填的阶段被拒', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'nope', capability: 'discuss' }));
  });
});

describe('pipeline.ts · 输出形态', () => {
  const artifact = ['generate', 'rewrite', 'split'];

  for (const capability of pipeline.CAPABILITIES) {
    const expected = artifact.includes(capability) ? 'artifact' : 'text';
    test(`${capability} → ${expected}`, () => {
      const kind = pipeline.outputKindOf({ stage: 'plan', capability });
      assert.equal(kind, expected, kind);
    });
  }

  // 讨论/挑刺/检查绝不能产出可采纳的东西——否则用户会不知道该采纳哪一个。
  test('讨论不产出产物', () => {
    assert.equal(pipeline.outputKindOf({ stage: 'scene', capability: 'discuss' }), 'text');
  });
});

describe('pipeline.ts · 动作归一（容错）', () => {
  test('认得出合法动作', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'critique' }).capability, 'critique');
  });

  // 旧会话没有这两个字段：回落到正文阶段的讨论，而不是直接开始烧 token 写正文。
  test('缺字段回落到 manuscript', () => {
    assert.equal(pipeline.normalizeAction(undefined).stage, 'manuscript');
  });

  test('缺字段回落到 discuss', () => {
    assert.equal(pipeline.normalizeAction(undefined).capability, 'discuss');
  });

  test('阶段不支持的能力被换掉', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'manuscript', capability: 'split' }).capability, 'discuss');
  });

  test('认不出的阶段回落', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'beat' }).stage, 'manuscript');
  });
});

describe('pipeline.ts · Target', () => {
  const outline = { kind: 'outline' };
  const plan = { kind: 'plan', chapterRelPath: 'chapters/卷一/012-夜入青云.md' };
  const scene = { kind: 'scene', chapterRelPath: 'chapters/卷一/012-夜入青云.md', sceneNo: 2 };
  const whole = { kind: 'manuscript', chapterRelPath: 'chapters/卷一/012-夜入青云.md' };
  const oneScene = { kind: 'manuscript', chapterRelPath: 'chapters/卷一/012-夜入青云.md', sceneNo: 2 };

  test('target 的阶段', () => {
    assert.equal(pipeline.stageOfTarget(scene), 'scene');
  });

  test('大纲没有归属章节', () => {
    assert.equal(pipeline.chapterOfTarget(outline), undefined);
  });

  test('细纲有归属章节', () => {
    assert.ok(pipeline.chapterOfTarget(plan).endsWith('012-夜入青云.md'));
  });

  test('key 稳定', () => {
    assert.equal(pipeline.targetKey(scene), pipeline.targetKey({ ...scene }));
  });

  test('写整章与写某一场是不同的 key', () => {
    assert.notEqual(pipeline.targetKey(whole), pipeline.targetKey(oneScene));
  });

  test('细纲与正文是不同的 key', () => {
    assert.notEqual(pipeline.targetKey(plan), pipeline.targetKey(whole));
  });

  test('isSameTarget', () => {
    assert.ok(pipeline.isSameTarget(scene, { ...scene }));
    assert.ok(!pipeline.isSameTarget(scene, plan));
  });

  // 同序号不同文件的两章必须是不同的 target——用 order 做键就会在这里撞车。
  test('同序号不同文件不撞 key', () => {
    const twin = { kind: 'plan', chapterRelPath: 'chapters/001 正文.txt' };
    const twinB = { kind: 'plan', chapterRelPath: 'chapters/001 序.txt' };
    assert.notEqual(pipeline.targetKey(twin), pipeline.targetKey(twinB));
  });

  test('描述大纲', () => {
    assert.equal(pipeline.describeTarget(outline), '全书大纲');
  });

  test('描述细纲', () => {
    assert.equal(
      pipeline.describeTarget(plan, { order: 12, title: '夜入青云' }),
      '第 12 章《夜入青云》 · 细纲',
      pipeline.describeTarget(plan, { order: 12, title: '夜入青云' })
    );
  });

  test('描述场景', () => {
    assert.equal(
      pipeline.describeTarget(scene, { order: 12, title: '夜入青云', sceneTitle: '翻越侧峰' }),
      '第 12 章《夜入青云》 · 场景 2 翻越侧峰'
    );
  });

  test('描述整章正文', () => {
    assert.equal(
      pipeline.describeTarget(whole, { order: 12, title: '夜入青云' }),
      '第 12 章《夜入青云》 · 正文'
    );
  });

  test('没有章节信息时退回路径', () => {
    assert.ok(pipeline.describeTarget(plan).includes('012-夜入青云.md'));
  });

  // 流水线新建出来的章节是纯序号名，标题回落成「第 N 章」。套进模板会变成
  // 「第 7 章《第 7 章》」，看起来像出了 bug。
  test('未命名的章节只报序号', () => {
    assert.equal(
      pipeline.describeTarget(plan, { order: 7, title: '第 7 章' }),
      '第 7 章 · 细纲',
      pipeline.describeTarget(plan, { order: 7, title: '第 7 章' })
    );
  });
});

describe('pipeline.ts · chapterLabel', () => {
  test('有标题时带书名号', () => {
    assert.equal(pipeline.chapterLabel(12, '夜入青云'), '第 12 章《夜入青云》');
  });

  test('标题为空时只报序号', () => {
    assert.equal(pipeline.chapterLabel(7, ''), '第 7 章');
  });

  test('标题缺席时只报序号', () => {
    assert.equal(pipeline.chapterLabel(7), '第 7 章');
  });

  // 「第 7 章」正是 listChapters 对未命名章节给出的回落标题，它不是真标题。
  test('标题恰好是回落值时只报序号', () => {
    assert.equal(pipeline.chapterLabel(7, '第 7 章'), '第 7 章');
  });

  // 但作者手工把某一章命名成「第 8 章」（序号不同）就是真标题，照常显示。
  test('别的序号写在标题里仍算真标题', () => {
    assert.equal(pipeline.chapterLabel(7, '第 8 章'), '第 7 章《第 8 章》');
  });
});

describe('pipeline.ts · Target 归一（容错）', () => {
  test('认得出合法 target', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md', sceneNo: 3 }).sceneNo, 3);
  });

  // 认不出的一律回落到大纲：它是唯一不依赖任何章节就一定存在的产物。
  test('undefined 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget(undefined).kind, 'outline');
  });

  test('认不出的 kind 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'beat' }).kind, 'outline');
  });

  test('缺章节路径的细纲回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'plan', chapterRelPath: '  ' }).kind, 'outline');
  });

  // 场景号丢了但章节还在——退到该章的细纲比退回全书大纲更接近用户本意。
  test('缺场景号的场景退到该章细纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md' }).kind, 'plan');
  });

  test('场景号为 0 不认', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md', sceneNo: 0 }).kind, 'plan');
  });

  test('整章正文允许没有场景号', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'manuscript', chapterRelPath: 'a.md' }).sceneNo, undefined);
  });
});

describe('planFile.ts', () => {
  let rendered;
  let back;
  let bare;
  let emptyFilled;
  let onlyOpening;
  let withGoal;

  before(() => {
    rendered = planFile.renderPlanFile({
      chapterRelPath: 'chapters/卷一/012-夜入青云.md',
      order: 12,
      title: '夜入青云',
      arc: '第一幕 · 入局',
      targetWords: 3000,
      upstreamHash: '3f2a1c0000000000',
      done: false,
      sections: {
        本章目标: '林昭成功进入青云宗。',
        开头: '林昭在山门外观察守卫。',
        结尾: '沈月告诉林昭：「你找的人，昨晚刚从这里出去。」',
        冲突与节奏: '主冲突是身份验证；四拍推进，第三拍最危险。',
        伏笔与回收: '埋：墙内的血迹',
      },
    });
    back = planFile.parsePlanFile(rendered, '.novelforge/plans/卷一/012-夜入青云.md');

    // 空小节保留占位，作者手改时知道该往哪填（与摘要 keepEmpty 一致）。
    bare = planFile.renderPlanFile({
      chapterRelPath: 'chapters/001.md', order: 1, title: 'x', arc: '', done: false,
      sections: planFile.emptyPlanSections(),
    });

    // ---- 有没有实质内容 ----
    const filled = planFile.emptyPlanSections();
    emptyFilled = planFile.isPlanFilled(filled);
    filled.开头 = '林昭在山门外观察守卫。';
    onlyOpening = planFile.isPlanFilled(filled);
    filled.本章目标 = '进入青云宗';
    withGoal = planFile.isPlanFilled(filled);
  });

  test('细纲序列化往返 · 章节路径', () => {
    assert.equal(back.chapterRelPath, 'chapters/卷一/012-夜入青云.md');
  });

  test('细纲序列化往返 · 序号', () => {
    assert.equal(back.order, 12);
  });

  test('细纲序列化往返 · 幕', () => {
    assert.equal(back.arc, '第一幕 · 入局');
  });

  test('细纲序列化往返 · 目标字数', () => {
    assert.equal(back.targetWords, 3000);
  });

  test('细纲序列化往返 · upstreamHash', () => {
    assert.equal(back.upstreamHash, '3f2a1c0000000000');
  });

  test('细纲序列化往返 · 小节', () => {
    assert.equal(back.sections.本章目标, '林昭成功进入青云宗。');
  });

  test('细纲序列化往返 · 冲突与节奏', () => {
    assert.ok(back.sections.冲突与节奏.includes('第三拍'));
  });

  test('未标记完成时 done 为假', () => {
    assert.equal(back.done, false);
  });

  test('渲染带标题行', () => {
    assert.ok(rendered.includes('# 第12章 夜入青云 · 细纲'));
  });

  test('空小节仍写出标题与占位', () => {
    assert.ok(bare.includes('## 冲突与节奏') && bare.includes('（待补充）'));
  });

  test('status: done 被读出', () => {
    assert.equal(planFile.parsePlanFile('---\nstatus: done\n---\n\n## 本章目标\n\nx', 'p.md').done, true);
  });

  test('全空的细纲不算填过', () => {
    assert.ok(!emptyFilled);
  });

  test('只有开头不算填过（没规划就是没规划）', () => {
    assert.ok(!onlyOpening);
  });

  test('有本章目标就算填过', () => {
    assert.ok(withGoal);
  });

  test('占位文字不算内容', () => {
    const placeholder = planFile.emptyPlanSections();
    placeholder.本章目标 = '（待补充）';
    assert.ok(!planFile.isPlanFilled(placeholder));
  });

  // ---- 容错：作者手改 ----
  test('无 frontmatter 不抛错', () => {
    assert.equal(planFile.parsePlanFile('## 本章目标\n\nx', 'p.md').sections.本章目标, 'x');
  });

  test('畸形 frontmatter 不抛错', () => {
    assert.equal(planFile.parsePlanFile('---\n乱写\n---\nx', 'p.md').order, 0);
  });

  test('整份大白话不抛错', () => {
    assert.equal(planFile.parsePlanFile('随便写点什么', 'p.md').sections.本章目标, '');
  });

  test('空文件不抛错', () => {
    assert.equal(planFile.parsePlanFile('', 'p.md').chapterRelPath, '');
  });
});

describe('sceneFile.ts · 文件名规则', () => {
  const yes = ['01-山门观察.md', '02-翻越侧峰.md', '03.md', '10-初见沈月.markdown', '2_临时.md'];
  for (const name of yes) {
    test(`「${name}」算场景`, () => {
      assert.ok(sceneFile.isSceneFileName(name));
    });
  }

  // 场景是插件自己的格式，只认 md——与角色卡/设定一致，与「章节不认扩展名」相反。
  const no = ['01-山门观察.txt', '山门观察.md', '00-零号.md', 'README.md', '01.png'];
  for (const name of no) {
    test(`「${name}」不算场景`, () => {
      assert.ok(!sceneFile.isSceneFileName(name));
    });
  }

  test('解析场景号与词干', () => {
    const parsed = sceneFile.parseSceneFileName('02-翻越侧峰.md');
    assert.equal(parsed.no, 2, JSON.stringify(parsed));
    assert.equal(parsed.stem, '翻越侧峰', JSON.stringify(parsed));
  });

  // 与 parseChapterFileName 同一个坑：必须先剥扩展名，否则 `03.md` 会被吃成词干 md。
  test('`03.md` 的词干为空', () => {
    assert.equal(sceneFile.parseSceneFileName('03.md').stem, '');
  });

  test('拼文件名补两位', () => {
    assert.equal(sceneFile.sceneFileName(2, '翻越侧峰'), '02-翻越侧峰.md');
  });

  test('拼文件名 · 无标题', () => {
    assert.equal(sceneFile.sceneFileName(3, ''), '03.md');
  });

  test('拼文件名 · 两位数场景', () => {
    assert.equal(sceneFile.sceneFileName(12, 'x'), '12-x.md');
  });

  test('文件名与解析互逆', () => {
    assert.equal(sceneFile.parseSceneFileName(sceneFile.sceneFileName(7, '灵兽园')).no, 7);
  });
});

describe('sceneFile.ts · 解析与渲染', () => {
  let back;
  let conflict;

  before(() => {
    const rendered = sceneFile.renderSceneFile({
      chapterRelPath: 'chapters/卷一/012-夜入青云.md',
      no: 2,
      title: '翻越侧峰',
      place: '青云宗侧峰',
      time: '子时，暴雨',
      characters: ['林昭'],
      targetWords: 1000,
      upstreamHash: '9b4e7d0000000000',
      status: 'ready',
      sections: {
        目的: '进入青云宗',
        前置: '林昭无法伪造身份玉牌',
        必须发生: sceneFile.renderList(['林昭决定翻墙', '差点被巡逻弟子发现', '使用轻身术']),
        不能发生: sceneFile.renderList(['不能暴露真实身份', '不能遇见沈月']),
        情绪曲线: '紧张 → 危险 → 庆幸',
        人物状态: '林昭：疲惫、警惕',
        伏笔: '墙内发现奇怪的血迹',
      },
    });
    back = sceneFile.parseSceneFile(rendered, '.novelforge/scenes/卷一/012-夜入青云/02-翻越侧峰.md');

    // 场景号以**文件名**为准：作者重排顺序的方式就是改文件名前缀。
    conflict = sceneFile.parseSceneFile('---\nscene: 9\n---\n\n## 目的\n\nx', 'scenes/x/03-甲.md');
  });

  test('场景往返 · 章节路径', () => {
    assert.equal(back.chapterRelPath, 'chapters/卷一/012-夜入青云.md');
  });

  test('场景往返 · 场景号', () => {
    assert.equal(back.no, 2);
  });

  test('场景往返 · 标题', () => {
    assert.equal(back.title, '翻越侧峰');
  });

  test('场景往返 · 地点时间', () => {
    assert.equal(back.place, '青云宗侧峰');
    assert.equal(back.time, '子时，暴雨');
  });

  test('场景往返 · 人物', () => {
    assert.equal(back.characters.length, 1);
    assert.equal(back.characters[0], '林昭');
  });

  test('场景往返 · upstreamHash', () => {
    assert.equal(back.upstreamHash, '9b4e7d0000000000');
  });

  test('场景往返 · 状态', () => {
    assert.equal(back.status, 'ready');
  });

  test('场景往返 · 必须发生', () => {
    assert.equal(sceneFile.parseList(back.sections.必须发生).length, 3);
  });

  test('场景往返 · 不能发生', () => {
    assert.equal(sceneFile.parseList(back.sections.不能发生)[1], '不能遇见沈月');
  });

  test('文件名的场景号压过 frontmatter', () => {
    assert.equal(conflict.no, 3, String(conflict.no));
  });

  test('无 frontmatter 标题时用文件名词干', () => {
    assert.equal(conflict.title, '甲');
  });

  // ---- 状态推导 ----
  test('填了必须发生就 ready', () => {
    assert.equal(sceneFile.parseSceneFile('## 必须发生\n\n- 甲\n- 乙', 'scenes/x/01-a.md').status, 'ready');
  });

  test('没填必须发生就 draft', () => {
    assert.equal(sceneFile.parseSceneFile('## 目的\n\n进入宗门', 'scenes/x/01-a.md').status, 'draft');
  });

  test('认不出的状态按内容推', () => {
    assert.equal(
      sceneFile.parseSceneFile('---\nstatus: 乱写\n---\n\n## 必须发生\n\n- 甲', 'scenes/x/01-a.md').status,
      'ready'
    );
  });

  test('written 状态被保留', () => {
    assert.equal(
      sceneFile.parseSceneFile('---\nstatus: written\n---\n\n## 必须发生\n\n- 甲', 'scenes/x/01-a.md').status,
      'written'
    );
  });

  test('isSceneReady', () => {
    assert.ok(sceneFile.isSceneReady({ ...sceneFile.emptySceneSections(), 必须发生: '- 甲' }));
  });

  test('空必须发生不 ready', () => {
    assert.ok(!sceneFile.isSceneReady(sceneFile.emptySceneSections()));
  });

  test('占位不算 ready', () => {
    assert.ok(!sceneFile.isSceneReady({ ...sceneFile.emptySceneSections(), 必须发生: '（待补充）' }));
  });

  // ---- 列表往返 ----
  test('列表渲染', () => {
    assert.equal(sceneFile.renderList(['甲', '乙']), '- 甲\n- 乙');
  });

  test('列表渲染跳过空条目', () => {
    assert.equal(sceneFile.renderList(['甲', '  ', '']), '- 甲');
  });

  test('列表解析 · 星号', () => {
    assert.equal(sceneFile.parseList('* 甲\n* 乙').length, 2);
  });

  test('列表解析 · 数字', () => {
    assert.equal(sceneFile.parseList('1. 甲\n2) 乙').join('|'), '甲|乙');
  });

  test('列表解析 · 裸文本每行一条', () => {
    assert.equal(sceneFile.parseList('甲\n乙').length, 2);
  });

  test('列表解析跳过占位', () => {
    assert.equal(sceneFile.parseList('（待补充）').length, 0);
  });

  test('一行摘要', () => {
    assert.equal(
      sceneFile.describeScene({ no: 2, title: '翻越侧峰', place: '侧峰', time: '子时' }),
      '2. 翻越侧峰 · 侧峰 · 子时'
    );
  });

  test('一行摘要 · 缺字段不留空段', () => {
    assert.equal(sceneFile.describeScene({ no: 1, title: '山门观察', place: '', time: '' }), '1. 山门观察');
  });

  // ---- 容错 ----
  test('空文件不抛错', () => {
    assert.equal(sceneFile.parseSceneFile('', 'scenes/x/01-a.md').no, 1);
  });

  test('大白话不抛错', () => {
    assert.equal(sceneFile.parseSceneFile('随便写点什么', 'scenes/x/01-a.md').status, 'draft');
  });

  // characters 忘了写方括号也要收下——作者手改 frontmatter 是常态。
  test('characters 写成单行也解析', () => {
    assert.equal(
      sceneFile.parseSceneFile('---\ncharacters: 林昭、沈月\n---\nx', 'scenes/x/01-a.md').characters.length,
      2
    );
  });

  test('targetWords 写成汉字时不产生 NaN', () => {
    assert.equal(
      sceneFile.parseSceneFile('---\ntargetWords: 三千\n---\nx', 'scenes/x/01-a.md').targetWords,
      undefined
    );
  });
});

describe('pipeline.ts · 章节流水线状态推导', () => {
  const F = (patch) => ({ ...pipeline.emptyFacts(), ...patch });
  const stage = (patch) => pipeline.deriveStage(F(patch));
  const done = { hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4, sceneWritten: 4, words: 3000 };

  test('什么都没有 → 待写细纲', () => {
    assert.equal(stage({}), 'plan');
  });

  test('有细纲但没填 → 待写细纲', () => {
    assert.equal(stage({ hasPlan: true, planFilled: false }), 'plan');
  });

  test('细纲填好但没场景 → 待拆场景', () => {
    assert.equal(stage({ hasPlan: true, planFilled: true }), 'scene');
  });

  test('场景没填够 → 待拆场景', () => {
    assert.equal(stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 3 }), 'scene');
  });

  test('场景齐了正文空 → 待写正文', () => {
    assert.equal(stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4 }), 'manuscript');
  });

  test('正文写了但场景没写完 → 待写正文', () => {
    assert.equal(
      stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4, sceneWritten: 2, words: 800 }),
      'manuscript'
    );
  });

  test('正文齐了摘要没有 → 待审阅', () => {
    assert.equal(stage(done), 'review');
  });

  test('正文齐了摘要过期 → 待审阅', () => {
    assert.equal(stage({ ...done, summaryExists: true, summaryStale: true }), 'review');
  });

  test('全齐 → 已完成', () => {
    assert.equal(stage({ ...done, summaryExists: true, summaryStale: false }), 'done');
  });

  // 上游改过必须把状态拉回来——这就是「变更影响」在状态机上的落法。
  test('场景改过 → 正文重新变成待写', () => {
    assert.equal(
      stage({ ...done, summaryExists: true, summaryStale: false, beatsStale: true }),
      'manuscript'
    );
  });

  // 作者手工宣布完成：只在正文与场景都齐了之后才认，且只能向前。
  test('手工标记完成可以跳过审阅', () => {
    assert.equal(stage({ ...done, markedDone: true }), 'done');
  });

  test('手工标记不能跳过没写的正文', () => {
    assert.equal(
      stage({ hasPlan: true, planFilled: true, sceneCount: 2, sceneReady: 2, markedDone: true }),
      'manuscript'
    );
  });

  test('手工标记不能跳过没拆的场景', () => {
    assert.equal(stage({ hasPlan: true, planFilled: true, markedDone: true }), 'scene');
  });

  // ---- 完成度 ----
  const p = (patch) => pipeline.deriveProgress(F(patch));

  test('全空的完成度是 0', () => {
    assert.equal(p({}).plan, 0);
    assert.equal(p({}).scene, 0);
  });

  test('细纲建了没填算一半', () => {
    assert.equal(p({ hasPlan: true }).plan, 0.5);
  });

  test('细纲填好算 1', () => {
    assert.equal(p({ hasPlan: true, planFilled: true }).plan, 1);
  });

  test('场景 3/4 → 0.75', () => {
    assert.equal(p({ sceneCount: 4, sceneReady: 3 }).scene, 0.75);
  });

  test('正文按已写场景数算', () => {
    assert.equal(p({ sceneCount: 4, sceneWritten: 2, words: 1000 }).manuscript, 0.5);
  });

  // 没有场景但正文写了（作者跳过流水线直接写）——不该报 0%，那会让界面显得很蠢。
  test('没有场景时正文有字就算满', () => {
    assert.equal(p({ words: 1000 }).manuscript, 1);
  });

  test('摘要新鲜才算 1', () => {
    assert.equal(p({ summaryExists: true, summaryStale: false }).summary, 1);
    assert.equal(p({ summaryExists: true, summaryStale: true }).summary, 0);
  });
});

describe('pipeline.ts · 下一步（状态机 → 一个动作）', () => {
  const N = (patch) => ({ sceneCount: 0, beatsStale: false, ...patch });
  const step = (chapterStage, patch) => pipeline.deriveNextStep(chapterStage, N(patch));

  // 每一档都必须落在一个**该阶段支持**的能力上，否则界面上会出现一个
  // 后端当场回落掉的主按钮——点了跑出来的不是它写的那件事。
  for (const s of ['plan', 'scene', 'manuscript', 'review']) {
    test(`${s} 有下一步`, () => {
      const next = step(s, { sceneCount: 2, firstUnreadyScene: 1 });
      assert.ok(!!next, s);
    });

    test(`${s} 的能力在该阶段合法`, () => {
      const next = step(s, { sceneCount: 2, firstUnreadyScene: 1 });
      assert.ok(
        pipeline.STAGE_CAPABILITIES[next.stage].includes(next.capability),
        `${next.stage}·${next.capability}`
      );
    });

    test(`${s} 的下一步有说明`, () => {
      const next = step(s, { sceneCount: 2, firstUnreadyScene: 1 });
      assert.ok(!!next.label && !!next.hint, JSON.stringify(next));
    });
  }

  test('没细纲 → 生成细纲', () => {
    assert.equal(step('plan').stage, 'plan');
    assert.equal(step('plan').capability, 'generate');
  });

  // 一场都没有就先拆；这一步归**细纲**阶段（拆的是细纲），不是场景阶段。
  test('没场景 → 细纲拆场景', () => {
    const split = step('scene', { sceneCount: 0 });
    assert.equal(split.stage, 'plan', `${split.stage}·${split.capability}`);
    assert.equal(split.capability, 'split', `${split.stage}·${split.capability}`);
  });

  test('有场没填满 → 去填第一个没填的', () => {
    const design = step('scene', { sceneCount: 4, firstUnreadyScene: 3 });
    assert.equal(design.stage, 'scene', JSON.stringify(design));
    assert.equal(design.sceneNo, 3, JSON.stringify(design));
  });

  test('下一步的标题带上场号', () => {
    const design = step('scene', { sceneCount: 4, firstUnreadyScene: 3 });
    assert.ok(design.label.includes('3'), design.label);
  });

  // 场景改过而正文没跟上：要的是拿新场景重做一版，不是往后接着写。
  test('场景变过 → 重写正文', () => {
    const stale = step('manuscript', { sceneCount: 2, beatsStale: true });
    assert.equal(stale.capability, 'rewrite', stale.capability);
  });

  test('正文没写完 → 写第一场没写的', () => {
    const write = step('manuscript', { sceneCount: 2, firstUnwrittenScene: 2 });
    assert.equal(write.capability, 'generate', JSON.stringify(write));
    assert.equal(write.sceneNo, 2, JSON.stringify(write));
  });

  // 审阅要的是更新摘要，那是工程动作，不该假装成一轮对话。
  test('待审阅 → 总结本章（工程动作）', () => {
    const review = step('review');
    assert.equal(review.projectAction, 'summarizeChapter', JSON.stringify(review));
  });

  // 写完就是写完了。造一个假的下一步等于逼作者一直有事可做。
  test('已完成不催', () => {
    assert.equal(pipeline.deriveNextStep('done', N()), undefined);
  });
});

describe('pipeline.ts · 命令表', () => {
  for (const stage of pipeline.CREATION_STAGES) {
    test(`${stage} 有命令`, () => {
      assert.ok(pipeline.commandsFor(stage).length > 0);
    });

    test(`${stage} 的命令与 STAGE_CAPABILITIES 一致`, () => {
      const cmds = pipeline.commandsFor(stage);
      assert.equal(cmds.length, pipeline.STAGE_CAPABILITIES[stage].length);
      assert.ok(cmds.every((c) => pipeline.STAGE_CAPABILITIES[stage].includes(c.capability)));
    });

    test(`${stage} 的命令名不重复`, () => {
      const cmds = pipeline.commandsFor(stage);
      assert.equal(new Set(cmds.map((c) => c.label)).size, cmds.length, cmds.map((c) => c.label).join('|'));
    });

    test(`${stage} 每个命令都有说明与过滤键`, () => {
      assert.ok(pipeline.commandsFor(stage).every((c) => c.hint && c.keys.length > 0));
    });

    // 只有讨论必须先输入——它的全部内容就是作者那句话。其余命令（生成细纲、
    // 拆场景、写这一场）不该逼作者先编一句「请生成」。
    test(`${stage} 只有讨论需要输入`, () => {
      const cmds = pipeline.commandsFor(stage);
      assert.equal(
        cmds.filter((c) => c.needsText).map((c) => c.capability).join(),
        'discuss',
        cmds.filter((c) => c.needsText).map((c) => c.capability).join()
      );
    });

    test(`${stage} 的写文件标记与 outputKindOf 一致`, () => {
      assert.ok(
        pipeline.commandsFor(stage).every(
          (c) => c.writes === (pipeline.outputKindOf({ stage, capability: c.capability }) === 'artifact')
        )
      );
    });
  }

  // 同一个能力在不同阶段的说法不同——split 在大纲拆的是章，在细纲拆的是场。
  test('大纲的 split 叫拆成章节', () => {
    assert.equal(pipeline.labelOf('outline', 'split'), '拆成章节');
  });

  test('细纲的 split 叫拆成场景', () => {
    assert.equal(pipeline.labelOf('plan', 'split'), '拆成场景');
  });

  // 没有专门说法的沿用通用标签（日志与确认框用的就是它）。
  test('没覆盖的沿用通用说法', () => {
    assert.equal(pipeline.labelOf('plan', 'critique'), pipeline.CAPABILITY_LABEL.critique);
  });

  test('查得到某个具体命令', () => {
    assert.equal(pipeline.commandOf('plan', 'split')?.label, '拆成场景');
  });

  test('阶段不支持的能力查不到', () => {
    assert.equal(pipeline.commandOf('manuscript', 'split'), undefined);
  });
});
