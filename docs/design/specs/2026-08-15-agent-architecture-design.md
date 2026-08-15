# Agent 架构改造设计

日期：2026-08-15
状态：待评审

## 背景与目标

对话页现在是 **chatbot + workflow** 的形态：作者在输入框里挑一个命令（讨论 / 拓展 / 挑刺 / 生成大纲 / 重写大纲 / 落定剧情 / 拆成场景 / 写正文），后端按 `Stage × Capability` 装配一次上下文、调一次模型、把结果摊在气泡里等他点「采纳写入」。每一次交互都是**一问一答的单步**。

这套东西的单步质量很好——分阶段装配（`context/recipes.ts`）、身份化提示词（`context/prompts.ts`）、三层降级解析（`features/artifact.ts`）、零模型调用的新鲜度链与状态机（`model/pipeline.ts`）都是调出来的。**本次改造一个字都不动它们。**

缺的是**多步**：

- 「把 12 到 18 章排一遍，注意跟第 9 章埋的伏笔对上」——现在要作者自己点七次，还要自己去翻第 9 章。
- 「这一章太平了，你看着办」——现在得由作者先诊断出问题在剧情层还是场景层，再挑对应的命令。
- 「主角前面说过他没去过北境吗？」——现在只能靠作者手动 `@` 引用几章原文，跨章对账根本做不了。

目标：**把 AI 从「执行一条命令」改成「拿着工具达成一个目标」**，同时保住既有的全部产品承诺（AGENTS.md 的 23 条）。

**非目标**：不做一键成书、不做多 agent、不让 agent 决定「下一步该做什么」（那是状态机的活）。

## 核心决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| agent 与既有单步命令的关系 | **并存**。命令仍然直通，不进 agent 循环 | 点「写剧情」是确定性单步，多一次调度调用只是加钱加延迟 |
| 「下一步」由谁算 | **仍是 `deriveNextStep`**，agent 每回合免费读到它 | 第 20 条：界面永远只推荐一个下一步，且由状态机算出来。两处各判各的，界面上就会出现「徽章说待拆场景，agent 让你写正文」 |
| 工具坐标系 | **一律用路径**，不收 `stage` / `chapterNo` / `sceneNo` | 工程里所有东西已经是普通 Markdown；层与目标能从路径反推 |
| 工具数量 | **7 个通用工具**，不做每层一个的特化工具 | 模型见过 `read` / `write` / `edit` / `search` 千万次，没见过 `breakdown_scenes`。领域知识留在 `prompts.ts`，由 `generate` 内部那次调用自己带着 |
| agent 上下文 | **薄**：只有状态、路径、字数、hash、工具结果摘要 | 生成产物（三千字正文）绝不回灌循环，否则每走一步重烧一遍 |
| 生成工具的上下文 | **厚**：照旧走 `buildContext` + `recipeFor` | 这是既有质量的来源，不能绕过 |
| 工具调用降级 | **不做**。模型不支持 tool calling 就当不了 agent | 用户明确要求不考虑兼容；文本协议兜底的解析失败率会毁掉体验 |
| 向后兼容 | **不做**。`chatStream` 直接换成事件流 | 项目处于初期开发阶段（.claude/CLAUDE.md） |
| 裸文件系统访问 | **不给**。没有 `bash`，没有工程根之外的路径 | 既有落盘路径背着一堆不变量，见下 |

### 为什么工具必须收路径而不是章号

`Stage` 与 `CreationTarget` 都能从路径反推：目录决定层（`plots/` → plot，`scenes/X/` → scene，`manuscripts/` → manuscript，章节根 → chapter），文件名数字前缀决定章号，场景号在文件名里。这张映射表本来就散在四处（`files/fileOps.ts` 的 `sectionOf` / `isPlotPath`、`model/plotFile.ts` 的 `parsePlotFileName`、`model/chapterFile.ts` 的 `parseChapterFileName`、`project.ts` 的 `summaryPathForChapter`），收成一张表是这次重构的副产品。

收路径的三个好处：

1. **消掉翻译层**。agent 说 `plots/012-入宗.md`，工具直接用，不必再把章号翻回路径。
2. **`read` / `search` / `edit` 三个通用工具立刻可用**，不需要为每层各写一个。
3. **与「数据是普通 Markdown」的产品定位一致**。作者在文件管理器里看到的路径，就是 agent 用的路径。

### 为什么不给裸 `write_file`

既有落盘路径背着一批不变量，绕过任何一条都会安静地损坏工程：

- 细纲改名要连带搬走场景目录与中转站正文（`carryPlotCompanions`），当普通文件搬会把它们变成孤儿（第 7 条）
- 拆分要**先移号再落盘**（第 23 条），反过来会留下「章节已建但细纲还撞着号」的中间态
- 场景文件名由「场号 + 标题」决定，改标题要清掉旧文件名，否则同一场以两个文件名并存
- 写正文要记 `beatsHash`，写细纲要记 `upstreamHash`（第 18 条），漏了新鲜度链就断
- 删除一律进 `.trash/`（第 6 条）；同名目标一律报错退出（第 3 条）

所以 `write` 不是「往这个路径写字节」，而是「按这个路径**应有的种类**写一份合法产物」——种类判定、渲染、记账、伴生搬迁、覆盖审阅全在工作区层里做一次。

## 架构：四层，自下而上

```
core/llm/         L0  事件流 provider（含 tool calling）
core/workspace/   L1  唯一读写网关：路径 → 种类 → 解析/渲染/记账/授权
core/generation/  L2  装配 + 调模型 + 产物解析（无状态）
core/agent/       L3  循环、工具注册表、预算、策略
```

依赖方向严格自下而上。L1 不认识 L2，L2 不认识 L3。

改造顺序就是这个顺序，**每层独立交付，前三层零新功能**。

---

## L0 · 事件流 provider

### 现状

```ts
chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>
```

只吐字符串，`reasoning` 与 `usage` 走 options 上的回调。`ChatMessage` 只有 `system | user | assistant` + `content`。三个 provider（OpenAI 兼容 / Anthropic / vscode-lm）都没有 tools。

### 目标态

一个原语，四种事件：

```ts
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** 参数累积完整、JSON 解析成功之后才发一次。 */
  | { type: 'toolCall'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'usage'; usage: TokenUsage };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema，直接透传给各家 API。 */
  parameters: Record<string, unknown>;
}

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  readonly label: string;
  maxInputTokens(): Promise<number | undefined>;
  stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
}

export interface StreamOptions extends ChatOptions {
  tools?: ToolSpec[];
  /** 'auto' | 'none' | 'required'。缺省 auto。 */
  toolChoice?: ToolChoice;
}
```

`onReasoning` / `onUsage` 从 options 上**删掉**——它们现在是事件流里的一等公民。

### 既有 13 个调用点怎么办

`collectStream` 改成 `collectText`，签名保持「传一个流，拿一段文本」：

```ts
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: { onDelta?(d: string, full: string): void;
               onReasoning?(d: string, full: string): void;
               onUsage?(u: TokenUsage): void }
): Promise<string>;
```

摘要、角色卡、设定、文风、批量流水线五个模块的调用形状不变，只是把原来传给 `chatStream` 的 `onReasoning` / `onUsage` 挪到 `collectText` 的第二参。**行为逐字节不变**，`npm test` 全绿即算过。

### 三家的分片累积（本层八成的工作量与八成的 bug）

| 服务商 | 工具调用怎么来 | 坑 |
| --- | --- | --- |
| OpenAI 兼容 | `delta.tool_calls[]`，每片带 `index` / 可选 `id` / 可选 `function.name` / `function.arguments` 片段 | **按 `index` 累积，不是按 `id`**——`id` 只在第一片给。多个并行工具调用各占一个 index |
| Anthropic | `content_block_start`（`content_block.type === 'tool_use'`，带 `id` / `name`）+ `content_block_delta`（`delta.type === 'input_json_delta'`，带 `partial_json`）+ `content_block_stop` | 参数是**逐字符拼出来的 JSON 串**，只有 `content_block_stop` 之后才完整。`tool_result` 要作为 `user` 消息里的 content block 回传，不是独立 role |
| vscode-lm | `sendRequest(msgs, { tools })`，响应流里出现 `LanguageModelToolCallPart` | 参数已经是解析好的对象，不用累积。系统提示仍要并进首条 user |

三家共同的收敛点：**`args` 解析失败不抛**，发一个 `toolCall` 但 `args: {}`，由 agent 层报「参数解析失败」给模型看，让它重试。抛异常会让整轮对话炸掉。

### 模型能力标记

`ModelEntry` 加一个可选字段：

```ts
/** 该模型支持工具调用，可以当 agent 的调度模型。 */
supportsTools?: boolean;
```

设置页勾选。没勾的模型在 agent 模型选择器里不出现。**不做自动探测**——探测要真发一次带 tools 的请求，那是在用户没点任何东西的时候花钱。

---

## L1 · workspace：唯一读写网关

### 现状：写盘散在六处

| 位置 | 管什么 | 带哪些保护 |
| --- | --- | --- |
| `model/project.ts`（1501 行） | 所有产物的读写 | 路径推导、frontmatter 渲染、伴生搬迁 |
| `features/creation.ts` 的 `acceptArtifact` | 六条采纳落盘路径 | `confirmOverwrite` / `reviewReplace`、记 `upstreamHash` / `beatsHash` |
| `files/fileOps.ts` | 三区类文件操作 | 区界限、同名不覆盖、`.trash` |
| `files/fileEditing.ts` | 内置编辑器读写 | 工程根包含、扩展名白名单、大小上限、内容 hash 乐观锁 |
| `files/projectFiles.ts` | 文件页的移动/复制/改名 | 工程根包含、`isProtectedPath`、同名不覆盖 |
| `features/splitChapter.ts` | 拆分 | 先移号再落盘、伴生搬迁 |

每处各带一部分保护，谁也不认识谁。**这就是为什么现在不敢给 agent 一个 `write`。**

还有一个既有缺陷：**记账只在「采纳」路径上做**。作者在内置编辑器里改一份细纲，`upstreamHash` 不会更新，指纹链就断了——那一章从此再也不挂 ⟳。

### 目标态

```
core/workspace/
  index.ts       对外 6 个方法：list / read / write / edit / move / remove
  kind.ts        路径 → 种类（纯函数，零 I/O）
  guard.ts       统一入口守卫：越界 / 区界限 / 保护路径 / 大小 / 乐观锁
  handlers/      每种产物一个 handler：解析、渲染、记账、伴生
```

#### 种类表（`kind.ts`）

```ts
export type ArtifactKind =
  | 'outline' | 'style' | 'globalSummary'   // 固定单文件
  | 'plot' | 'scene' | 'manuscript'
  | 'chapter' | 'summary' | 'draft'
  | 'character' | 'lore'
  | 'other';                                 // 工程内其它纯文本

export interface PathKind {
  kind: ArtifactKind;
  /** 该路径对应的创作层，`other` 与非创作产物为 undefined。 */
  stage?: CreationStage;
  /** 该路径对应的创作目标，供 generate 直接使用。 */
  target?: CreationTarget;
  no?: number;       // 章号
  sceneNo?: number;
}

export function kindOfPath(project: NovelProject, relPath: string): PathKind;
```

**纯函数、零 I/O、绝不抛**——认不出一律 `{ kind: 'other' }`。

| 种类 | 判定 | 解析 / 渲染 | 上游指纹 | 伴生 |
| --- | --- | --- | --- | --- |
| `outline` / `style` / `globalSummary` | 固定路径 | 纯文本 | — | — |
| `plot` | `plots/` 下 + 数字前缀 | `plotFile.ts` | 写入记 `hash(outline)` | 改名连带场景目录 + 中转站正文 |
| `scene` | `scenes/<plotStem>/` 下 | `sceneFile.ts` | 写入记 `plotContentHash(plot)` | 改标题时清掉旧文件名 |
| `manuscript` | `manuscripts/` 下 | 正文 + frontmatter | 追加记 `beatsHash` | — |
| `chapter` | 章节根下 + 数字前缀 + 扩展名不在黑名单 | `chapterFile.ts` | — | 改名/移动带草稿 |
| `summary` | `summaries/` 镜像 | `summarize.ts` 的解析 | `sourceHash` | — |
| `character` / `lore` | 各自区 + `.md` | frontmatter | — | — |
| `draft` | `drafts/` 下 | 纯文本 | — | **永不自动进上下文**（第 10 条） |

#### 对外 API

```ts
export interface Workspace {
  list(relDir?: string): Promise<WsEntry[]>;
  read(relPath: string, opts?: { offset?: number; limit?: number }): Promise<WsFile>;
  write(relPath: string, input: WriteInput, opts?: WriteOptions): Promise<WriteResult>;
  edit(relPath: string, edits: TextEdit[]): Promise<WriteResult>;
  move(from: string, to: string): Promise<WriteResult>;
  remove(relPath: string): Promise<WriteResult>;
  search(pattern: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

export type WriteInput =
  | { text: string }                    // 原样写（种类 handler 仍负责渲染与记账）
  | { artifact: Artifact };             // 结构化产物，由 handler 渲染成该种类的文件格式

export interface WriteOptions {
  mode?: 'create' | 'overwrite' | 'append';   // 缺省 create（同名报错）
  /** 覆盖前是否走 reviewReplace。缺省 true，**agent 路径不允许传 false**。 */
  review?: boolean;
  /** 乐观锁基线。给了就比对，磁盘变过报冲突。 */
  baseHash?: string;
}
```

**守卫在 `guard.ts` 里做一次**，六个方法全过：

1. `normalizeRel` —— 绝对路径、`..` 逃逸、空路径一律拒
2. 工程根包含检查
3. `isProtectedPath` —— 固定目录不可改名/删除
4. `.trash/` 内容不可操作
5. 大小上限（读、写各一个）
6. 同名不覆盖（`mode: 'create'` 时）
7. 覆盖走 `reviewReplace`（有则 diff，无则确认框）
8. 删除搬进 `.trash/` 并保留原相对路径

### 收益（不只是给 agent 用）

- **记账下沉**：谁写都记 `upstreamHash` / `beatsHash`，内置编辑器改细纲不再断链
- **`project.ts` 瘦身**：只剩领域查询（`listPlots` / `nextPlotNo` / `getPlot` / `listChapters` …），读写全搬走
- **四条路共用一套保护**：文件页、内置编辑器、批量流水线、agent
- **`kindOfPath` 消掉四处重复的路径判定**

---

## L2 · generation：拆成无状态

### 现状

`CreationSession` 一个类同时管四件事：当前有没有在生成（`currentAbort`）、装配上下文、解析产物、落盘（`acceptArtifact` 的六条分支）。

落盘搬进 L1 之后，剩下的应该是纯函数。

### 目标态

```
core/generation/
  generate.ts    装配 → 调模型 → 解析 → 产出 Draft（无状态，收 signal）
  drafts.ts      Draft store：内存 + 随会话持久化
```

```ts
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原样输出。用户可能在气泡里改过，采纳时以这份为准重新解析。 */
  raw: string;
  artifact?: Artifact;
  words: number;
  createdAt: string;
}

export async function generate(
  project: NovelProject,
  request: BuildRequest,
  handlers: GenerateHandlers,
  signal: AbortSignal
): Promise<Draft | undefined>;
```

并发控制（「已有一个生成任务在进行中」）上移到 controller 与 agent 循环——那是**调度**的责任，不是生成的责任。

Draft store 持久化的理由与现在 `ChatTurn.artifact` 存进会话是同一条：**刷新网页后采纳按钮还在**，不然刚生成的四个场景就只剩一段谁也用不上的 JSON。

### 一个字都不改的

`context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`。

分阶段装配那套东西是对的，agent 化不碰它。这是本次改造最值得强调的一点。

---

## L3 · agent

```
core/agent/
  loop.ts        对话循环
  tools/         7 个工具，全是 L1/L2 的薄包装
  registry.ts    工具注册表 → ToolSpec[]
  policy.ts      哪些工具要确认
  budget.ts      步数 / 调用次数 / token 上限 + 无进展检测
  context.ts     状态注入 + 工具结果压缩
```

### 工具集：7 个

| 工具 | 参数 | 返回 | 底座 |
| --- | --- | --- | --- |
| `list` | `path?` | 条目名、类型、字数/大小 | `Workspace.list` |
| `read` | `path`, `offset?`, `limit?` | 文本 + `truncated` | `Workspace.read` |
| `search` | `pattern`, `path?`, `glob?` | 命中行 + 路径 + 前后文 | `Workspace.search` |
| `generate` | `target`(路径), `capability`, `ask?`, `targetWords?` | `{draftId, kind, summary, words}` | `generation.generate` |
| `write` | `path`, `content?` \| `draftId?`, `mode?` | 写入结果 | `Workspace.write` |
| `edit` | `path`, `old`, `new`, `all?` | 替换处数 | `Workspace.edit` |
| `run` | `action`, `args?` | 动作结果 | 既有 `ProjectAction` 分派 |

前三个 + `edit` 是标准四件套，任何支持工具调用的模型都见过。剩下三个：

**`generate`** —— 「agent 只做上层调度，实际生成通过工具调用 LLM」的落点。内部：`kindOfPath(target)` → `stage` → `recipeFor(stage, capability)` 装配厚上下文 → 调模型 → `parseArtifact` → 存 Draft。`capability` 直接用现有那个 8 值枚举（`discuss` / `expand` / `critique` / `check` / `split` / `generate` / `settle` / `rewrite`），不新增概念。

**产出不回灌 agent 上下文**——只回 `{draftId, kind: 'plot', summary: '剧情 · 4/4 节', words: 620}`，正文照旧流进气泡给作者看。要看内容让它显式 `read` 那份 draft。

**`write`** —— 接 `content` 或 `draftId` 二选一。给 `draftId` 时由 L1 的 handler 渲染成该路径应有的格式、记上游指纹、跑覆盖审阅。等价于用户点「采纳写入」。

**`run`** —— 零模型调用或整包的工程动作，enum 就是现有的 `ProjectAction` 子集：`split` / `summarize` / `batchPlots` / `batchScenes` / `batchManuscripts` / `updateCard` / `createCard` / `extractStyle` / `generateLore` / `newPlot` / `newChapter`。这些背着 agent 不该知道的不变量，必须是一个口子而不是让它拿 `write` 自己拼。

### 没有 `status` 工具

流水线状态**每回合自动注入** agent 的 system 消息，约 150 token，不花一次往返：

```
《青云志》· 已发布 99 章 · 31.2 万字
当前目标：第 100 章（.novelforge/plots/100.md）
本章状态：待写剧情
下一步（状态机）：写剧情
提醒：全书大纲改过，第 12、13 章的细纲已过期（⟳）
```

这同时把第 20 条钉死了：agent 看到的「下一步」与界面主按钮是同一个 `deriveNextStep` 的输出，**不可能分叉**。

### 闸门

| 承诺 | 落法 |
| --- | --- |
| 第 4 条 不偷偷烧 token | `budget.ts` 硬上限：步数 / 模型调用次数 / 累计 token。每次 `generate` / `run(batch*)` 在界面上显示这一步花了多少。批量动作照旧先报「预计调用 N 次」 |
| 第 3 / 19 条 不静默覆盖 | `write` 到已有内容一律走 `reviewReplace`，**任何策略模式下都不放开** |
| 第 11 条 不闷着干活 | 每个工具调用在气泡里画出来（名字、关键参数、耗时、结果摘要）；长回合走 `runTask`，工程页能看进度、能停 |
| 第 12 条 换人只在档内 | `generate` 打到正文层时严格用对话页选定的那个模型，**不走池、不 fallback**——换人会让文风断掉 |
| 第 2 条 不静默截断 | 所有读工具的返回值有硬上限，超了必须在返回值里写明截断了多少；agent 上下文压缩丢弃条目也要留痕 |

### 策略（`policy.ts`）

| 模式 | `list`/`read`/`search` | `generate` | `write`/`edit`/`run` |
| --- | --- | --- | --- |
| 谨慎 | 自动 | 每次确认 | 每次确认 |
| **默认** | 自动 | 预算内自动 | 确认 |
| 放手 | 自动 | 预算内自动 | 新建自动，**覆盖仍确认** |

「覆盖仍确认」在任何模式下都不放开——那是产品承诺，不是偏好设置。

### 无进展检测

连续两次调用**同工具 + 同参数**就停下来报告。模型卡在一个读不到的路径上反复重试是最常见的烧钱方式。

---

## 分期

| 期 | 内容 | 交付物 | 新功能 |
| --- | --- | --- | --- |
| **零** | L0 事件流 provider（三家）+ `collectText` 适配 13 个调用点 | `npm test` 全绿 | 无 |
| **一** | L1 workspace 网关，六处写盘收敛，记账下沉 | `project.ts` 瘦身；内置编辑器改细纲不再断链 | 无（有一处缺陷修复） |
| **二** | L2 拆无状态 + Draft store | 刷新网页后采纳按钮仍在 | 无 |
| **三** | L3 骨架 + 只读四件套（`list`/`read`/`search`/`generate`）+ 状态注入 | agent 能查、能跨章对账、能批评、能出草稿 | ★ 跨章一致性对账 |
| **四** | `write`/`edit`/`run` + policy + budget + 工具流 UI | agent 能完整跑「排剧情 → 拆场景 → 写正文」 | ★ 多步自主执行 |

**零到二期一个新功能都没有，全是重构。** 但它们把「能不能安全地给 agent 一个 write」这个问题彻底解决掉了——三期的 agent 循环因此只有 300 行左右，四期加写权限不需要新的保护代码。

三期那四个只读工具是纯增量、零风险：跨章一致性对账（「他前面说过没去过北境吗」）现在只能靠作者手动 `@`，`search` 一上来就解决了。

## 明确不做

- **不做 `bash` / 任意文件系统访问。** 工作区之外不存在。
- **不做多 agent / 子 agent。** 一本小说的创作没有可并行的独立子任务。
- **不让 agent 决定「下一步」。** 那是 `deriveNextStep` 的活，agent 拿着它去执行。
- **不做自动化整本书。** 每一层的落盘仍然要人点。
- **不做工具调用的文本协议兜底。** 不支持 tool calling 的模型就不出现在 agent 模型选择器里。
- **不动 `recipes.ts` / `prompts.ts` / `layers/` / `artifact.ts`。** 分阶段装配是既有质量的来源。
