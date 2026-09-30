# core/generation — 装配 + 调模型 + 解析 + 落盘

创作的一次单步：**装配上下文 → 调模型 → 解析成产物 → 当场问一句，作者点头才落盘**。

从前这四件事挤在 `features/creation.ts` 的 `CreationSession` 一个类里，外加第五件——「当前有没有在生成」。落盘搬进 [`workspace/`](../workspace/README.md) 之后，剩下的应该是纯函数，所以这一层**没有类、没有字段、没有单例**。

| 文件 | 职责 |
|---|---|
| [generate.ts](generate.ts) | ★ **无状态**：装配（`buildContext`）→ 调模型 → （需要时接生成链）→ 解析 → 产出一份 `Draft`（带 `range`、`notes`、`calls`）。收 `signal`，不自己管并发。另有 `previewContext`（只装配不调模型，面板的「预览上下文」）与 `parseDraftArtifact`（解析，不写盘）。 |
| [structured.ts](structured.ts) | ★ **生成链**（二期，移植自 AI-Novel-Writer）：小说配置（截断整份重来、「全局要求」只重写这一节）、角色图谱（身份清单 → 每批 3 人补详情）、细纲批次（截断或解不出来时多章对半拆、单章紧凑重建，语法修复一次且只许改标点，漏章 fail-closed）。单步与批量共用，只在 `ChainIO` 上不同；每一次降级记进 `notes`。 |
| [continuation.ts](continuation.ts) | ★ **正文的续写链**（三期，移植自上游 `extendDraftIfNeeded`）：被截断或不到目标的八成就续，最多 7 轮；被截断又没写出 300 字的那一轮丢弃、只给一次恢复；正常收尾又只多了几句就不再催；最后查一遍重演（`context/replay.ts`）。另有纯函数：该不该续、续出来的那段怎么接（去重叠、去整段重复、去「未完待续」一类话术）。见下文「写一章正文」。 |
| [accept.ts](accept.ts) | ★ 落盘：按产物分派到六条落盘路径（架构文档 / 角色图谱 / 情节大纲 / 细纲 / 细纲批次 / 正文）。配置附带的文风只在 `style.md` 还是初始化模板时写过去；角色图谱新卡直接建、**同名的走覆盖审阅一张一审**；大纲带区间时只并进那一段，纯续写不审阅；细纲批次逐章落（排过的审阅、空壳按标题改名填上、没有的新建），再给新角色建卡（D19）；正文落**同号的章节**，按写法落（没有就新建、「接着写」追加、其余在已有正文时覆盖并审阅，标题行沿用原文件；没记写法的老草稿按覆盖审阅），然后在细纲上记 `writtenFrom`。`onlyBlank` 给批量路径用：作者写过的一个字都不动、不问。守卫、渲染、记账全在 `workspace/` 做一次，这里只做分派与人话消息。 |
| [drafts.ts](drafts.ts) | ★ `DraftStore`：还没落盘的产物，内存按会话分桶 + 随会话 JSON 落盘。 |

## 三条硬约束

### 1. 一个字都不写磁盘（生成那一半）

`generate` 只把文本交回界面，`accept` 才写，且只在用户在那张落盘卡片上点了「写入」之后（AGENTS 第 19 条）。中间那一步是用户看着产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。

**那一问在产出的当下**（`controller/chat.ts` 的 `askArtifact` → `controller/gate.ts`），不是气泡末尾一颗可以永远不点的按钮：拖着不点的话，「过一遍人」就成了一件可以无限拖延的事，而 agent 早接着往下做了。

唯一的例外是失败记账（`recordFailure` / `clearFailures`），它写的是痕迹库不是内容（第 17 条）。

### 2. `cleanOutput` 只对正文层做

正文由续写链（`continuation.ts`）对每一轮的输出各跑一遍 `cleanOutput`，其余层 `full.trim()`。

那几条正则是为正文写的（剥开场白、剥章节标题、剥结尾字数统计）。跑在 JSON 产物上会切坏结构——产物里的 ``` 由 `features/parse.ts` 的 `stripCodeFence` 在**解析时**处理，不在这里剥。

### 3. 落盘时重新解析，不用 `draft.artifact`

`Draft` 出厂就带 `artifact` 与 `summary`（省掉了从前三次解析里多余的那次：生成时 → 后端画卡片时 → 落盘时）。但**落盘走的是气泡里当下那份文本**：

```
draft.target → accept(project, target, parseArtifact(action, 气泡里的文本))
```

用户可能在气泡里改过两个字再点「写入」（那份改动经 `editTurn` 已经落在 `turn.content` 上，所以那份文本**答完才取**——取早了拿到的是他改之前那版）。`draft.artifact` 只是生成那一刻的展示快照，`draft.raw` 只是兜底。

**`target` 从 draft 里取，不由前端传**——前端猜不出一段讨论该写到哪一层（第 19 条最后一句）。

## 并发控制不在这里

「已有一个生成任务在进行中」是**调度**的责任：

- 对话页 → `controller/index.ts` 的 `beginGeneration()` / `stopGeneration()`，`busy` 就是 `currentAbort !== undefined`（两个独立状态迟早对不上，而对不上的表现是「停止按钮点了没反应」）
- agent 循环 → 它自己管自己那一份

`generate` 只收一个 `signal` 往下透传。这正是它能被 agent 并发调用的前提。

## Draft 为什么要落盘

`generate` 产出的那份东西一个字都没写盘，而它至少要活到作者在落盘卡片上点头那一刻；agent 手里的 `draftId` 还可能被它稍后用 `write draftId=…` 拿去写——翻回一个旧会话接着让它干活时，那几份草稿还得在。

- **存哪里**：内存为主（`Map`，按会话分桶），随会话 JSON 一起落盘（`.novelforge/sessions/<id>.json`）
- **不进 SQLite**：第 17 条，库只放可丢弃的痕迹。draft 是未落盘的内容，但它跟着会话走，会话本来就是 JSON
- **留多少**：一个会话 20 份（`MAX_DRAFTS_PER_SESSION`）。`draft.raw` 与 `ChatTurn.content` 是同一段文字，全留着等于把会话文件写两遍
- **谁装回内存**：`controller/session.ts` 的 `openSession`。换会话时 `dropBySession` 掉上一个，不然开一天面板会攒下几十份没人再看的正文
- **容错**：认不出的草稿在 `model/session.ts` 的 `normalize()` 里丢掉。气泡上那份 `ChatTurn.artifact` 是**回放用的记录**（产出过什么、落到哪儿了 / 未采纳），与草稿在不在无关——它不再驱动任何按钮

## 一件产物可能要调几次

小说配置、角色图谱、细纲批次由 `structured.ts` 的链拼出来。对话页第一次调用是流式的，后面几次照样流进同一个气泡（每步前面一行「——角色详情（林昭、沈青）——」），链结束后气泡换成**规范化结果**——将要落盘的样子（配置是 `config.md` 全文，角色图谱与细纲批次是规范化 JSON），作者改完再点写入时按同一套解码读回来。

链走不下去（清单不合格、漏章、修复改了内容……）抛 `ChainError`：已经收到的输出留在气泡里，报错，不出卡片，失败挂在那一章 / 那一件上。卡片上除了形状，还列出会新建的角色卡、这一轮调了几次模型、每一处降级（第 2 条）。

## 写一章正文

写正文也是一条链（`continuation.ts` 的 `completeManuscript`），与上面三条共用 `ChainIO`。

- **写法**（`model/pipeline.ts` 的 `WriteMode`）由 `generate.ts` 的 `planWriting` 按磁盘定：这一章还没有正文 → `write`；请求明说接着写 → `continue`（只写新增的那一段，装配器带本章已写末尾）；其余 → `rewrite`（整章，上一版正文经 `revision` 层作底稿）。从前已有正文时一律追加，对话里发「写正文」就会把一整章叠到已有的后面。
- **目标字数**：请求给的 → 细纲的 `targetWords` → 配置的每章字数（D6）。都没有时不自动续写。
- **续写**：被截断、或总字数（`continue` 含已有的）不到目标的八成就续；每一轮带最后 1600 字、本章细纲、执行卡、后 5 章边界（装配器的精简配方）。轮与轮之间在气泡里只空一行；丢弃的那一轮经 `ChainIO.reset` 让气泡退回；流式期间约 300ms 报一次进度（`onProgress`，controller 转成 `writeProgress`）。
- **比上游宽松：已写的不丢**。恢复那一轮仍没进展、最后仍被截断、最后仍不到八成、某一轮调用失败，都保留已写的并写进说明，卡片照样可以写入。只有「截断且正文不到 100 字」（思考把输出预算吃光）报错、不出卡片。作者自己点了停止照旧不出卡片。
- **重演**：续写结束之后查一次（`continue` 不查），上一章结尾按磁盘现读。命中不拒收：Draft 带 `replay`，卡片标红、写入要点两下。
- Draft 多带 `writeMode`、`length`（总字数、目标、新写多少、续写几轮、够不够八成）与 `replay`，随会话落盘——刷新之后再写入，「接着写」不会变成「覆盖」。
- **批量写章也走这一条**（四期，`features/pipelineBatch.ts`）：同一个 `planWriting`（已导出）、同一个 `completeManuscript`，只是换一个走分档池的 `ChainIO`——第一次调用失败换同档其余，之后续写那几轮钉住第一次成功的那个模型（一章之内不换人）。批量没有卡片：重演命中或没写够的照样落盘、挂黄 ❗、批量停下。

## 不在这里写装配

`context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts` 是装配与解析的唯一一份。生成链重新装配时也走 `buildContext`（换 `range` / `step` / `draftPlots`），不在这里手拼 prompt；只有语法修复与「全局要求」字段重写两条消息不经装配器——它们不需要上下文，给多了反而会让模型「顺手」补内容。

## 逐字保留的四件事

从 `CreationSession` 搬过来时一个字都没改：

1. `logAssembly` 的日志格式（token 数、降级/丢弃明细）——**绝不记 prompt 全文**，那是十万字级的东西，一次就能把日志缓冲挤空
2. `cleanOutput` 的调用位置（见上）
3. `recordUsage` / `describeUsage` 的调用位置——实测用量是校准 tokenCounter 的唯一来源
4. 失败时 `recordFailure` 挂在**细纲**上、成功时 `clearFailures`（第 16 条）。取消不算失败——那是用户自己点的

## 依赖关系

依赖 `context/`（装配）、`llm/`（provider）、`workspace/`（落盘）、`features/artifact.ts`（解析）、`model/`、`runtime/`。被 `controller/chat.ts`（对话页）、`tools/novel/generate.ts`（agent）与 `shells/vscode/quickContinue.ts`（命令面板的快速续写，落在下一可写章）调用。**不认识 `agent/`**——依赖方向严格自下而上。
