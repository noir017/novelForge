# core/llm — 模型接入层

把「调用大模型」抽象成统一的 `LlmProvider` 接口，上层（features / context）不关心具体协议。

## 文件

| 文件 | 职责 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 接口、`ChatMessage` / `ChatOptions`、`CancelledError` / `LlmError`、`collectStream`，以及 SSE 流的通用解析与取消/超时处理。 |
| [openaiProvider.ts](openaiProvider.ts) | OpenAI 兼容协议（OpenAI / DeepSeek / 智谱 / Kimi / 通义 / OpenRouter / 本地 Ollama 都走这里）。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要单独提取、相邻同角色消息要合并。 |
| [registry.ts](registry.ts) | ★ 按「前缀/模型名」引用构造 provider；API Key 按服务商 id 存 SecretStorage（含 0.1.x 按 kind 存的迁移）；连接测试。 |

> `vscode-lm`（Copilot）的实现在 [../../vscode/vscodeLmProvider.ts](../../vscode/vscodeLmProvider.ts)——它依赖 VS Code Language Model API，属于宿主层，但由本层的 registry 统一分发。

## 关键设计

- **统一接口**：`chatStream(messages, options): AsyncIterable<string>` 逐段 yield 增量文本，取消经 `AbortSignal`，超时经 `timeoutMs`。
- **错误说人话**：HTTP 401/404/429 等都在 provider 内整理成面向作者的中文提示后以 `LlmError` 抛出；用户主动取消抛 `CancelledError`，调用方静默处理。
- **API Key 按服务商 id 分开存**：同一种协议可以并存多个服务商（智谱官方、OpenRouter、本地 Ollama 都是 openai 兼容），各有各的 Key。`vscode-lm` 走 Copilot 授权，不需要 Key。
- **硬配额上报**：`maxInputTokens()` 返回 provider 的硬性输入上限（vscode-lm 有配额），装配器会与 `contextWindow` 取小。

## 依赖关系

依赖 `model/`（读配置、解析模型引用）。被 `features/` 使用；`initSecrets` 由 `vscode/extension.ts` 在激活时调用以注入 SecretStorage。
