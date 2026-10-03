/**
 * Anthropic 的收尾原因（`stop_reason`）→ `StopSignal`。
 *
 * 续写链靠它分清「模型自己收了尾」与「被输出上限截断」，所以：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 说完了 | `stop: end` |
 * | 截断 | `stop: maxTokens` |
 * | 认不出的值 | `stop: other` |
 * | 上游不发这一条 | 一个 stop 都不交（`undefined` 有它自己的意思） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

/** 一段 SSE 文本 → 一个假的 fetch。 */
function fakeFetch(sse) {
  return async () =>
    new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

const line = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

const START = line({
  type: 'message_start',
  message: { type: 'message', role: 'assistant', id: 'x', usage: { input_tokens: 2746 }, content: [] },
});
const STOP = (reason) =>
  line({ type: 'message_delta', usage: { output_tokens: 38 }, delta: { stop_reason: reason } }) +
  line({ type: 'message_stop' });

const ENDED =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '他说过。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  STOP('end_turn');

/** 压根不发 `message_delta` 的兼容实现。 */
const SILENT =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  line({ type: 'message_stop' });

describe('llm/anthropicProvider · 收尾原因', () => {
  let m;
  let real;

  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
    real = globalThis.fetch;
  });

  /** 收全流，只留事件类型与要断言的那几个字段。 */
  async function events(sse) {
    globalThis.fetch = fakeFetch(sse);
    try {
      const p = new m.AnthropicProvider('https://例子', '假模型', 'k');
      const out = [];
      for await (const ev of p.stream([{ role: 'user', content: '看看' }], {
        maxOutputTokens: 4096,
        temperature: 0.8,
        timeoutMs: 5000,
      })) {
        out.push(ev);
      }
      return out;
    } finally {
      globalThis.fetch = real;
    }
  }

  const stops = (evs) => evs.filter((e) => e.type === 'stop').map((e) => e.reason);

  test('说完了就是 end', async () => {
    assert.deepEqual(stops(await events(ENDED)), ['end']);
  });

  // undefined 有它自己的意思：「上游没说」。补一个默认值等于替它编一句话。
  test('上游不发这一条时一个 stop 都不交', async () => {
    assert.deepEqual(stops(await events(SILENT)), []);
  });

  // 这个字段上游还在加值（pause_turn、refusal）。认不出的报错会让续写链因为一个
  // 不认识的字符串就断掉。
  test('认不出的收尾原因归到 other', async () => {
    assert.deepEqual(stops(await events(START + STOP('pause_turn'))), ['other']);
  });

  test('截断归到 maxTokens', async () => {
    assert.deepEqual(stops(await events(START + STOP('max_tokens'))), ['maxTokens']);
  });
});
