// 进程内起独立服务 → HTTP 拿页面/资源 → WS 握手拿 init 消息。用法：bun scripts/smoke-server.js
// 不另起子进程：避免 Windows 上子进程杀不干净留下占用端口的孤儿。
import { startServer } from '../src/standalone/server';
import * as path from 'node:path';

const PORT = 3999;
const root = path.join(import.meta.dir, '..', 'sample-novel');

startServer({ root, port: PORT });

const base = `http://127.0.0.1:${PORT}`;
try {
  const html = await (await fetch(`${base}/`)).text();
  if (!html.includes('view.js')) throw new Error('首页缺 view.js');
  if ((await fetch(`${base}/media/view.js`)).status !== 200) throw new Error('view.js 404');
  if ((await fetch(`${base}/media/bridge.js`)).status !== 200) throw new Error('bridge.js 404');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const first = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    setTimeout(() => reject(new Error('WS 无 init')), 5000);
  });
  if (first.type !== 'init' && first.type !== 'state') throw new Error(`首条消息是 ${first.type}`);
  ws.close();
  console.log('✓ smoke-server 通过');
} finally {
  // 服务是进程内的 Bun.serve，直接退出即可，不会留孤儿。
  process.exit(0);
}
