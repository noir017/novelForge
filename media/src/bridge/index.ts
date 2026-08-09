/**
 * 独立版桥接：在 view.js 之前加载，把 WebSocket 伪装成 webview API。
 *
 * webview 环境（VS Code）里 `acquireVsCodeApi` 已经存在，本文件直接退出——
 * 一个前端两个壳，靠的就是这层伪装，view / editor / explorer 里没有一行
 * 「我在哪个壳里」的判断。
 */
import { connect } from './socket';
import { installWebviewApi } from './webviewApi';

// 已经在 webview 里了：宿主给的那个才是真的，别覆盖。
if (typeof acquireVsCodeApi !== 'function') {
  installWebviewApi(connect());
}
