# core/context — 上下文装配

插件的核心。在有限 token 预算内，把「文风指南 + 全书摘要 + 相关角色卡 + 近章原文 + 会话历史 + 用户引用」按优先级装配成一次请求的消息序列，并如实记录装了什么、丢了什么。

## 文件

| 文件 | 职责 |
|---|---|
| [tokenCounter.ts](tokenCounter.ts) | ★ `TokenCounter` 接口 + 注册表 + 默认的字符加权实现（中文 ≈ 1.5 token/字，拉丁 ≈ 1/4）。另含真实用量的校准统计。 |
| [tokenizer.ts](tokenizer.ts) | 门面：`estimateTokens`（= `countTokens`）与按预算截取的 `takeHead` / `takeTail`。全仓库几十处调用点都走这里。 |
| [builder.ts](builder.ts) | ★ `buildContext()`：分层预算装配器。输入 `BuildRequest`（纲要、目标章、附件、历史、排除名单、模式），输出 `BuiltContext`（messages + 逐条明细 items）。 |

## Token 计数是可替换的

改造前 `estimateTokens` 是一个写死的函数，想换更准的算法得改遍全仓库。现在分三层：

1. **`TokenCounter` 接口**——`count(text)` 数 token、`charsFor(tokens)` 反推字符数（截断要用），可选 `prepare()` 供需要加载 wasm/词表的实现。
2. **注册表**——`registerTokenCounter()` 注册、`useTokenCounter(id)` 切换。切换失败（未注册、`prepare()` 抛错）时**保持原计数器并返回 false**，绝不让「数不了 token」把写作流程带停。
3. **`HeuristicTokenCounter`**——默认实现，就是原来那套系数，零依赖、同步、永不失败。它是所有降级路径的终点。

要接 tiktoken 或服务商的 count_tokens 接口，写一个实现注册进去即可，`builder.ts` 一行都不用改。

**校准回路**：服务商返回真实用量时（`ChatOptions.onUsage` → `recordUsage`）记下「估算/实测」比值，`usageStats()` 可查。它**只用于日志与展示，不自动修正估算值**——估算必须是纯函数，否则同一份上下文两次装配会得出不同的预算判断，「不静默截断」的明细也就不可复现了。没给 usage 的服务商什么都不记，不拿估算冒充实测。

## 分层优先级

| 层级 | 内容 | 预算不足时 |
|---|---|---|
| **P0** | 系统提示、剧情纲要、用户 @ 引用、上一章结尾原文、重写反馈 | 永远保留；引用单条封顶预算 35%，超出从头部截断 |
| **P1** | 本会话历史对话、文风指南、全书滚动摘要 | 整块丢弃并标注；历史上限 30%、单轮 12% |
| **P2** | 相关角色卡 | 降级为「身份 + 当前状态 + 未收伏笔」三节 |
| **P3** | 最近 N 章完整原文（默认 2 章） | 降级为该章摘要 → 丢弃 |
| **P4** | 更早章节摘要、命中关键词的设定 | 由近及远填充，填满即止 |

预算 = `contextWindow - maxOutputTokens - 512`，并与 provider 的 `maxInputTokens` 取小。

## 关键设计

- **不静默截断**：每条 `ContextItem` 带 `status`（included / degraded / dropped / excluded）与人类可读的 `note`，前端折叠展示。作者随时知道这次没带上什么。
- **引用在 P0**：用户特意 @ 的内容不该被自动装配挤掉。
- **历史是多轮消息**：会话历史按 role 交替作为真正消息发出，不是塞一段「以下是之前的对话」；单轮过长取结尾（越靠后越接近当前进度）。
- **去重**：上一章整章原文能完整放下时，P0 的结尾片段自动撤掉，同一段文字不在 prompt 里出现两次。
- **write / discuss 两种模式**：「只输出正文、不要解释」的硬约束只在 write 模式生效。

## 依赖关系

依赖 `model/`（读章节、摘要、角色卡、设定）与 `llm/`（`ChatMessage` 类型）。被 `features/continueWriting` 调用。
