/**
 * 创作流水线纯函数：Stage × Capability × Target、细纲的文件格式、
 * 单段流水线状态推导、全书状态推导。
 *
 * 这两个模块是整条流水线的地基，且全部零 I/O——所以它们能被单独 bundle 出来直接调，
 * 不需要建工程、不需要 host、不需要模型。
 *
 * 模块在文件顶层同步加载（而不是在 before() 里）：有四处用例要按模块常量
 * （CREATION_STAGES / CAPABILITIES）展开成一批 test，describe 体在收集阶段就要读到它们。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');
const plotFile = loadModule('src/core/model/plotFile.ts');

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

  // 剧情段就是最小的规划单位：从前它拆的是场景，而那一层已经删掉了。
  test('剧情阶段不能拆分', () => {
    assert.ok(!pipeline.STAGE_CAPABILITIES.plot.includes('split'));
  });

  test('卷纲阶段可以拆分', () => {
    assert.ok(pipeline.STAGE_CAPABILITIES.volume.includes('split'));
  });

  test('大纲阶段可以拆分', () => {
    assert.ok(pipeline.STAGE_CAPABILITIES.outline.includes('split'));
  });

  test('四个阶段都能讨论', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.STAGE_CAPABILITIES[s].includes('discuss')));
  });

  // 「落定」只给剧情层：它是唯一一层「先跟人聊、聊出结论再落文件」的东西。
  // 铺到四层会得到三个几乎没人点、点了也不知道该沉淀什么的按钮。
  test('只有剧情层能落定', () => {
    assert.equal(
      pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('settle')).join(),
      'plot'
    );
  });

  test('合法动作', () => {
    assert.ok(pipeline.isValidAction({ stage: 'volume', capability: 'split' }));
  });

  test('落定是剧情层的合法动作', () => {
    assert.ok(pipeline.isValidAction({ stage: 'plot', capability: 'settle' }));
  });

  test('非法组合被拒', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'manuscript', capability: 'split' }));
  });

  // 剧情层的 split 随场景层一起没了，老会话里存着它的要被拒。
  test('剧情层的 split 被拒', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'plot', capability: 'split' }));
  });

  test('大纲不能落定', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'outline', capability: 'settle' }));
  });

  test('乱填的阶段被拒', () => {
    assert.ok(!pipeline.isValidAction({ stage: 'nope', capability: 'discuss' }));
  });
});

describe('pipeline.ts · 输出形态', () => {
  const artifact = ['generate', 'split', 'settle'];

  for (const capability of pipeline.CAPABILITIES) {
    const expected = artifact.includes(capability) ? 'artifact' : 'text';
    test(`${capability} → ${expected}`, () => {
      const kind = pipeline.outputKindOf({ stage: 'plot', capability });
      assert.equal(kind, expected, kind);
    });
  }

  // 讨论/挑刺/检查绝不能产出可采纳的东西——否则用户会不知道该采纳哪一个。
  test('讨论不产出产物', () => {
    assert.equal(pipeline.outputKindOf({ stage: 'scene', capability: 'discuss' }), 'text');
  });

  // 落定的全部意义就是把讨论沉淀成文件，它必须可采纳。
  test('落定产出产物', () => {
    assert.equal(pipeline.outputKindOf({ stage: 'plot', capability: 'settle' }), 'artifact');
  });
});

describe('pipeline.ts · 动作归一（容错）', () => {
  test('认得出合法动作', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'generate' }).capability, 'generate');
  });

  // 删掉的能力在老会话里各有落点：改写并进了生成，其余三个都是讨论的变体。
  test('老会话的 rewrite 落到 generate', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'rewrite' }).capability, 'generate');
  });

  test('老会话的挑刺/检查/扩展落到讨论', () => {
    for (const legacy of ['critique', 'check', 'expand']) {
      assert.equal(pipeline.normalizeAction({ stage: 'plot', capability: legacy }).capability, 'discuss', legacy);
    }
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

  // 旧会话里存的是重构前的 `plan`，它不再是合法阶段——回落而不是崩。
  test('旧的 plan 阶段回落', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'plan' }).stage, 'manuscript');
  });

  // 场景层删掉之后，老会话里那个 stage 落到剧情层——它记着的是「这一段该
  // 怎么发生」，接着往下做最可能是回剧情层把它写清楚。与 normalizeTarget 一致。
  test('老会话的 scene 阶段落到剧情', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'generate' }).stage, 'plot');
  });

  test('老会话的 scene 阶段能力也归一', () => {
    const a = pipeline.normalizeAction({ stage: 'scene', capability: 'generate' });
    assert.ok(pipeline.STAGE_CAPABILITIES[a.stage].includes(a.capability), JSON.stringify(a));
  });

  test('认不出的阶段回落', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'beat' }).stage, 'manuscript');
  });
});

describe('pipeline.ts · Target', () => {
  const outline = { kind: 'outline' };
  const volume = { kind: 'volume', volumeRelPath: '.novelforge/volumes/01-觉醒之日.md' };
  const plot = { kind: 'plot', plotRelPath: '.novelforge/plots/012-夜入青云.md' };
  const whole = { kind: 'manuscript', plotRelPath: '.novelforge/plots/012-夜入青云.md' };

  // 卷纲成为独立阶段之后，四种 target 与四个阶段一一对应。
  test('target 的阶段', () => {
    assert.equal(pipeline.stageOfTarget(plot), 'plot');
  });

  test('卷纲的阶段是 volume（不再借 outline）', () => {
    assert.equal(pipeline.stageOfTarget(volume), 'volume');
  });

  test('每种 target 的阶段都是合法阶段', () => {
    for (const t of [outline, volume, plot, whole]) {
      assert.ok(pipeline.CREATION_STAGES.includes(pipeline.stageOfTarget(t)), t.kind);
    }
  });

  test('大纲没有归属的章', () => {
    assert.equal(pipeline.plotOfTarget(outline), undefined);
  });

  test('卷纲没有归属的段', () => {
    assert.equal(pipeline.plotOfTarget(volume), undefined);
  });

  test('剧情有归属的章', () => {
    assert.ok(pipeline.plotOfTarget(plot).endsWith('012-夜入青云.md'));
  });

  test('正文也有归属的段', () => {
    assert.ok(pipeline.plotOfTarget(whole).endsWith('012-夜入青云.md'));
  });

  test('key 稳定', () => {
    assert.equal(pipeline.targetKey(plot), pipeline.targetKey({ ...plot }));
  });

  test('剧情与正文是不同的 key', () => {
    assert.notEqual(pipeline.targetKey(plot), pipeline.targetKey(whole));
  });

  test('isSameTarget', () => {
    assert.ok(pipeline.isSameTarget(plot, { ...plot }));
    assert.ok(!pipeline.isSameTarget(plot, whole));
  });

  // 同序号不同文件的两段必须是不同的 target——用段号做键就会在这里撞车。
  test('同序号不同文件不撞 key', () => {
    const twin = { kind: 'plot', plotRelPath: '.novelforge/plots/001-甲.md' };
    const twinB = { kind: 'plot', plotRelPath: '.novelforge/plots/001-乙.md' };
    assert.notEqual(pipeline.targetKey(twin), pipeline.targetKey(twinB));
  });

  test('描述大纲', () => {
    assert.equal(pipeline.describeTarget(outline), '全书大纲');
  });

  test('描述剧情', () => {
    assert.equal(
      pipeline.describeTarget(plot, { no: 12, title: '夜入青云' }),
      '第 12 章《夜入青云》 · 剧情',
      pipeline.describeTarget(plot, { no: 12, title: '夜入青云' })
    );
  });

  test('描述卷纲', () => {
    assert.equal(pipeline.describeTarget(volume, { no: 1, title: '觉醒之日' }), '第 1 卷《觉醒之日》 · 卷纲');
  });

  test('描述整段正文', () => {
    assert.equal(
      pipeline.describeTarget(whole, { no: 12, title: '夜入青云' }),
      '第 12 章《夜入青云》 · 正文'
    );
  });

  test('没有章节信息时退回路径', () => {
    assert.ok(pipeline.describeTarget(plot).includes('012-夜入青云.md'));
  });

  // 流水线新建出来的章是纯序号名，标题回落成「第 N 章」。套进模板会变成
  // 「第 7 章《第 7 章》」，看起来像出了 bug。
  test('未命名的章只报序号', () => {
    assert.equal(
      pipeline.describeTarget(plot, { no: 7, title: '第 7 章' }),
      '第 7 章 · 剧情',
      pipeline.describeTarget(plot, { no: 7, title: '第 7 章' })
    );
  });
});

describe('pipeline.ts · plotLabel', () => {
  test('有标题时带书名号', () => {
    assert.equal(pipeline.plotLabel(12, '夜入青云'), '第 12 章《夜入青云》');
  });

  test('标题为空时只报序号', () => {
    assert.equal(pipeline.plotLabel(7, ''), '第 7 章');
  });

  test('标题缺席时只报序号', () => {
    assert.equal(pipeline.plotLabel(7), '第 7 章');
  });

  // 「第 7 章」正是未命名章节的回落标题，它不是真标题。
  test('标题恰好是回落值时只报序号', () => {
    assert.equal(pipeline.plotLabel(7, '第 7 章'), '第 7 章');
  });

  // 但作者手工把某一章命名成「第 8 章」（序号不同）就是真标题，照常显示。
  test('别的序号写在标题里仍算真标题', () => {
    assert.equal(pipeline.plotLabel(7, '第 8 章'), '第 7 章《第 8 章》');
  });
});

// 章节退出了流水线，但它仍是工程页发布区里的东西，说法要留着。
describe('pipeline.ts · chapterLabel（发布区）', () => {
  test('有标题时带书名号', () => {
    assert.equal(pipeline.chapterLabel(12, '夜入青云'), '第 12 章《夜入青云》');
  });

  test('标题恰好是回落值时只报序号', () => {
    assert.equal(pipeline.chapterLabel(7, '第 7 章'), '第 7 章');
  });
});

describe('pipeline.ts · Target 归一（容错）', () => {
  test('认得出合法 target', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'plot', plotRelPath: 'a.md' }).plotRelPath, 'a.md');
  });

  // 认不出的一律回落到大纲：它是唯一不依赖任何细纲就一定存在的产物。
  test('undefined 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget(undefined).kind, 'outline');
  });

  test('认不出的 kind 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'beat' }).kind, 'outline');
  });

  // 旧会话存的是 `{kind:'plan', chapterRelPath}`：两个字段都认不出，回落到大纲。
  test('旧的 plan target 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'plan', chapterRelPath: 'chapters/001.md' }).kind, 'outline');
  });

  test('缺路径的剧情回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'plot', plotRelPath: '  ' }).kind, 'outline');
  });

  // 场景那一层删掉了，但老会话里还存着它。段路径仍然有效，落回那一段的
  // 剧情层——与 normalizeAction 把 stage 落到 plot 是同一条判断，两处必须一致。
  test('老会话的 scene target 落到该段剧情', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', plotRelPath: 'a.md', sceneNo: 3 }).kind, 'plot');
  });

  test('老会话的 scene target 保住段路径', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', plotRelPath: 'a.md', sceneNo: 3 }).plotRelPath, 'a.md');
  });

  test('scene 的场号被丢掉（新模型里没有落点）', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', plotRelPath: 'a.md', sceneNo: 3 }).sceneNo, undefined);
  });

  test('缺路径的 scene 回落到大纲', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'scene', sceneNo: 3 }).kind, 'outline');
  });

  // 老会话里的正文 target 可能带 sceneNo，新模型不认它。
  test('正文的场号被丢掉', () => {
    assert.equal(
      pipeline.normalizeTarget({ kind: 'manuscript', plotRelPath: 'a.md', sceneNo: 2 }).sceneNo,
      undefined
    );
  });

  test('卷纲 target 认得出', () => {
    assert.equal(pipeline.normalizeTarget({ kind: 'volume', volumeRelPath: 'v.md' }).kind, 'volume');
  });
});

describe('plotFile.ts · 文件名规则', () => {
  const yes = ['001-入宗风波.md', '007.md', '012-夜入青云.markdown', '0100-末章.md', '3_临时.md'];
  for (const name of yes) {
    test(`「${name}」算细纲`, () => {
      assert.ok(plotFile.isPlotFileName(name), name);
    });
  }

  // 细纲是插件自己的格式，只认 md——与角色卡/场景一致，与「章节不认扩展名」相反。
  const no = ['001-入宗风波.txt', '入宗风波.md', '000-零号.md', 'README.md', '001.png'];
  for (const name of no) {
    test(`「${name}」不算细纲`, () => {
      assert.ok(!plotFile.isPlotFileName(name), name);
    });
  }

  test('解析段号与词干', () => {
    const parsed = plotFile.parsePlotFileName('012-夜入青云.md');
    assert.equal(parsed.no, 12, JSON.stringify(parsed));
    assert.equal(parsed.stem, '夜入青云', JSON.stringify(parsed));
  });

  // 与 parseChapterFileName 同一个坑：必须先剥扩展名，否则 `007.md` 会被吃成词干 md。
  test('`007.md` 的词干为空', () => {
    assert.equal(plotFile.parsePlotFileName('007.md').stem, '');
  });

  test('拼文件名补三位', () => {
    assert.equal(plotFile.plotFileName(7, '入宗风波'), '007-入宗风波.md');
  });

  test('拼文件名 · 无标题', () => {
    assert.equal(plotFile.plotFileName(7, ''), '007.md');
  });

  test('拼文件名 · 三位数段号', () => {
    assert.equal(plotFile.plotFileName(128, 'x'), '128-x.md');
  });

  test('文件名与解析互逆', () => {
    assert.equal(plotFile.parsePlotFileName(plotFile.plotFileName(42, '灵兽园')).no, 42);
  });
});

describe('plotFile.ts · 解析与渲染', () => {
  let rendered;
  let back;
  let bare;
  let emptyFilled;
  let onlyGoal;
  let withThread;

  before(() => {
    rendered = plotFile.renderPlotFile({
      no: 12,
      title: '夜入青云',
      arc: '第一幕 · 入局',
      targetWords: 3000,
      upstreamHash: '3f2a1c0000000000',
      done: false,
      chapters: [],
      sections: {
        目标: '林昭拿到入宗名额，同时被沈砚盯上。',
        剧情脉络:
          '林昭在山门外等到放榜，名额里没有他；他去找李叔要说法，' +
          '牵出沈砚压名额的事；于是他连夜翻墙进宗门找证据。' +
          '收在：他手里攥着那份名册，而沈砚已经知道他来过。',
        冲突与转折: '主冲突是名额被压；在李叔说漏嘴那一步翻转；代价是他从此没法走正路进宗。',
        伏笔与回收: '埋：墙内的血迹。收：第 9 段那枚崖字令牌。',
      },
    });
    back = plotFile.parsePlotFile(rendered, '.novelforge/plots/012-夜入青云.md');

    // 空小节保留占位，作者手改时知道该往哪填（与摘要 keepEmpty 一致）。
    bare = plotFile.renderPlotFile({
      no: 1,
      title: 'x',
      arc: '',
      done: false,
      chapters: [],
      sections: plotFile.emptyPlotSections(),
    });

    // ---- 有没有实质内容 ----
    const filled = plotFile.emptyPlotSections();
    emptyFilled = plotFile.isPlotFilled(filled);
    filled.目标 = '进入青云宗';
    onlyGoal = plotFile.isPlotFilled(filled);
    filled.剧情脉络 = '他翻墙进去，拿到名册，被发现。';
    withThread = plotFile.isPlotFilled(filled);
  });

  test('剧情序列化往返 · 段号', () => {
    assert.equal(back.no, 12);
  });

  test('剧情序列化往返 · 标题', () => {
    assert.equal(back.title, '夜入青云');
  });

  test('剧情序列化往返 · 幕', () => {
    assert.equal(back.arc, '第一幕 · 入局');
  });

  test('剧情序列化往返 · 目标字数', () => {
    assert.equal(back.targetWords, 3000);
  });

  test('剧情序列化往返 · upstreamHash', () => {
    assert.equal(back.upstreamHash, '3f2a1c0000000000');
  });

  test('剧情序列化往返 · 目标', () => {
    assert.equal(back.sections.目标, '林昭拿到入宗名额，同时被沈砚盯上。');
  });

  test('剧情序列化往返 · 剧情脉络', () => {
    assert.ok(back.sections.剧情脉络.includes('收在：'), back.sections.剧情脉络);
  });

  test('剧情序列化往返 · 冲突与转折', () => {
    assert.ok(back.sections.冲突与转折.includes('翻转'), back.sections.冲突与转折);
  });

  test('剧情序列化往返 · 伏笔与回收', () => {
    assert.ok(back.sections.伏笔与回收.includes('崖字令牌'), back.sections.伏笔与回收);
  });

  test('未标记完成时 done 为假', () => {
    assert.equal(back.done, false);
  });

  // 标题行说「剧情段」而不是「第 N 章」：段号只是 `plots/` 里的排序键，
  // 一段可以拆成三章，写成「第 12 章」会在文件里留下一个假承诺。
  test('渲染带标题行', () => {
    assert.ok(rendered.includes('# 剧情段 12 夜入青云'), rendered.split('\n').slice(0, 12).join('\n'));
  });

  // 四节都在，且**没有「开头」「结尾」**——这是整次重构的落点：细纲不再
  // 规定这一章从哪句话开始、到哪句话结束，那是写正文时才定的东西。
  test('只有四节', () => {
    assert.equal(plotFile.PLOT_SECTION_KEYS.join(), '目标,剧情脉络,冲突与转折,伏笔与回收');
  });

  test('不再有「开头」小节', () => {
    assert.ok(!rendered.includes('## 开头'), rendered);
  });

  test('不再有「结尾」小节', () => {
    assert.ok(!rendered.includes('## 结尾'), rendered);
  });

  test('空小节仍写出标题与占位', () => {
    assert.ok(bare.includes('## 冲突与转折') && bare.includes('（待补充）'));
  });

  test('status: done 被读出', () => {
    assert.equal(plotFile.parsePlotFile('---\nstatus: done\n---\n\n## 目标\n\nx', '001-a.md').done, true);
  });

  // 判「排过没有」只看「剧情脉络」：拆段那一步就把目标填上了，拿它当判据的话
  // 刚拆出来的空壳会全部立刻显示「已规划」。
  test('全空的剧情不算排过', () => {
    assert.ok(!emptyFilled);
  });

  test('只有目标不算排过（拆段时它就填上了）', () => {
    assert.ok(!onlyGoal);
  });

  test('有剧情脉络就算排过', () => {
    assert.ok(withThread);
  });

  test('占位文字不算内容', () => {
    const placeholder = plotFile.emptyPlotSections();
    placeholder.剧情脉络 = '（待补充）';
    assert.ok(!plotFile.isPlotFilled(placeholder));
  });

  // ---- 一行摘要 ----
  test('一行摘要', () => {
    assert.equal(plotFile.describePlot({ no: 1, title: '入宗风波', arc: '第一幕 · 入局' }), '1. 入宗风波 · 第一幕 · 入局');
  });

  test('一行摘要 · 缺幕不留空段', () => {
    assert.equal(plotFile.describePlot({ no: 2, title: '夜访', arc: '' }), '2. 夜访');
  });

  test('一行摘要 · 未命名', () => {
    assert.equal(plotFile.describePlot({ no: 3, title: '', arc: '' }), '3. （未命名）');
  });

  // ---- 容错：作者手改 ----
  test('无 frontmatter 不抛错', () => {
    assert.equal(plotFile.parsePlotFile('## 目标\n\nx', '001-a.md').sections.目标, 'x');
  });

  test('畸形 frontmatter 不抛错', () => {
    assert.equal(plotFile.parsePlotFile('---\n乱写\n---\nx', 'p.md').no, 0);
  });

  test('整份大白话不抛错', () => {
    assert.equal(plotFile.parsePlotFile('随便写点什么', '001-a.md').sections.剧情脉络, '');
  });

  test('空文件不抛错', () => {
    assert.equal(plotFile.parsePlotFile('', '001-a.md').no, 1);
  });

  // 段号以**文件名**为准：作者重排顺序的方式就是改文件名前缀。
  test('文件名的段号压过 frontmatter', () => {
    assert.equal(plotFile.parsePlotFile('---\nplot: 9\n---\n\n## 目标\n\nx', 'plots/003-甲.md').no, 3);
  });

  test('无 frontmatter 标题时用文件名词干', () => {
    assert.equal(plotFile.parsePlotFile('---\nplot: 9\n---\n\n## 目标\n\nx', 'plots/003-甲.md').title, '甲');
  });

  test('targetWords 写成汉字时不产生 NaN', () => {
    assert.equal(plotFile.parsePlotFile('---\ntargetWords: 三千\n---\nx', '001-a.md').targetWords, undefined);
  });
});

describe('pipeline.ts · 单章流水线状态推导', () => {
  const F = (patch) => ({ ...pipeline.emptyFacts(), ...patch });
  const stage = (patch) => pipeline.deriveStage(F(patch));
  // 正文写完、也已经拆成发布章节（chapterExists）才轮得到审阅。
  const done = { plotFilled: true, words: 3000, chapterExists: true };

  test('什么都没有 → 待写剧情', () => {
    assert.equal(stage({}), 'plot');
  });

  // 拆段建出来的骨架只有「目标」，isPlotFilled 不认——所以它停在待写剧情，
  // 而不是假装已经排过。
  test('只有骨架 → 待写剧情', () => {
    assert.equal(stage({ plotFilled: false }), 'plot');
  });

  // 场景那一层删掉之后，剧情排好的下一步直接是写正文——链上少一个闸口。
  test('剧情排好但正文空 → 待写正文', () => {
    assert.equal(stage({ plotFilled: true }), 'manuscript');
  });

  // ---- 「写够没有」的判据：targetWords × MANUSCRIPT_DONE_RATIO ----

  test('目标字数缺席时有字就算写完 → 待拆分', () => {
    assert.equal(stage({ plotFilled: true, words: 500 }), 'split');
  });

  test('写到目标字数的一半 → 还在待写正文', () => {
    assert.equal(stage({ plotFilled: true, words: 1500, targetWords: 3000 }), 'manuscript');
  });

  test('写到目标字数的八成 → 待拆分', () => {
    assert.equal(stage({ plotFilled: true, words: 2400, targetWords: 3000 }), 'split');
  });

  // 模型不会正好停在目标字数上。卡在 0.97 会让「待写正文」永远消不掉，
  // 而那是个假的待做项。
  test('略微超出八成也算写完', () => {
    assert.equal(stage({ plotFilled: true, words: 2900, targetWords: 3000 }), 'split');
  });

  test('目标字数为 0 视同没写', () => {
    assert.equal(stage({ plotFilled: true, words: 100, targetWords: 0 }), 'split');
  });

  // 中转站里有正文、chapters/ 里还没有：活儿在作者手上，不花 token。
  test('正文齐了还没拆分 → 待拆分', () => {
    assert.equal(stage({ ...done, chapterExists: false }), 'split');
  });

  // 老工程：只有 chapters/ 里的成品，从没走过这条流水线。
  // 成品在就不该倒回去要求补细纲——那是「原有的章节天生就算数」的落点。
  test('只有成品、没有细纲 → 待审阅（不回到写剧情）', () => {
    assert.equal(stage({ chapterExists: true }), 'review');
  });

  test('只有成品且摘要新鲜 → 已完成', () => {
    assert.equal(stage({ chapterExists: true, summaryExists: true, summaryStale: false }), 'done');
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
  // 正文的上游现在是**细纲本身**（从前是那一段的场景集合）。
  test('细纲改过 → 正文重新变成待写', () => {
    assert.equal(stage({ ...done, chapterExists: false, upstreamStale: true }), 'manuscript');
  });

  // 但已经发布的章不被拉回去：中转站那份拆分时就删了，
  // 把作者已经发出去的文字标成「待写正文」是在撺掇他重写。
  // 工程页那一行仍会挂 ⟳（isUpstreamStale 认它），提醒到位就够了。
  test('已发布的章：细纲改过不拉回待写正文', () => {
    assert.equal(
      stage({ ...done, summaryExists: true, summaryStale: false, upstreamStale: true }),
      'done'
    );
  });

  // 作者手工宣布完成：只在正文齐了之后才认，且只能向前。
  test('手工标记完成可以跳过审阅', () => {
    assert.equal(stage({ ...done, markedDone: true }), 'done');
  });

  test('手工标记不能跳过没写的正文', () => {
    assert.equal(stage({ plotFilled: true, markedDone: true }), 'manuscript');
  });

  test('手工标记不能跳过没排的剧情', () => {
    assert.equal(stage({ markedDone: true }), 'plot');
  });

  // ---- 完成度 ----
  const p = (patch) => pipeline.deriveProgress(F(patch));

  test('全空的完成度是 0', () => {
    assert.equal(p({}).plot, 0);
    assert.equal(p({}).manuscript, 0);
  });

  test('只有三段（场景那一段没了）', () => {
    assert.deepEqual(Object.keys(p({})).sort(), ['manuscript', 'plot', 'summary']);
  });

  test('剧情排好算 1', () => {
    assert.equal(p({ plotFilled: true }).plot, 1);
  });

  // 正文那一段用比例：「目标三千字、写了一千八」和「一个字都没写」不是一回事。
  test('正文按目标字数算比例', () => {
    assert.equal(p({ words: 1200, targetWords: 3000 }).manuscript, 0.5);
  });

  // 没有目标字数时退化成布尔——不拿一个猜出来的阈值骗人。
  test('没有目标字数时正文有字就算满', () => {
    assert.equal(p({ words: 1000 }).manuscript, 1);
  });

  // 进度与状态机必须同源：到 1 的那一刻正是它判「写完了」的那一刻。
  test('进度到 1 与状态机说写完是同一刻', () => {
    const f = F({ plotFilled: true, words: 2400, targetWords: 3000 });
    assert.equal(pipeline.deriveProgress(f).manuscript, 1);
    assert.equal(pipeline.deriveStage(f), 'split');
  });

  test('比例不会超过 1', () => {
    assert.equal(p({ words: 99999, targetWords: 3000 }).manuscript, 1);
  });

  test('摘要新鲜才算 1', () => {
    assert.equal(p({ summaryExists: true, summaryStale: false }).summary, 1);
    assert.equal(p({ summaryExists: true, summaryStale: true }).summary, 0);
  });

  // 老工程的 99 章明明写完了，只是没经过这条流水线。
  test('成品在就前两段满格', () => {
    const r = p({ chapterExists: true });
    assert.equal(r.plot, 1);
    assert.equal(r.manuscript, 1);
  });
});

describe('pipeline.ts · 下一步（状态机 → 一个动作）', () => {
  const N = (patch) => ({ words: 0, ratio: 0, upstreamStale: false, ...patch });
  const step = (plotStage, patch) => pipeline.deriveNextStep(plotStage, N(patch));

  // 每一档都必须落在一个**该阶段支持**的能力上，否则界面上会出现一个
  // 后端当场回落掉的主按钮——点了跑出来的不是它写的那件事。
  for (const s of ['plot', 'manuscript', 'split', 'review']) {
    test(`${s} 有下一步`, () => {
      assert.ok(!!step(s), s);
    });

    test(`${s} 的能力在该阶段合法`, () => {
      const next = step(s);
      assert.ok(
        pipeline.STAGE_CAPABILITIES[next.stage].includes(next.capability),
        `${next.stage}·${next.capability}`
      );
    });

    test(`${s} 的下一步有说明`, () => {
      const next = step(s);
      assert.ok(!!next.label && !!next.hint, JSON.stringify(next));
    });
  }

  test('没剧情 → 写剧情', () => {
    assert.equal(step('plot').stage, 'plot');
    assert.equal(step('plot').capability, 'generate');
  });

  // 主按钮永远是「写剧情」而不是「落定剧情」：落定要有讨论才有意义，
  // 而状态机不知道这一轮会话里聊过没有。想落定就去 `/` 面板挑。
  test('没剧情时主按钮不是落定', () => {
    assert.notEqual(step('plot').capability, 'settle');
  });

  // 细纲改过而正文没跟上：要的是拿新剧情重做一版，不是往后接着写。
  // 改写不是独立能力（并进了 generate），但按钮上要说的仍是「重写」。
  test('剧情变过 → 重写正文', () => {
    const stale = step('manuscript', { words: 3000, ratio: 1, upstreamStale: true });
    assert.equal(stale.capability, 'generate', stale.capability);
    assert.equal(stale.label, '重写正文', stale.label);
  });

  test('一个字都没写 → 写正文', () => {
    const write = step('manuscript');
    assert.equal(write.capability, 'generate', JSON.stringify(write));
    assert.equal(write.label, '写正文', write.label);
  });

  // 写了一半：落盘走的是追加，按钮上必须说清是「接着写」而不是重来一遍，
  // 否则作者会以为点下去会丢掉前面那几千字。
  test('写了一半 → 接着写', () => {
    const more = step('manuscript', { words: 1500, ratio: 0.5 });
    assert.equal(more.label, '接着写', more.label);
  });

  test('接着写的说明报出已写字数', () => {
    assert.ok(step('manuscript', { words: 1500, ratio: 0.5 }).hint.includes('1500'));
  });

  test('接着写的说明报出百分比', () => {
    assert.ok(step('manuscript', { words: 1500, ratio: 0.5 }).hint.includes('50%'));
  });

  // 上游变过优先于「接着写」：拿新剧情重做一版才是对的，往后接只会接歪。
  test('上游变过时不说接着写', () => {
    assert.equal(step('manuscript', { words: 1500, ratio: 0.5, upstreamStale: true }).label, '重写正文');
  });

  // 拆分是作者的活（标 `---`），不是一次模型调用。
  test('待拆分 → 拆成章节（工程动作）', () => {
    assert.equal(step('split').projectAction, 'splitManuscript');
  });

  // 审阅要的是更新摘要，那是工程动作，不该假装成一轮对话。
  test('待审阅 → 总结这一章（工程动作）', () => {
    assert.equal(step('review').projectAction, 'summarizePlot');
  });

  // 写完就是写完了。造一个假的下一步等于逼作者一直有事可做。
  test('已完成不催', () => {
    assert.equal(pipeline.deriveNextStep('done', N()), undefined);
  });
});
describe('pipeline.ts · 全书状态（大纲 → 卷 → 剧情段 → 按段推进）', () => {
  const B = (patch) => ({ outlineFilled: false, volumeCount: 0, plotCount: 0, ...patch });
  const stage = (patch) => pipeline.deriveBookStage(B(patch));

  test('没大纲 → 写大纲', () => {
    assert.equal(stage({}), 'outline');
  });

  // 有段但大纲空着（作者先手写了几段再回头补大纲）仍然先催大纲：
  // 后面几层都从它展开，空着的话每一段的上下文都少一块。
  test('大纲空着时段数不算数', () => {
    assert.equal(stage({ plotCount: 5 }), 'outline');
  });

  test('有大纲没卷 → 拆成卷', () => {
    assert.equal(stage({ outlineFilled: true }), 'volumes');
  });

  test('有卷没段 → 拆剧情段', () => {
    assert.equal(stage({ outlineFilled: true, volumeCount: 2 }), 'plots');
  });

  test('有段 → 交给按段流水线', () => {
    assert.equal(stage({ outlineFilled: true, volumeCount: 1, plotCount: 1 }), 'working');
  });

  // 老工程一份卷纲都没有，但它写了 99 章——把它拉回「先把大纲拆成卷」是荒唐的。
  test('老工程（有章没卷）直接算在写', () => {
    assert.equal(stage({ outlineFilled: true, volumeCount: 0, plotCount: 99 }), 'working');
  });

  // ---- 全书下一步 ----
  const step = (s) => pipeline.deriveBookNextStep(s);

  test('大纲阶段 → 生成大纲', () => {
    assert.equal(step('outline').stage, 'outline');
    assert.equal(step('outline').capability, 'generate');
  });

  test('拆卷阶段 → 大纲的 split', () => {
    assert.equal(step('volumes').stage, 'outline');
    assert.equal(step('volumes').capability, 'split');
  });

  test('拆卷的按钮写着「拆成卷」', () => {
    assert.equal(step('volumes').label, '拆成卷');
  });

  test('拆段的按钮写着「拆出剧情段」', () => {
    assert.equal(step('plots').label, '拆出剧情段');
  });

  // 拆段是**卷纲层**的活：它从一卷的卷纲里拆，作者点开看的也是那份卷纲。
  // 从前它挂在 outline 阶段、靠 targetKind 特判换文案。
  test('拆段落在卷纲层的 split', () => {
    assert.equal(step('plots').stage, 'volume');
    assert.equal(step('plots').capability, 'split');
  });

  // 段已经有了：该做什么由**选中的那一段**决定，挑哪一段是作者的选择。
  test('有段之后全书级不再给下一步', () => {
    assert.equal(step('working'), undefined);
  });

  test('全书下一步的能力都合法', () => {
    for (const s of ['outline', 'volumes', 'plots']) {
      const next = step(s);
      assert.ok(
        pipeline.STAGE_CAPABILITIES[next.stage].includes(next.capability),
        `${s} → ${next.stage}·${next.capability}`
      );
    }
  });
});

describe('pipeline.ts · 命令表', () => {
  for (const stage of pipeline.CREATION_STAGES) {
    test(`${stage} 有命令`, () => {
      assert.ok(pipeline.commandsFor(stage).length > 0);
    });

    // 讨论不是命令——打字就是在讨论。面板里是 STAGE_CAPABILITIES 去掉 discuss。
    test(`${stage} 的命令与 STAGE_CAPABILITIES 一致（不含讨论）`, () => {
      const cmds = pipeline.commandsFor(stage);
      assert.equal(cmds.length, pipeline.STAGE_CAPABILITIES[stage].length - 1);
      assert.ok(cmds.every((c) => pipeline.STAGE_CAPABILITIES[stage].includes(c.capability)));
    });

    test(`${stage} 的面板里没有讨论`, () => {
      assert.ok(pipeline.commandsFor(stage).every((c) => c.capability !== 'discuss'));
    });

    test(`${stage} 的命令名不重复`, () => {
      const cmds = pipeline.commandsFor(stage);
      assert.equal(new Set(cmds.map((c) => c.label)).size, cmds.length, cmds.map((c) => c.label).join('|'));
    });

    test(`${stage} 每个命令都有说明与过滤键`, () => {
      assert.ok(pipeline.commandsFor(stage).every((c) => c.hint && c.keys.length > 0));
    });

    // 面板里剩下的每一条都产出可采纳的产物（会花钱、会问一次落盘），
    // 这正是它们值得显式挑一下的原因。
    test(`${stage} 的命令都产出产物`, () => {
      assert.ok(
        pipeline.commandsFor(stage).every(
          (c) => pipeline.outputKindOf({ stage, capability: c.capability }) === 'artifact'
        )
      );
    });
  }

  // 同一个能力在不同阶段的说法不同——split 在大纲拆的是卷，在卷纲层拆的是段。
  test('大纲的 split 叫拆成卷', () => {
    assert.equal(pipeline.labelOf('outline', 'split'), '拆成卷');
  });

  // 从前这条要靠 targetKind 特判（`labelOf('outline','split','volume')`）。
  // 卷纲独立成阶段之后按 stage 取就够了，少一个会忘记传的参数。
  test('卷纲的 split 叫拆出剧情段', () => {
    assert.equal(pipeline.labelOf('volume', 'split'), '拆出剧情段');
  });

  test('卷纲的 generate 叫写这一卷的卷纲', () => {
    assert.equal(pipeline.labelOf('volume', 'generate'), '写这一卷的卷纲');
  });

  test('卷纲的 split 说明写着一次只拆一段', () => {
    assert.match(pipeline.commandOf('volume', 'split').hint, /一次只拆一段/);
  });

  test('剧情的 generate 叫写剧情', () => {
    assert.equal(pipeline.labelOf('plot', 'generate'), '写剧情');
  });

  test('剧情的 settle 叫落定剧情', () => {
    assert.equal(pipeline.labelOf('plot', 'settle'), '落定剧情');
  });

  // 没有专门说法的沿用通用标签（日志与确认框用的就是它）。
  test('没覆盖的沿用通用说法', () => {
    assert.equal(pipeline.labelOf('manuscript', 'discuss'), pipeline.CAPABILITY_LABEL.discuss);
  });

  // 落定与写剧情产出的是同一种产物，通用文案说不清它们的差别——
  // 而那个差别（以讨论为准还是以你这句话为准）正是作者要选的东西。
  test('落定与写剧情的说明不同', () => {
    assert.notEqual(pipeline.commandOf('plot', 'settle').hint, pipeline.commandOf('plot', 'generate').hint);
  });

  test('落定的说明提到讨论', () => {
    assert.ok(pipeline.commandOf('plot', 'settle').hint.includes('讨论'), pipeline.commandOf('plot', 'settle').hint);
  });

  test('查得到某个具体命令', () => {
    assert.equal(pipeline.commandOf('volume', 'split')?.label, '拆出剧情段');
  });

  test('剧情层查不到 split（场景那一层没了）', () => {
    assert.equal(pipeline.commandOf('plot', 'split'), undefined);
  });

  test('阶段不支持的能力查不到', () => {
    assert.equal(pipeline.commandOf('manuscript', 'split'), undefined);
  });

  test('大纲查不到落定', () => {
    assert.equal(pipeline.commandOf('outline', 'settle'), undefined);
  });
});
