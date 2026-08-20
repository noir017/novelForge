/**
 * OpenAI Responses provider 的两段纯逻辑：消息转换与事件解析。
 *
 * 这条协议与老的 `/chat/completions` 有三处形状不同，全在这里钉住：
 * **system 走 `instructions`**、**工具调用与工具结果是 input 里独立的项**
 * （靠 `call_id` 配对）、**思考块要原样交回且排在它引出的调用之前**。
 *
 * 事件解析那半边的硬约束是「认不出的类型一律忽略」：这条协议有二十来种
 * 事件，为未知类型报错等于上游加一个新事件就炸掉整轮生成。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/openaiProvider · 消息转换', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  test('system 合并进 instructions，不留在 input 里', () => {
    const out = m.toResponsesInput([
      { role: 'system', content: '你是作者' },
      { role: 'system', content: '别写画面' },
      { role: 'user', content: '续写' },
    ]);
    assert.equal(out.instructions, '你是作者\n\n别写画面');
    assert.deepEqual(out.input, [{ role: 'user', content: '续写' }]);
  });

  test('assistant 无工具调用时是一条普通消息', () => {
    const out = m.toResponsesInput([{ role: 'assistant', content: '上一版' }]);
    assert.deepEqual(out.input, [{ role: 'assistant', content: '上一版' }]);
  });

  test('assistant 的工具调用是独立的 function_call 项', () => {
    const out = m.toResponsesInput([
      {
        role: 'assistant',
        content: '我先读一下',
        toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' }],
      },
    ]);
    assert.deepEqual(out.input, [
      { role: 'assistant', content: '我先读一下' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.md"}' },
    ]);
  });

  test('一个字都没说时不放空的 assistant 消息', () => {
    const out = m.toResponsesInput([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: {}, raw: '{}' }] },
    ]);
    assert.deepEqual(out.input, [
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
    ]);
  });

  test('tool 消息转成 function_call_output，按 call_id 配对', () => {
    const out = m.toResponsesInput([
      { role: 'tool', toolCallId: 'call_1', name: 'read', content: '正文…' },
    ]);
    assert.deepEqual(out.input, [
      { type: 'function_call_output', call_id: 'call_1', output: '正文…' },
    ]);
  });

  // 顺序是硬约束：上游按顺序把推理与它引出的调用配对，颠倒等于没交。
  test('思考凭据排在它引出的 function_call 之前', () => {
    const out = m.toResponsesInput([
      {
        role: 'assistant',
        content: '',
        traces: [{ kind: 'openai', payload: { type: 'reasoning', id: 'rs_1' } }],
        toolCalls: [{ id: 'c1', name: 'read', args: {}, raw: '{}' }],
      },
    ]);
    assert.deepEqual(out.input, [
      { type: 'reasoning', id: 'rs_1' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
    ]);
  });

  // 作者可以在一轮对话中间换模型，另一家的凭据交过去只会 400。
  test('别家协议的思考凭据被丢掉', () => {
    const out = m.toResponsesInput([
      {
        role: 'assistant',
        content: '答案',
        traces: [{ kind: 'anthropic', payload: { type: 'thinking', signature: 'x' } }],
      },
    ]);
    assert.deepEqual(out.input, [{ role: 'assistant', content: '答案' }]);
  });
});

describe('llm/openaiProvider · 事件解析', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  const read = (event) => m.readResponsesEvent(event, 'test-model @ 127.0.0.1');

  test('正文增量', () => {
    assert.deepEqual(read({ type: 'response.output_text.delta', delta: '雨' }), [
      { type: 'text', text: '雨' },
    ]);
  });

  test('思考摘要与推理正文都走 reasoning 事件', () => {
    assert.deepEqual(read({ type: 'response.reasoning_summary_text.delta', delta: '在想' }), [
      { type: 'reasoning', text: '在想' },
    ]);
    assert.deepEqual(read({ type: 'response.reasoning_text.delta', delta: '再想' }), [
      { type: 'reasoning', text: '再想' },
    ]);
  });

  test('function_call 项收完就是一次完整的工具调用，参数不用自己拼', () => {
    assert.deepEqual(
      read({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a.md"}' },
      }),
      [
        {
          type: 'toolCall',
          call: { id: 'c1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' },
        },
      ]
    );
  });

  test('坏 JSON 不抛：args 为空对象，raw 保留原文', () => {
    const [ev] = read({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":' },
    });
    assert.deepEqual(ev.call, { id: 'c1', name: 'read', args: {}, raw: '{"path":' });
  });

  test('reasoning 项原样收成凭据', () => {
    const item = { type: 'reasoning', id: 'rs_1', encrypted_content: 'xx' };
    assert.deepEqual(read({ type: 'response.output_item.done', item }), [
      { type: 'reasoningTrace', trace: { kind: 'openai', payload: item } },
    ]);
  });

  test('completed 带用量', () => {
    assert.deepEqual(
      read({
        type: 'response.completed',
        response: { usage: { input_tokens: 12, output_tokens: 3 } },
      }),
      [{ type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }]
    );
  });

  test('incomplete 也要把用量交出来', () => {
    const [ev] = read({
      type: 'response.incomplete',
      response: { usage: { input_tokens: 9 } },
    });
    assert.deepEqual(ev.usage, { inputTokens: 9, outputTokens: undefined });
  });

  test('failed 与 error 抛 LlmError，且带上游原文', () => {
    assert.throws(
      () => read({ type: 'response.failed', response: { error: { message: '上游过载' } } }),
      (e) => e.name === 'LlmError' && e.message.includes('上游过载')
    );
    assert.throws(
      () => read({ type: 'error', error: { message: '密钥无效' } }),
      (e) => e.name === 'LlmError' && e.message.includes('密钥无效')
    );
  });

  test('认不出的事件类型一律忽略', () => {
    assert.deepEqual(read({ type: 'response.output_item.added', item: { type: 'message' } }), []);
    assert.deepEqual(read({ type: 'response.content_part.done' }), []);
    assert.deepEqual(read({}), []);
  });
});

describe('llm/openaiProvider · 工具参数解析', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  test('空串与坏 JSON 退成空对象', () => {
    assert.deepEqual(m.parseToolArgs(''), {});
    assert.deepEqual(m.parseToolArgs('{"a":'), {});
  });

  test('解析出数组或字符串时也退成空对象', () => {
    assert.deepEqual(m.parseToolArgs('[1,2]'), {});
    assert.deepEqual(m.parseToolArgs('"文本"'), {});
  });

  test('正常对象原样收下', () => {
    assert.deepEqual(m.parseToolArgs('{"path":"a.md"}'), { path: 'a.md' });
  });
});
