/**
 * WebSocket 测试客户端（**ESM，只给 Bun 侧的 e2e 用**）。
 *
 * 独立版的 e2e（tests/e2e/standalone/）跑在 Bun 下：ESM、顶层 await、全局
 * WebSocket。Node 侧的测试一律 CommonJS，用不到这份 helper，也 require 不进去。
 *
 * 协议是「发一条、等一条」：服务端会主动推状态（连上就来一轮全量），
 * 所以不能假设下一条消息就是自己要的那条——收到的一律先进 inbox，
 * 由 waitFor 按谓词挑走。已经躺在 inbox 里的旧消息也能被挑中，
 * 于是「先 send 后 waitFor」和「消息先到」两种时序都成立。
 *
 * 迁自 scripts/smoke-server.js 的 connect()。
 */

const TIMEOUT_MS = 5000;

/**
 * 开一条 WS，把收到的消息按谓词分发给等待者，其余排进 inbox。
 *
 * @param {number} port 服务端口
 * @returns {{
 *   ws: WebSocket,
 *   ready: Promise<void>,
 *   waitFor: (match: (msg: any) => boolean, label: string) => Promise<any>,
 *   send: (msg: any) => void,
 *   drain: () => void,
 * }}
 */
export function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      waiters.splice(idx, 1)[0].resolve(msg);
    } else {
      inbox.push(msg);
    }
  };

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    setTimeout(() => reject(new Error('WS 连不上')), TIMEOUT_MS);
  });

  const waitFor = (match, label) =>
    new Promise((resolve, reject) => {
      // 先翻 inbox：想等的那条可能在 send 之前就到了。
      const idx = inbox.findIndex(match);
      if (idx >= 0) {
        resolve(inbox.splice(idx, 1)[0]);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`等不到 ${label}`)), TIMEOUT_MS);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });

  return {
    ws,
    ready,
    waitFor,
    send: (m) => ws.send(JSON.stringify(m)),
    /** 丢掉堆积的旧消息——切目标前必须清，否则 waitFor 会立刻拿到上一轮的。 */
    drain: () => (inbox.length = 0),
  };
}
