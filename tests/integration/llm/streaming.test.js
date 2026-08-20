/**
 * LLM provider 的流式解析：跨块切分、CRLF、心跳注释、非 JSON 行、流中错误、
 * 取消、超时、流式输出期间不超时、HTTP 错误信息、思考深度落成请求字段，
 * 以及 Anthropic 的 system 抽取与相邻消息合并。
 *
 * OpenAI 那一侧走的是 **Responses**（`/responses`）：事件名是
 * `response.output_text.delta` 这一套，工具调用在 `response.output_item.done`
 * 上一次给全（不必按 index 拼分片），思考深度是 `reasoning.effort`。
 *
 * ## 为什么这份假服务器留在文件里
 *
 * 它跑的是**真的 OpenAiProvider / AnthropicProvider**，走真的 fetch 与真的 SSE
 * 解析，所以必须有一个真的 HTTP 服务端把畸形分帧喂进去——事件被切在半路、
 * CRLF 分隔、注释心跳、空 delta、流到一半改吐 error。这与
 * helpers/fakeProvider.js（经 registerProviderFactory 注入假模型、根本不过网络）
 * 是两件事，别硬凑到一起。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');

/**
 * 服务端行为开关：每个用例在自己的 before() 里切 mode，再看 lastRequest。
 *
 * `requests` 留着整串——**字段协商**那几条要看「第一次发了什么、第二次少了
 * 什么」，只留最后一条看不出来。用例自己在 before() 里清空它。
 */
const server = { mode: 'openai-ok', lastRequest: null, requests: [] };

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    server.lastRequest = {
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };
    server.requests.push(server.lastRequest);

    const sse = () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    };

    switch (server.mode) {
      case 'openai-ok': {
        sse();
        // 故意把事件切成不规则的块，检验缓冲区拼接。
        res.write('data: {"type":"response.output_text.delta","delta":"雨下了"}\n\n');
        res.write('data: {"type":"response.output_text.delta","del');
        res.write(
          'ta":"三天，"}\n\ndata: {"type":"response.output_text.delta","delta":"石板路"}\n\n'
        );
        res.write(': 这是一条注释心跳\n\n');
        res.write('data: {"type":"response.output_text.delta"}\n\n'); // 空 delta
        res.write('data: {"type":"response.output_text.delta","delta":"泡得发白。"}\n\n');
        res.write(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4}}}\n\n'
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-crlf': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"CRLF"}\r\n\r\n');
        res.write('data: {"type":"response.output_text.delta","delta":"分隔"}\r\n\r\n');
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }
      case 'openai-reasoning': {
        sse();
        // 思考摘要先来、正文后到：摘要不能混进正文。
        res.write('data: {"type":"response.reasoning_summary_text.delta","delta":"我在思考"}\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"正文"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-garbage': {
        sse();
        res.write('data: 这不是 JSON\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"仍能继续"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-mid-error': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"开头"}\n\n');
        res.write('data: {"type":"error","error":{"message":"上游过载"}}\n\n');
        res.end();
        return;
      }
      case 'http-401': {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      case 'http-404': {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      case 'http-429': {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('rate limited');
        return;
      }
      case 'slow': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"慢"}\n\n');
        // 不结束，用于测试取消与超时
        return;
      }
      case 'slow-stream': {
        // 持续吐字，总时长超过 timeoutMs；空闲超时不应打断。
        sse();
        let i = 0;
        let closed = false;
        res.on('close', () => {
          closed = true;
        });
        const tick = () => {
          if (closed || res.writableEnded) {
            return;
          }
          if (i >= 6) {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(`data: {"type":"response.output_text.delta","delta":"${i}"}\n\n`);
          i += 1;
          setTimeout(tick, 150);
        };
        tick();
        return;
      }
      case 'openai-tool-calls': {
        sse();
        // Responses 的形状：正文与工具调用是两种 item，调用在 done 上一次给全，
        // 不必按 index 拼分片。中间那个 reasoning item 要被收成思考凭据。
        res.write('data: {"type":"response.output_text.delta","delta":"我先读一下"}\n\n');
        res.write(
          'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc"}}\n\n'
        );
        res.write(
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"read","arguments":"{\\"path\\":\\"plots/001.md\\"}"}}\n\n'
        );
        res.write(
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_b","name":"search","arguments":"{\\"q\\":\\"北境\\"}"}}\n\n'
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-tool-calls-bad-json': {
        sse();
        res.write(
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"read","arguments":"{\\"path\\":"}}\n\n'
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      /**
       * 第一次 400（「不认这个 effort 值」），之后正常。
       *
       * 用来验字段协商：**降一档再发**，而不是把这一轮判死——上游那句
       * 「Unsupported value」在作者眼里只是「怎么又不能用了」。
       */
      case 'openai-effort-400': {
        if (server.requests.length === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: "Unsupported value: 'reasoning.effort' does not support 'xhigh'" },
            })
          );
          return;
        }
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"降档后成了"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'anthropic-ok': {
        sse();
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"三更，"}}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"林昭醒了。"}}\n\n');
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      /** 思考块：thinking_delta 若干 + 一个 signature_delta，然后才是正文。 */
      case 'anthropic-thinking': {
        sse();
        res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n');
        res.write(
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n'
        );
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想一下"}}\n\n'
        );
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}\n\n'
        );
        res.write('data: {"type":"content_block_stop","index":0}\n\n');
        res.write(
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}\n\n'
        );
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      /**
       * 第一次 400（「这个模型不认自适应思考」），之后正常。
       *
       * 验的是**换写法再发**：老模型只认手动预算，而作者的设置页里只有一个
       * 模型名，指望他知道自家模型属于哪一代思考写法是不合理的。
       */
      case 'anthropic-adaptive-400': {
        if (server.requests.length === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: '"thinking.type.adaptive" is not supported by this model' },
            })
          );
          return;
        }
        sse();
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"换写法后成了"}}\n\n'
        );
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      case 'anthropic-error': {
        sse();
        res.write('data: {"type":"error","error":{"message":"overloaded_error"}}\n\n');
        res.end();
        return;
      }
      default:
        res.writeHead(500);
        res.end('unknown mode');
    }
  });
});

const opts = (extra = {}) => ({
  maxOutputTokens: 1000,
  temperature: 0.8,
  timeoutMs: 5000,
  ...extra,
});

/** 一份最小可用的工具声明，只用来看透传形状。 */
const TOOL = {
  name: 'read',
  description: '读一个工程内的文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

let vs;
let providerMod;
let collectText;
let collect;
let OpenAiProvider;
let AnthropicProvider;
let openai;
let anthropic;
let base;
let port;

/** core 侧取消已改 AbortSignal：包一层，用 provider 模块自己的 CancelledError 作 reason。 */
function makeCancelSource() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel() { controller.abort(new providerMod.CancelledError()); },
  };
}

/** 把「跑一次流并接住异常」压成一句，省掉每处都写 try/catch。 */
async function catchError(fn) {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

before(async () => {
  vs = installVscodeStub({ level: 'minimal' });
  // 一个 bundle 装全部：两个 provider 与 provider.ts 必须共用同一份
  // CancelledError / LlmError，否则 normalizeError 的 instanceof 判断落空
  //（它有 err.name 兜底，所以原脚本分开 bundle 也过得去，但共用才是对的）。
  const bundle = loadBundle({
    openai: './src/core/llm/openaiProvider.ts',
    anthropic: './src/core/llm/anthropicProvider.ts',
    provider: './src/core/llm/provider.ts',
    collect: './src/core/llm/collect.ts',
  });
  providerMod = bundle.provider;
  ({ collectText, collect } = bundle.collect);
  OpenAiProvider = bundle.openai.OpenAiProvider;
  AnthropicProvider = bundle.anthropic.AnthropicProvider;

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
  base = `http://127.0.0.1:${port}/v1`;

  openai = new OpenAiProvider(base, 'test-model', 'sk-test');
  anthropic = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-test', 'sk-ant-test');
});

after(() => {
  // close() 只是停止接受新连接：slow 模式的响应从不 res.end()，不显式销毁
  // 已建立的连接就会把进程吊住。原脚本靠 process.exit 掩盖了这一点。
  httpServer.closeAllConnections();
  httpServer.close();
  vs.restore();
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 正常流', () => {
  let text;
  let req;
  let nestedModel;

  before(async () => {
    server.mode = 'openai-ok';
    text = await collectText(openai.stream(
      [{ role: 'system', content: '你是作者' }, { role: 'user', content: '续写' }],
      opts()
    ));
    // 必须在下面那次请求之前抓下来：lastRequest 只留最后一条。
    req = server.lastRequest;

    // 含斜杠的模型名必须**原样**上线。路由型服务商（OpenRouter、my-router 等）
    // 的模型名本就是 `渠道/厂商/模型`，任何一段被吃掉，上游都会回
    // 「has no provider supported」，而那个报错看起来像是模型不存在。
    const nested = new OpenAiProvider(base, 'ms/deepseek-ai/DeepSeek-V4-Flash', 'sk-test');
    await collectText(nested.stream([], opts()));
    nestedModel = server.lastRequest.body.model;
  });

  test('拼接出完整文本', () => {
    assert.equal(text, '雨下了三天，石板路泡得发白。');
  });

  test('跨块切分的事件被正确拼接', () => {
    assert.ok(text.includes('三天，'));
  });

  test('注释心跳被忽略', () => {
    assert.ok(!text.includes('注释'));
  });

  test('请求路径正确', () => {
    assert.equal(req.url, '/v1/responses');
  });

  test('带 Bearer 认证头', () => {
    assert.equal(req.headers.authorization, 'Bearer sk-test');
  });

  test('stream 为 true', () => {
    assert.equal(req.body.stream, true);
  });

  test('传递 model', () => {
    assert.equal(req.body.model, 'test-model');
  });

  test('传递 max_output_tokens', () => {
    assert.equal(req.body.max_output_tokens, 1000);
  });

  // 不思考时它仍是有效的文风旋钮；思考开着时一律不带（见下面那一组）。
  test('不思考时带 temperature', () => {
    assert.equal(req.body.temperature, 0.8);
  });

  test('system 走 instructions 顶层字段，不留在 input 里', () => {
    assert.equal(req.body.instructions, '你是作者');
    assert.deepEqual(req.body.input, [{ role: 'user', content: '续写' }]);
  });

  // 会话历史由本地那份 JSON 负责，服务端再存一份只是多一个副本。
  test('store 恒为 false', () => {
    assert.equal(req.body.store, false);
  });

  test('不思考时不带 reasoning 字段', () => {
    assert.equal('reasoning' in req.body, false);
  });

  test('provider label 含模型与主机', () => {
    assert.ok(openai.label.includes('test-model') && openai.label.includes('127.0.0.1'));
  });

  test('多层斜杠的模型名原样传给上游', () => {
    assert.equal(nestedModel, 'ms/deepseek-ai/DeepSeek-V4-Flash');
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 边界情况', () => {
  let crlf;
  let reasoning;
  let garbage;
  let caught;

  before(async () => {
    server.mode = 'openai-crlf';
    crlf = await collectText(openai.stream([], opts()));

    server.mode = 'openai-reasoning';
    reasoning = await collectText(openai.stream([], opts()));

    server.mode = 'openai-garbage';
    garbage = await collectText(openai.stream([], opts()));

    server.mode = 'openai-mid-error';
    caught = await catchError(() => collectText(openai.stream([], opts())));
  });

  test('CRLF 分隔的 SSE', () => {
    assert.equal(crlf, 'CRLF分隔');
  });

  // 思考不该被采纳写进章节，所以它不进 text；但它必须有地方去，
  // 否则推理模型想几十秒的那段时间界面上是一片空白。
  test('思考摘要不混进正文', () => {
    assert.equal(reasoning, '正文');
  });

  test('跳过非 JSON 行继续解析', () => {
    assert.equal(garbage, '仍能继续');
  });

  test('流中途的 error 事件被抛出', () => {
    assert.equal(caught && caught.name, 'LlmError');
  });

  test('错误信息含上游原文', () => {
    assert.ok(caught && caught.message.includes('上游过载'), caught && caught.message);
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · HTTP 错误', () => {
  for (const [mode, expect] of [
    ['http-401', 'API Key 可能无效'],
    ['http-404', '接口地址或模型名可能填错'],
    ['http-429', '触发限流'],
  ]) {
    describe(mode, () => {
      let err;

      before(async () => {
        server.mode = mode;
        err = await catchError(() => collectText(openai.stream([], opts())));
      });

      test(`${mode} 抛出 LlmError`, () => {
        assert.ok(err && err.name === 'LlmError');
      });

      test(`${mode} 附带排查提示`, () => {
        assert.ok(err && err.message.includes(expect), err && err.message);
      });
    });
  }
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 取消与超时', () => {
  let first;
  let cancelErr;
  let timeoutErr;
  let preCancelledErr;

  before(async () => {
    server.mode = 'slow';
    {
      const src = makeCancelSource();
      const stream = openai.stream([], opts({ signal: src.signal }));
      const iter = stream[Symbol.asyncIterator]();
      first = await iter.next();
      src.cancel();
      cancelErr = await catchError(() => iter.next());
    }

    server.mode = 'slow';
    timeoutErr = await catchError(() =>
      collectText(openai.stream([], opts({ timeoutMs: 300 })))
    );

    // 已取消的 signal 传进来时应立刻失败，不发请求
    server.mode = 'openai-ok';
    const src = makeCancelSource();
    src.cancel();
    preCancelledErr = await catchError(() =>
      collectText(openai.stream([], opts({ signal: src.signal })))
    );
  });

  test('取消前已收到首个分片', () => {
    assert.deepEqual(first.value, { type: 'text', text: '慢' });
  });

  test('取消后抛 CancelledError', () => {
    assert.equal(cancelErr && cancelErr.name, 'CancelledError');
  });

  test('超时抛 LlmError', () => {
    assert.equal(timeoutErr && timeoutErr.name, 'LlmError');
  });

  test('超时信息提示可调设置', () => {
    assert.ok(timeoutErr && timeoutErr.message.includes('requestTimeoutMs'), timeoutErr && timeoutErr.message);
  });

  test('预先取消的 signal 立即抛 CancelledError', () => {
    assert.equal(preCancelledErr && preCancelledErr.name, 'CancelledError');
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 流式输出期间不超时', () => {
  let text;

  before(async () => {
    server.mode = 'slow-stream';
    // 6 片 × 150ms ≈ 900ms，大于 400ms 空闲超时；一直有数据就不该中止。
    text = await collectText(openai.stream([], opts({ timeoutMs: 400 })));
  });

  test('总时长超过 timeoutMs 仍收齐全文', () => {
    assert.equal(text, '012345');
  });
});

// ---------------------------------------------------------------------------

describe('Anthropic provider', () => {
  let aText;
  let aReq;
  let aErr;

  before(async () => {
    server.mode = 'anthropic-ok';
    aText = await collectText(anthropic.stream(
      [
        { role: 'system', content: '系统提示A' },
        { role: 'system', content: '系统提示B' },
        { role: 'user', content: '第一段' },
        { role: 'user', content: '第二段' },
        { role: 'assistant', content: '上一版' },
      ],
      opts()
    ));
    aReq = server.lastRequest;

    server.mode = 'anthropic-error';
    aErr = await catchError(() =>
      collectText(anthropic.stream([{ role: 'user', content: 'x' }], opts()))
    );
  });

  test('拼接 text_delta', () => {
    assert.equal(aText, '三更，林昭醒了。');
  });

  test('请求路径为 /v1/messages', () => {
    assert.equal(aReq.url, '/v1/messages');
  });

  test('带 x-api-key 头', () => {
    assert.equal(aReq.headers['x-api-key'], 'sk-ant-test');
  });

  test('带 anthropic-version 头', () => {
    assert.equal(aReq.headers['anthropic-version'], '2023-06-01');
  });

  test('system 提到顶层字段', () => {
    assert.equal(aReq.body.system, '系统提示A\n\n系统提示B');
  });

  test('messages 中不含 system', () => {
    assert.ok(aReq.body.messages.every((m) => m.role !== 'system'));
  });

  test('相邻同角色消息被合并', () => {
    assert.equal(aReq.body.messages[0].content, '第一段\n\n第二段', JSON.stringify(aReq.body.messages));
  });

  test('首条为 user', () => {
    assert.equal(aReq.body.messages[0].role, 'user');
  });

  test('assistant 消息保留', () => {
    assert.equal(aReq.body.messages[1].role, 'assistant');
  });

  test('Anthropic 错误事件被抛出', () => {
    assert.ok(aErr && aErr.name === 'LlmError');
  });

  test('错误信息含上游原文', () => {
    assert.ok(aErr && aErr.message.includes('overloaded_error'), aErr && aErr.message);
  });
});

// ---------------------------------------------------------------------------

describe('collectText onDelta 回调', () => {
  const deltas = [];
  const fulls = [];
  let result;

  before(async () => {
    server.mode = 'openai-ok';
    result = await collectText(openai.stream([], opts()), {
      onDelta: (d, f) => {
        deltas.push(d);
        fulls.push(f);
      },
    });
  });

  test('onDelta 收到每个分片', () => {
    assert.equal(deltas.length, 4, JSON.stringify(deltas));
  });

  test('onDelta 的 full 是累积值', () => {
    assert.equal(fulls[fulls.length - 1], result);
  });

  test('full 逐步增长', () => {
    assert.ok(fulls.every((f, i) => i === 0 || f.length > fulls[i - 1].length));
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · tool_calls', () => {
  let ok;
  let bad;

  before(async () => {
    server.mode = 'openai-tool-calls';
    ok = await collect(openai.stream([], opts({ tools: [TOOL], toolChoice: 'auto' })));

    server.mode = 'openai-tool-calls-bad-json';
    bad = await collect(openai.stream([], opts({ tools: [TOOL] })));
  });

  test('正文与工具调用分开：text 里没有参数片段', () => {
    assert.equal(ok.text, '我先读一下');
  });

  test('分片按 index 拼成完整参数（id 只在第一片给）', () => {
    assert.deepEqual(ok.toolCalls[0], {
      id: 'call_a',
      name: 'read',
      args: { path: 'plots/001.md' },
      raw: '{"path":"plots/001.md"}',
    });
  });

  test('两个并行调用各自拼对，不串味', () => {
    assert.deepEqual(ok.toolCalls[1], {
      id: 'call_b',
      name: 'search',
      args: { q: '北境' },
      raw: '{"q":"北境"}',
    });
  });

  test('tools 透传给上游，且是平的形状（不包 function 对象）', () => {
    const body = server.lastRequest.body;
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        name: TOOL.name,
        description: TOOL.description,
        parameters: TOOL.parameters,
      },
    ]);
  });

  // 多轮工具调用要把它原样交回去，否则模型接不上「上一步为什么调这个工具」。
  test('reasoning item 被收成思考凭据，不进正文', () => {
    assert.deepEqual(ok.traces, [
      { kind: 'openai', payload: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' } },
    ]);
  });

  test('坏 JSON 不抛：args 为空对象，raw 保留原文', () => {
    assert.deepEqual(bad.toolCalls, [
      { id: 'call_a', name: 'read', args: {}, raw: '{"path":' },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 没有 tools 时不带这两个字段', () => {
  before(async () => {
    server.mode = 'openai-ok';
    await collectText(openai.stream([], opts()));
  });

  // 有些兼容实现见到未知字段会直接 400，stream_options 上已经踩过这个坑。
  test('请求体里没有 tools', () => {
    assert.equal('tools' in server.lastRequest.body, false);
  });

  test('请求体里没有 tool_choice', () => {
    assert.equal('tool_choice' in server.lastRequest.body, false);
  });

  test('stream 恒开', () => {
    assert.equal(server.lastRequest.body.stream, true);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · OpenAI Responses', () => {
  let low;
  let max;
  let off;

  before(async () => {
    server.mode = 'openai-ok';
    await collectText(openai.stream([], opts({ thinking: 'low' })));
    low = server.lastRequest.body;

    await collectText(openai.stream([], opts({ thinking: 'max' })));
    max = server.lastRequest.body;

    await collectText(openai.stream([], opts({ thinking: 'off' })));
    off = server.lastRequest.body;
  });

  test('档位落成 reasoning.effort', () => {
    assert.deepEqual(low.reasoning, { effort: 'low', summary: 'auto' });
  });

  // 界面上只有一个「极限思考」，两家的枚举名不同：这边是 xhigh。
  test('极限档在 OpenAI 这侧是 xhigh', () => {
    assert.equal(max.reasoning.effort, 'xhigh');
  });

  // 没有 summary 就没有思考增量，界面上那段「正在思考」会是空白。
  test('要思考摘要（summary: auto）', () => {
    assert.equal(max.reasoning.summary, 'auto');
  });

  // store: false 时不显式要，推理块回来是不带 encrypted_content 的空壳。
  test('思考开着时要 encrypted_content', () => {
    assert.deepEqual(low.include, ['reasoning.encrypted_content']);
  });

  // 推理模型一律拒收 temperature：带上去就是 400。
  test('思考开着时不带 temperature', () => {
    assert.equal('temperature' in low, false);
  });

  test('关着时既不带 reasoning 也不带 include', () => {
    assert.equal('reasoning' in off, false);
    assert.equal('include' in off, false);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · 上游不认那一档时降级再发', () => {
  let text;
  let bodies;

  before(async () => {
    server.mode = 'openai-effort-400';
    server.requests.length = 0;
    // 模型名与别的用例不同：降级结论按「接口地址 + 模型」记在内存里，
    // 共用一个模型名会让用例之间互相污染。
    const provider = new OpenAiProvider(base, 'picky-model', 'sk-test');
    text = await collectText(provider.stream([], opts({ thinking: 'max' })));
    bodies = server.requests.map((r) => r.body);
  });

  test('两次请求：第一次 xhigh 被拒，第二次降到 high', () => {
    assert.equal(bodies.length, 2, JSON.stringify(bodies.map((b) => b.reasoning)));
    assert.equal(bodies[0].reasoning.effort, 'xhigh');
    assert.equal(bodies[1].reasoning.effort, 'high');
  });

  test('作者拿到的是正常结果，不是一句报错', () => {
    assert.equal(text, '降档后成了');
  });

  test('降级结论记住了：同一个模型的下一次请求直接发 high', async () => {
    server.mode = 'openai-ok';
    const provider = new OpenAiProvider(base, 'picky-model', 'sk-test');
    await collectText(provider.stream([], opts({ thinking: 'max' })));
    assert.equal(server.lastRequest.body.reasoning.effort, 'high');
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · Anthropic', () => {
  let result;
  let body;
  let off;

  before(async () => {
    server.mode = 'anthropic-thinking';
    result = await collect(
      anthropic.stream([{ role: 'user', content: '想一想' }], opts({ thinking: 'max' }))
    );
    body = server.lastRequest.body;

    server.mode = 'anthropic-ok';
    await collectText(anthropic.stream([{ role: 'user', content: 'x' }], opts()));
    off = server.lastRequest.body;
  });

  test('默认走自适应写法', () => {
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  });

  // 界面上那个「极限思考」在这一侧的名字是 max（OpenAI 那侧是 xhigh）。
  test('档位落成 output_config.effort，极限档是 max', () => {
    assert.deepEqual(body.output_config, { effort: 'max' });
  });

  test('思考开着时不带 temperature', () => {
    assert.equal('temperature' in body, false);
  });

  test('关着时不带思考字段，temperature 照常', () => {
    assert.equal('thinking' in off, false);
    assert.equal('output_config' in off, false);
    assert.equal(off.temperature, 0.8);
  });

  test('thinking_delta 走 reasoning，不混进正文', () => {
    assert.equal(result.reasoning, '先想一下');
    assert.equal(result.text, '答案');
  });

  // 签名是整段推理的加密副本，下一轮要原样交回去；没有它的思考块交回去会被拒。
  test('思考块连签名一起收成凭据', () => {
    assert.deepEqual(result.traces, [
      { kind: 'anthropic', payload: { type: 'thinking', thinking: '先想一下', signature: 'SIG==' } },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · 老模型不认自适应时换写法', () => {
  let text;
  let bodies;

  before(async () => {
    server.mode = 'anthropic-adaptive-400';
    server.requests.length = 0;
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    text = await collectText(
      provider.stream(
        [{ role: 'user', content: 'x' }],
        // 输出上限要给足：预算必须小于它，1000 的上限连 1024 的下限都装不下。
        opts({ thinking: 'medium', maxOutputTokens: 16000 })
      )
    );
    bodies = server.requests.map((r) => r.body);
  });

  test('第一次自适应被拒，第二次改用手动思考预算', () => {
    assert.equal(bodies.length, 2, JSON.stringify(bodies.map((b) => b.thinking)));
    assert.equal(bodies[0].thinking.type, 'adaptive');
    assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 10240 });
  });

  // 预算必须小于 max_tokens（思考 token 算在输出上限里），所以留 1024 给正文。
  test('预算按输出上限收紧', async () => {
    server.mode = 'anthropic-ok';
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    await collectText(
      provider.stream(
        [{ role: 'user', content: 'x' }],
        opts({ thinking: 'max', maxOutputTokens: 4000 })
      )
    );
    assert.equal(server.lastRequest.body.thinking.budget_tokens, 4000 - 1024);
  });

  // 上限太小连 1024 的硬下限都留不出来时不带思考字段，而不是发一个必然 400 的请求。
  test('输出上限装不下思考时干脆不带思考字段', async () => {
    server.mode = 'anthropic-ok';
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    await collectText(
      provider.stream([{ role: 'user', content: 'x' }], opts({ thinking: 'max', maxOutputTokens: 1500 }))
    );
    assert.equal('thinking' in server.lastRequest.body, false);
  });

  test('手动预算那条路上带交错思考的 beta 头（有工具时）', async () => {
    server.mode = 'anthropic-ok';
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    await collectText(
      provider.stream(
        [{ role: 'user', content: 'x' }],
        opts({ thinking: 'low', tools: [TOOL], maxOutputTokens: 16000 })
      )
    );
    assert.equal(server.lastRequest.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  });

  test('作者拿到的是正常结果，不是一句报错', () => {
    assert.equal(text, '换写法后成了');
  });
});
