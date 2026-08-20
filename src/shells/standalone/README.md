# standalone — 独立 Web 服务壳（Bun）

不装 VS Code 也能用的第二个宿主：本机起一个 Web 服务，浏览器里操作。与插件壳共用 `core/` 与
[shared/panes.ts](../shared/panes.ts)，自己只实现 `Host` 窄接口与一层 HTTP/WebSocket 传输
（壳的契约见 [../README.md](../README.md)）。

## 文件

| 文件 | 职责 |
|---|---|
| [main.ts](main.ts) | 入口。`init` 装上 `TerminalHost` 后走 **core 的** `initProjectFlow`；否则起服务（端口被占顺延，最多 20 次）并按需开浏览器。 |
| [cli.ts](cli.ts) | 参数解析：`novelforge [dir] [--port N] [--no-open] [--verbose]` / `novelforge init [dir]`。 |
| [server.ts](server.ts) | `Bun.serve`：`/` 出页面、`/media/*` 出内嵌资源、`/favicon.ico`、`/ws` WebSocket。`promptResult` 解弹窗，其余先问 `WorkspaceHub`，有激活工程再交给它的 `ChatController`。启动时把 core 的日志接到终端（默认 info 及以上，`--verbose` 放开 debug）。 |
| [workspaceHub.ts](workspaceHub.ts) | 工作区登记处：0 或 1 个工程、热换 `ChatController`、吃掉打开/关闭文件夹与设置类消息。 |
| [windowState.ts](windowState.ts) | `~/.novelforge/window.json`：上次打开的目录与最近打开列表。 |
| [hostFs.ts](hostFs.ts) | 本机一层目录列举与选择器「新建文件夹」。不进 core，agent 拿不到。 |
| [fileHost.ts](fileHost.ts) | `Host` 的实现：弹窗经 `PromptHub` 变成网页 modal；`fs.watch` 监听工程（失败退化为轮询，带 250ms 去抖）；`openFile` 走内置编辑器；`openBeside` 开在第二块编辑区。`progress` 只提供 signal——进度由 `core/runtime/progress.ts` 结构化推给网页。`bind` / `unbind` 随 Hub 热换工程根。 |
| [promptHub.ts](promptHub.ts) | 未决网页弹窗的登记与回执匹配。WS 全部断开时一律按取消处理。 |
| [terminalHost.ts](terminalHost.ts) | `Host` 的终端实现，只给 `novelforge init` 用：问答走 readline，`openFile` 报一句路径。有了它，CLI 只是「第三个宿主」，「初始化工程」这条流程仍然只有一份实现。 |
| [page.ts](page.ts) | **布局**：标题栏 + 活动栏 + 侧栏 + 内置编辑器。六个 pane 的 DOM 全部取自 [../shared/panes.ts](../shared/panes.ts)（含只有这里装配的「文件」页），这里没有第二份。 |
| [assets.ts](assets.ts) | `/media/*` 的字节来源（内嵌资源表）。与 `page.ts` 分开：拼一段 HTML 不该牵进那个几十 MB 的生成文件。 |
| [systemOpen.ts](systemOpen.ts) | 交给系统默认程序打开（`explorer` / `open` / `xdg-open`）。开浏览器与编辑器的「外部打开」共用这一份。 |
| `mediaAssets.ts` | **生成文件**（已 gitignore）。由 [../../scripts/embed-media.js](../../../scripts/embed-media.js) 把前端资源 base64 内嵌（`.js` / `.css` 取自构建产物 `dist/media/`，`icon.svg` 取自 `media/`），使单文件可执行不依赖外部资源。`npm run typecheck` / `test:e2e` / `dist` 前会自动生成。 |

## 关键设计

- **单用户、只绑本机，工程可空**：`127.0.0.1`，无鉴权。工作区由 [workspaceHub.ts](workspaceHub.ts) 持有，窗口里 0 或 1 个工程；多个 WS 连接共享当前那一份 `ChatController`。没有工程时不造假实例，创作类消息 toast「请先打开文件夹」。
- **Origin 校验**：WebSocket 不受同源策略约束，恶意网页能向本机端口发消息。`server.ts` 因此校验 `Origin` 只认本机同端口；没有 `Origin` 头的（命令行工具、冒烟测试）放过。
- **openFile 的语义差异**：插件里是「打开 VS Code 的编辑器 tab」，这里是「在网页内置编辑器里打开」。刻意让 `openFile` 本身改道，这样 controller 里「采纳写入后打开」「点章节」「点上下文条目」三处调用点一次全对。非文本文件回落到系统默认程序。
- **两块编辑区**：`openInEditor(rel, pane)` 的 `pane` 决定 `editorOpen` 落到哪一块，`openBeside` 就是 `pane: 'draft'`。`editorOpen` 广播时顺手带上 `draftPath`（由 `draftPathOf` 从章节路径推导），前端据此显示工具栏上的「草稿」按钮——前端不该自己复刻「什么算章节」。`editorSaved` 也必须带它，否则按钮会在首次保存后消失。
- **文件读写全部经 [../core/files/fileEditing.ts](../../core/files/fileEditing.ts)**：路径包含校验、可编辑判定（扩展名白名单 ∪ 章节文件名规则）、大小上限、保存的 hash 乐观锁都在那里。本层只负责把异常翻译成 `editorError` / `editorConflict` 广播出去，不要绕过它直接 `fs.writeFile`。
- **多一个「文件」页**：侧栏比插件形态多一个资源管理器（[../core/files/fileTree.ts](../../core/files/fileTree.ts) 出数据，`media/src/explorer/` 渲染），列的是磁盘上的真实目录结构，**含 `.novelforge/` 等点开头的文件夹**——插件形态里这件事由 VS Code 自己的资源管理器承担，独立版没有它，作者就没有任何入口去手改摘要/会话/`project.json`。它只读不写：新建/改名/删除仍然只在「工程」页走 `core/files/fileOps.ts`。
- **watcher 只挡二进制，而且规则不在这里**：过滤走 [../../core/watchPolicy.ts](../../core/watchPolicy.ts) 的 `shouldIgnoreChange`（黑名单——章节可以是 `.txt`/无扩展名，目录事件也没有扩展名，白名单式过滤会让这些改动看不见）。插件壳用同一份策略的 glob 形态。因为放行面宽，`onChange` 带 250ms 去抖：它会触发 `pushState`，那是一次全量重扫。
- **进度不再是 toast**：`FileHost.progress` 过去每收到一次 `report` 就弹一条 toast，跑一次「同步 76 章摘要」等于刷 76 条提示、把别的消息全盖掉。现在同一份进度由 `core/runtime/progress.ts` 结构化推成 `tasks` 消息，工程页顶部画进度条（n/N、计时、可停止），`FileHost.progress` 只负责给出 signal 与报告失败。
- **终端 sink 只挂一次**：端口被占时 `main.ts` 会重试着调 `startServer`，每次都 `addLogSink` 会让同一条日志打印好几遍。
- **前端资源三处同改**：新增前端**产物**后，要同时加进 `build-media.js` 的 entryPoints、`embed-media.js` 的 `built` 数组和 `page.ts` 的引用，否则编译版会 404。（只改已有产物的源码不需要动那两个脚本。）`/media/*` 是路由名，不是磁盘路径——字节全部来自内嵌的 `MEDIA_ASSETS`。
- **管道输入也要能跑 init**：`TerminalHost` 全程共用一个 readline，并把没人接的行排队。每问一句就新建再关掉一个（原来那份实现）会让 `printf '书名\n作者\n' | novelforge init` 在第二问就撞上 EOF；而管道是一次全来的，两问之间夹着落盘 await，不排队那几行就白丢了。EOF 一律按「取消」处理，免得在校验失败里死循环。

## 与插件壳的能力差异

`Host` 上的可选方法就是差异点：`browseFile`（这里提示输入相对路径）、`reviewReplace`（这里无 diff，纯确认）、`openNativeSettings`（**这里不实现**，于是 `page.ts` 渲染时就不产出那颗按钮——不是渲染出来再隐藏）、`openInEditor` / `saveFromEditor` / `openExternal`（只有这里实现）、`openBeside`（这里开第二块编辑区，插件是 `ViewColumn.Beside`）。`supportsVscodeLm` 为 `false`，Copilot 模型在设置页与下拉框里都被过滤掉。

## 验证

[`tests/e2e/standalone/server.test.js`](../../../tests/e2e/standalone/server.test.js)（`npm run test:e2e`，需 Bun）：静态资源、WS 首条消息、Origin 校验，内置编辑器的读写往返——保存落盘、过期基线触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒、无扩展名章节可打开，以及草稿的按需创建与并列打开；资源管理器的目录列举——点开头的目录列得出来、目录排在文件前、`editable` 标注、一次多目录、越界与不存在的目录降级成 `error`。

资源管理器的前端行为在 [`tests/dom/standalone/explorer.test.js`](../../../tests/dom/standalone/explorer.test.js) 里（jsdom 跑构建产物 `dist/media/explorer.js`，源码在 `media/src/explorer/`）：懒展开、折叠连带子目录、载入中占位、可编辑与否走不同消息、编辑器高亮联动、截断提示、右键菜单复用 view 的引擎。
