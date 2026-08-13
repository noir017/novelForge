# core/context — 上下文装配

插件的核心。在有限 token 预算内，把「文风指南 + 全书摘要 + 相关角色卡 + 本层产物 + 近章原文 + 会话历史 + 用户引用」按优先级装配成一次请求的消息序列，并如实记录装了什么、丢了什么。

## 文件

| 文件 | 职责 |
|---|---|
| [tokenCounter.ts](tokenCounter.ts) | ★ `TokenCounter` 接口 + 注册表 + 默认的字符加权实现（中文 ≈ 1.5 token/字，拉丁 ≈ 1/4）。另含真实用量的校准统计。 |
| [tokenizer.ts](tokenizer.ts) | 门面：`estimateTokens`（= `countTokens`）与按预算截取的 `takeHead` / `takeTail`。全仓库几十处调用点都走这里。 |
| [types.ts](types.ts) | `BuildRequest` / `BuiltContext` / `ContextItem` / `LayerId` / `LayerSpec`。单独成文件是为了打断 recipes 与 layers 的循环引用。 |
| [recipes.ts](recipes.ts) | ★ 四个阶段各带哪些层、优先级多少。**改装配策略只改这一张表。** |
| [layers/](layers/index.ts) | ★ 每一层的取数与注入，外加 `resolveFocus`（按配方只读用得上的文件）。`LAYERS` 注册表在 index，实现按 dialog / artifacts / background 拆开。 |
| [prompts.ts](prompts.ts) | ★ 身份（Stage）× 任务（Capability）× 输出契约。 |
| [builder.ts](builder.ts) | ★ `buildContext()`：算预算 → 按配方跑一遍层 → 拼 messages。 |

## Token 计数是可替换的

改造前 `estimateTokens` 是一个写死的函数，想换更准的算法得改遍全仓库。现在分三层：

1. **`TokenCounter` 接口**——`count(text)` 数 token、`charsFor(tokens)` 反推字符数（截断要用），可选 `prepare()` 供需要加载 wasm/词表的实现。
2. **注册表**——`registerTokenCounter()` 注册、`useTokenCounter(id)` 切换。切换失败（未注册、`prepare()` 抛错）时**保持原计数器并返回 false**，绝不让「数不了 token」把写作流程带停。
3. **`HeuristicTokenCounter`**——默认实现，就是原来那套系数，零依赖、同步、永不失败。它是所有降级路径的终点。

要接 tiktoken 或服务商的 count_tokens 接口，写一个实现注册进去即可，`builder.ts` 一行都不用改。

**校准回路**：服务商返回真实用量时（`ChatOptions.onUsage` → `recordUsage`）记下「估算/实测」比值，`usageStats()` 可查。它**只用于日志与展示，不自动修正估算值**——估算必须是纯函数，否则同一份上下文两次装配会得出不同的预算判断，「不静默截断」的明细也就不可复现了。没给 usage 的服务商什么都不记，不拿估算冒充实测。

## 分阶段装配

一次装配由 `BuildRequest.action.stage` 决定带什么。四张配方在 [recipes.ts](recipes.ts) 里，**顺序即填充顺序**：

| 阶段 | 身份 | 带什么 | 明确不带 |
|---|---|---|---|
| **大纲** | 策划编辑 | 大纲全文（P0 force）、全书摘要、全书各章摘要 | 正文原文 |
| **细纲** | 剧情导演 | 本章细纲（P0 force）、大纲、上一章细纲、前文摘要 | 正文原文 |
| **细节** | 编剧 | 本场场景卡 + 本章细纲（P0 force）、前后两场、**角色卡 P1** | 正文原文 |
| **正文** | 作者 | **文风指南 P0 force**、场景卡、上一章结尾、近 N 章原文…全套 | —— |

两处刻意的抬高（表里加粗的两条）：

- **正文阶段文风指南升到 P0 force**。它是「读者感觉不到换人执笔」的唯一保障，不该跟一段长对话抢预算——改之前它在 P1，一段长对话（封顶 30%）加几张角色卡就能把它挤掉。
- **细节阶段角色卡按场景 frontmatter 的 `characters` 精确取**，不再靠在用户那一句话里做子串匹配。用户说「把这一场写扎实点」时一个人名都没有，旧筛选会把在场的人全漏掉。

**前三个阶段都不带正文原文**：讨论故事结构或章节调度时读三章原文既没用又昂贵，一章三千字 × 近三章，够装下整本书的摘要还有富余。

## 预算与降级

| 优先级 | 预算不足时 |
|---|---|
| P0 · force | 永远保留（系统提示、用户这一句、本层产物） |
| 用户 @ 的引用 | 单条封顶预算 35%，超出从头部截断而非丢弃 |
| 会话历史 | 整体封顶 30%、单轮 12%，由近及远保留，更早的整轮丢弃 |
| 角色卡 | 降级为「身份 + 当前状态 + 未收伏笔」三节 |
| 章节原文 | 降级为该章摘要 → 丢弃 |
| 更早章节摘要 | 由近及远填充，填满即止 |

预算 = `contextWindow - maxOutputTokens - 512`，并与 provider 的 `maxInputTokens` 取小。

## 关键设计

- **不静默截断**：每条 `ContextItem` 带 `status`（included / degraded / dropped / excluded）与人类可读的 `note`，前端折叠展示。作者随时知道这次没带上什么。
- **层与配方分离**：「带什么」在 recipes、「怎么取」在 layers。让细纲阶段不带正文原文是配方里少写一行，不是装配器里多一个 if。
- **只读用得上的文件**：`resolveFocus` 按配方决定读不读上一章细纲、读不读场景目录。正文阶段每次生成都多读一份用不上的细纲，那是落在关键路径上的浪费。
- **引用在 P0**：用户特意 @ 的内容不该被自动装配挤掉。
- **历史是多轮消息**：会话历史按 role 交替作为真正消息发出，不是塞一段「以下是之前的对话」；单轮过长取结尾（越靠后越接近当前进度）。
- **去重**：上一章整章原文能完整放下时，P0 的结尾片段自动撤掉，同一段文字不在 prompt 里出现两次。
- **讨论型能力禁止改写产物**：`outputKindOf(action) === 'text'` 时系统提示里明写「只回答，不要输出改写后的完整产物」。少了这一条，模型会一边回答一边把整份细纲重写一遍，而界面上那一版是不能采纳的。

## 依赖关系

依赖 `model/`（读章节、摘要、角色卡、设定、细纲、场景；`model/pipeline.ts` 提供 Stage × Capability × Target）与 `llm/`（`ChatMessage` 类型）。被 `features/creation.ts`（创作页单次生成）与 `features/pipelineBatch.ts`（工程页批量）调用——两者走同一个 `buildContext`，因此批量与单次产出的是同一个质量。
