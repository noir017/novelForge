/**
 * OpenAI Responses provider 的两段纯逻辑：消息转换与事件解析。
 *
 * 消息转换那半边钉的是与老的 `/chat/completions` 不同的那一处：**system 走
 * `instructions`**，不留在 input 里。
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

  test('assistant 是一条普通消息', () => {
    const out = m.toResponsesInput([{ role: 'assistant', content: '上一版' }]);
    assert.deepEqual(out.input, [{ role: 'assistant', content: '上一版' }]);
  });

  test('assistant 空内容时不放空消息', () => {
    const out = m.toResponsesInput([{ role: 'assistant', content: '' }]);
    assert.deepEqual(out.input, []);
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

  test('completed 带用量，报正常收尾', () => {
    assert.deepEqual(
      read({
        type: 'response.completed',
        response: { usage: { input_tokens: 12, output_tokens: 3 } },
      }),
      [
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
        // 续写链要分清「模型自己收了尾」与「网关没说」，completed 必须报 end。
        { type: 'stop', reason: 'end' },
      ]
    );
  });

  test('incomplete 报截断；completed 里写着 incomplete 的也按截断算', () => {
    assert.deepEqual(read({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }), [
      { type: 'stop', reason: 'maxTokens' },
    ]);
    assert.deepEqual(read({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }), [
      { type: 'stop', reason: 'other' },
    ]);
    assert.deepEqual(
      read({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
      [{ type: 'stop', reason: 'maxTokens' }]
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
    assert.deepEqual(read({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } }), []);
    assert.deepEqual(read({ type: 'response.content_part.done' }), []);
    assert.deepEqual(read({}), []);
  });
});
