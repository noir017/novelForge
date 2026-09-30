# 三期：正文生成 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期直接关系到第 1、2、3、4、11、12、16、19、20、26 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#9–#12）、§2.3 正文那一行、§2.4、§3.3 的 W6 / W7、§4（D6–D8、D16、D23）。
> 3. [二期计划](2026-09-30-blueprint-pipeline-phase2.md) 的 §5–§7：本期的续写链与二期的三条生成链长在同一处（`generation/`），单步与批量共用 `ChainIO`。
> 4. 上游源码：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植处在注释里注明出处。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 细纲排好之后，主按钮「写第 N 章」一次写出一章能读的正文：正文层按总计划 §2.3 装配（执行卡、后 5 章边界、上一章结尾不许重演、去 AI 味禁令），不到目标字数的八成就自动续写，写完查一遍有没有重演上一章结尾；落盘直接进 `chapters/`，已有正文时走覆盖审阅，「接着写」追加。前端能看见续写到第几轮、写了多少字，章节行点开是正文与细纲并排的工作台。本期结尾是**真实模型验收关卡**。

**Architecture:** 纯函数先行（调用次数、续写拼接、重演检测），再是提示词与装配层，然后是续写链（`generation/continuation.ts`，与二期的三条链同一个 `ChainIO`），再是落盘三种写法、协议与 controller，最后是前端两件（W7、W6）与验收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。
- **不静默截断**（第 2 条）：每一轮续写、每一次丢弃与恢复、最后没写够、重演命中，都写进 Draft 的 `notes`，落盘卡片上列出来并进日志。
- **不静默覆盖**（第 3 条）：章节已有正文时，除「接着写」（追加）以外的写入一律走覆盖审阅。
- **动手之前写明调用次数**（第 4 条、D16）：写正文的每一种下一步都带 `calls`，续写的上限算在里面。
- **已写的不丢**（D6）：续写到最后仍不到八成、最后一轮被截断、重演命中，都**不作废**——卡片照样可以「写入」，只是说清楚。唯一不出卡片的是「思考把输出预算吃光、一个字正文都没有」。
- **严格用作者选定的模型**（第 12 条）：续写的每一轮都用第一次那个模型、同一档思考深度（第 26 条）。
- **输出上限一律取模型配置**，不搬上游写死的 8192（总计划 §1 #10）。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。

---

## 本期定下的东西（写进代码注释）

### 1. 写正文的三种写法（`WriteMode`）

| 写法 | 什么时候 | 模型写什么 | 落盘 |
|---|---|---|---|
| `write` | 这一章还没有正文 | 整章 | 新建 `chapters/NNN-标题.md`（空文件就直接填） |
| `continue` | 主按钮「接着写」、工作台「接着写」 | 只写新增的那一段，接在已有正文末尾 | **追加**，不审阅（不覆盖任何东西） |
| `rewrite` | 主按钮「重写第 N 章」，或已有正文时在对话里发「写正文」 | 整章，上一版正文作底稿、作者那句话是修改意见 | **覆盖**，写入前审阅 diff，标题行沿用原文件 |

- 写法由生成层按磁盘定（`resolveWriteMode`）：章节没有正文 → `write`；请求明说 `continue` → `continue`；其余 → `rewrite`。**从前已有正文时一律追加**——对话里发「写正文」写出的是完整一章，追加上去就是两章叠在一起；现在改成覆盖审阅，与「生成即修改意见」的口径一致（二期 `CAPABILITY_TASK.generate`）。
- `NextStepPlan` 加 `writeMode?: 'continue' | 'rewrite'`，主按钮带过去；`SendPayload`、`ChatTurn` 同名字段（重来一轮原样重跑）。
- agent 的 `generate` 工具不带写法，走同一条缺省（有正文就覆盖审阅）。

### 2. 目标字数

- 生成层对正文层兜底：请求没给 `targetWords` 时取细纲的 `targetWords`，再取配置的每章字数（D6：必填，缺省取配置）。agent 工具与快速续写从此也有目标。
- 两者都没有时**不自动续写**（只在被截断时说一句）——「有字就算写够」（第 21 条那半句），不拿猜出来的数去续。

### 3. 续写链（`generation/continuation.ts`，新）

移植自 `generate-draft.command.ts` 的 `extendDraftIfNeeded`（GD:930-1186）与 `bounded-completion.ts` 的拼接。

```
第一次调用（对话页流式 / 批量由链自己调）
  → 截断且新写的正文 < 100 字：报错（有思考时说「思考把输出上限吃光了」，否则说「输出上限太小」），不出卡片
  → 循环，最多 7 轮：
      该续写 = 被截断（stop: maxTokens）或 总字数 < 目标 × 80%
      stop: other（内容审查一类）→ 不续，说一句
      续写一轮：最后 1600 字 + 本章细纲 + 执行卡 + 后 5 章边界 + 文风 + 全局要求 + 出场角色
      新增部分去掉与已写末尾的重叠（≥ 48 个非空白字符才算重叠），去掉整段重复（≥ 40 字）
      被截断且只多了 < 300 字 → 丢弃这一轮，只给 1 次恢复机会（恢复那一轮开头说清「上一轮已丢弃，直接推进下一件事」）
      恢复仍没进展 → 停下，已写的保留
      正常收尾但只多了 < 300 字 → 模型已经收尾，不再续
  → 最后仍被截断：说一句「结尾可能停在半句」
  → 最后仍不到八成：说「未写够 x / y 字」，照样出卡片
  → 重演检测（§4），命中写进说明并标在卡片上
```

- **比上游宽松的两处**：上游恢复失败、最后没写够、被截断收尾都整份作废；这里一律保留并说清（D6：已写的内容不丢）。只有「一个字正文都没有」才报错。
- 调用次数：1 + 至多 7 轮 = **最多 8 次**（恢复那一轮算在 7 轮里，与上游 `MAX_AUTO_CONTINUE_ROUNDS` 同一口径）。
- 续写每一轮的正文照样流进同一个气泡（轮与轮之间空一行，不插「——第 k 步——」那种分隔：读起来得是一章）；丢弃那一轮时气泡退回已保留的版本。
- 进度：每一轮开始、以及流式期间每 300ms 报一次 `{ round, words, target }`（`GenerateHandlers.onProgress`）。
- `continue` 写法时「总字数」含已有正文，气泡里与 Draft 里只有新写的那一段。
- 链的结果多带 `rounds`、`words`（这一章写完后的总字数）、`added`、`short`、`replay`；这些进 Draft，卡片据此写「2980 / 3000 字 · 已达标」或「未写够」。

### 4. 重演检测（`context/replay.ts`，新，纯函数）

移植自 `hasSubstantialPreviousChapterReuse`（GD:276-317）：上一章结尾（约 1000 字，按句界对齐，`chapter-materials.ts:88-97`）与新稿前 1200 字各自归一（NFKC、小写、去空白与标点），按 8 字 n-gram 标出新稿里被覆盖的位置，**连续覆盖 ≥ 80 字**就算重演。返回 `{ hit, quote }`，`quote` 是新稿里那一段的原文（带标点，给作者看）。

- 只在续写结束之后跑一次；`continue` 写法不跑（这一章的开头作者早就有了）。
- 上一章结尾按磁盘现读，不取上下文里那一份（那一份可能被整章全文取代、或被作者取消勾选）。
- 命中**不自动拒收**（总计划 §2.4）：卡片标红、写明重合的原句，「写入」要点两下（按钮文案两段式，不叠弹窗）。上游命中就作废；这里交给作者判断——有时重合的是一句刻意呼应的台词。

### 5. 正文层的装配（`context/recipes.ts` + 新层）

| 层 | 优先级 | 说明 |
|---|---|---|
| `system` | P0 | 移植的写作系统提示 + D8 禁令（§6） |
| `ask` | P0 | 作者本章指导（也进执行卡） |
| `attachments` | P0 | 不变 |
| `style` | P0 | 不变 |
| `guidance` ★ | P0 | 小说配置的「全局要求」一节，单独成段（上游每章都带它） |
| `plotSelf` | P0 | 本章细纲 |
| `prevTail` | P0 | 上一章结尾，标题改成「只作边界，不可重演」 |
| `plotAhead` ★ | P0 | 后 5 章细纲，一章一行（标题 + 关键事件），标「只为了解后面的发力点，绝对不要在本章提前写出」 |
| `chapterSoFar` ★ | P0 | `continue` 写法与续写轮次：本章已写正文的最后 1600 字 |
| `revision` | P0 | `rewrite` 写法：上一版正文 + 修改意见 |
| `characters` | P1 | 本章出场（细纲 `characters[]`）+ 主角，不变 |
| `premiseWorld` ★ | P1 | 小说配置（除全局要求）、故事前提、世界观，一件一条 |
| `outlineSlice` | P1 | 大纲里本章所在那一节 |
| `history` | P1 | 不变 |
| `globalSummary` / `lore` | P2 | 不变（`evidence` 是四期的事） |
| `manuscriptFull` | P3 | 近 2 章全文，不变 |
| `plotSummary` | P4 | 不变 |

- 续写轮次用一张精简配方（`step.kind === 'continuation'`）：system、ask、style、guidance、plotSelf、plotAhead、chapterSoFar、characters。上游续写时把整个材料包再发一遍（GD:1036）；这里只带「接着写」真正要看的，其余靠已写的那 1600 字承接。
- 执行卡、篇幅合同放在消息**最末**（上游 GD:657 的顺序），由输出契约拼。

### 6. 提示词（`context/prompts.ts`）

移植自 `first_chapter_draft` / `next_chapter_draft`（PT:720-855），第 1 章与后续章各一套：

- **系统提示**：原有六条硬性要求保留前五条（它们与上游不冲突）；第 6 条「不要强行收束，留出继续往下写的余地」改成「按细纲约定的结束状态或章末钩子收束」——那一条是一段细纲拆成几章时的写法，一章一纲之后这一章就该停在钩子上。加上：不可偏离的作者事实、文风适用边界、格式（双引号、段间空行、写不够停在段末、不写「继续生成」）、叙事视角（配置里写了的话）、**D8 去 AI 味禁令四条**。
- **输出契约**：第 1 章「黄金第一章」四条 / 后续章「连载更新法则」五条；篇幅合同（±20%）；执行卡（必需事件 = 关键事件、章节钩子 = 章末钩子、作者本章指导 = 这一轮的输入）。**单章入口也带章末钩子**——上游单章入口漏了（`chapter-creation-parameters.ts:43-58` 不收 suspenseHook）。
- `continue` 写法 / 续写轮次的契约：「从已写正文末尾无缝接下去，只输出新增正文，尽量写完剩余约 R 字」+ 上游那六条硬性要求（GD:1012-1018）+ 执行卡；恢复轮前面加上游那句「上一轮已被丢弃……禁止复述已写末尾」。
- 删掉 builder 里「目标字数：约 N 字（±15% 均可）」那一行，由篇幅合同代替（两处写两个比例，作者与模型都分不清哪个算数）。

### 7. 调用次数

| 步骤 | 预计 | 最多 | 文案 |
|---|---|---|---|
| 写第 N 章 / 接着写 / 重写第 N 章 | 1 | 8 | 「预计 1 次调用，最多 8 次（没写够时自动续写，最多再续 7 轮）」 |
| 定稿（生成摘要） | 1 | 1 | 不变（四期改成 2 次） |

`CallEstimate` 加可选的 `why`，`describeCalls` 把它接在后面。卡片上写「这一轮一共调了 3 次模型（续写 2 轮）」。

### 8. 协议与会话

- `SendPayload.writeMode?`、`ChatTurn.writeMode?`、`NextStepPlan.writeMode?`。
- `OutMessage` 加 `writeProgress { turnId, round, words, target? }`（W7）与 `streamReset { turnId, text }`（丢弃那一轮时把气泡退回去）。
- `SerializedArtifact` 加 `length?: { words, target?, added?, reached }`、`replay?: string`、`append?: boolean`。
- `gate` 消息加 `danger?: string`（红色块）与 `confirm?: string`（「写入」要点两下时第二下的字）。
- `Draft` / `SessionDraft` 加 `writeMode`、`length`、`replay`。
- `InMessage` 加 `openChapter`、`chapterAction`（W6，见下文）。

### 9. 本期不做

- **批量写正文接续写链**：`features/pipelineBatch.ts` 的 `writeManuscripts` 四期整个重写成严格串行（D10），那时一并接上续写链与重演检测（批量没有人看卡片，命中要怎么处理得和「失败即停」一起定）。本期它照旧一章一次调用，只是自动吃到新的装配与提示词；确认框的调用次数照实说「一章 1 次，不自动续写」。
- **`evidence` 层与定稿后的角色状态**：四期。
- **续写时带上已写正文里新出场的角色**：续写轮次的出场角色仍按细纲挑。

---

## 提交节奏（10 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `feat(model)` | 写正文的调用次数与写法、续写拼接与重演检测（纯函数 + 单测） |
| 3 | `feat(context)` | 移植的正文提示词、四个新层与正文 / 续写两张配方 |
| 4 | `feat(generation)` | 续写链、`generate` 接链与进度、落盘的三种写法 |
| 5 | `feat(controller)` | 协议与会话字段、卡片上的字数与重演、主按钮带写法、快速续写 |
| 6 | `feat(media)` | W7：写章进度条、写入卡的字数、重演标红与两段式写入 |
| 7 | `feat(media)` | W6：章节工作台 |
| 8 | `test` | 三期验收——跟着主按钮写完前 3 章，续写与重演的八种情形 |
| 9 | `docs` | 本期动到的模块 README |
| 10 | — | 真实模型验收：脚本放 `~/workspace/project-scripts/novelforge-phase3-live/`，导出放 `~/workspace/project-reports/`，**跑之前先找作者确认网关、模型与预计调用次数** |

---

### Task 2：纯函数（commit 2）

- `model/pipeline.ts`：`MAX_CONTINUE_ROUNDS = 7`、`WRITE_CALLS`、`CallEstimate.why`、`describeCalls`；`deriveNextStep` 的三种写正文都带 `calls` 与 `writeMode`。
- Create `src/core/context/replay.ts`：`previousEnding(text)`、`detectReplay(prevEnding, draft)`。
- Create `src/core/generation/continuation.ts` 的纯函数部分：`stripOverlap(existing, addition)`、`joinContinuation(existing, addition)`（去重叠 + 去整段重复 + 去「继续生成」类提示行）、`shouldContinue(...)`。
- 测试：重演命中 / 不命中 / 太短不判 / 标点空白差异照样命中 / `quote` 是原文；重叠去除（≥48 才算）、整段重复去除、提示行去除；调用次数与文案。

### Task 3：提示词与装配（commit 3）

- `context/prompts.ts`：写作系统提示（第 1 章 / 后续章）、D8 禁令、黄金第一章 / 连载更新法则、篇幅合同、执行卡、接着写与恢复的契约，各注明出处。
- `context/types.ts`：`BuildRequest.writeMode`、`ChainStep` 加 `continuation { tail, remaining?, recovery }`；新层 `guidance`、`premiseWorld`、`plotAhead`、`chapterSoFar`，新条目种类 `guidance`、`boundary`、`chapterSoFar`。
- `context/layers/`：四个新层；`prevTail` 的说法。
- `context/recipes.ts`：正文配方按 §5；续写配方。
- `context/builder.ts`：新条目的小节标题与顺序；删「目标字数 ±15%」；上一章结尾的两种说法都带「不许重演」。
- 测试：配方层与优先级；第 1 章与第 N 章的提示词各有各的法则；执行卡在最后、带章末钩子与作者指导；后 5 章边界只带排过的、最多 5 章；全局要求单独成段且不在 premiseWorld 里重复；续写配方不带摘要与全文。

### Task 4：续写链与落盘（commit 4）

- `generation/continuation.ts`：`completeManuscript(first, io, ctx)`（§3）。
- `generation/generate.ts`：正文层接链；目标字数兜底；`resolveWriteMode`；`onProgress`、`onReset`；Draft 的新字段；正文层失败照旧挂在细纲上。
- `generation/structured.ts`：`ChainIO.call` 可选 `separator`，`ChainIO.reset` 可选。
- `generation/accept.ts`：正文三种写法（§1）；`AcceptOptions.writeMode`。
- 测试（集成）：一次写够、截断续写、不到八成续写、低增长丢弃后恢复、恢复失败保留、思考耗尽报错、最终未写够照样出 Draft、重演命中写进说明、`continue` 只含新增、`rewrite` 覆盖前审阅且保留标题行、`write` 新建。

### Task 5：controller 与协议（commit 5）

- `protocol/`、`model/session.ts`、`generation/drafts.ts`：§8 的字段。
- `controller/chat.ts`：`writeMode` 进会话与生成请求；`writeProgress` / `streamReset` 转发；卡片的 `length` / `replay` / `append`；`targetHasContent` 按写法说「覆盖」；`artifactDetail` 写字数行与续写轮数；重演命中时 gate 带 `danger` 与 `confirm`。
- `features/pipelineBatch.ts`：确认框里的调用次数照实说（§9）。
- `shells/vscode/quickContinue.ts`：落点改成全书状态机的下一可写章，带目标字数；完成时整份替换文档（续写丢弃过的那一轮不留在文档里）。
- `tools/novel/generate.ts`：`targetWords` 的说明改成「留空取细纲 / 配置」。
- 测试：卡片字段；重演 gate 带 danger；主按钮「接着写」发出去的 writeMode。

### Task 6：W7（commit 6）

- `media/src/view/messages.ts`：流式气泡顶上一条进度（「第 k 轮 · 已写 x / 目标 y 字」+ 进度条），收 `writeProgress`；`streamReset` 替换气泡文本。
- `media/src/view/gate.ts`：`danger` 画成红色块；有 `confirm` 时「写入」第一下改字、第二下才发。
- CSS 同步；`verify-css`。
- DOM 测试：进度条随消息更新；两段式写入只在第二下发 `gateResult`；没有 danger 时一下就发。

### Task 7：W6 章节工作台（commit 7）

见下文「W6」一节。

### Task 8：验收用例（commit 8）

`tests/integration/generation/manuscriptChain.test.js`：假模型按脚本应答，从二期验收结束的状态（前 5 章细纲）起，经 controller **跟着主按钮**走「写第 1 章 → 定稿 → 写第 2 章 → 定稿 → 写第 3 章」，断言磁盘上的三章、主按钮每一步落在哪、总调用次数；第 2 章那一次故意先截断再续写，第 3 章故意重演一段上一章结尾（卡片标红，点两下写入）。另外八种情形各一条（§3 的每个分支 + 调用次数文案）。

### Task 9：README（commit 9）

只改本期动过、现在描述已经错了的段落：context、generation、features、model、media、shells、tests。

### Task 10：真实模型验收

- 先实测网关地址、key、两个候选模型能不能调（只调 `/v1/models` 与一次最小请求），**然后找作者确认**：用哪个模型、预计调用次数（配置 1–3、前提 1、角色 2–4、世界观 1、大纲 1、细纲 1、正文每章 1–8、定稿每章 1：共约 15–25 次）。
- 脚本用 `tests/helpers/load.js` 的 `loadBundle` 直接跑源码，经 controller 跟着主按钮走「一句话 → 前 3 章」，每张卡片答「写入」，产物导出成一份 Markdown（三章正文 + 细纲 + 调用与降级记录）发给作者。
- **作者读得下去才进四期**；读不下去就在本期里调提示词和配方。

---

## W6：章节工作台（Task 7）

**点章节行 = 正文与细纲并排打开。** 从前点行名只开一份（有正文开正文，否则开细纲），对照着看要自己再去右键「打开细纲」。

- **协议**：`InMessage` 加 `openChapter { plotRelPath }` 与 `chapterAction { plotRelPath, action: 'write' | 'continue' | 'rewrite' | 'finalize' }`。
- **后端**（`controller/files.ts`）`openChapter`：
  - 正文在就 `host.openFile(正文)`，细纲在就再 `host.openBeside(细纲)`；
  - 宿主没有 `openBeside`（能力探测，与 `openDraft` 同一个判法）时只开一份；
  - 还没有正文时只开细纲（主区）。
  - 独立版的 `openBeside` 落在第二块编辑区（从前只放草稿的那块）；VS Code 的落在 `ViewColumn.Beside`。**两个壳都不用改**。
- **后端** `chapterAction`：`finalize` 走既有的 `finalizeChapter`；其余三种等于「对这一章按下主按钮」——切到这一章的正文层，按对应写法发一轮生成（`writeMode`）。
- **前端**：
  - 工程页章节行的行名点击改发 `openChapter`（右键里单独的「打开正文」「打开细纲」保留）。
  - 独立版编辑区顶上一条**章节条**（`media/src/editor/chapterBar.ts`，新）：主区当前那份文件是某一章的正文或细纲时出现，写「第 3 章《夜访》 · 待写正文 · 1860 / 3000 字」，按钮「写这一章 / 接着写 / 重写 / 定稿」按这一章的状态亮灭，按钮提示里写调用次数；另一份没开着时给「并排看细纲」「并排看正文」。数据取自后端推来的工程树（`project` 消息），不新增推送。
  - 第二块编辑区的空白提示从「这一块用来放草稿」改成「这一块放草稿或细纲」。
  - VS Code 壳没有内置编辑器，不画章节条——并排的两个编辑器加侧边栏的主按钮就是那一套。
- 审稿按钮是五期的事，本期不放。
- DOM 测试：行名点击发 `openChapter`；章节条随活动文件出现与消失、按钮按状态亮灭、点击发 `chapterAction`；集成测试：`openChapter` 在有 / 没有 `openBeside` 的宿主上各开几份。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- 假模型跑通 Task 8；续写与重演的八种情形各有测试。
- 独立版打开一个排好细纲的工程：主按钮「写第 1 章」提示写着「预计 1 次调用，最多 8 次」；写的时候气泡顶上有进度；写入卡写着字数；点章节行是正文与细纲并排。
- 真实模型跑出前 3 章，作者读过。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「三期：正文生成」。先读 `docs/design/plans/2026-09-30-blueprint-pipeline-phase3.md` 全文、根目录 AGENTS.md、总计划的 §1、§2.3、§2.4 与 §4，以及二期计划的 §5–§7。上游源码在 `~/workspace/AI-Novel-Writer`，移植的提示词在注释里注明出处。按 Task 2→9 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 4、Task 8 结束时跑 `npm run test:node`，Task 9 结束时再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。Task 10 要花钱，跑之前必须先找作者确认。遇到计划里没写到、又会改变产品行为的决定，停下来问。
