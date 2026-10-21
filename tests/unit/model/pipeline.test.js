/**
 * 创作流水线纯函数：Stage × Capability × Target、细纲的文件格式、
 * 单章状态推导、全书状态推导。
 *
 * 这两个模块是整条流水线的地基，且全部零 I/O——所以它们能被单独 bundle 出来直接调，
 * 不需要建工程、不需要 host、不需要模型。
 *
 * 模块在文件顶层同步加载（而不是在 before() 里）：有几处用例要按模块常量
 * （CREATION_STAGES / SETTING_DOCS）展开成一批 test，describe 体在收集阶段就要读到它们。
 *
 * 新链路（一章一纲）：架构 → 情节大纲 → 细纲（细纲号 = 章号）→ 正文 → 定稿。
 * 卷、剧情段位次、中转站、拆章都删了，老会话里的那几种 stage / target 要能容错回落。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');
const plotFile = loadModule('src/core/model/plotFile.ts');

describe('pipeline.ts · Stage × Capability', () => {
  test('四个阶段：架构 / 大纲 / 细纲 / 正文', () => {
    assert.deepEqual(pipeline.CREATION_STAGES, ['setting', 'outline', 'plot', 'manuscript']);
    assert.deepEqual(
      pipeline.CREATION_STAGES.map((s) => pipeline.STAGE_LABEL[s]),
      ['架构', '大纲', '细纲', '正文']
    );
  });

  // 「设定」在工程页上是设定条目（lore）的名字，阶段叫它会撞名。
  test('架构阶段不叫「设定」', () => {
    assert.notEqual(pipeline.STAGE_LABEL.setting, '设定');
  });

  test('每个阶段都有身份与问题', () => {
    for (const s of pipeline.CREATION_STAGES) {
      assert.ok(pipeline.STAGE_ROLE[s], s);
      assert.ok(pipeline.STAGE_QUESTION[s], s);
    }
  });

  test('能力是讨论 / 生成 / 落定 / 审稿（split 删了）', () => {
    assert.deepEqual(pipeline.CAPABILITIES, ['discuss', 'generate', 'settle', 'review']);
    assert.equal(pipeline.isCapability('split'), false);
  });

  // 五期：审稿是正文层的可选动作，其余各层没有「这一章写得对不对」可查。
  test('只有正文层能审稿', () => {
    const withReview = pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('review'));
    assert.deepEqual(withReview, ['manuscript']);
    assert.equal(pipeline.isValidAction({ stage: 'plot', capability: 'review' }), false);
  });

  // 前端的按钮组直接读这张表，混进一个不存在的能力会渲染出一个点了什么都不会发生的按钮。
  for (const stage of pipeline.CREATION_STAGES) {
    test(`${stage} 的能力集合法，且都能讨论、都能生成`, () => {
      const caps = pipeline.STAGE_CAPABILITIES[stage];
      assert.ok(caps.every((c) => pipeline.isCapability(c)), JSON.stringify(caps));
      assert.ok(caps.includes('discuss') && caps.includes('generate'), JSON.stringify(caps));
    });
  }

  // 第 22 条：细纲是「先聊、聊出结论再落文件」的东西；完善设定二期起，架构那一层的设定目录也能落定（落定设定）。
  test('能落定的是细纲与设定目录，别的架构文档不开', () => {
    const withSettle = pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('settle'));
    assert.deepEqual(withSettle, ['setting', 'plot']);
    const on = (target) => pipeline.capabilitiesOn('setting', target);
    assert.deepEqual(on({ kind: 'setting', doc: 'lore' }), ['discuss', 'generate', 'settle']);
    for (const doc of ['config', 'premise', 'characters', 'world']) {
      assert.deepEqual(on({ kind: 'setting', doc }), ['discuss', 'generate'], doc);
    }
    assert.deepEqual(on({ kind: 'lore', relPath: '.novelforge/lore/a.md' }), ['discuss', 'generate']);
    assert.deepEqual(on(undefined), ['discuss', 'generate']);
    assert.deepEqual(pipeline.capabilitiesOn('plot', { kind: 'plot', plotRelPath: 'x' }), ['discuss', 'settle', 'generate']);
  });

  test('默认能力一律是讨论（不偷偷烧 token）', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.DEFAULT_CAPABILITY[s] === 'discuss'));
  });

  test('isValidAction', () => {
    assert.equal(pipeline.isValidAction({ stage: 'plot', capability: 'settle' }), true);
    assert.equal(pipeline.isValidAction({ stage: 'setting', capability: 'generate' }), true);
    assert.equal(pipeline.isValidAction({ stage: 'outline', capability: 'settle' }), false);
    assert.equal(pipeline.isValidAction({ stage: 'volume', capability: 'generate' }), false);
    assert.equal(pipeline.isValidAction({ stage: 'outline', capability: 'split' }), false);
  });

  test('命令面板不列讨论，每条都产出产物或报告', () => {
    for (const s of pipeline.CREATION_STAGES) {
      const cmds = pipeline.commandsFor(s);
      assert.ok(cmds.length > 0, s);
      assert.ok(cmds.every((c) => c.capability !== 'discuss'), s);
    }
    assert.deepEqual(pipeline.commandsFor('plot').map((c) => c.label), ['落定细纲', '写细纲', '落定设定']);
    assert.deepEqual(pipeline.commandsFor('manuscript').map((c) => c.label), ['写正文', '审稿', '落定设定']);
    assert.ok(pipeline.commandOf('manuscript', 'review').keys.includes('sg'));
  });

  // 完善设定二期：聊细纲、聊正文时定下的设定当场就能落，不必先切到设定目录。
  test('/落定设定 每一层都有：带着自己的阶段与目标，挂在末尾', () => {
    for (const s of pipeline.CREATION_STAGES) {
      const last = pipeline.commandsFor(s).at(-1);
      assert.equal(last.label, '落定设定', s);
      assert.equal(last.capability, 'settle');
      assert.equal(last.stage, 'setting');
      assert.deepEqual(last.target, { kind: 'setting', doc: 'lore' });
      assert.ok(last.keys.includes('ldsd') && last.keys.includes('ld'), last.keys.join(','));
      assert.ok(last.hint.includes('预计 1 次调用，最多 2 次'), last.hint);
    }
  });

  test('目标就是设定目录时它是这一层自己的 settle，不重复挂', () => {
    const cmds = pipeline.commandsFor('setting', { kind: 'setting', doc: 'lore' });
    assert.deepEqual(cmds.map((c) => c.label), ['生成这份架构文档', '落定设定']);
    assert.equal(cmds[1].stage, undefined);
    assert.equal(pipeline.commandOf('setting', 'settle', { kind: 'setting', doc: 'lore' }).label, '落定设定');
  });

  // 别的层挂过来的那一条只在 setting 认：细纲层问 settle 得到的是落定细纲，正文层问 settle 什么都没有。
  test('commandOf 只认这一层自己的', () => {
    assert.equal(pipeline.commandOf('plot', 'settle').label, '落定细纲');
    assert.equal(pipeline.commandOf('manuscript', 'settle'), undefined);
    assert.equal(pipeline.commandOf('setting', 'settle', { kind: 'setting', doc: 'config' }), undefined);
  });

  test('isLoreSettle：架构那一层的 settle', () => {
    assert.equal(pipeline.isLoreSettle({ stage: 'setting', capability: 'settle' }), true);
    assert.equal(pipeline.isLoreSettle({ stage: 'plot', capability: 'settle' }), false);
    assert.equal(pipeline.isLoreSettle({ stage: 'setting', capability: 'generate' }), false);
    assert.equal(pipeline.labelOf('setting', 'settle', { kind: 'setting', doc: 'lore' }), '落定设定');
  });

  // 审稿报告不是可以落盘的产物：按「不是讨论就是产物」判断的地方会把它写进章节。
  test('输出形态：讨论是文本，审稿是报告，其余是产物', () => {
    assert.equal(pipeline.outputKindOf({ stage: 'plot', capability: 'discuss' }), 'text');
    assert.equal(pipeline.outputKindOf({ stage: 'plot', capability: 'settle' }), 'artifact');
    assert.equal(pipeline.outputKindOf({ stage: 'setting', capability: 'generate' }), 'artifact');
    assert.equal(pipeline.outputKindOf({ stage: 'manuscript', capability: 'review' }), 'report');
  });

  test('审稿与修稿的调用次数', () => {
    assert.equal(pipeline.describeCalls(pipeline.REVIEW_CALLS), '预计 1 次调用，最多 3 次（输出被截断或不合格时重来，最多再 2 次）');
    assert.equal(pipeline.describeCalls(pipeline.REVISE_CALLS), '预计 1 次调用，最多 4 次（被输出上限截断时接着写，最多再续 3 轮）');
    assert.equal(pipeline.isWriteMode('revise'), true);
  });
});

describe('pipeline.ts · 动作归一（容错，老会话）', () => {
  test('认得出合法动作', () => {
    assert.deepEqual(pipeline.normalizeAction({ stage: 'setting', capability: 'generate' }), {
      stage: 'setting',
      capability: 'generate',
    });
  });

  test('老会话的 volume 阶段落到大纲', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'volume', capability: 'generate' }).stage, 'outline');
  });

  test('老会话的 scene 阶段落到细纲', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'generate' }).stage, 'plot');
  });

  // 打开一个老会话不该替作者按下一个会花钱的按钮。
  test('老会话的 split 回落到讨论，不映射成生成', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'outline', capability: 'split' }).capability, 'discuss');
  });

  test('rewrite 落到 generate，挑刺 / 检查 / 扩展落到讨论', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'plot', capability: 'rewrite' }).capability, 'generate');
    for (const c of ['critique', 'check', 'expand']) {
      assert.equal(pipeline.normalizeAction({ stage: 'plot', capability: c }).capability, 'discuss', c);
    }
  });

  test('缺字段回落到 正文 · 讨论', () => {
    assert.deepEqual(pipeline.normalizeAction(undefined), { stage: 'manuscript', capability: 'discuss' });
  });

  test('阶段不支持的能力被换掉', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'outline', capability: 'settle' }).capability, 'discuss');
  });
});

describe('pipeline.ts · Target', () => {
  const P = { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜访.md' };
  const M = { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜访.md' };

  test('target 的阶段就是它的 kind', () => {
    assert.equal(pipeline.stageOfTarget({ kind: 'setting', doc: 'world' }), 'setting');
    assert.equal(pipeline.stageOfTarget({ kind: 'outline' }), 'outline');
    assert.equal(pipeline.stageOfTarget(P), 'plot');
    assert.equal(pipeline.stageOfTarget(M), 'manuscript');
  });

  test('只有细纲与正文有归属的细纲路径', () => {
    assert.equal(pipeline.plotOfTarget({ kind: 'outline' }), undefined);
    assert.equal(pipeline.plotOfTarget({ kind: 'setting', doc: 'config' }), undefined);
    assert.equal(pipeline.plotOfTarget(M), P.plotRelPath);
  });

  test('settingOfTarget', () => {
    assert.equal(pipeline.settingOfTarget({ kind: 'setting', doc: 'premise' }), 'premise');
    assert.equal(pipeline.settingOfTarget(P), undefined);
  });

  test('key 稳定且各不相同', () => {
    const keys = [
      { kind: 'setting', doc: 'config' },
      { kind: 'setting', doc: 'world' },
      { kind: 'outline' },
      P,
      M,
    ].map(pipeline.targetKey);
    assert.equal(new Set(keys).size, keys.length, keys.join('|'));
    assert.equal(pipeline.targetKey({ kind: 'setting', doc: 'world' }), 'setting:world');
  });

  test('描述', () => {
    assert.equal(pipeline.describeTarget({ kind: 'outline' }), '情节大纲');
    assert.equal(pipeline.describeTarget({ kind: 'setting', doc: 'characters' }), '故事架构 · 角色图谱');
    assert.equal(pipeline.describeTarget({ kind: 'setting', doc: 'lore' }), '故事架构 · 设定清单');
    assert.equal(pipeline.describeTarget(P, { no: 12, title: '夜访' }), '第 12 章《夜访》 · 细纲');
    assert.equal(pipeline.describeTarget(M, { no: 12, title: '夜访' }), '第 12 章《夜访》 · 正文');
    assert.equal(pipeline.describeTarget(M), `${M.plotRelPath} · 正文`);
  });

  // 设定名录（作者定案）：设定清单进架构主链，排在世界观之后、情节大纲之前。
  test('五件架构文档各有中文名，设定清单排在世界观之后', () => {
    assert.deepEqual(pipeline.SETTING_DOCS, ['config', 'premise', 'characters', 'world', 'lore']);
    assert.ok(pipeline.SETTING_DOCS.every((d) => pipeline.SETTING_DOC_LABEL[d]));
    assert.equal(pipeline.SETTING_DOC_LABEL.lore, '设定清单');
    assert.equal(pipeline.isSettingDoc('lore'), true);
  });
});

describe('pipeline.ts · Target 归一（容错）', () => {
  test('认得出合法 target', () => {
    const t = { kind: 'setting', doc: 'premise' };
    assert.deepEqual(pipeline.normalizeTarget(t), t);
  });

  test('setting 带认不出的 doc 落到小说配置', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'setting', doc: '乱写' }), { kind: 'setting', doc: 'config' });
  });

  test('老会话的 volume target 落到大纲', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'volume', volumeRelPath: '.novelforge/volumes/01.md' }), {
      kind: 'outline',
    });
  });

  test('老会话的 scene target 落到那一章的细纲，场号丢掉', () => {
    assert.deepEqual(
      pipeline.normalizeTarget({ kind: 'scene', plotRelPath: '.novelforge/plots/003.md', sceneNo: 2 }),
      { kind: 'plot', plotRelPath: '.novelforge/plots/003.md' }
    );
  });

  test('缺路径的细纲 / 正文回落到大纲', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'plot' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'manuscript', plotRelPath: '  ' }), { kind: 'outline' });
  });

  test('undefined 与认不出的 kind 回落到大纲', () => {
    assert.deepEqual(pipeline.normalizeTarget(undefined), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'plan' }), { kind: 'outline' });
  });
});

describe('pipeline.ts · chapterLabel', () => {
  test('有标题时带书名号', () => {
    assert.equal(pipeline.chapterLabel(12, '夜访'), '第 12 章《夜访》');
  });

  test('标题为空、缺席、恰好是回落值时只报序号', () => {
    assert.equal(pipeline.chapterLabel(7, ''), '第 7 章');
    assert.equal(pipeline.chapterLabel(7), '第 7 章');
    assert.equal(pipeline.chapterLabel(7, '第 7 章'), '第 7 章');
  });

  test('别的序号写在标题里仍算真标题', () => {
    assert.equal(pipeline.chapterLabel(7, '第 8 章'), '第 7 章《第 8 章》');
  });

  test('plotLabel 是它的别名', () => {
    assert.equal(pipeline.plotLabel(3, '夜访'), pipeline.chapterLabel(3, '夜访'));
  });
});

// ---------------------------------------------------------------- 细纲文件

describe('plotFile.ts · 文件名规则', () => {
  test('解析章号与词干', () => {
    assert.deepEqual(plotFile.parsePlotFileName('012-夜访.md'), { no: 12, stem: '夜访' });
  });

  test('`007.md` 的词干为空', () => {
    assert.deepEqual(plotFile.parsePlotFileName('007.md'), { no: 7, stem: '' });
  });

  test('非 markdown、0 号、没有数字前缀都不认', () => {
    assert.equal(plotFile.parsePlotFileName('012-夜访.txt'), undefined);
    assert.equal(plotFile.parsePlotFileName('000-序.md'), undefined);
    assert.equal(plotFile.parsePlotFileName('夜访.md'), undefined);
  });

  test('拼文件名补三位，无标题就是纯序号名', () => {
    assert.equal(plotFile.plotFileName(3, '夜访'), '003-夜访.md');
    assert.equal(plotFile.plotFileName(3, ''), '003.md');
  });

  test('文件名与解析互逆', () => {
    const name = plotFile.plotFileName(128, '入宗');
    assert.deepEqual(plotFile.parsePlotFileName(name), { no: 128, stem: '入宗' });
  });
});

describe('plotFile.ts · 解析与渲染（七节）', () => {
  const sections = {
    ...plotFile.emptyPlotSections(),
    梗概: '林昭雨夜翻墙进宗门，靠半枚令牌被破例留下。',
    出场人物: '林昭、沈青',
    时间地点: '第 11 章当夜，青云宗外墙。',
    关键事件: '雨夜翻墙，被巡夜弟子撞见，亮出半枚令牌。',
    看点: '- 执事认出令牌，脸色变了。',
    状态变更: '林昭成了记名弟子。',
  };
  const plot = {
    no: 12,
    title: '夜入青云',
    targetWords: 3000,
    upstreamHash: 'aaaa',
    writtenFrom: 'bbbb',
    done: false,
    sections,
  };
  const text = plotFile.renderPlotFile(plot);
  const back = plotFile.parsePlotFile(text, '.novelforge/summaries/012-夜入青云.md');

  test('往返：frontmatter', () => {
    assert.equal(back.no, 12);
    assert.equal(back.title, '夜入青云');
    assert.equal(back.targetWords, 3000);
    assert.equal(back.upstreamHash, 'aaaa');
    assert.equal(back.writtenFrom, 'bbbb');
    assert.equal(back.sourceHash, '');
    assert.equal(back.done, false);
  });

  test('往返：七节', () => {
    assert.deepEqual(back.sections, sections);
  });

  // 叙事线二期：「新增伏笔」删了（伏笔并进了叙事线），摘要那八节剩七节。
  test('就是摘要那八节去掉新增伏笔', () => {
    assert.deepEqual(
      [...plotFile.PLOT_SECTION_KEYS],
      ['梗概', '出场人物', '时间地点', '关键事件', '看点', '状态变更', '连续性事实']
    );
  });

  test('老细纲里的「新增伏笔」当认不出的小节：不读、不进指纹，文件里还在', () => {
    const old = text.replace('## 状态变更', '## 新增伏笔\n\n- 半枚令牌的另一半在谁手里。\n\n## 状态变更');
    const parsed = plotFile.parsePlotFile(old, '.novelforge/summaries/012-夜入青云.md');
    assert.deepEqual(parsed.sections, sections);
    assert.equal(plotFile.plotContentHash(parsed), plotFile.plotContentHash(back));
    assert.ok(parsed.body.includes('半枚令牌的另一半'));
  });

  test('渲染带「第N章 标题」一行', () => {
    assert.match(text, /^# 第12章 夜入青云$/m);
  });

  test('没定稿：计划出场从「出场人物」一节读，不写 cast', () => {
    assert.deepEqual(back.characters, ['林昭', '沈青']);
    assert.ok(!/^cast:/m.test(text), text);
  });

  test('空的字段不写出来', () => {
    const bare = plotFile.renderPlotFile({ ...plot, targetWords: undefined, writtenFrom: '', upstreamHash: '' });
    assert.ok(!/^targetWords:/m.test(bare) && !/^writtenFrom:/m.test(bare) && !/^upstreamHash:/m.test(bare), bare);
  });

  test('空小节写出占位，读回来是空串', () => {
    const empty = plotFile.renderPlotFile({ ...plot, sections: plotFile.emptyPlotSections() });
    assert.match(empty, /（待补充）/);
    assert.equal(plotFile.parsePlotFile(empty, 'x/001.md').sections.关键事件, '');
  });

  test('status: done 被读出', () => {
    assert.equal(plotFile.parsePlotFile(plotFile.renderPlotFile({ ...plot, done: true }), 'x/012.md').done, true);
  });

  test('定稿过：sourceHash 与 cast 写进 frontmatter，出场的人取 cast', () => {
    const cast = [{ name: '林昭', aliases: ['阿昭'] }, { name: '巡夜弟子', aliases: [] }];
    const finalized = plotFile.renderPlotFile({ ...plot, sourceHash: 'cccc', cast });
    assert.match(finalized, /^cast: \[林昭\(阿昭\), 巡夜弟子\]$/m);
    const p = plotFile.parsePlotFile(finalized, 'x/012.md');
    assert.equal(p.sourceHash, 'cccc');
    assert.deepEqual(p.cast, cast);
    assert.deepEqual(p.characters, ['林昭', '巡夜弟子']);
  });
});

describe('plotFile.ts · 计划出场（「出场人物」一节）', () => {
  const names = (text) => plotFile.plannedNames(text);

  test('顿号、逗号、斜杠、分号都切', () => {
    assert.deepEqual(names('林昭、沈青，李叔/年轻守卫；掌柜'), ['林昭', '沈青', '李叔', '年轻守卫', '掌柜']);
  });

  test('一行一个、带列表记号的也认', () => {
    assert.deepEqual(names('- 林昭\n* 沈青\n1. 李叔'), ['林昭', '沈青', '李叔']);
  });

  test('括号里的别名不切开，只取名字', () => {
    assert.deepEqual(names('林昭(阿昭/昭儿)、沈青（青姐、阿青）'), ['林昭', '沈青']);
  });

  // castFromText 为了挡住句子碎片会丢掉带「从」「和」的名字；计划里的名单是排细纲的人写的，不该漏人。
  test('不按虚词过滤：带「从」「和」的名字照收', () => {
    assert.deepEqual(names('沈从文、和珅'), ['沈从文', '和珅']);
  });

  test('占位与「无」不算人', () => {
    assert.deepEqual(names('（待补充）'), []);
    assert.deepEqual(names('无'), []);
  });
});

// 关键事件、看点落盘都是一条一行的列表（计划与定稿同一个形状）；一章一行的一览要把它压成一行。
describe('plotFile.ts · 一条一行的那几节', () => {
  test('按行切成条，去掉列表记号，空行与占位不算', () => {
    assert.deepEqual(plotFile.sectionItems('- 林昭踩点\n\n* 翻墙进了后院\n1. 落在藏书阁门口\n（待补充）'), ['林昭踩点', '翻墙进了后院', '落在藏书阁门口']);
    assert.deepEqual(plotFile.sectionItems(''), []);
  });

  // 一条里本来就可以有分号；作者手写成一整段的就是一项。
  test('只按换行切：一条里的分号不切', () => {
    assert.deepEqual(plotFile.sectionItems('- 林昭翻墙；落在后院'), ['林昭翻墙；落在后院']);
    assert.deepEqual(plotFile.sectionItems('一整段写成的关键事件。'), ['一整段写成的关键事件。']);
  });

  test('压成一行：条与条之间用「；」接，不留「- 」', () => {
    assert.equal(plotFile.sectionLine('- 林昭踩点\n- 翻墙进了后院'), '林昭踩点；翻墙进了后院');
    assert.equal(plotFile.sectionLine('一整段。'), '一整段。');
    assert.equal(plotFile.sectionLine('（待补充）'), '');
  });

  test('关键事件的上限：条数 8、合计 1200 字', () => {
    assert.equal(plotFile.BLUEPRINT_LIMITS.keyEventItems, 8);
    assert.equal(plotFile.BLUEPRINT_LIMITS.keyEvents, 1200);
  });
});

describe('plotFile.ts · 排过没有 / 容错', () => {
  test('只看「关键事件」', () => {
    const empty = plotFile.emptyPlotSections();
    assert.equal(plotFile.isPlotFilled(empty), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 梗概: '有梗概', 看点: '- 有看点' }), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 关键事件: '有事件' }), true);
  });

  test('占位文字不算内容', () => {
    assert.equal(plotFile.isPlotFilled({ ...plotFile.emptyPlotSections(), 关键事件: '（待补充）' }), false);
  });

  test('认不出的小节读进来全空、不抛', () => {
    const odd = '---\nno: 3\ntitle: 夜访\n---\n\n## 目标\n\n甲\n\n## 剧情脉络\n\n乙\n';
    const p = plotFile.parsePlotFile(odd, '.novelforge/summaries/003-夜访.md');
    assert.equal(p.no, 3);
    assert.equal(p.title, '夜访');
    assert.equal(plotFile.isPlotFilled(p.sections), false);
  });

  test('无 frontmatter、畸形 frontmatter、大白话、空文件都不抛', () => {
    for (const t of ['## 关键事件\n\n甲', '---\n: :\n---\n', '就一句大白话', '', '---\ncast: [(, )]\nsourceHash: x\n---\n']) {
      assert.doesNotThrow(() => plotFile.parsePlotFile(t, 'x/001.md'), t);
    }
  });

  test('文件名的章号压过 frontmatter', () => {
    assert.equal(plotFile.parsePlotFile('---\nno: 99\n---\n', 'x/004-甲.md').no, 4);
  });

  test('无 frontmatter 标题时用文件名词干', () => {
    assert.equal(plotFile.parsePlotFile('', 'x/004-甲.md').title, '甲');
  });

  test('targetWords 写成汉字或非正数时当没写', () => {
    assert.equal(plotFile.parsePlotFile('---\ntargetWords: 三千\n---\n', 'x/001.md').targetWords, undefined);
    assert.equal(plotFile.parsePlotFile('---\ntargetWords: 0\n---\n', 'x/001.md').targetWords, undefined);
  });
});

// 老工程 summaries/ 根下的单章摘要本来就是这七节，带着 sourceHash 与 cast：直接当成定稿过的细纲读。
describe('plotFile.ts · 老工程的单章摘要当成定稿过的细纲', () => {
  const old = [
    '---',
    'chapter: 7',
    'title: 入宗',
    'sourceHash: f00d',
    'cast: [林昭(阿昭), 沈青]',
    'generatedBy: novel-forge',
    '---',
    '',
    '# 第7章 入宗 · 摘要',
    '',
    '## 梗概',
    '',
    '林昭进了宗门。',
    '',
    '## 出场人物',
    '',
    '林昭、沈青',
    '',
    '## 关键事件',
    '',
    '- 林昭拜师。',
    '',
  ].join('\n');
  const p = plotFile.parsePlotFile(old, '.novelforge/summaries/007-入宗.md');

  test('章号取文件名前缀，frontmatter 的 chapter 不认', () => {
    assert.equal(plotFile.parsePlotFile(old.replace('chapter: 7', 'chapter: 99'), 'x/007-入宗.md').no, 7);
    assert.equal(p.no, 7);
  });

  test('sourceHash 在：算定稿过', () => {
    assert.equal(p.sourceHash, 'f00d');
  });

  test('cast 照读，出场的人取它', () => {
    assert.deepEqual(p.cast, [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈青', aliases: [] }]);
    assert.deepEqual(p.characters, ['林昭', '沈青']);
  });

  test('关键事件有内容：算排过', () => {
    assert.equal(plotFile.isPlotFilled(p.sections), true);
  });

  test('没有 cast 字段的（手写的、更早的摘要）从「出场人物」反解', () => {
    const q = plotFile.parsePlotFile(old.replace('cast: [林昭(阿昭), 沈青]\n', ''), 'x/007-入宗.md');
    assert.deepEqual(q.cast.map((c) => c.name), ['林昭', '沈青']);
  });
});

describe('plotFile.ts · 内容指纹', () => {
  const base = plotFile.parsePlotFile(
    plotFile.renderPlotFile({
      no: 3,
      title: '夜访',
      upstreamHash: 'u',
      done: false,
      sections: { ...plotFile.emptyPlotSections(), 关键事件: '甲', 看点: '- 乙' },
    }),
    'x/003-夜访.md'
  );
  const h = plotFile.plotContentHash(base);

  test('七节里任何一节变了指纹就变', () => {
    for (const key of plotFile.PLOT_SECTION_KEYS) {
      assert.notEqual(plotFile.plotContentHash({ sections: { ...base.sections, [key]: `${base.sections[key]}改` } }), h, key);
    }
  });

  // 记一条预检放行、写前冲突检查放行、定稿记的 cast、改个标题，都不该让正文变成「细纲改过」。
  test('preflightOk / factCheckOk / cast / 标题不进指纹', () => {
    const other = plotFile.parsePlotFile(
      plotFile.renderPlotFile({
        no: 3,
        title: '另一个标题',
        upstreamHash: 'u2',
        done: true,
        sourceHash: 's',
        cast: [{ name: '林昭', aliases: [] }],
        preflightOk: [{ name: '沈秋', reason: '回忆' }],
        factCheckOk: true,
        sections: base.sections,
      }),
      'x/003-夜访.md'
    );
    assert.equal(plotFile.plotContentHash(other), h);
  });
});

// ---------------------------------------------------------------- 单章状态机

describe('pipeline.ts · 单章状态推导', () => {
  const facts = (over) => ({ ...pipeline.emptyFacts(), ...over });

  test('什么都没有 → 待写细纲', () => {
    assert.equal(pipeline.deriveStage(facts({})), 'plot');
  });

  test('细纲排好、没有正文 → 待写正文', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true })), 'manuscript');
  });

  // 空文件不算写过：作者建了个空章节占位，仍然是「写这一章」。
  test('章节文件在但是空的 → 按没写算', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 0 })), 'manuscript');
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 0 })), 'plot');
  });

  test('写了但不到目标的八成 → 还在待写正文（接着写）', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 1000, targetWords: 3000 })),
      'manuscript'
    );
  });

  test('写到八成 → 待定稿', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 2400, targetWords: 3000 })),
      'finalize'
    );
  });

  test('目标字数缺席时有字就算写够', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 10 })), 'finalize');
  });

  test('细纲在正文之后改过 → 回到写正文（重写）', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 3000, upstreamStale: true })),
      'manuscript'
    );
  });

  test('摘要在且新鲜 → 已完成', () => {
    assert.equal(
      pipeline.deriveStage(
        facts({ plotFilled: true, chapterExists: true, words: 3000, summaryExists: true, summaryStale: false })
      ),
      'done'
    );
  });

  // 定稿过的章即使细纲后来改了也不拉回「待写」——那是作者已经认可的文字。
  test('定稿过、细纲后来改了 → 仍是已完成', () => {
    assert.equal(
      pipeline.deriveStage(
        facts({ chapterExists: true, words: 3000, upstreamStale: true, summaryExists: true, summaryStale: false })
      ),
      'done'
    );
  });

  test('摘要过期（正文改过）→ 回到待定稿', () => {
    assert.equal(
      pipeline.deriveStage(facts({ chapterExists: true, words: 3000, summaryExists: true, summaryStale: true })),
      'finalize'
    );
  });

  test('作者宣布过了 → 已完成', () => {
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 100, targetWords: 3000, markedDone: true })), 'done');
  });

  // 老工程：只有正文、没有细纲。不倒回去要求补细纲。
  test('只有正文、没有细纲 → 待定稿，不回到写细纲', () => {
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 3000 })), 'finalize');
  });
});

describe('pipeline.ts · 三段完成度', () => {
  test('每一段只报它自己', () => {
    const p = pipeline.deriveProgress({
      ...pipeline.emptyFacts(),
      chapterExists: true,
      words: 1200,
      targetWords: 3000,
    });
    assert.deepEqual(p, { plot: 0, manuscript: 0.5, summary: 0 });
  });

  test('写够之后正文满格；摘要新鲜才算定稿', () => {
    const p = pipeline.deriveProgress({
      ...pipeline.emptyFacts(),
      plotFilled: true,
      chapterExists: true,
      words: 2400,
      targetWords: 3000,
      summaryExists: true,
      summaryStale: false,
    });
    assert.deepEqual(p, { plot: 1, manuscript: 1, summary: 1 });
  });

  test('manuscriptRatio：没字是 0，没有目标有字就是 1', () => {
    assert.equal(pipeline.manuscriptRatio({ words: 0, targetWords: 3000 }), 0);
    assert.equal(pipeline.manuscriptRatio({ words: 5 }), 1);
    assert.equal(pipeline.manuscriptRatio({ words: 1200, targetWords: 1000 }), 1);
  });
});

describe('pipeline.ts · 单章下一步', () => {
  const next = (stage, over = {}) =>
    pipeline.deriveNextStep(stage, { no: 12, words: 0, ratio: 0, upstreamStale: false, ...over });

  test('待写细纲 → 写第 N 章细纲', () => {
    const s = next('plot');
    assert.equal(s.stage, 'plot');
    assert.equal(s.capability, 'generate');
    assert.equal(s.label, '写第 12 章细纲');
  });

  test('待写正文 · 没字 → 写第 N 章', () => {
    assert.equal(next('manuscript').label, '写第 12 章');
  });

  test('待写正文 · 有字没写够 → 接着写，并说清写了多少', () => {
    const s = next('manuscript', { words: 1200, ratio: 0.5 });
    assert.equal(s.label, '接着写');
    assert.match(s.hint, /1200 字/);
    assert.match(s.hint, /50%/);
  });

  test('待写正文 · 细纲改过 → 重写第 N 章', () => {
    assert.equal(next('manuscript', { words: 3000, ratio: 1, upstreamStale: true }).label, '重写第 12 章');
  });

  test('待定稿 → 工程动作 finalizeChapter，停在正文层', () => {
    const s = next('finalize');
    assert.equal(s.projectAction, 'finalizeChapter');
    assert.equal(s.stage, 'manuscript');
  });

  test('已完成 → 不给（调用方转去问全书）', () => {
    assert.equal(next('done'), undefined);
  });

  test('单章下一步不自带 target（落点就是那一章）', () => {
    assert.equal(next('plot').target, undefined);
  });
});

// ---------------------------------------------------------------- 全书状态机

describe('pipeline.ts · 全书状态推导', () => {
  const all = { config: true, premise: true, characters: true, world: true, lore: true };
  const book = (over = {}) => ({
    settings: all,
    outlineFilled: true,
    outlineCoverage: 20,
    totalChapters: 100,
    nextChapterNo: 1,
    nextPlotFilled: false,
    plotFilledNos: [],
    ...over,
  });

  test('架构缺哪件推哪件，按 配置 → 前提 → 角色 → 世界观 → 设定清单 的顺序', () => {
    const order = [];
    let settings = { config: false, premise: false, characters: false, world: false, lore: false };
    for (const doc of pipeline.SETTING_DOCS) {
      const f = book({ settings });
      assert.equal(pipeline.deriveBookStage(f), 'setting');
      const step = pipeline.deriveBookNextStep('setting', f);
      order.push(step.target.doc);
      settings = { ...settings, [doc]: true };
    }
    assert.deepEqual(order, ['config', 'premise', 'characters', 'world', 'lore']);
    // 五件齐了才轮到情节大纲。
    assert.equal(pipeline.deriveBookStage(book({ settings, outlineFilled: false, outlineCoverage: 0 })), 'outline');
  });

  test('世界观之后、情节大纲之前是设定清单：按钮、提示与 target', () => {
    const f = book({ settings: { ...all, lore: false }, outlineFilled: false, outlineCoverage: 0 });
    assert.equal(pipeline.deriveBookStage(f), 'setting');
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.label, '生成设定清单');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'lore' });
    assert.match(s.hint, /地点、势力、能力体系、关键物品/);
    assert.equal(s.form, undefined);
  });

  // 作者定案：在写的书不被新加的这一件推回架构。判据只在纯函数层写一次，读盘在 settingFilled。
  test('设定清单「填过」：有条目，或者这本书已经有正文', () => {
    assert.equal(pipeline.isLoreListFilled(0, false), false);
    assert.equal(pipeline.isLoreListFilled(3, false), true);
    assert.equal(pipeline.isLoreListFilled(0, true), true);
  });

  test('已经写了正文、一条设定都没有的书：照常往下走，不被推回架构', () => {
    const lore = pipeline.isLoreListFilled(0, true);
    const f = book({ settings: { ...all, lore }, nextChapterNo: 31, outlineCoverage: 40, nextPlotFilled: true });
    assert.equal(pipeline.deriveBookStage(f), 'writing');
  });

  test('架构那一档的按钮与 target', () => {
    const f = book({ settings: { ...all, premise: false } });
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.label, '生成故事前提');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'premise' });
    assert.equal(s.stage, 'setting');
  });

  test('大纲没写 → 生成情节大纲（第 1–20 章）', () => {
    const f = book({ outlineFilled: false, outlineCoverage: 0 });
    assert.equal(pipeline.deriveBookStage(f), 'outline');
    const s = pipeline.deriveBookNextStep('outline', f);
    assert.deepEqual(s.range, { from: 1, to: 20 });
    assert.equal(s.label, '生成情节大纲（第 1–20 章）');
    assert.deepEqual(s.target, { kind: 'outline' });
  });

  test('总章数不足 20 时区间收在总章数', () => {
    const s = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0, totalChapters: 12 }));
    assert.deepEqual(s.range, { from: 1, to: 12 });
  });

  test('下一章超出大纲覆盖 → 续写情节大纲，从覆盖的下一章起', () => {
    const f = book({ outlineCoverage: 20, nextChapterNo: 21 });
    assert.equal(pipeline.deriveBookStage(f), 'outline');
    const s = pipeline.deriveBookNextStep('outline', f);
    assert.deepEqual(s.range, { from: 21, to: 40 });
    assert.match(s.label, /^续写情节大纲/);
  });

  // 散文式大纲（没有区间标题）覆盖视为 Infinity：说不上覆盖到哪，就不拦。
  test('大纲覆盖是 Infinity 时不推续写', () => {
    assert.equal(pipeline.deriveBookStage(book({ outlineCoverage: Infinity, nextChapterNo: 300, totalChapters: undefined })), 'plots');
  });

  // 第 25–31 章没有正文、后面还有 51 章：照「写到第 24 章」续写大纲，后面那些会被当成没写过。
  test('正文断了一截 → 大纲那一档推「把章号接上」，不推续写', () => {
    const gap = { from: 25, to: 31, later: 51, last: 82 };
    const s = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 24, nextChapterNo: 25, gap }));
    assert.equal(s.projectAction, 'chapterGap');
    assert.equal(s.label, '第 25–31 章缺正文…');
    assert.match(s.hint, /51 章已写（写到第 82 章）/);
    assert.equal(s.calls, undefined);
    assert.deepEqual(s.target, { kind: 'outline' });
  });

  test('正文断了一截 → 架构那一档也不推补齐', () => {
    const gap = { from: 1, to: 3, later: 10, last: 13 };
    const s = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, world: false }, gap }));
    assert.equal(s.projectAction, 'chapterGap');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'world' });
  });

  test('断了一截但大纲已覆盖缺口：拆细纲、写正文照常（跳着写是作者的自由）', () => {
    const f = book({ outlineCoverage: 40, nextChapterNo: 25, gap: { from: 25, to: 31, later: 9, last: 40 } });
    assert.equal(pipeline.deriveBookStage(f), 'plots');
    assert.equal(pipeline.deriveBookNextStep('plots', f).projectAction, undefined);
  });

  test('下一章没有细纲 → 拆细纲，一批 5 章', () => {
    const f = book({ nextChapterNo: 6 });
    assert.equal(pipeline.deriveBookStage(f), 'plots');
    const s = pipeline.deriveBookNextStep('plots', f);
    assert.deepEqual(s.range, { from: 6, to: 10 });
    assert.equal(s.label, '拆细纲（第 6–10 章）');
    assert.equal(s.stage, 'plot');
    // 细纲的路径由调用方用文件名规则补，纯函数给不出。
    assert.equal(s.target, undefined);
  });

  test('拆细纲的区间不越过大纲覆盖与总章数', () => {
    assert.deepEqual(pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 18 })).range, { from: 18, to: 20 });
    assert.deepEqual(
      pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 99, outlineCoverage: 200, totalChapters: 100 })).range,
      { from: 99, to: 100 }
    );
  });

  test('只剩一章时按钮说「第 N 章」而不是「第 N–N 章」', () => {
    const s = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 20 }));
    assert.equal(s.label, '拆细纲（第 20 章）');
  });

  // 主按钮那一批永远是空白：第 8 章已经排过，第 6 章起的这一批收在第 7 章。
  test('拆细纲的区间在第一份已有细纲之前收住', () => {
    const s = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 6, plotFilledNos: [1, 2, 3, 4, 5, 8, 9] }));
    assert.deepEqual(s.range, { from: 6, to: 7 });
    assert.equal(s.label, '拆细纲（第 6–7 章）');
  });

  test('每一档都写明要调几次模型', () => {
    const none = { config: false, premise: false, characters: false, world: false, lore: false };
    const config = pipeline.deriveBookNextStep('setting', book({ settings: none }));
    assert.deepEqual(config.calls, pipeline.CONFIG_CALLS);
    // 配置要先填一句话与规模，主按钮打开表单而不是直接发送。
    assert.equal(config.form, 'idea');

    const roster = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, characters: false } }));
    assert.deepEqual(roster.calls, { low: 2, high: 4, max: 16 });
    assert.equal(roster.form, undefined);

    const premise = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, premise: false } }));
    assert.deepEqual(premise.calls, pipeline.ONE_CALL);

    // 设定清单：清单 1 次 + 详情每批 6 条（12–30 条）；上限封顶 12。
    const lore = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, lore: false } }));
    assert.deepEqual(lore.calls, { low: 3, high: 6, max: 12 });
    assert.deepEqual(pipeline.loreListCalls(), lore.calls);
    assert.equal(pipeline.LORE_LIST_CALLS_MAX, 12);
    assert.deepEqual(pipeline.settingCalls('lore'), lore.calls);
    assert.deepEqual(pipeline.settingCalls('characters'), pipeline.rosterCalls());

    const outline = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0 }));
    assert.deepEqual(outline.calls, pipeline.ONE_CALL);

    // 一批 5 章：通常 1 次，上限 3n（上游 blueprint-batch-policy 的式子）。
    const plots = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 1 }));
    assert.deepEqual(plots.calls, { low: 1, high: 1, max: 15 });
  });

  test('下一章有细纲 → 在写（交给单章状态机）', () => {
    const f = book({ nextPlotFilled: true, nextChapterNo: 3 });
    assert.equal(pipeline.deriveBookStage(f), 'writing');
    assert.equal(pipeline.deriveBookNextStep('writing', f), undefined);
  });

  test('写满总章数 → 写完了，不给按钮', () => {
    const f = book({ nextChapterNo: 101, outlineCoverage: 100 });
    assert.equal(pipeline.deriveBookStage(f), 'complete');
    assert.equal(pipeline.deriveBookNextStep('complete', f), undefined);
  });

  test('没写总章数就没有「写完了」', () => {
    assert.notEqual(pipeline.deriveBookStage(book({ totalChapters: undefined, nextChapterNo: 500 })), 'complete');
  });

  // D11：老工程（有正文、没有架构）被推回第一格——新链路写正文要读前提、角色与世界观。
  // 拆书 A 之后这一格的动作换成「从已写正文补齐」：照正文整理，不从一句话重新编。
  test('有正文但没有架构的老工程 → 先补架构，动作是从已写正文补齐', () => {
    const f = book({ settings: { config: false, premise: false, characters: true, world: false, lore: true }, nextChapterNo: 100 });
    assert.equal(pipeline.deriveBookStage(f), 'setting');
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.target.doc, 'config');
    assert.equal(s.projectAction, 'deriveFromText');
    assert.equal(s.label, '从已写正文补齐…');
    assert.equal(s.form, undefined);
    // 次数要读摘要才算得准：确认框里报，主按钮不带。
    assert.equal(s.calls, undefined);
    assert.match(s.hint, /第 1–99 章/);
    assert.match(s.hint, /小说配置/);
  });

  test('还没有正文时架构那一档照旧（一句话表单）', () => {
    const s = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, config: false }, nextChapterNo: 1 }));
    assert.equal(s.form, 'idea');
    assert.equal(s.projectAction, undefined);
  });

  test('大纲没覆盖到已写的章 → 从已写正文补齐，不往前规划', () => {
    const none = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0, nextChapterNo: 31 }));
    assert.equal(none.projectAction, 'deriveFromText');
    assert.deepEqual(none.target, { kind: 'outline' });
    assert.match(none.hint, /还没有情节大纲/);

    const short = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 20, nextChapterNo: 31 }));
    assert.equal(short.projectAction, 'deriveFromText');
    assert.match(short.hint, /只覆盖到第 20 章/);
  });

  test('大纲恰好覆盖到已写的最后一章 → 照常续写大纲', () => {
    const s = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 30, nextChapterNo: 31 }));
    assert.equal(s.projectAction, undefined);
    assert.deepEqual(s.range, { from: 31, to: 50 });
  });
});

// ---------------------------------------------------------------- 细纲批次与调用次数

describe('pipeline.ts · 批量拆细纲的切分', () => {
  test('跳过已有细纲的章，剩下的按连续段切、每批不超过 5 章', () => {
    const plan = pipeline.planPlotBatches({ from: 1, to: 14, filledNos: [4, 5] });
    assert.deepEqual(plan.skipped, [4, 5]);
    assert.deepEqual(plan.chapters, [1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // 第 4、5 章把区间断开：1–3 一批；6–14 再按 5 章切。
    assert.deepEqual(plan.batches, [[1, 2, 3], [6, 7, 8, 9, 10], [11, 12, 13, 14]]);
    // 三批各 1 次；上限 3n 按要写的章数加总。有叙事线时不排线。
    assert.deepEqual(plan.calls, { low: 3, high: 3, max: 36 });
  });

  // 叙事线重做（设计稿 ⚑8）：一条线都没有时开拆之前先从情节大纲排一次；拆完不再排。
  test('一条叙事线都没有：先排一次，+1；没有要拆的就不排', () => {
    const plan = pipeline.planPlotBatches({ from: 1, to: 14, filledNos: [4, 5], planThreads: true });
    assert.deepEqual(plan.calls, { low: 4, high: 4, max: 37 });
    const none = pipeline.planPlotBatches({ from: 7, to: 5, filledNos: [5, 6, 7], planThreads: true });
    assert.deepEqual(none.calls, { low: 0, high: 0, max: 0 });
  });

  test('区间写反了照样认；全都排过时一批都没有', () => {
    const plan = pipeline.planPlotBatches({ from: 7, to: 5, filledNos: [5, 6, 7] });
    assert.equal(plan.from, 5);
    assert.equal(plan.to, 7);
    assert.deepEqual(plan.batches, []);
    assert.deepEqual(plan.calls, { low: 0, high: 0, max: 0 });
  });

  test('调用次数的说法', () => {
    assert.equal(pipeline.describeCalls({ low: 1, high: 1, max: 1 }), '预计 1 次调用');
    assert.equal(pipeline.describeCalls({ low: 1, high: 1, max: 15 }), '预计 1 次调用，最多 15 次');
    assert.equal(pipeline.describeCalls({ low: 2, high: 4, max: 16 }), '预计 2–4 次调用，最多 16 次');
  });

  test('单章的下一步也写调用次数', () => {
    assert.deepEqual(pipeline.deriveNextStep('plot', { no: 3, words: 0, ratio: 0, upstreamStale: false }).calls, pipeline.ONE_CALL);
  });

  // D17：定稿 = 摘要 + 出场角色的当前状态；叙事线重做之后叙事线 1–3 次（认事件每次都跑，设计稿 ⚑6），
  // 所以最少 2 次。
  test('定稿第 N 章报「预计 2–5 次调用」，并说清各做什么', () => {
    const step = pipeline.deriveNextStep('finalize', { no: 3, words: 900, ratio: 1, upstreamStale: false });
    assert.equal(step.label, '定稿第 3 章');
    assert.equal(step.projectAction, 'finalizeChapter');
    assert.deepEqual(step.calls, pipeline.FINALIZE_CALLS);
    assert.equal(
      pipeline.describeCalls(step.calls),
      '预计 2–5 次调用（照正文更新细纲 1 次；本章出场的人有角色卡时更新角色状态 1 次；叙事线认事件 1 次，有线动过时更新当前进度 1 次，认出新线或新伏笔时归并 1 次）'
    );
  });

  // D16：自动续写算进调用次数，动手之前写明上限。
  test('写正文的三种下一步都报「1–2 次，最多 9 次」，并说清为什么', () => {
    const f = { no: 3, words: 0, ratio: 0, upstreamStale: false };
    const steps = [
      pipeline.deriveNextStep('manuscript', f),
      pipeline.deriveNextStep('manuscript', { ...f, words: 900, ratio: 0.4 }),
      pipeline.deriveNextStep('manuscript', { ...f, words: 3000, ratio: 1, upstreamStale: true }),
    ];
    for (const s of steps) {
      assert.deepEqual(s.calls, pipeline.WRITE_CALLS);
    }
    assert.equal(pipeline.WRITE_CALLS.max, 2 + pipeline.MAX_CONTINUE_ROUNDS);
    assert.equal(pipeline.describeCalls(pipeline.WRITE_CALLS), '预计 1–2 次调用，最多 9 次（开着删修饰时写完再删 1 次；没写够时自动续写，最多再续 7 轮）');
  });

  test('加总时不带原因（几件事的原因拼不成一句话）', () => {
    assert.equal(pipeline.addCalls(pipeline.WRITE_CALLS, pipeline.WRITE_CALLS).why, undefined);
  });
});

describe('pipeline.ts · 写正文的写法', () => {
  const f = { no: 12, words: 0, ratio: 0, upstreamStale: false };

  test('没字 → 不带写法（由磁盘定：新建）', () => {
    assert.equal(pipeline.deriveNextStep('manuscript', f).writeMode, undefined);
  });

  test('接着写 → continue（追加）', () => {
    assert.equal(pipeline.deriveNextStep('manuscript', { ...f, words: 800, ratio: 0.3 }).writeMode, 'continue');
  });

  test('重写第 N 章 → rewrite（覆盖前审阅）', () => {
    const s = pipeline.deriveNextStep('manuscript', { ...f, words: 3000, ratio: 1, upstreamStale: true });
    assert.equal(s.writeMode, 'rewrite');
    assert.match(s.hint, /对比/);
  });

  test('isWriteMode 只认三种', () => {
    assert.ok(['write', 'continue', 'rewrite'].every(pipeline.isWriteMode));
    assert.ok(![undefined, 'append', '', 3].some(pipeline.isWriteMode));
  });
});

// ---------------------------------------------------------------- 批量写章（四期，W9）

describe('pipeline.ts · 批量写章的切分', () => {
  const base = { mode: 'draft', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };

  test('只写正文：一章 1–2 次、最多 9 次，加写前比对 0–1 次、最多 2 次，按件加总', () => {
    const plan = pipeline.planWriteBatch({ ...base, from: 1, to: 3 });
    assert.deepEqual(plan.chapters, [1, 2, 3]);
    assert.deepEqual(plan.plotBatches, []);
    assert.deepEqual(plan.calls, { low: 3, high: 9, max: 33 });
  });

  test('写完即定稿：每章再加定稿的 2–5 次', () => {
    const plan = pipeline.planWriteBatch({ ...base, mode: 'finalize', from: 1, to: 3 });
    assert.deepEqual(plan.calls, { low: 9, high: 24, max: 48 });
    assert.equal(plan.mode, 'finalize');
    assert.equal(plan.review, false);
  });

  // 五期补遗 §4：审稿一章 1 次、最多 3 次，与定稿各算各的。
  test('写完即审稿：每章再加审稿的 1 次（最多 3 次）；与定稿叠加', () => {
    const plan = pipeline.planWriteBatch({ ...base, review: true, from: 1, to: 3 });
    assert.equal(plan.review, true);
    assert.deepEqual(plan.calls, { low: 6, high: 12, max: 42 });
    const both = pipeline.planWriteBatch({ ...base, mode: 'finalize', review: true, from: 1, to: 3 });
    assert.deepEqual(both.calls, { low: 12, high: 27, max: 57 });
  });

  // 第 19 条批量那一面：已有产物的一律跳过，不问、不覆盖。
  test('已有正文的章跳过，不断开区间', () => {
    const plan = pipeline.planWriteBatch({ ...base, writtenNos: [2], from: 1, to: 4 });
    assert.deepEqual(plan.skipped, [2]);
    assert.deepEqual(plan.chapters, [1, 3, 4]);
    assert.equal(plan.stopAt, undefined);
  });

  // 后面的章要接着它的结尾写：跳过一章没细纲的去写后面的，写出来接不上。
  test('不给大纲覆盖：遇到第一章没有细纲的就在它前面收住', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 4, 5], from: 1, to: 5 });
    assert.deepEqual(plan.chapters, [1, 2]);
    assert.equal(plan.stopAt, 3);
  });

  // 百章实验复盘：细纲一次拆完、看不到正文。大纲覆盖到的章写到时再拆。
  test('边写边拆：大纲覆盖之内没细纲的章照写，连续的空白章每 5 章一批，拆细纲的调用算进去', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 9], from: 1, to: 10, outlineCoverage: 20 });
    assert.deepEqual(plan.chapters, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(plan.plotBatches, [[3, 4, 5, 6, 7], [8], [10]]);
    assert.equal(plan.stopAt, undefined);
    const writing = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 1, to: 10 }).calls;
    // 三批细纲各 1 次（上限 3n）。边写边拆不排叙事线（叙事线重做：计划随细纲写进线里，不再拆完排一次）。
    assert.deepEqual(plan.calls, { low: writing.low + 3, high: writing.high + 3, max: writing.max + 15 + 3 + 3 });
  });

  test('边写边拆：超出大纲覆盖的第一章在它前面收住', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1], from: 1, to: 6, outlineCoverage: 4 });
    assert.deepEqual(plan.chapters, [1, 2, 3, 4]);
    assert.deepEqual(plan.plotBatches, [[2, 3, 4]]);
    assert.equal(plan.stopAt, 5);
  });

  test('边写边拆：已有正文的章把批断开', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [], writtenNos: [3], from: 1, to: 5, outlineCoverage: 10 });
    assert.deepEqual(plan.plotBatches, [[1, 2], [4, 5]]);
  });

  test('写完即定稿：全文大纲落后 10 章就在那一章定稿之后更新一次，各算 1 次；只写正文不更新', () => {
    const filled = Array.from({ length: 30 }, (_, i) => i + 1);
    const plan = pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, writtenNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 11, to: 20, globalSummaryThrough: 3 });
    assert.deepEqual(plan.globalSummaryAt, [13]);
    const none = pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, from: 11, to: 20, globalSummaryThrough: 10 });
    assert.deepEqual(none.globalSummaryAt, [20]);
    assert.equal(none.calls.low - pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, from: 11, to: 20, globalSummaryThrough: 11 }).calls.low, 1);
    assert.deepEqual(pipeline.planWriteBatch({ ...base, plotFilledNos: filled, from: 11, to: 20 }).globalSummaryAt, []);
  });

  test('一次最多 10 章；写满了就不再往后看细纲', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 1, to: 20 });
    assert.equal(plan.chapters.length, pipeline.WRITE_BATCH_MAX);
    assert.equal(plan.stopAt, undefined, '第 11 章没细纲，但本来就写不到它');
  });

  test('区间写反了照样认；全写过时一章都没有、零调用', () => {
    const plan = pipeline.planWriteBatch({ ...base, writtenNos: [3, 4], from: 4, to: 3 });
    assert.equal(plan.from, 3);
    assert.deepEqual(plan.chapters, []);
    assert.deepEqual(plan.calls, { low: 0, high: 0, max: 0 });
  });

  test('isWriteBatchMode 只认两种', () => {
    assert.ok(['draft', 'finalize'].every(pipeline.isWriteBatchMode));
    assert.ok(![undefined, 'review', ''].some(pipeline.isWriteBatchMode));
  });
});

// 叙事线二期（设计稿「四、写前检查」）：两类提醒，零调用、不拦人。前端批量写章弹窗与后端确认框同一个函数、同一句。
describe('pipeline.ts · 写前检查的叙事线提醒', () => {
  const watch = {
    lines: [
      { name: '青崖旧案', kind: '主线', lastActive: 1, stall: 5, planned: [] },
      { name: '林昭与沈青', kind: '感情线', lastActive: 2, stall: 15, planned: [7] },
      { name: '断剑', kind: '支线', lastActive: 1, stall: 15, planned: [] },
      { name: '师父', kind: '人物线', lastActive: 1, stall: 15, planned: [9] },
    ],
    foreshadowing: [
      { name: '玉佩的来历', resolve: 5, planned: [] },
      { name: '旧伤', resolve: 6, planned: [7] },
      { name: '名册', resolve: 20, planned: [] },
    ],
  };

  test('一章：写第 N 章时按第 N − 1 章算，过了回收章、断了 K 章，本章计划里也没有的才提', () => {
    assert.deepEqual(pipeline.threadRemindersFor(watch, [7]), [
      { kind: 'overdue', name: '玉佩的来历', resolve: 5, at: 7 },
      { kind: 'stalled', name: '青崖旧案', lineKind: '主线', gap: 5, at: 7 },
    ]);
    // 第 6 章：主线只断了 4 章；旧伤第 6 章前收，写第 6 章时还不算过。
    assert.deepEqual(pipeline.threadRemindersFor(watch, [6]).map((r) => r.name), ['玉佩的来历']);
    // 第 8 章：旧伤第 7 章的计划在这一章之外，照报。
    assert.deepEqual(pipeline.threadRemindersFor(watch, [8]).map((r) => r.name), ['玉佩的来历', '旧伤', '青崖旧案']);
  });

  test('一批：区间里哪一章安排过都算；at 是第一个对上的那一章；没有 watch 或区间是空的不提', () => {
    assert.deepEqual(pipeline.threadRemindersFor(watch, [8, 6, 7]), [
      { kind: 'overdue', name: '玉佩的来历', resolve: 5, at: 6 },
      { kind: 'stalled', name: '青崖旧案', lineKind: '主线', gap: 5, at: 7 },
    ]);
    assert.deepEqual(pipeline.threadRemindersFor(undefined, [7]), []);
    assert.deepEqual(pipeline.threadRemindersFor(watch, []), []);
  });

  test('说法：本章与区间里两种；注一句没定稿的那几章；没有提醒是空串', () => {
    const one = pipeline.threadRemindersFor(watch, [7]);
    assert.equal(
      pipeline.describeThreadReminders('本章', one),
      '叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，还没收，本章计划里也没安排收；〈青崖旧案〉（主线）已经 5 章没有进展，本章计划里也没安排推进。只是提醒，照写不拦。'
    );
    assert.equal(
      pipeline.describeThreadReminders('区间里', pipeline.threadRemindersFor(watch, [6, 7, 8]), pipeline.unrecordedBefore(4, 6)),
      '叙事线提醒：伏笔〈玉佩的来历〉计划第 5 章前收，写到第 6 章还没收，区间里也没安排收；〈青崖旧案〉（主线）写到第 7 章就断了 5 章，区间里也没安排推进（第 5 章还没定稿，叙事线还没记上，提醒可能不准）。只是提醒，不拦。'
    );
    assert.equal(pipeline.describeThreadReminders('本章', []), '');
    assert.deepEqual(pipeline.unrecordedBefore(3, 7), { from: 4, to: 6 });
    assert.equal(pipeline.unrecordedBefore(6, 7), undefined);
    assert.equal(pipeline.unrecordedBefore(0, 1), undefined);
  });
});
