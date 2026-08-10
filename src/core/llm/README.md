# core/llm — 模型接入层

把「调用大模型」抽象成统一的 `LlmProvider` 接口，上层（features / context）不关心具体协议。

## 文件

| 文件 | 职责 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 接口、`ChatMessage` / `ChatOptions`、`CancelledError` / `LlmError`、`collectStream`，以及 SSE 流的通用解析与取消/超时处理。 |
| [openaiProvider.ts](openaiProvider.ts) | OpenAI 兼容协议（OpenAI / DeepSeek / 智谱 / Kimi / 通义 / OpenRouter / 本地 Ollama 都走这里）。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要单独提取、相邻同角色消息要合并。 |
| [registry.ts](registry.ts) | ★ 按「前缀/模型名」引用构造 provider；API Key 按服务商 id 存 SecretStorage（含 0.1.x 按 kind 存的迁移）；连接测试。 |
| [pool.ts](pool.ts) | ★ 模型池：按**任务档位**取模型，并把该档的清单变成**轮转负载均衡**（并发）与**随机 fallback**（串行失败后换模型重试）。另出 `budgetForTask()`——不构造 provider 的预算查询。只给工程页的后台任务用。 |

> `vscode-lm`（Copilot）的实现在 [../../vscode/vscodeLmProvider.ts](../../vscode/vscodeLmProvider.ts)——它依赖 VS Code Language Model API，属于宿主层，但由本层的 registry 统一分发。

## 关键设计

- **统一接口**：`chatStream(messages, options): AsyncIterable<string>` 逐段 yield 增量文本，取消经 `AbortSignal`，超时经 `timeoutMs`。
- **错误说人话**：HTTP 401/404/429 等都在 provider 内整理成面向作者的中文提示后以 `LlmError` 抛出；用户主动取消抛 `CancelledError`，调用方静默处理。
- **API Key 按服务商 id 分开存**：同一种协议可以并存多个服务商（智谱官方、OpenRouter、本地 Ollama 都是 openai 兼容），各有各的 Key。`vscode-lm` 走 Copilot 授权，不需要 Key。
- **硬配额上报**：`maxInputTokens()` 返回 provider 的硬性输入上限（vscode-lm 有配额），装配器会与 `contextWindow` 取小。

## 模型池的五条规矩

模型分为**三档**（快速 / 均衡 / 精标，见 [../model/tiers.ts](../model/tiers.ts)），每档各是一份有序清单。`createModelPool({ task })` 按任务所属的档取清单，把它变成一个能换人的池，但**只有工程页的后台任务**（摘要、角色卡、设定、文风、角色提取）走它——对话页续写与连接测试必须严格用用户选定的那个模型，中途换人会让文风断掉。

1. **空档位沿用「默认模型」**：某一档没配模型，归在该档的任务就用 `config.models`。三档都不配 = 不分档，行为与分档之前逐字节一致。这条是硬约束——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。
2. **起始模型看场景**：并发任务（`concurrent: true`）按游标轮转，把请求摊到几个服务商上；串行任务恒取该档的 `refs[0]`，与「档内第一个是首选」的直觉一致。
3. **fallback 是换人，不是重试，而且不跨档**：失败后从**同档里没试过的**模型里随机挑一个，最多 `config.fallbackAttempts` 次；同一个模型不会被试两遍，档里只有一个模型时干脆不重试，档内换完了就上抛——**绝不去别的档捞人**。快速档失败自动升级到精标档，等于绕过作者的成本决定去烧贵 token，而且从日志上看不出来。`CancelledError` 立刻上抛——用户点了停止还接着换模型，会让「停止」看起来失灵。
4. **只有该档首选能弹 Key 输入框**：备选模型一律 `buildProvider(active, { promptForKey: false })`，缺 Key / 环境不支持就剔除并 `warn`。一次点击连弹五个 API Key 输入框，比没有 fallback 更让人恼火。
5. **预算跟着干活的模型走**：`pool.primaryBudget` 是该档**首选模型**的窗口与输出上限（模型自带的优先，缺省退回全局默认）。features 切批、截断一律读它，不能读 `config.contextWindow`——后者是**对话页选定模型**的窗口，拿 200k 的写作模型的窗口去给 32k 的快速档模型切批会稳定超窗。取首选而非全池最小值：fallback 是小概率路径，为它把每一批都切小等于让常态下每次调用都少读几章。

确认框之前就要算的东西（设定生成的扫描片段数、角色卡的批数——它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`：它只解析引用、不构造 provider，因此不会在用户点确认之前弹出 API Key 输入框。

## 依赖关系

依赖 `model/`（读配置、解析模型引用）。被 `features/` 使用；`initSecrets` 由 `vscode/extension.ts` 在激活时调用以注入 SecretStorage。
