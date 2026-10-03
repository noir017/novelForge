/**
 * Novel Forge 的 MCP 入口：工具清单 + 说明 + HTTP 传输，壳只要给出「当前工程的执行端」。
 *
 * ```ts
 * const mcp = createNovelMcp(() => hub.activeController() && createMcpBackend(...));
 * // fetch 里：if (url.pathname === '/mcp') return mcp.handle(req);
 * ```
 */
import { NOVEL_TOOLS } from '../tools/novel';
import { specOf } from '../tools/registry';
import { McpHttpHandler, McpHttpOptions } from './http';
import { MCP_INSTRUCTIONS } from './instructions';
import { McpBackend, McpServer } from './server';

export { McpHttpHandler } from './http';
export type { McpHttpOptions } from './http';
export { McpServer, McpSession, PROTOCOL_VERSIONS } from './server';
export type { McpBackend, McpCallResult } from './server';
export { MCP_INSTRUCTIONS } from './instructions';

/** 挂在独立版服务上的路径。 */
export const MCP_PATH = '/mcp';

/** `serverInfo.version`。只给客户端日志看，不参与任何判断。 */
const SERVER_VERSION = '0.1.0';

export function createNovelMcp(backend: () => McpBackend | undefined, opts: McpHttpOptions = {}): McpHttpHandler {
  const server = new McpServer({
    tools: NOVEL_TOOLS.map(specOf),
    backend,
    version: SERVER_VERSION,
    instructions: MCP_INSTRUCTIONS,
  });
  return new McpHttpHandler(server, opts);
}
