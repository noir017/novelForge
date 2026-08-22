# src — 源码总览

两层结构，依赖方向自上而下，反向不允许：

```
src/
├── core/        核心逻辑：数据、上下文装配、功能编排、LLM 接入（见 core/README.md）
│   ├── model/       数据层：NovelProject、Markdown 解析、创作流水线领域模型、服务商配置、会话
│   ├── context/     ★ 分阶段装配（配方 × 层）+ 身份化提示词 + token 粗估
│   ├── features/    创作（四层产物）/ 批量流水线 / 摘要 / 角色卡 / 设定 / 文风提取
│   ├── llm/         LlmProvider 接口与 OpenAI / Anthropic 实现
│   ├── tools/       ★ 工具层：契约 + 注册表 + novel/ 那八个工具（不认识 agent/）
│   ├── agent/       ★ 多步调度：循环、状态注入、预算、闸门（只认 ToolInvoker）
│   ├── protocol/    webview ↔ 扩展消息协议（前后端唯一契约；对外仍是 core/protocol）
│   ├── controller/  ★ ChatController：宿主无关的面板逻辑
│   ├── views/       ★ 只读聚合：工程树、I/O 流水线、工作区卡、出场人物索引
│   ├── runtime/     ★ 运行时设施：日志、SQLite 痕迹库、失败记录、长任务、并发
│   └── stores.ts    文件后端的配置与密钥存储
└── shells/      三个宿主壳，并排放（见 shells/README.md 的壳契约）
    ├── shared/      两个以上壳共用的页面骨架（所有 pane 的 DOM 唯一来源）
    ├── vscode/      VS Code 壳：extension 入口、两个 webview 宿主、vscode-lm
    ├── standalone/  独立 Web 服务壳：Bun 服务 + WorkspaceHub（工程可空）+ 页面装配
    └── desktop/     桌面壳（Tauri，Rust）：把独立版当 sidecar 装进一个窗口
```

各模块详见：

- [core/README.md](core/README.md)
- [core/model/README.md](core/model/README.md) · [core/context/README.md](core/context/README.md) · [core/features/README.md](core/features/README.md) · [core/llm/README.md](core/llm/README.md)
- [core/tools/README.md](core/tools/README.md) · [core/agent/README.md](core/agent/README.md) —— 「能做什么」与「谁拿着它做」分成两层的理由
- [shells/README.md](shells/README.md) —— 壳的契约（三件事该做、三件事不该做）
- [shells/vscode/README.md](shells/vscode/README.md) · [shells/standalone/README.md](shells/standalone/README.md) · [shells/desktop/README.md](shells/desktop/README.md)

`core/views/pipeline.ts` 是读取磁盘产物的 I/O 聚合器；`core/model/pipeline.ts` 仍是零 I/O
的纯领域模型与状态机，不属于 `views/`。

## 一条创作请求的完整链路

以「排一下第 12 段的剧情」为例。**对话只有一条路：agent**——作者说什么它自己
决定读什么、产出什么，六件创作活（`CreationJob`）走的是同一条链，差别只在配方
与提示词：

1. webview 前端（[media/src/view/](../media/src/view/)）发 `sendAgent` 消息，**只带作者那句话**——不带层、不带要干什么（那两样由 agent 自己算，第 20 条）→ 宿主（`shells/vscode/chatViewProvider` 或 `chatPanel`）转给 `core/ChatController`。
2. `ChatController` 起一轮 `agent/loop.ts`：每回合先把状态机的结论注入 system（`agent/context.ts`），再调模型，模型决定调哪个工具。
3. 它要产出内容时调 `generate` 工具（[core/tools/novel/generate.ts](core/tools/novel/generate.ts)），参数是 `job`（产出什么）+ `target`（落在哪）；工具校验两者落在同一层，然后调 `core/generation/generate.ts`。
4. 那一层经 `core/llm/registry` 拿到 provider，调 `core/context/builder.buildContext()` 装配上下文：按 `stageOfJob(job)` 取一张配方（[core/context/recipes.ts](core/context/recipes.ts)），**只读这一层用得上的文件**，按优先级填预算。系统提示 = 身份（层）+ 这一件活（job）+ 输出契约。
5. provider 流式返回增量文本，经 `ToolContext.onDelta` 回到 `ChatController`，以 `OutMessage` 广播给所有挂接的宿主——作者看得见它正在写什么。
6. 产出解析成产物之后，后端算出「落点 + 形状 + 会不会覆盖」，**当场在对话里问一句「写不写」**（`controller/gate.ts` 推一条 `gate`，前端画成输入框上方的一张权限卡片，与 agent 动手前那一问同一副样子）。
7. 点「确认」→ 目标已有内容时再走 `reviewReplace`，两层都过了才落盘；点「不采纳」则一个字不写，那一行工具条上记一笔。结论接在工具返回里告诉 agent，它于是不会重复生成同一份。

全程 `core/runtime/logger.ts` 记下：这是哪一件活与目标产物、装配用了多少 token / 哪几项被降级丢弃、首字延迟、产出字数与总耗时、最终写到哪个文件。

## 一次批量摘要同步的链路

与上面那条并列，是「长任务」的样板——新加批量功能照着这条接：

1. 前端在工程页点「立即同步」发 `projectAction: 'syncSummaries'` → `ChatController` 调 `core/features/summarize.syncSummaries()`。
2. 先扫一遍新鲜度并**记进日志**（共几章、缺几章、哪几章），再弹确认框——不偷偷烧 token。
3. `core/runtime/progress.runTask('同步章节摘要', …)` 起任务。它一次做三件事：包住 `Host.progress` 拿到宿主原生进度与取消信号；把 `report({ message, current, total })` 登记进任务表；开始/结束进日志附耗时。
4. 任务表一变，`ChatController` 构造时挂的 `onTasksChanged` 就把 `tasks` 快照广播给所有前端 → 工程页顶部的进度条动起来。
5. 逐章 `summarizePlot`（读的是 `chapters/` 里的发布正文——还没拆分的章没有成品，本来就不该总结），每章一条 `info`（用时、平均速度、预计剩余）。**失败不中断整批**，记 `error` 后继续；`signal.aborted` 则停在当前章，已写的摘要保留。
6. 每条日志同时经 `addLogSink` 推成 `log` 消息 → 日志页实时追加。

## 构建

入口由 [esbuild.js](../esbuild.js) 打包为 `dist/extension.js`（`main` 指向它）。TypeScript 配置在根目录 [tsconfig.json](../tsconfig.json)，strict 全开。
