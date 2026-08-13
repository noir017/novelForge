# src — 源码总览

两层结构，依赖方向自上而下，反向不允许：

```
src/
├── core/        核心逻辑：数据、上下文装配、功能编排、LLM 接入（见 core/README.md）
│   ├── model/       数据层：NovelProject、Markdown 解析、创作流水线领域模型、服务商配置、会话
│   ├── context/     ★ 分阶段装配（配方 × 层）+ 身份化提示词 + token 粗估
│   ├── features/    创作（四层产物）/ 批量流水线 / 摘要 / 角色卡 / 设定 / 文风提取
│   ├── llm/         LlmProvider 接口与 OpenAI / Anthropic 实现
│   ├── protocol/    webview ↔ 扩展消息协议（前后端唯一契约；对外仍是 core/protocol）
│   ├── controller/  ★ ChatController：宿主无关的面板逻辑
│   ├── logger.ts    ★ 运行日志：环形缓冲 + sink（脱敏、不记 prompt 全文）
│   ├── progress.ts  ★ 长任务登记处：runTask（宿主进度 + 网页进度条 + 日志三合一）
│   ├── pipeline.ts  ★ 章节流水线的读取聚合：四层产物 + 四段新鲜度链
│   ├── fileOps.ts   类文件操作：建文件夹/重命名/移动/删除（区内、不覆盖、进回收站）
│   ├── fileEditing.ts 内置编辑器的文件读写（路径校验 + hash 乐观锁）
│   └── projectView.ts 工程页可序列化快照（任意深度的 ProjectNode 目录树）
└── shells/      三个宿主壳，并排放（见 shells/README.md 的壳契约）
    ├── shared/      两个以上壳共用的页面骨架（所有 pane 的 DOM 唯一来源）
    ├── vscode/      VS Code 壳：extension 入口、两个 webview 宿主、vscode-lm
    ├── standalone/  独立 Web 服务壳：Bun 服务 + FileHost + 页面装配
    └── desktop/     桌面壳（Tauri，Rust）：把独立版当 sidecar 装进一个窗口
```

各模块详见：

- [core/README.md](core/README.md)
- [core/model/README.md](core/model/README.md) · [core/context/README.md](core/context/README.md) · [core/features/README.md](core/features/README.md) · [core/llm/README.md](core/llm/README.md)
- [shells/README.md](shells/README.md) —— 壳的契约（三件事该做、三件事不该做）
- [shells/vscode/README.md](shells/vscode/README.md) · [shells/standalone/README.md](shells/standalone/README.md) · [shells/desktop/README.md](shells/desktop/README.md)

## 一条创作请求的完整链路

以「在细纲阶段点生成」为例，四个阶段走的是同一条路，差别只在配方与提示词：

1. webview 前端（[media/src/view/](../media/src/view/)）发 `send` 消息，带上 `stage` / `capability` / `target` → 宿主（`shells/vscode/chatViewProvider` 或 `chatPanel`）转给 `core/ChatController`。
2. `ChatController` 校验一遍这个能力在这个阶段合不合法（对不上就回落到 `discuss` 并 warn），记进会话，交给 `core/features/CreationSession.generate()`。
3. `CreationSession` 先经 `core/llm/registry` 拿到 provider，再调 `core/context/builder.buildContext()` 装配上下文。
4. 装配器按 `action.stage` 取一张配方（[core/context/recipes.ts](core/context/recipes.ts)），**只读这一层用得上的文件**，按优先级填预算，产出 messages + 明细。系统提示由 `stage`（身份）× `capability`（任务）拼出。
5. provider 流式返回增量文本，经 `GenerateHandlers` 回到 `ChatController`，以 `OutMessage` 广播给所有挂接的宿主。
6. 收尾时若这次的输出形态是 `artifact`，后端解析一遍并回一份「落点 + 形状 + 会不会覆盖」，前端据此画采纳卡片。
7. 用户改完点「采纳写入」→ `acceptArtifact` **重新解析气泡里当下的文本**（用户可能改过），目标已有内容时先走 `reviewReplace`，确认后才落盘。

全程 `core/logger.ts` 记下：阶段·能力与目标产物、装配用了多少 token / 哪几项被降级丢弃、首字延迟、产出字数与总耗时、最终写到哪个文件。

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
