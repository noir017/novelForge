/**
 * Anthropic provider 的消息转换。
 *
 * 与 OpenAI 不同的硬约束：system 走顶层字段、user/assistant 严格交替（相邻
 * 同角色合并）、首条必须是 user。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/anthropicProvider · 消息转换', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
  });

  test('user / assistant 纯文本原样', () => {
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

  test('system 消息不进 messages（由顶层字段带）', () => {
    const out = m.toAnthropicMessages([
      { role: 'system', content: '你是作者' },
      { role: 'user', content: '续写' },
    ]);
    assert.deepEqual(out, [{ role: 'user', content: '续写' }]);
  });
});
