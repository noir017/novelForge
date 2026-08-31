/**
 * 断流与裸报错：**「模型什么都没说」和「上游把流掐了」不是一回事**。
 *
 * 现场（`.novelforge/sessions/` 里那一份）：推理模型经中转网关，吐完 1893 字
 * 思考就把连接断了——没有 `message_delta`、没有 `message_stop`、实测输出
 * 0 token。从前这条路与「模型正常说完但一个字都没说」完全同形，于是
 * `generate` 造出一份 `raw: ''` 的草稿，工具回「已生成 · 0 字」，agent 转头
 * 跟作者说「正在等你点头」，而作者那边一张卡片都没有。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 只有思考、没有收尾事件 | **抛** LlmError，说清是断流 |
 * | 已经吐了正文、没有收尾事件 | **不抛**（抛掉等于把那半份也扔了），只留 warn |
 * | 只有思考但正常收尾 | 不抛——那是模型自己的选择，空产出由 `generate` 去判 |
 * | 中途来一条没有 `type` 的裸 `{"error":…}` | 抛，别再静默丢掉 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

function fakeFetch(sse) {
  return async () =>
    new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

const line = (obj) => `event: ${obj.type ?? 'unknown'}\ndata: ${JSON.stringify(obj)}\n\n`;

const START = line({
  type: 'message_start',
  message: { type: 'message', role: 'assistant', id: 'x', usage: { input_tokens: 2927 }, content: [] },
});
const THINKING =
  line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看看大纲。' } });
const TEXT =
  line({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"volumes":[' } });

/** 想完就断：思考块连 `content_block_stop` 都没有。 */
const CUT_AFTER_THINKING = START + THINKING;
/** 已经吐了半份正文才断。 */
const CUT_AFTER_TEXT = START + THINKING + TEXT;
/** 只想不说，但收尾是全的。 */
const SILENT_BUT_CLOSED =
  START + THINKING + line({ type: 'content_block_stop', index: 0 }) + line({ type: 'message_stop' });
/** 网关的裸报错：没有 `type`，只有 `error`。 */
const BARE_ERROR =
  START + THINKING + `data: ${JSON.stringify({ error: { message: '上游连接被重置' } })}\n\n`;

describe('llm/anthropicProvider · 断流与裸报错', () => {
  let m;
  let real;

  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
    real = globalThis.fetch;
  });

  /** 收全流。抛了就把错误也交出来，由用例自己判。 */
  async function run(sse) {
    globalThis.fetch = fakeFetch(sse);
    try {
      const p = new m.AnthropicProvider('https://例子', '假模型', 'k');
      const out = [];
      try {
        for await (const ev of p.stream([{ role: 'user', content: '拆卷' }], {
          maxOutputTokens: 4096,
          temperature: 0.8,
          timeoutMs: 5000,
        })) {
          out.push(ev);
        }
      } catch (err) {
        return { events: out, error: err };
      }
      return { events: out, error: undefined };
    } finally {
      globalThis.fetch = real;
    }
  }

  test('只有思考就断流：抛错，而不是当成一次空回答', async () => {
    const { error } = await run(CUT_AFTER_THINKING);
    assert.ok(error, '这一条必须抛');
    assert.match(error.message, /中途断开/);
  });

  test('那句话里说清了「只收到思考」', async () => {
    const { error } = await run(CUT_AFTER_THINKING);
    assert.match(error.message, /只收到思考/);
  });

  // 抛掉等于把已经吐出来的半份正文一起扔了：那半份该由上层按内容处理。
  test('已经吐了正文再断流：不抛，正文留着', async () => {
    const { events, error } = await run(CUT_AFTER_TEXT);
    assert.equal(error, undefined, error && error.message);
    assert.deepEqual(
      events.filter((e) => e.type === 'text').map((e) => e.text),
      ['{"volumes":[']
    );
  });

  // 正常收尾的空回答不是断流：那时该由 `generate` 判「这不是一份产物」。
  test('只想不说但收尾是全的：不抛', async () => {
    const { error, events } = await run(SILENT_BUT_CLOSED);
    assert.equal(error, undefined, error && error.message);
    assert.deepEqual(
      events.filter((e) => e.type === 'text'),
      []
    );
  });

  test('中途一条没有 type 的裸 error：抛，并带上上游那句话', async () => {
    const { error } = await run(BARE_ERROR);
    assert.ok(error, '这一条必须抛');
    assert.match(error.message, /上游连接被重置/);
  });
});

/**
 * 「上一轮的思考原文要交回去」那句 400。
 *
 * 中转网关（new-api 那一类）把 Anthropic 协议转成 OpenAI 协议发给上游，转换时
 * 把 thinking 块丢了，于是上游那条「思考模式下必须交回 reasoning_content」
 * 永远满足不了——**交与不交是同一句 400**（实测过）。所以这一条不能沿思考写法
 * 的梯子降一格（手动预算同样是思考模式），只能直接退到不带思考字段。
 *
 * 表现是**间歇性**的：自适应思考不是每轮都想，哪一轮真想了，下一轮才死。会话
 * `20260831-160302-114801` 就是跑到第 4 步才炸。
 */
describe('llm/anthropicProvider · 网关丢了思考原文', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
  });

  const DEMAND = 'The `reasoning_content` in the thinking mode must be passed back to the API.';
  const quirk = (over = {}) => ({ mode: 'adaptive', maxDepth: 'max', warnedRoom: false, ...over });

  test('自适应上收到这一句：直接退到不带思考字段，不是降一格', () => {
    const q = quirk();
    assert.equal(m.negotiate(400, DEMAND, q, 'x'), true);
    assert.equal(q.mode, 'none');
  });

  test('手动预算上也是退到不带（手动同样是思考模式）', () => {
    const q = quirk({ mode: 'manual' });
    assert.equal(m.negotiate(400, DEMAND, q, 'x'), true);
    assert.equal(q.mode, 'none');
  });

  test('这一条不去动思考档位', () => {
    const q = quirk();
    m.negotiate(400, DEMAND, q, 'x');
    assert.equal(q.maxDepth, 'max');
  });

  test('已经不带思考字段了还这么说：不再重发', () => {
    assert.equal(m.negotiate(400, DEMAND, quirk({ mode: 'none' }), 'x'), false);
  });

  // 作者看到的只有一句 HTTP 400，而这件事他其实有解：换成 OpenAI 通用那条路。
  test('报错里指出这是网关的转换丢了东西，并给出换协议那条路', () => {
    const hint = m.gatewayHint(DEMAND);
    assert.match(hint, /中转网关/);
    assert.match(hint, /OpenAI 通用/);
  });

  test('与它无关的报错不加这段话', () => {
    assert.equal(m.gatewayHint('model not found'), '');
  });
});
