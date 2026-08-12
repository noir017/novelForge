/**
 * LLM provider 的流式解析：跨块切分、CRLF、心跳注释、非 JSON 行、流中错误、
 * 取消、超时、HTTP 错误信息，以及 Anthropic 的 system 抽取与相邻消息合并。
 * 迁自 scripts/smoke-llm.js（38 个 check 调用点 → 42 条用例，HTTP 错误那两条在
 * 三个 mode 上循环）。
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

/** 服务端行为开关：每个用例在自己的 before() 里切 mode，再看 lastRequest。 */
const server = { mode: 'openai-ok', lastRequest: null };

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    server.lastRequest = {
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };

    const sse = () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    };

    switch (server.mode) {
      case 'openai-ok': {
        sse();
        // 故意把事件切成不规则的块，检验缓冲区拼接。
        res.write('data: {"choices":[{"delta":{"content":"雨下了"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"conte');
        res.write('nt":"三天，"}}]}\n\ndata: {"choices":[{"delta":{"content":"石板路"}}]}\n\n');
        res.write(': 这是一条注释心跳\n\n');
        res.write('data: {"choices":[{"delta":{}}]}\n\n'); // 空 delta
        res.write('data: {"choices":[{"delta":{"content":"泡得发白。"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-crlf': {
        sse();
        res.write('data: {"choices":[{"delta":{"content":"CRLF"}}]}\r\n\r\n');
        res.write('data: {"choices":[{"delta":{"content":"分隔"}}]}\r\n\r\n');
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }
      case 'openai-reasoning': {
        sse();
        // DeepSeek reasoner 风格：先吐 reasoning_content，应被忽略
        res.write('data: {"choices":[{"delta":{"reasoning_content":"我在思考"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"正文"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-garbage': {
        sse();
        res.write('data: 这不是 JSON\n\n');
        res.write('data: {"choices":[{"delta":{"content":"仍能继续"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-mid-error': {
        sse();
        res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n');
        res.write('data: {"error":{"message":"上游过载"}}\n\n');
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
        res.write('data: {"choices":[{"delta":{"content":"慢"}}]}\n\n');
        // 不结束，用于测试取消与超时
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

let vs;
let providerMod;
let OpenAiProvider;
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
  });
  providerMod = bundle.provider;
  OpenAiProvider = bundle.openai.OpenAiProvider;

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
  base = `http://127.0.0.1:${port}/v1`;

  openai = new OpenAiProvider(base, 'test-model', 'sk-test');
  anthropic = new bundle.anthropic.AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-test', 'sk-ant-test');
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
    text = await providerMod.collectStream(openai.chatStream(
      [{ role: 'system', content: '你是作者' }, { role: 'user', content: '续写' }],
      opts()
    ));
    // 必须在下面那次请求之前抓下来：lastRequest 只留最后一条。
    req = server.lastRequest;

    // 含斜杠的模型名必须**原样**上线。路由型服务商（OpenRouter、my-router 等）
    // 的模型名本就是 `渠道/厂商/模型`，任何一段被吃掉，上游都会回
    // 「has no provider supported」，而那个报错看起来像是模型不存在。
    const nested = new OpenAiProvider(base, 'ms/deepseek-ai/DeepSeek-V4-Flash', 'sk-test');
    await providerMod.collectStream(nested.chatStream([], opts()));
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
    assert.equal(req.url, '/v1/chat/completions');
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

  test('传递 max_tokens', () => {
    assert.equal(req.body.max_tokens, 1000);
  });

  test('传递 temperature', () => {
    assert.equal(req.body.temperature, 0.8);
  });

  test('system 消息保留在 messages 中', () => {
    assert.equal(req.body.messages[0].role, 'system');
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
    crlf = await providerMod.collectStream(openai.chatStream([], opts()));

    server.mode = 'openai-reasoning';
    reasoning = await providerMod.collectStream(openai.chatStream([], opts()));

    server.mode = 'openai-garbage';
    garbage = await providerMod.collectStream(openai.chatStream([], opts()));

    server.mode = 'openai-mid-error';
    caught = await catchError(() => providerMod.collectStream(openai.chatStream([], opts())));
  });

  test('CRLF 分隔的 SSE', () => {
    assert.equal(crlf, 'CRLF分隔');
  });

  test('忽略 reasoning_content', () => {
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
        err = await catchError(() => providerMod.collectStream(openai.chatStream([], opts())));
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
      const stream = openai.chatStream([], opts({ signal: src.signal }));
      const iter = stream[Symbol.asyncIterator]();
      first = await iter.next();
      src.cancel();
      cancelErr = await catchError(() => iter.next());
    }

    server.mode = 'slow';
    timeoutErr = await catchError(() =>
      providerMod.collectStream(openai.chatStream([], opts({ timeoutMs: 300 })))
    );

    // 已取消的 signal 传进来时应立刻失败，不发请求
    server.mode = 'openai-ok';
    const src = makeCancelSource();
    src.cancel();
    preCancelledErr = await catchError(() =>
      providerMod.collectStream(openai.chatStream([], opts({ signal: src.signal })))
    );
  });

  test('取消前已收到首个分片', () => {
    assert.equal(first.value, '慢');
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

describe('Anthropic provider', () => {
  let aText;
  let aReq;
  let aErr;

  before(async () => {
    server.mode = 'anthropic-ok';
    aText = await providerMod.collectStream(anthropic.chatStream(
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
      providerMod.collectStream(anthropic.chatStream([{ role: 'user', content: 'x' }], opts()))
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

describe('collectStream onDelta 回调', () => {
  const deltas = [];
  const fulls = [];
  let result;

  before(async () => {
    server.mode = 'openai-ok';
    result = await providerMod.collectStream(openai.chatStream([], opts()), (d, f) => {
      deltas.push(d);
      fulls.push(f);
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
