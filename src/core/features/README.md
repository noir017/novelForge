# core/features — 功能编排

面向用户动作的编排层：每个文件对应一类「点一下发生什么」。负责组合数据层（model）、装配器（context）与模型层（llm），并把结果以回调形式交回宿主，不直接操作 UI。

## 文件

| 文件 | 职责 |
|---|---|
| [creation.ts](creation.ts) | 设置页的连接测试（`testConnection`，严格用指定的模型）与两个纯文本工具 `cleanOutput`（只对正文层用）、`suggestTitle`。 |
| [artifact.ts](artifact.ts) | ★ 模型输出 → 可采纳的结构化产物（三层降级；细纲给了区间就按批次合同严格解码）。 |
| [blueprint.ts](blueprint.ts) | 细纲批次（章节蓝图）的严格解码与覆盖检查，含这一章在叙事线上的计划 `threads`。 |
| [roster.ts](roster.ts) | 角色图谱两段式的解码：身份清单 → 按冻结清单补详情 → 拼成角色卡。 |
| [loreExpand.ts](loreExpand.ts) | 展开一条设定的解码与截断（明面三节合计 600、暗设 200、一句话 40）。 |
| [loreSettle.ts](loreSettle.ts) | 落定设定的解码：一批条目照展开那一套截，最多 12 条。 |
| [loreList.ts](loreList.ts) | 设定清单（架构第五件）两段式的解码：清单 → 每 6 条补正文三节；调用次数 `loreListCalls()`。 |
| [novelConfig.ts](novelConfig.ts) | 小说配置的 JSON 合同、「全局要求」的质检与规范化草稿。 |
| [structuredJson.ts](structuredJson.ts) | 结构化输出的 JSON 小工具，含转写用的 `jsonValueOf` / `withoutNone` / `unfaithfulStrings`。 |
| [parse.ts](parse.ts) | 模型输出解析小工具：剥代码围栏、提取 JSON、字符串与数字去重、字符串数组归一。 |
| [pipelineBatch.ts](pipelineBatch.ts) | ★ 工程页的三条批量动作（补齐架构、批量拆细纲、批量写章），都严格串行、一件失败就停、只补空白。 |
| [askCall.ts](askCall.ts) | ★ 调模型之前的那一问：确认框上模型与上下文详细度两个下拉框只在这里拼（第 4 条）。 |
| [transcribe.ts](transcribe.ts) | ★ 转写的整条走法 `transcribeJson`：照抄 → 「无」换空 → 逐段核对出自原文 → 原来的解码，不合格重转一次。 |
| [poolIO.ts](poolIO.ts) | 工程页任务那条路的 `ChainIO`（走分档池、用干活那个模型的窗口、不带思考深度），以及转写的 `lazyTranscriber` / `transcribeWith`。 |
| [finalize.ts](finalize.ts) | ★ 定稿一章：照正文反向更新细纲 → 出场角色的当前状态 → 叙事线 → 故事时间。 |
| [finalizeSteps.ts](finalizeSteps.ts) | 定稿的后几步（角色状态、叙事线 `judgeChapterThreads`）与 `ModelRunner`，单章定稿与「立即同步」共用。 |
| [threads.ts](threads.ts) | 叙事线：从情节大纲排线（`generateThreads`）与定稿时认事件 / 归并 / 当前进度（`recordThreads`）。 |
| [threadsBackfill.ts](threadsBackfill.ts) | **从已写正文补记叙事线**：`planThreadsBackfill` 算出水位之后要判的章（零调用），`runThreadsBackfill` 按章号串行补。 |
| [storyTime.ts](storyTime.ts) | **认时间**：同步一章时单独推一次故事时间（`recordChapterTime`），补推、重推也走 `judgeTimes`。 |
| [timelineBackfill.ts](timelineBackfill.ts) | **补推、重推故事时间**：几章一批，只动机器写的行。 |
| [timelineEdit.ts](timelineEdit.ts) | **作者在工程页改故事时间**（零调用）：改一行、改历法与起点，经网关只改那一行、那两个键。 |
| [threadPlan.ts](threadPlan.ts) | 叙事线的计划事件随细纲走：`writePlannedThreads` 整组换掉那几章的计划事件、新伏笔加在线下。 |
| [threadsPrompt.ts](threadsPrompt.ts) | 叙事线的四段系统提示（排线、认事件、当前进度、归并），按格式写、转写成 JSON。 |
| [plotCheck.ts](plotCheck.ts) | 写前冲突检查（只在批量写章里跑）：本章细纲比对前面的连续性事实，对不上就停在那一章前面。 |
| [preflight.ts](preflight.ts) | 一致性预检的取数（零调用；判断在 `model/preflight.ts`），对话页写第 N 章之前与批量写章两个入口。 |
| [characterState.ts](characterState.ts) | 定稿时更新本章出场角色的「当前状态」：归机器的卡只换那一节，作者改过的不写、挂黄 ❗。 |
| [summarize.ts](summarize.ts) | 定稿第一步（`summarizeChapter`）、「立即同步」（`syncSummaries`）与全文大纲（`updateGlobalSummary` / `rebuildGlobalSummary`）。 |
| [summarizePrompt.ts](summarizePrompt.ts) | 定稿（照正文整理细纲）、阶段大纲与全文大纲的系统提示，以及转写合同 `SUMMARY_JSON_CONTRACT`。 |
| [characters.ts](characters.ts) | 从选定的几段正文批量提取 / 更新角色卡（剧作称谓换成真名、同一批先去重）。 |
| [charactersPrompt.ts](charactersPrompt.ts) | 批量提取角色卡的系统提示（一个人物一份、十个小标题，不写 JSON）与转写那一步的合同（`CHARACTER_JSON_CONTRACT`）。 |
| [lore.ts](lore.ts) | ★ 设定条目的四件维护：建条目、整合、按目录整理、批量展开。 |
| [loreRecord.ts](loreRecord.ts) | 记设定：定稿时顺手记进细纲「设定」一节（`checkLore` 校验），以及单独记一章 / 补记（`recordLore`）。 |
| [lorePrompt.ts](lorePrompt.ts) | 「设定」字段说明（定稿与单独记设定共用）与建条目、整合、按目录整理的提示词及转写合同；字数上限是第 27 条的锚点。 |
| [characterCard.ts](characterCard.ts) | ★ **单个角色**的档案更新编排；解析在 characterCardParse.ts，提示词在 characterCardPrompt.ts。 |
| [characterCardParse.ts](characterCardParse.ts) | 角色卡更新的 JSON 解析（`parseCardResponse`）与转写那一步的说明（`cardTranscribeSpec`：合同、解码、性别按对应关系填）。 |
| [characterCardPrompt.ts](characterCardPrompt.ts) | 更新角色卡与定稿时更新当前状态（`STATE_SYSTEM`）的系统提示，及各自的转写合同。 |
| [characterMaintenance.ts](characterMaintenance.ts) | ★ 两条不调模型的整理动作：`cleanCharacterAliases` 删非专属别名、`mergeDuplicateCharacterCards` 合并重复卡；只改 frontmatter。 |
| [style.ts](style.ts) | 从样章归纳文风指南写入 `.novelforge/style.md`。 |
| [stylePrompt.ts](stylePrompt.ts) | 文风提取与从参考书学写法的系统提示（只学技法，不复述情节、不抄原句）。 |
| [bookText.ts](bookText.ts) | 拆书两条路共用的取书：作者可挑本机任意位置的 txt（上限 64 MiB），agent 给的路径只认工程里的清单。 |
| [importManuscript.ts](importManuscript.ts) | ★ **导入原稿**（拆书 A）：挑 txt → 切章 → 确认 → 一批建好章节，再问要不要从已写正文补齐。 |
| [exportBook.ts](exportBook.ts) | **导出全文**（零调用）：全部章节按章号拼成 `导出/<书名>.txt`。 |
| [derive.ts](derive.ts) | ★ **从已写正文补齐**（拆书 A）：按 细纲 → 配置 → 前提 → 角色卡 → 世界观 → 设定条目 → 全文大纲 的顺序只补空白。 |
| [outlineRewrite.ts](outlineRewrite.ts) | **分段重写情节大纲**：只重写还没写正文的章，20 章一段，全部写完一次审阅。 |
| [reference.ts](reference.ts) | **从参考书学写法**（拆书 B）：学文风写 `style.md`、学写法写成本工程的写作技能；原文不进工程。 |
| [bookReplace.ts](bookReplace.ts) | ★ **全书替换**（零调用）：预览里勾着的几处经网关逐份写；未保存的、hash 对不上的跳过，换之前先存一版历史。 |
| [checkpoint.ts](checkpoint.ts) | 存档点：批量动作之前自动存（`checkpointBefore`，绝不抛）与退回的编排（`restoreCheckpoint`）。 |
| [pickPlots.ts](pickPlots.ts) | 多章选择：Host.pick 只支持单选，需要选几章时改为输入章号列表（如 `1,2,3`）。 |

## 创作的四层与两条路

创作按 `Stage × Capability × Target` 展开（定义在 [../model/pipeline.ts](../model/pipeline.ts)）：架构 → 大纲 → 细纲 → 正文。同一层可以被讨论（默认动作，挑刺、检查设定都靠直接打字说），也可以被生成；细纲层另有一个 `settle`（落定细纲），把刚才那段讨论里**已经达成的结论**沉淀成细纲。改写不是独立能力：目标已有内容时的生成就是改写，作者那句话就是修改意见。从前还有 `split`（大纲拆卷、卷拆剧情段）与拆章，卷那一层删掉之后都没了。

**创作编排本身已经不在本层了**——它是 [../generation/](../generation/README.md)：`generate.ts` 无状态地装配 → 调模型 → （需要时接 `structured.ts` 的生成链）→ 解析成 `Draft`，`accept.ts` 按产物分派到八条落盘路径，`drafts.ts` 让草稿活过一次刷新。并发控制在 `controller/`（那是调度的责任）。本层留下的是 `artifact.ts`（解析）与 `pipelineBatch.ts`（工程页批量）。

**生成与落盘是两步**，这是这条路上最要紧的一条：

1. `generate()` 只把文本交回调用方，**一个字都不写盘**，产出一份带 `artifact` 的 `Draft`；
2. `acceptArtifact()` 才写，且只在用户在那张落盘卡片上点了「写入」之后（`controller/chat.ts` 的 `askArtifact`，产出的当下就问）——**落盘时拿气泡里当下的文本重新解析**（用户可能改过），`draft.artifact` 只是生成那一刻的展示快照。

中间那一步是用户看着产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。

`generation/`（创作页，一次一份）与 `pipelineBatch.ts`（工程页，一次几十份）的失败模型完全不同，所以是两条路：

| | `generation/` | `pipelineBatch.ts` |
|---|---|---|
| 一次处理 | 一份产物 | 几十章 |
| 覆盖已有产物 | 走 `reviewReplace` 逐份审阅 | **一律跳过**——一次弹 63 个 diff 没人看得完。补齐架构连一节都不覆盖：作者写过的节原样留着（`onlyBlank`） |
| 解析失败 | 单份文档全文兜底（产物摊在屏幕上，用户看得见它是什么）；细纲批次不兜底 | **不兜底**——没人逐份过目，兜底会把「这次失败了」变成「这一章已排好」，紧接着的批量写章还会照着它写出一整章 |
| 出错 | 报错，用户重来 | 记进 errorLog 挂在那一行上，**就此停下**——后一件、后一批、后一章要吃前面的产出 |
| 写出来但有问题（重演、没写够） | 卡片上标出来，作者当场判断 | 照样落盘（钱已经花了，D6），不定稿，黄 ❗ 挂在那一章上，**停下**——接着往下写等于踩着一个有问题的结尾 |

两条路共用同一个 `buildContext` 与同两条生成链（`generation/structured.ts`、`generation/continuation.ts`），因此批量与单次产出的是同一个质量、同一套降级与续写。

## 定稿走 JSON

定稿第一步（2026-10-25 起）要模型按八个小标题写自然语言，转写模型照抄成 JSON：细纲的七个字段（梗概 / 出场人物 / 时间地点 / 关键事件 / 看点 / 状态变更 / 连续性事实；叙事线二期删了「新增伏笔」——伏笔由定稿第三步认进叙事线）与「设定」，其中 `出场人物: [{name, aliases}]`、`连续性事实: [...]`。`parseSummaryResponse` 解析成 `SummaryData`。落盘是 `Workspace.finalizePlot`，写回同一份细纲，仍是 Markdown（作者要翻、要手改）：结构化的出场人物额外写进 frontmatter 的 `cast`；连续性事实挂上证据之后写成最后一节（`- 陈述 〔证据：「原文」〕`，格式在 [../model/continuity.ts](../model/continuity.ts)）。

解析分**两层**，两层都不中就什么都不收——能解析的一定要解析出来（解析失败意味着这一章的连续性事实与出场人物进不了上下文），解析不了的一个字都不写：

1. **JSON**：字段缺失、类型不对（字符串/数组混用）都逐字段兜住，不整体作废；多出来的尾逗号（模型最常见的语法错）先自己去掉再解析一次（`parse.ts` 的 `stripTrailingCommas`）。判据是「梗概或关键事件至少有一个非空」——模型偶尔吐出语法合法但不相干的 JSON，认下来会得到一份空细纲，比解析失败更糟。
2. **Markdown 小节**：模型忽略 JSON 要求、照着细纲的样子写回来时走这条。

从前还有第三层「全文进梗概」。定稿写回的就是这一章的细纲，那一层等于拿一段没解析开的原文换掉作者的计划、还记上 `sourceHash` 让这一章看起来已经定稿（真实模型试跑撞上过：尾逗号让 JSON 解析失败，整段 JSON 进了梗概）。所以两层都不中就报失败、挂红，细纲一个字不动。

只有第 1 条有结构化 `cast`，第 2 条从「出场人物」小节的文本反解（见 [../model/castParse.ts](../model/castParse.ts) 的 `castFromText`）。

## 两条角色流程的分工

| | `characters.ts` · 提取角色 | `characterCard.ts` · 更新角色卡 |
|---|---|---|
| 面向 | 「刚写完几章，把新出现的人补上」 | 「这个人出场三十章了，把他的档案重新过一遍」 |
| 作用对象 | 一批章里的**所有**角色 | **一个**角色（另有按卡并发的批量版） |
| 章从哪来 | 作者手输序号列表 | 出场索引（定稿过的细纲）自动给出该角色的出场章 |
| 上下文 | 一次装完（超预算就截断并 warn） | 按预算分批，逐批精炼同一张卡 |
| 入口 | 「角色」分组右键「提取/更新角色卡（挑几章正文）…」 | 角色行右键；角色分组右键的批量更新；「未建卡」分组右键的「全部建卡」 |

`characterCard.ts` 的三条关键设计：

- **自动关联出场章**：来自 [../views/cast.ts](../views/cast.ts) 的索引，作者不必再手输章号。
- **分批时先说要调几次**：主角可能出现在几十章里，一次装不下就切批。动手前的确认框里必须写明「分 N 批」与预计调用次数（2026-10-25 起每批写 1 次、转写 1 次）——这是「不偷偷烧 token」在本层的落法。后一批看得到前一批的产出，逐批精炼而非各写各的。
- **提示词是为「控篇幅」写的**：同一个角色会被反复调用，每批都往上堆的话角色卡会膨胀成一篇论文，而它每次续写都要注入上下文。所以每一节都给了硬性字数上限，并明确「性格 / 语言习惯」优先（它们决定模型能不能把人写像），外貌与人物关系从简；「暗设」（读者还不知道的事，原「未收伏笔」，≤120 字）只做减法——正文里已经揭开的拿掉、写进相应的节，没揭开的一字不改，看不出来的秘密不编。

## 关键设计

- **回调而非返回**：生成类操作通过 `GenerateHandlers`（onDelta / onDone / onError / onCancelled）汇报进度，UI 层决定怎么展示流式内容。
- **长任务走 `runTask`，不直调 `Host.progress`**：本层除创作页的单次生成（它在对话页有流式气泡）以外的批量活一律经 [../runtime/progress.ts](../runtime/progress.ts)。`report({ message, current, total })` 里的 `total` 决定网页上画不画进度条——同步过期细纲是 `stale.length`，重建全文大纲是「批数 + 合并那一步」，角色/文风是固定三步/两步，设定生成是「逐章扫描 + 设定整合 + 写入/审阅」，流水线批量是待处理的章数（补齐架构是缺的件数）。
- **一次改很多份的批量动作，动手之前先存一个存档点**（[checkpoint.ts](checkpoint.ts) 的 `checkpointBefore`，设计见 [docs/design/plans/2026-10-20-checkpoints.md](../../../docs/design/plans/2026-10-20-checkpoints.md)「自动存档点」）：十一处——批量写章（含写完即定稿）、补齐架构、批量拆细纲（`pipelineBatch.ts`）、全书替换（`bookReplace.ts`）、按目录整理设定与批量展开设定（`lore.ts`）、导入原稿、从已写正文补齐、立即同步（`summarize.ts`）、从正文补记叙事线（`threadsBackfill.ts`；补齐里接上的那一段算在补齐那一个里，不另存）、补推 / 重推故事时间（`timelineBackfill.ts`）——作者点了「开始」之后、第一次写盘之前各调一次，整本书退得回这一次之前。位置是 `runTask` 回调的开头（确认框取消、「没有可用的模型」直接返回的都不留一个没用的点）；按目录整理在作者点了「照这样整理」之后、搬之前；全书替换在逐份写之前、有要换的才存。钩子在本层，外部 agent 经 MCP 调同一个批量功能也一样先存。批量写章「边写边拆」走的是 `runPlotBatch`、从已写正文补齐的细纲那一步存过之后其余几样，都不另存；其余与最近一个一模一样时也不另存。**绝不抛、不挡**：存不下只记一条 warn，批量动作照常跑（第 1 条；每份文件覆盖之前的历史版本照存）。
- **无先后依赖的条目并发跑**：各章照正文更新细纲之间、角色卡之间、全文大纲的各阶段批次之间都没有依赖，一律经 [../runtime/concurrency.ts](../runtime/concurrency.ts) 的 `runPool`（并发量取 `config.concurrency`）。**有依赖的绝不并发**——同一张角色卡内部的分批必须串行，后一批要看到前一批的产出；全文大纲的 reduce 合并要等全部 map 到齐。并发下 `current` 只在项结束时 +1，`message` 报「已完成 n/N + 正在跑哪几项」。
- **模型经 `llm/pool.ts` 取，并且要报出档位**：建池时必须传 `task`（如 `createModelPool({ task: 'plotSummary' })`），这样才有分档、「同档失败随机换模型」与并发轮转。唯一的例外是创作页的单次生成（[../generation/generate.ts](../generation/README.md)）与设置页的连接测试（`creation.ts`），两者都必须用用户选定的那个模型。同一个功能里难度不同的阶段要**各建一个池**——`rebuildGlobalSummary` 的分批汇总（`globalSummaryStage`）与最终合并（`globalSummaryMerge`）、`generateLore` 的逐章识别（`loreScan`）与条目整合（`loreSynthesis`）都是两档，串行时也不能图省事复用同一个池（那会把后一阶段悄悄降级到前一阶段的档）。流水线批量同理：`plotOutline`（均衡）与 `manuscript`（均衡）各建各的池；批量写章的「写完即定稿」再为定稿的两步各建一个（`plotSummary`、`characterCard`）。
- **切批与预算用 `pool.primaryBudget`，不用 `config.contextWindow`**：后者是对话页选定模型的窗口，分档后与干活的模型无关。确认框之前就要算的批数/片段数（它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`，它不构造 provider，不会在用户点确认前弹 Key 输入框。
- **确认框里的「模型」一行走 `describeTaskModels(config, task)`**：档位、实际清单、会不会换人、是不是继承默认模型，四件事一次说清。**不要再打印 `config.models`**——弹窗写着一个模型、实际跑另一个，是「不偷偷烧 token」的反面。
- **每一步都留痕**：批量任务逐项打一条 `info`（含刚完成的项、用时、平均速度、预计剩余），失败项打 `error`；可以并发的（同步细纲、角色卡批量）**继续跑完剩下的**、结束时汇总说明哪几项失败，流水线那三条就此停下并说清停在哪。日志里绝不出现 API Key（`logger.redact` 统一处理），也不记 prompt 全文。
- **模型输出清洗**：LLM 常把正文包在 code fence 里或加上「好的，以下是续写」之类的前言，写入前统一剥掉（`stripCodeFence` 等）。
- **人工确认优先**：凡是覆盖作者可能手改过的文件（角色卡、style.md），一律先经宿主审阅/弹窗确认。批量更新时分析是并发的，但审阅经 `concurrency.ts` 的 `serialize()` 排队——同时弹三个 diff，用户根本不知道自己在看谁。作者点了采纳（或在批量确认框里选了「全部直接采纳」）之后经 `workspace.write` 写回原文件（`review: false`：不问第二次），覆盖之前旧内容照样进历史版本（第 7 条：写盘经网关）。
- **超预算截断必须打 `warn`**：单章正文、角色提取的语料、文风样文、阶段摘要合并这四处都会按输入预算 `takeHead`。截断本身是对的，但作者选了五章却只读进两章半时必须说出来——这是「不静默截断」在本层的落法。
- **交互全走 Host**：弹窗、进度、文件打开都经 `host.ts` 窄接口，本层零 `vscode` 依赖。
- **定稿与全文大纲温度 0.3**：要稳定、可复现，不用用户设的创作温度。

## 依赖关系

依赖 `model/`、`context/`、`llm/`、`host.ts`。被 `vscode/extension.ts`（命令）与 `core/controller/`（对话面板）调用；插件命令面板与独立版网页共用同一批流程。
