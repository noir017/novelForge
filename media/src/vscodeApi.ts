/**
 * webview API 的取用与消息收发。
 *
 * 四个产物各自打包，因此各自调用一次 `acquireVsCodeApi()`——这与改造前
 * 逐个文件调用的行为完全一致。VS Code 的 webview 里这个函数只允许调一次，
 * 所以 editor / explorer 那两个**必须**在确认自己那块 DOM 存在（即独立版）
 * 之后才走到这里；独立版的 bridge.js 每次调用都返回同一个对象，无此限制。
 */
import type { InMessage, OutMessage } from './protocol';

/** webview 宿主给的那点 API。独立版由 bridge.js 伪装出同样的形状。 */
export interface WebviewApi<State> {
  postMessage(message: InMessage): void;
  getState(): State | undefined;
  setState(state: State): State;
}

declare global {
  function acquireVsCodeApi(): WebviewApi<unknown>;

  interface Window {
    /** bridge.js 在独立版里装上的伪装实现；webview 里由宿主注入。 */
    acquireVsCodeApi?: () => WebviewApi<unknown>;
  }
}

/**
 * 取一次 webview API。
 *
 * 类型参数是 `getState`/`setState` 里那份 UI 状态的形状——只有 view 用得上
 * （输入框草稿），其余两块不带参数即表示不碰它。宿主那边这块存储本来就是
 * 无类型的 JSON，断言只在这一处发生，调用方拿到的是确定的形状。
 */
export function acquireApi<State = never>(): WebviewApi<State> {
  return acquireVsCodeApi() as WebviewApi<State>;
}

/**
 * 监听后端推来的消息。
 *
 * 三个前端产物各自挂一份监听、各自认自己关心的 `type`，互不干扰——
 * 这是改造前就有的格局（view / editor / explorer 完全解耦），保持不变。
 */
export function onMessage(handler: (msg: OutMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<OutMessage>) => {
    if (event.data) {
      handler(event.data);
    }
  });
}
