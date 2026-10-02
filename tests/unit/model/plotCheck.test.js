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
    assert.equal(m.describeConflict(r.conflicts[0]), '细纲「钱执事在惊恐中毙命」与第 10 章的定稿事实「钱执事已被大阵吞噬，尸骨无存」矛盾：他第 10 章已经死了');
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
});
