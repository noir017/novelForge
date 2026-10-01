# 七期：叙事线 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期直接关系到第 1、2、3、4、11、12、16、17、19、20 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1 #22、§2.3（正文那一行）、§5 七期。
> 3. [四期计划](2026-09-30-blueprint-pipeline-phase4.md) 的 §1（连续性事实）、§3（定稿）、§4（`evidence` 层）：叙事线的事件挂在定稿上，写法照着 `evidence` 层。
> 4. 上游源码：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator），叙事线在 `src/shared/narrative-thread.ts`、`src/services/narrative-thread-candidate-generator.ts`、`electron/repositories/narrative-thread-repository.ts`、`generate-draft.command.ts:1452-1498`。移植处在注释里注明出处。
>
> 六期计划里标 ⚑ 的 4 处，作者 2026-10-01 已全部认可。本计划新标 ⚑ 的照旧是自定、收尾时报给作者确认的。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 跨章的伏笔与线索有一个地方记：`.novelforge/threads.md`，每条线写着类型、计划在第几章埋下、第几章前回收、作者意图，以及正文里推进到哪一步（事件，每条带一句逐字原文）。工程页一个动作从细纲排出 3–8 条线（1 次调用）；定稿时多一步，判这一章推进了哪几条（0–1 次调用，证据逐字校验）；写正文时挑最多 6 条和本章有关的线带进上下文（≤1200 字），并写明「没到回收章不许提前揭开」。

**Architecture:** 纯函数先行（文件格式的解析与外科式追加、状态推导、挑线、事件校验），再是两个调模型的动作（排线、定稿第三步），然后是装配的 `threads` 层，最后是工程页那一行、验收与文档。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。
- **容错**（第 1 条）：`threads.md` 是作者的 Markdown，怎么手改都不许崩。认不出的行原样留着、不当成线也不当成事件。
- **机器只追加、不改写**（第 3 条）：排线只在文件末尾追加新线，定稿只在某条线的事件列表末尾追加事件行。作者写的字（包括自加的行、改过的意图、删掉的事件）一个都不动，不整份重渲染。
- **不静默截断**（第 2 条）：挑线时因为 6 条 / 1200 字放不下的线、定稿时证据找不到而丢掉的事件，一律进明细或日志与完成提示。
- **动手之前写明调用次数**（第 4 条）：排线「预计 1 次」；定稿「预计 1–3 次」；批量写章的上限跟着变。
- **SQLite 只放可丢弃的痕迹**（第 17 条）：叙事线是内容，只落 Markdown。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。**不调真实模型**。

---

## 本期定下的东西

标 ⚑ 的是本期自定的取舍，收尾时报给作者。

### 1. 文件格式（`model/threadsFile.ts`）

```markdown
# 叙事线

> 跨章的伏笔与线索。……（模板里的说明，解析时忽略）

## 玉佩的来历
- 类型：伏笔
- 计划：第 2–8 章
- 意图：林昭身上的玉佩是沈家旧物，第 8 章前揭开他的身世。
- 事件：
  - 第 3 章 · 埋下：「他摸了摸怀里那块温润的玉佩」——玉佩第一次露面
  - 第 5 章 · 推进：「沈青盯着那道云纹看了很久」——沈青认出了纹样
```

- 一个 `## ` 标题是一条线，标题就是线的名字（同名按审稿引文那套归一化判，`model/review.ts` 的 `normalizeQuote`）。
- 「计划：第 a–b 章」= 从第 a 章埋下、到第 b 章前回收（上游 `targetStartChapter` / `targetEndChapter`，UI 上叫「计划埋设」「预计回收」）。容错：`第2-8章`、`2~8`、`第 5 章`（a = b）都认；缺了就是没有区间。
- 事件行：`第 N 章 · 类型：「证据」——理由`。类型四种：**埋下 / 推进 / 回收 / 放弃**（上游 `planted / progressing / resolved / abandoned`）。容错：分隔符写成 `-`、空格、半角冒号，引号换成别的，证据或理由缺了，都认；没有章号的行不算事件（原样留着）。事件行写在 `- 事件：` 下面缩进，或直接写成顶格的 `- 第 N 章 …` 都认。
- **状态不落盘**（与流水线状态同一个口径）：取章号最大的那条事件的类型，同章取写在后面的那条；没有事件就是「计划中」。状态五种：计划中 / 已埋下 / 推进中 / 已回收 / 已放弃。已回收、已放弃是「收了的」，不再带进上下文、不再判事件。作者想放弃一条线：加一行 `第 N 章 · 放弃：——不写了`，或者整条删掉。
- 外科式写入两个纯函数：`appendThreads(raw, threads)`（文件末尾追加，文件空或不存在时先写模板头）与 `appendEvents(raw, title, events)`（找到那条线，插在它最后一条事件后面；没有 `- 事件：` 就补一行）。原文件的换行符（CRLF）、BOM、其余行原样保留。

### 2. 排叙事线（`features/threads.ts` 的 `generateThreads`，新）

- ⚑ **是工程页动作，不进主按钮、不走写入卡**。叙事线是可选的（第 20 条只推一个下一步，不能拿它挡路）；它只往文件末尾**追加新线**、同名的跳过、已有的不改——这是第 19 条的批量路径（只补空白、不问、不覆盖），确认框写明「预计 1 次调用」。入口：工程页「文风与摘要」组的「叙事线」一行（行内按钮 + 右键）、agent 的 `run generateThreads`（同一个确认框）。
- ⚑ 走「剧情细纲」档（`plotOutline`）：排线和拆细纲是同一种活——在大纲与各章计划之间排跨章的东西。不新增档位（设置页那张表不动）。
- 输入（修上游 #10：上游只给**一章**蓝图、不给已有的线）：小说配置的规模与一句话、故事前提（「悬念骨架」就在这里）、情节大纲、**全部已排细纲**（一行一章：章号、标题、本章目的、章末钩子，关键事件截短）、已有的线（名字 + 区间，叫它别重复）。超出输入预算时从细纲一览的最后截，截了写日志。
- 提示词移植上游 `narrative-thread-plan-candidate` 的系统提示（「只从章节蓝图提出可供作者确认的伏笔与叙事线索计划，不得声称正文事件已经发生……优先提出 3–8 条真正有用的候选；不足 3 条时不要凑数」），输出 `{"threads":[{"title","type","from","to","intent"}]}`。
- 校验（修上游 #8：上游先截到 8 条再校验，前面几条坏了后面好的也丢）：先逐条校验再取前 8 条。名字 1–30 字、类型 1–12 字、意图 1–200 字；`1 ≤ from ≤ to`，配置里有总章数时 `to ≤ 总章数`；名字与已有的线、与同一批里前面的重名就跳过。一条都不合格 → 失败，挂红 ❗ 在「叙事线」那一行上（第 16 条）。
- 剥代码围栏、宽松取 JSON（`features/parse.ts`），不做修复重试：1 次就是 1 次，坏了作者再点一次。
- 完成提示「排出 5 条叙事线（同名跳过 1 条），已追加到 threads.md」，并打开文件。

### 3. 定稿第三步：本章推进了哪几条线（`features/threads.ts` 的 `recordThreadEvents`）

```
定稿第 N 章
  1. 摘要（1 次）
  2. 角色状态（0–1 次）
  3. 叙事线（0–1 次）：还没收的线 → 判本章推进了哪几条 → 证据逐字校验 → 追加事件
```

- ⚑ **定稿时自动做、直接写**（上游要作者在编辑器里一条线一条线手动点「AI 识别定稿事件」再逐条确认）。理由与 D15 角色状态同一个：批量「写完即定稿」时没人看，而事件只是**追加**一行带原文的记录，不吞任何东西；证据逐字校验就是那道闸。这一条写进第 19 条的例外清单。
- 一次调用判所有还没收的线（上游一次只判一条）。送哪几条：状态不是已回收 / 已放弃的线，按 §4 的顺序排，最多 12 条（多出的写日志）。一条都没有（没有 `threads.md`、或者都收了）→ 不调，这一步 0 次。
- 提示词移植上游 `narrative-thread-event-candidate`（「你是小说定稿事实审查员……证据必须是正文中逐字出现、最多 240 字的短摘录……最多 5 项」），改成多条线、中文类型：输出 `{"events":[{"thread","type","evidence","reason"}]}`。
- 校验（修上游 #11：上游只去空白，一个「。」也算逐字出现）：`thread` 认得出（同名归一）；`type` 是四种之一；证据按审稿那套归一化（NFKC、去空白与标点）后在本章正文里找得到，且归一后至少 4 个字（`MIN_QUOTE_CHARS`）；证据 ≤240 字、理由 ≤100 字（超了截）；最多 5 条。同一条线、同一章、证据归一后相同的事件已经有了就不重复记（重新定稿同一章时）。
- 找不到证据、认不出线的事件**丢弃**（与连续性事实同一个理由：没有原文撑着的多半是编的），丢了几条写进日志和定稿的完成提示。
- 失败（调用失败、解析不出来）：摘要、角色状态照样算数，黄 ❗ 挂在章节上（`op: 'threads'`，与角色状态那一步同一个做法）。
- ⚑ 用哪个模型：单章入口用对话页选定的那个（与摘要同）；批量「写完即定稿」走「单章摘要」档（`plotSummary`）——它和摘要一样是「读一章、按合同摘出东西」，不新增档位。
- `FINALIZE_CALLS` 改成 `{ low: 1, high: 3, max: 3 }`，说明「摘要 1 次；本章出场的人有角色卡时更新角色状态 1 次；有还没收的叙事线时判一次本章推进了哪几条」。主按钮、工作台、右键、批量确认框都用它，批量写章「写完即定稿」的上限跟着从 10n 变成 11n。
- 任务条三步：摘要 → 角色状态 → 叙事线（`total: 3`）。

### 4. 写正文时带哪几条线（`threads` 层）

⚑ **挑线**（修上游 #2、#4、#6：上游按创建顺序取前 6 条，一条超长的线会让后面全部丢掉，第 1 章不带）：

- 候选：还没收的线里，满足任一条的——本章细纲（标题、目的、关键事件、章末钩子）提到了它的名字；本章在它的计划区间里；本章已经过了它的回收章；它已经埋下了（有事件）；本章出场的人（细纲 `characters[]`，≥2 字）出现在它的名字或意图里。**计划中、还没到埋下那一章、细纲也没提到的线不带**——带进去等于提示模型提前埋。
- 排序：细纲提到的 → 本章在区间里的（回收章近的在前）→ 已过回收章的 → 其余已埋下的（最近一次推进近的在前）→ 只是人物对上的。同档按文件里的顺序。
- 最多 6 条、一共 1200 字（上游 `ACTIVE_THREAD_LIMIT` / `ACTIVE_THREAD_CHAR_LIMIT`）。每行的意图截到 60 字、证据截到 40 字，一条线不可能一个人吃掉 1200 字；放不下的那条**跳过、接着试下一条**（上游是 `break`），丢的条目 `dropped` 并写原因（第 2 条）。
- 第 1 章也带：计划在第 1 章埋下的线，写第 1 章的人得知道。
- 一行长这样：`- 玉佩的来历（伏笔 · 已埋下 · 第 2 章埋、第 8 章前收；第 8 章之前不要揭开）意图：……；最近：第 3 章「他摸了摸怀里……」`。没到回收章的线写「第 b 章之前不要揭开」，本章就是回收章写「计划在本章前后回收，以本章细纲为准」，过了写「已过计划回收的第 b 章」。状态用中文，不像上游那样把英文枚举塞进中文提示词（上游 #7）。
- 小节标题：`# 进行中的叙事线（只作提醒：以本章细纲为准，细纲没写到的线不要硬塞；没到回收章的线不许提前揭开）`，排在「定稿原文片段」后面、「前文正文」前面。
- 配方：正文层 P1，排在 `outlineSlice` 后面（它和大纲那一节一样是「计划」，很短）。续写、审稿、修稿不带（续写只带「接着写」真正要看的；审稿判的是正文与细纲）。
- 条目：一条线一个条目，`id` 为 `thread:<序号>`，`label`「叙事线 · 玉佩的来历」，`note` 写状态、区间与为什么带它（「细纲提到」「本章在计划区间内」……）。没有 `threads.md`、或者没有一条候选 → 这一层什么都不出（没有东西被截断）。

### 5. 工程页「叙事线」一行（W2 的延伸）

- 放在「文风与摘要」组（与全书摘要、文风指南同类：一份可选的固定文件），不进「故事架构」组——那组的 x/5 是主链的五件，叙事线不挡路。
- 说明：没有文件或一条线都没有时「未生成」，有了写「5 条 · 3 条进行中 · 1 条已回收」，已过回收章还没收的另加「· 1 条已过回收章」（以「下一可写章 − 1」为当前章）。
- 行内按钮：没有线时「从细纲排出」，有了「从细纲补充」，都发 `projectAction('generateThreads')`（后端弹确认框）；还没有细纲时不给按钮，说明写「拆出细纲之后可以从细纲排出」。右键：打开、从细纲排出 / 补充叙事线。失败的 ❗ 挂在这一行上。
- `ProjectTree` 加 `threadsPath` 与 `threads: { total, open, closed, overdue }`；`threads.md` 每次刷新只读一次（`projectTreeReads` 钉着）。

### 6. 周边

- `workspace/kind.ts`：新种类 `threads`（固定单文件，排在目录判定之前，无 stage / target），`docHandler`；`Workspace.writeThreads(text)`。
- `runtime/errorLog.ts`：`FailureTargetKind` 加 `threads`。
- agent 工具：`run` 加 `generateThreads`；`list` 的固定位置加 `.novelforge/threads.md`；`search` 的 `KINDS` 加 `threads`；`naming.ts` 的审阅框说「叙事线」。
- `model/tiers.ts` 的 `TASK_HINT`：`plotOutline` 与 `plotSummary` 两行补一句「排叙事线」「定稿时判叙事线」。

### 7. 本期不做

- 上游的「沉寂提醒阈值」与沉寂 N 章的徽章：工程页只报「已过回收章」几条。
- 编辑、删除单条事件的界面：就是 Markdown，作者直接改。
- 剧情树（上游 ADR-0014）、配置变更的影响预览。
- 拆完细纲自动排线：要调模型，不能不问（第 4 条）。
- 审稿时对照叙事线：五期审稿判的是正文与细纲，不扩。
- sample-novel 不加 `threads.md`（夹具的 hash 断言与文件计数不动）。

---

## 提交节奏（8 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `feat(model)` | 叙事线文件：解析、外科式追加、状态推导、挑线、事件校验（纯函数 + 单测） |
| 3 | `feat(features)` | 从细纲排叙事线：工程页动作与 agent 的 `run generateThreads` |
| 4 | `feat(features)` | 定稿第三步：判本章推进了哪几条叙事线，证据逐字校验后追加事件 |
| 5 | `feat(context)` | `threads` 层：写正文时带最多 6 条有关的线，放不下的写进明细 |
| 6 | `feat(media)` | 工程页「叙事线」一行 |
| 7 | `test` | 七期验收——排线、连写 3 章并定稿，第 3 章的装配里有线与第 2 章的事件 |
| 8 | `docs` | README、AGENTS.md 与本期动到的模块 README |

---

### Task 2：纯函数（commit 2）

- Create `src/core/model/threadsFile.ts`：`Thread`、`ThreadEvent`、`ThreadStatus`、`THREAD_EVENT_TYPES`、`THREADS_TEMPLATE`、`parseThreads`、`threadStatus`、`isClosed`、`appendThreads`、`appendEvents`、`renderThreadBlock`、`pickActiveThreads`、`renderThreadLine`、常量（`ACTIVE_THREAD_LIMIT = 6`、`ACTIVE_THREAD_CHARS = 1200`、`THREAD_PLAN_LIMIT = 8`、`THREAD_EVENT_LIMIT = 5`）。
- `model/project.ts`：`threadsPath`、`readThreads()`（没有文件返回空）。
- `model/pipeline.ts`：`FINALIZE_CALLS` 按 §3（本 Task 只改常量与说明，测试跟着改）。
- 测试 `tests/unit/model/threadsFile.test.js`：几种手写格式都认、认不出的行不崩；状态取最大章号、同章取后写的；追加线保留原文（CRLF、BOM、作者自加的行）；追加事件插对位置、没有 `- 事件：` 时补；挑线的候选条件、排序、6 条与 1200 字、放不下跳过接着试；一行的截短。

### Task 3：排叙事线（commit 3）

- `workspace/kind.ts`、`handlers/index.ts`、`workspace/index.ts`（`writeThreads`）；`runtime/errorLog.ts`。
- Create `src/core/features/threadsPrompt.ts`（两段系统提示，注明出处）与 `src/core/features/threads.ts` 的 `generateThreads(project)`、`parseThreadPlans`。
- `protocol/in.ts` 的 `ProjectAction` 加 `generateThreads`；`controller/project.ts` 分派；`tools/novel/run.ts` 加动作；`list.ts` / `search.ts` / `naming.ts` 的说明。
- 测试（集成）`tests/integration/features/threads.test.js`：确认框写着 1 次与档位；追加到文件末尾、同名跳过、已有的不动；先校验后取 8 条；区间越界的丢；一条都不合格挂红 ❗ 且不写文件；没有细纲时不调模型。`runTool.test.js`：`generateThreads` 转发并记账。

### Task 4：定稿第三步（commit 4）

- `features/threads.ts` 的 `recordThreadEvents(project, chapter, { run, budget, signal })`、`parseThreadEvents`。
- `features/finalize.ts`：第三步、`FinalizeOptions.threads`（runner）、`onStep('threads')`、`FinalizeOutcome.threads` / `threadsError`、`describeFinalize` 说事件与丢弃；`finalizeChapterTask` 三步进度。
- `features/pipelineBatch.ts`：写完即定稿时第三步走 `plotSummary` 档的池。
- 测试（集成）：有线时 3 次调用、事件追加到对的线下、证据找不到 / 太短 / 线认不出的丢弃并写进提示；没有线或都收了时不调；重新定稿不重复记；这一步失败挂黄 ❗、摘要与角色状态照样在；`finalize.test.js`、`writeBatch.test.js`、`serialBatch.test.js`、`pipeline.test.js` 里跟着变的次数。

### Task 5：`threads` 层（commit 5）

- `context/types.ts`：层 `threads`、条目种类 `thread`。`context/layers/` 新函数、`layers/index.ts` 注册、`focus.ts` 若要读细纲原文、`recipes.ts` 正文配方 P1、`builder.ts` 的小节。
- 测试 `tests/integration/context/threads.test.js`：候选与排序进了消息、顺序对；6 条与 1200 字的丢弃说明；计划中且没到区间的不带；收了的不带；没有文件时这一层为空；续写、审稿、修稿不带。

### Task 6：工程页（commit 6）

- `views/projectView.ts`、`protocol/views.ts`；`media/src/view/project/groups.ts` 的 `buildMetaRows`。
- DOM 测试 `tests/dom/view/projectTree.test.js`：三种说明、两种按钮文字都发 `projectAction generateThreads`、没有细纲时不给按钮、右键菜单；`projectTreeReads.test.js`：`threads.md` 只读一次。

### Task 7：验收用例（commit 7）

`tests/integration/features/threadsFlow.test.js`：从排好前 5 章细纲的工程起，工程页「排叙事线」→ 「批量写章」第 1–3 章、写完即定稿，假模型按脚本应答。断言：

- `threads.md` 里有排出的线，第 1、2 章定稿各给对的线追加了带证据的事件，一条伪造证据的事件被丢弃；
- **第 3 章写正文那一次的装配里**有「# 进行中的叙事线」，带着第 2 章那条事件的证据，计划中、没到区间的那条不在里面；
- 作者手改过的一行（意图）在三次定稿之后原样还在；
- 总调用次数 ≤ 确认框报的上限。

### Task 8：文档（commit 8）

- 根 README：目录结构、工程页「文风与摘要」组、定稿那几段（三步与次数）、上下文装配表（P1 加叙事线）、模型分档表的说明。
- AGENTS.md：开头的链路补「`threads.md`（叙事线，可选）」；第 4 条不动（没写死次数）；第 19 条例外清单加「定稿时把本章推进了哪几条叙事线追加进 `threads.md`（只追加、证据逐字校验）」。
- 模块 README：model、context（七期那张层表）、features、workspace（种类表）、tools、views、media、tests。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- Task 7 通过。
- 独立版打开一个排好细纲的工程：「文风与摘要」组有「叙事线 · 未生成」和「从细纲排出」；点了弹确认框写着 1 次调用。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「七期：叙事线」。先读 `docs/design/plans/2026-10-01-blueprint-pipeline-phase7.md` 全文、根目录 AGENTS.md、总计划的 §1 #22 与 §2.3、四期计划的 §1、§3、§4。上游源码在 `~/workspace/AI-Novel-Writer`，移植的提示词在注释里注明出处。按 Task 2→8 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 4、Task 7 结束时跑 `npm run test:node`，Task 8 再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。这一期不调真实模型。遇到计划里没写到、又会改变产品行为的决定，停下来问。
