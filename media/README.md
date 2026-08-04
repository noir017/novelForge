# media — webview 前端资源

面板的全部前端代码。由 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 生成的 HTML 加载，两个宿主（侧边栏 / 编辑器标签页）共用同一套。

| 文件 | 职责 |
|---|---|
| [view.js](view.js) | 前端逻辑（原生 JS，无框架）：渲染 `ViewState`、tabbar 切页、流式文本追加、回复就地编辑、上下文明细折叠展示、@ 引用标签、设置页表单。顶部取 `acquireVsCodeApi()` 后以 `postMessage` 发 `InMessage`、监听 `message` 收 `OutMessage`，加载完自报 `{ type: 'ready' }`。 |
| [view.css](view.css) | 全部样式，用 CSS 变量贴近 VS Code 原生配色（`--vscode-*`）。 |
| [icon.svg](icon.svg) | 活动栏与编辑器标签页图标。 |

## 关键约定

- **前端无状态**：一切数据来自 `ViewState` 全量推送，前端只保留 UI 状态（草稿、展开/折叠、正在编辑的回复）。webview 销毁重建后一条 `ready` 就能完整恢复。
- **消息契约**：收发的消息类型与 [../src/core/protocol.ts](../src/core/protocol.ts) 一一对应。改协议要同时改这里，`smoke-builder.js` 覆盖不到前端，需要手动验证。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。
- **独立形态兼容**：standalone 改造计划里，`view.js` 会经一个 `bridge.js` 把 WebSocket 伪装成 webview API 复用——所以这里不要直接调用 webview 独有的能力（如 `setState`），保持只走 postMessage。
