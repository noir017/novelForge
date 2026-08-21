/**
 * 通用 `/chat/completions` provider 的三段纯逻辑：消息转换、请求体里的思考
 * 字段、以及流里读出来的东西。
 *
 * 这条协议与另两条最大的差别是**思考字段没有标准**：同一个「想深一点」在四家
 * 是四个不同的字段名，所以那张风格表是这里的主角——每种风格落成什么，钉死在
 * 用例里，否则改一个字段名不会有任何东西报错。
 *
 * 另外三条硬约束也在这里：**工具参数按 index 累积**（`id` 只在第一片给）、
 * **收尾原因归一成四档**、**「不思考」是不带字段而不是显式关掉**。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let m;

before(() => {
  m = loadModule('src/core/llm/chatCompletionsProvider.ts');
});

describe('llm/chatCompletionsProvider · 消息转换', () => {
  test('system 是一条普通消息，不抽到顶层', () => {
    const out = m.toChatMessages([
      { role: 'system', content: '你是作者' },
      { role: 'user', content: '续写' },
    ]);
    assert.deepEqual(out, [
      { role: 'system', content: '你是作者' },
      { role: 'user', content: '续写' },
    ]);
  });

  test('assistant 的工具调用挂在自己身上', () => {
    const out = m.toChatMessages([
      {
        role: 'assistant',
        content: '我先读一下',
        toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' }],
      },
    ]);
    assert.deepEqual(out, [
      {
        role: 'assistant',
        content: '我先读一下',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } },
        ],
      },
    ]);
  });

  // 空串会被部分实现拒掉，必须是 null。
  test('一个字都没说时 content 是 null 而不是空串', () => {
    const out = m.toChatMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: {}, raw: '{}' }] },
    ]);
    assert.equal(out[0].content, null);
  });

  test('tool 消息是独立 role，按 tool_call_id 配对', () => {
    const out = m.toChatMessages([
      { role: 'tool', toolCallId: 'call_1', name: 'read', content: '文件内容' },
    ]);
    assert.deepEqual(out, [{ role: 'tool', tool_call_id: 'call_1', content: '文件内容' }]);
  });

  // DeepSeek 把上一轮的 reasoning_content 交回去是直接 400。
  test('思考凭据一律不交回去', () => {
    const out = m.toChatMessages([
      {
        role: 'assistant',
        content: '想过了',
        traces: [{ kind: 'openai-responses', payload: { type: 'reasoning' } }],
      },
    ]);
    assert.deepEqual(out, [{ role: 'assistant', content: '想过了' }]);
  });
});

describe('llm/chatCompletionsProvider · 思考字段落成什么', () => {
  const fields = (style, effort = 'high', depth = 'high', max = 32000) =>
    m.thinkingFields(effort, depth, max, style);

  test('effort 风格只发 reasoning_effort', () => {
    assert.deepEqual(fields('effort'), { reasoning_effort: 'high' });
  });

  // 智谱那边开关与档位是两个字段。
  test('thinking 风格发 thinking 对象加 reasoning_effort', () => {
    assert.deepEqual(fields('thinking'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  test('enable 风格发 enable_thinking 加预算', () => {
    assert.deepEqual(fields('enable'), { enable_thinking: true, thinking_budget: 24576 });
  });

  // 预算算不出来时只开开关，不带一个必然被拒的数字。
  test('输出上限装不下预算时只发开关', () => {
    assert.deepEqual(fields('enable', 'high', 'high', 2000), { enable_thinking: true });
  });

  test('reasoning 风格发嵌套的 reasoning 对象', () => {
    assert.deepEqual(fields('reasoning'), { reasoning: { effort: 'high' } });
  });

  test('none 风格什么都不发', () => {
    assert.deepEqual(fields('none'), {});
  });

  // 「不思考」那一档：effort 为 undefined，任何风格都不带字段。
  test('不思考那档一律不带字段，不发显式关掉', () => {
    for (const style of ['effort', 'thinking', 'enable', 'reasoning']) {
      assert.deepEqual(m.thinkingFields(undefined, 'off', 32000, style), {}, style);
    }
  });
});

describe('llm/chatCompletionsProvider · 收尾原因', () => {
  test('tool_calls 归成 toolUse', () => {
    assert.equal(m.stopSignalOf('tool_calls'), 'toolUse');
  });

  test('stop 与 stop_sequence 都归成 end', () => {
    assert.equal(m.stopSignalOf('stop'), 'end');
    assert.equal(m.stopSignalOf('stop_sequence'), 'end');
  });

  test('length 归成 maxTokens', () => {
    assert.equal(m.stopSignalOf('length'), 'maxTokens');
  });

  // 认不出的报错会让循环因为一个不认识的字符串就断掉。
  test('认不出的归成 other', () => {
    assert.equal(m.stopSignalOf('content_filter'), 'other');
    assert.equal(m.stopSignalOf('胡说'), 'other');
  });
});

describe('llm/chatCompletionsProvider · 流里读出来的东西', () => {
  const read = (chunk) => m.readChatChunk(chunk, 'test-model @ 127.0.0.1');

  test('正文走 text 事件', () => {
    assert.deepEqual(read({ choices: [{ delta: { content: '雨下了' } }] }), [
      { type: 'event', event: { type: 'text', text: '雨下了' } },
    ]);
  });

  test('reasoning_content 走 reasoning 事件，不混进正文', () => {
    assert.deepEqual(read({ choices: [{ delta: { reasoning_content: '我在想' } }] }), [
      { type: 'event', event: { type: 'reasoning', text: '我在想' } },
    ]);
  });

  // OpenRouter 用的是 reasoning 这个名字。
  test('reasoning 这个字段名也认', () => {
    assert.deepEqual(read({ choices: [{ delta: { reasoning: '我在想' } }] }), [
      { type: 'event', event: { type: 'reasoning', text: '我在想' } },
    ]);
  });

  test('usage 按 prompt/completion 映射', () => {
    assert.deepEqual(read({ usage: { prompt_tokens: 11, completion_tokens: 4 } }), [
      { type: 'event', event: { type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } } },
    ]);
  });

  test('工具分片不当成事件，交给调用方攒', () => {
    const out = read({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1' }] } }] });
    assert.deepEqual(out, [{ type: 'toolChunk', chunk: [{ index: 0, id: 'c1' }] }]);
  });

  test('finish_reason 单独一档，不与事件混在一起', () => {
    assert.deepEqual(read({ choices: [{ finish_reason: 'tool_calls' }] }), [
      { type: 'finish', reason: 'toolUse' },
    ]);
  });

  test('流里的 error 抛 LlmError，带上游原话', () => {
    assert.throws(() => read({ error: { message: '余额不足' } }), /余额不足/);
  });

  test('认不出的 chunk 一律忽略', () => {
    assert.deepEqual(read({}), []);
    assert.deepEqual(read({ choices: [{ delta: {} }] }), []);
  });
});

describe('llm/chatCompletionsProvider · 工具参数按 index 累积', () => {
  test('分片拼成完整参数', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }],
      [{ index: 0, function: { arguments: 'th":"a.md"}' } }],
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'c1');
    assert.equal(calls[0].name, 'read');
    assert.deepEqual(calls[0].args, { path: 'a.md' });
    assert.equal(calls[0].raw, '{"path":"a.md"}');
  });

  // id 只在第一片给：按 id 累积会让后面每片各开一个空 id 的槽。
  test('两个并行调用各占一个 index', () => {
    const calls = m.accumulateToolCalls([
      [
        { index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } },
        { index: 1, id: 'c2', function: { name: 'list', arguments: '{}' } },
      ],
    ]);
    assert.deepEqual(calls.map((c) => c.name), ['read', 'list']);
  });

  test('坏 JSON 退成空对象但保留原文，绝不抛', () => {
    const calls = m.accumulateToolCalls([
      [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }],
    ]);
    assert.deepEqual(calls[0].args, {});
    assert.equal(calls[0].raw, '{"path":');
  });

  test('没有分片时一个调用都不产', () => {
    assert.deepEqual(m.accumulateToolCalls([]), []);
  });
});

/**
 * 「值不认」与「字段不认」是两种抱怨，走两条路：前者降一档，后者换写法。
 *
 * 这一组是回归测试。两句话里都有 `reasoning_effort`（于是都含 `effort` 这个
 * 子串），只按子串判会把「压根不认识这个字段」当成「这一档太高」，于是一路
 * 降到 low 都在发同一个它不认识的字段名——四种写法一种都试不到。
 */
describe('llm/chatCompletionsProvider · 400 的两种抱怨要分清', () => {
  const quirk = () => ({
    style: 'effort',
    pinned: false,
    noStreamOptions: false,
    noTemperature: false,
    maxDepth: 'max',
    warnedRoom: false,
  });
  const sent = { reasoning_effort: 'max' };
  const nego = (body, q) => m.negotiate(400, body, sent, q, 'test-model');

  test('「值不支持」降一档，写法不变', () => {
    const q = quirk();
    assert.equal(nego("Unsupported value: 'reasoning_effort' does not support 'max'", q), true);
    assert.equal(q.maxDepth, 'high');
    assert.equal(q.style, 'effort');
  });

  test('「不认识这个字段」换写法，档位不变', () => {
    const q = quirk();
    assert.equal(nego("Unrecognized request argument: 'reasoning_effort'", q), true);
    assert.equal(q.style, 'thinking');
    assert.equal(q.maxDepth, 'max');
  });

  test('通义那种 invalid_parameter 算值不对', () => {
    const q = quirk();
    assert.equal(nego('invalid_parameter_error: reasoning_effort', q), true);
    assert.equal(q.maxDepth, 'high');
  });

  test('判不准时宁可换写法，不在不认识的字段上降档', () => {
    const q = quirk();
    assert.equal(nego('reasoning_effort is not supported by this model', q), true);
    assert.equal(q.style, 'thinking');
  });

  test('作者钉死风格时不换写法，直接退到不带字段', () => {
    const q = { ...quirk(), style: 'enable', pinned: true };
    assert.equal(nego("Unrecognized request argument: 'enable_thinking'", q), true);
    assert.equal(q.style, 'none');
  });

  // 这一次压根没带思考字段，上游那句抱怨与我们无关。
  test('没带思考字段时不协商，让真错误报出来', () => {
    const q = quirk();
    assert.equal(m.negotiate(400, 'reasoning_effort 不认', {}, q, 'test-model'), false);
  });

  test('只认 400：其余状态码一律不协商', () => {
    for (const status of [401, 404, 429, 500]) {
      assert.equal(m.negotiate(status, 'reasoning', sent, quirk(), 'x'), false, String(status));
    }
  });

  test('与思考无关的 400 不动思考字段', () => {
    const q = quirk();
    assert.equal(nego('context length exceeded', q), false);
    assert.equal(q.style, 'effort');
    assert.equal(q.maxDepth, 'max');
  });
});
