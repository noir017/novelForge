# views — 只读聚合与界面快照

本目录把磁盘上的 Markdown 与工程状态聚合成上层界面需要的只读数据，**不写盘**：

- `projectView.ts`：工程树（剧情组带流水线状态，章节组是纯文件列表）、单段摘要浮窗与剧情段流水线视图；
- `pipeline.ts`：读取大纲、剧情、场景、正文与摘要，汇总剧情段的流水线状态与新鲜度链；
- `summaryIndex.ts`：全书摘要读一次，摊给上面三个都要它的取数方；
- `workbench.ts`：读取当前创作目标，构造「当前产物」浮窗的内容；
- `cast.ts`：从段落摘要反向聚合出场人物索引。

新鲜度链：`outline.md` → `plots/*.md` → `scenes/<段名>/*.md` → `manuscripts/<段名>.md` → `summaries/<段名>.md`，
全靠比对 hash，零模型调用。`chapters/` **不在这条链上**——它是作者切好的发布区，工具不分析它的内容。

`pipeline.ts` 是 I/O 聚合器；[`../model/pipeline.ts`](../model/pipeline.ts) 仍是零 I/O、零 import
的纯领域模型和状态机。不要把后者迁入 `views/`，也不要在 `views/pipeline.ts` 里复制状态判断。

## 读盘只读一次

工程树、流水线状态、出场索引要的是**同一批文件**，而 `buildProjectTree` 由文件监听触发
（两个壳各去抖 250ms）——**作者每存一次盘就跑一次**。三处各读各的，一次刷新就把每段的
摘要读三遍、场景读两遍、段文件自己也读两遍。

所以这里的规矩是：**同一次刷新里，一个文件只读一次**。批量入口
（`buildPipelineIndex`）负责把大纲、manifest 与全书摘要读出来，经 `context` 参数往下摊；
单段入口不传就自己读，行为不变。段列表本身则由 `NovelProject.listPlots()` 自己缓存
（与 `listChapters()` 同构，含在途 promise 与世代号）。新增取数方时接着摊这一份，不要再开
一条读盘路径——`tests/integration/views/projectTreeReads.test.js` 会把重复读盘的文件名打出来。

