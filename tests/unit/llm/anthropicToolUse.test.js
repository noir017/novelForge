/**
 * Anthropic provider 的两段纯逻辑：消息转换与 tool_use 累积。
 *
 * 两条与 OpenAI 不同的硬约束：
 * 1. `tool_result` **不是独立 role**，要合并进一条 `user` 消息的 content 数组；
 * 2. 工具参数是 `input_json_delta` 逐字符拼出来的 JSON 串，只有
 *    `content_block_stop` 之后才完整。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/anthropicProvider · 消息转换', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
  });

  test('user / assistant 纯文本原样，content 仍是字符串', () => {
    assert.deepEqual(
      m.toAnthropicMessages([
        { role: 'user', content: '续写' },
        { role: 'assistant', content: '上一版' },
      ]),
      [
        { role: 'user', content: '续写' },
        { role: 'assistant', content: '上一版' },
      ]
    );
  });

  test('相邻同角色消息被合并', () => {
    assert.deepEqual(
      m.toAnthropicMessages([
        { role: 'user', content: '第一段' },
        { role: 'user', content: '第二段' },
      ]),
      [{ role: 'user', content: '第一段\n\n第二段' }]
    );
  });

  test('首条不是 user 时前面补一条「（继续）」', () => {
    const out = m.toAnthropicMessages([{ role: 'assistant', content: '上一版' }]);
    assert.deepEqual(out[0], { role: 'user', content: '（继续）' });
    assert.equal(out.length, 2);
  });

  test('连续三条 tool 消息合并成一条 user，content 里三个 tool_result', () => {
    const out = m.toAnthropicMessages([
      { role: 'user', content: '看看' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', args: {}, raw: '{}' }] },
      { role: 'tool', toolCallId: 't1', name: 'read', content: 'A' },
      { role: 'tool', toolCallId: 't2', name: 'read', content: 'B' },
      { role: 'tool', toolCallId: 't3', name: 'read', content: 'C' },
    ]);
    const last = out[out.length - 1];
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content, [
      { type: 'tool_result', tool_use_id: 't1', content: 'A' },
      { type: 'tool_result', tool_use_id: 't2', content: 'B' },
      { type: 'tool_result', tool_use_id: 't3', content: 'C' },
    ]);
  });

  test('assistant 空 text + toolCalls：content 里没有空 text block', () => {
    const out = m.toAnthropicMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tu1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' }],
      },
    ]);
    const assistant = out[out.length - 1];
    assert.deepEqual(assistant.content, [
      { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a.md' } },
    ]);
  });

  test('assistant 有 text + toolCalls：text block 在前', () => {
    const out = m.toAnthropicMessages([
      {
        role: 'assistant',
        content: '我先读一下',
        toolCalls: [{ id: 'tu1', name: 'read', args: {}, raw: '{}' }],
      },
    ]);
    const assistant = out[out.length - 1];
    assert.deepEqual(assistant.content, [
      { type: 'text', text: '我先读一下' },
      { type: 'tool_use', id: 'tu1', name: 'read', input: {} },
    ]);
  });

  test('字符串 content 与数组 content 相邻同角色时也能接起来', () => {
    const out = m.toAnthropicMessages([
      { role: 'user', content: '先说一句' },
      { role: 'tool', toolCallId: 't1', name: 'read', content: 'A' },
    ]);
    assert.deepEqual(out, [
      {
        role: 'user',
        content: [
          { type: 'text', text: '先说一句' },
          { type: 'tool_result', tool_use_id: 't1', content: 'A' },
        ],
      },
    ]);
  });

  test('system 消息不进 messages（由顶层字段带）', () => {
    const out = m.toAnthropicMessages([
      { role: 'system', content: '你是作者' },
      { role: 'user', content: '续写' },
    ]);
    assert.deepEqual(out, [{ role: 'user', content: '续写' }]);
  });
});

describe('llm/anthropicProvider · tool_use 累积', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
  });

  test('input_json_delta 逐字符拼，content_block_stop 后产出完整 args', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th":"a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '.md"}' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    assert.deepEqual(calls, [
      { id: 'tu1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' },
    ]);
  });

  test('两个并行 tool_use（index 0 与 1）各自拼对', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'search' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"北境"}' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 0 },
    ]);
    assert.deepEqual(calls, [
      { id: 'b', name: 'search', args: { q: '北境' }, raw: '{"q":"北境"}' },
      { id: 'a', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' },
    ]);
  });

  test('坏 JSON：args 为空对象，raw 保留，不抛', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    assert.deepEqual(calls, [{ id: 'tu1', name: 'read', args: {}, raw: '{"path":' }]);
  });

  test('没有 partial_json 时按空对象处理', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'now' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    assert.deepEqual(calls, [{ id: 'tu1', name: 'now', args: {}, raw: '' }]);
  });

  test('text block 不产出 toolCall', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    assert.deepEqual(calls, []);
  });

  test('没有 content_block_stop 的块不产出（参数还没拼完）', () => {
    const calls = m.accumulateToolUse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    ]);
    assert.deepEqual(calls, []);
  });
});
