/**
 * 收尾原因（`StopSignal`）：**判断一轮响应自不自洽的那个字段**。
 *
 * 「这一轮没有工具调用」在 agent 循环里等于「模型给出了最终回答」。这个等号有
 * 一个前提：上游没在别处说过它想调工具。而经手过的兼容网关（OpenAI 协议转
 * Anthropic 协议的那一类）会破坏这个前提——上游模型明明返回了 tool_calls，网关
 * 把 `stop_reason: "tool_use"` 照抄过来了，却把 `tool_use` 内容块整个漏掉。下面
 * 那段 SSE 是照抄的现场（同一份请求连发八次、五次这样）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 缺了 tool_use 块的那种响应 | 交出 `stop: toolUse` 且零个 toolCall（循环据此重发） |
 * | 正常那一份 | 同样交出 `stop: toolUse`，工具调用也在 |
 * | 说完了 | `stop: end` |
 * | 顺序 | `stop` **排在**所有 toolCall 之后（不然对账时手里还是空的） |
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

/** 网关丢了 tool_use 块的那一份：有话、有 `stop_reason`，就是没有调用。 */
const DROPPED =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来看看工程根目录。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  STOP('tool_use');

/** 同一个网关状态好的时候给的那一份。 */
const INTACT =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来看看。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  line({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call_1', name: 'list', input: {} },
  }) +
  line({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"."}' },
  }) +
  line({ type: 'content_block_stop', index: 1 }) +
  STOP('tool_use');

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
  const tools = (evs) => evs.filter((e) => e.type === 'toolCall').map((e) => e.call.name);

  // ★ 这一条就是这次修的那个 bug 的现场：从前它落到循环里长得和「模型说完了」
  //   一模一样，于是 agent 说一句话就停，没有工具、没有报错。
  test('网关丢了 tool_use 块：交出 stop=toolUse，但一个调用都没有', async () => {
    const evs = await events(DROPPED);
    assert.deepEqual(stops(evs), ['toolUse']);
    assert.deepEqual(tools(evs), []);
  });

  test('正常那一份：stop 与工具调用都在', async () => {
    const evs = await events(INTACT);
    assert.deepEqual(stops(evs), ['toolUse']);
    assert.deepEqual(tools(evs), ['list']);
  });

  // `stop` 是拿来跟手里的工具调用对账的：它要是先到，对账时手里还是空的。
  test('stop 排在所有 toolCall 之后', async () => {
    const evs = await events(INTACT);
    const order = evs.map((e) => e.type);
    assert.ok(order.lastIndexOf('toolCall') < order.indexOf('stop'), JSON.stringify(order));
  });

  test('说完了就是 end', async () => {
    assert.deepEqual(stops(await events(ENDED)), ['end']);
  });

  // undefined 有它自己的意思：「上游没说」。补一个默认值等于替它编一句话。
  test('上游不发这一条时一个 stop 都不交', async () => {
    assert.deepEqual(stops(await events(SILENT)), []);
  });

  // 这个字段上游还在加值（pause_turn、refusal）。认不出的报错会让循环因为一个
  // 不认识的字符串就断掉。
  test('认不出的收尾原因归到 other', async () => {
    assert.deepEqual(stops(await events(START + STOP('pause_turn'))), ['other']);
  });

  test('截断归到 maxTokens', async () => {
    assert.deepEqual(stops(await events(START + STOP('max_tokens'))), ['maxTokens']);
  });
});
