# vscode — VS Code 宿主层

扩展的入口与一切「只在 VS Code 里存在」的东西：命令注册、webview 宿主、VS Code Language Model API。业务逻辑都在 `core/` 与 `ui/`，这里只做接线。

## 文件

| 文件 | 职责 |
|---|---|
| [extension.ts](extension.ts) | ★ `activate()`：注册全部 `novel.*` 命令、「Novel Forge」输出面板（core 日志的 sink）、FileSystemWatcher（章节保存 → 刷新摘要新鲜度）、`.novel` → `.novelforge` 迁移询问、无工作区时的占位视图。 |
| [vscodeHost.ts](vscodeHost.ts) | `Host` 的实现：弹窗/进度/文件监听接回原生 API。`openFile` 开在第一栏，`openBeside` 用 `ViewColumn.Beside` 让草稿与正文并排。 |
| [chatViewProvider.ts](chatViewProvider.ts) | 侧边栏宿主（`WebviewViewProvider`，视图 id `novelForge.chat`）。实现 `ViewHost` 挂到 `ChatController`。 |
| [chatPanel.ts](chatPanel.ts) | 编辑器宿主（`WebviewPanel` 单例）。侧边栏太窄时用 ⧉ 打开，两边是同一个会话。 |
| [webviewHtml.ts](webviewHtml.ts) | 两个宿主共用的 HTML 外壳：tabbar + 五个页签（对话/工程/历史/日志/设置）的静态结构，CSP 只允许本地资源，加载 [../../media](../../../media) 下的 view.css / view.js。 |
| [vscodeLmProvider.ts](vscodeLmProvider.ts) | `LlmProvider` 的 vscode-lm 实现（复用 Copilot 订阅）。两点特殊：system 提示并入首条 user 消息；有硬性 `maxInputTokens` 配额，装配器据此收紧预算。 |

## 关键设计

- **UI 全在 webview**：不用 TreeView 等原生控件，一套 HTML 同时供侧边栏与编辑器标签页使用。命令、菜单、快捷键的声明在根目录 [package.json](../../../package.json)。
- **激活条件**：`workspaceContains:.novelforge/project.json`（含旧目录 `.novel/`），非小说工程不激活。
- **侧边栏折叠不丢状态**：`retainContextWhenHidden: true`，否则草稿和流式内容会丢。
- **命令是兜底入口**：工程页上每个按钮都映射到一条 `novel.*` 命令（webview 只说「点了什么」），命令面板也能直达同一功能。
- **输出面板最先建**：`registerOutputChannel` 是 `activate` 的第一句。迁移、配置读取这些在它之后才跑，但模块 import 期就可能打过日志了——所以它会先把缓冲里已有的补进面板，再挂 sink。面板里的内容与网页日志页是同一份，只是多一个能跟其他扩展并排看、能整段复制的入口（命令 `Novel: 显示输出面板日志`）。
- **草稿开在旁边一栏**：`openBeside` 用 `ViewColumn.Beside`，它是相对**当前活动编辑器**的。从侧边栏点过来时最后活动的文本编辑器通常就是正文（`openFile` 把它放在第一栏），草稿于是落到第二栏；若此刻活动的是 `ChatPanel` 那个 tab，草稿就开在它旁边。够用，没去纠正。
- **watcher 的章节 glob 是全量的**：`${chaptersDir}/**` 那条本来是为了看见空目录的增删，顺带也覆盖了非 `.md` 的章节（`.txt` / 无扩展名 / `.json`），所以章节扩展名放宽不需要在这里加模式。另加了 `${draftsDir}/**`，手工建的草稿也能让工程页上的「有草稿」标记翻过来。

## 依赖关系

依赖 `core/` 与 `ui/`。本层是唯一允许使用 webview / 命令 / 视图 API 的地方；把这里的 `vscode` 依赖剥干净是将来支持独立 Web 服务的前提（见根目录 `docs/design/` 的改造计划）。
