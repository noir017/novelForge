/**
 * 写前冲突检查（model/plotCheck.ts）：选哪些事实、校验模型交回来的冲突。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 提到计划出场的人的事实不论多早都带；其余只带近 12 章 | 钱执事第 10 章死、第 26 章又被排出场 |
 * | 两句原文都对得上才算 | 这一步会让批量停下：拿编出来的矛盾拦作者比漏掉一条更糟 |
 * | 章号以对上的那一条为准 | 模型常写错章号 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/plotCheck.ts');

describe('plotCheck · 选事实', () => {
  const chapters = Array.from({ length: 30 }, (_, i) => ({
    no: i + 1,
    statements: i + 1 === 10 ? ['钱执事已被大阵吞噬，尸骨无存', '陆沉夺得聚灵囊'] : [`第${i + 1}章的事`],
  }));

  test('提到本章计划出场的人的事实不论多早都带；其余只带最近 12 章；按章号升序', () => {
    const picked = m.selectCheckFacts(chapters, ['钱执事', '陆沉']);
    const nos = picked.map((c) => c.no);
    assert.equal(nos[0], 10);
    assert.deepEqual(nos.slice(1), Array.from({ length: 12 }, (_, i) => 19 + i));
    assert.deepEqual(picked[0].statements, ['钱执事已被大阵吞噬，尸骨无存', '陆沉夺得聚灵囊']);
  });

  test('早于近 12 章、又没提到这几个人的，不带', () => {
    const picked = m.selectCheckFacts(chapters, ['沈秋']);
    assert.ok(!picked.some((c) => c.no === 10));
  });

  test('近几章、一共几字按传进来的上限（上下文详细度）', () => {
    const nos = m.selectCheckFacts(chapters, ['沈秋'], { recent: 6 }).map((c) => c.no);
    assert.deepEqual(nos, Array.from({ length: 6 }, (_, i) => 25 + i));
    const long = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, statements: ['字'.repeat(400)] }));
    const total = m.selectCheckFacts(long, [], { chars: 1500 }).reduce((n, c) => n + c.statements.join('').length, 0);
    assert.ok(total <= 1500 && total > 0, String(total));
  });

  test('一共不超过预算', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, statements: ['字'.repeat(400)] }));
    const total = m.selectCheckFacts(long, []).reduce((n, c) => n + c.statements.join('').length, 0);
    assert.ok(total <= m.PLOT_CHECK_BUDGET_CHARS, String(total));
  });
});

describe('plotCheck · 校验冲突', () => {
  const facts = [{ no: 10, statements: ['钱执事已被大阵吞噬，尸骨无存'] }];
  const plot = '陆沉潜入钱执事居所，以剧毒灵液偷袭，钱执事在惊恐中毙命。';

  test('两句都对得上：收下，章号以对上的那一条为准', () => {
    const r = m.verifyConflicts([{ plot: '钱执事在惊恐中毙命', fact: '钱执事已被大阵吞噬', chapter: 3, why: '他第 10 章已经死了' }], plot, facts);
    assert.equal(r.dropped, 0);
    assert.deepEqual(r.conflicts, [{ plot: '钱执事在惊恐中毙命', fact: '钱执事已被大阵吞噬，尸骨无存', chapter: 10, why: '他第 10 章已经死了' }]);
    assert.equal(m.describeConflict(r.conflicts[0]), '细纲「钱执事在惊恐中毙命」与第 10 章同步下来的事实「钱执事已被大阵吞噬，尸骨无存」矛盾：他第 10 章已经死了');
  });

  test('标点、空白不同照样认', () => {
    const r = m.verifyConflicts([{ plot: '钱执事 在惊恐中毙命！', fact: '钱执事已被大阵吞噬,尸骨无存', chapter: 10, why: '' }], plot, facts);
    assert.equal(r.conflicts.length, 1);
  });

  test('细纲里找不到、事实对不上、引文太短、字段缺了：一律丢掉', () => {
    const r = m.verifyConflicts(
      [
        { plot: '细纲里没有这句话', fact: '钱执事已被大阵吞噬', chapter: 10, why: '' },
        { plot: '钱执事在惊恐中毙命', fact: '钱执事还活着', chapter: 10, why: '' },
        { plot: '毙命', fact: '钱执事已被大阵吞噬', chapter: 10, why: '' },
        { why: '只有理由' },
        '一句话',
      ],
      plot,
      facts
    );
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.dropped, 5);
  });

  test('提示词与用户消息', () => {
    assert.match(m.PLOT_CHECK_SYSTEM, /硬矛盾/);
    const user = m.plotCheckUser({ no: 26, title: '执事之死', text: plot }, facts);
    assert.match(user, /【第10章】\n- 钱执事已被大阵吞噬，尸骨无存/);
    assert.match(user, /# 本章细纲（第26章 执事之死）/);
  });

  // 2026-10-25 起改成转写：比对的模型按格式写，JSON 由转写模型照抄（合同在 PLOT_CHECK_JSON_CONTRACT）。
  test('写的那一次不要 JSON：按格式写，两句原句用「」括起来，最多 5 处', () => {
    assert.doesNotMatch(m.PLOT_CHECK_SYSTEM, /\{"conflicts"|只输出 JSON/);
    assert.match(m.PLOT_CHECK_SYSTEM, /不写 JSON/);
    assert.match(m.PLOT_CHECK_SYSTEM, /没有矛盾就只写「无矛盾」/);
    assert.match(m.PLOT_CHECK_SYSTEM, /两句原句都用「」括起来，必须逐字摘自下面给的原文/);
    assert.match(m.PLOT_CHECK_SYSTEM, new RegExp(`最多 ${m.PLOT_CHECK_MAX} 处`));
    assert.doesNotMatch(m.plotCheckUser({ no: 26, title: '', text: plot }, facts), /JSON/);
    assert.match(m.PLOT_CHECK_JSON_CONTRACT, /\{"conflicts":\[/);
  });

  test('只写了「无矛盾」不必转写；连矛盾、细纲、事实都不提的不像比对结果', () => {
    for (const s of ['无矛盾', '无矛盾。', '**无矛盾**', '没有硬矛盾', '无']) {
      assert.equal(m.saysNoConflict(s), true, s);
    }
    assert.equal(m.saysNoConflict('### 矛盾 1\n细纲：「钱执事在惊恐中毙命」'), false);
    assert.equal(m.saysNoConflict('无矛盾，但细纲里「钱执事在惊恐中毙命」要留意'), false);
    assert.equal(m.looksLikePlotCheck('### 矛盾 1\n细纲：「钱执事在惊恐中毙命」'), true);
    assert.equal(m.looksLikePlotCheck('我不太确定。'), false);
  });
});
