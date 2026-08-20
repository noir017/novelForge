/**
 * 事件流的收集器：collectText / collect。
 *
 * 这一层是 13 个既有调用点与 provider 之间唯一的桥，所以三件事必须钉死：
 * reasoning 绝不混进正文、usage 按字段合并（同一次请求会回调多次）、
 * toolCall 原样收进数组。
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

  test('toolCall 收进数组并回调', async () => {
    const call = { id: 'c1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' };
    const seen = [];
    const r = await c.collect(streamOf([{ type: 'toolCall', call }]), {
      onToolCall: (x) => seen.push(x.name),
    });
    assert.deepEqual(r.toolCalls, [call]);
    assert.deepEqual(seen, ['read']);
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
    const call = { id: 'c1', name: 'read', args: {}, raw: '{}' };
    const r = await c.collect(
      streamOf([
        { type: 'text', text: '正' },
        { type: 'reasoning', text: '想' },
        { type: 'toolCall', call },
        { type: 'usage', usage: { inputTokens: 5 } },
        { type: 'text', text: '文' },
      ])
    );
    assert.deepEqual(
      { text: r.text, reasoning: r.reasoning, calls: r.toolCalls.length, usage: r.usage },
      { text: '正文', reasoning: '想', calls: 1, usage: { inputTokens: 5 } }
    );
  });

  test('空流产出空字符串与空 usage', async () => {
    const r = await c.collect(streamOf([]));
    assert.deepEqual(r, { text: '', reasoning: '', toolCalls: [], usage: {}, traces: [] });
  });

  // 思考凭据要按到达顺序原样收着：下一轮请求把它交回去，模型才接得上
  // 「上一步为什么调那个工具」。它不是给界面看的，所以不进 reasoning。
  test('reasoningTrace 按顺序收进 traces，不混进 reasoning', async () => {
    const r = await c.collect(
      streamOf([
        { type: 'reasoning', text: '想' },
        { type: 'reasoningTrace', trace: { kind: 'anthropic', payload: { signature: 'a' } } },
        { type: 'reasoningTrace', trace: { kind: 'anthropic', payload: { signature: 'b' } } },
      ])
    );
    assert.equal(r.reasoning, '想');
    assert.deepEqual(
      r.traces.map((t) => t.payload.signature),
      ['a', 'b']
    );
  });

  test('mergeUsage 就地按字段合并，undefined 不覆盖已有值', () => {
    const target = { inputTokens: 100, outputTokens: 7 };
    c.mergeUsage(target, { outputTokens: 20 });
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
    c.mergeUsage(target, {});
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
  });
});
