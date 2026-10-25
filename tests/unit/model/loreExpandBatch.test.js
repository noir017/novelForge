/**
 * 完善设定三期的两个纯函数（model/pipeline.ts）：批量展开的调用次数与写前提醒那一句。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 批量展开每条 2 次、最多 4 次（2026-10-25 起写完转写），n 条乘 n；原因写明「重转一次、重写一次，两样不叠加」 | 第 4 条：工程页菜单、确认框报的是同一个数 |
 * | 写前提醒：本章 / 区间里两种说法，名字最多列 5 个、多了写总数；区间里那句写明不拦 | 工作台、批量写章弹窗与确认框同一句（零调用、不拦） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');

describe('批量展开的调用次数', () => {
  test('每条 2 次（写 1、转写 1）、最多 4 次', () => {
    const { low, high, max } = pipeline.LORE_EXPAND_BATCH_CALLS;
    assert.deepEqual([low, high, max], [2, 2, 4]);
  });

  test('n 条乘 n，原因照抄', () => {
    assert.equal(
      pipeline.describeCalls(pipeline.loreExpandCalls(3)),
      '预计 6 次调用，最多 12 次（写 1 次、转写 1 次；转写不合格重转 1 次，或者整理不出来时这一条重写、再转写 1 次，两样不叠加）'
    );
  });
});

describe('写前提醒那一句', () => {
  test('本章', () => {
    assert.equal(
      pipeline.describeThinLore('本章', ['天机阁', '九层楼']),
      '本章要用的 天机阁、九层楼 还只有一句话，写之前可以先展开（在工程页「待完善」里右键「展开…」）。'
    );
  });

  test('区间里：写总数、写明不拦', () => {
    assert.equal(
      pipeline.describeThinLore('区间里', ['天机阁']),
      '区间里 1 条要用到的设定还只有一句话（天机阁），写之前可以先在工程页「待完善」里展开；不展开也照写。'
    );
  });

  test('名字最多列 5 个，多了写总数', () => {
    const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
    assert.ok(pipeline.describeThinLore('区间里', names).includes('（甲、乙、丙、丁、戊 等 7 条）'));
    assert.ok(pipeline.describeThinLore('本章', names).startsWith('本章要用的 甲、乙、丙、丁、戊 等 7 条 还只有一句话'));
  });
});
