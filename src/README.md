# src — 源码总览

三层结构，依赖方向自上而下，反向不允许：

```
src/
├── core/        核心逻辑：数据、上下文装配、功能编排、LLM 接入（见 core/README.md）
│   ├── model/       数据层：NovelProject、Markdown 解析、服务商配置、会话
│   ├── context/     ★ 分层预算上下文装配器 + token 粗估
│   ├── features/    续写 / 摘要 / 角色卡 / 文风提取
│   ├── llm/         LlmProvider 接口与 OpenAI / Anthropic 实现
│   ├── protocol.ts  webview ↔ 扩展消息协议（前后端唯一契约）
│   └── projectView.ts 工程页可序列化快照
├── ui/          宿主无关的面板逻辑：ChatController + @ 引用（见 ui/README.md）
└── vscode/      VS Code 宿主层：extension 入口、两个 webview 宿主、vscode-lm（见 vscode/README.md）
```

各模块详见：

- [core/README.md](core/README.md)
- [core/model/README.md](core/model/README.md) · [core/context/README.md](core/context/README.md) · [core/features/README.md](core/features/README.md) · [core/llm/README.md](core/llm/README.md)
- [ui/README.md](ui/README.md)
- [vscode/README.md](vscode/README.md)

## 一条续写请求的完整链路

1. webview 前端（[media/view.js](../media/view.js)）发 `send` 消息 → 宿主（`vscode/chatViewProvider` 或 `chatPanel`）转给 `ui/ChatController`。
2. `ChatController` 把 payload 交给 `core/features/ContinueSession.generate()`。
3. `ContinueSession` 先经 `core/llm/registry` 拿到 provider，再调 `core/context/builder.buildContext()` 装配上下文。
4. 装配器从 `core/model/NovelProject` 读文风、摘要、角色卡、近章原文，按 P0–P4 填预算，产出 messages + 明细。
5. provider 流式返回增量文本，经 `GenerateHandlers` 回到 `ChatController`，以 `OutMessage` 广播给所有挂接的宿主。
6. 用户编辑后点「采纳写入」，`ChatController` 经 `NovelProject` 落盘到 `chapters/`。

## 构建

入口由 [esbuild.js](../esbuild.js) 打包为 `dist/extension.js`（`main` 指向它）。TypeScript 配置在根目录 [tsconfig.json](../tsconfig.json)，strict 全开。
