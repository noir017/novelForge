# 细纲改用摘要的设计，摘要不再单独存一份

> 2026-10-17。单独一件，**在 main 上直接开发**。起因：作者认为细纲 `plots/` 实际用处极小，照它写不出高质量的章节；摘要的设计更完善。作者的原则是**相似的东西不保留两份**。

**Goal:** 每章只有一份文件，叫「**细纲**」，放在 `.novelforge/summaries/NNN-标题.md`，格式用现在摘要的那八节。
- 写正文之前，它是计划，正文照它写。
- 正文写完后由作者点「定稿」，**拿着细纲和正文，把细纲改成正文实际写成的样子**。

从此不再有一份单独的「单章摘要」文件。`plots/` 目录不再读。

## 作者定的（2026-10-17）

| # | 问题 | 定案 |
|---|---|---|
| 1 | 细纲和摘要留几份 | **一份**，用摘要的格式、放在 `summaries/`，界面和文档**统一叫「细纲」** |
| 2 | 向后兼容 | **不做**。老工程的 `plots/` 直接不认：判成 `other`，不读、不显示、不删，目录守卫照旧拦着 |
| 3 | 定稿做什么 | **反向更新细纲**：拿细纲和正文，正文偏离的地方改成正文的样子，正文没写到的改掉或删掉，正文没偏离的保留原措辞。这是修改，不是重写。调用次数和现在一样，原来「写摘要」那一次就是它 |
| 4 | 定稿还是不是「写完」的判据 | **是**。第 4、23 条不变：不自动跑，只有批量的「写完即定稿」模式例外 |
| 5 | 章末钩子 | **并进「看点」**，不单列。单列的钩子没用，反而会影响模型 |
| 6 | `role`（本章在结构里的功能） | **去掉**。它只出现在细纲标题行，别的地方都不读 |
| 7 | 定稿后又改了细纲 | **要有体现**：正文挂 ⟳，提醒正文可能没跟上 |
| 8 | 认「这一章」用什么 | **继续按路径认**。作者改了文件名，就算新章节。现有的 `resolvePlot` / `retargetPlot`（占位路径 `003.md` → 采纳后变成 `003-雪夜.md`）保留 |
| 9 | 真实模型试跑 | 走本机 newapi（`OPENAI_BASE_URL`），模型用 `gemini-3-flash-lite` |

## 细纲文件

路径是 `.novelforge/summaries/NNN-标题.md`，细纲号 = 章号，**只认根目录下数字开头的 `.md`**；子目录里的判成 `other`。`summaries/global.md` 仍是全书摘要，不变。

代码里的「细纲」继续叫 `plot`（`plotFile.ts`、`plotRelPath`、`listPlots`……），**只是 `plotsDir` 指向 `summaries/`**，不做大规模改名。被删掉的是「单章摘要」这一套：`PlotSummary`、`readSummary`、`writeSummary`、`summaryPathForChapter`、`summaryMirrorRelPath`、`markSummarized`、manifest 里的 `summaryHash`、`handlers/summary.ts`，以及按章节路径镜像的规则。

```markdown
---
no: 12
title: 夜入青云
targetWords: 3000
upstreamHash: …        # 生成计划时，大纲里管这一章那一节的指纹
writtenFrom: …         # 正文是照哪一版细纲写的（内容指纹）。正文落盘时记，定稿时刷新
sourceHash: …          # 定稿时正文的 contentHash。有它，就表示这份细纲反向更新过
cast: [林昭(阿昭), 沈氏]  # 定稿时记，机器读的实际出场
status: done           # 可选：作者手工宣布这一章完成
preflightOk: …         # 可选，不进内容指纹
factCheckOk: true      # 可选，不进内容指纹
generatedBy: novel-forge
---

# 第12章 夜入青云

## 梗概
## 出场人物
## 时间地点
## 关键事件
## 看点
## 新增伏笔
## 状态变更
## 连续性事实
```

- **八节**照 `SUMMARY_SYSTEM` 的字段原样搬过来。原来细纲的「本章目的」并进「梗概」，「章末钩子」并进「看点」。
- **排过没有**（`isPlotFilled`）：仍然只看「关键事件」。
- **内容指纹**：八节全进，`preflightOk`、`factCheckOk`、`cast` 和标题不进。
- **出场人物**：定稿前，这一节写的是**计划出场**，只用来挑角色卡、算「后几章才出场的人」、做一致性预检，**不进出场统计**。定稿后改写成实际出场，同时写 frontmatter 的 `cast`。出场统计 `buildCastIndex` **只认有 `sourceHash` 的细纲**（第 14 条）。
- **连续性事实**：计划时为空（证据句要回原文定位，没有正文就没法定位）。定稿时照现在的做法生成，证据逐字校验。
- **老工程**：`summaries/` 根目录下的旧摘要（`001-楔子.md` 这种）本来就是这八节，带着 `sourceHash` 和 `cast`，会被直接当成定稿过的细纲读进来。frontmatter 里的 `chapter:` 忽略，章号取文件名前缀。子目录里的旧摘要和 `plots/` 都不认。都不迁移，解析失败就当空的处理，不崩（第 1 条）。

## 生命周期与指纹链

```
大纲那一节 ─(upstreamHash)─▶ 细纲 ─(writtenFrom)─▶ 正文 ─(sourceHash)─▶ 细纲（反向更新）
                                 ▲                                          │
                                 └──── 定稿时把 writtenFrom 刷成更新后的指纹 ─┘
```

| 磁盘上是什么 | 阶段 | 主按钮 |
|---|---|---|
| 没有细纲，或者「关键事件」是空的 | 待排 | 写第 N 章细纲 |
| 细纲已填，没有正文 | 待写 | 写第 N 章正文 |
| 有正文，不到 `targetWords` 的八成 | 在写 | 接着写 |
| 正文够了，没有 `sourceHash` | 待定稿 | 定稿第 N 章 |
| `sourceHash` 等于正文的 `contentHash`，或者手标了 `status: done` | 完成 | — |
| 定稿过，正文后来改了（`sourceHash` 对不上） | 待定稿 | 定稿第 N 章（也就是重新定稿） |

定稿过、后来又改了正文的章，回到「待定稿」，不算完成。这和原来的状态机一样：原来也是摘要过期就不算写完（第 23 条）。我起草时在这一格写过「完成 ⟳」，实现时按原状态机改回来了。

脏标记规则：
- 细纲的 `upstreamHash` 和大纲对不上：细纲挂 ⟳（和现在一样）。
- 细纲内容指纹和 `writtenFrom` 对不上：**正文挂 ⟳**。定稿时 `writtenFrom` 会刷新，所以这条同时覆盖两种情况：正文写完、定稿之前改了细纲；**定稿之后又改了细纲**（作者定案 7）。
- 定稿过的章即使上游改了，也不会被拉回待写，只挂 ⟳（第 18 条不变）。
- 没有记录过指纹的不算脏（第 18a 条不变）。

## 定稿：反向更新细纲

调用次数不变：`FINALIZE_CALLS` 仍是 1–3 次，依次是更新细纲 1 次、角色当前状态 0–1 次、判断叙事线 0–1 次。

**提示词**从 `SUMMARY_SYSTEM` 改出来。输出仍是那八个字段的 JSON，规则不变（出场人物、连续性事实、看点）。改动有三处：
- 输入多给一份**当前细纲**：
  - 以正文为准；
  - 细纲里和正文一致的内容，尽量保留原来的措辞和条目；
  - 正文写偏的地方，改成正文的样子；
  - 正文没写到的，删掉；
  - 原计划的伏笔正文里没埋，就从「新增伏笔」里拿掉。
- 细纲是空的（拆书导入、作者手写正文），就照正文从头整理，也就是现在的行为。
- 「看点」那一条照现在写：爽点和章末吊着读者的东西都写进去。

**落盘**：
- 八节整体替换。
- frontmatter 里保留：`no`、`title`、`targetWords`、`upstreamHash`、`status`、`preflightOk`、`factCheckOk`。
- 写入：`sourceHash` = 正文的 contentHash，`writtenFrom` = 更新后的内容指纹，`cast`。
- 落盘前，把旧版细纲复制一份进 `.novelforge/.trash/`（同第 6 条的做法），任务日志写明「旧版已放进回收站」。

⚑A **覆盖前要不要先审阅**：定稿按钮本身就是作者的确认，现在写摘要也是直接落盘，所以我采用「直接写、旧版进回收站」。如果你要先看一张段级 diff 卡片再落盘，告诉我。那要在对话页加一张卡片，批量「写完即定稿」照样直接写。

之后两步不变：角色当前状态、本章推进了哪几条叙事线，都从更新后的细纲读。

## 去掉章末钩子之后

| 原来读钩子的地方 | 改成 |
|---|---|
| 篇幅不够时，用钩子在正文里找收尾那一场再回退（`rewindPoint`，`model/manuscriptCheck.ts:320`） | 不给钩子，走它现成的兜底：从末尾往前切约 25%，最多 600 字 |
| 审稿冻结目标（`freezeGoals`，`model/review.ts:138`） | 目标只取「关键事件」 |
| 写正文时的执行卡（`context/prompts.ts:480`，来自 `layers/dialog.ts:26`） | 只列「关键事件」 |
| 细纲渲染、前序细纲一览、冲突检查、叙事线 | 读「看点」，原来读「本章目的」的地方改读「梗概」 |

## 落在哪

| 模块 | 怎么改 |
|---|---|
| `model/plotFile.ts` | 三节换成八节，frontmatter 合并成上面那一份，`characters` 改从「出场人物」一节（或 `cast`）读；删掉 `role`、`章末钩子`、`本章目的`；`BLUEPRINT_LIMITS` 跟着改 |
| `model/types.ts` | 删 `PlotSummary`；`SummarySections` 并进细纲的八节类型 |
| `model/project.ts` | `plotsDir` 改成 `summaries/`，只扫根目录；删单章摘要那一套（见上一节）；`staleChapters` / `finalizedFacts` 改读细纲的 `sourceHash` 和连续性事实 |
| `model/pipeline.ts` | `PipelineFacts` 里摘要相关的判据改读细纲的 `sourceHash` / `status`；状态机、阶段名、次数估算不变 |
| `workspace/` | `kind.ts`：`plots/` 判成 `other`，`summaries/` 根目录下数字开头的判成 `plot`，`global.md` 不变；`handlers/summary.ts` 删；`handlers/plot.ts` 加定稿写入（刷新 `sourceHash` / `writtenFrom` / `cast`，保留其余 frontmatter，旧版进回收站）；删 `writeSummary` |
| `views/` | `pipeline.ts` 的新鲜度改读细纲；`cast.ts` 只认有 `sourceHash` 的；`summaryIndex.ts`、`projectView.ts` 的悬浮提示改显示细纲 |
| `features/summarize.ts` + `summarizePrompt.ts` | 单章摘要改成反向更新细纲（带上当前细纲）；拆书时批量整理（`syncSummaries`）照正文写细纲；全书摘要（阶段摘要 → `global.md`）的输入改成定稿过的细纲 |
| `features/finalize.ts` | 第一步改调反向更新，后两步读更新后的细纲 |
| `features/blueprint.ts` + `context/prompts.ts` | 每批 5 章的 JSON 合同：`chapterNumber` / `title` / `synopsis`（梗概）/ `characters`（出场人物）/ `timePlace`（时间地点）/ `keyEvents`（关键事件）/ `highlights`（看点）/ `foreshadowing`（新增伏笔）/ `stateChange`（状态变更）/ `newCharacters`（可选）。去掉 `role`、`purpose`、`suspenseHook`；`title` / `synopsis` 必须非空，`keyEvents` 至少一条（⚑B 定案后改成列表，见实施记录）。字段说明照 `SUMMARY_SYSTEM` 的写法改成「计划」口吻；容量合同、节奏规则、修复链不动 |
| `generation/` | `accept.ts` 写新格式（`createPlannedCards` 保留，新角色卡的身份一节从「本章目的」改成「梗概」）；`generate.ts` 的 `planWriting` 不再给钩子，`planReview` 只冻结关键事件 |
| `context/` | 渲染（`render.ts`）换成八节，「上文」带梗概、关键事件、状态变更，「下文」带梗概、关键事件；**细纲配方去掉 `plotSummary`**（前几章已经由 `plotPrev` 和 `plotList` 带了，同一份文件不再带两遍）；正文配方的 `plotSummary` 改读更早几章的细纲，没定稿的标「计划」，不再退化成「本章目的」；`evidence` / `recentFacts` 只认有 `sourceHash` 且对得上的 |
| `features/derive.ts` | 拆书补齐里的「补细纲」一步**整个删掉**：整理细纲那一步已经照正文写出了细纲 |
| `features/` 其余 | `threads.ts` / `preflight.ts` / `plotCheck.ts` / `characters.ts` / `characterCard.ts` / `pipelineBatch.ts`：改节名，语料只取定稿过的细纲 |
| `tools/` + `mcp/instructions.ts` | 路径 `plots/` 改成 `summaries/`；`summary` 工具的说明改成「定稿 = 反向更新细纲」 |
| `media/` + `panes.ts` + `protocol/` | 界面上「单章摘要」的说法改成「细纲」（悬浮提示、定稿按钮的说明）；「全书摘要」不改名 |

## AGENTS.md 要改的条款

只改文字，编号不动：
- 开头几段的链条改成「`outline.md` ──▶ `summaries/NNN-标题.md`（细纲）──▶ `chapters/` ──▶ 定稿反向更新同一份细纲」；`plots/` 加进「代码里不认」的旧目录。
- 第 8 条：去掉「摘要跟着章节文件名镜像」。
- 第 14 条：出场人物只认定稿过的细纲。
- 第 18 条：改成新的指纹链。
- 第 21 条：八节、看点、出场人物是计划。
- 第 23 条：「摘要新鲜」改成「细纲定稿过且对得上」。
- 其余提到「摘要」的地方逐条核对。

模块 README 全部同步。`docs/design/` 下的历史文档不改。

## 样例工程与测试

- `sample-novel/`：
  - 删掉 `plots/`；
  - `summaries/001–003` 改成新格式：并入原细纲的 `targetWords` 和 `upstreamHash`，重新算 `writtenFrom`；
  - 再加一份 `004` 的计划细纲（没有正文），用来覆盖「待写」这条路径。
- `tests/contract/sampleNovel.test.js` 改成断言新的指纹链。
- 测试按模块跟着改。新增：
  - 旧摘要当成定稿过的细纲读进来；
  - `plots/` 判成 `other`；
  - 出场统计只认定稿过的；
  - 定稿后改细纲，正文挂 ⟳；
  - 定稿保留 frontmatter，旧版进回收站。
- 验收：`npm test` 全过，`npm run test:e2e` 能跑就跑；再用真实模型跑一遍「排 3 章细纲 → 写正文 → 定稿」。

## 实施顺序

1. 核心：格式、数据层、网关、状态机、装配、生成合同、定稿、各功能，单测和集成测试同步改。
2. 界面、工具、MCP、文档、样例工程，dom、e2e、contract 测试同步改。
3. 真实模型试跑。

全部做完、测试全过才提交；推送另报。

## 实施记录（2026-10-17）

验收：`npm run typecheck` 零错误，`npm run test:node` 全过（改动前 4632 条，改动后 4796 条）。e2e 需要 Bun，本机没装，没跑（`tests/e2e/standalone/server.test.js` 只对照代码改了）。

**和上面设计不一样的地方**

- 定稿过、后来又改了正文：**回到待定稿**，不是「完成 ⟳」。上面的表格已经改过来了。
- `rewindPoint` 不再收钩子参数，按钩子找收尾那一段的逻辑删掉了，只剩按比例切。审稿冻结的目标去掉了 `kind`，只剩关键事件。写正文提示词里的「章末钩子」改成了「本章细纲约定的结束状态」。
- 拆书删掉「补细纲」那一步之后，细纲阶段的整条补齐链路（`deriveBlueprintContract`、`written` 层的细纲分支、`runPlotBatch` 的 derive 参数）都没人用了，一并删除。拆书整理出来的细纲不记 `targetWords`。
- 排细纲合同里的「看点」原本还有一句「每章都要有一条章末的钩子」，是从旧的 `suspenseHook` 必填项搬过来的，与定案 5 冲突，已删。看点的说法跟摘要的提示词保持一致：「过渡章没有爽点就只写钩子」。
- 实现过程中发现并修了一处原有 bug：`Workspace.deletePlot` 移进回收站时不加序号，而且吞掉错误，会覆盖定稿时刚复制进去的旧版。现在和其他删除动作一样走 `trashPathFor`。
- **定稿解析不了就不写**（试跑撞上的）：第二次试跑里，第 1 章定稿时模型返回的 JSON 多了一个尾逗号。原有的三层解析里，最后一层「全文塞进梗概」把整段 JSON 原文写进了梗概，其余七节写成占位，还记上了 `sourceHash`。结果细纲被毁，这一章却显示已定稿。现在改成：先自己去掉尾逗号再解析一次（`parse.ts` 的 `stripTrailingCommas`），去掉第三层；两层都解析不出来，就走原有的失败分支（报错、挂红、细纲不动、不记定稿）。
- 排叙事线（`planThreads`）仍然读全部细纲，包括还没定稿的计划，因为计划本来就是它的原料。出场统计和角色卡语料只认定稿过的。
- `skills/novelforge-autopilot/scripts/nf.py` 原来写死了 `plots/`，还用「`summaries/` 下有没有同名文件」判断定稿，都改了：路径换成 `summaries/`，定稿看 frontmatter 里有没有 `sourceHash`。

**真实模型试跑**（gemini-3-flash-lite，同一句脑洞，从空工程跟着主按钮写 3 章，每章定稿。报告在 `~/workspace/project-reports/novelForge-细纲改用摘要格式-真实模型对照-gemini-3-flash-lite-20261017.md`，脚本在 `~/workspace/project-scripts/novelforge-merge-plots/`）

| | 改动前 | 改动后 |
|---|---|---|
| 请求数 / 用时 | 21 次 / 3.6 分钟 | 22 次 / 2.7 分钟 |
| 三章字数 | 2538 / 2944 / 2735 | 2950 / 3068 / 2526 |
| 后面章节的人提前登场 | 1 次（第 3 章） | 0 |
| 报错 | 无 | 无 |

- 改动后第 2、3 章的对话**没有引号**，程序的「对白段占比」检查报 2% 和 0%。追查结果：
  - 引号是第一次生成时就没写，后面的续写和回退都没有删它。
  - 旧流程写第 2 章的第一次生成也是 0 个引号，是后来「接着写」时才有的。
  - 把写第 2 章的那份消息原样重放：新流程第一轮重放 2 次都正常；第二轮重放 4 次，引号分别是 0、2、4、0 个。旧流程重放 4 次，分别是 12、2、16、4 个。
  - 结论：gemini-3-flash-lite 在这套提示词下本来就会漏引号，第 3 章则是照着上下文里第 2 章的整章正文学来的。新流程这组样本偏低，但两边是不同的故事，样本又少，不能断定是新格式造成的。这个问题原来就有，不在这次改动范围内。
- 定稿基本是**重写了措辞**，内容保住了。计划里的二字组，定稿后在「梗概」里只剩 16%–30%，在「关键事件」里只剩 6%–25%。但第 3 章拦截、拆穿、结盟、透露鸿门宴这几件事都还在。主要原因是两边格式不同：计划的「关键事件」是一整段 100–300 字的场面描写，定稿用的是摘要的格式，一条一句的列表。见 ⚑B。

**三处取舍（2026-10-17 作者说「按推荐的来」）**

| # | 问题 | 定案 |
|---|---|---|
| ⚑A | 定稿覆盖细纲前要不要先审阅 | **不审阅**：直接写，旧版进回收站 |
| ⚑B | 计划的「关键事件」要不要也改成一条一句的列表，和摘要一致 | **改了**。`keyEvents` 改成字符串数组，一条一件事、按发生顺序，合同要求 3–6 条、合计 100–300 字，每条仍然可以写到具体场面。最多收 8 条（`BLUEPRINT_LIMITS.keyEventItems`），合计超过 1200 字从超出那一条起截掉。模型给成一段字时，按换行和分号拆开照收。执行卡在多于一条时逐条列出；只能一行的地方（前序细纲一览、后续章节边界、排叙事线）用「；」接起来 |
| ⚑C | 排细纲的节奏规则里还有「悬念钩子机制：每章结尾必须有一个让读者想连续翻页的变数」，黄金三章那条也写了「留钩子」（`context/prompts.ts` 的 `blueprintContract`） | **没动**。这条当时没给推荐，所以维持原样。如果作者认为它也会带偏模型，再删 |

已知的小毛病：`freezeGoals` 除了按行切，还按「；」切，一条关键事件里要是带分号，审稿时会变成两项目标。这条没改。
