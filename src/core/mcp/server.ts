/**
 * MCP server：**把 `tools/` 那七个工具端给外部 agent**（Claude Code、Codex……）。
 *
 * 这一层只懂协议：JSON-RPC 的那几个方法、会话、取消。它不认识 `Workspace`、
 * `DraftStore`、任何一个具体工具——工具清单是一份 `ToolSpec[]`，执行交给
 * {@link McpBackend}（[controller/mcp.ts](../controller/mcp.ts) 绑在当前工程上的那一份）。
 * 传输在 [http.ts](http.ts)。
 *
 * ## 支持的方法
 *
 * | 方法 | 做什么 |
 * |---|---|
 * | `initialize` | 协商版本，回 `instructions`（怎么用这几个工具） |
 * | `ping` | 回 `{}` |
 * | `tools/list` | 七个工具，带 `readOnlyHint` / `destructiveHint` |
 * | `tools/call` | 执行；出错照 MCP 的约定回 `isError`，不回 JSON-RPC 错误 |
 * | `notifications/cancelled` | 中断那一次调用（生成会停在半路） |
 *
 * 没有 resources / prompts / sampling：用不上，多声明一项能力就多一处宿主会来问的东西。
 *
 * ## 状态简报跟着工具结果走（第 20 条）
 *
 * MCP 没有「每回合往 system 里注入」这个口子，于是状态机给出的那份简报贴在工具结果
 * 末尾——**只在它变了的时候贴**：会话的第一次调用必贴，之后与上一次贴出去的那份逐字比，
 * 一样就不贴。连读十份文件不会被同一段简报刷十遍，
 * 而写完一章之后下一次调用一定看得到新的「下一步」。没有 `status` 工具的理由照旧：
 * 状态白送，不给模型「要不要查一下」的选择。
 */
import type { ToolSpec } from '../tools/types';
import { describeError, scoped } from '../runtime/logger';

const log = scoped('MCP');

/** 认得的协议版本，新的在前。客户端要的不在表里时回第一个（规范的协商方式）。 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 一次 `tools/call` 的结果。 */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

/**
 * 绑在某一个工程上的执行端。**每次调用现取**（{@link McpServerOptions.backend}）：
 * 作者可能在网页上换了工程，MCP 会话不跟着重连。
 */
export interface McpBackend {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  /** 现在这本书走到哪了（第 20 条的那份简报）。 */
  brief(): Promise<string>;
}

export interface McpServerOptions {
  /** 工具清单。与工程无关，没打开工程时 `tools/list` 照样回得出来。 */
  tools: ToolSpec[];
  /** 当前工程的执行端。没打开工程时回 undefined。 */
  backend(): McpBackend | undefined;
  version: string;
  instructions: string;
}

// ---------------------------------------------------------------- JSON-RPC

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 带 `id` 和 `method` 的是请求；只有 `method` 的是通知；只有 `id` 的是客户端回的响应。 */
export function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

// ---------------------------------------------------------------- 会话

/** 一条 MCP 会话。`initialize` 时建，DELETE 或服务停掉时没。 */
export class McpSession {
  /** 上一次贴出去的简报。逐字比，一样就不再贴。 */
  lastBrief?: string;
  /** 还在跑的调用，`notifications/cancelled` 按请求 id 找到它。 */
  readonly inflight = new Map<JsonRpcId, AbortController>();
  clientName = '';

  constructor(readonly id: string) {}

  /** 会话没了：还在跑的一并中断，不留一个没人收结果的生成。 */
  close(): void {
    for (const ctrl of this.inflight.values()) {
      ctrl.abort();
    }
    this.inflight.clear();
  }
}

// ---------------------------------------------------------------- 服务

export class McpServer {
  constructor(private readonly opts: McpServerOptions) {}

  /**
   * 处理一条消息。通知与客户端回的响应返回 undefined（HTTP 那一层据此回 202）。
   * **绝不抛**：任何异常都变成一条 JSON-RPC 错误。
   */
  async dispatch(
    msg: JsonRpcMessage,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<JsonRpcResponse | undefined> {
    if (!msg || typeof msg !== 'object' || (msg.jsonrpc !== undefined && msg.jsonrpc !== '2.0')) {
      return rpcError(null, RPC.invalidRequest, '不是一条 JSON-RPC 2.0 消息。');
    }
    if (typeof msg.method !== 'string') {
      // 客户端回给我们的响应。我们从不发请求，收到了也无事可做。
      return undefined;
    }
    if (!isRequest(msg)) {
      this.notify(msg.method, msg.params ?? {}, session);
      return undefined;
    }
    const id = msg.id as JsonRpcId;
    try {
      return { jsonrpc: '2.0', id, result: await this.request(id, msg.method, msg.params ?? {}, session, signal) };
    } catch (err) {
      if (err instanceof RpcFailure) {
        return rpcError(id, err.code, err.message);
      }
      log.error(`处理 ${msg.method} 失败：${describeError(err)}`, err);
      return rpcError(id, -32603, describeError(err));
    }
  }

  private notify(method: string, params: Record<string, unknown>, session: McpSession): void {
    if (method === 'notifications/cancelled') {
      const requestId = params.requestId as JsonRpcId | undefined;
      const ctrl = requestId === undefined ? undefined : session.inflight.get(requestId);
      if (ctrl) {
        log.info('客户端取消了一次调用', `请求 ${String(requestId)}`);
        ctrl.abort();
      }
    }
    // notifications/initialized 之类：没有要做的事。
  }

  private async request(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params, session);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.opts.tools.map(toMcpTool) };
      case 'tools/call':
        return this.callTool(id, params, session, signal);
      default:
        throw new RpcFailure(RPC.methodNotFound, `不支持 ${method}。`);
    }
  }

  private initialize(params: Record<string, unknown>, session: McpSession): unknown {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const client = params.clientInfo as { name?: unknown; version?: unknown } | undefined;
    session.clientName = typeof client?.name === 'string' ? client.name : '';
    log.info(`MCP 客户端已连接${session.clientName ? `：${session.clientName}` : ''}`, `协议 ${asked || '（未声明）'}`);
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'novel-forge', version: this.opts.version },
      instructions: this.opts.instructions,
    };
  }

  private async callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) {
      throw new RpcFailure(RPC.invalidParams, 'tools/call 缺 name。');
    }
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    const backend = this.opts.backend();
    if (!backend) {
      return toCallResult({ text: 'Novel Forge 现在没有打开任何小说工程。请作者先在 Novel Forge 里打开一个工程。', isError: true });
    }

    // 两条取消的路：客户端发 `notifications/cancelled`，或者 HTTP 连接断了。
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    if (signal?.aborted) {
      ctrl.abort();
    } else {
      signal?.addEventListener('abort', relay, { once: true });
    }
    session.inflight.set(id, ctrl);
    try {
      const result = await backend.call(name, args, ctrl.signal);
      return toCallResult({ ...result, text: await this.withBrief(result.text, backend, session) });
    } finally {
      session.inflight.delete(id);
      signal?.removeEventListener('abort', relay);
    }
  }

  /** 简报变了才贴（见文件头）。取简报本身失败不连累这一次调用的结果。 */
  private async withBrief(text: string, backend: McpBackend, session: McpSession): Promise<string> {
    let brief: string;
    try {
      brief = await backend.brief();
    } catch (err) {
      log.warn('MCP 状态简报生成失败', describeError(err));
      return text;
    }
    if (!brief || brief === session.lastBrief) {
      return text;
    }
    session.lastBrief = brief;
    return `${text}\n\n${brief}`;
  }
}

class RpcFailure extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function toCallResult(r: McpCallResult): unknown {
  return { content: [{ type: 'text', text: r.text }], isError: r.isError };
}

/**
 * `ToolSpec` → MCP 的一条工具声明。`costly` / `mutating` 只是事实（见 `tools/types.ts`），
 * 落成规范里的两条提示：宿主据此决定要不要先问用户。
 */
export function toMcpTool(spec: ToolSpec): unknown {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters,
    annotations: {
      readOnlyHint: !spec.costly && !spec.mutating,
      destructiveHint: !!spec.mutating,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}
