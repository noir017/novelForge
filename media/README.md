# media — 前端资源

面板的全部前端代码，两个形态共用。插件形态由 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 生成 HTML 加载（侧边栏 / 编辑器标签页），独立形态由 [../src/standalone/html.ts](../src/standalone/html.ts) 加载。

| 文件 | 加载于 | 职责 |
|---|---|---|
| [view.js](view.js) | 两者 | 前端逻辑（原生 JS，无框架）：渲染 `ViewState`、tabbar 切页、流式文本追加、回复就地编辑、上下文明细折叠展示、@ 引用标签、工程页的多层目录树、右键菜单、设置页表单。顶部取 `acquireVsCodeApi()` 后以 `postMessage` 发 `InMessage`、监听 `message` 收 `OutMessage`，加载完自报 `{ type: 'ready' }`。 |
| [view.css](view.css) | 两者 | 面板样式，全部走 `--vscode-*` 变量。**不写死颜色**——插件里这些变量由 VS Code 注入，独立版由 standalone.css 提供。 |
| [icon.svg](icon.svg) | 两者 | 活动栏与编辑器标签页图标。`stroke="currentColor"`，跟随主题色。 |
| [bridge.js](bridge.js) | 仅独立版 | 把 WebSocket 伪装成 webview API：`postMessage` / `message` 事件 / `getState`+`setState`（落 localStorage）。检测到 `acquireVsCodeApi` 已存在（即在 webview 里）就直接退出。断线时插入重连提示条。 |
| [standalone.css](standalone.css) | 仅独立版 | ① 补齐 view.css 依赖的全部 `--vscode-*` 变量（深/浅两套，对齐 VS Code Dark/Light Modern）；② 把单列页面重排为工作台：标题栏 + 竖排活动栏 + 侧栏 + 编辑区 + 拖拽分隔条，并含窄屏（≤900px）适配。 |
| [editor.js](editor.js) | 仅独立版 | 内置文件编辑器：多标签、脏标记、`Ctrl+S` 保存、还原、冲突取舍、字数/行列状态栏、Markdown 预览、主题切换、侧栏宽度拖拽、刷新后恢复未保存草稿。 |

## 关键约定

- **前端无状态**：一切数据来自 `ViewState` / `ProjectTree` 全量推送，前端只保留 UI 状态（草稿、展开/折叠、正在编辑的回复）。webview 销毁重建后一条 `ready` 就能完整恢复。
- **工程页的树是扁平渲染的**：`renderNodes` 递归遍历 `ProjectNode`，但产出的是**扁平的行数组**，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM。折叠状态存在模块级的 `openFolders`（relPath 集合）与 `openGroups` 里；切换折叠只用最近一次收到的树重画（`rerenderProject`），不往后端要数据。文件夹默认折叠，四个顶层分组默认展开。
- **一套菜单引擎、两个入口**：`buildMenuElement(items, className)` 由 `{ label, run, danger, disabled }`（`{ sep: true }` 是分隔线）建出菜单 DOM。气泡右上角的 ⋯ 用 `.msg-menu` 绝对定位贴在 `.msg-head` 里；右键用 `.ctx-menu` 挂到 `body` 上 `position: fixed` 跟着光标走（工程页有内部滚动，挂在容器里会被裁掉），贴边时翻转。`openMenu` 保证同时只有一个，点别处 / Esc / 滚动都收起。
- **右键菜单靠 WeakMap 登记**：构建某一行时用 `onContextMenu(row, () => items)` 把「这行右键给什么」记在元素上（那一刻上下文最全，不用右键时反查 `lastTree`；行被重渲染丢弃后自动回收）。全局 `contextmenu` 监听从 `e.target` 向上找第一个登记过的祖先，找不到就用兜底的「刷新」。**刷新复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，会按当前页签推数据，天然适用于所有页面，无需新增协议。
- **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 / 内置编辑器里也一样，所以**原生的复制/粘贴/剪切菜单不会出现**。这是有意的取舍（菜单风格统一），代价是这几处的编辑项要自己实现——目前还没做，那里只有「刷新」。插件形态另需 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 的 `<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>`：VS Code 给 webview 右键菜单加的复制/粘贴项由宿主渲染，JS 的 `preventDefault` 压不住，不加会同时冒出两层菜单。
- **消息契约**：收发的消息类型与 [../src/core/protocol.ts](../src/core/protocol.ts) 一一对应。改协议要同时改这里；`smoke-server.js` 覆盖了编辑器的消息往返，其余前端逻辑需手动验证。
- **DOM 结构两处同源**：工程页工具栏等结构在 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 与 [../src/standalone/html.ts](../src/standalone/html.ts) 各有一份，加按钮要同时改两处。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。独立版同样不引外部资源。
- **两形态隔离**：`standalone.css` 与 `editor.js` **只**由独立版加载，插件的 `webviewHtml.ts` 里没有它们，也没有 `#wbEditor` 容器。给独立版加样式请只改 `standalone.css`（必要时用 `.workbench` 前缀覆盖 view.css），不要为独立版去动 view.css。
- **能力探测而非环境判断**：`view.js` 里用 `document.getElementById('wbEditor')` 判断有没有内置编辑器，据此决定「打开文件」发 `openEditor` 还是 `openFile`。插件里没有这个容器，行为不变。
- **不拼 HTML 字符串渲染用户内容**：Markdown 预览全部走 `createElement` + `textContent`，正文里写 `<script>` 也只是普通文字。

## 内置编辑器的行为约束

对应「不静默覆盖」这条产品承诺（见 [../AGENTS.md](../AGENTS.md)）：

- 保存带**内容 hash 乐观锁**。磁盘上的 hash 与编辑器基线不一致（作者在别处改过、或插件写入过）时保存被拒，前端弹冲突条，由用户在「用磁盘版本覆盖编辑器」和「用编辑器内容强制保存」之间选。
- 只有用户明确点了「强制保存」，才会发不带 `baseHash` 的 `saveFile`。
- 刷新页面后恢复未保存草稿时，同样比对 hash：磁盘变过就丢弃草稿并提示，不拿旧草稿盖新内容。
- 关闭有未保存修改的标签页、以及带未保存内容离开页面，都会先问一句。
