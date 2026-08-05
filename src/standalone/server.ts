import { ChatController } from '../core/controller';
import { initHost } from '../core/host';
import { initSecrets } from '../core/llm/registry';
import { NovelProject } from '../core/model/project';
import { InMessage, OutMessage } from '../core/protocol';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { FileHost } from './fileHost';
import { assetBytes, standalonePage } from './html';

/**
 * 独立版 Web 服务：Bun.serve 提供静态页 + /ws WebSocket。
 * 仅绑定 127.0.0.1，无鉴权——设计上只服务本机作者。
 */

export interface ServeOptions {
  /** 小说工程目录（绝对路径）。 */
  root: string;
  port: number;
}

export function startServer(opts: ServeOptions): number {
  const project = NovelProject.open(opts.root);
  const clients = new Set<BunServerWebSocket>();

  const broadcast = (msg: OutMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(text);
    }
  };

  const host = new FileHost(new FileConfigStore(), broadcast, opts.root);
  initHost(host);
  initSecrets(new FileSecretStore());
  const chat = new ChatController(project);

  // controller 只向已挂接的 ViewHost 广播；独立版把广播函数包成一个 ViewHost 挂上去，
  // 这样 pushState / session / settings 等消息才能流到所有 WebSocket 客户端。
  chat.attach({
    kind: 'editor',
    post: (msg) => broadcast(msg),
    reveal: () => undefined,
  });

  host.watch(project, () => {
    project.invalidate();
    void chat.pushState();
  });

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(standalonePage(), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/media/')) {
        const asset = assetBytes(url.pathname.slice('/media/'.length));
        if (asset) {
          return new Response(asset.bytes, { headers: { 'content-type': asset.mime } });
        }
      }
      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        // 重连时 view.js 不会再发 ready，这里主动推一遍全量状态；
        // 首次加载时前端还没挂监听，view.js 加载完会发 ready 再推一遍。
        void chat.resendFullState();
      },
      async message(_ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as InMessage;
          if (msg.type === 'promptResult') {
            host.prompts.resolve(msg.requestId, msg.value);
            return;
          }
          await chat.handle(msg);
        } catch (err) {
          broadcast({
            type: 'toast',
            message: err instanceof Error ? err.message : String(err),
            level: 'error',
          });
        }
      },
      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) {
          host.prompts.cancelAll();
        }
      },
    },
  });

  console.log(`Novel Forge 已启动：http://127.0.0.1:${server.port}/（工程：${opts.root}）`);
  return server.port;
}
