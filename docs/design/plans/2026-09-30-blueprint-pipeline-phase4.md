# 四期：定稿 + 证据 + 串行批量 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期直接关系到第 2、3、4、11、12、14、15、16、17、19、26 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#13–#15）、§2.1 摘要那一节、§2.3 正文那一行的 P2、§3.3 的 W8 / W9、§4（D10、D15、D17、D18、D23、D24）。
> 3. [三期计划](2026-09-30-blueprint-pipeline-phase3.md) 的 §3（续写链）与 §9（本期接手的那几件）。
> 4. 上游源码：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植处在注释里注明出处。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 一章写够之后，主按钮「定稿第 N 章」一次做完两件事：生成摘要（六节 + 新的「连续性事实」，每条事实用 bigram 在正文里确定性地找一句证据原文，零调用），再用一次调用更新本章出场角色卡的「当前状态」——作者手改过这一节的卡不覆盖、挂黄 ❗、给一个对比入口。写后面的章时，正文层多一层 `evidence`：拿证据原句回到 `chapters/` 里逐字定位，带那一段前后各一段原文。工程页的「批量写章」改成严格串行：写一章（带续写链）→ 落盘 →（写完即定稿模式下）定稿 → 下一章，失败即停、只在章与章之间停。任务进度挪到页头，所有页签都看得见，完成时给一个带「打开第 N 章」的提示。

**Architecture:** 纯函数先行（连续性事实的解析 / 渲染 / 挂证据 / 定位原文、角色状态归属、定稿与批量的调用次数、批量切分），再是定稿那一条功能链（摘要 → 角色状态），然后是装配的 `evidence` 层，再是批量写章与任务登记处（可在章间停、完成提示），最后是前端两件（W8、W9）与验收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。
- **不静默截断**（第 2 条）：定稿时丢掉的事实、`evidence` 定位不到而降级的条目、「上一章还没定稿」，一律进日志或装配明细。
- **不静默覆盖**（第 3 条、D15）：角色卡「当前状态」只有在「自上次机器写入之后没人改过」时才由机器更新；改过的不写、挂黄 ❗、给对比入口。机器写这一节只动这一节与两个 frontmatter 字段，卡上其余内容（包括作者自加的小节）一个字不碰。
- **动手之前写明调用次数**（第 4 条、D16、D17）：定稿「预计 1–2 次」；批量写章按上限报（一章最多 8 次，写完即定稿再加 2 次）。
- **单章写完不自动定稿**（D17）：只有批量的「写完即定稿」模式里才自动定稿。
- **批量不带思考**（第 26 条）；**换人只在档内**（第 12 条），而且**一章之内不换人**：续写那几轮用第一次调用成功的那个模型。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。

---

## 本期定下的东西（写进代码注释）

### 1. 摘要的「连续性事实」（D18 的前半段）

- `SummarySections` 加第七节 `连续性事实`，六节不动（第 14 条依赖「出场人物」）。落盘格式（总计划 §2.1）：
  ```markdown
  ## 连续性事实
  - 林昭左臂被青鳞划伤，未愈 〔证据：「血顺着左臂往下淌，他把袖子扎紧了」〕
  ```
- 摘要的 JSON 契约加 `"连续性事实": ["…"]`：只写正文明写、后面各章必须保持一致的事实（伤势、持有物、谁知道了什么、身在何处、关系变化、生死），一条一句，最多 12 条（上游 `CONTINUITY_FACT_LIMIT`）。
- **证据用确定性方法找，不调模型**：移植 `finalize-chapter.command.ts` 的 `textBigrams` / `evidenceExcerpt` / `buildFinalizedContinuityFacts`（FC:161-230）。按句切正文，去掉事实里的人名之后算 bigram，取命中最多且「有独立支撑」的一句（≤240 字）。事实里提到了出场人物时只在含那个人名的句子里找。
- **找不到证据的事实丢弃**（与上游同）：没有原文撑着的「事实」多半是模型编的，留着会被后面几章当真。丢了几条、是哪几条，写进日志与定稿的 toast。
- 解析容错（第 1 条）：作者手改的这一节，`〔证据：…〕` 缺了、括号写成半角、整行没有 `- ` 都认；认不出证据的行照样是一条事实（只是没有证据，写正文时降级成事实原句）。

### 2. 角色卡「当前状态」（D15）

- 角色卡 frontmatter 加 `stateThrough`（这一节更新到第几章）与 `stateHash`（机器最后一次写这一节时它的指纹）。
- **归属判据只有一条**（`model/characterState.ts` 的 `stateOwnedByMachine`）：这一节是空的，或者 `stateHash` 与这一节当前内容的指纹一致 → 机器可以写；其余（改过、或者从来没记过指纹的非空内容）→ 作者的，不写。与上游 `protectedValue` 同一口径（FC:481-483：非空且不是机器派生的一律保护）。
- **机器写这一节的地方都要记指纹**，否则它自己写的东西下次也被当成作者的：角色图谱建卡 / 覆盖（`acceptRoster`，`stateThrough: 0` = 开篇）、「更新角色卡」采纳后（`stateThrough` = 读到的最后一章）、从正文提取角色建卡、定稿更新状态。维护类动作（清理别名、合并）原样带着旧的两个字段，不重新盖章。
- 写入是**外科式**的：只替换 `## 当前状态` 那一节的内容、改两个 frontmatter 字段（`rewriteFrontmatter` 同一个思路），不整卡重渲染——整卡渲染会抹掉作者自加的小节。
- 定稿那一次调用（移植 `update_character_cards`，PT:1116-1181，字段收成一段文字）：输入本章正文 + 本章摘要「出场人物」里**已经建卡**的人（名字、身份一行、现在的当前状态）；输出 `{"updates":[{"name","当前状态"}]}`，只列状态变了的人，100 字以内。
  - 没有一个出场的人有卡 → 不调，定稿就是 1 次。
  - 认不出的名字忽略并记日志（上游直接报错整批作废；这里一个名字认错不该拖累其余几个人）。
  - 卡上的状态已经更新到比第 N 章更晚的章（重新定稿早前的章）→ 不回退，记一句。
  - 作者的 → 不写，**挂黄 ❗**（`targetKind: 'character'`，`op: 'cardState'`），说明里带上机器给出的那一版。角色行右键「对比第 N 章给出的状态…」走覆盖审阅（`reviewReplace`），采用就按机器写入（记指纹、清 ❗），放弃就清 ❗、不写。
  - 在本章出场、状态没变的人：机器的卡把 `stateThrough` 推到 N（状态仍然成立到这一章）；作者的卡不动。
- 这一节在角色卡上的字数上限不变（第 15 条：120 字）。

### 3. 定稿（`features/finalize.ts`，新）

```
定稿第 N 章
  1. 摘要（1 次）：六节 + 连续性事实 → 挂证据（0 次）→ 落盘
  2. 角色状态（0–1 次）：本章出场、已建卡的人 → 按归属写或挂 ❗
```

- 调用次数 `FINALIZE_CALLS = { low: 1, high: 2, max: 2 }`：「预计 1–2 次调用」（出场的人都没建卡时只有摘要那一次）。主按钮「定稿第 N 章」、章节工作台的「定稿」、工程页右键共用这一个数。
- 摘要失败 → 整个定稿失败（红 ❗ 挂在章节上，与现在一样），不调第二次。角色状态那一步失败 → 摘要照样算数，失败挂黄 ❗ 在章节上（第 16 条：部分完成）。
- 单章入口（主按钮、工作台、右键、agent 的 `run summarize`）用对话页选定的那个模型（与现在的「总结这一章」一致）；批量入口两步各走各的档：摘要 `plotSummary`、角色状态 `characterCard`。
- 「同步所有过期摘要」仍然只生成摘要（它是补账，不是定稿）；但摘要本身从此带连续性事实。

### 4. `evidence` 层（D18 的后半段）

| 取哪几章 | 取什么 |
|---|---|
| 前 5 章（按章号） | 全部连续性事实 |
| 更早的章，最多凑满 12 章 | 只取提到本章角色（细纲 `characters[]` 与他们的别名）的事实 |

- 每条事实拿证据原句回到那一章的正文里**逐字**定位（空白归一后 `includes`），取所在段落与前后各一段，相邻窗口合并（移植 `adjacentEvidencePassages`，CM:65-86）。一章一条条目：`第 N 章 · 定稿原文`。
- **定位不到**（作者改过正文）→ 那一条换成事实原句，条目标 `degraded`，明细写「k 条证据在正文里找不到（正文改过），换成事实原句」。
- 总量封顶 6000 字（上游 `MATERIAL_BUDGET_CHARS`），由近及远填，放不下的章 `dropped` 并写原因；拼进消息时按章号正序。
- 条目种类 `evidence`，小节标题「# 定稿原文片段（前情以这些原文为准；摘要、角色状态与它有出入时信原文）」（上游 CM:223-227 的说法）。
- 与近 2 章全文（`manuscriptFull`）去重：某一章整章正文进来了，它的 `evidence` 条目改成 `dropped`，note「整章正文已完整注入」，预算退回去（与 `prevTail` 同一个做法）。
- 配方：正文层 P2，排在 `globalSummary` 前面；续写配方不带。
- **D23**：上一章有正文但还没定稿（摘要缺失或过期）时，明细里多一条 `dropped` 的「第 N−1 章 · 定稿原文」，note「第 N−1 章还没定稿：没有连续性事实，角色状态截至第 K 章」。`characters` 层每张卡的 note 后面带「当前状态截至第 K 章」（`stateThrough` 缺席时不说）。

### 5. 批量写章（`features/pipelineBatch.ts` 的 `writeManuscripts` 重写，D10）

- 入参 `{ range, mode: 'draft' | 'finalize', confirmed }`。缺省区间：下一可写章起 3 章，一次最多 10 章（W9，上游 1–10 章）。
- 切分是纯函数 `planWriteBatch`（`model/pipeline.ts`，前端弹窗与后端确认框同源）：区间里**已有正文的章跳过**；遇到第一章**没有细纲**的就在它前面收住（后面的章要接着它写，跳过去写不成）。调用次数 = 章数 ×（`WRITE_CALLS` + 写完即定稿时 `FINALIZE_CALLS`），确认框按上限报。
- **严格串行**，不看并发设置：
  ```
  for 每一章：
    写（续写链，与对话页同一个 completeManuscript；池里的首选，失败换同档其余；一章之内续写那几轮钉住同一个模型）
    → 新建 chapters/NNN-标题.md、记 writtenFrom
    → 写完即定稿：定稿（§3）
    → 作者点过「写完这一章就停」：停
  ```
- **失败即停**：写不出来（调用失败、思考吃光、空正文）或定稿的摘要失败 → 停，红 ❗ 挂在那一章上，已经写好的留着。
- **写出来但不能往下接的也停**（这一处是本期定的，上游直接作废整章）：
  - 重演命中（开头与上一章结尾大段重合）；
  - 最后仍不到目标的八成。
  这两种都把已经写出的正文**照样落盘**（新章，没有东西可吞；钱已经花了，D6），**不定稿**，黄 ❗ 挂在那一章上写明原因，批量停下。对话页那边有卡片让作者当场判断；批量没有人看，接着往下写等于让后面几章踩在一个有问题的结尾上。
- 取消（「停止」）：正在写的那一章不落盘（作者不要了），前面的留着。「写完这一章就停」：这一章照常写完、落盘、（定稿），然后停。
- 完成提示（D24）：「第 1–3 章已写好（定稿 3 章）」，按钮「打开第 3 章」；停下时说清停在哪、为什么。
- agent 的 `run batchManuscripts`：缺省区间、只写正文、先弹确认框，返回实际调用次数。

### 6. 任务登记处（`runtime/progress.ts`）与协议

- `runTask` 的选项加 `pausable`：`TaskContext.stopRequested()` 读作者有没有点「写完这一章就停」。快照加 `pausable`、`stopping`。
- `TaskContext.finish(notice)`：任务结束时的那一句（`message`、`level`、可选 `open: { plotRelPath, label }`）。controller 订阅后推 `taskDone`；前端出一条带按钮的提示，按钮发 `openChapter`（W6 那一条）。给了 `finish` 的任务不再另外 `toast`（不重复）。
- `InMessage` 加 `stopAfterItem { id }`；`projectAction` 的批量参数加 `mode`。`OutMessage` 加 `taskDone`。

### 7. 调用次数

| 步骤 | 预计 | 最多 | 文案 |
|---|---|---|---|
| 定稿第 N 章 | 1–2 | 2 | 「预计 1–2 次调用（摘要 1 次，本章出场的人有角色卡时再更新一次角色状态）」 |
| 批量写章 n 章 · 只写正文 | n | 8n | 按件加总 |
| 批量写章 n 章 · 写完即定稿 | 2n | 10n | 同上 |

### 8. 本期不做

- 预检（已死亡的角色又被排进本章）：五期。它读的正是本期维护起来的「当前状态」。
- 批量里「写完即定稿」之外的第三种模式（写完即审稿）：五期。
- 连续性事实的叙事线归并（`threads.md`）：七期。
- 证据的来源 hash、定稿收据、项目租约：不搬（总计划 §1 #14）。

---

## 提交节奏（8 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `feat(model)` | 连续性事实与证据、角色状态归属、定稿与批量写章的调用次数与切分（纯函数 + 单测） |
| 3 | `feat(features)` | 定稿：摘要带连续性事实与证据、一次调用更新出场角色的当前状态、手改过的挂黄 ❗ 与对比入口 |
| 4 | `feat(context)` | `evidence` 层：定稿原文片段、定位不到降级、与近章全文去重、上一章未定稿写进明细 |
| 5 | `feat(features)` | 批量写章严格串行：续写链、写完即定稿、失败即停、章间停下、完成提示 |
| 6 | `feat(media)` | W8 页头任务条与完成提示、W9 批量写章弹窗、定稿按钮与角色的「状态截至第 K 章」 |
| 7 | `test` | 四期验收——连写 3 章，第 3 章看得到第 2 章更新过的角色状态与证据原文；手改过的状态不被覆盖 |
| 8 | `docs` | 本期动到的模块 README |

真实模型冒烟（前 1 章 + 定稿，约 3–5 次调用）按总计划 §7 **要作者点头才跑**，不在这 8 个 commit 里。

---

### Task 2：纯函数（commit 2）

- `model/types.ts`：`SummarySections.连续性事实`、`SUMMARY_SECTION_KEYS` 加一项；`CharacterCard.stateThrough` / `stateHash`。
- Create `src/core/model/continuity.ts`：`ContinuityFact`、`parseContinuityFacts`、`renderContinuityFacts`、`attachEvidence(statements, text, entities)`（bigram，返回 `{ facts, dropped }`）、`locateEvidence(text, quotes)`（段落窗口，返回 `{ passages, located }`）。
- Create `src/core/model/characterState.ts`：`stateHashOf`、`stateOwnedByMachine`、`stampState`。
- `model/markdown.ts`：`replaceSection(text, key, value)`（没有这一节就追加在末尾）。
- `model/pipeline.ts`：`FINALIZE_CALLS`；`deriveNextStep` 的定稿那一档改成「定稿第 N 章」；`WRITE_BATCH_DEFAULT = 3`、`WRITE_BATCH_MAX = 10`、`planWriteBatch`。
- `model/project.ts`：`listCharacters` 读两个新字段，`renderCharacterCard` 写它们；`emptySummarySections` 加一项。
- 测试：挂证据命中 / 人名过滤 / 找不到丢弃 / 上限 12 条；解析手改写法；定位原文的窗口与合并；归属判据四种情形；`replaceSection` 保留其余小节与 BOM；`planWriteBatch` 跳过已写、遇到无细纲收住、上限 10、两种模式的调用次数。

### Task 3：定稿（commit 3）

- `features/summarizePrompt.ts`：契约加「连续性事实」。`features/summarize.ts`：解析它、挂证据、落盘；`summarizeChapter` 返回 `SummaryData | undefined`。
- Create `src/core/features/characterState.ts`：`updateCharacterStates(project, chapter, cast, llm, …)`、`reviewCharacterState(project, relPath)`（对比入口）。
- Create `src/core/features/finalize.ts`：`finalizeChapter(project, chapter, opts)`，返回调用次数与结果。
- 机器写「当前状态」的几处盖章：`generation/accept.ts` 的 `acceptRoster`，`features/characterCard.ts` 采纳更新之后，`features/characters.ts` 建卡。
- `views/cast.ts` 导出按名字认卡的那张表（`cardsForCast`）。
- `controller/project.ts` 的 `finalizeChapter` 走新函数；`characterAction` 加 `reviewState`；`tools/novel/run.ts` 的 `summarize` 走新函数并按实际次数记账。
- 测试（集成）：摘要带连续性事实与证据、找不到的丢了并记日志；状态更新写进机器的卡、只动那一节；手改过的不写 + 黄 ❗ + 对比后采用 / 放弃；没人有卡时只调 1 次；不回退到更早的章；状态那一步失败时摘要照样在。

### Task 4：evidence 层（commit 4）

- `context/types.ts`：层 `evidence`、条目种类 `evidence`；`Assembly.scratch.evidence`。
- `context/layers/background.ts`：`evidence` 层；`manuscriptFull` 去重；`characters` 的 note 带状态截至第几章。
- `context/recipes.ts`、`context/builder.ts`：配方与小节。
- 测试：前 5 章全取、更早只取涉及本章角色、12 章上限、6000 字封顶的丢弃说明；定位不到降级；整章全文进来时去重；上一章未定稿的那一条明细。

### Task 5：批量写章（commit 5）

- `runtime/progress.ts`：`pausable`、`stopRequested`、`finish`、`requestStop`、`onTaskFinished`。
- `protocol/`：`stopAfterItem`、`taskDone`、`projectAction.mode`。`controller/`：转发。
- `generation/generate.ts`：导出 `planWriting`（批量要同一份「写法、目标、上一章结尾」）。
- `features/pipelineBatch.ts`：`writeManuscripts` 按 §5 重写。
- `tools/novel/run.ts`：`batchManuscripts` 的说明与记账。
- 测试（集成）：只写正文连写 3 章；写完即定稿；已有正文跳过；无细纲收住；中间一章失败即停；重演 / 未写够落盘后停并挂黄 ❗；写完这一章就停；取消时这一章不落盘；续写那几轮不换模型；完成提示带「打开第 N 章」。

### Task 6：前端（commit 6）

- `shells/shared/panes.ts`：`#taskList` 挪出工程页，新 `taskBar()` 由两个壳放在页头（插件在标签栏下、独立版在侧栏顶上）。
- `media/src/view/tasks.ts`：「写完这一章就停」；`taskDone` 出带按钮的提示（`toast.ts` 支持一个动作按钮）。
- `media/src/view/forms.ts`：W9 批量写章弹窗（区间、模式；「写完即定稿」的提交键两段式，`form.ts` 加 `confirm`）。工程页工具栏加「批量写章…」，章节组右键换成它。
- 定稿按钮的调用次数（章节条、右键）；角色行说明带「状态截至第 K 章」、右键「对比第 N 章给出的状态…」。
- CSS 同步；`verify-css`。
- DOM 测试：任务条在对话页也看得见；「写完这一章就停」发 `stopAfterItem`；完成提示的按钮发 `openChapter`；弹窗的实时说明与调用次数、上限 10、两段式提交只在第二下发消息。

### Task 7：验收用例（commit 7）

`tests/integration/features/serialBatch.test.js`：从排好前 5 章细纲的工程起，工程页「批量写章」第 1–3 章、写完即定稿，假模型按脚本应答。断言：

- 磁盘上三章正文与三份摘要，摘要里有连续性事实且每条带证据；
- 第 2 章定稿后角色卡的当前状态换成了第 2 章给出的那一版，`stateThrough: 2`；
- **第 3 章写正文那一次的装配里**：角色卡是第 2 章更新过的状态，`evidence` 里有第 2 章证据所在的那一段原文；
- 作者在第 1 章之后手改过一张卡的当前状态：第 2、3 章定稿都没覆盖它，卡上挂黄 ❗；
- 总调用次数与确认框报的上限对得上（实际 ≤ 上限）。

### Task 8：README（commit 8）

只改本期动过、现在描述已经错了的段落：model、context、features、runtime、generation、protocol、media、shells、tests。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- Task 7 通过。
- 独立版打开一个排好细纲的工程：工程页「批量写章…」弹窗写着区间、模式与调用上限；跑起来切到对话页也看得见进度条与「写完这一章就停」；跑完有「打开第 3 章」。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「四期：定稿 + 证据 + 串行批量」。先读 `docs/design/plans/2026-09-30-blueprint-pipeline-phase4.md` 全文、根目录 AGENTS.md、总计划的 §1（#13–#15）、§2.3、§3.3 的 W8 / W9 与 §4，以及三期计划的 §3、§9。上游源码在 `~/workspace/AI-Novel-Writer`，移植的算法与提示词在注释里注明出处。按 Task 2→8 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 3、Task 5、Task 7 结束时跑 `npm run test:node`，Task 8 结束时再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。真实模型冒烟要花钱，跑之前必须先找作者确认。遇到计划里没写到、又会改变产品行为的决定，停下来问。
