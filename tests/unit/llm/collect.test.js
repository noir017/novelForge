/**
 * 事件流的收集器：collectText / collect。
 *
 * 这一层是 13 个既有调用点与 provider 之间唯一的桥，所以三件事必须钉死：
 * reasoning 绝不混进正文、usage 按字段合并（同一次请求会回调多次）、
 * 收尾原因原样交出（上游没说就是 undefined）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

async function* streamOf(events) {
  for (const e of events) yield e;
}

describe('llm/collect', () => {
  let c;
  before(() => {
    c = loadModule('src/core/llm/collect.ts');
  });

  test('collectText 只拼 text 事件', async () => {
    const text = await c.collectText(
      streamOf([
        { type: 'text', text: '雨下了' },
        { type: 'reasoning', text: '（先想想）' },
        { type: 'text', text: '三天。' },
      ])
    );
    assert.equal(text, '雨下了三天。');
  });

  test('reasoning 不混进正文，单独回调', async () => {
    const seen = [];
    await c.collectText(
      streamOf([
        { type: 'reasoning', text: 'a' },
        { type: 'text', text: 'X' },
        { type: 'reasoning', text: 'b' },
      ]),
      { onReasoning: (d, full) => seen.push([d, full]) }
    );
    assert.deepEqual(seen, [
      ['a', 'a'],
      ['b', 'ab'],
    ]);
  });

  test('usage 按字段合并，缺席字段保留', async () => {
    const r = await c.collect(
      streamOf([
        { type: 'usage', usage: { inputTokens: 100 } },
        { type: 'text', text: 'x' },
        { type: 'usage', usage: { outputTokens: 20 } },
      ])
    );
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('usage 每条都回调，不等收全', async () => {
    const seen = [];
    await c.collect(
      streamOf([
        { type: 'usage', usage: { inputTokens: 100 } },
        { type: 'usage', usage: { outputTokens: 20 } },
      ]),
      { onUsage: (u) => seen.push(u) }
    );
    assert.deepEqual(seen, [{ inputTokens: 100 }, { outputTokens: 20 }]);
  });

  test('onDelta 收到增量与全量', async () => {
    const seen = [];
    await c.collectText(
      streamOf([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
      { onDelta: (d, full) => seen.push([d, full]) }
    );
    assert.deepEqual(seen, [
      ['a', 'a'],
      ['b', 'ab'],
    ]);
  });

  test('collect 同时给出四份产出', async () => {
    const r = await c.collect(
      streamOf([
        { type: 'text', text: '正' },
        { type: 'reasoning', text: '想' },
        { type: 'usage', usage: { inputTokens: 5 } },
        { type: 'text', text: '文' },
        { type: 'stop', reason: 'end' },
      ])
    );
    assert.deepEqual(r, { text: '正文', reasoning: '想', usage: { inputTokens: 5 }, stopReason: 'end' });
  });

  test('空流产出空字符串与空 usage', async () => {
    const r = await c.collect(streamOf([]));
    assert.deepEqual(r, {
      text: '',
      reasoning: '',
      usage: {},
      stopReason: undefined,
    });
  });

  test('收尾原因收进 stopReason', async () => {
    const r = await c.collect(
      streamOf([{ type: 'text', text: '写到一半' }, { type: 'stop', reason: 'maxTokens' }])
    );
    assert.equal(r.stopReason, 'maxTokens');
  });

  // undefined 有它自己的意思：「上游没说」。补一个默认值等于替它编一句话，而
  // 续写链会照着那句话决定回退还是往后接。
  test('上游没说时是 undefined，不补默认值', async () => {
    const r = await c.collect(streamOf([{ type: 'text', text: '好的。' }]));
    assert.equal(r.stopReason, undefined);
  });

  test('mergeUsage 就地按字段合并，undefined 不覆盖已有值', () => {
    const target = { inputTokens: 100, outputTokens: 7 };
    c.mergeUsage(target, { outputTokens: 20 });
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
    c.mergeUsage(target, {});
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
  });
});
