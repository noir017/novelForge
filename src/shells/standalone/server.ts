/**
 * 独立版 Web 服务：Bun.serve 提供静态页 + /ws WebSocket。
 * 仅绑定 127.0.0.1，无鉴权——设计上只服务本机作者。
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
import { assetBytes } from './assets';
import { FileHost } from './fileHost';
import { standalonePage } from './page';
import { currentScope, ScopedHost } from './scopedHost';
import { WindowConn, WorkspaceHub } from './workspaceHub';

const log = scoped('服务');

/** 终端 sink 只挂一次：端口被占时 main.ts 会重试着调 startServer，
 *  每次都挂会让同一条日志打印好几遍。 */
let consoleSinkAttached = false;

export interface ServeOptions {
  /** 小说工程目录。不传则按 window.json 恢复，或进空窗口。 */
  root?: string;
  port: number;
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

  const clients = new Map<BunServerWebSocket, WindowConn>();

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
  const mcp = createNovelMcp((project) => hub.mcpBackend(project), {
    allowOrigin: (origin) => isAllowedOrigin(origin, port),
  });

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === MCP_PATH) {
        // 一次工具调用可能跑几分钟（写一章），期间连接上一个字节都没有。Bun 缺省 10 秒
        // 空闲就断，这里对这一个请求关掉。
        server.timeout(req, 0);
        return mcp.handle(req);
      }
      if (url.pathname === '/ws') {
        // 服务无鉴权，只靠「仅绑 127.0.0.1」保护。恶意网页无法读跨源
        // WebSocket 的响应，但能发消息（WS 不受同源策略约束），
        // 所以这里显式校验 Origin，把 DNS rebinding 一类的写入攻击挡在外面。
        if (!isAllowedOrigin(req.headers.get('origin'), server.port)) {
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
        return new Response(standalonePage(project), {
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
          msg = JSON.parse(String(raw)) as InMessage;
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
  const rootLabel = hub.defaultRoot() ?? '未打开工程';
  log.info(`服务已启动：http://127.0.0.1:${server.port}/`, `工程根 ${rootLabel}`);
  log.info(`MCP 已就绪：http://127.0.0.1:${server.port}${MCP_PATH}`, `claude mcp add --transport http novelforge http://127.0.0.1:${server.port}${MCP_PATH}`);
  return server.port;
}

/**
 * WS 的 Origin 白名单：只认本机同端口。
 *
 * 没有 Origin 头的一律放过——命令行工具（冒烟测试里的 Bun WebSocket、
 * wscat 等）不发这个头，浏览器一定发，所以缺失说明不是网页发起的请求。
 */
function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (!origin) {
    return true;
  }
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const localhost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    return localhost && u.port === String(port);
  } catch {
    return false;
  }
}
