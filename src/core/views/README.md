# views — 只读聚合与界面快照

本目录把磁盘上的 Markdown 与工程状态聚合成上层界面需要的只读数据，**不写盘**：

- `projectView.ts`：工程树（**卷**那一组、章节列表——已发布的章在前、还没交付的剧情段在后，角色/设定是目录树）、摘要浮窗与单段流水线视图；两种章节行的说法（「第 12 章《夜访》」/「剧情 4《楼道》」）都由这一层给，前端只渲染。
- `pipeline.ts`：读取大纲、卷纲、细纲、中转站正文、发布章节与摘要，**两条轴各遍历一遍**（不再按号合并），汇总每个剧情段的流水线状态、界面位次与新鲜度链；
- `summaryIndex.ts`：全书摘要读一次，摊给上面三个都要它的取数方；
- `workbench.ts`：读取当前创作目标，构造「当前产物」浮窗的内容；
- `cast.ts`：从各章摘要反向聚合出场人物索引。

新鲜度链：`outline.md` → `volumes/*.md` → `plots/**/*.md` → `manuscripts/<段镜像键>.md`
→（**拆分**）→ `chapters/*.md` → `summaries/*.md`，全靠比对 hash，零模型调用。

`chapters/` 是这条链的**终点，也是唯一真相**：`buildPlotPipeline` 先看这一章有没有成品，
有就短路整条生产链（`deriveStage` 里 `chapterExists` 排在最前）。所以只有 `chapters/`、
一份细纲都没有的老工程，每一章天生就是「已完成」，不需要任何迁移。

`pipeline.ts` 是 I/O 聚合器；[`../model/pipeline.ts`](../model/pipeline.ts) 仍是零 I/O、零 import
的纯领域模型和状态机。不要把后者迁入 `views/`，也不要在 `views/pipeline.ts` 里复制状态判断。

## 一行同时代表一章的两面

`buildPipelineIndex` 返回的是 `Map<章号, PlotPipeline>`：细纲（`plots/`）与成品（`chapters/`）
各扫一遍，按**章号**合进同一条。两边都可能缺席——只有细纲是「还没写完的章」，只有成品是
「老工程里已经写好的章」，都有是正常情况。章号是两侧唯一共同的身份，所以索引按它建。

## 读盘只读一次

工程树、流水线状态、出场索引要的是**同一批文件**，而 `buildProjectTree` 由文件监听触发
（两个壳各去抖 250ms）——**作者每存一次盘就跑一次**。三处各读各的，一次刷新就把每一章的
摘要读三遍、细纲自己也读两遍。

所以这里的规矩是：**同一次刷新里，一个文件只读一次**。批量入口
（`buildPipelineIndex`）负责把大纲、manifest 与全书摘要读出来，经 `context` 参数往下摊；
单章入口不传就自己读，行为不变。两份列表本身则由 `NovelProject.listPlots()` /
`listChapters()` 各自缓存（同构，含在途 promise 与世代号）。新增取数方时接着摊这一份，
不要再开一条读盘路径——`tests/integration/views/projectTreeReads.test.js` 会把重复读盘的
文件名打出来。
