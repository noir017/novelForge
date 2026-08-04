# ui — 宿主无关的面板逻辑

面板的业务逻辑层：消息协议在这里被翻译成动作（生成、采纳、切会话、存设置），但不关心消息来自哪个 webview。

## 文件

| 文件 | 职责 |
|---|---|
| [chatController.ts](chatController.ts) | ★ `ChatController`：全部面板逻辑。收 `InMessage` → 调度 `ContinueSession` / 会话存储 / 设置读写 → 广播 `OutMessage`。通过 `ViewHost` 接口与宿主解耦，`attach` / `detach` 支持多宿主同时挂接。 |
| [attachments.ts](attachments.ts) | Cursor 式的 @ 引用：QuickPick 列出章节 / 角色卡 / 设定 / 任意工作区文件，以及把编辑器选区转成 `Attachment`（存快照）。 |

## 关键设计

- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂的是同一个 `ChatController`，所以同一会话能在两处同时打开且实时同步。宿主只需实现 `ViewHost`（`post` / `reveal` / `kind`）。
- **状态全量推送**：`pushState()` 把 `ViewState`（当前 tab、会话列表、当前会话、模型清单、设置、工程树快照）整体推给前端，前端无状态、好重建——webview 被销毁重建后一条消息就能恢复。
- **采纳才落盘**：模型回复先留在会话里（可编辑、可重写），用户点「采纳写入」才写进章节文件。
- **附件与排除名单随消息上行**：`SendPayload` 带 `attachments` 与 `excludedIds`（用户在明细里取消勾选的条目），装配器据此调整。

## 依赖关系

依赖 `core/` 全部子层。被 `vscode/` 的两个宿主实例化；消息契约见 [../core/protocol.ts](../core/protocol.ts)。
