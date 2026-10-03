/**
 * 删修饰的纯函数（model/trimProse.ts）：编号、读回、只许删的验收、八成保底。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 编号读回：越界、重复的丢，缺的就是没交回来 | 模型会漏段、多段、重复编号 |
 * | 新增的字按 LCS 算 | 只删不加是这一轮唯一的合同 |
 * | 加字、动对白、删太狠、改段尾都退回 | 一段改坏不连累整章，退回原文 |
 * | 删到八成以下从删得最多的段退回 | 不然主按钮转去推「接着写」，等于白删 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const tp = loadModule('src/core/model/trimProse.ts');
const han = (s) => (s.match(/[一-鿿]/g) ?? []).length;

describe('trimProse.ts · 编号与读回', () => {
  test('按空行切段、编号', () => {
    const paras = tp.trimParagraphs('甲。\n\n  乙。\r\n\r\n\n丙。');
    assert.deepEqual(paras, ['甲。', '乙。', '丙。']);
    assert.equal(tp.numberParagraphs(paras), '[1] 甲。\n\n[2] 乙。\n\n[3] 丙。');
  });

  test('读回：越界与重复的丢掉（取第一个），缺的不在表里', () => {
    const m = tp.parseNumbered('[1] 甲\n[3] 丙\n[3] 丙二\n[9] 越界\n说明文字', 3);
    assert.deepEqual([...m], [[1, '甲'], [3, '丙']]);
  });
});

describe('trimProse.ts · 只许删', () => {
  const before = '钱执事那肥硕的身躯带着一股浓重的灵草香气压了过来。';

  test('新增的字按最长公共子序列算', () => {
    assert.equal(tp.addedChars(before, '钱执事带着灵草香气压了过来。'), '');
    assert.equal(tp.addedChars('他走了。', '他慢慢走了。'), '慢慢');
  });

  test('只删：合格', () => {
    assert.equal(tp.trimProblem(before, '钱执事带着灵草香气压了过来。'), undefined);
  });

  test('补一两个字算合格，多了退回', () => {
    assert.equal(tp.trimProblem('他狠狠碾压下去。', '他碾了下去。'), undefined);
    assert.equal(tp.trimProblem(before, '钱执事走过来，一身药味。'), '加了原文没有的字');
  });

  test('对白一字不许动', () => {
    assert.equal(tp.trimProblem('他冷冷地说：“你这废物，磨蹭什么。”', '他说：“废物，磨蹭什么。”'), '动了对白');
    assert.equal(tp.trimProblem('他冷冷地说：“你这废物。”', '他说：“你这废物。”'), undefined);
  });

  test('删得太狠、删光、改了段尾都退回', () => {
    assert.equal(tp.trimProblem(before, '钱执事。'), '删得太多');
    assert.equal(tp.trimProblem(before, ''), '整段删光了');
    assert.equal(tp.trimProblem(before, '钱执事带着灵草香气压了过来'), '改了段尾');
  });
});

describe('trimProse.ts · 拼回正文', () => {
  const paras = ['甲乙丙丁戊己庚辛壬癸。', '子丑寅卯辰巳午未申酉。', '“这句对白不动。”'];

  test('逐段验收，不合格的退回原文，原因计数', () => {
    const edits = new Map([
      [1, '甲乙丙丁戊己。'],
      [2, '子丑寅卯辰巳午未申酉外加许多字。'],
    ]);
    const out = tp.applyTrim(paras, edits);
    assert.equal(out.text, ['甲乙丙丁戊己。', paras[1], paras[2]].join('\n\n'));
    assert.equal(out.changed, 1);
    assert.deepEqual([...out.rejected], [['加了原文没有的字', 1], ['没交回来', 1]]);
    assert.equal(out.restored, 0);
  });

  test('删到保底以下：从删得最多的段开始退回，够数就停', () => {
    const edits = new Map([
      [1, '甲乙丙丁戊。'],
      [2, '子丑寅卯辰巳午未。'],
      [3, paras[2]],
    ]);
    const full = han(paras.join(''));
    // 第 1 段删了 5 字，第 2 段删了 2 字：差 3 字够数，退回第 1 段就够。
    const out = tp.applyTrim(paras, edits, { floor: full - 3, countWords: han });
    assert.equal(out.restored, 1);
    assert.equal(out.text, [paras[0], '子丑寅卯辰巳午未。', paras[2]].join('\n\n'));
    assert.equal(out.changed, 1);
  });
});
