/**
 * 独立版 Web 服务：静态页 + /ws WebSocket。Bun 下是 `Bun.serve`，没有 Bun 的地方（Android 壳里的 node）
 * 走 `node:http` + `ws`，两边的差别收在 [serve.ts](serve.ts)，路由与收发只在这里写一份。
 * 缺省只绑 127.0.0.1、无鉴权——服务本机作者。部署到服务器时绑别的地址、配上令牌，
 * 规则与理由见 [auth.ts](auth.ts)。
 *
 * 工程由 WorkspaceHub 持有：一个进程同时开着几个，每个窗口（WebSocket）各绑一个或者空着，
 * 窗口网址上的 `?project=` 说它开的是哪个。ChatController 仍然一对一绑一份 NovelProject，
 * 没有工程时不造假实例。
 */
import { initHost } from '../../core/host';
import { setTaskOwnerResolver } from '../../core/runtime/progress';
import { initSecrets } from '../../core/llm/registry';
import {
  addLogSink,
  describeError,
  formatLogEntry,
  scoped,
  setSinkLevel,
} from '../../core/runtime/logger';
import { InMessage, OutMessage } from '../../core/protocol';
import { MCP_PATH, createNovelMcp } from '../../core/mcp';
import { FileConfigStore, FileSecretStore } from '../../core/stores';
import { PRODUCT_VERSION, assetBytes } from './assets';
import { LOGIN_PATH, TOKEN_ENV, handleLogin, isAllowedOrigin, isAuthorized, loginRequired } from './auth';
import { FileHost } from './fileHost';
import { standalonePage } from './page';
import { currentScope, ScopedHost } from './scopedHost';
import { serve, ServerSocket } from './serve';
import { WindowConn, WorkspaceHub } from './workspaceHub';

const log = scoped('服务');

/** 终端 sink 只挂一次：端口被占时 main.ts 会重试着调 startServer，
 *  每次都挂会让同一条日志打印好几遍。 */
let consoleSinkAttached = false;

export interface ServeOptions {
  /** 小说工程目录。不传则按 window.json 恢复，或进空窗口。 */
  root?: string;
  port: number;
  /** 监听地址，缺省 127.0.0.1。安不安全由调用方先过 `exposureError`。 */
  host?: string;
  /** 访问令牌。给了就所有页面、WS、MCP 都要鉴权。 */
  token?: string;
  /** 终端里也打 debug 级日志。网页的日志页始终收全量，不受这里影响。 */
  verbose?: boolean;
  /** window.json 所在目录。测试注入，缺省为 ~/.novelforge。 */
  windowDir?: string;
}

export async function startServer(opts: ServeOptions): Promise<number> {
  // 终端只转 info 及以上（--verbose 时放开 debug）：debug 里有逐章进度，
  // 跑一次同步会刷屏，而网页的日志页本来就看得到那些。
  setSinkLevel(opts.verbose ? 'debug' : 'info');
  if (!consoleSinkAttached) {
    consoleSinkAttached = true;
    addLogSink((entry) => console.log(formatLogEntry(entry)));
  }

  const clients = new Map<ServerSocket, WindowConn>();

  const broadcast = (msg: OutMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients.keys()) {
      ws.send(text);
    }
  };

  // 不在任何窗口上下文里的 getHost()（启动期）落到这一份，广播给所有网页。
  const config = new FileConfigStore();
  initHost(new ScopedHost(new FileHost(config, broadcast)));
  initSecrets(new FileSecretStore());
  setTaskOwnerResolver(() => currentScope()?.owner);
  const hub = new WorkspaceHub({ config, windowDir: opts.windowDir });
  await hub.bootstrap(opts.root);

  // 外部 agent（Claude Code 之类）从这里接进来。地址带 `?project=<工程目录>` 就落到那个工程，
  // 不带落到作者最近操作的那个窗口的工程。没打开工程时工具照样列得出来，调用回一句「先打开工程」。
  let port = opts.port;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token;
  const mcp = createNovelMcp((project) => hub.mcpBackend(project), {
    allowOrigin: (origin, req) => isAllowedOrigin(origin, req, port, !!token),
  });

  const server = await serve({
    port: opts.port,
    hostname: host,

    fetch(req, server) {
      const url = new URL(req.url);
      if (token) {
        // 静态资源与登录本身不设防：登录页要用 favicon，资源里也没有作者的东西。
        if (url.pathname === LOGIN_PATH) {
          return handleLogin(req, token);
        }
        const open = url.pathname.startsWith('/media/') || url.pathname === '/favicon.ico';
        if (!open && !isAuthorized(req, token)) {
          if (url.pathname === '/' || url.pathname === '/index.html') {
            return loginRequired(url);
          }
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="novelforge"' },
          });
        }
      }
      if (url.pathname === MCP_PATH) {
        // 一次工具调用可能跑几分钟（写一章），期间连接上一个字节都没有。Bun 缺省 10 秒
        // 空闲就断，这里对这一个请求关掉。
        server.timeout(req, 0);
        return mcp.handle(req);
      }
      if (url.pathname === '/ws') {
        // 没配令牌时只靠「仅绑 127.0.0.1」保护。恶意网页无法读跨源
        // WebSocket 的响应，但能发消息（WS 不受同源策略约束），
        // 所以这里显式校验 Origin，把 DNS rebinding 一类的写入攻击挡在外面。
        if (!isAllowedOrigin(req.headers.get('origin'), req, server.port, !!token)) {
          log.warn('拒绝了一个跨源 WebSocket 连接', `Origin: ${req.headers.get('origin')}`);
          return new Response('Forbidden origin', { status: 403 });
        }
        // 窗口开的是哪个工程：页面把自己网址上的 `?project=` 原样带过来。
        const project = url.searchParams.get('project')?.trim() || undefined;
        if (server.upgrade(req, { data: { project } })) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const project = url.searchParams.get('project')?.trim();
        // 不带工程的网址落到最近操作的那个工程上，并把它写进网址：之后刷新、重连都认这一个，
        // 别的窗口换了「最近操作」也不会把这个窗口带走。
        const fallback = project ? undefined : hub.defaultRoot();
        if (fallback) {
          const target = new URL(url);
          target.searchParams.set('project', fallback);
          return Response.redirect(target.toString(), 302);
        }
        return new Response(standalonePage(project, PRODUCT_VERSION), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/media/')) {
        const asset = assetBytes(url.pathname.slice('/media/'.length));
        if (asset) {
          return new Response(asset.bytes, { headers: { 'content-type': asset.mime } });
        }
      }
      // 浏览器会自动请求 /favicon.ico；不接住的话每次加载都在控制台留一条 404。
      // icon.svg 用 currentColor（活动栏里要跟随主题），单独当 favicon 时没有
      // 继承色可用，这里替换成品牌蓝，深浅色标签栏上都看得见。
      if (url.pathname === '/favicon.ico') {
        const icon = assetBytes('icon.svg');
        if (icon) {
          const svg = new TextDecoder().decode(icon.bytes).replaceAll('currentColor', '#4daafc');
          return new Response(svg, { headers: { 'content-type': icon.mime } });
        }
      }
      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        // 重连时 view.js 不会再发 ready，connect 里主动推一遍全量状态；
        // 首次加载时前端还没挂监听，view.js 加载完会发 ready 再推一遍。
        const project = (ws.data as { project?: string } | undefined)?.project;
        clients.set(ws, hub.connect((msg) => ws.send(JSON.stringify(msg)), project));
        log.debug(`网页已连接（当前 ${clients.size} 个客户端）`);
      },
      async message(ws, raw) {
        const conn = clients.get(ws);
        if (!conn) {
          return;
        }
        let msg: InMessage;
        try {
          msg = JSON.parse(raw) as InMessage;
        } catch (err) {
          log.error(`处理网页消息失败：${describeError(err)}`, err);
          return;
        }
        await hub.receive(conn, msg);
      },
      close(ws) {
        const conn = clients.get(ws);
        clients.delete(ws);
        if (conn) {
          hub.disconnect(conn);
        }
        log.debug(`网页已断开（剩 ${clients.size} 个客户端）`);
      },
    },
  });

  port = server.port;

  // 走日志而不是裸 console.log：终端 sink 会把它打出来，网页的日志页也留一条。
  // 令牌本身绝不进日志（网页日志页、docker logs 都看得到）。带令牌的请求头写法也不打：
  // 日志脱敏（logger.ts 的 redact）见到 Bearer / Authorization 就整段抹掉，打出来也只剩省略号。
  const rootLabel = hub.defaultRoot() ?? '未打开工程';
  const wildcard = host === '0.0.0.0' || host === '::';
  const shown = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const base = `http://${shown}:${server.port}`;
  log.info(`服务已启动：${base}/`, `工程根 ${rootLabel}${wildcard ? `；监听 ${host}（所有网卡）` : ''}`);
  if (token) {
    log.info('已开启令牌鉴权', `令牌取自环境变量 ${TOKEN_ENV}；网页先登录，MCP 客户端在请求头里带上它`);
  }
  const addCmd = `claude mcp add --transport http novelforge ${base}${MCP_PATH}`;
  log.info(`MCP 已就绪：${base}${MCP_PATH}`, token ? `${addCmd}（另加 --header 带令牌，写法见 README「Docker 部署」）` : addCmd);
  return server.port;
}
