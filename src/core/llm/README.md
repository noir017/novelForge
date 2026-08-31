# core/llm — 模型接入层

把「调用大模型」抽象成统一的 `LlmProvider` 接口，上层（features / context）不关心具体协议。

## 文件

| 文件 | 职责 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 接口、`StreamEvent` / `AgentMessage` / `ToolSpec` / `StreamOptions`、`CancelledError` / `LlmError`，以及 SSE 流的通用解析与取消/超时处理。 |
| [collect.ts](collect.ts) | ★ 把事件流收成一段文本：`collectText` / `collect` / `mergeUsage`。既有调用点只经这里碰事件流。 |
| [http.ts](http.ts) | 三条 HTTP 协议共用的零碎：`hostOf` / `readBody` / `describeHttpBody` / `parseToolArgs`。从前住在 openai 那个 provider 里、由另一个反过来 import 它——三家之后「其中一个当宿主」就说不通了。 |
| [chatCompletionsProvider.ts](chatCompletionsProvider.ts) | ★ 通用 **OpenAI 兼容** `/chat/completions`（`kind: 'openai'`）。生态里说「OpenAI 兼容」指的就是它，DeepSeek / 智谱 / Kimi / 通义 / Ollama / OpenRouter 几乎只认这一条。思考深度**没有标准**，四种写法自动协商——见下面「三条协议，三个梯子」。 |
| [responsesProvider.ts](responsesProvider.ts) | OpenAI 的 **Responses API**（`/responses`，Codex 那一套，`kind: 'openai-responses'`）。思考深度是 `reasoning.effort`；工具调用在 `response.output_item.done` 上一次给全；推理块能原样交回。目前基本只有官方与少数网关有这个接口。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要单独提取、相邻同角色消息要合并、`tool_result` 是 user 消息里的 content block。思考深度有**两代写法**，由 provider 自己问出来（见下）。 |
| [registry.ts](registry.ts) | ★ 按「前缀/模型名」引用构造 provider；API Key 按服务商 id 存 SecretStorage（含 0.1.x 按 kind 存的迁移）；连接测试。 |
| [pool.ts](pool.ts) | ★ 模型池：按**任务档位**取模型，并把该档的清单变成**轮转负载均衡**（并发）与**随机 fallback**（串行失败后换模型重试）。另出 `budgetForTask()`——不构造 provider 的预算查询。只给工程页的后台任务用。 |

> `vscode-lm`（Copilot）的实现在 [../../shells/vscode/vscodeLmProvider.ts](../../shells/vscode/vscodeLmProvider.ts)——它依赖 VS Code Language Model API，属于宿主层，但由本层的 registry 统一分发。

## 关键设计

- **`StreamEvent` 是唯一原语**：`stream(messages, options): AsyncIterable<StreamEvent>`，五种事件 `text` / `reasoning` / `toolCall` / `usage` / `reasoningTrace`。取消经 `AbortSignal`，超时经 `timeoutMs`（**空闲超时**：流式还在吐字时重置，卡住这么久没数据才中止）。**没有第二条路**——从前 reasoning 与 usage 挂在 options 的回调上，那是「调用方想不想听决定 provider 发不发」，方向反了：usage 是校准 tokenCounter 的唯一实测来源，thinking 是「正文还没开始吐」这段时间界面上唯一的反馈，都不该由调用方开关。要文本的调用点一律走 `collectText`，形状仍是「传一个流，拿一段文本」。
- **usage 按字段合并**：同一次请求会回报多次（Anthropic 在 `message_start` 给输入、`message_delta` 给输出），所以 `mergeUsage` 是**后到的覆盖同名字段、缺席的字段保留**。整份覆盖会让先到的输入用量被后一条抹掉，估算/实测比值就废了。
- **错误说人话**：HTTP 401/404/429 等都在 provider 内整理成面向作者的中文提示后以 `LlmError` 抛出；用户主动取消抛 `CancelledError`，调用方静默处理。
- **API Key 按服务商 id 分开存**：同一种协议可以并存多个服务商（官方接口、路由型服务商、自建网关都可以是同一种 kind），各有各的 Key。`vscode-lm` 走 Copilot 授权，不需要 Key。
- **硬配额上报**：`maxInputTokens()` 返回 provider 的硬性输入上限（vscode-lm 有配额），装配器会与 `contextWindow` 取小。
- **思考深度只作用于作者选定的那个模型**：`StreamOptions.thinking` 由对话页的单次生成与 agent 循环带上（作者在会话上选的那一档），**工程页的后台批量任务一律不带**。理由与第 12 条同源——那一档模型是作者按成本挑的，替他把七十六章的摘要都升级成深思考，账单上看不出是谁决定的。

## 三条协议，三个梯子

**`openai` 走通用 `/chat/completions`，`openai-responses` 走 Responses，`anthropic` 走 Messages。**

两条 OpenAI 协议并存，名字这么分是因为**生态里说「OpenAI 兼容」指的就是
`/chat/completions`**：第三方服务商（DeepSeek、智谱、Kimi、通义、本地 Ollama、OpenRouter）
几乎只认它，所以那个名字归它；Responses 是 OpenAI 自家 Codex 那一套，目前基本只有官方与
少数网关有。**它们不是一条路的两种写法**——Responses 独有的三样东西在 `/chat/completions`
上表达不出来：system 走 `instructions`、推理块能原样交回（`store: false` + `include`）、
工具调用在 item 收完时一次给全（不必按 index 拼分片）。所以是两个 provider，而不是一个
provider 里判「现在是哪一条」——那种分支每加一个字段就要判一次。

思考深度是**一个档位、三套字段**（档位表在 [../model/thinking.ts](../model/thinking.ts)）：

| 档 | 通用 chat/completions | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| 不思考 | 不带任何思考字段 | 不带 `reasoning` | 不带 `thinking` / `output_config` |
| 浅 / 中 / 深 | 按风格，见下表 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` |
| 极限 | `max` | `reasoning.effort: xhigh` | `output_config.effort: max` |

### 通用那条路上「想多深」没有标准

另两条协议里它是一个固定字段。`/chat/completions` 上它是**四个**，而作者的设置页里只有一个
接口地址——指望他知道自己那个网关转发给谁、认哪一套是不合理的：

| 风格 | 字段 | 认它的服务商 |
|---|---|---|
| `effort` | `reasoning_effort` | OpenAI / Kimi / Ollama / DeepSeek |
| `thinking` | `thinking: {type:'enabled'}` + `reasoning_effort` | 智谱 GLM / DeepSeek |
| `enable` | `enable_thinking` + `thinking_budget` | 通义 Qwen / vLLM 自建 |
| `reasoning` | `reasoning: {effort}` | OpenRouter |

所以缺省 `auto`：**问出来**——按上表顺序发，被 400 就换下一种，结论按「接口地址 + 模型」记内存。
服务商弹窗里另有一个手动档（`thinkingStyle`），供自动协商猜错时钉死——它靠 400 的错误文本认
字段，而中转网关的报错措辞什么样都有可能。**手动档是唯一进配置的那一项**：风格是「对面那台
服务器认哪个字段名」，属于服务商而不是模型，所以挂在服务商上。

另外六条与它绑在一起：

- **思考开着时不带 `temperature`**。三家都要求它是默认值，带上去就是 400。关着时照常带——
  非推理模型上它仍然是有效的文风旋钮。
- **「不思考」不等于真关掉**。三条路上这一档都是「不带字段」（显式关在各家都是部分模型才认：
  OpenAI 的 `effort:'none'` 在老模型上 400，Anthropic 的 `disabled` 被 Fable 5 / Mythos 5 拒，
  GLM 的 `disabled` 有报告说被忽略，Ollama 的 `false` 因字段类型是 string 直接报错）。于是在
  缺省就开思考的模型（GLM、DeepSeek、Ollama 上的推理模型）上，这一档的准确含义是**跟随服务商
  默认**，界面上的说明就是这么写的。
- **`reasoningTrace` 三条协议都发**。工具结果在协议上是一条新的 user 消息，但它与上一步的思考
  属于同一段推理。Anthropic 不交回思考块（含 `signature`）会**静默把这一轮的思考关掉**（文档
  写明是 graceful degradation，不报错），表现出来就是「开了深思考，但 agent 从第二步起就不
  想了」——很难查。Responses 那边则是白丢一次推理缓存（`store: false`，所以要显式
  `include: ['reasoning.encrypted_content']`）。载荷对本层不透明，`kind` 认不出就丢掉：
  作者可以在一轮对话中间换模型，另一家的凭据交过去只会 400。
  **通用那条按模型记**：同一个 kind 底下各家要求正好相反——老的 `deepseek-reasoner` 把上一轮的
  `reasoning_content` 交回去是**直接 400**，DeepSeek V4 的思考模式**不交回才是 400**（Kimi 的
  文档同样要求交回）。从前的结论是「一律不交」，代价是 V4 上的工具循环从第二步起必然 400，而
  那句报错里含 `reasoning`/`thinking` 两个词，还会被字段协商误当成「不认这种思考写法」，把整个
  网关记成不带思考字段。矛盾的要求只能用一张按模型记的表装（`MODEL_COMPAT`：表里认得的直接按
  对的来，认不出的缺省不交、被上游的 400 教一次就改），判据用 DeepSeek 文档给的那个——**这次
  请求带没带 `tools`**：不带时交回去也会被忽略，带 `tools` 时历史上每一轮都必须交回，包括那些
  没有工具调用的轮。同一张表还装着另外两格：`content` 为 null 的 assistant 消息、以及
  `tool_choice`，V4 的思考模式两样都拒。
- **上游拒了就换一种写法，不把这一轮判死**。`effort` 的梯子上老模型缺顶上那两档；Anthropic
  更是有两代写法（自适应 `thinking: {type:'adaptive'}` + `output_config.effort`，以及 4.5 及
  更早唯一可用的手动预算 `thinking: {type:'enabled', budget_tokens}`，后者在 4.7 以后直接被
  拒）；通用那条则是上面那四种风格。三个 provider 各自按「接口地址 + 模型」把结论记在内存里
  ：降一档、换一种写法、最后退到不带思考字段。**结论分两张表记**（通用那条）：哪个**字段名**能用按 `baseUrl` 记（`STYLE`），能到**多高档**、收不收 `temperature` 按 `baseUrl|model` 记（`PER_MODEL`）。认字段名的是网关：一个 OpenRouter 底下挂着 Claude、GPT、DeepSeek、GLM，但收请求的始终是 openrouter.ai 那一层——按模型记的话，挂 20 个模型就要把同一个答案问 20 遍，每遍最多四次重发。而档位相反是模型的属性：同网关下 gpt-4o 只到 high、Claude 能到 max，混在一起记会把所有模型都限在最低那一档上，而作者选的是「极限思考」。代价：网关真按模型分化字段时（少见），第一个模型的结论会先套到其余模型上——套错了照样被 400，然后就地重新协商，不会卡死。
  **记在内存而不是配置里**——这是上游的事实，不是作者的偏好。
- **协商花多少次**。它是**同一次生成的重发**，不是额外的模型调用——被 400 的那几次上游没跑模型，不出 token，代价是延迟。预设里那几家带了 `thinkingStyle`，**0 次**；自己填地址的网关猜对也是 0 次（梯子第一档 `reasoning_effort` 覆盖 OpenAI / Kimi / Ollama / DeepSeek），要换写法最多 **4 次**；「不思考」那档 0 次（压根不带思考字段）。上限 `MAX_NEGOTIATIONS` **按梯子长度算出来**而不是拍一个数：最长那条路是先把 effort 从 max 降到 low（4 档）、再把四种写法轮一遍退到不带（4 步），写死一个数会在那条路上提前报错——这里真踩过，作者第一次调用会平白吃一次失败。
- **400 要分清「值不认」与「字段不认」**。`Unsupported value: 'reasoning_effort' does not
  support 'max'` 与 `Unrecognized request argument: 'reasoning_effort'` 里都有 `effort` 这个
  子串，但前者该**降档**、后者该**换写法**。只按子串判会把「它压根不认识这个字段」当成「这一
  档太高」，于是一路降到 `low` 都在发同一个它不认识的字段名——四种写法一种都试不到，作者看到
  的是「思考深度这个开关对这家没用」。判不准时**宁可当成字段不认**：换写法最多多试三次就收敛，
  而在一个它不认识的字段上降档是死路。
- **手动预算那条路上，预算必须小于 `max_tokens`**（思考 token 算在输出上限里，且下限是 1024）。
  所以 `thinkingBudget` 按输出上限收紧，收不出 1024 就不带思考字段，而不是发一个必然 400 的请求。

## 工具调用：四家四个坑

工具调用的分片累积是这一层八成的 bug 来源，四家的形状完全不同：

| 服务商 | 怎么来 | 坑 |
|---|---|---|
| 通用 chat/completions | `delta.tool_calls` 的分片，每片带 `index` | **按 `index` 累积，不是按 `id`**——`id` 只在第一片给，`name` 通常也只给一次，后续分片只有 `function.arguments` 的片段。按 id 累积会让后面每一片各开一个空 id 的槽，参数永远拼不起来。工具声明包在 `function` 对象里；只发工具调用、一个字都没说时 `content` 必须是 `null`（空串会被部分实现拒掉） |
| OpenAI Responses | `response.output_item.done` 上的 `item.type === 'function_call'`，带 `call_id` / `name` / 完整的 `arguments` | **不必累积**——这条协议在 item 收完时一次给全，所以分片增量事件（`function_call_arguments.delta`）干脆不听。坑在别处：工具声明是**平的**（`name` / `parameters` 直接挂在这一层，不包 `function` 对象），system 走 `instructions`，工具结果是独立的 `function_call_output` 项 |
| Anthropic | `content_block_start`（`content_block.type === 'tool_use'`，带 `id` / `name`）+ 若干 `content_block_delta`（`input_json_delta` 的 `partial_json`）+ `content_block_stop` | 参数是**逐字符拼出来的 JSON 串**，只有 `content_block_stop` 之后才完整。另外 **`tool_result` 不是独立 role**：它是一条 `user` 消息 content 数组里的 block，连续的 `tool` 消息要合并进**一条** user，各自成条会让 user/assistant 不再交替 |
| vscode-lm | `response.stream` 里的 `LanguageModelToolCallPart` | 参数已经是解析好的对象，不用累积。但**必须走 `response.stream` 而不是 `response.text`**——后者把工具调用整段滤掉了。系统提示仍要并进首条 user |

另外两条对四家一致：

- **`args` 解析失败绝不抛**。发一个 `args: {}` 的 `toolCall`，`raw` 保留原文，由上层报「参数解析失败」给模型看让它重试。抛异常会炸掉整轮对话——模型少写一个右花括号，用户丢的是整段生成。解析出数组或字符串也按同样的方式退成空对象：下游拿 `args.path` 会得到 `undefined`，那比 `[1,2].path` 更容易报出人话。
- **没有工具时一律不带 `tools` / `tool_choice`**。有些兼容实现见到未知字段会直接 400——`/chat/completions` 上的 `stream_options` 就是这么踩到的（那条路上它至今还留着一条协商：400 里提到它就以后不带，代价是拿不到真实用量）。

### 上游会说一套做一套：`StopSignal`

两条协议上还有一件事必须往上报：**收尾原因**（Anthropic 的 `stop_reason`、`/chat/completions` 的 `finish_reason`）。它的唯一用处是判断这一轮的响应自不自洽。

「说了要调工具」与「零个工具调用」不可能同时为真。但抓到过的中转网关（OpenAI 协议转 Anthropic 协议）就这么干：上游模型明明返回了 tool_calls，它把 `stop_reason` 照抄过来，却把 `tool_use` 块整个漏掉。同一份请求连发八次，五次这样。**通用那条协议最需要这一档**——那种网关打的就是 `/chat/completions`。

这一层不做判断，只把事实归一成 `StopSignal`（`end` / `toolUse` / `maxTokens` / `other`）交上去，由 agent 循环对账并决定重发（见 [core/agent](../agent/README.md) 的「『没调工具』不一定等于『说完了』」）。两条硬规矩：

- **`stop` 事件排在所有 `toolCall` 之后**。先到的话，对账时上层手里还是空的。Anthropic 那边它在 `message_delta` 上，天然在所有内容块之后；但**通用那条要自己保证**——工具参数是分片攒到流结束才拼得完的，而 `finish_reason` 往往在那之前就到了，所以收尾原因要先扣着，冲完工具调用再发。
- **上游不发就一个都不交**（`undefined` 意为「它没说」）。补一个默认值等于替它编一句话，而循环会照着那句话决定要不要重发。

Responses 那条协议里**没有** `tool_use` 这一档：工具调用是输出项（`function_call`），不是一个需要另行声明的状态，所以这种自相矛盾在那条路上表达不出来。它那边能报的只有截断（`response.incomplete` 的 `incomplete_details.reason`）。

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
