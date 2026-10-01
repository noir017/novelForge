/**
 * 审稿报告（五期）：引文要找得到、目标逐项核对、只把勾选的交给修稿。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 改了标点、并了空格的引文照样认 | 模型抄原文时改标点是常态（⚑ 上游只容忍多一对引号） |
 * | 太短的引文不认 | 两三个字到处都能命中，证明不了什么 |
 * | 定位映射回原文的位置 | 点引文要在编辑器里选中那一句 |
 * | 普通问题的引文找不到就丢 | 没有原文撑着的问题多半是编的（⚑ 上游不校验） |
 * | 目标任何一句引文找不到 → 整项待核实 | 上游同一口径 |
 * | 「未完成」没有证据 → 待核实 | 「没写到」只能是待核实（总计划 §5） |
 * | 漏项、重复、认不出的 id → 覆盖不完整 | 完整不等于全部完成，但不完整要说出来 |
 * | 章末钩子单列一项 | D3 里钩子必填 |
 * | 清单只有勾选项；勾了待核实要带边界 | 作者没勾的不该出现在模型眼前 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const r = loadModule('src/core/model/review.ts');

const TEXT = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  '“你明天就走？”她问。林昭点了点头，说：“天一亮就走。”',
].join('\n\n');

const CTX = { text: TEXT, chapterNo: 2, chapterTitle: '客栈', chapterRelPath: 'chapters/002-客栈.md', chapterHash: 'h' };

describe('review.ts · 目标冻结', () => {
  test('按换行与分号切，去掉列表记号；章末钩子单列最后一项', () => {
    const goals = r.freezeGoals('- 林昭回到客栈；沈氏收下残令\n2. 林昭决定北上', '门外有人敲了三下');
    assert.deepEqual(
      goals.map((g) => [g.id, g.kind, g.text]),
      [
        ['g1', 'event', '林昭回到客栈'],
        ['g2', 'event', '沈氏收下残令'],
        ['g3', 'event', '林昭决定北上'],
        ['g4', 'hook', '门外有人敲了三下'],
      ]
    );
  });

  test('一整段写成的关键事件就是一项，不按句号切', () => {
    const goals = r.freezeGoals('林昭回到客栈。沈氏收下残令。', '');
    assert.equal(goals.length, 1);
    assert.equal(goals[0].text, '林昭回到客栈。沈氏收下残令。');
  });

  test('占位与空的不算', () => {
    assert.deepEqual(r.freezeGoals('（待补充）', '（待补充）'), []);
  });

  test('交给模型的清单里钩子带说法', () => {
    const json = JSON.parse(r.frozenGoalsJson(r.freezeGoals('甲', '乙')));
    assert.deepEqual(json, [{ id: 'g1', text: '甲' }, { id: 'g2', text: '章末钩子：乙' }]);
  });
});

describe('review.ts · 引文', () => {
  const index = r.indexText(TEXT);

  test('逐字的引文找得到', () => {
    assert.equal(r.quoteFound(index, '她把那块残令收进了袖中。'), true);
  });

  test('改了标点、并了空格、全角半角不同都照样认', () => {
    assert.equal(r.quoteFound(index, '她把那块残令，收进了袖中'), true);
    assert.equal(r.quoteFound(index, '"你明天就走?"她问'), true);
    assert.equal(r.quoteFound(index, '林昭推开 客栈的门'), true);
  });

  test('改了字、拼接两句都认不出', () => {
    assert.equal(r.quoteFound(index, '她把那枚残令收进了袖中'), false);
    assert.equal(r.quoteFound(index, '雨下了一整夜。她把那块残令收进了袖中'), false);
  });

  test('归一后不到 4 个字的不认', () => {
    assert.equal(r.quoteFound(index, '林昭，'), false);
    assert.equal(r.quoteFound(index, '沈氏在柜'), true);
  });

  test('定位映射回原文：从引文第一个字到最后一个字', () => {
    const at = r.locateQuote(TEXT, '你明天就走?”她问');
    assert.ok(at);
    assert.equal(TEXT.slice(at.start, at.end), '你明天就走？”她问');
  });

  test('找不到时 undefined', () => {
    assert.equal(r.locateQuote(TEXT, '根本没有这一句话'), undefined);
  });
});

describe('review.ts · 解析', () => {
  test('认代码围栏与前后多余的话', () => {
    const p = r.parseReviewJson('好的，审稿结果如下：\n```json\n{"summary":"还行","items":[{"category":"角色状态","severity":"pass","description":"一致"}]}\n```');
    assert.equal(p.ok, true);
    assert.equal(p.value.summary, '还行');
    assert.equal(p.value.items[0].severity, 'pass');
  });

  test('严重度的近义写法照收，认不出的那一条跳过并记一句', () => {
    const p = r.parseReviewJson(JSON.stringify({
      summary: '',
      items: [
        { category: 'a', severity: 'critical', quote: 'x', description: 'd1' },
        { category: 'b', severity: 'minor', quote: 'y', description: 'd2' },
        { category: 'c', severity: '??', quote: 'z', description: 'd3' },
      ],
    }));
    assert.deepEqual(p.value.items.map((i) => i.severity), ['error', 'warning']);
    assert.match(p.value.warnings.join(), /1 条认不出/);
  });

  test('超长的截断并说明', () => {
    const p = r.parseReviewJson(JSON.stringify({ summary: '长'.repeat(200), items: [] }));
    assert.equal(Array.from(p.value.summary).length, r.REVIEW_SUMMARY_MAX);
    assert.match(p.value.warnings.join(), /截断/);
  });

  test('不是 JSON、没有 items 数组都不合格', () => {
    assert.equal(r.parseReviewJson('这一章写得很好。').ok, false);
    assert.equal(r.parseReviewJson('{"summary":"x"}').ok, false);
  });

  test('goalReviews 缺席与空数组不同', () => {
    assert.equal(r.parseReviewJson('{"items":[]}').value.goalReviews, undefined);
    assert.deepEqual(r.parseReviewJson('{"items":[],"goalReviews":[]}').value.goalReviews, []);
  });
});

function raw(items, goalReviews) {
  return { summary: '总评', items, ...(goalReviews ? { goalReviews } : {}), warnings: [] };
}

describe('review.ts · 校验', () => {
  const goals = r.freezeGoals('沈氏收下残令；林昭决定北上', '门外有人敲门');

  test('引文找得到的问题留下，找不到的丢掉并说明', () => {
    const { report, notes } = r.verifyReview(
      raw([
        { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已经交出去了' },
        { category: '角色状态', severity: 'warning', quote: '林昭拔出长剑指着她', description: '编出来的一句' },
        { category: '剧情连贯性', severity: 'warning', quote: '', description: '没给引文' },
        { category: '前后章节串联', severity: 'pass', quote: '', description: '接得上' },
      ]),
      { ...CTX, goals: [] }
    );
    assert.deepEqual(report.issues.map((i) => [i.id, i.category]), [['i1', '剧情合理性']]);
    assert.deepEqual(report.passes.map((p) => p.category), ['前后章节串联']);
    assert.deepEqual(report.dropped.map((d) => d.why), ['引文在正文里找不到', '没有给引文']);
    assert.match(notes.join('\n'), /丢掉 2 条/);
  });

  test('目标：完成且引文找得到的留下', () => {
    const { report } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: '收下了', quotes: ['她把那块残令收进了袖中'] },
        { id: 'g2', status: 'completed', description: '天亮就走', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: '没写到敲门', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.deepEqual(report.goals.map((g) => g.status), ['completed', 'completed', 'unknown']);
    assert.equal(report.goals[2].judgment, '没写到敲门');
    assert.equal(report.coverage, 'complete');
  });

  test('目标：任何一句引文找不到，整项降成待核实，其余几句也救不回', () => {
    const { report, notes } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: '收下了', quotes: ['她把那块残令收进了袖中', '她当场烧了残令'] },
        { id: 'g2', status: 'completed', description: 'x', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: 'y', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.equal(report.goals[0].status, 'unknown');
    assert.deepEqual(report.goals[0].quotes, []);
    assert.equal(report.goals[0].judgment, r.GOAL_UNVERIFIED);
    assert.match(notes.join(), /1 项目标/);
  });

  test('目标：「未完成」没有证据 → 待核实（没写到不等于没发生）', () => {
    const { report } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那块残令收进了袖中'] },
        { id: 'g2', status: 'unmet', description: '正文里没写他决定北上', quotes: [] },
        { id: 'g3', status: 'unknown', description: 'y', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.equal(report.goals[1].status, 'unknown');
  });

  test('目标：漏项、重复、认不出的 id → 那几项待核实，覆盖不完整', () => {
    const { report, notes } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那块残令收进了袖中'] },
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那块残令收进了袖中'] },
        { id: 'g9', status: 'completed', description: 'x', quotes: ['天一亮就走'] },
      ]),
      { ...CTX, goals }
    );
    assert.deepEqual(report.goals.map((g) => g.status), ['unknown', 'unknown', 'unknown']);
    assert.equal(report.coverage, 'partial');
    assert.match(notes.join(), /目标核对不完整/);
  });

  test('模型根本没交目标核对：整张清单待核实', () => {
    const { report } = r.verifyReview(raw([]), { ...CTX, goals });
    assert.equal(report.coverage, 'partial');
    assert.ok(report.goals.every((g) => g.status === 'unknown'));
  });

  test('细纲没有关键事件：覆盖记 none', () => {
    const { report, notes } = r.verifyReview(raw([]), { ...CTX, goals: [] });
    assert.equal(report.coverage, 'none');
    assert.match(notes.join(), /没有可核对的关键事件/);
  });

  test('超过 10 条的不收', () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ category: `c${k}`, severity: 'pass', quote: '', description: 'ok' }));
    const { report, notes } = r.verifyReview(raw(items), { ...CTX, goals: [] });
    assert.equal(report.passes.length, 10);
    assert.match(notes.join(), /后面 2 条没有收/);
  });
});

describe('review.ts · 勾选与清单', () => {
  const goals = r.freezeGoals('沈氏收下残令；林昭决定北上', '门外有人敲门');
  const { report } = r.verifyReview(
    raw(
      [
        { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令前文已交出' },
        { category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '他左臂有伤却点头如常' },
      ],
      [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那块残令收进了袖中'] },
        { id: 'g2', status: 'unmet', description: '他说的是明天走，细纲要他今晚就走', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: '没写到敲门', quotes: [] },
      ]
    ),
    { ...CTX, goals }
  );

  test('默认勾：全部问题 + 未完成的目标；待核实不勾', () => {
    assert.deepEqual(r.defaultPicks(report), ['i1', 'i2', 'g2']);
    assert.deepEqual(r.pickableIds(report), ['i1', 'i2', 'g2', 'g3']);
  });

  test('清单只有勾选项，带原文', () => {
    const brief = r.renderRevisionBrief(report, ['i1', 'g2']);
    assert.match(brief, /【已确认纳入本次修稿的审稿项】/);
    assert.match(brief, /1\. \[剧情合理性 \/ 严重\] 残令前文已交出\n   相关原文：她把那块残令收进了袖中/);
    assert.match(brief, /2\. \[本章目标 \/ 未完成\] 关键事件：林昭决定北上/);
    assert.doesNotMatch(brief, /点头如常/);
    assert.doesNotMatch(brief, /待核实项处理边界/);
  });

  test('勾了待核实：前面带边界那一句', () => {
    const brief = r.renderRevisionBrief(report, ['g3']);
    assert.match(brief, /^【待核实项处理边界】/);
    assert.match(brief, /章末钩子：门外有人敲门/);
  });

  test('一条都没勾：空串；已完成的目标勾了也不算', () => {
    assert.equal(r.renderRevisionBrief(report, []), '');
    assert.equal(r.renderRevisionBrief(report, ['g1']), '');
  });

  test('正文改过之后：引文不在了的那条作废，目标不受影响', () => {
    const changed = TEXT.replace('她把那块残令收进了袖中。', '她把残令推回给他。');
    const { kept, lost } = r.relocatePicks(report, ['i1', 'i2', 'g2', 'g1'], changed);
    assert.deepEqual(kept, ['i2', 'g2']);
    assert.deepEqual(lost.map((i) => i.id), ['i1']);
  });

  test('给人读的一份与一句话概括', () => {
    const md = r.renderReport(report);
    assert.match(md, /^# 第 2 章《客栈》审稿/);
    assert.match(md, /## 严重（1）/);
    assert.match(md, /未完成｜关键事件：林昭决定北上/);
    assert.equal(r.describeReport(report), '1 严重 · 1 建议 · 目标 1/3 已完成（1 项待核实）');
  });

  test('用户气泡上的那几行', () => {
    assert.deepEqual(r.describePicks(report, ['i2', 'g3']), ['[建议] 角色状态：他左臂有伤却点头如常', '[待核实] 章末钩子：门外有人敲门']);
  });
});

// 五期补遗 §3：报告卡的编辑模式。
describe('review.ts · 编辑报告', () => {
  const base = {
    chapterNo: 2,
    chapterTitle: '客栈',
    chapterRelPath: 'chapters/002-客栈.md',
    chapterHash: 'h',
    summary: '',
    issues: [
      { id: 'i1', category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '残令早交出去了' },
      { id: 'i2', category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '左臂有伤' },
    ],
    passes: [],
    goals: [{ id: 'g1', kind: 'event', text: '林昭回到客栈', status: 'unmet', judgment: '判断', quotes: ['林昭推开客栈的门'] }],
    coverage: 'complete',
    dropped: [],
  };
  const plain = (x) => JSON.parse(JSON.stringify(x));

  test('模型给的：漏了就原样留着；改过的标 edited；新加的接着编号 a1、a2，分类缺省「作者补充」', () => {
    const { report, notes } = r.applyReviewEdits(
      base,
      [
        { id: 'i2', category: '角色状态', severity: 'error', description: '左臂有伤，不该点头如常', quote: '林昭点了点头' },
        { category: '', severity: 'warning', description: '雨写得太长', quote: '雨下了一整夜' },
        { severity: 'error', category: '节奏', description: '结尾太急' },
      ],
      TEXT
    );
    assert.deepEqual(notes, []);
    assert.deepEqual(
      plain(report.issues).map((i) => [i.id, i.category, i.severity, i.origin ?? '', !!i.edited]),
      [
        ['i1', '剧情合理性', 'error', '', false],
        ['i2', '角色状态', 'error', '', true],
        ['a1', '作者补充', 'warning', 'author', false],
        ['a2', '节奏', 'error', 'author', false],
      ]
    );
    assert.equal(report.issues[3].quote, '');
    assert.deepEqual(report.goals.map((g) => g.id), ['g1']);
  });

  test('引文：作者加的找不到就清空，模型条目改出来的找不到就保留原句；都说明', () => {
    const { report, notes } = r.applyReviewEdits(
      base,
      [
        { id: 'i1', category: '剧情合理性', severity: 'error', description: '残令早交出去了', quote: '正文里没有这一句话' },
        { category: '', severity: 'warning', description: '一条新的', quote: '也没有这一句' },
      ],
      TEXT
    );
    assert.equal(report.issues[0].quote, '她把那块残令收进了袖中');
    assert.equal(report.issues[0].edited, undefined);
    assert.equal(report.issues[2].quote, '');
    assert.equal(notes.length, 2);
    assert.match(notes[0], /改过的引文在正文里找不到，保留原来那一句/);
    assert.match(notes[1], /引文在正文里找不到，按没有引文处理/);
  });

  test('说明空的：模型条目保留原句，新加的整条不收；作者加的漏了就是删掉', () => {
    const once = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '先加一条' }], TEXT).report;
    const { report, notes } = r.applyReviewEdits(
      once,
      [
        { id: 'i1', category: '剧情合理性', severity: 'error', description: '  ', quote: '她把那块残令收进了袖中' },
        { category: '', severity: 'warning', description: '' },
      ],
      TEXT
    );
    assert.equal(report.issues[0].description, '残令早交出去了');
    assert.deepEqual(report.issues.map((i) => i.id), ['i1', 'i2']);
    assert.ok(notes.some((n) => /说明不能是空的/.test(n)));
    assert.ok(notes.some((n) => /1 条新加的问题没写说明/.test(n)));
    assert.ok(notes.some((n) => /删掉了 1 条作者加的问题/.test(n)));
  });

  test('作者加的：缺省勾上；修稿清单里没有引文就不写「相关原文」，分类不是缺省的标「作者补充」', () => {
    const { report } = r.applyReviewEdits(
      base,
      [
        { category: '', severity: 'warning', description: '雨写得太长' },
        { category: '节奏', severity: 'error', description: '结尾太急' },
      ],
      TEXT
    );
    assert.deepEqual(r.defaultPicks(report), ['i1', 'i2', 'a1', 'a2', 'g1']);
    const brief = r.renderRevisionBrief(report, ['a1', 'a2']);
    assert.match(brief, /1\. \[作者补充 \/ 建议\] 雨写得太长\n2\. \[节奏 \/ 严重 · 作者补充\] 结尾太急/);
    assert.doesNotMatch(brief, /相关原文/);
    assert.match(r.renderReport(report), /- \[作者补充\] 雨写得太长（作者补充）/);
  });

  test('会话文件读回来：作者加的没有引文也认；模型条目没有引文就不认', () => {
    const { report } = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '雨写得太长' }], TEXT);
    const back = r.normalizeReport(plain({ ...report, issues: [...report.issues, { id: 'i9', category: 'x', severity: 'error', quote: '', description: '坏的' }] }));
    assert.deepEqual(back.issues.map((i) => i.id), ['i1', 'i2', 'a1']);
    assert.equal(back.issues[2].origin, 'author');
  });

  test('正文改过之后重新定位：没有引文的照旧交给模型', () => {
    const { report } = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '雨写得太长' }], TEXT);
    assert.deepEqual(r.relocatePicks(report, ['a1'], '完全换了一版正文。').kept, ['a1']);
  });
});
