# core/features — 功能编排

面向用户动作的编排层：每个文件对应一类「点一下发生什么」。负责组合数据层（model）、装配器（context）与模型层（llm），并把结果以回调形式交回宿主，不直接操作 UI。

## 文件

| 文件 | 职责 |
|---|---|
| [creation.ts](creation.ts) | 设置页的连接测试（`testConnection`——严格用指定的那个模型，不走分档池）+ 两个纯文本工具：`cleanOutput`（**只对正文层用**，在 JSON 产物上跑会切坏结构）与 `suggestTitle`。从前的 `CreationSession` 类没了，四件事各自搬了家，见下表。 |
| [artifact.ts](artifact.ts) | ★ 模型输出 → 可采纳的结构化产物。三层降级（JSON → Markdown 小节 → 全文兜底），与摘要同一套；**细纲给了区间就是一批**，按批次合同严格解码、不做全文兜底。**只解析，一个字都不写盘。** |
| [blueprint.ts](blueprint.ts) | 细纲批次（章节蓝图）的严格解码：缺必填字段给出带路径的诊断，超长截断不作废，新角色必须逐字出现在出场名单里；覆盖检查（漏章 / 重复 / 越界）。合同移植自 AI-Novel-Writer。 |
| [roster.ts](roster.ts) | 角色图谱两段式的解码：身份清单 → 按冻结清单补详情 → 拼成角色卡，「人物关系」由清单生成到双方卡上。比上游宽松：只有一个能用的人都没有才算失败。 |
| [novelConfig.ts](novelConfig.ts) | 小说配置的 JSON 合同：上游英文键 → `config.md` 七节与 frontmatter，「全局要求」4–8 条 600 字的质检，一句话弹窗时「保留原文，追加生成」的合并，规范化草稿（`config.md` 全文 + 一节文风）。 |
| [structuredJson.ts](structuredJson.ts) | 结构化输出的 JSON 小工具：认出「语法坏了但值得修」的输出；校验修过的那份只改了标点（标量逐个一致，只许在末尾补闭合括号）；「唯一一个完整对象」。 |
| [parse.ts](parse.ts) | 模型输出解析小工具：剥代码围栏、提取 JSON、字符串与数字去重、字符串数组归一。 |
| [pipelineBatch.ts](pipelineBatch.ts) | ★ 工程页的三条批量动作，**都严格串行、一件失败就停**：**补齐设定**（配置 → 前提 → 角色图谱 → 世界观，只补空白）、**批量拆细纲**（区间里没有细纲的章每批 5 章走生成链）、**批量写章**（四期，D10：区间里还没有正文的章一章一章写，续写链与重演检测与对话页同一份，一章之内续写那几轮钉住同一个模型；「写完即定稿」模式写一章定稿一章；重演命中、后面几章才登场的人提前写了进来（五期补遗 §1.2）或没写够八成的照样落盘、不定稿、挂黄 ❗ 并停下；「写完即审稿」（五期补遗 §4）写 → 审 → 定稿，审稿走与对话页同一条链与 `review` 档，报告一章一轮放进新会话「批量审稿 · 第 a–b 章」，审出问题、审稿失败都不停，完成提示的按钮打开那个会话；能「写完这一章就停」；切分与调用上限走 `planWriteBatch`；五期起开跑之前做一致性预检、有问题先问一句「仅本次忽略」，跑的中途新冒出来的停在那一章前面、挂黄 ❗；细纲里记过永久放行的不算）。**只补不改**，失败挂在那一行上，返回实际调用次数。 |
| [finalize.ts](finalize.ts) | ★ 定稿一章（四期，D17）：摘要（1 次，带连续性事实与证据）→ 出场角色的当前状态（0–1 次）。摘要失败整个定稿失败；角色状态失败摘要照样算数，黄 ❗ 挂在章节上。`finalizeChapterTask` 是单章入口的外壳（主按钮、工作台、工程页右键、VS Code「定稿这一章」共用）；批量入口两步各走各的档。 |
| [preflight.ts](preflight.ts) | 一致性预检的取数（五期）：本章细纲排了谁、他们卡上的「当前状态」（判断在 `model/preflight.ts`）。零调用。两个入口：对话页写第 N 章之前（controller 亮一张卡，可以「仅本次忽略」，或填一句理由「记为刻意安排」——记进这一章细纲的 `preflightOk`，五期补遗 §2）与批量写章。细纲里记过永久放行的那几处在这里分出去（`PreflightResult.exempted`），两个入口都只为剩下的停。 |
| [characterState.ts](characterState.ts) | 定稿时更新本章出场角色的「当前状态」（D15，移植 `update_character_cards`）：按本章摘要的出场人物认卡、一次调用出所有人的；归机器的卡只换那一节并盖章（`model/characterState.ts`），作者改过的不写、挂黄 ❗；`reviewCharacterState` 是那张卡右键「对比第 N 章给出的状态…」。 |
| [summarize.ts](summarize.ts) | 单章摘要编排（从 `chapters/` 的正文生成；解析、批量同步、全书 map-reduce）。摘要里的「连续性事实」在这里挂证据：模型只给陈述，证据句用 bigram 在整章正文里找（`model/continuity.ts`，零调用），找不到依据的丢掉并记日志。「同步所有过期摘要」只补摘要，不更新角色状态（那是定稿的事）。系统提示词在 [summarizePrompt.ts](summarizePrompt.ts)。 |
| [summarizePrompt.ts](summarizePrompt.ts) | 单章摘要 / 阶段摘要 / 全书摘要三条系统提示。 |
| [characters.ts](characters.ts) | 从选定的几段正文**批量**提取/更新角色卡。系统提示词在 [charactersPrompt.ts](charactersPrompt.ts)。 |
| [charactersPrompt.ts](charactersPrompt.ts) | 批量提取角色卡的系统提示。 |
| [lore.ts](lore.ts) | 从全书正文自动生成设定。系统提示词在 [lorePrompt.ts](lorePrompt.ts)。 |
| [lorePrompt.ts](lorePrompt.ts) | 逐段识别与条目整合两条系统提示。 |
| [characterCard.ts](characterCard.ts) | ★ **单个角色**的档案更新编排。解析见 [characterCardParse.ts](characterCardParse.ts)，控篇幅提示词见 [characterCardPrompt.ts](characterCardPrompt.ts)。 |
| [characterCardParse.ts](characterCardParse.ts) | 角色卡更新的 JSON 解析（`parseCardResponse`）。 |
| [characterCardPrompt.ts](characterCardPrompt.ts) | 更新角色卡的系统提示（字数上限与「性格 / 语言习惯」优先）；定稿时更新当前状态的系统提示（`STATE_SYSTEM`）。 |
| [characterMaintenance.ts](characterMaintenance.ts) | ★ 两条**不调模型**的整理动作：`cleanCharacterAliases` 删掉不是专属称呼的别名（含被误填成别名的**其他角色的名字**），`mergeDuplicateCharacterCards` 把同一个人的多张卡并成一张。只改 frontmatter（`rewriteFrontmatter`），作者手写的正文一个字节不动；被合并的卡搬进 `.novelforge/.trash/`。 |
| [style.ts](style.ts) | 从 1~3 章样章归纳文风指南写入 `.novelforge/style.md`。系统提示词在 [stylePrompt.ts](stylePrompt.ts)。 |
| [stylePrompt.ts](stylePrompt.ts) | 文风提取的系统提示。并入了 AI-Novel-Writer 文风分析模板的任务边界：只学技法，不复述情节、角色名、地名，不抄原句。 |
| [pickPlots.ts](pickPlots.ts) | 多章选择：Host.pick 只支持单选，需要选几章时改为输入章号列表（如 `1,2,3`）。 |

## 创作的四层与两条路

创作按 `Stage × Capability × Target` 展开（定义在 [../model/pipeline.ts](../model/pipeline.ts)）：架构 → 大纲 → 细纲 → 正文。同一层可以被讨论（默认动作，挑刺、检查设定都靠直接打字说），也可以被生成；细纲层另有一个 `settle`（落定细纲），把刚才那段讨论里**已经达成的结论**沉淀成细纲。改写不是独立能力：目标已有内容时的生成就是改写，作者那句话就是修改意见。从前还有 `split`（大纲拆卷、卷拆剧情段）与拆章，卷那一层删掉之后都没了。

**创作编排本身已经不在本层了**——它是 [../generation/](../generation/README.md)：`generate.ts` 无状态地装配 → 调模型 → （需要时接 `structured.ts` 的生成链）→ 解析成 `Draft`，`accept.ts` 按产物分派到六条落盘路径，`drafts.ts` 让草稿活过一次刷新。并发控制在 `controller/`（那是调度的责任）。本层留下的是 `artifact.ts`（解析）与 `pipelineBatch.ts`（工程页批量）。

**生成与落盘是两步**，这是这条路上最要紧的一条：

1. `generate()` 只把文本交回调用方，**一个字都不写盘**，产出一份带 `artifact` 的 `Draft`；
2. `acceptArtifact()` 才写，且只在用户在那张落盘卡片上点了「写入」之后（`controller/chat.ts` 的 `askArtifact`，产出的当下就问）——**落盘时拿气泡里当下的文本重新解析**（用户可能改过），`draft.artifact` 只是生成那一刻的展示快照。

中间那一步是用户看着产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。

`generation/`（创作页，一次一份）与 `pipelineBatch.ts`（工程页，一次几十份）的失败模型完全不同，所以是两条路：

| | `generation/` | `pipelineBatch.ts` |
|---|---|---|
| 一次处理 | 一份产物 | 几十章 |
| 覆盖已有产物 | 走 `reviewReplace` 逐份审阅 | **一律跳过**——一次弹 63 个 diff 没人看得完。补齐设定连一节都不覆盖：作者写过的节原样留着（`onlyBlank`） |
| 解析失败 | 单份文档全文兜底（产物摊在屏幕上，用户看得见它是什么）；细纲批次不兜底 | **不兜底**——没人逐份过目，兜底会把「这次失败了」变成「这一章已排好」，紧接着的批量写章还会照着它写出一整章 |
| 出错 | 报错，用户重来 | 记进 errorLog 挂在那一行上，**就此停下**——后一件、后一批、后一章要吃前面的产出 |
| 写出来但有问题（重演、没写够） | 卡片上标出来，作者当场判断 | 照样落盘（钱已经花了，D6），不定稿，黄 ❗ 挂在那一章上，**停下**——接着往下写等于踩着一个有问题的结尾 |

两条路共用同一个 `buildContext` 与同两条生成链（`generation/structured.ts`、`generation/continuation.ts`），因此批量与单次产出的是同一个质量、同一套降级与续写。

## 摘要走 JSON

单章摘要的提示词要求模型输出 JSON（六个小节 + `出场人物: [{name, aliases}]` + `连续性事实: [...]`），`parseSummaryResponse` 解析成 `SummaryData`。落盘仍是 Markdown（作者要翻、要手改），结构化的出场人物额外写进 frontmatter 的 `cast`；连续性事实挂上证据之后写成第七节（`- 陈述 〔证据：「原文」〕`，格式在 [../model/continuity.ts](../model/continuity.ts)）。

解析是**三层降级**，一层都不能少——模型不听话是常态，而解析失败意味着这一章的剧情永远进不了上下文：

1. **JSON**：字段缺失、类型不对（字符串/数组混用）都逐字段兜住，不整体作废。判据是「梗概或关键事件至少有一个非空」——模型偶尔吐出语法合法但不相干的 JSON，认下来会得到一份空摘要且不再降级，比解析失败更糟。
2. **Markdown 小节**：0.2.x 之前的格式、模型忽略 JSON 要求、作者手改过的文件都走这条。
3. **全文进梗概**：信息密度低，但比丢掉整段强。

只有第 1 条有结构化 `cast`，后两条从「出场人物」小节的文本反解（见 [../model/castParse.ts](../model/castParse.ts) 的 `castFromText`）。

## 两条角色流程的分工

| | `characters.ts` · 提取角色 | `characterCard.ts` · 更新角色卡 |
|---|---|---|
| 面向 | 「刚写完几章，把新出现的人补上」 | 「这个人出场三十章了，把他的档案重新过一遍」 |
| 作用对象 | 一批章里的**所有**角色 | **一个**角色（另有按卡并发的批量版） |
| 章从哪来 | 作者手输序号列表 | 摘要索引自动给出该角色的出场章 |
| 上下文 | 一次装完（超预算就截断并 warn） | 按预算分批，逐批精炼同一张卡 |
| 入口 | 工具栏「提取/更新角色卡」 | 角色行右键；角色分组右键的批量更新；「未建卡」分组右键的「全部建卡」 |

`characterCard.ts` 的三条关键设计：

- **自动关联出场章**：来自 [../views/cast.ts](../views/cast.ts) 的索引，作者不必再手输章号。
- **分批时先说要调几次**：主角可能出现在几十章里，一次装不下就切批。动手前的确认框里必须写明「分 N 批，预计调用模型 N 次」——这是「不偷偷烧 token」在本层的落法。后一批看得到前一批的产出，逐批精炼而非各写各的。
- **提示词是为「控篇幅」写的**：同一个角色会被反复调用，每批都往上堆的话角色卡会膨胀成一篇论文，而它每次续写都要注入上下文。所以每一节都给了硬性字数上限，并明确「性格 / 语言习惯」优先（它们决定模型能不能把人写像），外貌与人物关系从简；「未收伏笔」要做减法。

## 关键设计

- **回调而非返回**：生成类操作通过 `GenerateHandlers`（onDelta / onDone / onError / onCancelled）汇报进度，UI 层决定怎么展示流式内容。
- **长任务走 `runTask`，不直调 `Host.progress`**：本层除创作页的单次生成（它在对话页有流式气泡）以外的批量活一律经 [../runtime/progress.ts](../runtime/progress.ts)。`report({ message, current, total })` 里的 `total` 决定网页上画不画进度条——摘要同步是 `stale.length`，重建全书摘要是「批数 + 合并那一步」，角色/文风是固定三步/两步，设定生成是「逐章扫描 + 设定整合 + 写入/审阅」，流水线批量是待处理的章数（补齐设定是缺的件数）。
- **无先后依赖的条目并发跑**：各章摘要之间、角色卡之间、全书摘要的各阶段批次之间都没有依赖，一律经 [../runtime/concurrency.ts](../runtime/concurrency.ts) 的 `runPool`（并发量取 `config.concurrency`）。**有依赖的绝不并发**——同一张角色卡内部的分批必须串行，后一批要看到前一批的产出；全书摘要的 reduce 合并要等全部 map 到齐。并发下 `current` 只在项结束时 +1，`message` 报「已完成 n/N + 正在跑哪几项」。
- **模型经 `llm/pool.ts` 取，并且要报出档位**：建池时必须传 `task`（如 `createModelPool({ task: 'plotSummary' })`），这样才有分档、「同档失败随机换模型」与并发轮转。唯一的例外是创作页的单次生成（[../generation/generate.ts](../generation/README.md)）与设置页的连接测试（`creation.ts`），两者都必须用用户选定的那个模型。同一个功能里难度不同的阶段要**各建一个池**——`rebuildGlobalSummary` 的分批汇总（`globalSummaryStage`）与最终合并（`globalSummaryMerge`）、`generateLore` 的逐章识别（`loreScan`）与条目整合（`loreSynthesis`）都是两档，串行时也不能图省事复用同一个池（那会把后一阶段悄悄降级到前一阶段的档）。流水线批量同理：`plotOutline`（均衡）与 `manuscript`（均衡）各建各的池；批量写章的「写完即定稿」再为定稿的两步各建一个（`plotSummary`、`characterCard`）。
- **切批与预算用 `pool.primaryBudget`，不用 `config.contextWindow`**：后者是对话页选定模型的窗口，分档后与干活的模型无关。确认框之前就要算的批数/片段数（它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`，它不构造 provider，不会在用户点确认前弹 Key 输入框。
- **确认框里的「模型」一行走 `describeTaskModels(config, task)`**：档位、实际清单、会不会换人、是不是继承默认模型，四件事一次说清。**不要再打印 `config.models`**——弹窗写着一个模型、实际跑另一个，是「不偷偷烧 token」的反面。
- **每一步都留痕**：批量任务逐项打一条 `info`（含刚完成的项、用时、平均速度、预计剩余），失败项打 `error`；可以并发的（摘要同步、角色卡批量）**继续跑完剩下的**、结束时汇总说明哪几项失败，流水线那三条就此停下并说清停在哪。日志里绝不出现 API Key（`logger.redact` 统一处理），也不记 prompt 全文。
- **模型输出清洗**：LLM 常把正文包在 code fence 里或加上「好的，以下是续写」之类的前言，写入前统一剥掉（`stripCodeFence` 等）。
- **人工确认优先**：凡是覆盖作者可能手改过的文件（角色卡、style.md），一律先经宿主审阅/弹窗确认。批量更新时分析是并发的，但审阅经 `concurrency.ts` 的 `serialize()` 排队——同时弹三个 diff，用户根本不知道自己在看谁。
- **超预算截断必须打 `warn`**：单章正文、角色提取的语料、文风样文、阶段摘要合并这四处都会按输入预算 `takeHead`。截断本身是对的，但作者选了五章却只读进两章半时必须说出来——这是「不静默截断」在本层的落法。
- **交互全走 Host**：弹窗、进度、文件打开都经 `host.ts` 窄接口，本层零 `vscode` 依赖。
- **摘要温度 0.3**：摘要要稳定、可复现，不用用户设的创作温度。

## 依赖关系

依赖 `model/`、`context/`、`llm/`、`host.ts`。被 `vscode/extension.ts`（命令）与 `core/controller/`（对话面板）调用；插件命令面板与独立版网页共用同一批流程。
