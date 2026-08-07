/**
 * LLM provider 的离线验证：起一个本地假服务器，模拟 OpenAI / Anthropic 的
 * SSE 流式响应与各种错误，验证流解析、取消、超时与错误信息。
 *
 * 用法：node scripts/smoke-llm.js
 */
const http = require('http');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- vscode 桩

/** core 侧取消已改 AbortSignal：包一层，用 provider 模块自己的 CancelledError 作 reason。 */
function makeCancelSource() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel() { controller.abort(new providerMod.CancelledError()); },
  };
}

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') {
    return {
      window: {}, workspace: {}, commands: {}, Uri: {},
    };
  }
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const { OpenAiProvider } = loadModule('src/core/llm/openaiProvider.ts');
const { AnthropicProvider } = loadModule('src/core/llm/anthropicProvider.ts');
const providerMod = loadModule('src/core/llm/provider.ts');

// ---------------------------------------------------------------- 假服务器

/** @type {{mode: string, lastRequest: any}} */
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

async function main() {
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  const base = `http://127.0.0.1:${port}/v1`;

  const openai = new OpenAiProvider(base, 'test-model', 'sk-test');
  const anthropic = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-test', 'sk-ant-test');

  console.log('\n== OpenAI provider · 正常流 ==');
  server.mode = 'openai-ok';
  const text = await providerMod.collectStream(openai.chatStream(
    [{ role: 'system', content: '你是作者' }, { role: 'user', content: '续写' }],
    opts()
  ));
  check('拼接出完整文本', text === '雨下了三天，石板路泡得发白。', JSON.stringify(text));
  check('跨块切分的事件被正确拼接', text.includes('三天，'));
  check('注释心跳被忽略', !text.includes('注释'));

  const req = server.lastRequest;
  check('请求路径正确', req.url === '/v1/chat/completions', req.url);
  check('带 Bearer 认证头', req.headers.authorization === 'Bearer sk-test');
  check('stream 为 true', req.body.stream === true);
  check('传递 model', req.body.model === 'test-model');
  check('传递 max_tokens', req.body.max_tokens === 1000);
  check('传递 temperature', req.body.temperature === 0.8);
  check('system 消息保留在 messages 中', req.body.messages[0].role === 'system');
  check('provider label 含模型与主机', openai.label.includes('test-model') && openai.label.includes('127.0.0.1'));

  // 含斜杠的模型名必须**原样**上线。路由型服务商（OpenRouter、my-router 等）
  // 的模型名本就是 `渠道/厂商/模型`，任何一段被吃掉，上游都会回
  // 「has no provider supported」，而那个报错看起来像是模型不存在。
  {
    const nested = new OpenAiProvider(base, 'ms/deepseek-ai/DeepSeek-V4-Flash', 'sk-test');
    await providerMod.collectStream(nested.chatStream([], opts()));
    check('多层斜杠的模型名原样传给上游',
      server.lastRequest.body.model === 'ms/deepseek-ai/DeepSeek-V4-Flash',
      JSON.stringify(server.lastRequest.body.model));
  }

  console.log('\n== OpenAI provider · 边界情况 ==');
  server.mode = 'openai-crlf';
  check('CRLF 分隔的 SSE', (await providerMod.collectStream(openai.chatStream([], opts()))) === 'CRLF分隔');

  server.mode = 'openai-reasoning';
  check('忽略 reasoning_content', (await providerMod.collectStream(openai.chatStream([], opts()))) === '正文');

  server.mode = 'openai-garbage';
  check('跳过非 JSON 行继续解析', (await providerMod.collectStream(openai.chatStream([], opts()))) === '仍能继续');

  server.mode = 'openai-mid-error';
  let caught;
  try {
    await providerMod.collectStream(openai.chatStream([], opts()));
  } catch (e) {
    caught = e;
  }
  check('流中途的 error 事件被抛出', caught && caught.name === 'LlmError', caught && caught.name);
  check('错误信息含上游原文', caught && caught.message.includes('上游过载'), caught && caught.message);

  console.log('\n== OpenAI provider · HTTP 错误 ==');
  for (const [mode, expect] of [
    ['http-401', 'API Key 可能无效'],
    ['http-404', '接口地址或模型名可能填错'],
    ['http-429', '触发限流'],
  ]) {
    server.mode = mode;
    let err;
    try {
      await providerMod.collectStream(openai.chatStream([], opts()));
    } catch (e) {
      err = e;
    }
    check(`${mode} 抛出 LlmError`, err && err.name === 'LlmError');
    check(`${mode} 附带排查提示`, err && err.message.includes(expect), err && err.message);
  }

  console.log('\n== OpenAI provider · 取消与超时 ==');
  server.mode = 'slow';
  {
    const src = makeCancelSource();
    const stream = openai.chatStream([], opts({ signal: src.signal }));
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    check('取消前已收到首个分片', first.value === '慢', JSON.stringify(first.value));
    src.cancel();
    let err;
    try {
      await iter.next();
    } catch (e) {
      err = e;
    }
    check('取消后抛 CancelledError', err && err.name === 'CancelledError', err && err.name);
  }

  {
    server.mode = 'slow';
    let err;
    try {
      await providerMod.collectStream(openai.chatStream([], opts({ timeoutMs: 300 })));
    } catch (e) {
      err = e;
    }
    check('超时抛 LlmError', err && err.name === 'LlmError', err && err.name);
    check('超时信息提示可调设置', err && err.message.includes('requestTimeoutMs'), err && err.message);
  }

  {
    // 已取消的 signal 传进来时应立刻失败，不发请求
    server.mode = 'openai-ok';
    const src = makeCancelSource();
    src.cancel();
    let err;
    try {
      await providerMod.collectStream(openai.chatStream([], opts({ signal: src.signal })));
    } catch (e) {
      err = e;
    }
    check('预先取消的 signal 立即抛 CancelledError', err && err.name === 'CancelledError', err && err.name);
  }

  console.log('\n== Anthropic provider ==');
  server.mode = 'anthropic-ok';
  const aText = await providerMod.collectStream(anthropic.chatStream(
    [
      { role: 'system', content: '系统提示A' },
      { role: 'system', content: '系统提示B' },
      { role: 'user', content: '第一段' },
      { role: 'user', content: '第二段' },
      { role: 'assistant', content: '上一版' },
    ],
    opts()
  ));
  check('拼接 text_delta', aText === '三更，林昭醒了。', JSON.stringify(aText));
  const aReq = server.lastRequest;
  check('请求路径为 /v1/messages', aReq.url === '/v1/messages', aReq.url);
  check('带 x-api-key 头', aReq.headers['x-api-key'] === 'sk-ant-test');
  check('带 anthropic-version 头', aReq.headers['anthropic-version'] === '2023-06-01');
  check('system 提到顶层字段', aReq.body.system === '系统提示A\n\n系统提示B', JSON.stringify(aReq.body.system));
  check('messages 中不含 system', aReq.body.messages.every((m) => m.role !== 'system'));
  check('相邻同角色消息被合并', aReq.body.messages[0].content === '第一段\n\n第二段',
    JSON.stringify(aReq.body.messages));
  check('首条为 user', aReq.body.messages[0].role === 'user');
  check('assistant 消息保留', aReq.body.messages[1].role === 'assistant');

  server.mode = 'anthropic-error';
  let aErr;
  try {
    await providerMod.collectStream(anthropic.chatStream([{ role: 'user', content: 'x' }], opts()));
  } catch (e) {
    aErr = e;
  }
  check('Anthropic 错误事件被抛出', aErr && aErr.name === 'LlmError');
  check('错误信息含上游原文', aErr && aErr.message.includes('overloaded_error'), aErr && aErr.message);

  console.log('\n== collectStream onDelta 回调 ==');
  {
    server.mode = 'openai-ok';
    const deltas = [];
    const fulls = [];
    const result = await providerMod.collectStream(openai.chatStream([], opts()), (d, f) => {
      deltas.push(d);
      fulls.push(f);
    });
    check('onDelta 收到每个分片', deltas.length === 4, `got ${deltas.length}: ${JSON.stringify(deltas)}`);
    check('onDelta 的 full 是累积值', fulls[fulls.length - 1] === result);
    check('full 逐步增长', fulls.every((f, i) => i === 0 || f.length > fulls[i - 1].length));
  }

  httpServer.close();
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  httpServer.close();
  process.exit(1);
});
