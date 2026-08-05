/**
 * Bun 运行时的最小类型声明。不引 bun-types 全量包——独立壳只用
 * Bun.serve 的一小块表面；真装上 bun-types 后可删除本文件。
 */

interface BunServerWebSocket {
  send(text: string): void;
  close(): void;
}

interface BunServeOptions {
  port: number;
  hostname?: string;
  fetch(
    req: Request,
    server: { upgrade(req: Request, options?: { data?: unknown }): boolean }
  ): Response | undefined | Promise<Response | undefined>;
  websocket?: {
    open?(ws: BunServerWebSocket): void;
    message?(ws: BunServerWebSocket, data: string | Buffer): void | Promise<void>;
    close?(ws: BunServerWebSocket): void;
  };
}

declare const Bun: {
  serve(options: BunServeOptions): { port: number; stop(): void };
};
