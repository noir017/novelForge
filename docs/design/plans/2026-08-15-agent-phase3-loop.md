# 三期：agent 循环 + 只读四件套 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md) —— 尤其第 **2、4、11、12、19、20** 条
> 2. 设计依据 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L3 一节**
> 3. 前置：[零期](2026-08-15-agent-phase0-provider-events.md)、[一期](2026-08-15-agent-phase1-workspace.md)、[二期](2026-08-15-agent-phase2-generation.md) 必须已经合入
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。

**Goal:** 让 agent 跑起来——但**只给只读工具与生成工具**。这一期结束时 agent 能查、能跨章对账、能批评、能出草稿，**但一个字都写不进磁盘**（落盘仍走现有的采纳卡片）。

**Architecture:** 循环本身很短（约 300 行），因为工具体全是前三期成果的薄包装。真正要小心的是三件事：**状态注入**（让 agent 与状态机说同一套话）、**上下文压缩**（agent 自己的历史会涨）、**预算闸门**（第 4 条）。

**Tech Stack:** TypeScript（`src/core/agent/`）+ `node:test`。不新增依赖。

## Global Constraints

- **这一期 agent 不写盘。** `write` / `edit` / `run` 三个工具**不注册**，四期才加。
- **agent 不决定「下一步」**：每回合注入 `deriveNextStep` 的结论，agent 拿着它去执行（第 20 条）。
- **生成产物绝不回灌 agent 上下文**：`generate` 只回 `{draftId, kind, summary, words}`。
- **读工具的返回值有硬上限，超了必须说明截断了多少**（第 2 条）。
- **日志不记 prompt / 正文全文，不出现 API Key**（第 11 条）。工具调用只记工具名与参数的**键名**，不记参数值——值里可能有正文片段。
- **正文层的 `generate` 严格用对话页选定的模型**，不走池不 fallback（第 12 条）。
- 每个 Task 结束立刻 commit；前缀 `feat(agent)` / `test`；中文正文。

---

## 目标态文件结构

```
src/core/agent/
├── loop.ts        对话循环
├── registry.ts    工具注册表 → ToolSpec[]
├── context.ts     ★ 状态注入 + 工具结果压缩
├── budget.ts      ★ 步数 / 调用次数 / token 上限 + 无进展检测
├── tools/
│   ├── index.ts
│   ├── list.ts
│   ├── read.ts
│   ├── search.ts
│   └── generate.ts
└── README.md
```

## 提交节奏（6 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `feat` | 工具注册表与 JSON Schema |
| 2 | `feat` | 只读三件套（list / read / search） |
| 3 | `feat` | `generate` 工具 |
| 4 | `feat` | 状态注入与上下文压缩 |
| 5 | `feat` | 预算闸门与无进展检测 |
| 6 | `feat` | agent 循环 + 协议 + 前端工具流 |

---

### Task 1: 工具注册表与 JSON Schema

**Files:**
- Create: `src/core/agent/registry.ts`
- Create: `src/core/agent/tools/index.ts`
- Create: `tests/unit/agent/registry.test.js`

**Interfaces:**

```ts
export interface ToolContext {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  signal: AbortSignal;
  /** 生成类工具用它记账。 */
  budget: Budget;
  /** 工具想说点什么给用户看（进气泡，不进 agent 上下文）。 */
  report(message: string): void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  /** 会花钱。预算闸门与策略据此分类。 */
  costly?: boolean;
  /** 会写盘。三期一个都没有。 */
  mutating?: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  /** 回给模型看的文本。**必须简短**——它会留在 agent 上下文里。 */
  text: string;
  /** 给界面画的结构化摘要，不进 agent 上下文。 */
  display?: { title: string; detail?: string };
  /** 出错了。模型看得到，据此重试或换路。 */
  error?: string;
}

export function toolSpecs(defs: ToolDef[]): ToolSpec[];
```

**工具描述怎么写**（这是本 Task 真正的活）：

模型只靠 `description` 与 `parameters` 决定怎么用。三条原则：

1. **说清坐标系**：「path 是工程内相对路径，正斜杠。细纲在 `.novelforge/plots/`，场景在 `.novelforge/scenes/<细纲名>/`，中转站正文在 `.novelforge/manuscripts/`，已发布章节在 `chapters/`。」
2. **说清限制**：「一次最多返回 400 行，超出会截断并告诉你截了多少。」
3. **不写领域知识**：不要在工具描述里写「剧情不写画面天气台词」——那在 `prompts.ts` 里，由 `generate` 内部那次调用自己带着。工具描述里写一遍只会浪费 token 且两处会跑偏。

**参数 schema 尽量扁平**：`{path, offset, limit}` 好过 `{target: {kind, chapterNo, sceneNo}}`。嵌套对象是模型最容易填错的地方。

- [ ] **Step 1: 写失败测试**（`toolSpecs` 产出的 schema 合法、名字不重、必填字段标对）
- [ ] **Step 2–5: 同上**

---

### Task 2: 只读三件套

**Files:**
- Create: `src/core/agent/tools/{list,read,search}.ts`
- Create: `tests/integration/agent/readTools.test.js`

三个都是 `Workspace` 的薄包装（一期已经实现），**每个不超过 50 行**。这一期的活是把返回值**压成模型读得动的形状**。

#### `list`

```
参数：{ path?: string }
返回（文本）：
  .novelforge/plots/  （42 项）
  001-楔子.md          620 字
  002-入宗.md          710 字
  …
  （还有 32 项未列出，用 path 参数进子目录看）
```

**上限 60 项**，超了说明还有多少。

#### `read`

```
参数：{ path: string, offset?: number, limit?: number }
返回（文本）：文件内容，带行号
  末尾若截断：（第 401–1203 行未读，共 1203 行。用 offset 继续读）
```

**上限 400 行 / 20000 字符**，取先到的。

#### `search`

```
参数：{ pattern: string, path?: string, kinds?: string[], regex?: boolean }
返回（文本）：
  chapters/009-北境.md:142  「我从没去过北境。」他说。
  chapters/031-旧事.md:88   北境的雪他见过三回。
  （命中 2 处，扫了 99 个文件）
  ⚠ 因超上限丢弃 0 条
```

按章号升序（一期的 `search.ts` 已经这么排了）。**`dropped > 0` 必须写在返回文本里**——第 2 条。

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| `list` 超 60 项 | 返回文本里有「还有 N 项未列出」 |
| `read` 超行数上限 | 有「第 X–Y 行未读」 |
| `read` 越界路径 | `error` 字段有值，**不抛** |
| `read` 不存在的文件 | `error` 字段说清楚，模型能据此换路 |
| `search` 有丢弃 | 返回文本里有 ⚠ |
| `search` 跨章命中 | 按章号升序 |
| 三个工具都不写盘 | 跑完磁盘 mtime 不变 |

- [ ] **Step 2–5: 同上**

---

### Task 3: `generate` 工具

**Files:**
- Create: `src/core/agent/tools/generate.ts`
- Create: `tests/integration/agent/generateTool.test.js`

**这是「agent 只做上层调度，生成走工具」的落点。**

```
参数：{
  target: string,        // 路径。决定层与目标
  capability: string,    // discuss|expand|critique|check|split|generate|settle|rewrite
  ask?: string,          // 补充要求，可空
  targetWords?: number
}
返回（文本）：
  已生成：剧情 · 4/4 节，620 字
  draftId: d-3f2a
  落点：.novelforge/plots/012-入宗.md（已有内容，采纳时会先请作者审阅）
```

**内部流程**（全是二期成果的调用）：

```ts
const { stage, target: t } = kindOfPath(project, args.target);
const action = { stage, capability };
if (!isValidAction(action)) return { error: `${stage} 层不支持 ${capability}` };
const { draft } = await generate(project, { action, target: t, ask, targetWords, history: [] }, handlers, { signal, provider });
ctx.drafts.put(draft);
return { text: `已生成：${draft.summary}…`, display: {…} };
```

**五条必须做对的事：**

1. **产物不回灌**。返回文本里只有形状与 draftId，**没有正文**。三千字正文塞回循环，agent 每走一步重烧一遍。
2. **正文层用对话页选定的模型**，不传 `provider`（走缺省）。非正文层可以走分档池（`plotOutline` / `sceneBreakdown`）——但**这一期先全部走缺省**，四期再接池。
3. **`history` 传空数组**。agent 的对话历史与创作会话的历史是两回事，混进去会让装配器把 agent 的工具调用当成作者的讨论。**唯一的例外是 `settle`**——它要沉淀的就是一段讨论；这一期**不支持 `settle`**，返回 `error` 说明「落定剧情请在对话页手动执行」。
4. **流式内容照旧推给前端**（`onDelta` → `delta` 消息），作者看得见 agent 在写什么。
5. **`costly: true`**，每次调用记进 budget。

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| 对 `plots/012.md` 调 `generate` | draft 落进 store，返回文本里**没有正文** |
| 对 `chapters/012.md` 调 `capability: 'split'` | `error`（manuscript 层不支持 split，`STAGE_CAPABILITIES` 说了算） |
| `capability: 'settle'` | `error`，说明去对话页手动执行 |
| 认不出的路径 | `error`，不抛 |
| 调用一次 | `budget.calls` +1 |
| 正文层 | 用的是 `config.active` 那个模型 |

- [ ] **Step 2–5: 同上**

---

### Task 4: 状态注入与上下文压缩

**Files:**
- Create: `src/core/agent/context.ts`
- Create: `tests/unit/agent/context.test.js`

#### 状态注入

每回合把这段拼进 system 消息（约 150 token）：

```
# 当前工程
《青云志》· 已发布 99 章 · 31.2 万字
当前目标：第 100 章（.novelforge/plots/100.md）
本章状态：待写剧情
下一步（由状态机算出，不要另做判断）：写剧情
提醒：全书大纲改过，第 12、13 章的细纲已过期（⟳）
```

**数据全从既有的只读聚合取**：`buildPlotPipelineView` / `deriveNextStep` / `deriveBookStage`（`views/pipeline.ts` + `model/pipeline.ts`）。**不要重新实现任何判据**——两处各判各的，界面上就会出现「徽章说待拆场景，agent 让你写正文」（第 20 条）。

「⟳ 提醒」**最多列 5 章**，超了写「等 N 章」。

#### 上下文压缩

agent 的消息历史会涨（工具结果累积）。策略：

1. **system 与最后 K 轮永不压缩**（K 默认 6）。
2. 更早的 `tool` 消息**只留第一行 + 一句「（结果已省略，需要可重新调用）」**。
3. 压缩发生时**记一条 warn 日志**说明省了几条（第 2 条：不静默截断）。
4. 超过 token 上限仍然压不下去时**停止循环并报告**，不要静默丢用户的原始要求。

```ts
export function buildAgentMessages(
  system: string,
  turns: AgentTurn[],
  budgetTokens: number
): { messages: AgentMessage[]; droppedCount: number };
```

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| 状态注入含 `deriveNextStep` 的 label | 与 `deriveNextStep` 直接调用的结果一字不差 |
| 老工程（99 章无细纲） | 状态说「已发布 99 章」，不说「待写剧情」 |
| ⟳ 超 5 章 | 写「等 N 章」 |
| 压缩触发 | 最后 6 轮完整，更早的 tool 结果只剩第一行 |
| 压缩触发 | 打了一条 warn |
| 压不下去 | 返回信号让循环停下 |

- [ ] **Step 2–5: 同上**

---

### Task 5: 预算闸门与无进展检测

**Files:**
- Create: `src/core/agent/budget.ts`
- Create: `tests/unit/agent/budget.test.js`

```ts
export interface BudgetLimits {
  /** 最多几个回合（一个回合 = 一次模型调用 + 若干工具）。缺省 20。 */
  steps: number;
  /** 最多几次**花钱的**工具调用（generate）。缺省 10。 */
  calls: number;
  /** 累计输入+输出 token 上限。缺省 200_000。 */
  tokens: number;
}

export interface Budget {
  readonly limits: BudgetLimits;
  steps: number; calls: number; tokens: number;
  /** 触顶了。循环据此停下并报告。 */
  exceeded(): { what: 'steps' | 'calls' | 'tokens'; message: string } | undefined;
  /** 记一次工具调用，同时做无进展检测。 */
  recordTool(name: string, args: Record<string, unknown>): { stalled: boolean };
}
```

**无进展检测**：连续两次**同工具 + 同参数**（`JSON.stringify(args)` 相等）就 `stalled: true`。循环收到之后给模型一条 tool 结果说「你刚才用同样的参数调过这个工具，结果一样。换个思路或者结束。」，再来一次就直接停。

**这是最常见的烧钱方式**：模型卡在一个读不到的路径上反复重试。

**预算触顶时的行为**：**不静默停**。给模型最后一次机会用 `finish` 说明「做到哪了、还差什么」，再结束。

**用户可见**：每次 `generate` 之后在气泡里显示「已用 3/10 次生成，约 4.2 万 token」（第 4 条）。

- [ ] **Step 1: 写失败测试**（三条上限各一、无进展检测两连与三连、触顶后仍允许一次 finish）
- [ ] **Step 2–5: 同上**

---

### Task 6: agent 循环 + 协议 + 前端工具流

**Files:**
- Create: `src/core/agent/loop.ts`
- Create: `src/core/agent/README.md`
- Modify: `src/core/protocol/{in,out}.ts`
- Modify: `src/core/controller/chat.ts`
- Modify: `src/core/model/session.ts`（`ChatTurn` 加工具调用记录）
- Modify: `media/src/view/messages.ts`（画工具调用流）
- Modify: `src/shells/shared/panes.ts`（如果需要新按钮）
- Create: `tests/integration/agent/loop.test.js`
- Create: `tests/dom/view/agentTurn.test.js`

#### 循环

```ts
export async function runAgent(opts: {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  provider: LlmProvider;      // 必须支持工具调用
  ask: string;
  limits: BudgetLimits;
  signal: AbortSignal;
  on: AgentHandlers;
}): Promise<AgentOutcome>;
```

一个回合：

```
1. buildAgentMessages(system + 状态注入, turns, budgetTokens)
2. provider.stream(messages, { tools: toolSpecs(READ_ONLY_TOOLS) })
3. 收流：text → onDelta 推气泡；toolCall → 收集
4. 没有 toolCall → 结束（模型给出了最终回答）
5. 有 toolCall → 逐个执行（budget.recordTool → tool.run），
   结果作为 role:'tool' 消息追加，回到 1
6. budget.exceeded() → 最后一轮 toolChoice:'none' 让它总结，然后停
```

**取消要停在工具边界**：`signal.aborted` 时不再发起下一次模型调用，也不再执行下一个工具；**正在跑的 `generate` 靠它自己的 signal 停**。

**整个回合走 `runTask`**（第 11 条）：工程页顶部有进度条、能看见、能停。

#### 协议

```ts
// out.ts
| { type: 'agentStep'; turnId: string; step: number; message: string }
| { type: 'toolCall'; turnId: string; callId: string; name: string; display?: {title, detail} }
| { type: 'toolResult'; turnId: string; callId: string; ok: boolean; summary: string; elapsedMs: number }
| { type: 'agentDone'; turnId: string; outcome: AgentOutcome }

// in.ts
| { type: 'sendAgent'; text: string; limits?: Partial<BudgetLimits> }
```

#### 会话记录

`ChatTurn` 加：

```ts
/** 仅 assistant 轮：这一轮 agent 调了哪些工具。重开面板要能回放。 */
toolCalls?: { callId: string; name: string; title: string; ok: boolean; summary: string; elapsedMs: number }[];
```

**不存工具的完整返回值**——那可能是几万字。只存展示摘要。

#### 前端

对话页加一个入口（**建议：输入框旁一个「Agent」开关**，而不是新页签——它跟创作是同一件事，只是执行方式不同）。工具调用画成气泡里的一串折叠条：

```
🔧 search「北境」          2 处命中   0.3s
🔧 read chapters/009…     142 行     0.1s
✨ generate 剧情           620 字     12.4s   [采纳写入]
```

**「采纳写入」按钮**仍然是现有那个（吃 draftId），三期不变。

- [ ] **Step 1: 写失败测试** `tests/integration/agent/loop.test.js`

用假 provider（脚本化的事件序列）。至少覆盖：

| 用例 | 断言 |
|---|---|
| 模型直接回答不调工具 | 一个回合结束 |
| 模型调 `read` 再回答 | 两个回合，tool 消息形状正确 |
| 模型连续两次同工具同参数 | 收到 stalled 提示 |
| 三次 | 循环停下 |
| 预算触顶 | 最后一轮 `toolChoice: 'none'`，有总结 |
| 取消 | 停在工具边界，已产出的 draft 保留 |
| 工具抛异常 | 变成 `error` 回给模型，循环继续 |
| 全程 | 日志里没有 prompt 全文、没有参数值 |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: dom 测试**（工具调用流渲染）
- [ ] **Step 5: `npm test` + F5 手动验证**

手动验证脚本（用一个真模型）：
1. 「第 9 章里主角说过他没去过北境吗？」→ 应该看到 `search` + `read`，然后给出答案
2. 「第 12 章的剧情有什么问题？」→ 应该 `read` 细纲后 `generate(capability:'critique')`
3. 「把第 12 章的剧情排一下」→ 应该 `generate(capability:'generate')` 并给出采纳按钮

- [ ] **Step 6: 写 `src/core/agent/README.md`** + 更新 `src/core/README.md`、`AGENTS.md` 的模块地图
- [ ] **Step 7: Commit**

---

## 本期不做

- **不给写工具**（`write` / `edit` / `run`）。四期。
- **不做策略模式**（谨慎/默认/放手）。四期——这一期没有写盘，没有可确认的东西。
- **不做 `supportsTools` 的设置页 UI**。可以先在 `ModelEntry` 上加字段并手改配置文件；UI 四期一起做。
- **不接分档池**。`generate` 全走对话页选定的模型。

## 给接手 agent 的提示词

> 你在 novel-forge 仓库里执行「三期：agent 循环 + 只读四件套」。前置是零、一、二期，确认都已合入（`src/core/workspace/` 与 `src/core/generation/` 都在，`npm test` 绿）。
>
> 先读 `AGENTS.md` 的第 2、4、11、12、19、20 条与 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L3 一节。然后读 `src/core/model/pipeline.ts`（状态机，你要注入它的结论而不是重新判断）、`src/core/workspace/index.ts`、`src/core/generation/generate.ts`。
>
> 这一期 agent **一个字都不写磁盘**——只注册 `list` / `read` / `search` / `generate` 四个工具，落盘仍走现有的采纳卡片。这是有意的：写权限等四期，那时前三期的保护已经全部就位。
>
> 按 `docs/design/plans/2026-08-15-agent-phase3-loop.md` 的 6 个 Task 逐个做，每个 Task 做完立刻 commit（前缀 `feat(agent)`，中文正文，**不要加 Co-Authored-By 或 Generated with 标记**）。
>
> 六件最容易做错的事：
> 1. **不要让 agent 自己判断「下一步」**。每回合注入 `deriveNextStep` 的结论，它拿着去执行。两处各判各的，界面上就会出现「徽章说待拆场景，agent 让你写正文」。
> 2. **生成产物绝不回灌 agent 上下文**。`generate` 只回 draftId 与形状摘要，正文流给前端气泡。三千字正文塞回循环，每走一步重烧一遍。
> 3. **工具描述里不写领域知识**。「剧情不写画面天气台词」在 `context/prompts.ts` 里，由 `generate` 内部那次调用自己带着。工具描述里写一遍会让两处慢慢跑偏。
> 4. **日志不记参数值**——值里可能有正文片段。只记工具名与参数的键名。
> 5. **`generate` 的 `history` 传空数组**。agent 的工具调用不是作者的讨论，混进装配器会把它当成创作要求。
> 6. **无进展检测**：连续两次同工具同参数就提示，三次就停。这是最常见的烧钱方式。
>
> 参数 schema 尽量扁平（`{path, offset, limit}` 好过嵌套对象）——嵌套是模型最容易填错的地方。
