/**
 * OpenAI 兼容 provider 的两段纯逻辑：消息转换与 tool_calls 分片累积。
 *
 * 分片累积那半边最容易做错——**按 `index` 累积，不是按 `id`**：`id` 只在
 * 第一片给，按 id 累积会让后续每一片各开一个空 id 的槽，参数拼不起来。
 * 坏 JSON 那条同样是硬约束：抛异常会炸掉整轮对话。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/openaiProvider · 消息转换', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  test('system / user 原样', () => {
    assert.deepEqual(
      m.toOpenAiMessages([
        { role: 'system', content: '你是作者' },
        { role: 'user', content: '续写' },
      ]),
      [
        { role: 'system', content: '你是作者' },
        { role: 'user', content: '续写' },
      ]
    );
  });

  test('assistant 无 toolCalls 时原样', () => {
    assert.deepEqual(m.toOpenAiMessages([{ role: 'assistant', content: '上一版' }]), [
      { role: 'assistant', content: '上一版' },
    ]);
  });

  test('assistant 带 toolCalls 转换成 tool_calls，空 content 给 null', () => {
    const out = m.toOpenAiMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' }],
      },
    ]);
    assert.deepEqual(out, [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } },
        ],
      },
    ]);
  });

  test('assistant 有文本又有 toolCalls 时 content 保留', () => {
    const out = m.toOpenAiMessages([
      {
        role: 'assistant',
        content: '我先读一下',
        toolCalls: [{ id: 'c1', name: 'read', args: {}, raw: '{}' }],
      },
    ]);
    assert.equal(out[0].content, '我先读一下');
  });

  test('tool 消息转换', () => {
    assert.deepEqual(
      m.toOpenAiMessages([{ role: 'tool', toolCallId: 'call_1', name: 'read', content: '正文…' }]),
      [{ role: 'tool', tool_call_id: 'call_1', content: '正文…' }]
    );
  });
});

describe('llm/openaiProvider · tool_calls 分片累积', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  test('单个工具调用分三片到达，id 只在第一片给', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }],
      [{ index: 0, function: { arguments: 'th":"pl' } }],
      [{ index: 0, function: { arguments: 'ots/001.md"}' } }],
    ]);
    assert.deepEqual(calls, [
      { id: 'call_1', name: 'read', args: { path: 'plots/001.md' }, raw: '{"path":"plots/001.md"}' },
    ]);
  });

  test('两个并行工具调用交错到达，各自拼对不串味', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'c0', function: { name: 'read', arguments: '{"path":"' } }],
      [{ index: 1, id: 'c1', function: { name: 'search', arguments: '{"q":"' } }],
      [{ index: 0, function: { arguments: 'a.md"}' } }],
      [{ index: 1, function: { arguments: '北境"}' } }],
    ]);
    assert.deepEqual(calls, [
      { id: 'c0', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' },
      { id: 'c1', name: 'search', args: { q: '北境' }, raw: '{"q":"北境"}' },
    ]);
  });

  test('同一片里带多个 index 也分得开', () => {
    const calls = m.accumulateToolCalls([
      [
        { index: 0, id: 'c0', function: { name: 'read', arguments: '{}' } },
        { index: 1, id: 'c1', function: { name: 'list', arguments: '{}' } },
      ],
    ]);
    assert.deepEqual(
      calls.map((c) => c.name),
      ['read', 'list']
    );
  });

  test('arguments 是坏 JSON：args 为空对象，raw 保留原文，不抛', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'c0', function: { name: 'read', arguments: '{"path":' } }],
    ]);
    assert.deepEqual(calls, [{ id: 'c0', name: 'read', args: {}, raw: '{"path":' }]);
  });

  test('arguments 缺席时按空对象处理', () => {
    const calls = m.accumulateToolCalls([[{ index: 0, id: 'c0', function: { name: 'now' } }]]);
    assert.deepEqual(calls, [{ id: 'c0', name: 'now', args: {}, raw: '' }]);
  });

  test('arguments 解析出非对象（数组 / 字符串）时也退成空对象', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'c0', function: { name: 'read', arguments: '[1,2]' } }],
    ]);
    assert.deepEqual(calls, [{ id: 'c0', name: 'read', args: {}, raw: '[1,2]' }]);
  });

  test('没有 tool_calls 时产出空数组', () => {
    assert.deepEqual(m.accumulateToolCalls([]), []);
  });

  test('按 index 升序产出，不按到达顺序', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }],
      [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }],
    ]);
    assert.deepEqual(
      calls.map((c) => c.name),
      ['a', 'b']
    );
  });
});
