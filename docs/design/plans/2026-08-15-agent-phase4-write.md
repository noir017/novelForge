# 四期：写工具 + 策略 + 工具流 UI Implementation Plan

> **已合入，本文是当时的记录。** 分层此后调过一次：工具与工具契约从
> `core/agent/{tools/,registry.ts}` 独立成 [`core/tools/`](../../../src/core/tools/README.md)，
> 下面提到的这些路径已经不存在。当下的真相以模块 README 为准。

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md) —— **全部 23 条**。这一期给 agent 开写权限，每一条都在射程内
> 2. 设计依据 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L3 一节**
> 3. 前置：[零](2026-08-15-agent-phase0-provider-events.md)、[一](2026-08-15-agent-phase1-workspace.md)、[二](2026-08-15-agent-phase2-generation.md)、[三期](2026-08-15-agent-phase3-loop.md) 必须已经合入
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。

**Goal:** 给 agent 加上 `write` / `edit` / `run` 三个工具，配上策略与确认闸门，让它能完整跑一条「排剧情 → 拆场景 → 写正文」。

**Architecture:** 这一期**不需要写任何新的保护代码**——一期的 `guard.ts` 八条守卫已经全在写入路径上了。要做的是把它们**接到 agent 的确认流程上**：哪些动作自动、哪些要问、问的时候说什么。

**Tech Stack:** TypeScript（`src/core/agent/`）+ `node:test` + `npm run typecheck`。不新增依赖。

## Global Constraints

- **覆盖已有内容一律走 `reviewReplace`，任何策略模式下都不放开**（第 3、19 条）。这是产品承诺，不是偏好设置。
- **批量动作动手前必须报「预计调用 N 次」**（第 4 条）。并发不改变总次数，这个数在并发下也要对得上账。
- **删除一律进 `.trash/`**（第 6 条）。agent 的 `run` 里**不给删除动作**——见下。
- **失败要留在出错的东西身上**（第 16 条）：agent 写盘失败要 `recordFailure`，成功要 `clearFailures`。
- **不给 `bash`、不给工程根外的路径、不给裸 `fs`**。
- 每个 Task 结束立刻 commit；前缀 `feat(agent)`；中文正文。

---

## 提交节奏（6 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `feat` | `write` 工具（吃 draftId 与 content） |
| 2 | `feat` | `edit` 工具 |
| 3 | `feat` | `run` 工具（工程动作） |
| 4 | `feat` | 策略与确认闸门 |
| 5 | `feat` | 分档池接入与 `supportsTools` 设置页 |
| 6 | `feat` | 工具流 UI 完善与端到端验证 |

---

### Task 1: `write` 工具

**Files:**
- Create: `src/core/agent/tools/write.ts`
- Modify: `src/core/agent/tools/index.ts`
- Create: `tests/integration/agent/writeTool.test.js`

```
参数：{
  path: string,
  draftId?: string,      // 与 content 二选一
  content?: string,
  mode?: 'create' | 'overwrite' | 'append'
}
返回：
  已写入 .novelforge/plots/012-入宗.md（620 字）
  同时记下 upstreamHash（大纲指纹）
```

**实现就是一次 `ws.write`**（一期已经把渲染、记账、伴生、审阅全做完了）：

```ts
const input = args.draftId
  ? { artifact: requireDraft(args.draftId).artifact }
  : { text: args.content };
const r = await ctx.workspace.write(args.path, input, {
  mode: args.mode ?? 'create',
  review: true,              // ★ 永远 true，不接受参数
  what: describeForReview(kindOfPath(project, args.path)),
});
```

**五条硬约束：**

1. **`review` 永远 `true`**，不作为工具参数暴露。模型不该有能力关掉审阅。
2. **`draftId` 找不到时 `error`，不静默降级成写空文件。**
3. **`draftId` 的 draft 没有 `artifact`（讨论类产出）时 `error`**——一段批评意见不该被写成一份细纲。
4. **用户在审阅里拒绝 → `{skipped}`，回给模型的文本要说清「作者没有采纳」**，让它别原地重试。
5. **写失败 `recordFailure` 挂在对应细纲上，成功 `clearFailures`**（第 16 条）。

`mutating: true`。

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| `write` + draftId 到空路径 | 落盘，`upstreamHash` 记上 |
| `write` + draftId 到已有内容 + 假 Host 同意 | 覆盖 |
| `write` + 假 Host 拒绝 | 磁盘一字未改，返回文本说「作者没有采纳」 |
| `write` + 不存在的 draftId | `error`，不写 |
| `write` + 讨论类 draft | `error`，不写 |
| `write` 到受保护路径 | `error`（guard 拦下） |
| `write` 到 `../` | `error` |
| 写失败 | errorLog 里挂上一条 |

- [ ] **Step 2–5: 同上**

---

### Task 2: `edit` 工具

**Files:**
- Create: `src/core/agent/tools/edit.ts`
- Create: `tests/integration/agent/editTool.test.js`

```
参数：{ path: string, old: string, new: string, all?: boolean }
返回：已替换 1 处（.novelforge/plots/012-入宗.md）
```

**为什么需要它**：改一个人名、修一句台词、调一个数字——用 `generate` 重写整份产物是浪费，用 `write` 全文覆盖则要求模型把整份内容重新吐一遍（既慢又容易漏）。

**四条硬约束：**

1. **`old` 不唯一且 `all !== true` 时报错，不改**（与标准 edit 工具一致）。错误文本要说清命中了几处。
2. **`old` 找不到时报错**，并提示「先 `read` 确认当前内容」。
3. **仍然走 `ws.edit` → guard**：越界、保护路径、大小上限照样拦。
4. **编辑产物类文件后照样记账**——`ws.edit` 内部走 handler 的 `after`，一期已经保证了。

**不做多处批量编辑**（`edits: [{old,new}]` 数组）。一次一处，出错时状态清楚。

- [ ] **Step 1: 写失败测试**（唯一/不唯一/找不到/越界/记账）
- [ ] **Step 2–5: 同上**

---

### Task 3: `run` 工具

**Files:**
- Create: `src/core/agent/tools/run.ts`
- Create: `tests/integration/agent/runTool.test.js`

```
参数：{ action: string, path?: string, range?: string }
返回：动作的结果描述
```

**动作白名单**（`ProjectAction` 的子集）：

| action | 底座 | 花钱？ | 备注 |
|---|---|---|---|
| `newPlot` | `actions.newPlotFlow` | 否 | 建一份空细纲骨架 |
| `split` | `features/splitChapter` | 否 | 中转站正文按 `---` 拆成发布章 |
| `summarize` | `features/summarize.summarizeChapter` | 是（1 次） | 单章摘要 |
| `syncSummaries` | 同上 | 是（N 次） | **要报预计次数** |
| `batchPlots` | `pipelineBatch.generatePlots` | 是（N 次） | **要报预计次数** |
| `batchScenes` | `pipelineBatch.breakdownScenes` | 是（N 次） | 同上 |
| `batchManuscripts` | `pipelineBatch.writeManuscripts` | 是（N 次） | 同上 |
| `updateCard` / `createCard` | `features/characterCard` | 是 | 同上 |
| `extractStyle` / `generateLore` | 对应 feature | 是 | 同上 |

**明确不给的**：`delete`（任何形式）、`rename` / `move`、`initProject`、`newChapter`。

- **删除**：作者要删东西会自己删。给 agent 一个删除工具，收益接近零而风险是丢内容——即使进 `.trash/`，作者也未必知道它删过什么。
- **改名/移动**：`move` 在 workspace 层有，但不暴露给 agent。改名会连带搬走场景目录与中转站正文（第 7 条），一次误操作的收拾成本远高于收益。
- **`newChapter`**：正常路径上发布章节是**拆分**出来的（第 23 条），不该由 agent 直接建。

**批量动作的确认**（第 4 条的落点）：

既有的 `pipelineBatch` 已经自带确认框（写明「有 N 章还没排剧情，需要调用 N 次模型」）。agent 调用时**这个框照弹**——不要为 agent 加一条绕过它的路。同时把预计次数记进 `budget.calls`。

**`run` 全部 `mutating: true`**，即使 `summarize` 这种只写摘要的也算。

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| `action: 'split'` | 中转站正文拆成章，原件进 `.trash` |
| `action: 'delete'` | `error`：不在白名单 |
| `action: 'batchPlots'` + 假 Host 拒绝 | 一次模型都不调 |
| `action: 'batchPlots'` + 同意 | 预计次数记进 budget |
| 认不出的 action | `error` 里列出可用动作 |

- [ ] **Step 2–5: 同上**

---

### Task 4: 策略与确认闸门

**Files:**
- Create: `src/core/agent/policy.ts`
- Modify: `src/core/agent/loop.ts`
- Modify: `src/core/config.ts`（加一项 `agentPolicy`）
- Modify: 设置页（前端 + `SettingsPayload`）
- Create: `tests/unit/agent/policy.test.js`

| 模式 | `list`/`read`/`search` | `generate` | `write`/`edit` 新建 | `write`/`edit` 覆盖 | `run` |
|---|---|---|---|---|---|
| 谨慎 | 自动 | 每次确认 | 确认 | **审阅** | 确认 |
| **默认** | 自动 | 预算内自动 | 确认 | **审阅** | 确认 |
| 放手 | 自动 | 预算内自动 | 自动 | **审阅** | 自动（批量动作自带的确认框仍然弹） |

「覆盖 → 审阅」那一列**三种模式完全一样**，且不可配置。

```ts
export type AgentPolicy = 'careful' | 'default' | 'bold';

export interface Gate {
  /** 要不要在执行前问一句。 */
  confirm: boolean;
  /** 问什么。要说清「会发生什么」，不是「确定吗」。 */
  message?: string;
  detail?: string;
}

export function gateFor(policy: AgentPolicy, tool: ToolDef, args: Record<string, unknown>): Gate;
```

**确认框的文案要说清后果**，不是「agent 想调用 write，允许吗」：

```
Agent 要写入「第 12 章的细纲」
.novelforge/plots/012-入宗.md（新建，620 字）
[写入] [跳过这一步] [停止 agent]
```

三个选项，不是两个：「跳过这一步」让 agent 继续跑别的，「停止」结束整轮。

**用户拒绝时回给模型的文本要有信息量**：「作者跳过了这一步（写入 …）。不要重试同一个动作。」——否则它会原地重试。

- [ ] **Step 1: 写失败测试**（三种模式 × 五类工具的矩阵；覆盖那一列三模式一致）
- [ ] **Step 2–5: 同上**

---

### Task 5: 分档池接入与 `supportsTools`

**Files:**
- Modify: `src/core/model/tiers.ts`（加 `agent` 任务）
- Modify: `src/core/model/providers.ts`（`ModelEntry.supportsTools`）
- Modify: `src/core/agent/tools/generate.ts`（非正文层走池）
- Modify: 设置页

#### `tiers.ts`

```ts
export type LlmTask = … | 'agent';
TASK_LABEL.agent = 'Agent 调度';
TASK_HINT.agent = '每一步都要调一次，只做决策不产文本；必须支持工具调用';
DEFAULT_TASK_TIERS.agent = 'balanced';
```

#### `generate` 工具的模型选择（第 12 条的延伸）

| 层 | 用哪个模型 |
|---|---|
| `manuscript` | **对话页选定的那个**，不走池、不 fallback。中途换人会让文风断掉 |
| `plot` | `plotOutline` 档的池 |
| `scene` | `sceneBreakdown` 档的池 |
| `outline` | 对话页选定的那个（一次定调，且没有对应档位） |

#### `supportsTools`

`ModelEntry` 加 `supportsTools?: boolean`，设置页每个模型一个复选框。**agent 的调度模型选择器只列勾了的**；一个都没勾时提示「还没有标记为支持工具调用的模型」。

**不做自动探测**——探测要真发一次带 tools 的请求，那是在用户没点任何东西的时候花钱。

- [ ] **Step 1: 写失败测试**（正文层不走池、非正文层走对应档、选择器过滤）
- [ ] **Step 2–5: 同上**

---

### Task 6: 工具流 UI 完善与端到端验证

**Files:**
- Modify: `media/src/view/messages.ts`
- Modify: `src/shells/shared/panes.ts`
- Modify: `src/core/agent/README.md`
- Modify: `AGENTS.md`（模块地图 + 可能要加一条行为约束）
- Create: `tests/dom/view/agentTools.test.js`

#### 界面要素

```
你：把第 12 章排一下剧情，注意第 9 章埋的伏笔

  🔧 read .novelforge/plots/012.md          38 行     0.1s
  🔧 search「伏笔」kinds=summary             3 处      0.3s
  🔧 read .novelforge/summaries/009-….md    22 行     0.1s
  ✨ generate 剧情 · 4/4 节                  620 字    12.4s
  📝 write .novelforge/plots/012-入宗.md     已写入    0.2s

  已排好第 12 章的剧情，把第 9 章那处「北境旧识」的伏笔接在……
  ─────────────────────────────────
  5 步 · 1 次生成 · 约 1.8 万 token
```

**四条界面约束：**

1. **每一步都看得见**（第 11 条）。折叠是可以的，但默认展开——第一次用的人要能看懂 agent 干了什么。
2. **花销要显示**（第 4 条）：末尾那一行。
3. **停止按钮全程可用**，停在工具边界。
4. **失败的步骤标红并保留**，不要因为后面成功了就把失败那步藏掉。

#### 端到端手动验证（用真模型跑一遍）

| # | 输入 | 预期 |
|---|---|---|
| 1 | 「第 9 章里主角说过他没去过北境吗？」 | `search` + `read`，给出答案，**不写盘** |
| 2 | 「第 12 章的剧情有什么问题？」 | `read` + `generate(critique)`，**不写盘** |
| 3 | 「把第 12 章的剧情排一下」 | `generate` + `write`（弹确认） |
| 4 | 「把第 12 章拆成场景，然后写正文」 | `run(split)` 不对——应该是 `generate(split)` + `write` ×N，再 `generate(manuscript)` + `write(append)` |
| 5 | 「把 12 到 18 章都排一遍」 | 应该走 `run(batchPlots)`（自带确认框写明 7 次调用），而不是循环 7 次 `generate` |
| 6 | 中途点停止 | 停在工具边界，已写的保留，气泡里说清停在哪一步 |
| 7 | 对一份已有内容的细纲 `write` | 弹 diff/确认，拒绝后 agent 不原地重试 |

第 5 条是**提示词调优的验收点**：如果 agent 倾向于循环调 7 次 `generate` 而不是用 `run(batchPlots)`，要在 system 提示里补一句「连续多章的同类工作用 `run` 的批量动作，比逐章 generate 省钱且有进度条」。

- [ ] **Step 1: dom 测试**
- [ ] **Step 2: 实现**
- [ ] **Step 3: `npm test`**
- [ ] **Step 4: 端到端手动验证**（七条全过）
- [ ] **Step 5: 更新文档**

`AGENTS.md` 建议加一条行为约束（第 24 条）：

> **24. Agent 不越过既有的闸门**：agent 的写入走的是与「采纳写入」同一条 `workspace.write`，覆盖已有内容一律先审阅，批量动作照弹既有的确认框（含「预计调用 N 次」）。给 agent 一条绕过闸门的快路，等于把前面 23 条一次性作废。agent 也不决定「下一步该做什么」——那是 `deriveNextStep` 的输出，每回合注入给它，它拿着去执行。

- [ ] **Step 6: Commit**

---

## 本期不做

- **不给删除 / 改名 / 移动工具。**
- **不做多 agent / 子 agent。**
- **不做自动化整本书**：每一层的落盘仍然要人点（除非用户显式选了「放手」模式，而那时覆盖仍然要审阅）。
- **不做 agent 的记忆/长期状态**。每轮 agent 从当前工程状态重新开始——状态在磁盘上，不在 agent 脑子里。

## 给接手 agent 的提示词

> 你在 novel-forge 仓库里执行「四期：写工具 + 策略 + 工具流 UI」。前置是零到三期，确认都已合入（`src/core/agent/` 存在且只读四件套能跑，`npm test` 绿）。
>
> 先读 **`AGENTS.md` 的全部 23 条**——这一期给 agent 开写权限，每一条都在射程内。再读 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L3 一节与 `src/core/workspace/README.md`（八条守卫）。
>
> **这一期不需要写任何新的保护代码**：一期的 `guard.ts` 已经把八条守卫放在所有写入路径上了。你要做的是把它们接到 agent 的确认流程上——哪些自动、哪些要问、问的时候说什么。**如果你发现自己在写一段新的路径检查，说明你绕过了 workspace，停下来重想。**
>
> 按 `docs/design/plans/2026-08-15-agent-phase4-write.md` 的 6 个 Task 逐个做，每个 Task 做完立刻 commit（前缀 `feat(agent)`，中文正文，**不要加 Co-Authored-By 或 Generated with 标记**）。
>
> 六件最容易做错的事：
> 1. **`review` 永远 `true`**，不作为工具参数暴露。模型不该有能力关掉审阅。
> 2. **覆盖已有内容一律审阅，三种策略模式完全一样**，不可配置。这是产品承诺不是偏好设置。
> 3. **批量动作照弹既有的确认框**（含「预计调用 N 次」），不要为 agent 加一条绕过它的路。
> 4. **不给删除/改名/移动工具。** 收益接近零，一次误操作的收拾成本极高。
> 5. **用户拒绝时回给模型的文本要有信息量**（「作者跳过了这一步，不要重试同一个动作」），否则它会原地重试烧钱。
> 6. **正文层的 `generate` 严格用对话页选定的模型**，不走池不 fallback——换人会让文风断掉。
>
> Task 6 的七条端到端手动验证要真的跑一遍。第 5 条（连续多章应该走 `run(batchPlots)` 而不是循环 `generate`）是提示词调优的验收点，跑不过就补 system 提示。
