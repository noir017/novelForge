# core/llm — 模型接入层

把「调用大模型」抽象成统一的 `LlmProvider` 接口，上层（features / context）不关心具体协议。

## 文件

| 文件 | 职责 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 接口、`StreamEvent` / `AgentMessage` / `ToolSpec` / `StreamOptions`、`CancelledError` / `LlmError`，以及 SSE 流的通用解析与取消/超时处理。 |
| [collect.ts](collect.ts) | ★ 把事件流收成一段文本：`collectText` / `collect` / `mergeUsage`。既有调用点只经这里碰事件流。 |
| [openaiProvider.ts](openaiProvider.ts) | OpenAI 兼容协议（OpenAI / DeepSeek / 智谱 / Kimi / 通义 / OpenRouter / 本地 Ollama 都走这里）。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要单独提取、相邻同角色消息要合并、`tool_result` 是 user 消息里的 content block。 |
| [registry.ts](registry.ts) | ★ 按「前缀/模型名」引用构造 provider；API Key 按服务商 id 存 SecretStorage（含 0.1.x 按 kind 存的迁移）；连接测试。 |
| [pool.ts](pool.ts) | ★ 模型池：按**任务档位**取模型，并把该档的清单变成**轮转负载均衡**（并发）与**随机 fallback**（串行失败后换模型重试）。另出 `budgetForTask()`——不构造 provider 的预算查询。只给工程页的后台任务用。 |

> `vscode-lm`（Copilot）的实现在 [../../shells/vscode/vscodeLmProvider.ts](../../shells/vscode/vscodeLmProvider.ts)——它依赖 VS Code Language Model API，属于宿主层，但由本层的 registry 统一分发。

## 关键设计

- **`StreamEvent` 是唯一原语**：`stream(messages, options): AsyncIterable<StreamEvent>`，四种事件 `text` / `reasoning` / `toolCall` / `usage`。取消经 `AbortSignal`，超时经 `timeoutMs`。**没有第二条路**——从前 reasoning 与 usage 挂在 options 的回调上，那是「调用方想不想听决定 provider 发不发」，方向反了：usage 是校准 tokenCounter 的唯一实测来源，thinking 是「正文还没开始吐」这段时间界面上唯一的反馈，都不该由调用方开关。要文本的调用点一律走 `collectText`，形状仍是「传一个流，拿一段文本」。
- **usage 按字段合并**：同一次请求会回报多次（Anthropic 在 `message_start` 给输入、`message_delta` 给输出），所以 `mergeUsage` 是**后到的覆盖同名字段、缺席的字段保留**。整份覆盖会让先到的输入用量被后一条抹掉，估算/实测比值就废了。
- **错误说人话**：HTTP 401/404/429 等都在 provider 内整理成面向作者的中文提示后以 `LlmError` 抛出；用户主动取消抛 `CancelledError`，调用方静默处理。
- **API Key 按服务商 id 分开存**：同一种协议可以并存多个服务商（智谱官方、OpenRouter、本地 Ollama 都是 openai 兼容），各有各的 Key。`vscode-lm` 走 Copilot 授权，不需要 Key。
- **硬配额上报**：`maxInputTokens()` 返回 provider 的硬性输入上限（vscode-lm 有配额），装配器会与 `contextWindow` 取小。

## 工具调用：三家三个坑

工具调用的分片累积是这一层八成的 bug 来源，三家的形状完全不同：

| 服务商 | 怎么来 | 坑 |
|---|---|---|
| OpenAI 兼容 | `delta.tool_calls[]`，每片带 `index` / 可选 `id` / 可选 `function.name` / `function.arguments` 片段 | **按 `index` 累积，不是按 `id`**——`id` 只在第一片给，`name` 通常也只给一次。按 id 累积会让后续每片各开一个空 id 的槽，参数永远拼不起来。多个并行调用各占一个 index，流结束才 yield |
| Anthropic | `content_block_start`（`content_block.type === 'tool_use'`，带 `id` / `name`）+ 若干 `content_block_delta`（`input_json_delta` 的 `partial_json`）+ `content_block_stop` | 参数是**逐字符拼出来的 JSON 串**，只有 `content_block_stop` 之后才完整。另外 **`tool_result` 不是独立 role**：它是一条 `user` 消息 content 数组里的 block，连续的 `tool` 消息要合并进**一条** user，各自成条会让 user/assistant 不再交替 |
| vscode-lm | `response.stream` 里的 `LanguageModelToolCallPart` | 参数已经是解析好的对象，不用累积。但**必须走 `response.stream` 而不是 `response.text`**——后者把工具调用整段滤掉了。系统提示仍要并进首条 user |

另外两条对三家一致：

- **`args` 解析失败绝不抛**。发一个 `args: {}` 的 `toolCall`，`raw` 保留原文，由上层报「参数解析失败」给模型看让它重试。抛异常会炸掉整轮对话——模型少写一个右花括号，用户丢的是整段生成。解析出数组或字符串也按同样的方式退成空对象：下游拿 `args.path` 会得到 `undefined`，那比 `[1,2].path` 更容易报出人话。
- **没有工具时一律不带 `tools` / `tool_choice`**。有些兼容实现见到未知字段会直接 400，`stream_options` 上已经踩过这个坑。

## 模型池的五条规矩

模型分为**三档**（快速 / 均衡 / 精标，见 [../model/tiers.ts](../model/tiers.ts)），每档各是一份有序清单。`createModelPool({ task })` 按任务所属的档取清单，把它变成一个能换人的池，但**只有工程页的后台任务**（摘要、角色卡、设定、文风、角色提取）走它——对话页续写与连接测试必须严格用用户选定的那个模型，中途换人会让文风断掉。

1. **空档位沿用「默认模型」**：某一档没配模型，归在该档的任务就用 `config.models`。三档都不配 = 不分档，行为与分档之前逐字节一致。这条是硬约束——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。
2. **起始模型看场景**：并发任务（`concurrent: true`）按游标轮转，把请求摊到几个服务商上；串行任务恒取该档的 `refs[0]`，与「档内第一个是首选」的直觉一致。
3. **fallback 是换人，不是重试，而且不跨档**：失败后从**同档里没试过的**模型里随机挑一个，最多 `config.fallbackAttempts` 次；同一个模型不会被试两遍，档里只有一个模型时干脆不重试，档内换完了就上抛——**绝不去别的档捞人**。快速档失败自动升级到精标档，等于绕过作者的成本决定去烧贵 token，而且从日志上看不出来。`CancelledError` 立刻上抛——用户点了停止还接着换模型，会让「停止」看起来失灵。
4. **只有该档首选能弹 Key 输入框**：备选模型一律 `buildProvider(active, { promptForKey: false })`，缺 Key / 环境不支持就剔除并 `warn`。一次点击连弹五个 API Key 输入框，比没有 fallback 更让人恼火。
5. **预算跟着干活的模型走**：`pool.primaryBudget` 是该档**首选模型**的窗口与输出上限（模型自带的优先，缺省退回内置兼容值）。features 切批、截断一律读它，不能读 `config.contextWindow`——后者是**对话页选定模型**的窗口，拿 200k 的写作模型的窗口去给 32k 的快速档模型切批会稳定超窗。取首选而非全池最小值：fallback 是小概率路径，为它把每一批都切小等于让常态下每次调用都少读几段。

确认框之前就要算的东西（设定生成的扫描片段数、角色卡的批数——它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`：它只解析引用、不构造 provider，因此不会在用户点确认之前弹出 API Key 输入框。

## 依赖关系

依赖 `model/`（读配置、解析模型引用）。被 `features/` 使用；`initSecrets` 由 `vscode/extension.ts` 在激活时调用以注入 SecretStorage。
