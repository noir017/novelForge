/**
 * 独立版在 node 上跑（Android 壳的内置服务端就是这样跑的）。
 *
 * 两层：
 * 1. `serveNode`：node:http + ws 转成照 `Bun.serve` 摆的形状，几处要和 Bun 对齐的行为逐条钉住
 *    ——流式响应边到边写、客户端断开要 abort `req.signal`、升级被拒回真的 HTTP 状态、处理器抛了服务还在。
 * 2. 整个独立版：照 Android 构建同一条路（scripts/build-android-server.js）打成单文件，子进程里用 node 起，
 *    走一遍令牌登录、页面、WebSocket（含跨源拒绝）与 MCP。前端资源用占位（见那个脚本的说明）。
 *
 * e2e（tests/e2e/standalone/）只在 Bun 下跑，覆盖不到 node 这一半，所以有这一份。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { loadModule } = require('../../helpers/load');
const { bundleServer } = require('../../../scripts/build-android-server');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 开一条 WS，等它连上或被拒。被拒时给出 HTTP 状态码。 */
function openWs(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.once('error', (err) => resolve({ error: err }));
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (m) => resolve(m.toString())));
}

describe('serveNode', () => {
  const { serveNode } = loadModule('src/shells/standalone/nodeServe.ts');
  let served;
  let base;
  const events = [];
  /** 流式用例里「客户端已经收到第一块」的信号，收到之前服务端不放第二块。 */
  let releaseSecond;
  let aborted;

  before(async () => {
    const port = await freePort();
    served = await serveNode({
      port,
      hostname: '127.0.0.1',
      async fetch(req, ctl) {
        const url = new URL(req.url);
        switch (url.pathname) {
          case '/hello': {
            const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
            headers.append('set-cookie', 'a=1; Path=/');
            headers.append('set-cookie', 'b=2; Path=/');
            return new Response(`你好 ${req.method} ${ctl.port}`, { status: 201, headers });
          }
          case '/form': {
            const form = await req.formData();
            return new Response(`token=${form.get('token')}`);
          }
          case '/stream': {
            const second = new Promise((r) => (releaseSecond = r));
            let step = 0;
            const body = new ReadableStream({
              async pull(controller) {
                step++;
                if (step === 1) {
                  controller.enqueue(new TextEncoder().encode('first;'));
                } else if (step === 2) {
                  await second;
                  controller.enqueue(new TextEncoder().encode('second'));
                } else {
                  controller.close();
                }
              },
            });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          }
          case '/hang': {
            aborted = new Promise((r) => req.signal.addEventListener('abort', () => r(true)));
            const body = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('waiting'));
              },
            });
            return new Response(body);
          }
          case '/boom':
            throw new Error('故意的');
          case '/ws':
            if (req.headers.get('origin') === 'http://evil.example') {
              return new Response('Forbidden origin', { status: 403 });
            }
            ctl.upgrade(req, { data: { project: url.searchParams.get('project') } });
            return undefined;
          default:
            return new Response('Not Found', { status: 404 });
        }
      },
      websocket: {
        open: (ws) => events.push(['open', ws.data]),
        message: (ws, text) => {
          events.push(['message', text]);
          if (text === 'throw') {
            throw new Error('处理器炸了');
          }
          ws.send(`echo:${text}`);
        },
        close: () => events.push(['close']),
      },
    });
    base = `http://127.0.0.1:${served.port}`;
  });

  after(() => served?.stop());

  test('普通响应：状态码、正文、端口与多条 set-cookie 原样带出去', async () => {
    const res = await fetch(`${base}/hello`);
    assert.equal(res.status, 201);
    assert.equal(await res.text(), `你好 GET ${served.port}`);
    assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  });

  test('请求体：表单读得出来（登录页就是这样交令牌的）', async () => {
    const res = await fetch(`${base}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=abc&next=%2F',
    });
    assert.equal(await res.text(), 'token=abc');
  });

  test('流式响应边到边写：第二块还没产出，第一块已经到了客户端', async () => {
    const res = await fetch(`${base}/stream`);
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first;');
    releaseSecond();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.equal(rest, 'second');
  });

  test('客户端断开时 req.signal 被 abort（MCP 靠它取消调用）', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/hang`, { signal: ac.signal });
    await res.body.getReader().read();
    ac.abort();
    assert.equal(await aborted, true);
  });

  test('处理器抛了回 500，服务还在', async () => {
    assert.equal((await fetch(`${base}/boom`)).status, 500);
    assert.equal((await fetch(`${base}/hello`)).status, 201);
  });

  test('WebSocket：升级时给的 data 带进 open，收发与关闭都回调', async () => {
    events.length = 0;
    const { ws } = await openWs(`ws://127.0.0.1:${served.port}/ws?project=书`);
    assert.ok(ws, '没连上');
    ws.send('throw');
    ws.send('你好');
    assert.equal(await nextMessage(ws), 'echo:你好');
    const closed = new Promise((r) => ws.once('close', r));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events, [['open', { project: '书' }], ['message', 'throw'], ['message', '你好'], ['close']]);
  });

  test('升级被拒：客户端拿到 fetch 回的那个状态码', async () => {
    const { status } = await openWs(`ws://127.0.0.1:${served.port}/ws`, { origin: 'http://evil.example' });
    assert.equal(status, 403);
  });

  test('端口被占时抛出来（main.ts 据此顺延端口）', async () => {
    await assert.rejects(
      serveNode({ port: served.port, hostname: '127.0.0.1', fetch: () => undefined, websocket: {} }),
      /EADDRINUSE/
    );
  });
});

describe('独立版打成 node 单文件后能跑', () => {
  const TOKEN = 'node-runtime-test-token-0123';
  let dir;
  let child;
  let port;
  let base;
  let cookie;
  let output = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-node-server-'));
    const outfile = path.join(dir, 'server.cjs');
    await bundleServer({ outfile, stubMedia: true });
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    child = spawn(process.execPath, [outfile, '--port', String(port), '--no-open'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NOVELFORGE_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务 15 秒没起来：${output}`)), 15000);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('服务已启动')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`服务退出了（${code}）：${output}`));
      });
    });
  });

  after(() => {
    child?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('没登录：页面回 401 登录页', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 401);
    assert.match(await res.text(), /name="token"/);
  });

  test('登录：交令牌换 cookie，303 跳回', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}&next=%2F`,
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    cookie = res.headers.getSetCookie()[0].split(';')[0];
    assert.match(cookie, /^nf_session=/);
  });

  test('带 cookie：拿到页面', async () => {
    const res = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/);
  });

  test('WebSocket：同源带 cookie 连得上、一连上就推状态；跨源 403', async () => {
    const ok = await openWs(`ws://127.0.0.1:${port}/ws`, { cookie, origin: base });
    assert.ok(ok.ws, `没连上：${ok.status ?? ok.error}`);
    const first = JSON.parse(await nextMessage(ok.ws));
    assert.equal(typeof first.type, 'string');
    ok.ws.close();
    const evil = await openWs(`ws://127.0.0.1:${port}/ws`, { cookie, origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
  });

  test('MCP：带令牌能 initialize，不带 401', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${TOKEN}` }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.serverInfo.name, 'novel-forge');
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body })).status, 401);
  });
});
