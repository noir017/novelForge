/**
 * MCP 的 Streamable HTTP 传输。**只用标准的 `Request` / `Response`**，Bun 与 Node 都跑得动。
 *
 * 实现的是规范里最小的那一截：
 *
 * - `POST` 一条（或一批）JSON-RPC 消息 → 有请求就回 `application/json`，只有通知回 202；
 * - `initialize` 的响应带 `Mcp-Session-Id`，之后的请求带着它来；认不出的 id 回 404，
 *   客户端据此重新 `initialize`（服务重启过就是这样）；
 * - `DELETE` 结束会话；
 * - `GET`（服务端主动推的那条 SSE 流）回 405——我们从不主动推东西。
 *
 * 不回 SSE：一次 `tools/call` 可能跑几分钟（写一章），那期间什么都不推，等它跑完一次
 * 回整份 JSON。连接上的空闲超时由壳关掉（`server.ts` 的 `server.timeout(req, 0)`）。
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
  rpcError,
} from './server';

const log = scoped('MCP');

const SESSION_HEADER = 'mcp-session-id';

export interface McpHttpOptions {
  /** 浏览器发来的 `Origin` 认不认。不给就一律放过（测试用）。 */
  allowOrigin?(origin: string | null): boolean;
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

    const replies = (
      await Promise.all(messages.map((m) => this.server.dispatch(m, session, req.signal)))
    ).filter((r): r is JsonRpcResponse => r !== undefined);

    const headers: Record<string, string> = session.id ? { 'Mcp-Session-Id': session.id } : {};
    if (replies.length === 0) {
      return new Response(null, { status: 202, headers });
    }
    return json(batch ? replies : replies[0], 200, headers);
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

function json(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
