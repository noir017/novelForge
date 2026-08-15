# core/generation — 装配 + 调模型 + 解析 + 采纳

创作的一次单步：**装配上下文 → 调模型 → 解析成产物 → 由用户点了采纳才落盘**。

从前这四件事挤在 `features/creation.ts` 的 `CreationSession` 一个类里，外加第五件——「当前有没有在生成」。落盘搬进 [`workspace/`](../workspace/README.md) 之后，剩下的应该是纯函数，所以这一层**没有类、没有字段、没有单例**。

| 文件 | 职责 |
|---|---|
| [generate.ts](generate.ts) | ★ **无状态**：装配（`buildContext`）→ 调模型 → 解析 → 产出一份 `Draft`。收 `signal`，不自己管并发。另有 `previewContext`（只装配不调模型，面板的「预览上下文」）与 `parseDraftArtifact`（解析，不写盘）。 |
| [accept.ts](accept.ts) | ★ 采纳：按 target 分派到六条落盘路径（大纲 / 拆章 / 细纲 / 拆场景 / 场景卡 / 正文）。守卫、渲染、记账、伴生搬迁全在 `workspace/` 做一次，这里只做分派与人话消息。 |
| [drafts.ts](drafts.ts) | ★ `DraftStore`：未采纳的产物，内存按会话分桶 + 随会话 JSON 落盘。 |

## 三条硬约束

### 1. 一个字都不写磁盘（生成那一半）

`generate` 只把文本交回界面，`accept` 才写，且只在用户点了采纳之后（AGENTS 第 19 条）。中间那一步是用户看着产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。

唯一的例外是失败记账（`recordFailure` / `clearFailures`），它写的是痕迹库不是内容（第 17 条）。

### 2. `cleanOutput` 只对正文层做

```ts
const raw = stage === 'manuscript' ? cleanOutput(full) : full.trim();
```

那几条正则是为正文写的（剥开场白、剥章节标题、剥结尾字数统计）。跑在 JSON 产物上会切坏结构——产物里的 ``` 由 `features/parse.ts` 的 `stripCodeFence` 在**解析时**处理，不在这里剥。

### 3. 采纳时重新解析，不用 `draft.artifact`

`Draft` 出厂就带 `artifact` 与 `summary`（省掉了从前三次解析里多余的那次：生成时 → 后端画卡片时 → 采纳时）。但**采纳走的是气泡里当下那份文本**：

```
draftId → draft.target → accept(project, target, parseArtifact(action, 气泡里的文本))
```

用户可能在气泡里改过两个字再点采纳。`draft.artifact` 只是生成那一刻的展示快照，`draft.raw` 只是兜底。

**`target` 从 draft 里取，不由前端传**——前端猜不出一段讨论该写到哪一层（第 19 条最后一句）。

## 并发控制不在这里

「已有一个生成任务在进行中」是**调度**的责任：

- 对话页 → `controller/index.ts` 的 `beginGeneration()` / `stopGeneration()`，`busy` 就是 `currentAbort !== undefined`（两个独立状态迟早对不上，而对不上的表现是「停止按钮点了没反应」）
- agent 循环（三期）→ 它自己管自己那一份

`generate` 只收一个 `signal` 往下透传。这正是它能被 agent 并发调用的前提。

## Draft 为什么要落盘

与从前 `ChatTurn.artifact` 存进会话是同一条理由：**刷新网页后采纳按钮还在**，不然刚生成的四个场景就只剩一段谁也用不上的 JSON。

- **存哪里**：内存为主（`Map`，按会话分桶），随会话 JSON 一起落盘（`.novelforge/sessions/<id>.json`）
- **不进 SQLite**：第 17 条，库只放可丢弃的痕迹。draft 是未落盘的内容，但它跟着会话走，会话本来就是 JSON
- **留多少**：一个会话 20 份（`MAX_DRAFTS_PER_SESSION`）。`draft.raw` 与 `ChatTurn.content` 是同一段文字，全留着等于把会话文件写两遍
- **谁装回内存**：`controller/session.ts` 的 `openSession` —— 不装回来的话按钮会在（`ChatTurn.draftId` 还在），点下去却报「已经过期」。换会话时 `dropBySession` 掉上一个，不然开一天面板会攒下几十份没人再看的正文
- **容错**：认不出的草稿在 `model/session.ts` 的 `normalize()` 里丢掉；对不上草稿的 `draftId` 也丢掉——采纳按钮收起来，但 `ChatTurn.artifact` 那份展示快照仍在，气泡上仍看得出「这一轮产出过一份 4 场的场景清单」

## 一个字都不改装配器

`context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`。

分阶段装配与三层降级解析是这个项目既有质量的来源，agent 化不碰它们。本层只是它们的调用方。

## 逐字保留的四件事

从 `CreationSession` 搬过来时一个字都没改：

1. `logAssembly` 的日志格式（token 数、降级/丢弃明细）——**绝不记 prompt 全文**，那是十万字级的东西，一次就能把日志缓冲挤空
2. `cleanOutput` 的调用位置（见上）
3. `recordUsage` / `describeUsage` 的调用位置——实测用量是校准 tokenCounter 的唯一来源
4. 失败时 `recordFailure` 挂在**细纲**上、成功时 `clearFailures`（第 16 条）。取消不算失败——那是用户自己点的

## 依赖关系

依赖 `context/`（装配）、`llm/`（provider）、`workspace/`（落盘）、`features/artifact.ts`（解析）、`model/`、`runtime/`。被 `controller/chat.ts`（对话页）与 `shells/vscode/quickContinue.ts`（命令面板的快速续写）调用。**不认识 `agent/`**——依赖方向严格自下而上。
