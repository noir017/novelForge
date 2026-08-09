/**
 * 与后端的 WebSocket 连接，外加断线重连与那条提示条。
 *
 * 对外只暴露一个 `send`：连接没就绪时先攒着，连上再一次性发出去——
 * 页面加载后第一条消息（view.js 的 `ready`）几乎必然早于握手完成，
 * 丢掉它整个界面就是空的。
 */
import { el } from '../dom';

export interface Socket {
  send(message: unknown): void;
}

/** 重连间隔。够短到用户几乎察觉不到，又不至于把服务打满。 */
const RETRY_DELAY_MS = 1500;

export function connect(): Socket {
  let ws: WebSocket | undefined;
  /** 连接未就绪时暂存的消息。 */
  const outbox: unknown[] = [];
  const banner = offlineBanner();

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      banner.hide();
      const socket = ws;
      if (!socket) {
        return;
      }
      for (const msg of outbox.splice(0)) {
        socket.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      // 前端各处都用 window.addEventListener('message', e => e.data) 收消息，
      // 派一个 MessageEvent 与 webview 的行为完全一致。
      window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
    };

    ws.onclose = () => {
      banner.show();
      setTimeout(open, RETRY_DELAY_MS);
    };
  };

  open();

  return {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        outbox.push(message);
      }
    },
  };
}

/**
 * 断线提示条。惰性创建——正常连着的时候页面上不该有这个节点。
 * 样式走 standalone.css 的主题变量，不写死颜色。
 */
function offlineBanner() {
  let node: HTMLElement | undefined;
  return {
    show() {
      if (!node) {
        node = el(
          'div',
          'wb-offline',
          '与服务器的连接已断开，正在重连…（未保存的内容仍在页面里）'
        );
        document.body.appendChild(node);
      }
      node.style.display = '';
    },
    hide() {
      if (node) {
        node.style.display = 'none';
      }
    },
  };
}
