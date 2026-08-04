# vscode — VS Code 宿主层

扩展的入口与一切「只在 VS Code 里存在」的东西：命令注册、webview 宿主、VS Code Language Model API。业务逻辑都在 `core/` 与 `ui/`，这里只做接线。

## 文件

| 文件 | 职责 |
|---|---|
| [extension.ts](extension.ts) | ★ `activate()`：注册全部 `novel.*` 命令、FileSystemWatcher（章节保存 → 刷新摘要新鲜度）、`.novel` → `.novelforge` 迁移询问、无工作区时的占位视图。 |
| [chatViewProvider.ts](chatViewProvider.ts) | 侧边栏宿主（`WebviewViewProvider`，视图 id `novelForge.chat`）。实现 `ViewHost` 挂到 `ChatController`。 |
| [chatPanel.ts](chatPanel.ts) | 编辑器宿主（`WebviewPanel` 单例）。侧边栏太窄时用 ⧉ 打开，两边是同一个会话。 |
| [webviewHtml.ts](webviewHtml.ts) | 两个宿主共用的 HTML 外壳：tabbar + 四个页签的静态结构，CSP 只允许本地资源，加载 [../../media](../../media) 下的 view.css / view.js。 |
| [vscodeLmProvider.ts](vscodeLmProvider.ts) | `LlmProvider` 的 vscode-lm 实现（复用 Copilot 订阅）。两点特殊：system 提示并入首条 user 消息；有硬性 `maxInputTokens` 配额，装配器据此收紧预算。 |

## 关键设计

- **UI 全在 webview**：不用 TreeView 等原生控件，一套 HTML 同时供侧边栏与编辑器标签页使用。命令、菜单、快捷键的声明在根目录 [package.json](../../package.json)。
- **激活条件**：`workspaceContains:.novelforge/project.json`（含旧目录 `.novel/`），非小说工程不激活。
- **侧边栏折叠不丢状态**：`retainContextWhenHidden: true`，否则草稿和流式内容会丢。
- **命令是兜底入口**：工程页上每个按钮都映射到一条 `novel.*` 命令（webview 只说「点了什么」），命令面板也能直达同一功能。

## 依赖关系

依赖 `core/` 与 `ui/`。本层是唯一允许使用 webview / 命令 / 视图 API 的地方；把这里的 `vscode` 依赖剥干净是将来支持独立 Web 服务的前提（见根目录 `docs/design/` 的改造计划）。
