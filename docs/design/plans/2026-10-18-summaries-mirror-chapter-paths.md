# 细纲镜像正文的相对路径（更正 10-17 的平铺）

> 2026-10-18。单独一件，在 main 上直接开发。起因：作者在工程页点分卷里的章节，打不开细纲（也就是摘要）。

## 出了什么事

10-17 合并细纲与摘要（[2026-10-17-merge-plots-into-summaries.md](2026-10-17-merge-plots-into-summaries.md)，8b70948）时，细纲的落点沿用了老 `plots/` 的平铺：`summaries/NNN-标题.md`，只扫 `summaries/` 根下，按章号与正文配对，同时删掉了「摘要按章节路径镜像」的规则（7bf8ada 为修同号章节互相覆盖加的）。这一条写在当时设计要点里，**没有列成 ⚑ 让作者确认**。

后果：分卷的书（`chapters/第一卷/…`）原来的摘要在 `summaries/第一卷/…`，工程页一份都认不出，点章节名只开正文；对话页按 target 路径直接读（`readPlot` / `resolvePlot`），却读得到。两边看到的不是同一个东西。

## 作者定的（2026-10-18）

| # | 问题 | 定案 |
|---|---|---|
| 1 | 细纲放哪 | **镜像正文在章节根下的相对路径**，扩展名换成 `.md`：`chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`。「无相对路径是绝对错的」 |
| 2 | 还没写正文的新一章放哪 | **跟上一章放同一个子目录** |
| 3 | 工程页里给正文改名、移动 | 细纲**跟着走**（和草稿一样） |
| 4 | 合并后定稿在根下多出来的平铺副本 | 不管，不做向后兼容 |

## 规则

- **路径**：`NovelProject.plotPathForChapter`（正文 → 细纲）、`chapterPathForPlot`（细纲 → 照它写出来的正文）、`plotMirrorOf`（文件或整个卷目录的镜像）。正文不在章节根下时退回 `summaries/NNN.md`。
- **扫描与分类**：`listPlots` 递归扫 `summaries/`；`kindOfPath` 把各级子目录里数字开头的 `.md` 判成 `plot`。根下的 `global.md` 仍是全书摘要。`parsePlotFileName` 的前缀位数与章节一致（1–5 位）。
- **配对**（`NovelProject.plotFor`，`getPlot` / `resolvePlot` / 流水线索引 / 装配器共用）：
  - 有正文的章：只认正文镜像的那一份。作者在外面给正文改了名就是一章新的，旧细纲成了孤儿，不冒认。
  - 还没有正文的章：按文件名的章号认（计划）。
  - target 指着孤儿或占位路径时，`resolvePlot` 认这一章现在的那一份——对话页与工程页看到的必须是同一份。
- **新的一章**：既没有正文也没有细纲时，`subdirForNewChapter` 取章号比它小的里面最大的那一章所在的子目录（有正文看正文，只有细纲看细纲），`plotPathForNewChapter` / `plotPathOfNo` 据此给落点；`writePlot` 新建时先认调用方给的占位路径所在的子目录。
- **写正文**：`chapterTargetOf` 把正文落在细纲所在的子目录，文件名沿用细纲的；细纲是还没起名时建的 `030.md` 而标题已经有了，正文按标题起 `030-<标题>.md`，`Workspace.createChapterAt` 把细纲改名到新正文的镜像。
- **写细纲**（`writePlot`）：有正文就落在正文的镜像上，改标题只改 frontmatter；还没有正文就留在原来那份所在的子目录，文件名跟着「章号 + 标题」。
- **定稿**（`finalizePlot`）：写回正文镜像的那一份，没有就在镜像位置新建，绝不在根下另建。
- **改名、移动、删除**：
  - 正文改名、移动（单章或整个卷目录）：`handlers/chapter.ts` 的 `carryPlot` 把细纲一并搬过去，规矩与草稿相同（目标已有就不动、toast 说出来；移出 `chapters/` 就留在原处）。对话页目标指着那份细纲的跟着改。
  - 细纲改名（`fileOps.renamePlot`）改的是标题：没有正文时文件名跟着标题，有正文时文件名不动。正文从不因为细纲改名而改名。
  - 删正文不删细纲：它退回这一章的计划。
- **给模型的说明**（`list`、`generate` 工具与 MCP 说明）：细纲与正文相对路径相同，正文可以分子目录。工具文字里不出现「卷」（`tests/contract/toolText.test.js`）。

## 删掉的

`NovelProject.plotPathForNo`（按章号拼平铺路径）、`kind.ts` 的 `plotRelPathFor`、`views/pipeline.ts` 的 `firstByNo`（细纲按号取第一份）。

## 测试

- 新增 `tests/integration/files/plotFollow.test.js`：正文改名、移动、整卷搬时细纲跟着走，目标已有不覆盖，删正文不删细纲，照细纲新写正文时细纲跟着改名。
- `features/pipelineData.test.js` 末尾新增「细纲镜像正文的相对路径」：子目录里的细纲列得出、判成 plot、孤儿不冒认、`resolvePlot` 认现在那一份、定稿写回镜像、新一章跟上一章、同号两个文件各有各的细纲。
- `generation/chapterWorkbench.test.js`：卷目录里的章节，点名字时旁边打开 `summaries/` 同一个卷目录里的细纲（这次的回归）。
- 原来断言「平铺 / 子目录不认 / 按章号配对」的用例按新规则改写（kind、hashChain、fileOps、generateTool、selectPlot、creation）。
