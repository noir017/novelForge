# views — 只读聚合与界面快照

本目录把磁盘上的 Markdown 与工程状态聚合成上层界面需要的只读数据，**不写盘**：

- `projectView.ts`：工程树（「故事架构」五行、章节列表——**一个章号一行**，细纲与正文是同一行的两面；角色/设定是目录树；叙事线那一行的计数，七期）、细纲浮窗（`buildPlotSummaryView`：没定稿的标「计划」，定稿后正文又改过的标过期）与单章流水线视图；章的说法（「第 12 章《夜访》」）由这一层给，前端只渲染。
- `pipeline.ts`：读取大纲、配置、细纲与章节，**按章号合并**（细纲号 = 章号；认号只在 `chapterOfPlotNo` 里做一次），汇总每一章的流水线状态与新鲜度链；给全书状态机取数（`buildBookFacts`，主按钮、工程页、agent 三处共用）；算正文的落点（`chapterTargetOf`）；
- `workbench.ts`：读取当前创作目标，构造「当前产物」浮窗的内容；
- `cast.ts`：从各章**定稿过的**细纲（有 `sourceHash`）反向聚合出场人物索引（第 14 条）。没定稿的细纲里写的是计划出场，不算。

新鲜度链：`outline.md` 里覆盖第 N 章那一节 →（`upstreamHash`）`summaries/N.md` →
（`writtenFrom`，记在细纲上，定稿时刷新）`chapters/N` →（`sourceHash`，定稿时记）同一份
`summaries/N.md`，全靠比对 hash，零模型调用。细纲内容与 `writtenFrom` 对不上，正文挂 ⟳
（包括定稿之后又改细纲）；`sourceHash` 与正文对不上，这一章回到待定稿。

`chapters/` 是正文的**唯一真相**：`deriveStage` 先看这一章有没有字，有字就不再退回
「写细纲」。所以只有 `chapters/`、一份细纲都没有的老工程，每一章是「待定稿」或
「已完成」，不会被倒回去要求补细纲；它们缺的是架构，全书状态机会先推那一格。

`pipeline.ts` 是 I/O 聚合器；[`../model/pipeline.ts`](../model/pipeline.ts) 仍是零 I/O、零 import
的纯领域模型和状态机。不要把后者迁入 `views/`，也不要在 `views/pipeline.ts` 里复制状态判断。

## 一行同时代表一章的两面

`buildPipelineIndex` 返回的是 `Map<章号, PlotPipeline>`：细纲（`summaries/` 根下）与成品（`chapters/`）
各扫一遍，按**章号**合进同一条。两边都可能缺席——只有细纲是「还没写完的章」，只有成品是
「老工程里已经写好的章」，都有是正常情况。章号是两侧唯一共同的身份，所以索引按它建。

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
