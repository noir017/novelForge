# 二期：generation 无状态化 + Draft store Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md) —— 尤其第 **19、20、22** 条
> 2. 设计依据 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L2 一节**
> 3. [src/core/features/README.md](../../../src/core/features/README.md) 的「创作的四层与两条路」
> 4. 前置：[零期](2026-08-15-agent-phase0-provider-events.md)、[一期](2026-08-15-agent-phase1-workspace.md) 必须已经合入
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。

**Goal:** 把 `CreationSession` 这个「同时管四件事」的类拆成**无状态的生成函数** + **Draft store**。并发控制上移到调用方——那是调度的责任，不是生成的责任。

**Architecture:** `CreationSession` 现在管着：① 有没有在生成（`currentAbort`）② 装配上下文 ③ 解析产物 ④ 落盘（六条分支）。一期已经把 ④ 搬进 workspace 了。这一期把 ① 上移、②③ 变成纯函数，产出一个可持久化的 `Draft`。

**Tech Stack:** TypeScript（`src/core/generation/`）+ `node:test` + `npm run typecheck`。不新增依赖。

## Global Constraints

- **行为不变**。`npm test` 全绿是验收标准。
- **一处有意的行为变化**：刷新网页后，未采纳的产物仍然可以采纳（现在只有 `ChatTurn.artifact` 那份摘要活着，原文靠气泡里的文本重新解析——draft 落盘之后这条路更稳）。
- **不动** `context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`。这是设计文档里最强调的一条：分阶段装配是既有质量的来源。
- 「已有一个生成任务在进行中」这句 toast 与它的行为**必须保留**，只是搬个地方。
- 每个 Task 结束立刻 commit；前缀 `refactor` / `feat`；中文正文。

---

## 目标态文件结构

```
src/core/generation/
├── generate.ts     ★ 无状态：装配 → 调模型 → 解析 → Draft
├── drafts.ts       ★ Draft store：内存 + 随会话持久化
└── README.md

src/core/features/
└── creation.ts     ★ 瘦身：只剩 testConnection 与 cleanOutput/suggestTitle 等工具函数
                       （CreationSession 类整个消失）
```

`CreationSession` 的四个职责去向：

| 职责 | 现在 | 去向 |
|---|---|---|
| `currentAbort` 并发控制 | `CreationSession` 私有字段 | `ChatController`（对话页）与 `agent/loop.ts`（三期） |
| 装配 + 调模型 | `generate()` | `generation/generate.ts`（无状态函数，收 signal） |
| 解析 | `parse()` | 并进 `generate()`——产出的 `Draft` 自带 `artifact` |
| 落盘 | `acceptArtifact()` 六条分支 | **一期已搬进 workspace** |
| `preview()` | `CreationSession` | `generation/generate.ts` 导出 `previewContext()` |
| `testConnection()` | `CreationSession` | 留在 `features/creation.ts`（它跟创作没关系，是设置页的活） |

## 提交节奏（4 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `refactor` | 抽出 `generation/generate.ts`（无状态） |
| 2 | `feat` | `generation/drafts.ts` Draft store |
| 3 | `refactor` | controller 接管并发控制，`CreationSession` 消失 |
| 4 | `refactor` | 采纳路径改吃 draftId |

---

### Task 1: 抽出 `generation/generate.ts`

**Files:**
- Create: `src/core/generation/generate.ts`
- Modify: `src/core/features/creation.ts`（`CreationSession.generate` / `preview` / `parse` 的实现搬走，类暂时保留并转发）
- Create: `tests/integration/generation/generate.test.js`

**Interfaces:**

```ts
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原样输出（正文层已过 cleanOutput）。 */
  raw: string;
  /** 解析出的结构化产物。text 类能力（discuss/critique/…）没有。 */
  artifact?: Artifact;
  /** 一句话形状描述，如「剧情 · 4/4 节」。 */
  summary?: string;
  words: number;
  /** 推理模型的思考过程。不是正文，采纳时不取。 */
  reasoning?: string;
  createdAt: string;
}

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
}

export interface GenerateOptions {
  signal: AbortSignal;
  /**
   * 用哪个模型。缺省用对话页选定的那个（config.active）。
   *
   * **正文层永远不许传别的**（AGENTS.md 第 12 条：中途换人会让文风断掉）。
   * 这个参数留给三期的 agent 让非正文层走分档池。
   */
  provider?: LlmProvider;
}

/** 装配 + 调模型 + 解析。**一个字都不写磁盘。** */
export async function generate(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  handlers: GenerateHandlers,
  options: GenerateOptions
): Promise<{ draft?: Draft; built?: BuiltContext }>;

/** 只装配不调模型——面板的「预览上下文」。 */
export async function previewContext(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<BuiltContext>;
```

**逐字保留的四件事**（它们现在在 `features/creation.ts` 里，搬过去时不要改）：

1. `logAssembly` 的日志格式（token 数、降级/丢弃明细）——**绝不记 prompt 全文**
2. `cleanOutput` 只对正文层做（JSON 产物在这里剥会切坏结构）
3. `recordUsage` / `describeUsage` 的调用位置（实测用量校准 tokenCounter）
4. 失败时 `recordFailure` 挂在细纲上、成功时 `clearFailures`（第 16 条）

**一处结构变化**：`parse()` 从独立方法并进 `generate()`。现在的流程是「生成 → 前端拿到文本 → 后端再 parse 一次画卡片 → 采纳时第三次 parse」，其中第二次是多余的。`Draft` 生成时就带上 `artifact` 与 `summary`。

**采纳时仍然重新解析**——用户可能在气泡里改过文本（这条注释在 `chat.ts:192` 里，保留）。

- [ ] **Step 1: 写失败测试** `tests/integration/generation/generate.test.js`

用假 provider（`tests/helpers/` 里有）。至少覆盖：

| 用例 | 断言 |
|---|---|
| 剧情层 generate | `draft.artifact.kind === 'plot'`，`summary` 形如 `剧情 · N/4 节` |
| 正文层 generate | `raw` 过了 `cleanOutput`（开场白与章节标题被剥掉） |
| 讨论类能力 | `draft.artifact` 是 undefined（没有可采纳的东西） |
| 模型抛错 | `onError` 被调用，`errorLog` 里挂上一条 |
| 成功 | `clearFailures` 被调用 |
| 取消 | `onCancelled` 被调用，不记失败 |
| 装配明细 | `built.items` 里有降级/丢弃项时进 warn 日志 |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**，`CreationSession.generate` 改成转发
- [ ] **Step 4: 跑测试 + `npm test`**
- [ ] **Step 5: Commit**

---

### Task 2: `generation/drafts.ts`

**Files:**
- Create: `src/core/generation/drafts.ts`
- Modify: `src/core/model/session.ts`（`ChatTurn.artifact` 换成 `draftId` + 展示字段）
- Create: `tests/unit/generation/drafts.test.js`

**Interfaces:**

```ts
export interface DraftStore {
  put(draft: Draft): void;
  get(id: string): Draft | undefined;
  /** 会话切换/关闭时清掉该会话的草稿。 */
  dropBySession(sessionId: string): void;
}
```

**存哪里**：内存为主（`Map`），**随会话 JSON 一起落盘**（`.novelforge/sessions/<id>.json`）。理由与现在 `ChatTurn.artifact` 存进会话是同一条：刷新网页后采纳按钮还在，不然刚生成的四个场景就只剩一段谁也用不上的 JSON。

**不进 SQLite**（第 17 条：库只放可丢弃的痕迹，内容的唯一真相是 Markdown。draft 是未落盘的内容，但它跟着会话走，会话本来就是 JSON）。

`ChatTurn` 的变化：

```ts
// 现在
artifact?: { where: string; summary: string; overwrites: boolean };
// 改成
draftId?: string;
/** 展示用，与 draft 一起持久化，重开面板不必重新解析。 */
artifact?: { where: string; summary: string; overwrites: boolean };
```

两个字段都留：`draftId` 是身份，`artifact` 是**展示快照**。这样即使 draft 被清掉（会话很老了），气泡上仍然看得出「这一轮产出过一份 4 场的场景清单」，只是采纳按钮收起来。

**容错**：`normalize()` 读到认不出的 `draftId` 一律丢弃（会话文件可能被手改）。

- [ ] **Step 1: 写失败测试**（`put` / `get` / `dropBySession` / 会话往返序列化 / 坏 draftId 不抛）
- [ ] **Step 2–4: 同上**
- [ ] **Step 5: Commit**

---

### Task 3: controller 接管并发控制，`CreationSession` 消失

**Files:**
- Modify: `src/core/controller/index.ts`（`session: CreationSession` 换成 `drafts: DraftStore` + `currentAbort`）
- Modify: `src/core/controller/chat.ts`（`c.session.generate(...)` 改成 `generate(c.project, ..., {signal})`）
- Delete: `src/core/features/creation.ts` 里的 `CreationSession` 类
- Modify: `src/core/features/creation.ts`（只留 `testConnection` / `cleanOutput` / `suggestTitle`）

**并发控制搬到 controller**：

```ts
// ChatController
private currentAbort?: AbortController;
get isGenerating(): boolean { return this.currentAbort !== undefined; }
stopGeneration(): void { this.currentAbort?.abort(new CancelledError()); }
```

`c.busy` 与 `currentAbort` 现在是两个独立状态（前者给前端画忙碌标记，后者控真正的取消），**合成一个**：`busy` 就是 `currentAbort !== undefined`。

**「已有一个生成任务在进行中」这句 toast 保留**，判据从 `session.isGenerating` 改成 `this.isGenerating`。

- [ ] **Step 1: 改 controller**
- [ ] **Step 2: 删 `CreationSession`**
- [ ] **Step 3: `npm test` + `npm run typecheck`**
- [ ] **Step 4: 更新 `src/core/features/README.md` 与 `src/core/README.md`**（`creation.ts` 那一行改成新的职责；加 `generation/` 一行）
- [ ] **Step 5: Commit**

---

### Task 4: 采纳路径改吃 draftId

**Files:**
- Modify: `src/core/protocol/in.ts`（`acceptArtifact` 消息加 `draftId`）
- Modify: `src/core/controller/chat.ts`（`acceptArtifact`）
- Modify: `media/src/view/messages.ts`（采纳按钮带上 draftId）
- Modify: `tests/dom/view/*`（如有断言采纳按钮的）

```ts
// 现在
| { type: 'acceptArtifact'; turnId: string; target: CreationTarget; text: string }
// 改成
| { type: 'acceptArtifact'; turnId: string; draftId: string; text: string }
```

`target` 从 draft 里取，不再由前端传——**前端猜不出一段讨论该写到哪一层**（第 19 条最后一句）。

采纳流程：

```
draftId → draft.target → pathOfTarget(target) → ws.write(path, {artifact: parseArtifact(action, text)})
```

**`text` 参数保留**：用户可能在气泡里改过，采纳时以气泡里当下那份为准重新解析。`draft.raw` 只是兜底。

- [ ] **Step 1–5: 同上**。验收是既有的采纳集成测试与 dom 测试全绿。

---

## 本期不做

- **不接 agent**。
- **不改装配器与提示词**。
- **不改 draft 的界面呈现**（采纳卡片长什么样不变）。

## 给接手 agent 的提示词

> 你在 novel-forge 仓库里执行「二期：generation 无状态化 + Draft store」。前置是零期与一期，确认都已合入（`src/core/workspace/` 存在且 `npm test` 绿）。
>
> 先读 `AGENTS.md` 的第 19、20、22 条、`src/core/features/README.md` 的「创作的四层与两条路」、以及 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L2 一节。然后读 `src/core/features/creation.ts` 与 `src/core/controller/chat.ts`。
>
> 这一期是纯重构，`npm test` 全绿是验收标准。**绝对不要改** `context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`——分阶段装配是这个项目既有质量的来源，agent 化不碰它。
>
> 按 `docs/design/plans/2026-08-15-agent-phase2-generation.md` 的 4 个 Task 逐个做，每个 Task 做完立刻 commit（中文正文，**不要加 Co-Authored-By 或 Generated with 标记**）。
>
> 三件最容易做错的事：
> 1. **`cleanOutput` 只对正文层做**。在 JSON 产物上跑那几条正则会切坏结构。
> 2. **采纳时要重新解析气泡里当下的文本**，不能直接用 `draft.artifact`——用户可能改过。
> 3. **`target` 从 draft 里取，不由前端传**。前端猜不出一段讨论该写到哪一层。
