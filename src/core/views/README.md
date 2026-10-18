# views — 只读聚合与界面快照

本目录把磁盘上的 Markdown 与工程状态聚合成上层界面需要的只读数据，**不写盘**：

- `projectView.ts`：工程树（「故事架构」六行、章节列表——**一个章号一行**，细纲与正文是同一行的两面；角色/设定是目录树；叙事线那一行的计数，七期）、细纲浮窗（`buildPlotSummaryView`：没定稿的标「计划」，定稿后正文又改过的标过期）与单章流水线视图；章的说法（「第 12 章《夜访》」）由这一层给，前端只渲染。
- `pipeline.ts`：读取大纲、配置、细纲与章节，**一个章号一行**（正文按章号认，细纲**按路径配对**：正文镜像的那一份，还没有正文的按号认计划，规则在 `NovelProject.plotFor`），汇总每一章的流水线状态与新鲜度链；给全书状态机取数（`buildBookFacts`，主按钮、工程页、agent 三处共用）；算正文的落点（`chapterTargetOf`：已有正文就是它，否则落在细纲所在的子目录，连细纲都没有就跟上一章同一个子目录）；
- `workbench.ts`：读取当前创作目标，构造「当前产物」浮窗的内容；
- `cast.ts`：从各章**定稿过的**细纲（有 `sourceHash`）反向聚合出场人物索引（第 14 条）。没定稿的细纲里写的是计划出场，不算。
- `quickOpen.ts`：「转到…」（独立版 Ctrl+P）要的索引——章节（一个章号一条：章号、标题、卷目录、正文 / 细纲路径、字数）、角色卡（名字与别名）、设定、架构几件与大纲 / 文风 / 叙事线 / 全书摘要（有文件的；称呼与 `editorLabel.ts` 共用 `SETTING_DOC_LABEL` / `FIXED_DOC_LABEL`）、草稿。按需要（`requestQuickOpen`），不进工程树；章节与细纲借 `listChapters()` / `listPlots()` 的缓存，不为它多读一章（读了哪些盘写在文件头上）。
- `chapterIndex.ts`：内置编辑器的章节索引（`chapterIndex` 消息：章节条与上一章 / 下一章要的那几个字段）。与工程树章节那一行**同一个函数投影**（`projectView.ts` 在它上面再加定稿、草稿、⟳），数据是 controller 构建 `ViewState` 时本来就跑的那一趟流水线索引，不多读盘；controller 只在内容变了时推。
- `checkTerms.ts`：内置编辑器「写作体检」的词表（`checkTerms` 消息）：禁用词（`readBannedTerms`——`style.md` 的「禁用词表」、小说配置「全局要求」、`config.md` 的类型 / 子类型交给 `model/manuscriptCheck.ts` 的 `bannedTerms`；**写正文的 `generation/generate.ts` 的 `planWriting` 也调它**，两边同一个函数、同一份输入）+ 自定义敏感词表（`.novelforge/sensitive.txt`，`model/sensitiveWords.ts` 解析，坏行带行号）。读 `style.md` 与 `sensitive.txt` 各一次，`config.md` 由调用方给（controller 构建 `ViewState` 那一趟已经读过）；读不到当没有、绝不抛。controller 每次 `pushState` 都调、内容变了才推（`controller/check.ts`）。
- `editorLabel.ts`：内置编辑器怎么称呼一份文件（标签上的类型短标记与名字、工具栏面包屑），按 `kindOfPath` 与章节 / 细纲的文件名规则算，纯函数、零 I/O、绝不抛（输入是前端传上来的路径）。标题取文件名里的那一段，不读 H1。固定文件的中文称呼（`FIXED_DOC_LABEL`）与「转到…」的索引共用。
- `lore.ts`：设定名录（2026-10-18）。同一个路子：从定稿过的细纲**第九节「设定」**聚合出已建条目（出现章、水位之后待整合的新事实——第九节冒号后那句与提到它的连续性事实，工程页的 `＋N`）、**未建条目**（出现过、没有条目的名字，按出现章数排，分类取多数票）、**还没记过设定的定稿章**（第九节标题不在的，补记用）。认条目先标题后关键词，人名不算。工程页刷新时由 `projectView.ts` 把已读的细纲、条目、角色卡传进来，同一次刷新里一个文件只读一次；装配器的 `lore` 层也用它算尾巴。

新鲜度链：`outline.md` 里覆盖第 N 章那一节 →（`upstreamHash`）这一章的细纲 →
（`writtenFrom`，记在细纲上，定稿时刷新）`chapters/…/N-标题` →（`sourceHash`，定稿时记）同一份
细纲（`summaries/` 下与正文同样的相对路径），全靠比对 hash，零模型调用。细纲内容与 `writtenFrom` 对不上，正文挂 ⟳
（包括定稿之后又改细纲）；`sourceHash` 与正文对不上，这一章回到待定稿。

`chapters/` 是正文的**唯一真相**：`deriveStage` 先看这一章有没有字，有字就不再退回
「写细纲」。所以只有 `chapters/`、一份细纲都没有的老工程，每一章是「待定稿」或
「已完成」，不会被倒回去要求补细纲；它们缺的是架构，全书状态机会先推那一格。

`pipeline.ts` 是 I/O 聚合器；[`../model/pipeline.ts`](../model/pipeline.ts) 仍是零 I/O、零 import
的纯领域模型和状态机。不要把后者迁入 `views/`，也不要在 `views/pipeline.ts` 里复制状态判断。

## 一行同时代表一章的两面

`buildPipelineIndex` 返回的是 `Map<章号, PlotPipeline>`：细纲（`summaries/` 下，递归）与成品（`chapters/`）
各扫一遍，一个章号一条。两边都可能缺席——只有细纲是「还没写完的章」，只有成品是
「老工程里已经写好的章」，都有是正常情况。行按章号建，但细纲与正文**按路径配对**：有正文的章
只认正文镜像的那份细纲（作者在外面给正文改了名，旧细纲不冒认，这一章就是还没有细纲）；同号的正文
有两份时认路径排序第一份并记 warn。

## 读盘只读一次

工程树、流水线状态、出场索引要的是**同一批文件**，而 `buildProjectTree` 由文件监听触发
（两个壳各去抖 250ms）——**作者每存一次盘就跑一次**。三处各读各的，一次刷新就把每一章的
细纲读好几遍。

所以这里的规矩是：**同一次刷新里，一个文件只读一次**。批量入口
（`buildPipelineIndex`）负责把大纲、配置、manifest 与细纲、章节两份列表读出来，经 `context`
参数与返回值往下摊（出场索引 `buildCastIndex(project, plots)` 直接吃它的细纲列表）；
单章入口不传就自己读，行为不变。两份列表本身则由 `NovelProject.listPlots()` /
`listChapters()` 各自缓存（同构，含在途 promise 与世代号）。新增取数方时接着摊这一份，
不要再开一条读盘路径——`tests/integration/views/projectTreeReads.test.js` 会把重复读盘的
文件名打出来。
