/**
 * MCP 协议层（`src/core/mcp/server.ts` + `http.ts`）：**只测协议，不碰工程。**
 *
 * 执行端是一个假的 `McpBackend`——真的那一份（绑在 `ChatController` 上）在
 * `tests/integration/mcp/backend.test.js`。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | initialize | 版本协商、回会话 id、带上使用说明 |
 * | tools/list | 十二个工具；`costly` / `mutating` 落成 readOnlyHint / destructiveHint |
 * | tools/call | 参数原样转给执行端；出错走 `isError`，不走 JSON-RPC 错误 |
 * | 没打开工程 | 回一句能照着做的话，`isError` |
 * | 状态简报 | 第一次必贴；没变不贴；变了再贴 |
 * | 取消 | `notifications/cancelled` 与连接断开都中断那一次调用 |
 * | HTTP | 通知 202、坏 JSON 400、认不出的会话 404、DELETE 结束会话、GET 405、跨源 403 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mcp = loadModule('src/core/mcp/index.ts');

const URL_ = 'http://127.0.0.1:5000/mcp';

/** 可编程的执行端。`calls` 记下每一次调用，`brief` 可随时改。 */
function fakeBackend() {
  const b = {
    calls: [],
    brief: '# 当前工程\n下一步：写第 1 章细纲',
    reply: (name) => ({ text: `ran ${name}`, isError: false }),
    /** 给了就在调用里等它（测取消）。 */
    hold: undefined,
    backend: {
      call: async (name, args, signal) => {
        b.calls.push({ name, args, signal });
        if (b.hold) {
          await b.hold(signal);
        }
        return b.reply(name, args);
      },
      brief: async () => b.brief,
    },
  };
  return b;
}

function makeHandler({ backend, allowOrigin } = {}) {
  return mcp.createNovelMcp(() => backend, allowOrigin ? { allowOrigin } : {});
}

function post(handler, body, headers = {}) {
  return handler.handle(
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

let nextId = 1;
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: nextId++, method, params });

/** initialize 一次，返回会话 id。 */
async function open(handler) {
  const res = await post(handler, rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } }));
  return res.headers.get('mcp-session-id');
}

async function call(handler, sid, name, args = {}) {
  const res = await post(handler, rpc('tools/call', { name, arguments: args }), sid ? { 'mcp-session-id': sid } : {});
  return (await res.json()).result;
}

describe('initialize', () => {
  test('认得的版本原样回，带会话 id 与说明', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const res = await post(h, rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'x' } }));
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('mcp-session-id'));
    const body = await res.json();
    assert.equal(body.result.protocolVersion, '2025-03-26');
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(body.result.serverInfo.name, 'novel-forge');
    assert.ok(body.result.instructions.includes('generate'), body.result.instructions);
  });

  test('认不出的版本回我们最新的那个', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const body = await (await post(h, rpc('initialize', { protocolVersion: '1999-01-01' }))).json();
    assert.equal(body.result.protocolVersion, mcp.PROTOCOL_VERSIONS[0]);
  });
});

describe('tools/list', () => {
  let tools;
  test('十二个工具，按模型看到的顺序', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const sid = await open(h);
    const body = await (await post(h, rpc('tools/list'), { 'mcp-session-id': sid })).json();
    tools = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(tools), [
      'list',
      'read',
      'search',
      'generate',
      'write',
      'edit',
      'pipeline',
      'summary',
      'characters',
      'extract',
      'book',
      'skills',
    ]);
  });

  test('参数 schema 原样给成 inputSchema', () => {
    assert.equal(tools.read.inputSchema.type, 'object');
    assert.ok(tools.read.inputSchema.properties.path, JSON.stringify(tools.read.inputSchema));
  });

  test('查询只读，生成不只读，写盘有破坏性', () => {
    assert.equal(tools.read.annotations.readOnlyHint, true);
    assert.equal(tools.read.annotations.destructiveHint, false);
    assert.equal(tools.generate.annotations.readOnlyHint, false);
    assert.equal(tools.generate.annotations.destructiveHint, false);
    assert.equal(tools.write.annotations.readOnlyHint, false);
    assert.equal(tools.write.annotations.destructiveHint, true);
  });

  // 工具级的两个标记由动作表推出来：有一个动作调模型就 costly，有一个动作不是 auto 就 mutating。
  // skills 一个模型都不调，但装与绑会改东西——所以不只读，且有破坏性。
  test('带 action 的工具：标记由动作表推出', () => {
    assert.equal(tools.skills.annotations.readOnlyHint, false);
    assert.equal(tools.skills.annotations.destructiveHint, true);
    for (const name of ['pipeline', 'summary', 'characters', 'extract', 'book']) {
      assert.equal(tools[name].annotations.readOnlyHint, false, name);
      assert.equal(tools[name].annotations.destructiveHint, true, name);
    }
  });

  test('带 action 的工具：action 必填且是枚举', () => {
    for (const name of ['pipeline', 'summary', 'characters', 'extract', 'book', 'skills']) {
      const schema = tools[name].inputSchema;
      assert.deepEqual(schema.required, ['action'], name);
      assert.ok(Array.isArray(schema.properties.action.enum), name);
    }
  });

  test('没打开工程也列得出来', async () => {
    const h = makeHandler({ backend: undefined });
    const body = await (await post(h, rpc('tools/list'))).json();
    assert.equal(body.result.tools.length, 12);
  });
});

describe('tools/call', () => {
  test('参数原样转给执行端，结果放进 text 内容块', async () => {
    const b = fakeBackend();
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const r = await call(h, sid, 'read', { path: 'a.md' });
    assert.deepEqual(b.calls.map((c) => [c.name, c.args]), [['read', { path: 'a.md' }]]);
    assert.equal(r.isError, false);
    assert.equal(r.content[0].type, 'text');
    assert.ok(r.content[0].text.startsWith('ran read'), r.content[0].text);
  });

  test('执行端报错走 isError，不是 JSON-RPC 错误', async () => {
    const b = fakeBackend();
    b.reply = () => ({ text: '没有这个文件', isError: true });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const res = await post(h, rpc('tools/call', { name: 'read', arguments: {} }), { 'mcp-session-id': sid });
    const body = await res.json();
    assert.equal(body.error, undefined);
    assert.equal(body.result.isError, true);
    assert.ok(body.result.content[0].text.startsWith('没有这个文件'));
  });

  test('没打开工程：说清楚，isError', async () => {
    const h = makeHandler({ backend: undefined });
    const r = await call(h, undefined, 'read', { path: 'a.md' });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.includes('打开'), r.content[0].text);
  });

  test('缺 name 是参数错误', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const body = await (await post(h, rpc('tools/call', {}))).json();
    assert.equal(body.error.code, -32602);
  });
});

describe('状态简报：变了才贴', () => {
  const b = fakeBackend();
  const h = makeHandler({ backend: b.backend });
  let sid;

  test('会话的第一次调用必贴', async () => {
    sid = await open(h);
    const r = await call(h, sid, 'list');
    assert.ok(r.content[0].text.endsWith(b.brief), r.content[0].text);
  });

  test('没变不贴', async () => {
    const r = await call(h, sid, 'read');
    assert.equal(r.content[0].text, 'ran read');
  });

  test('变了再贴', async () => {
    b.brief = '# 当前工程\n下一步：写第 1 章正文';
    const r = await call(h, sid, 'generate');
    assert.ok(r.content[0].text.endsWith('写第 1 章正文'), r.content[0].text);
  });

  test('另一条会话从头算', async () => {
    const other = await open(h);
    const r = await call(h, other, 'list');
    assert.ok(r.content[0].text.endsWith(b.brief), r.content[0].text);
  });
});

describe('取消', () => {
  test('notifications/cancelled 中断那一次调用', async () => {
    const b = fakeBackend();
    let aborted = false;
    b.hold = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const req = rpc('tools/call', { name: 'generate', arguments: {} });
    const pending = post(h, req, { 'mcp-session-id': sid });
    while (b.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const note = await post(
      h,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req.id } },
      { 'mcp-session-id': sid }
    );
    assert.equal(note.status, 202);
    await pending;
    assert.ok(aborted);
  });

  test('连接断开也中断', async () => {
    const b = fakeBackend();
    let aborted = false;
    b.hold = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const ctrl = new AbortController();
    const pending = h.handle(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
        body: JSON.stringify(rpc('tools/call', { name: 'generate', arguments: {} })),
        signal: ctrl.signal,
      })
    );
    while (b.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ctrl.abort();
    await pending;
    assert.ok(aborted);
  });
});

describe('HTTP', () => {
  const h = makeHandler({ backend: fakeBackend().backend });

  test('只有通知：202，没有正文', async () => {
    const sid = await open(h);
    const res = await post(h, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });

  test('坏 JSON：400 + parse error', async () => {
    const res = await post(h, '{oops');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  test('认不出的会话：404（客户端会重新 initialize）', async () => {
    const res = await post(h, rpc('ping'), { 'mcp-session-id': 'gone' });
    assert.equal(res.status, 404);
  });

  test('批量：一条请求一条回复', async () => {
    const sid = await open(h);
    const res = await post(h, [rpc('ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping')], {
      'mcp-session-id': sid,
    });
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);
    assert.deepEqual(body[0].result, {});
  });

  test('认不出的方法：-32601', async () => {
    const body = await (await post(h, rpc('resources/list'))).json();
    assert.equal(body.error.code, -32601);
  });

  test('DELETE 结束会话，之后它就认不出了', async () => {
    const sid = await open(h);
    const del = await h.handle(new Request(URL_, { method: 'DELETE', headers: { 'mcp-session-id': sid } }));
    assert.equal(del.status, 200);
    const res = await post(h, rpc('ping'), { 'mcp-session-id': sid });
    assert.equal(res.status, 404);
  });

  test('GET（服务端推送流）不支持：405', async () => {
    const res = await h.handle(new Request(URL_, { method: 'GET' }));
    assert.equal(res.status, 405);
  });

  test('跨源请求：403；命令行客户端不带 Origin，放过', async () => {
    const guarded = makeHandler({ backend: fakeBackend().backend, allowOrigin: (o) => !o || o === 'http://127.0.0.1:5000' });
    const evil = await post(guarded, rpc('ping'), { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    const cli = await post(guarded, rpc('ping'));
    assert.equal(cli.status, 200);
  });
});
