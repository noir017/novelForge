/**
 * 续写的纯函数（generation/continuation.ts）：该不该续、续出来的那段怎么接。
 *
 * 判据移植自 AI-Novel-Writer 的 `shouldAutoContinue`；拼接移植自
 * `appendVisibleTextContinuation`。这里钉的是边界：
 *
 * - 被截断就续（哪怕字数够了）、不到八成就续、别的原因停了不续、没有目标不续、7 轮封顶；
 * - 续写把已写的最后几句复述一遍时，那一截要去掉（≥ 48 个非空白字符才算）；
 * - 整段一字不差地重复一遍的，去掉；界面话术（「未完待续」）去掉；正文一个字不碰。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('src/core/generation/continuation.ts');

describe('continuation · 该不该续', () => {
  const at = (over) => c.shouldContinue({ words: 1000, target: 3000, stop: 'end', rounds: 0, ...over });

  test('不到八成 → 续', () => {
    assert.equal(at({ words: 2399 }), true);
    assert.equal(c.lowerBound(3000), 2400);
  });

  test('到了八成、正常收尾 → 不续', () => {
    assert.equal(at({ words: 2400 }), false);
  });

  test('被截断 → 续，哪怕字数够了（结尾停在半句上）', () => {
    assert.equal(at({ words: 3500, stop: 'maxTokens' }), true);
  });

  test('别的原因停了（内容审查一类）→ 不续', () => {
    assert.equal(at({ words: 100, stop: 'other' }), false);
  });

  test('网关不报收尾原因 → 按字数判', () => {
    assert.equal(at({ words: 100, stop: undefined }), true);
    assert.equal(at({ words: 2800, stop: undefined }), false);
  });

  test('没有目标字数 → 不续（有字就算写够）', () => {
    assert.equal(at({ target: undefined, words: 10, stop: 'maxTokens' }), false);
  });

  test('7 轮封顶', () => {
    assert.equal(at({ rounds: 6 }), true);
    assert.equal(at({ rounds: 7 }), false);
  });
});

describe('continuation · 拼接', () => {
  const EXISTING = [
    '雪下到半夜才停。',
    '林昭把残令揣进怀里，沿着河堤往回走，脚下的冰壳一踩就碎。客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空。',
  ].join('\n\n');

  test('开头复述了已写末尾（≥48 字）→ 那一截去掉', () => {
    const addition =
      '沿着河堤往回走，脚下的冰壳一踩就碎。客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空。\n\n“李叔来过。”她说。';
    const { text, added } = c.joinContinuation(EXISTING, addition);
    assert.equal(added, '“李叔来过。”她说。');
    assert.equal(text, `${EXISTING}\n\n“李叔来过。”她说。`);
  });

  test('只重合了一小截（<48 字）→ 不动', () => {
    const addition = '手指停在半空。她把算盘推到一边。';
    assert.equal(c.stripOverlap(EXISTING, addition), addition);
  });

  test('整段一字不差地重复（≥40 字）→ 去掉；短段（如一句对白）重复不算', () => {
    const para = '林昭把残令揣进怀里，沿着河堤往回走，脚下的冰壳一踩就碎。客栈的灯还亮着，沈氏坐在柜台后面拨算盘，看见他进门，手指停在半空。';
    const addition = `“嗯。”\n\n${para}\n\n“嗯。”\n\n他坐下了。`;
    const { added } = c.joinContinuation('雪下到半夜才停。', `前言。\n\n${para}`);
    assert.ok(added.includes(para));
    const again = c.joinContinuation(EXISTING, addition);
    assert.equal(again.added, '“嗯。”\n\n“嗯。”\n\n他坐下了。');
  });

  test('界面话术去掉，正文不碰', () => {
    const { added } = c.joinContinuation('', '他走了。\n\n未完待续……\n\n\n\n点我继续生成后续内容\n她留下了。');
    assert.equal(added, '他走了。\n\n她留下了。');
  });

  test('已写为空 → 就是这一段', () => {
    assert.deepEqual(c.joinContinuation('', '第一句。'), { text: '第一句。', added: '第一句。' });
  });

  test('续写全是重复 → 新增为空', () => {
    const { added, text } = c.joinContinuation(EXISTING, EXISTING);
    assert.equal(added, '');
    assert.equal(text, EXISTING);
  });
});

describe('continuation · 带进提示词的已写末尾', () => {
  test('不长就原样；长了取最后 1600 字，开头对齐到段落', () => {
    assert.equal(c.continuationTail('短。'), '短。');
    const long = `${'甲'.repeat(300)}\n${'乙'.repeat(1500)}`;
    const tail = c.continuationTail(long);
    assert.ok(tail.startsWith('乙'), tail.slice(0, 5));
    assert.equal(tail.length, 1500);
  });

  test('字数连已有的一起算', () => {
    assert.equal(c.wordsOf('一二三', '四五'), 5);
  });
});
