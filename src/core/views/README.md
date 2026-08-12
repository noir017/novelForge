# views — 只读聚合与界面快照

本目录把磁盘上的 Markdown 与工程状态聚合成上层界面需要的只读数据，**不写盘**：

- `projectView.ts`：工程树、章节摘要浮窗与章节流水线视图；
- `pipeline.ts`：读取大纲、细纲、场景、正文与摘要，汇总章节流水线状态；
- `workbench.ts`：读取当前创作目标，构造「当前产物」浮窗的内容；
- `cast.ts`：从章节摘要反向聚合出场人物索引。

`pipeline.ts` 是 I/O 聚合器；[`../model/pipeline.ts`](../model/pipeline.ts) 仍是零 I/O、零 import
的纯领域模型和状态机。不要把后者迁入 `views/`，也不要在 `views/pipeline.ts` 里复制状态判断。
