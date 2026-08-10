# src — 源码总览

三层结构，依赖方向自上而下，反向不允许：

```
src/
├── core/        核心逻辑：数据、上下文装配、功能编排、LLM 接入（见 core/README.md）
│   ├── model/       数据层：NovelProject、Markdown 解析、服务商配置、会话
│   ├── context/     ★ 分层预算上下文装配器 + token 粗估
│   ├── features/    续写 / 摘要 / 角色卡 / 设定 / 文风提取
│   ├── llm/         LlmProvider 接口与 OpenAI / Anthropic 实现
│   ├── protocol.ts  webview ↔ 扩展消息协议（前后端唯一契约）
│   ├── logger.ts    ★ 运行日志：环形缓冲 + sink（脱敏、不记 prompt 全文）
│   ├── progress.ts  ★ 长任务登记处：runTask（宿主进度 + 网页进度条 + 日志三合一）
│   ├── fileOps.ts   类文件操作：建文件夹/重命名/移动/删除（区内、不覆盖、进回收站）
│   ├── fileEditing.ts 内置编辑器的文件读写（路径校验 + hash 乐观锁）
│   └── projectView.ts 工程页可序列化快照（任意深度的 ProjectNode 目录树）
├── ui/          宿主无关的面板逻辑：ChatController + @ 引用（见 ui/README.md）
├── vscode/      VS Code 宿主层：extension 入口、两个 webview 宿主、vscode-lm（见 vscode/README.md）
└── standalone/  独立 Web 服务壳：Bun 服务 + FileHost + 页面骨架（见 standalone/README.md）
```

各模块详见：

- [core/README.md](core/README.md)
- [core/model/README.md](core/model/README.md) · [core/context/README.md](core/context/README.md) · [core/features/README.md](core/features/README.md) · [core/llm/README.md](core/llm/README.md)
- [ui/README.md](ui/README.md)
- [vscode/README.md](vscode/README.md) · [standalone/README.md](standalone/README.md)

## 一条续写请求的完整链路

1. webview 前端（[media/src/view/](../media/src/view/)）发 `send` 消息 → 宿主（`vscode/chatViewProvider` 或 `chatPanel`）转给 `ui/ChatController`。
2. `ChatController` 把 payload 交给 `core/features/ContinueSession.generate()`。
3. `ContinueSession` 先经 `core/llm/registry` 拿到 provider，再调 `core/context/builder.buildContext()` 装配上下文。
4. 装配器从 `core/model/NovelProject` 读文风、摘要、角色卡、近章原文，按 P0–P4 填预算，产出 messages + 明细。
5. provider 流式返回增量文本，经 `GenerateHandlers` 回到 `ChatController`，以 `OutMessage` 广播给所有挂接的宿主。
6. 用户编辑后点「采纳写入」，`ChatController` 经 `NovelProject` 落盘到 `chapters/`。

全程 `core/logger.ts` 记下：模型与目标章、装配用了多少 token / 哪几项被降级丢弃、首字延迟、产出字数与总耗时、最终写到哪个文件。

## 一次批量摘要同步的链路

与上面那条并列，是「长任务」的样板——新加批量功能照着这条接：

1. 前端点「立即同步」发 `projectAction: 'syncSummaries'` → `ChatController` 调 `core/features/summarize.syncSummaries()`。
2. 先扫一遍新鲜度并**记进日志**（共几章、缺几章、哪几章），再弹确认框——不偷偷烧 token。
3. `core/progress.runTask('同步章节摘要', …)` 起任务。它一次做三件事：包住 `Host.progress` 拿到宿主原生进度与取消信号；把 `report({ message, current, total })` 登记进任务表；开始/结束进日志附耗时。
4. 任务表一变，`ChatController` 构造时挂的 `onTasksChanged` 就把 `tasks` 快照广播给所有前端 → 工程页顶部的进度条动起来。
5. 逐章 `summarizeChapter`，每章一条 `info`（用时、平均速度、预计剩余）。**失败不中断整批**，记 `error` 后继续；`signal.aborted` 则停在当前章，已写的摘要保留。
6. 每条日志同时经 `addLogSink` 推成 `log` 消息 → 日志页实时追加。

## 构建

入口由 [esbuild.js](../esbuild.js) 打包为 `dist/extension.js`（`main` 指向它）。TypeScript 配置在根目录 [tsconfig.json](../tsconfig.json)，strict 全开。
