# standalone — 独立 Web 服务壳（Bun）

不装 VS Code 也能用的第二个宿主：本机起一个 Web 服务，浏览器里操作。与插件壳共用 `core/`，自己只实现 `Host` 窄接口与一层 HTTP/WebSocket 传输。

## 文件

| 文件 | 职责 |
|---|---|
| [main.ts](main.ts) | 入口。`init` 走终端交互式初始化；否则起服务（端口被占顺延，最多 20 次）并按需开浏览器。 |
| [cli.ts](cli.ts) | 参数解析：`novelforge [dir] [--port N] [--no-open] [--verbose]` / `novelforge init [dir]`。 |
| [server.ts](server.ts) | `Bun.serve`：`/` 出页面、`/media/*` 出内嵌资源、`/favicon.ico`、`/ws` WebSocket。收到的 JSON 按 `InMessage` 分发给同一个 `ChatController`，`OutMessage` 广播给所有连接（多标签页同步）。启动时把 core 的日志接到终端（默认 info 及以上，`--verbose` 放开 debug）。 |
| [fileHost.ts](fileHost.ts) | `Host` 的实现：弹窗经 `PromptHub` 变成网页 modal；`fs.watch` 监听工程（失败退化为轮询，带 250ms 去抖）；`openFile` 走内置编辑器；`openBeside` 开在第二块编辑区。`progress` 只提供 signal——进度由 `core/progress.ts` 结构化推给网页。 |
| [promptHub.ts](promptHub.ts) | 未决网页弹窗的登记与回执匹配。WS 全部断开时一律按取消处理。 |
| [html.ts](html.ts) | 页面骨架：工作台布局（标题栏 + 活动栏 + 侧栏 + 内置编辑器）＋ 从内嵌资源表取字节的 `assetBytes`。 |
| `mediaAssets.ts` | **生成文件**（已 gitignore）。由 [../../scripts/embed-media.js](../../scripts/embed-media.js) 把 `media/` 下的资源 base64 内嵌，使单文件可执行不依赖外部资源。`npm run typecheck` / `smoke` / `dist` 前会自动生成。 |

## 关键设计

- **单工程、单用户、只绑本机**：`127.0.0.1`，无鉴权。多个 WS 连接共享同一个 `ChatController` 实例。
- **Origin 校验**：WebSocket 不受同源策略约束，恶意网页能向本机端口发消息。`server.ts` 因此校验 `Origin` 只认本机同端口；没有 `Origin` 头的（命令行工具、冒烟测试）放过。
- **openFile 的语义差异**：插件里是「打开 VS Code 的编辑器 tab」，这里是「在网页内置编辑器里打开」。刻意让 `openFile` 本身改道，这样 controller 里「采纳写入后打开」「点章节」「点上下文条目」三处调用点一次全对。非文本文件回落到系统默认程序。
- **两块编辑区**：`openInEditor(rel, pane)` 的 `pane` 决定 `editorOpen` 落到哪一块，`openBeside` 就是 `pane: 'draft'`。`editorOpen` 广播时顺手带上 `draftPath`（由 `draftPathOf` 从章节路径推导），前端据此显示工具栏上的「草稿」按钮——前端不该自己复刻「什么算章节」。`editorSaved` 也必须带它，否则按钮会在首次保存后消失。
- **文件读写全部经 [../core/fileEditing.ts](../core/fileEditing.ts)**：路径包含校验、可编辑判定（扩展名白名单 ∪ 章节文件名规则）、大小上限、保存的 hash 乐观锁都在那里。本层只负责把异常翻译成 `editorError` / `editorConflict` 广播出去，不要绕过它直接 `fs.writeFile`。
- **watcher 只挡二进制**：`fs.watch` 的过滤用 `NON_CHAPTER_EXTENSIONS` 黑名单——章节可以是 `.txt`/无扩展名，目录事件也没有扩展名，白名单式过滤会让这些改动看不见。因为放行面变宽，`onChange` 带 250ms 去抖：它会触发 `pushState`，那是一次全量重扫。
- **进度不再是 toast**：`FileHost.progress` 过去每收到一次 `report` 就弹一条 toast，跑一次「同步 76 章摘要」等于刷 76 条提示、把别的消息全盖掉。现在同一份进度由 `core/progress.ts` 结构化推成 `tasks` 消息，工程页顶部画进度条（n/N、计时、可停止），`FileHost.progress` 只负责给出 signal 与报告失败。
- **终端 sink 只挂一次**：端口被占时 `main.ts` 会重试着调 `startServer`，每次都 `addLogSink` 会让同一条日志打印好几遍。
- **前端资源三处同改**：新增 `media/` 下的**文件**后，要同时加进 `embed-media.js` 的 `files` 数组和 `html.ts` 的引用，否则编译版会 404。（只改已有文件的内容不需要动 `embed-media.js`。）

## 与插件壳的能力差异

`Host` 上的可选方法就是差异点：`browseFile`（这里提示输入相对路径）、`reviewReplace`（这里无 diff，纯确认）、`openNativeSettings`（这里不实现，前端隐藏按钮）、`openInEditor` / `saveFromEditor` / `openExternal`（只有这里实现）、`openBeside`（这里开第二块编辑区，插件是 `ViewColumn.Beside`）。`supportsVscodeLm` 为 `false`，Copilot 模型在设置页与下拉框里都被过滤掉。

## 验证

`bun scripts/smoke-server.js`（含在 `npm run smoke` 里）：静态资源、WS 首条消息、Origin 校验，内置编辑器的读写往返——保存落盘、过期基线触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒、无扩展名章节可打开，以及草稿的按需创建与并列打开。
