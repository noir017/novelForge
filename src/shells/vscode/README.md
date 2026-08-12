# vscode — VS Code 壳

扩展的入口与一切「只在 VS Code 里存在」的东西：命令注册、webview 宿主、VS Code Language Model API。
业务逻辑与页面内容都不在这里（见 [../README.md](../README.md) 的壳契约），这一层只做接线。

## 文件

| 文件 | 职责 |
|---|---|
| [extension.ts](extension.ts) | ★ `activate()`：注册全部 `novel.*` 命令、「Novel Forge」输出面板（core 日志的 sink）、FileSystemWatcher（章节保存 → 刷新摘要新鲜度）、`.novel` → `.novelforge` 迁移询问、无工作区时的占位视图。 |
| [vscodeHost.ts](vscodeHost.ts) | `Host` 的实现：弹窗/进度/文件监听接回原生 API。`openFile` 开在第一栏，`openBeside` 用 `ViewColumn.Beside` 让草稿与正文并排。 |
| [chatViewProvider.ts](chatViewProvider.ts) | 侧边栏宿主（`WebviewViewProvider`，视图 id `novelForge.chat`）。实现 `ViewHost` 挂到 `ChatController`。 |
| [chatPanel.ts](chatPanel.ts) | 编辑器宿主（`WebviewPanel` 单例）。侧边栏太窄时用 ⧉ 打开，两边是同一个会话。 |
| [webviewHtml.ts](webviewHtml.ts) | 两个宿主共用的页面模板：head / CSP / tabbar / 装配顺序。五个页签的 DOM 来自 [../shared/panes.ts](../shared/panes.ts)，**这里没有第二份**。它是纯函数——`asset` 与 `cspSource` 由调用方给，全文件零 vscode 依赖，因此 jsdom 能直接执行它拿真实页面。 |
| [webview.ts](webview.ts) | webview 的接线：`localResourceRoots`（`media/` 与 `dist/media/` 两处，少一条就一片 404）与 `asWebviewUri` 的拼装。两个宿主从前各写了一份。 |
| [vscodeLmProvider.ts](vscodeLmProvider.ts) | `LlmProvider` 的 vscode-lm 实现（复用 Copilot 订阅）。两点特殊：system 提示并入首条 user 消息；有硬性 `maxInputTokens` 配额，装配器据此收紧预算。 |

## 关键设计

- **UI 全在 webview**：不用 TreeView 等原生控件，一套 HTML 同时供侧边栏与编辑器标签页使用。命令、菜单、快捷键的声明在根目录 [package.json](../../../package.json)。
- **激活条件**：`workspaceContains:.novelforge/project.json`（含旧目录 `.novel/`），非小说工程不激活。
- **侧边栏折叠不丢状态**：`retainContextWhenHidden: true`，否则草稿和流式内容会丢。
- **命令是兜底入口**：工程页上每个按钮都映射到一条 `novel.*` 命令（webview 只说「点了什么」），命令面板也能直达同一功能。
- **输出面板最先建**：`registerOutputChannel` 是 `activate` 的第一句。迁移、配置读取这些在它之后才跑，但模块 import 期就可能打过日志了——所以它会先把缓冲里已有的补进面板，再挂 sink。面板里的内容与网页日志页是同一份，只是多一个能跟其他扩展并排看、能整段复制的入口（命令 `Novel: 显示输出面板日志`）。
- **草稿开在旁边一栏**：`openBeside` 用 `ViewColumn.Beside`，它是相对**当前活动编辑器**的。从侧边栏点过来时最后活动的文本编辑器通常就是正文（`openFile` 把它放在第一栏），草稿于是落到第二栏；若此刻活动的是 `ChatPanel` 那个 tab，草稿就开在它旁边。够用，没去纠正。
- **监听哪些文件不由这里决定**：`VsCodeHost.watch` 只负责机制（`createFileSystemWatcher` + `RelativePattern`），glob 清单来自 [../../core/watchPolicy.ts](../../core/watchPolicy.ts) 的 `watchGlobs`——独立版用同一份策略的另一种形态（事件过滤）。章节能是什么扩展名、草稿在哪，都是 core 的规则。
- **弹窗与清单一律走 Host**：这一层不再直接调 `window.showQuickPick` / `show*Message`。「更新哪个角色」那份清单（含「＋N 章待读」的计算）在 [../../core/choices.ts](../../core/choices.ts)——它是业务知识，壳里抄一份就会与工程页上的同一行说明分叉。
- **两处刻意留在壳里的原生流程**：[quickContinue.ts](quickContinue.ts)（流式写进一个 untitled 文档，是彻底的平台专属入口）与 `NO_WORKSPACE_HTML`（无工作区时的宿主占位视图，不加载脚本、CSP 收到最紧）。它们没有第二个壳需要复用，也没有业务判断藏在里面。

## 依赖关系

只依赖 [core/](../../core/README.md) 与 [shared/](../shared/panes.ts)。本层是唯一允许使用 webview / 命令 / 视图 API 的地方，
**不许 import 另外两个壳**（由 [tests/contract/shellPurity.test.js](../../../tests/contract/shellPurity.test.js) 守着）。
