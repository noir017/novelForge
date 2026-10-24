/**
 * node 上的监听：`node:http` 接 HTTP，`ws` 接 WebSocket 升级，把它们转成 [serve.ts](serve.ts) 那套
 * 照 `Bun.serve` 摆的形状。只有没有 Bun 的地方走这里——眼下就是 Android 壳（内置 Termux 编的 node）。
 *
 * 几处要对齐 Bun 的行为：
 * - **客户端断开要能取消**：MCP 的一次调用靠 `req.signal` 知道对面走了（`core/mcp/http.ts`），
 *   这里在响应没写完就断开时 abort 它。
 * - **流式响应边到边写**：MCP 的 SSE 一条一条推，头先发出去，背压时等 drain。
 * - **升级被拒要回一个真的 HTTP 响应**：`fetch` 对 `/ws` 回 401 / 403 时，把它写回裸 socket 再关。
 * - **一个处理器抛了不能带走整个服务**：Bun 里 WebSocket 回调抛错只打一行，node 里没接住的 rejection 会让进程退出
 *   ——手机上那就是服务没了、页面一直重连。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { describeError, scoped } from '../../core/runtime/logger';
import type { ServeControl, ServeSpec, Served, ServerSocket } from './serve';

const log = scoped('服务');

let rejectionGuard = false;

export function serveNode(spec: ServeSpec): Promise<Served> {
  if (!rejectionGuard) {
    rejectionGuard = true;
    process.on('unhandledRejection', (err) => log.error(`未处理的异常：${describeError(err)}`, err));
  }

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let port = spec.port;

  // node 的 http 服务缺省没有空闲超时（`server.timeout` 为 0），一次跑几分钟的 MCP 调用不会被掐，
  // Bun 那边才需要对 /mcp 单独关掉；这里 `timeout` 什么都不用做。
  const control = (onUpgrade?: (data: unknown) => void): ServeControl => ({
    get port() {
      return port;
    },
    upgrade: (_req, options) => {
      if (!onUpgrade) {
        return false;
      }
      onUpgrade(options?.data);
      return true;
    },
    timeout: () => undefined,
  });

  server.on('request', (req, res) => {
    void (async () => {
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          gone.abort();
        }
      });
      let response: Response | undefined;
      try {
        response = await spec.fetch(toRequest(req, port, gone.signal), control());
      } catch (err) {
        log.error(`处理请求失败：${req.method} ${req.url}：${describeError(err)}`, err);
        response = new Response('Internal Server Error', { status: 500 });
      }
      await sendResponse(res, response ?? new Response('Not Found', { status: 404 }));
    })();
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    void (async () => {
      let upgraded = false;
      let data: unknown;
      let response: Response | undefined;
      try {
        response = await spec.fetch(
          toRequest(req, port),
          control((d) => {
            upgraded = true;
            data = d;
          })
        );
      } catch (err) {
        log.error(`处理 WebSocket 握手失败：${describeError(err)}`, err);
        response = new Response('Internal Server Error', { status: 500 });
      }
      if (upgraded && !response) {
        wss.handleUpgrade(req, socket, head, (ws) => attach(ws, data));
        return;
      }
      await refuseUpgrade(socket, response ?? new Response('Not Found', { status: 404 }));
    })();
  });

  const attach = (ws: WebSocket, data: unknown): void => {
    const sock: ServerSocket = {
      send: (text) => ws.send(text),
      close: () => ws.close(),
      data,
    };
    // 没人接的 'error' 会被 EventEmitter 当异常抛出来；出错之后 'close' 照样会来，收尾在那里做。
    ws.on('error', () => undefined);
    spec.websocket.open(sock);
    ws.on('message', (raw) => {
      Promise.resolve()
        .then(() => spec.websocket.message(sock, raw.toString()))
        .catch((err: unknown) => log.error(`处理网页消息失败：${describeError(err)}`, err));
    });
    ws.on('close', () => spec.websocket.close(sock));
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.port, spec.hostname, () => {
      server.off('error', reject);
      server.on('error', (err) => log.error(`服务出错：${describeError(err)}`, err));
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop: () => {
          for (const ws of wss.clients) {
            ws.terminate();
          }
          wss.close();
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

function toRequest(req: http.IncomingMessage, port: number, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const method = req.method ?? 'GET';
  const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url ?? '/'}`;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // `duplex` 是流式请求体必须给的（undici 的要求），lib.dom 的 RequestInit 里还没有这一项。
  const init = {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: 'half',
  } as RequestInit;
  return new Request(url, init);
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') {
      res.setHeader(key, value);
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    res.setHeader('set-cookie', cookies);
  }
  if (!response.body) {
    res.end();
    return;
  }
  // SSE 要先把头发出去：第一条事件可能要等几秒，客户端在这之前一直以为没连上。
  res.flushHeaders();
  const reader = response.body.getReader();
  res.on('close', () => {
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) {
        break;
      }
      if (!res.write(value)) {
        await drained(res);
      }
    }
  } catch {
    // 客户端断了，或响应体那一头出错：都没有可以再写给谁的了。
  }
  res.end();
}

/** 等到能接着写，或者连接已经没了（那时 drain 永远不会来）。 */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

async function refuseUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.text());
  const head = [
    `HTTP/1.1 ${response.status} ${http.STATUS_CODES[response.status] ?? ''}`,
    'Connection: close',
    `Content-Type: ${response.headers.get('content-type') ?? 'text/plain; charset=utf-8'}`,
    `Content-Length: ${body.length}`,
    '',
    '',
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(head), body]));
}
