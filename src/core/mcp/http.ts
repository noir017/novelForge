/**
 * MCP 的 Streamable HTTP 传输。**只用标准的 `Request` / `Response`**，Bun 与 Node 都跑得动。
 *
 * 实现的是规范里最小的那一截：
 *
 * - `POST` 一条（或一批）JSON-RPC 消息 → 有请求就回 `application/json`（`tools/call` 见下），只有通知回 202；
 * - `initialize` 的响应带 `Mcp-Session-Id`，之后的请求带着它来；认不出的 id 回 404，
 *   客户端据此重新 `initialize`（服务重启过就是这样）；
 * - `DELETE` 结束会话；
 * - `GET`（服务端主动推的那条 SSE 流）回 405——我们从不主动推东西。
 *
 * 带 `tools/call` 的请求、客户端又收 `text/event-stream` 时回 SSE：一次调用可能跑几分钟（写一章、
 * 等作者点确认），而客户端等响应头有上限（Claude Code 缺省 60 秒，到点报「The operation timed out.」），
 * 等结果还有空闲上限（HTTP 缺省 5 分钟，收到 progress 通知才重新计时）。所以先回响应头，跑的期间
 * 每隔 `HEARTBEAT_MS` 发一条 `notifications/progress`（请求没带 progressToken 就发一行 SSE 注释），
 * 跑完把回复当事件发出去、关流。其余请求照旧回整份 JSON。
 * 连接上的空闲超时由壳关掉（`server.ts` 的 `server.timeout(req, 0)`）。
 *
 * 地址上可以带 `?project=<工程目录>` 指定落到哪个工程（独立版能同时开几个）；不带由壳决定。
 *
 * 没有鉴权，与网页那条 WebSocket 同一套理由：只绑 127.0.0.1。浏览器会带 `Origin`，
 * 这里只放本机同端口的那一个——挡掉恶意网页借浏览器打本机端口（DNS rebinding）。
 * 命令行客户端不带 `Origin`，放过。
 */
import { randomUUID } from 'node:crypto';
import { scoped } from '../runtime/logger';
import {
  JsonRpcMessage,
  JsonRpcResponse,
  McpServer,
  McpSession,
  RPC,
  isRequest,
  rpcError,
} from './server';

const log = scoped('MCP');

const SESSION_HEADER = 'mcp-session-id';

/** SSE 上多久发一次保活：远小于客户端的空闲上限（HTTP 缺省 5 分钟）。 */
export const HEARTBEAT_MS = 15_000;

export interface McpHttpOptions {
  /** 浏览器发来的 `Origin` 认不认。不给就一律放过（测试用）。 */
  allowOrigin?(origin: string | null): boolean;
  /** SSE 保活间隔，缺省 `HEARTBEAT_MS`（测试调小）。 */
  heartbeatMs?: number;
}

export class McpHttpHandler {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly server: McpServer, private readonly opts: McpHttpOptions = {}) {}

  async handle(req: Request): Promise<Response> {
    if (this.opts.allowOrigin && !this.opts.allowOrigin(req.headers.get('origin'))) {
      log.warn('拒绝了一个跨源 MCP 请求', `Origin: ${req.headers.get('origin')}`);
      return new Response('Forbidden origin', { status: 403 });
    }
    switch (req.method) {
      case 'POST':
        return this.post(req);
      case 'DELETE':
        return this.remove(req);
      default:
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } });
    }
  }

  /** 服务停掉时调：还在跑的调用全中断。 */
  closeAll(): void {
    for (const s of this.sessions.values()) {
      s.close();
    }
    this.sessions.clear();
  }

  private async post(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json(rpcError(null, RPC.parseError, '请求体不是合法的 JSON。'), 400);
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    if (messages.length === 0) {
      return json(rpcError(null, RPC.invalidRequest, '空的批量请求。'), 400);
    }

    const initializing = messages.some((m) => m?.method === 'initialize');
    const sid = req.headers.get(SESSION_HEADER);
    let session: McpSession;
    if (initializing) {
      session = new McpSession(randomUUID());
      this.sessions.set(session.id, session);
    } else if (sid) {
      const found = this.sessions.get(sid);
      if (!found) {
        // 规范：认不出的会话回 404，客户端会重新 initialize。
        return json(rpcError(null, RPC.invalidRequest, '会话不存在或已过期，请重新 initialize。'), 404);
      }
      session = found;
    } else {
      // 不带会话 id 的客户端也放过：只是没法按会话省掉重复的状态简报。
      session = new McpSession('');
    }
    // 地址上的 `?project=` 跟着每次请求走：客户端配置里改了地址、不必重新 initialize。
    session.project = new URL(req.url).searchParams.get('project')?.trim() || undefined;

    const headers: Record<string, string> = session.id ? { 'Mcp-Session-Id': session.id } : {};
    const long = messages.some((m) => m?.method === 'tools/call' && isRequest(m));
    if (long && (req.headers.get('accept') ?? '').includes('text/event-stream')) {
      return this.stream(messages, session, req.signal, headers);
    }

    const replies = (
      await Promise.all(messages.map((m) => this.server.dispatch(m, session, req.signal)))
    ).filter((r): r is JsonRpcResponse => r !== undefined);

    if (replies.length === 0) {
      return new Response(null, { status: 202, headers });
    }
    return json(batch ? replies : replies[0], 200, headers);
  }

  /** 先回响应头，跑的期间发保活，跑完一条回复一个事件。 */
  private stream(
    messages: JsonRpcMessage[],
    session: McpSession,
    signal: AbortSignal,
    headers: Record<string, string>
  ): Response {
    const tokens = messages
      .map((m) => (m?.params?._meta as { progressToken?: unknown } | undefined)?.progressToken)
      .filter((t): t is string | number => typeof t === 'string' || typeof t === 'number');
    const encoder = new TextEncoder();
    // 客户端断开时流会被 cancel：与 req.signal 一起当取消信号，哪个先到都中断那次调用。
    const gone = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (chunk: string) => {
          if (!gone.signal.aborted) {
            controller.enqueue(encoder.encode(chunk));
          }
        };
        // Bun 等到第一块正文才把响应头发出去：先发一行注释，响应头当场就到。
        send(': open\n\n');
        let beat = 0;
        timer = setInterval(() => {
          beat++;
          if (tokens.length === 0) {
            send(': running\n\n');
          }
          for (const progressToken of tokens) {
            send(event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: beat, message: '仍在运行' } }));
          }
        }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
        try {
          const replies = await Promise.all(
            messages.map((m) => this.server.dispatch(m, session, AbortSignal.any([signal, gone.signal])))
          );
          for (const r of replies) {
            if (r !== undefined) {
              send(event(r));
            }
          }
        } finally {
          clearInterval(timer);
          if (!gone.signal.aborted) {
            controller.close();
          }
        }
      },
      cancel: () => {
        clearInterval(timer);
        gone.abort();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...headers },
    });
  }

  private remove(req: Request): Response {
    const sid = req.headers.get(SESSION_HEADER);
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session) {
      return new Response(null, { status: 404 });
    }
    session.close();
    this.sessions.delete(session.id);
    log.info(`MCP 会话结束${session.clientName ? `：${session.clientName}` : ''}`);
    return new Response(null, { status: 200 });
  }
}

function event(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function json(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
