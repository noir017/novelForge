# core/llm — 模型接入层

把「调用大模型」抽象成统一的 `LlmProvider` 接口，上层（features / context）不关心具体协议。

## 文件

| 文件 | 职责 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 接口、`StreamEvent` / `ChatMessage` / `StopSignal` / `StreamOptions`、`CancelledError` / `LlmError`，以及 SSE 流的通用解析与取消/超时处理。 |
| [collect.ts](collect.ts) | ★ 把事件流收成一段文本：`collectText` / `collect` / `mergeUsage`。既有调用点只经这里碰事件流。 |
| [openaiProvider.ts](openaiProvider.ts) | OpenAI 的 **Responses API**（`/responses`，Codex 那一套）。思考深度是 `reasoning.effort`；system 走 `instructions` 顶层字段。**只认 `/chat/completions` 的服务商（DeepSeek / 智谱 / Kimi / 通义 / 本地 Ollama）在这条路上会 404**——见下面「两条协议，两个梯子」。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要单独提取、相邻同角色消息要合并、首条必须是 user。思考深度有**两代写法**，由 provider 自己问出来（见下）。 |
| [registry.ts](registry.ts) | ★ 按「前缀/模型名」引用构造 provider；API Key 按服务商 id 存 SecretStorage（含 0.1.x 按 kind 存的迁移）；连接测试。 |
| [pool.ts](pool.ts) | ★ 模型池：按**任务档位**取模型，并把该档的清单变成**轮转负载均衡**（并发）与**随机 fallback**（串行失败后换模型重试）。另出 `budgetForTask()`——不构造 provider 的预算查询。只给工程页的后台任务用。 |

> `vscode-lm`（Copilot）的实现在 [../../shells/vscode/vscodeLmProvider.ts](../../shells/vscode/vscodeLmProvider.ts)——它依赖 VS Code Language Model API，属于宿主层，但由本层的 registry 统一分发。

## 关键设计

- **`StreamEvent` 是唯一原语**：`stream(messages, options): AsyncIterable<StreamEvent>`，四种事件 `text` / `reasoning` / `usage` / `stop`。取消经 `AbortSignal`，超时经 `timeoutMs`（**空闲超时**：流式还在吐字时重置，卡住这么久没数据才中止）。**没有第二条路**——provider 总是全量发事件，不由「调用方想不想听」决定发不发：usage 是校准 tokenCounter 的唯一实测来源，thinking 是「正文还没开始吐」这段时间界面上唯一的反馈，都不该由调用方开关。要文本的调用点一律走 `collectText`，形状仍是「传一个流，拿一段文本」。
- **usage 按字段合并**：同一次请求会回报多次（Anthropic 在 `message_start` 给输入、`message_delta` 给输出），所以 `mergeUsage` 是**后到的覆盖同名字段、缺席的字段保留**。整份覆盖会让先到的输入用量被后一条抹掉，估算/实测比值就废了。
- **消息只有 system / user / assistant 三种角色**（`ChatMessage`），内容都是纯文本。本层不做工具调用：外部 agent 经 MCP（[../mcp](../mcp/README.md)）直接调我们的工具，模型侧的 tool calling 与这一层无关。
- **错误说人话**：HTTP 401/404/429 等都在 provider 内整理成面向作者的中文提示后以 `LlmError` 抛出；用户主动取消抛 `CancelledError`，调用方静默处理。
- **API Key 按服务商 id 分开存**：同一种协议可以并存多个服务商（官方接口、路由型服务商、自建网关都可以是同一种 kind），各有各的 Key。`vscode-lm` 走 Copilot 授权，不需要 Key。
- **硬配额上报**：`maxInputTokens()` 返回 provider 的硬性输入上限（vscode-lm 有配额），装配器会与 `contextWindow` 取小。
- **思考深度只作用于作者选定的那个模型**：`StreamOptions.thinking` 由对话页的单次生成带上（作者在会话上选的那一档），**工程页的后台批量任务一律不带**。理由与第 12 条同源——那一档模型是作者按成本挑的，替他把七十六章的摘要都升级成深思考，账单上看不出是谁决定的。

## 两条协议，两个梯子

**openai 这种 kind 走 Responses（`/responses`），anthropic 走 Messages，没有第三条路。**
思考深度的落点只在这两条协议上：老的 `/chat/completions` 里「想多深」不是一个字段（要么
是模型名的一部分，要么根本没有），界面上那个下拉框就无处可去。两条协议并存的代价是每个
字段都要先判一次「现在是哪一条」，而设置页也要让作者先答一道他答不上来的题。

代价说清楚：**只认 `/chat/completions` 的服务商（DeepSeek、智谱、Kimi、通义、本地 Ollama）
在这条路上会 404**，404 的提示里点了这件事，「添加服务商」的预设里也不再摆它们（点了就
404 的按钮比找不到更让人恼火）。要用它们仍然可以手工添加一个自己那侧的 `/responses` 网关。

思考深度是**一个档位、两套字段**（档位表在 [../model/thinking.ts](../model/thinking.ts)）：

| 档 | OpenAI Responses | Anthropic Messages |
|---|---|---|
| 不思考 | 不带 `reasoning` | 不带 `thinking` / `output_config` |
| 浅 / 中 / 深 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` |
| 极限 | `reasoning.effort: xhigh` | `output_config.effort: max` |

另外三条与它绑在一起：

- **思考开着时不带 `temperature`**。两家都要求它是默认值，带上去就是 400。关着时照常带——
  非推理模型上它仍然是有效的文风旋钮。
- **上游拒了就换一种写法，不把这一轮判死**。`effort` 的梯子上老模型缺顶上那两档；Anthropic
  更是有两代写法（自适应 `thinking: {type:'adaptive'}` + `output_config.effort`，以及 4.5 及
  更早唯一可用的手动预算 `thinking: {type:'enabled', budget_tokens}`，后者在 4.7 以后直接被
  拒）。两个 provider 各自按「接口地址 + 模型」把结论记在内存里（`QUIRKS`）：降一档、换一代
  写法、最后退到不带思考字段，每种模型一生只吃一次 400。**记在内存而不是配置里**——这是上游
  的事实，不是作者的偏好，写进设置页只会多一个他答不上来的问题。
- **手动预算那条路上，预算必须小于 `max_tokens`**（思考 token 算在输出上限里，且下限是 1024）。
  所以 `thinkingBudget` 按输出上限收紧，收不出 1024 就不带思考字段，而不是发一个必然 400 的请求。

### 收尾原因：`StopSignal`

两家都把上游的收尾原因归一成 `StopSignal`（`end` / `maxTokens` / `other`），以 `stop` 事件交上去。用它的是正文续写链（[../generation/continuation.ts](../generation/continuation.ts)：`maxTokens` 往后接、`end` 说明结尾已落在章末钩子上）与工程页批量（[../features/pipelineBatch.ts](../features/pipelineBatch.ts)：判断结构化输出是否被截断）。

- **上游不发就一个都不交**（`undefined` 意为「它没说」）。补一个默认值等于替它编一句话，而续写链会照着那句话决定回退还是往后接。
- Anthropic 的 `stop_reason` 在 `message_delta` 上；认不出的值（`pause_turn`、`refusal`……）一律 `other`。Responses 那条路上 `response.completed` 报 `end`，`response.incomplete` 按 `incomplete_details.reason` 报 `maxTokens` 或 `other`。

## 模型池的五条规矩

模型分为**三档**（快速 / 均衡 / 精标，见 [../model/tiers.ts](../model/tiers.ts)），每档各是一份有序清单。`createModelPool({ task })` 按任务所属的档取清单，把它变成一个能换人的池，但**只有工程页的后台任务**（补齐设定、批量拆细纲、批量写章与写完即审稿 / 定稿、摘要、角色卡、设定、文风、角色提取）以及经 MCP 接入的外部 agent 调生成工具时（只取首选，见 [../tools/novel/generate.ts](../tools/novel/generate.ts)）走它——对话页的单次生成（写正文、审稿、修稿……）与连接测试必须严格用用户选定的那个模型，中途换人会让文风断掉。

1. **空档位沿用「默认模型」**：某一档没配模型，归在该档的任务就用 `config.models`。三档都不配 = 不分档，行为与分档之前逐字节一致。这条是硬约束——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。
2. **起始模型看场景**：并发任务（`concurrent: true`）按游标轮转，把请求摊到几个服务商上；串行任务恒取该档的 `refs[0]`，与「档内第一个是首选」的直觉一致。
3. **fallback 是换人，不是重试，而且不跨档**：失败后从**同档里没试过的**模型里随机挑一个，最多 `config.fallbackAttempts` 次；同一个模型不会被试两遍，档里只有一个模型时干脆不重试，档内换完了就上抛——**绝不去别的档捞人**。快速档失败自动升级到精标档，等于绕过作者的成本决定去烧贵 token，而且从日志上看不出来。`CancelledError` 立刻上抛——用户点了停止还接着换模型，会让「停止」看起来失灵。
4. **只有该档首选能弹 Key 输入框**：备选模型一律 `buildProvider(active, { promptForKey: false })`，缺 Key / 环境不支持就剔除并 `warn`。一次点击连弹五个 API Key 输入框，比没有 fallback 更让人恼火。
5. **预算跟着干活的模型走**：`pool.primaryBudget` 是该档**首选模型**的窗口与输出上限（模型自带的优先，缺省退回内置兼容值）。features 切批、截断一律读它，不能读 `config.contextWindow`——后者是**对话页选定模型**的窗口，拿 200k 的写作模型的窗口去给 32k 的快速档模型切批会稳定超窗。取首选而非全池最小值：fallback 是小概率路径，为它把每一批都切小等于让常态下每次调用都少读几段。

确认框之前就要算的东西（设定生成的扫描片段数、角色卡的批数——它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`：它只解析引用、不构造 provider，因此不会在用户点确认之前弹出 API Key 输入框。

## 依赖关系

依赖 `model/`（读配置、解析模型引用）。被 `features/` 使用；`initSecrets` 由 `vscode/extension.ts` 在激活时调用以注入 SecretStorage。
