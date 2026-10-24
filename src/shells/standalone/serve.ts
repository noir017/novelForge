/**
 * 起 HTTP + WebSocket 服务的那一层，与运行时无关的一面。
 *
 * 独立版平时跑在 Bun 里，直接用 `Bun.serve`；Android 壳里没有 Bun（它不出 Android 的构建，
 * bionic 也跑不了 glibc 的二进制），只有 Termux 编的 node，于是同一份服务端要在 node 上也起得来。
 * 两边的差别只在「怎么监听」，路由、鉴权、WebSocket 的收发都在 [server.ts](server.ts) 里写一份：
 * 这里的形状照 `Bun.serve` 摆（`fetch(req, ctl)` + `websocket` 三个回调），Bun 下原样交过去，
 * node 下由 [nodeServe.ts](nodeServe.ts) 转成 `node:http` + `ws`。
 *
 * 挑哪一个看运行时有没有 `Bun` 这个全局——是运行时的能力，不是「我是哪个壳」。
 *
 * `ws` 静态 import 也不怕 Bun：Bun 把 `ws` 这个包换成自己内置的实现，不读 node_modules。
 */
import { serveNode } from './nodeServe';

/** 一条 WebSocket 连接。`data` 是升级时给的那份。 */
export interface ServerSocket {
  send(text: string): void;
  close(): void;
  readonly data: unknown;
}

/** 处理一个请求时能对服务做的事（Bun 的 `server` 参数里用得到的那几样）。 */
export interface ServeControl {
  readonly port: number;
  /** 把这个请求升级成 WebSocket；成了返回 true，`fetch` 随后返回 undefined。 */
  upgrade(req: Request, options?: { data?: unknown }): boolean;
  /** 这一个请求的空闲超时（秒），0 = 不限。 */
  timeout(req: Request, seconds: number): void;
}

export interface ServeSpec {
  port: number;
  hostname: string;
  fetch(req: Request, ctl: ServeControl): Response | undefined | Promise<Response | undefined>;
  websocket: {
    open(ws: ServerSocket): void;
    message(ws: ServerSocket, data: string): void | Promise<void>;
    close(ws: ServerSocket): void;
  };
}

export interface Served {
  port: number;
  stop(): void;
}

/** 端口被占等起不来的情况一律抛（main.ts 据此顺延端口重试）。 */
export async function serve(spec: ServeSpec): Promise<Served> {
  if (typeof Bun !== 'undefined') {
    return Bun.serve({
      port: spec.port,
      hostname: spec.hostname,
      fetch: spec.fetch,
      websocket: {
        open: spec.websocket.open,
        message: (ws, raw) => spec.websocket.message(ws, String(raw)),
        close: spec.websocket.close,
      },
    });
  }
  return serveNode(spec);
}
