/**
 * 创作流水线纯函数的离线验证：Stage × Capability × Target、
 * 细纲与场景的文件格式、章节流水线状态推导。
 *
 * 这三个模块是整条流水线的地基，且全部零 I/O——所以它们能被单独 bundle 出来
 * 直接调，不需要建工程、不需要 host、不需要模型。
 *
 * 用法：node scripts/smoke-pipeline.js
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const pipeline = loadModule('src/core/model/pipeline.ts');
const planFile = loadModule('src/core/model/planFile.ts');
const sceneFile = loadModule('src/core/model/sceneFile.ts');

console.log('\n== pipeline.ts · Stage × Capability ==');
{
  check('四个阶段', pipeline.CREATION_STAGES.length === 4);
  check('每个阶段都有身份', pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_ROLE[s]));
  check('每个阶段都有中文名', pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_LABEL[s]));
  check('每个能力都有中文名', pipeline.CAPABILITIES.every((c) => pipeline.CAPABILITY_LABEL[c]));

  // 每个阶段的可用能力必须是 CAPABILITIES 的子集——前端的按钮组直接读这张表，
  // 混进一个不存在的能力会渲染出一个点了什么都不会发生的按钮。
  for (const stage of pipeline.CREATION_STAGES) {
    const caps = pipeline.STAGE_CAPABILITIES[stage];
    check(`${stage} 的能力集非空且合法`,
      caps.length > 0 && caps.every((c) => pipeline.isCapability(c)), JSON.stringify(caps));
    check(`${stage} 的默认能力在可用集合里`,
      caps.includes(pipeline.DEFAULT_CAPABILITY[stage]), pipeline.DEFAULT_CAPABILITY[stage]);
  }

  // 默认动作永远是「讨论」——默认就花钱产出一份要不要都不知道的产物，
  // 是「不偷偷烧 token」的反面。
  check('默认能力一律是讨论',
    pipeline.CREATION_STAGES.every((s) => pipeline.DEFAULT_CAPABILITY[s] === 'discuss'));

  check('正文阶段不能拆分', !pipeline.STAGE_CAPABILITIES.manuscript.includes('split'));
  check('场景阶段不能拆分', !pipeline.STAGE_CAPABILITIES.scene.includes('split'));
  check('大纲阶段可以拆分成章', pipeline.STAGE_CAPABILITIES.outline.includes('split'));
  check('四个阶段都能讨论',
    pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_CAPABILITIES[s].includes('discuss')));

  check('合法动作', pipeline.isValidAction({ stage: 'plan', capability: 'split' }));
  check('非法组合被拒', !pipeline.isValidAction({ stage: 'manuscript', capability: 'split' }));
  check('乱填的阶段被拒', !pipeline.isValidAction({ stage: 'nope', capability: 'discuss' }));
}

console.log('\n== pipeline.ts · 输出形态 ==');
{
  const artifact = ['generate', 'rewrite', 'split'];
  for (const capability of pipeline.CAPABILITIES) {
    const kind = pipeline.outputKindOf({ stage: 'plan', capability });
    check(`${capability} → ${artifact.includes(capability) ? 'artifact' : 'text'}`,
      kind === (artifact.includes(capability) ? 'artifact' : 'text'), kind);
  }
  // 讨论/挑刺/检查绝不能产出可采纳的东西——否则用户会不知道该采纳哪一个。
  check('讨论不产出产物', pipeline.outputKindOf({ stage: 'scene', capability: 'discuss' }) === 'text');
}

console.log('\n== pipeline.ts · 动作归一（容错） ==');
{
  check('认得出合法动作',
    pipeline.normalizeAction({ stage: 'scene', capability: 'critique' }).capability === 'critique');
  // 旧会话没有这两个字段：回落到正文阶段的讨论，而不是直接开始烧 token 写正文。
  const empty = pipeline.normalizeAction(undefined);
  check('缺字段回落到 manuscript', empty.stage === 'manuscript');
  check('缺字段回落到 discuss', empty.capability === 'discuss');
  check('阶段不支持的能力被换掉',
    pipeline.normalizeAction({ stage: 'manuscript', capability: 'split' }).capability === 'discuss');
  check('认不出的阶段回落', pipeline.normalizeAction({ stage: 'beat' }).stage === 'manuscript');
}

console.log('\n== pipeline.ts · Target ==');
{
  const outline = { kind: 'outline' };
  const plan = { kind: 'plan', chapterRelPath: 'chapters/卷一/012-夜入青云.md' };
  const scene = { kind: 'scene', chapterRelPath: 'chapters/卷一/012-夜入青云.md', sceneNo: 2 };
  const whole = { kind: 'manuscript', chapterRelPath: 'chapters/卷一/012-夜入青云.md' };
  const oneScene = { kind: 'manuscript', chapterRelPath: 'chapters/卷一/012-夜入青云.md', sceneNo: 2 };

  check('target 的阶段', pipeline.stageOfTarget(scene) === 'scene');
  check('大纲没有归属章节', pipeline.chapterOfTarget(outline) === undefined);
  check('细纲有归属章节', pipeline.chapterOfTarget(plan).endsWith('012-夜入青云.md'));

  check('key 稳定', pipeline.targetKey(scene) === pipeline.targetKey({ ...scene }));
  check('写整章与写某一场是不同的 key', pipeline.targetKey(whole) !== pipeline.targetKey(oneScene));
  check('细纲与正文是不同的 key', pipeline.targetKey(plan) !== pipeline.targetKey(whole));
  check('isSameTarget', pipeline.isSameTarget(scene, { ...scene }) && !pipeline.isSameTarget(scene, plan));

  // 同序号不同文件的两章必须是不同的 target——用 order 做键就会在这里撞车。
  const twin = { kind: 'plan', chapterRelPath: 'chapters/001 正文.txt' };
  const twinB = { kind: 'plan', chapterRelPath: 'chapters/001 序.txt' };
  check('同序号不同文件不撞 key', pipeline.targetKey(twin) !== pipeline.targetKey(twinB));

  check('描述大纲', pipeline.describeTarget(outline) === '全书大纲');
  check('描述细纲',
    pipeline.describeTarget(plan, { order: 12, title: '夜入青云' }) === '第 12 章《夜入青云》 · 细纲',
    pipeline.describeTarget(plan, { order: 12, title: '夜入青云' }));
  check('描述场景',
    pipeline.describeTarget(scene, { order: 12, title: '夜入青云', sceneTitle: '翻越侧峰' })
      === '第 12 章《夜入青云》 · 场景 2 翻越侧峰');
  check('描述整章正文',
    pipeline.describeTarget(whole, { order: 12, title: '夜入青云' }) === '第 12 章《夜入青云》 · 正文');
  check('没有章节信息时退回路径',
    pipeline.describeTarget(plan).includes('012-夜入青云.md'));
}

console.log('\n== pipeline.ts · Target 归一（容错） ==');
{
  check('认得出合法 target',
    pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md', sceneNo: 3 }).sceneNo === 3);
  // 认不出的一律回落到大纲：它是唯一不依赖任何章节就一定存在的产物。
  check('undefined 回落到大纲', pipeline.normalizeTarget(undefined).kind === 'outline');
  check('认不出的 kind 回落到大纲', pipeline.normalizeTarget({ kind: 'beat' }).kind === 'outline');
  check('缺章节路径的细纲回落到大纲',
    pipeline.normalizeTarget({ kind: 'plan', chapterRelPath: '  ' }).kind === 'outline');
  // 场景号丢了但章节还在——退到该章的细纲比退回全书大纲更接近用户本意。
  check('缺场景号的场景退到该章细纲',
    pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md' }).kind === 'plan');
  check('场景号为 0 不认', pipeline.normalizeTarget({ kind: 'scene', chapterRelPath: 'a.md', sceneNo: 0 }).kind === 'plan');
  check('整章正文允许没有场景号',
    pipeline.normalizeTarget({ kind: 'manuscript', chapterRelPath: 'a.md' }).sceneNo === undefined);
}

console.log('\n== planFile.ts ==');
{
  const rendered = planFile.renderPlanFile({
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

  const back = planFile.parsePlanFile(rendered, '.novelforge/plans/卷一/012-夜入青云.md');
  check('细纲序列化往返 · 章节路径', back.chapterRelPath === 'chapters/卷一/012-夜入青云.md');
  check('细纲序列化往返 · 序号', back.order === 12);
  check('细纲序列化往返 · 幕', back.arc === '第一幕 · 入局');
  check('细纲序列化往返 · 目标字数', back.targetWords === 3000);
  check('细纲序列化往返 · upstreamHash', back.upstreamHash === '3f2a1c0000000000');
  check('细纲序列化往返 · 小节', back.sections.本章目标 === '林昭成功进入青云宗。');
  check('细纲序列化往返 · 冲突与节奏', back.sections.冲突与节奏.includes('第三拍'));
  check('未标记完成时 done 为假', back.done === false);
  check('渲染带标题行', rendered.includes('# 第12章 夜入青云 · 细纲'));
  // 空小节保留占位，作者手改时知道该往哪填（与摘要 keepEmpty 一致）。
  const bare = planFile.renderPlanFile({
    chapterRelPath: 'chapters/001.md', order: 1, title: 'x', arc: '', done: false,
    sections: planFile.emptyPlanSections(),
  });
  check('空小节仍写出标题与占位', bare.includes('## 冲突与节奏') && bare.includes('（待补充）'));

  check('status: done 被读出',
    planFile.parsePlanFile('---\nstatus: done\n---\n\n## 本章目标\n\nx', 'p.md').done === true);

  // ---- 有没有实质内容 ----
  const filled = planFile.emptyPlanSections();
  check('全空的细纲不算填过', !planFile.isPlanFilled(filled));
  filled.开头 = '林昭在山门外观察守卫。';
  check('只有开头不算填过（没规划就是没规划）', !planFile.isPlanFilled(filled));
  filled.本章目标 = '进入青云宗';
  check('有本章目标就算填过', planFile.isPlanFilled(filled));
  const placeholder = planFile.emptyPlanSections();
  placeholder.本章目标 = '（待补充）';
  check('占位文字不算内容', !planFile.isPlanFilled(placeholder));

  // ---- 容错：作者手改 ----
  check('无 frontmatter 不抛错', planFile.parsePlanFile('## 本章目标\n\nx', 'p.md').sections.本章目标 === 'x');
  check('畸形 frontmatter 不抛错', planFile.parsePlanFile('---\n乱写\n---\nx', 'p.md').order === 0);
  check('整份大白话不抛错', planFile.parsePlanFile('随便写点什么', 'p.md').sections.本章目标 === '');
  check('空文件不抛错', planFile.parsePlanFile('', 'p.md').chapterRelPath === '');
}

console.log('\n== sceneFile.ts · 文件名规则 ==');
{
  const yes = ['01-山门观察.md', '02-翻越侧峰.md', '03.md', '10-初见沈月.markdown', '2_临时.md'];
  for (const name of yes) check(`「${name}」算场景`, sceneFile.isSceneFileName(name));
  // 场景是插件自己的格式，只认 md——与角色卡/设定一致，与「章节不认扩展名」相反。
  const no = ['01-山门观察.txt', '山门观察.md', '00-零号.md', 'README.md', '01.png'];
  for (const name of no) check(`「${name}」不算场景`, !sceneFile.isSceneFileName(name));

  const parsed = sceneFile.parseSceneFileName('02-翻越侧峰.md');
  check('解析场景号与词干', parsed.no === 2 && parsed.stem === '翻越侧峰', JSON.stringify(parsed));
  // 与 parseChapterFileName 同一个坑：必须先剥扩展名，否则 `03.md` 会被吃成词干 md。
  check('`03.md` 的词干为空', sceneFile.parseSceneFileName('03.md').stem === '');

  check('拼文件名补两位', sceneFile.sceneFileName(2, '翻越侧峰') === '02-翻越侧峰.md');
  check('拼文件名 · 无标题', sceneFile.sceneFileName(3, '') === '03.md');
  check('拼文件名 · 两位数场景', sceneFile.sceneFileName(12, 'x') === '12-x.md');
  check('文件名与解析互逆',
    sceneFile.parseSceneFileName(sceneFile.sceneFileName(7, '灵兽园')).no === 7);
}

console.log('\n== sceneFile.ts · 解析与渲染 ==');
{
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

  const back = sceneFile.parseSceneFile(rendered, '.novelforge/scenes/卷一/012-夜入青云/02-翻越侧峰.md');
  check('场景往返 · 章节路径', back.chapterRelPath === 'chapters/卷一/012-夜入青云.md');
  check('场景往返 · 场景号', back.no === 2);
  check('场景往返 · 标题', back.title === '翻越侧峰');
  check('场景往返 · 地点时间', back.place === '青云宗侧峰' && back.time === '子时，暴雨');
  check('场景往返 · 人物', back.characters.length === 1 && back.characters[0] === '林昭');
  check('场景往返 · upstreamHash', back.upstreamHash === '9b4e7d0000000000');
  check('场景往返 · 状态', back.status === 'ready');
  check('场景往返 · 必须发生', sceneFile.parseList(back.sections.必须发生).length === 3);
  check('场景往返 · 不能发生', sceneFile.parseList(back.sections.不能发生)[1] === '不能遇见沈月');

  // 场景号以**文件名**为准：作者重排顺序的方式就是改文件名前缀。
  const conflict = sceneFile.parseSceneFile('---\nscene: 9\n---\n\n## 目的\n\nx', 'scenes/x/03-甲.md');
  check('文件名的场景号压过 frontmatter', conflict.no === 3, String(conflict.no));
  check('无 frontmatter 标题时用文件名词干', conflict.title === '甲');

  // ---- 状态推导 ----
  check('填了必须发生就 ready',
    sceneFile.parseSceneFile('## 必须发生\n\n- 甲\n- 乙', 'scenes/x/01-a.md').status === 'ready');
  check('没填必须发生就 draft',
    sceneFile.parseSceneFile('## 目的\n\n进入宗门', 'scenes/x/01-a.md').status === 'draft');
  check('认不出的状态按内容推',
    sceneFile.parseSceneFile('---\nstatus: 乱写\n---\n\n## 必须发生\n\n- 甲', 'scenes/x/01-a.md').status === 'ready');
  check('written 状态被保留',
    sceneFile.parseSceneFile('---\nstatus: written\n---\n\n## 必须发生\n\n- 甲', 'scenes/x/01-a.md').status === 'written');

  check('isSceneReady', sceneFile.isSceneReady({ ...sceneFile.emptySceneSections(), 必须发生: '- 甲' }));
  check('空必须发生不 ready', !sceneFile.isSceneReady(sceneFile.emptySceneSections()));
  check('占位不算 ready',
    !sceneFile.isSceneReady({ ...sceneFile.emptySceneSections(), 必须发生: '（待补充）' }));

  // ---- 列表往返 ----
  check('列表渲染', sceneFile.renderList(['甲', '乙']) === '- 甲\n- 乙');
  check('列表渲染跳过空条目', sceneFile.renderList(['甲', '  ', '']) === '- 甲');
  check('列表解析 · 星号', sceneFile.parseList('* 甲\n* 乙').length === 2);
  check('列表解析 · 数字', sceneFile.parseList('1. 甲\n2) 乙').join('|') === '甲|乙');
  check('列表解析 · 裸文本每行一条', sceneFile.parseList('甲\n乙').length === 2);
  check('列表解析跳过占位', sceneFile.parseList('（待补充）').length === 0);

  check('一行摘要',
    sceneFile.describeScene({ no: 2, title: '翻越侧峰', place: '侧峰', time: '子时' })
      === '2. 翻越侧峰 · 侧峰 · 子时');
  check('一行摘要 · 缺字段不留空段',
    sceneFile.describeScene({ no: 1, title: '山门观察', place: '', time: '' }) === '1. 山门观察');

  // ---- 容错 ----
  check('空文件不抛错', sceneFile.parseSceneFile('', 'scenes/x/01-a.md').no === 1);
  check('大白话不抛错', sceneFile.parseSceneFile('随便写点什么', 'scenes/x/01-a.md').status === 'draft');
  // characters 忘了写方括号也要收下——作者手改 frontmatter 是常态。
  check('characters 写成单行也解析',
    sceneFile.parseSceneFile('---\ncharacters: 林昭、沈月\n---\nx', 'scenes/x/01-a.md').characters.length === 2);
  check('targetWords 写成汉字时不产生 NaN',
    sceneFile.parseSceneFile('---\ntargetWords: 三千\n---\nx', 'scenes/x/01-a.md').targetWords === undefined);
}

console.log('\n== pipeline.ts · 章节流水线状态推导 ==');
{
  const F = (patch) => ({ ...pipeline.emptyFacts(), ...patch });
  const stage = (patch) => pipeline.deriveStage(F(patch));

  check('什么都没有 → 待写细纲', stage({}) === 'plan');
  check('有细纲但没填 → 待写细纲', stage({ hasPlan: true, planFilled: false }) === 'plan');
  check('细纲填好但没场景 → 待拆场景', stage({ hasPlan: true, planFilled: true }) === 'scene');
  check('场景没填够 → 待拆场景',
    stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 3 }) === 'scene');
  check('场景齐了正文空 → 待写正文',
    stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4 }) === 'manuscript');
  check('正文写了但场景没写完 → 待写正文',
    stage({ hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4, sceneWritten: 2, words: 800 })
      === 'manuscript');

  const done = { hasPlan: true, planFilled: true, sceneCount: 4, sceneReady: 4, sceneWritten: 4, words: 3000 };
  check('正文齐了摘要没有 → 待审阅', stage(done) === 'review');
  check('正文齐了摘要过期 → 待审阅', stage({ ...done, summaryExists: true, summaryStale: true }) === 'review');
  check('全齐 → 已完成', stage({ ...done, summaryExists: true, summaryStale: false }) === 'done');

  // 上游改过必须把状态拉回来——这就是「变更影响」在状态机上的落法。
  check('场景改过 → 正文重新变成待写',
    stage({ ...done, summaryExists: true, summaryStale: false, beatsStale: true }) === 'manuscript');

  // 作者手工宣布完成：只在正文与场景都齐了之后才认，且只能向前。
  check('手工标记完成可以跳过审阅', stage({ ...done, markedDone: true }) === 'done');
  check('手工标记不能跳过没写的正文',
    stage({ hasPlan: true, planFilled: true, sceneCount: 2, sceneReady: 2, markedDone: true }) === 'manuscript');
  check('手工标记不能跳过没拆的场景',
    stage({ hasPlan: true, planFilled: true, markedDone: true }) === 'scene');

  // ---- 完成度 ----
  const p = (patch) => pipeline.deriveProgress(F(patch));
  check('全空的完成度是 0', p({}).plan === 0 && p({}).scene === 0);
  check('细纲建了没填算一半', p({ hasPlan: true }).plan === 0.5);
  check('细纲填好算 1', p({ hasPlan: true, planFilled: true }).plan === 1);
  check('场景 3/4 → 0.75', p({ sceneCount: 4, sceneReady: 3 }).scene === 0.75);
  check('正文按已写场景数算',
    p({ sceneCount: 4, sceneWritten: 2, words: 1000 }).manuscript === 0.5);
  // 没有场景但正文写了（作者跳过流水线直接写）——不该报 0%，那会让界面显得很蠢。
  check('没有场景时正文有字就算满', p({ words: 1000 }).manuscript === 1);
  check('摘要新鲜才算 1',
    p({ summaryExists: true, summaryStale: false }).summary === 1 &&
    p({ summaryExists: true, summaryStale: true }).summary === 0);
}

console.log(`\n${failures === 0 ? '✓ smoke-pipeline 通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
