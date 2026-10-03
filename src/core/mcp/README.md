# core/mcp — 把工具端给外部 agent

**多步的活交给外部 agent（Claude Code、Codex……），Novel Forge 只提供工具。**

本项目不自带对话循环。上下文压缩、多步规划、权限模式、各家服务商的 tool calling 兼容——这些通用
agent 做得更好，自己再做一份只是更弱的重复。真正值钱的不在循环里：创作质量来自分阶段装配
（`generate` 内部那次调用），工程动作的不变量在 `features/` 里（`pipeline` / `summary` / `characters` 那几个工具转发过去）。

所以这一层只做一件事：把 [`tools/`](../tools/README.md) 那套工具经 MCP 端出去，外部 agent 自带循环。

| 文件 | 职责 |
|---|---|
| [server.ts](server.ts) | ★ 协议：`initialize` / `ping` / `tools/list` / `tools/call` / `notifications/cancelled`，会话，状态简报 |
| [http.ts](http.ts) | Streamable HTTP 传输：POST 回 JSON、会话头、DELETE、GET 405、Origin 校验。只用标准 `Request` / `Response` |
| [instructions.ts](instructions.ts) | `initialize` 回给客户端的使用说明（只说怎么用工具，不写领域知识） |
| [index.ts](index.ts) | `createNovelMcp(backend)`：工具清单 + 说明 + 传输，壳只给「当前工程的执行端」 |

执行端在 [controller/mcp.ts](../controller/mcp.ts)：一次调用落到当前打开的那个工程上。

## 怎么接

独立版（含桌面版的 sidecar）启动时在同一个端口上挂 `/mcp`，日志里会打一行：

```
MCP 已就绪：http://127.0.0.1:3000/mcp
    claude mcp add --transport http novelforge http://127.0.0.1:3000/mcp
```

调用落在**网页上当前打开的那个工程**上；没打开工程时工具照样列得出来，调用回一句「先打开工程」。
VS Code 壳还没接（要另起一个 HTTP 服务，等用得上再说）。

## 分层

```
外部 agent ──HTTP──▶ mcp/http.ts ──▶ mcp/server.ts ──McpBackend──▶ controller/mcp.ts ──▶ tools/（ToolRegistry）
                                       （只懂协议）                    （生成位、对话页、两问）
```

`mcp/` 只认 `tools/` 的契约（`ToolSpec`、`NOVEL_TOOLS`），**不认识 `Workspace` / `DraftStore` /
`ChatController`**；`tools/` 一行都不 import `mcp/` 与 `controller/`。两条由
[tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js) 守着。

## 四条约束

### 1. 产物不回灌

`generate` 的返回里只有形状与 `draftId`，**没有正文**。正文照旧流进对话页那个 MCP 气泡里的工具卡片
（`toolDelta`），外部 agent 看不到——它每走一步都重烧一遍上下文，三千字正文塞回去，十步之后就是
三万字的重复账单。要看内容，等落盘之后 `read`。

### 2. 落盘前当场过一遍人（第 19 条）

`generate` 一产出，执行端就在 Novel Forge 的对话页里问一句写不写（与单步创作同一张卡片），
**等作者答了才返回**，结论接在返回后面。这一问不交给宿主的权限配置：宿主那一层管的是「让不让调这个
工具」，可以被设成全自动；这一问管的是「这份东西进不进磁盘」，任何情况下都在。

`always` 那一档（`edit`、装 / 绑技能、改技能文件）同理：下游没有 diff，动手前先在对话页问。
覆盖已有内容走 workspace 的覆盖审阅，与这一层无关。

### 3. 状态由状态机给（第 20 条）

MCP 没有「每回合往 system 里注入」这个口子，于是状态机给出的那份简报
（[views/stateBrief.ts](../views/stateBrief.ts)）贴在工具结果末尾，**只在它变了的时候贴**：会话的第一次
调用必贴，之后与上一次贴出去的那份逐字比。仍然没有 `status` 工具。

### 4. 与对话页共用一把生成锁

花钱或写盘的调用占的是与对话页单步创作同一个生成位（两条路都往对话页里流正文、挂卡片，同时跑会互相盖）。
占不到就当场回 `isError`（「正在跑另一个生成任务」），不排队——排着的调用作者看不见，等它突然开始写盘时他早就忘了这回事。占到了就走 `runTask`：
进度条上看得见、能停；停止会中断那一次调用。查询（`list` / `read` / `search`、查技能）不占锁、不进对话页。

## 长调用

写一章可能跑几分钟，期间连接上一个字节都没有。不回 SSE、不发进度通知：等它跑完回一整份 JSON。
Bun 缺省 10 秒空闲就断连接，所以壳对 `/mcp` 的请求调 `server.timeout(req, 0)`。客户端那一侧的
工具超时要自己放宽（Codex 缺省 60 秒）。

取消有两条路：客户端发 `notifications/cancelled`，或者连接断了——都会中断那一次调用。
