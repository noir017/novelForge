/**
 * 把 `acquireVsCodeApi` 装到 window 上，形状与 webview 宿主给的那个一致。
 *
 * `getState`/`setState` 在浏览器里落 localStorage：网页会被 F5 刷新，
 * 比 webview 更需要它——view.js 用它存输入框里没发出去的草稿。
 */
import type { WebviewApi } from '../vscodeApi';
import type { Socket } from './socket';

const STATE_KEY = 'novelforge.viewState';

export function installWebviewApi(socket: Socket): void {
  // 内存副本：读一次 localStorage 就够，之后以它为准。
  let memoryState: unknown;
  let loaded = false;

  const api: WebviewApi<unknown> = {
    postMessage(message) {
      socket.send(message);
    },
    getState() {
      if (!loaded) {
        loaded = true;
        try {
          memoryState = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') ?? undefined;
        } catch {
          memoryState = undefined;
        }
      }
      return memoryState;
    },
    setState(state) {
      memoryState = state;
      loaded = true;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch {
        // 隐私模式下写不进去，退化为仅本次会话保留。
      }
      return state;
    },
  };

  // 每次调用都给同一个对象：view / editor / explorer 各调一次，
  // 它们共享同一条 WebSocket 与同一份状态存储。
  window.acquireVsCodeApi = () => api as WebviewApi<never>;
}
