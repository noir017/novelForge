# 五期：审稿 + 修稿 + 预检 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期直接关系到第 1、2、3、4、11、12、16、19、20、26 条。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#16–#19）、§2.2（审稿不进主按钮）、§2.3 审稿那一行、§3.3 的 W10 / W11、§4（D9、D22）。
> 3. [三期计划](2026-09-30-blueprint-pipeline-phase3.md) §3（续写链）、[四期计划](2026-09-30-blueprint-pipeline-phase4.md) §2（角色「当前状态」与 `stateThrough`）、§5（批量写章）。
> 4. 上游源码：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植处在注释里注明出处。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 一章写好之后，作者可以在正文层发 `/审稿`（或点章节条上的「审稿」）：一次调用出一份报告——每条问题都带一句逐字引文，引文在正文里找不到的条目直接丢掉；本章细纲的关键事件与章末钩子冻结成一张目标清单，逐项判「已完成 / 未完成 / 待核实」，「没写到」只能判待核实。报告不落盘，随会话保存；报告卡上按严重度分组、点引文就在编辑器里定位到那一句，作者勾选之后点「按勾选的 n 条修稿」——只把勾选的条目连同整章原文交给模型，要求最小改动，被截断时最多续 3 次，写完查一遍长度，覆盖前走 diff。独立版的覆盖审阅从一个字数确认框换成段级 diff / 合并视图：逐段「采用新版 / 保留原文」，结果可以手改，手改过的段不会被「采用」冲掉。写第 N 章之前先做一次零调用的一致性预检：细纲把一个角色卡上写着已经死了的人排进了本章，就先在对话页亮一张卡，作者可以「仅本次忽略」。

**Architecture:** 纯函数先行（审稿报告的类型与校验、目标冻结、引文归一与定位、修稿清单渲染、预检、段级 diff、调用次数），再是提示词与三张配方（审稿 / 修稿 / 修稿续写）及两个新层，然后是两条链（审稿链、修稿链）并把审稿从「写正文」那几条路里摘出来，再是 controller 与协议（报告存会话、按勾选修稿、预检卡片、定位引文、覆盖审阅可以交回合并结果），最后是前端两件（W10、W11）与验收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖（段级 LCS 自己写）。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。`model/review.ts`、`model/paragraphDiff.ts`、`model/preflight.ts` **零 import**（前端直接打包）。
- **审稿只出报告、不写文件**（D9、D22）：审稿那一轮没有落盘卡片，报告作为 Draft 随会话保存。它**不进主按钮**（第 20 条），只在正文层的命令面板与章节条上。
- **不静默截断**（第 2 条）：丢掉的问题（引文找不到）、降成待核实的目标、修稿时因正文改过而作废的勾选项、修稿续写的每一轮，一律写进 Draft 的 `notes`，卡片与日志里看得见。
- **不静默覆盖**（第 3 条）：修稿落盘一律走覆盖审阅；独立版的合并视图里手改过的段，「采用新版 / 保留原文」与「全部采用」都不碰它。
- **动手之前写明调用次数**（第 4 条）：审稿「预计 1 次，最多 3 次」；修稿「预计 1 次，最多 4 次」；预检 0 次。
- **严格用作者选定的模型**（第 12 条、第 26 条）：审稿与修稿都是对话页的单次生成，用选定的模型与会话的思考深度；工程页批量任务仍不带思考。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。

---

## 本期定下的东西（写进代码注释）

标 ⚑ 的几处是本期自定、**上游没有或与上游不同**的产品决定，收尾时报给作者确认。

### 1. 审稿能力 `review`

- `Capability` 加 `review`，只挂在正文层：`STAGE_CAPABILITIES.manuscript = ['discuss', 'generate', 'review']`。命令面板里是「审稿」（别名 `review` / `sg`），不要求输入：作者写了话就是「这次重点查什么」（上游 `review_focus`）。
- 输出形态加第三种 `report`（`outputKindOf`）：不是可以落盘的产物，也不是自由作答。凡是按「非 discuss 就是产物」判断的地方（`chainOf`、`cleanOutput`、`parseDraftArtifact`、落盘卡片）都要认它——**否则一份审稿 JSON 会走到写入卡上、被当成正文写进章节**。
- 这一章还没有正文时不审（toast 说明，不调模型）。
- 章节条（W6）加「审稿」按钮，`ChapterAction` 加 `review`：切到这一章的正文层、按 `review` 发一轮。
- agent 的 `generate` 工具不开放 `review`（与 `settle` 同一个做法：报错说明要作者在对话页发起）。报告要作者勾选才修稿，agent 拿到一份报告做不了什么；六期统一改工具时再定。

### 2. 审稿的装配（总计划 §2.3 审稿那一行）

| 层 | 优先级 | 说明 |
|---|---|---|
| `system` | P0 | 移植 `consistency_check` 的 systemRole + 审查原则 + 检查维度（PT:917-970） |
| `ask` | P0 | 作者要求重点检查的维度（可空） |
| `chapterFull` ★ | P0 force | 待审的这一章正文全文（新层） |
| `plotSelf` | P0 force | 本章细纲：目标清单从它冻结 |
| `plotAhead` | P0 | 后 5 章细纲，小标题标「非既定历史」（上游 `planningMaterial`，只用来判断本章有没有提前写掉） |
| `characters` | P1 | 本章出场角色卡（细纲 `characters[]` + 主角），带「状态截至第 K 章」 |
| `premiseWorld` | P1 | 小说配置、故事前提、世界观 |
| `guidance` | P1 | 全局要求 |
| `prevTail` | P1 | 上一章结尾（「前后章节串联」那一维要对照它） |
| `recentFacts` ★ | P2 | 前几章定稿留下的连续性事实（新层，只带事实文字，不回原文取段落；最近 12 章、3000 字封顶，放不下的写原因） |

上游审稿读的是「已定稿历史的连续性投影」（RV:121-154）；这里对应的是四期摘要里的「连续性事实」。不带历史对话——审稿判的是正文，不是聊天记录。

### 3. 审稿报告（`model/review.ts`，纯函数）

**JSON 合同**（移植 `consistency_check` 的 systemSuffix 与 `buildChapterGoalReviewPrompt`，`chapter-goal-review.ts:35-59`）：

```json
{"summary":"一句话总体评价",
 "items":[{"category":"剧情合理性","severity":"error","quote":"原文句子","description":"问题描述"},
          {"category":"角色状态","severity":"pass","description":"未发现不一致"}],
 "goalReviews":[{"id":"g1","evidence":[{"quote":"正文逐字引文"}],"description":"逐个子动作的判断","status":"completed|unmet|unknown"}]}
```

- `items` 1–10 条，`severity` 只有 `error / warning / pass`；`quote` ≤ 160 字、`description` ≤ 200 字、`summary` ≤ 120 字（上游 RV:36-38），超长截断并记一句。解析宽松（第 1 条）：认代码围栏、认前后多余的话（取第一个 `{` 到最后一个 `}`）、`critical / severe` 当 `error`、`minor / warn` 当 `warning`，单条坏了跳过那一条。
- **目标冻结**（`freezeGoals`，移植 `freezeChapterGoals`）：细纲「关键事件」按换行与 `；` 切开，一项一个 id（`g1`、`g2`…）。⚑ **章末钩子单列最后一项**（「章末钩子：……」）——D3 里它是必填的，执行卡也重列它；上游只冻结 keyEvents。
- **引文校验**（总计划 §5 五期；⚑ **与上游不同的两处**）：
  - 归一化之后再找：NFKC、去掉全部空白与标点符号（`\p{P}\p{S}`）后，看正文的归一形里有没有引文的归一形。上游只容忍多一对引号，改一个逗号就认不出；模型抄原文时改标点、并空格是常态。归一后不到 4 个字的引文一律当「找不到」（两三个字到处都能命中，证明不了什么）。
  - **普通问题的引文找不到就丢掉**（上游完全不校验普通问题的引文）：没有原文撑着的「问题」多半是模型编的，留着作者会照着去改一段根本不存在的话。丢了哪几条写进 notes，报告卡上折叠列出。
  - 目标核对：`completed` / `unmet` 必须至少有一句找得到的引文；**任何一句找不到**，这一项整项降成「待核实」、判断换成「这一项缺少可定位的正文证据，请人工核实」（上游同一口径，`chapter-goal-review.ts:82-115`）。「没写到」只能是待核实：`unmet` 没有证据就降级，于是模型没法拿「正文里没提」去判未完成。
  - 漏了哪一项、多出认不出的 id、同一 id 出现两次：那一项待核实，`coverage` 记 `partial`，报告卡上说「目标核对不完整」。细纲关键事件是空的：`coverage` 记 `none`，说「本章细纲没有可核对的关键事件」。
- 报告带 `chapterRelPath` 与 `chapterHash`（审稿时的正文指纹）。修稿时对不上就重新定位每一条勾选项的引文，找不到的作废并说明。
- `renderReport(report)`：一份给人读的 Markdown（气泡正文与「复制」用它，不是那段 JSON）。

### 4. 审稿链（`generation/review.ts`）

移植 `ReviewChapterCommand` 的重试（RV:288-367）：

```
第一次调用（对话页流式）
  → 被输出上限截断：丢弃，整份重来 1 次（截断的那一半不可信，不续接）
  → 解不出来（不是 JSON、没有 items 数组、一条合格的都没有）：丢弃，按合同重建 1 次
  → 仍不行：报错，不出报告（「两次都没有产出合格的审稿 JSON…通常是被输出上限截断」）
  → 校验引文、冻结目标、核对
```

- 调用次数 `REVIEW_CALLS = { low: 1, high: 1, max: 3 }`：「预计 1 次调用，最多 3 次（输出被截断或不合格时重来）」。
- Draft 带 `review`（报告本体），没有 `artifact`，不问落盘。

### 5. 修稿（按勾选的审稿意见）

- 新写法 `WriteMode = 'revise'`：整章、最小改动、覆盖前审阅。**只由报告卡发起**，不进主按钮、不进章节条。
- `InMessage` 加 `reviseChapter { turnId, picks }`：报告所在那一轮 + 勾选的条目 id。后端取那一轮的报告，把勾选项渲染成清单（`renderRevisionBrief`，移植 `renderHumanConfirmedReviewBrief`，`human-confirmed-review.ts:202-252`）：
  ```
  【已确认纳入本次修稿的审稿项】
  1. [剧情合理性 / 严重] ……
     相关原文：……
  2. [本章目标 / 未完成] 关键事件：…… —— 判断：……
  ```
  勾了待核实项时前面加上游那句边界（「作者纳入待核实项不等于确认其为错误，不得据此编造缺失前史或事实……」）。
- 勾选时的正文与审稿时不一样了（`chapterHash` 对不上）：逐条重新定位引文，找不到的那几条作废并写进 notes；一条都不剩就不调模型、toast 说明。
- 发出去的那一轮：用户气泡是 `/按审稿修稿` + 勾选清单（`ChatTurn.revise`，重来一轮时原样重跑）。
- **装配**：修稿配方（§6）；`revision` 层带**整章原文**（从前是 `takeTail(…, 3000)`：3000 token 的尾巴，长一点的章前半截直接没了——这对「重写」也是一处静默截断，一并修）。
- **契约**：移植 `refine_from_review`（PT:1023-1055）的修复原则四条 + 输出要求（纯文本、段间空行、不要开场白）。不带写正文那一套法则、篇幅合同与执行卡——那些是在教它「写一章」，修稿要的是「只改这几处」。
- **修稿链**（`generation/revision.ts`，移植 `bounded-completion.ts` 的 `append-visible-text` 与 `refinement-completeness.ts`）：
  ```
  第一次调用（流式）
    → 被输出上限截断就续写，最多 3 轮（只看截断，不看字数）：续写那一轮带原文、清单与已修订的最后 1600 字
    → 续写没有增长：停
    → 最后仍被截断：报错（整章覆盖一份半截的修订稿比不写更糟）
    → 完整性校验：修订稿字数 < min(原稿, max(200, 0.6 × min(原稿, 每章字数))) → 报错
  ```
  ⚑ **两种报错都不出卡片**（与写章的「已写的不丢」相反）：写章时那一版是新东西，半截也比没有强；修稿是拿它**覆盖**一章已经写好的正文。已经收到的文字留在气泡里，作者可以自己取用。
- 调用次数 `REVISE_CALLS = { low: 1, high: 1, max: 4 }`：「预计 1 次调用，最多 4 次（被输出上限截断时接着写，最多再续 3 轮）」。报告卡底部按钮「按勾选的 n 条修稿」，提示写这一句。
- 落盘：与 `rewrite` 一样整章覆盖、先审阅、沿用原标题行；**不记 `writtenFrom`**（修稿没有照细纲重写，细纲改过的 ⟳ 不能因为修了一次稿就消掉）。不跑重演检测（开头是原稿的开头）。

### 6. 修稿的装配

| 层 | 优先级 | 说明 |
|---|---|---|
| `system` | P0 | 上游 systemRole（「只依据人工确认的审稿意见进行必要修改……」）+ 格式 |
| `ask` | P0 | 作者补充的修稿指导（报告卡上不填就是空） |
| `revision` | P0 force | 待修稿全文 + 勾选清单 |
| `style` / `guidance` | P0 force | 修完的那几处要与全章同一个声音 |
| `plotSelf` | P1 | 修「未完成的目标」要知道细纲原话 |
| `characters` | P1 | |
| `prevTail` | P1 | 修「接不上上一章」要看上一章结尾 |
| `plotAhead` | P1 | 修的时候别把后面几章的事写进来 |
| `evidence` | P2 | 修连续性问题要看定稿原文 |

续写那几轮一张精简配方：system、style、guidance、revision、chapterSoFar（已修订的末尾）。

### 7. 精修（总计划 §1 #18）

「目标有内容时再生成，作者的话就是修改意见」在正文层就是 `rewrite`：本章细纲（`plotSelf`，P0 force）与执行卡一直都在，上游那个「ChapterInfo 传空」的缺口在这里不存在。本期只修一处：`revision` 层带整章原文（§5）。补一条测试钉住「重写时装配里有本章细纲与完整的上一版」。

### 8. 一致性预检（`model/preflight.ts` + `features/preflight.ts`）

- **判据**（移植 `findBlueprintContinuityRisks` 的那一条规则，`consistency-preflight.ts:84-119`）：本章细纲 `characters[]` 里的人（按名字与别名认卡），卡上「当前状态」写着已经死了 → 一条警告。
- ⚑ **读的是角色卡的「当前状态」**（总计划 §1 #19），不是上游的定稿事实投影。只信「写到本章之前」的状态：`stateThrough ≥ N`（状态已经更新到本章或更晚——重写早前的章时常见）不判；没记过 `stateThrough` 的手写卡照判。
- ⚑ **死亡判定**：按句读分句，一句**以**终态说法开头（可以带主语、「已 / 已经 / 于第 k 章 / 被……」前缀）才算：死亡、身亡、牺牲、去世、过世、亡故、病逝、遇害、阵亡、战死、丧生、丧命、殒命、毙命、气绝、惨死、死了、死去，以及「被……杀死 / 刺死 / 毒死 / 打死 / 害死」。前面有「假 / 诈 / 未 / 没 / 险些 / 差点 / 几乎 / 濒临 / 传言 / 疑似 / 误以为」的不算。上游只认「名字紧挨着死亡 / 身亡 / 牺牲 / 去世」四个词，角色卡的状态里通常不写自己的名字，照搬会一条都认不出。宁可误报一条让作者点一下「仅本次忽略」，也别漏报。
- 零调用。上游的那句「这是证据提示，不会阻止创作」照用：警告写「沈秋的当前状态（截至第 5 章）写着『已死亡……』，本章细纲仍安排他出场」+「调整细纲，或者这是回忆、幻象等刻意安排」。
- **单章**（对话页写第 N 章 / 重写，来自主按钮、章节条或对话）：生成之前查一次，有警告就在对话页亮一张卡（`askGate`，红色块列出警告），按钮「仅本次忽略，照写」/「先不写」。点「先不写」：不调模型，那一轮的回复写明为什么停。接着写、修稿不查（开头已经写下了）。
- ⚑ **批量写章**：开跑之前把要写的几章一起查一遍，有警告就在确认框里列出来，按钮「仅本次忽略，照写」；跑的中途新冒出来的（前面刚定稿的一章把某人写死了，后面一章还排着他）→ 停在那一章前面，黄 ❗ 挂在那一章上，完成提示里说清楚。批量没有人看着，接着写就是明知有矛盾还往下写（四期「写出来但不能往下接的也停」同一口径）。
- 不做上游的「永久豁免」（保存安排的理由）：本期只有「仅本次忽略」。

### 9. 覆盖审阅交回合并结果（W11 的后端一半）

- `Host.reviewReplace(name, current, proposed, relPath?, opts?)` 加 `opts.merge`：给了就可以交回 `{ merged: string }`（作者在合并视图里挑过、改过的那一份）。`workspace/guard.ts` 的 `reviewOverwrite` 请求合并、返回 `{ ok, text? }`，`Workspace.write` 落合并后的那一份（记账与伴生照常跑在最终文本上）。
- 其余四个直接调 `reviewReplace` 的地方（角色卡、设定条目、角色状态对比）不请求合并：独立版给它们开只读的 diff 视图（采纳 / 放弃），不再只是一个字数确认框。
- VS Code 壳照旧 `vscode.diff` + 采纳 / 放弃（总计划 W11），忽略 `merge`。

### 10. 段级 diff（`model/paragraphDiff.ts`，纯函数）

- 按空行切段，段的比较键是去掉空白后的文字；两边段序列做 LCS，相邻的改动并成一处（hunk）：`{ kind: 'same', text } | { kind: 'change', old: string[], new: string[] }`。
- 两边都超过 2000 段时不做 LCS，整份当一处改动（章节远到不了这个数，这是防御）。
- 上游 `ThreeWayMerge` 用的是按字频相似度的全局对齐（能认出「一段拆成两段」）；这里用 LCS——修稿与重写的改动多是整段增删改，LCS 已经够用，而且可以单测到每一步。

### 11. 定位引文（W10「点引文就在编辑器里定位到那句」）

- `model/review.ts` 的 `locateQuote(text, quote)`：与引文校验同一个归一化，找到之后把归一形里的位置映射回原文的 `{ start, end }`。
- `InMessage` 加 `revealQuote { relPath, quote }`。`Host.revealText?(relPath, quote)`：独立版打开那一章、推 `editorReveal { path, quote }`，编辑区选中那一段并滚到它；VS Code 打开文档、`selection` + `revealRange`。宿主没有这一项能力时退回 `openFile` 并 toast 那一句（能力探测，不判断是哪个壳）。

### 12. 本期不做

- ⚑ 批量写章的「写完即审稿」模式（四期计划 §8 曾列在这一期）：审稿报告要作者逐条勾选才修稿，批量里没有人勾；只审不修的话，十章报告堆在一个任务里没有地方看。留给作者决定要不要、要的话报告放哪。
- 审稿报告里并入预检警告（上游 `mergeConsistencyFindingsIntoReview`）：上游并进去的引文是**前面某一章**的证据，默认勾选后会被当成本章原文交给修稿——这里不跟。
- 预检的永久豁免；报告卡上「新增人工问题」、编辑条目（上游 ReviewReport 的编辑模式）。
- agent 工具开放 `review`、`TIER_TASK` 加审稿档：六期。

---

## 提交节奏（9 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `feat(model)` | 审稿报告与目标清单、引文归一与定位、修稿清单、一致性预检、段级 diff、审稿与修稿的调用次数（纯函数 + 单测） |
| 3 | `feat(context)` | 审稿与修稿的提示词、三张配方、本章全文与近章连续性事实两层；`revision` 层带整章原文 |
| 4 | `feat(generation)` | 审稿链与修稿链；审稿不再走写正文的那几条路 |
| 5 | `feat(controller)` | 报告随会话保存、按勾选修稿、预检卡片与批量预检、定位引文、覆盖审阅交回合并结果 |
| 6 | `feat(media)` | W10 审稿报告卡、章节条「审稿」、点引文定位 |
| 7 | `feat(media)` | W11 独立版 diff / 合并视图 |
| 8 | `test` | 五期验收——审一章、丢掉伪造引文、按勾选修稿、合并时手改的段不被冲掉、预检拦下死人出场 |
| 9 | `docs` | 本期动到的模块 README |

真实模型冒烟（写 1 章 + 审稿 + 修稿，约 3–10 次调用）按总计划 §7 **要作者点头才跑**，不在这 9 个 commit 里。

---

### Task 2：纯函数（commit 2）

- `model/pipeline.ts`：`Capability` 加 `review`（标签、提示、别名、`STAGE_CAPABILITIES`）；`OutputKind` 加 `report`；`WriteMode` 加 `revise`（`NextStepPlan.writeMode` 不含它）；`REVIEW_CALLS`、`REVISE_CALLS`、`REVISE_CONTINUE_ROUNDS = 3`。
- Create `src/core/model/review.ts`：`ReviewReport` 等类型、`freezeGoals`、`normalizeQuote`、`locateQuote`、`parseReviewJson`、`verifyReview`、`renderReport`、`renderRevisionBrief`、`relocatePicks`、`defaultPicks`。
- Create `src/core/model/preflight.ts`：`isTerminalState`、`findPreflightRisks`、`describeRisk`。
- Create `src/core/model/paragraphDiff.ts`：`splitParagraphs`、`diffParagraphs`、`joinMerge`。
- 测试：命令表与能力集合；引文归一（标点、空白、全半角）、太短不认、定位映射回原文；普通问题找不到就丢、目标任何一句找不到降待核实、unmet 无证据降级、漏项 / 重复 id 记 partial；钩子单列；清单渲染与待核实边界；预检的判定正反例（假死、险些丧命、为已死的师父报仇都不算）、`stateThrough ≥ N` 不判；diff 的相同 / 增 / 删 / 改、相邻改动合并、合并结果拼接。

### Task 3：提示词与装配（commit 3）

- `context/prompts.ts`：审稿的系统提示、审查原则、检查维度、JSON 合同与目标清单（`reviewContract`）；重建那一次的附加指令；修稿的系统提示与契约、修稿续写契约；`CAPABILITY_TASK.review`。
- `context/types.ts`：层 `chapterFull`、`recentFacts`；条目种类 `chapterFull`、`facts`；`BuildRequest.review`（冻结的目标清单）；`ChainStep` 加 `reviewRebuild`、`revisionContinuation`。
- `context/layers/`：两个新层；`revision` 带整章原文（修稿时再带清单）；`plotAhead` 在审稿时换说法。
- `context/recipes.ts`：审稿、修稿、修稿续写三张配方。`context/builder.ts`：小节标题与顺序。
- 测试：三张配方的层与优先级；审稿消息里有全文、细纲、目标清单 JSON、后续章节标「非既定历史」、近章事实；修稿消息里有整章原文与清单、没有执行卡与篇幅合同；重写时 `revision` 是全文。

### Task 4：两条链（commit 4）

- Create `src/core/generation/review.ts`：`completeReview(first, io, ctx)`（§4）。
- Create `src/core/generation/revision.ts`：`completeRevision(first, io, ctx)`、`assertCompleteRevision`（§5）。
- `generation/structured.ts`：`chainOf` 认 `review`、`revise`。`generation/generate.ts`：审稿不 `cleanOutput`、不解析成产物；`planWriting` 认 `revise`；Draft 带 `review`。`generation/accept.ts`：`revise` 覆盖审阅、不记 `writtenFrom`。
- 测试（集成）：审稿一次成功、截断重来、不合格重建、两次都不行报错；伪造引文被丢；修稿一次成功、截断续写、续写三轮仍截断报错、长度不够报错；审稿 Draft 没有 artifact。

### Task 5：controller 与协议（commit 5）

- `protocol/`、`model/session.ts`、`generation/drafts.ts`：`SerializedTurn.review`、`ChatTurn.review` / `revise`、`SessionDraft.review`；`InMessage` 的 `reviseChapter`、`revealQuote`；`OutMessage` 的 `editorReveal`、`prompt.kind = 'merge'`；`ChapterAction` 加 `review`。
- `controller/chat.ts`：审稿轮次不问落盘、报告进会话；`reviseChapter`；`chapterAction('review')`；写章之前的预检卡片。
- `features/preflight.ts`；`features/pipelineBatch.ts`：开跑前预检与中途停下。
- `host.ts`：`reviewReplace` 的 `opts.merge` 与 `{ merged }`、`revealText`。`workspace/guard.ts`、`workspace/index.ts`：落合并结果。两个壳：`fileHost.reviewReplace` 走 `prompt kind: 'merge'`，`revealText`；`vscodeHost.revealText`。
- `tools/novel/generate.ts`：`review` 报错说明。
- 测试（集成）：审稿轮次没有 gate、会话里存着报告、重开会话还在；按勾选修稿发出去的清单只有勾选项；正文改过时作废的条目写进 notes；预检卡片「先不写」不调模型、「仅本次忽略」照写；批量开跑前问一次、中途冒出来的停下挂黄 ❗；合并结果落盘；`revealQuote` 在有 / 没有 `revealText` 的宿主上。

### Task 6：W10（commit 6）

- `media/src/view/review.ts`：报告卡——总评一行、目标核对（逐项已完成 / 未完成 / 待核实、引文、覆盖说明）、问题按严重 / 建议分组、通过项折叠、丢掉的条目折叠；每条可勾选的前面一个勾（error / warning / 未完成默认勾，待核实默认不勾，通过与已完成不能勾）；点引文发 `revealQuote`；底部「按勾选的 n 条修稿」，提示里写调用次数，0 条时禁用。勾选状态按 turnId 记在前端（气泡重建时不丢）。
- `media/src/view/messages.ts`：有 `review` 的轮次画报告卡；用户气泡画 `/按审稿修稿` 与清单。
- `media/src/editor/chapterBar.ts`：「审稿」按钮。`media/src/editor/`：收 `editorReveal`，选中那一段并滚过去。
- CSS 同步；`verify-css`。
- DOM 测试：分组与计数、默认勾选、勾选数进按钮文案、点引文发 `revealQuote`、点修稿发 `reviseChapter` 且只带勾选的 id；章节条「审稿」发 `chapterAction`；`editorReveal` 之后 textarea 的选区落在那一句上。

### Task 7：W11（commit 7）

- `shells/shared/panes.ts`：合并视图的骨架（遮罩层、标题、进度、两颗整体按钮、正文区、底部两颗）。
- `media/src/view/merge.ts`：收 `prompt kind: 'merge'`——相同的段一行带过，每一处改动左右两栏（原文 / 新版）+ 下面一格可编辑的结果（缺省是新版）+「采用新版 / 保留原文」；手改过的那一格标「已手改」，两颗按钮与「全部采用新版 / 全部保留原文」都不动它，另给「撤销手改」；顶上「已处理 k / n 处」；底部「写入合并结果 / 放弃」。只读模式（不请求合并的调用方）只有「采纳 / 放弃」。一处都没动过就交回 `apply`（原样用新版，不经段拼接）。
- CSS 同步；`verify-css`。
- DOM 测试：改动的处数与相同段；采用 / 保留改结果；**手改过的段点「采用新版」「全部采用新版」都不被冲掉**；进度计数；交回的是合并结果；只读模式没有逐段按钮。

### Task 8：验收用例（commit 8）

`tests/integration/features/reviewRevise.test.js`：从写好第 1–2 章（第 2 章已定稿）的工程起，假模型按脚本应答。

- `/审稿` 第 2 章：报告里 3 条问题，其中一条引文是编的 → 报告只剩 2 条、notes 写着丢了哪条；目标清单 4 项（3 条关键事件 + 章末钩子），一项 `unmet` 没给引文 → 待核实；会话文件里存着报告；没有弹落盘卡片；调用 1 次。
- 勾选 1 条问题 + 1 项未完成 → `reviseChapter`：发出去的那一次里有整章原文与只含这两条的清单；假模型先截断一次再续完 → 调用 2 次；覆盖审阅拿到的是修订稿；宿主交回合并结果时磁盘上是合并结果。
- 修订稿不到原稿六成 → 报错，磁盘不变。
- 第 3 章细纲排着角色卡上已经死了的人：主按钮写第 3 章先亮预检卡，「先不写」一次模型都不调；再按一次选「仅本次忽略」照写。

### Task 9：README（commit 9）

只改本期动过、现在描述已经错了的段落：model、context、generation、controller / core、protocol、features、shells、media、tests。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- Task 8 通过。
- 独立版打开一个写好两章的工程：章节条有「审稿」；报告卡按严重度分组、点引文编辑区选中那一句；勾两条点修稿，写入前是合并视图，手改一段再点「全部采用新版」那一段不变。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「五期：审稿 + 修稿 + 预检」。先读 `docs/design/plans/2026-09-30-blueprint-pipeline-phase5.md` 全文、根目录 AGENTS.md、总计划的 §1（#16–#19）、§2.3、§3.3 的 W10 / W11 与 §4，以及三期计划 §3、四期计划 §2 / §5。上游源码在 `~/workspace/AI-Novel-Writer`，移植的算法与提示词在注释里注明出处。按 Task 2→9 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 4、Task 5、Task 8 结束时跑 `npm run test:node`，Task 9 结束时再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。真实模型冒烟要花钱，跑之前必须先找作者确认。遇到计划里没写到、又会改变产品行为的决定，停下来问。
