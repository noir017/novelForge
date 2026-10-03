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

  // 第 22 条：细纲是唯一一层「先聊、聊出结论再落文件」的东西。
  test('只有细纲层能落定', () => {
    const withSettle = pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('settle'));
    assert.deepEqual(withSettle, ['plot']);
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
    assert.deepEqual(pipeline.commandsFor('plot').map((c) => c.label), ['落定细纲', '写细纲']);
    assert.deepEqual(pipeline.commandsFor('manuscript').map((c) => c.label), ['写正文', '审稿']);
    assert.ok(pipeline.commandOf('manuscript', 'review').keys.includes('sg'));
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
    assert.equal(pipeline.describeTarget(P, { no: 12, title: '夜访' }), '第 12 章《夜访》 · 细纲');
    assert.equal(pipeline.describeTarget(M, { no: 12, title: '夜访' }), '第 12 章《夜访》 · 正文');
    assert.equal(pipeline.describeTarget(M), `${M.plotRelPath} · 正文`);
  });

  test('四件架构文档各有中文名', () => {
    assert.deepEqual(pipeline.SETTING_DOCS, ['config', 'premise', 'characters', 'world']);
    assert.ok(pipeline.SETTING_DOCS.every((d) => pipeline.SETTING_DOC_LABEL[d]));
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

describe('plotFile.ts · 解析与渲染（D3 格式）', () => {
  const plot = {
    no: 12,
    title: '夜入青云',
    role: '小高潮',
    characters: ['林昭', '沈青'],
    targetWords: 3000,
    upstreamHash: 'aaaa',
    writtenFrom: 'bbbb',
    done: false,
    sections: {
      本章目的: '林昭拿到入宗资格',
      关键事件: '雨夜翻墙，被巡夜弟子撞见，亮出半枚令牌。',
      章末钩子: '执事认出令牌，脸色变了。',
    },
  };
  const text = plotFile.renderPlotFile(plot);
  const back = plotFile.parsePlotFile(text, '.novelforge/plots/012-夜入青云.md');

  test('往返：规划字段', () => {
    assert.equal(back.no, 12);
    assert.equal(back.title, '夜入青云');
    assert.equal(back.role, '小高潮');
    assert.deepEqual(back.characters, ['林昭', '沈青']);
    assert.equal(back.targetWords, 3000);
    assert.equal(back.upstreamHash, 'aaaa');
    assert.equal(back.writtenFrom, 'bbbb');
    assert.equal(back.done, false);
  });

  test('往返：三节', () => {
    assert.deepEqual(back.sections, plot.sections);
  });

  test('只有三节', () => {
    assert.deepEqual([...plotFile.PLOT_SECTION_KEYS], ['本章目的', '关键事件', '章末钩子']);
  });

  test('渲染带「第N章 标题」一行', () => {
    assert.match(text, /^# 第12章 夜入青云$/m);
  });

  test('空的规划字段不写出来', () => {
    const bare = plotFile.renderPlotFile({ ...plot, role: '', characters: [], targetWords: undefined, writtenFrom: '' });
    assert.ok(!/^role:/m.test(bare) && !/^characters:/m.test(bare) && !/^writtenFrom:/m.test(bare), bare);
  });

  test('空小节写出占位，读回来是空串', () => {
    const empty = plotFile.renderPlotFile({ ...plot, sections: plotFile.emptyPlotSections() });
    assert.match(empty, /（待补充）/);
    assert.equal(plotFile.parsePlotFile(empty, 'x/001.md').sections.关键事件, '');
  });

  test('status: done 被读出', () => {
    assert.equal(plotFile.parsePlotFile(plotFile.renderPlotFile({ ...plot, done: true }), 'x/012.md').done, true);
  });
});

describe('plotFile.ts · 排过没有 / 容错', () => {
  test('只看「关键事件」', () => {
    const empty = plotFile.emptyPlotSections();
    assert.equal(plotFile.isPlotFilled(empty), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 本章目的: '有目的', 章末钩子: '有钩子' }), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 关键事件: '有事件' }), true);
  });

  test('占位文字不算内容', () => {
    assert.equal(plotFile.isPlotFilled({ ...plotFile.emptyPlotSections(), 关键事件: '（待补充）' }), false);
  });

  // 老工程里的四节细纲一个字节都不动，读进来如实说「没排过」，不崩（第 1 条）。
  test('老四节细纲读进来三节全空、不抛', () => {
    const old = '---\nplot: 3\ntitle: 夜访\narc: 第一卷\n---\n\n## 目标\n\n甲\n\n## 剧情脉络\n\n乙\n';
    const p = plotFile.parsePlotFile(old, '.novelforge/plots/003-夜访.md');
    assert.equal(p.no, 3);
    assert.equal(p.title, '夜访');
    assert.equal(plotFile.isPlotFilled(p.sections), false);
  });

  test('无 frontmatter、畸形 frontmatter、大白话、空文件都不抛', () => {
    for (const t of ['## 关键事件\n\n甲', '---\n: :\n---\n', '就一句大白话', '']) {
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

  test('characters 写成顿号分隔的一行也拆开', () => {
    assert.deepEqual(plotFile.parsePlotFile('---\ncharacters: 林昭、沈青\n---\n', 'x/001.md').characters, ['林昭', '沈青']);
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
  const all = { config: true, premise: true, characters: true, world: true };
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

  test('架构缺哪件推哪件，按 配置 → 前提 → 角色 → 世界观 的顺序', () => {
    const order = [];
    let settings = { config: false, premise: false, characters: false, world: false };
    for (const doc of pipeline.SETTING_DOCS) {
      const f = book({ settings });
      assert.equal(pipeline.deriveBookStage(f), 'setting');
      const step = pipeline.deriveBookNextStep('setting', f);
      order.push(step.target.doc);
      settings = { ...settings, [doc]: true };
    }
    assert.deepEqual(order, ['config', 'premise', 'characters', 'world']);
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
    const none = { config: false, premise: false, characters: false, world: false };
    const config = pipeline.deriveBookNextStep('setting', book({ settings: none }));
    assert.deepEqual(config.calls, pipeline.CONFIG_CALLS);
    // 配置要先填一句话与规模，主按钮打开表单而不是直接发送。
    assert.equal(config.form, 'idea');

    const roster = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, characters: false } }));
    assert.deepEqual(roster.calls, { low: 2, high: 4, max: 16 });
    assert.equal(roster.form, undefined);

    const premise = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, premise: false } }));
    assert.deepEqual(premise.calls, pipeline.ONE_CALL);

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
    const f = book({ settings: { config: false, premise: false, characters: true, world: false }, nextChapterNo: 100 });
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
    // 三批各 1 次；上限 3n 按要写的章数加总；拆完排一次叙事线。
    assert.deepEqual(plan.calls, { low: 4, high: 4, max: 37 });
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

  // D17：定稿 = 摘要 + 出场角色的当前状态；七期再加一次判叙事线。出场的人都没建卡、
  // 也没有还没收的线时只有摘要那一次。
  test('定稿第 N 章报「预计 1–3 次调用」，并说清三次各做什么', () => {
    const step = pipeline.deriveNextStep('finalize', { no: 3, words: 900, ratio: 1, upstreamStale: false });
    assert.equal(step.label, '定稿第 3 章');
    assert.equal(step.projectAction, 'finalizeChapter');
    assert.deepEqual(step.calls, pipeline.FINALIZE_CALLS);
    assert.equal(
      pipeline.describeCalls(step.calls),
      '预计 1–3 次调用（摘要 1 次；本章出场的人有角色卡时更新角色状态 1 次；有还没收的叙事线时判一次本章推进了哪几条）'
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

  test('写完即定稿：每章再加定稿的 1–3 次', () => {
    const plan = pipeline.planWriteBatch({ ...base, mode: 'finalize', from: 1, to: 3 });
    assert.deepEqual(plan.calls, { low: 6, high: 18, max: 42 });
    assert.equal(plan.mode, 'finalize');
    assert.equal(plan.review, false);
  });

  // 五期补遗 §4：审稿一章 1 次、最多 3 次，与定稿各算各的。
  test('写完即审稿：每章再加审稿的 1 次（最多 3 次）；与定稿叠加', () => {
    const plan = pipeline.planWriteBatch({ ...base, review: true, from: 1, to: 3 });
    assert.equal(plan.review, true);
    assert.deepEqual(plan.calls, { low: 6, high: 12, max: 42 });
    const both = pipeline.planWriteBatch({ ...base, mode: 'finalize', review: true, from: 1, to: 3 });
    assert.deepEqual(both.calls, { low: 9, high: 21, max: 51 });
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
    // 三批细纲各 1 次（上限 3n），每批拆完各排一次叙事线。
    assert.deepEqual(plan.calls, { low: writing.low + 6, high: writing.high + 6, max: writing.max + 15 + 3 + 3 + 3 });
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

  test('写完即定稿：全书摘要落后 10 章就在那一章定稿之后更新一次，各算 1 次；只写正文不更新', () => {
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
