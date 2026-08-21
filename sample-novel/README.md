# sample-novel — 示例小说工程

一个真实格式的示例工程，有两个用途：

1. **开发调试**：按 `F5` 启动 Extension Development Host 时自动打开这里，直接可以试拆卷 / 拆段 / 排剧情 / 写正文 / 拆成章节 / 摘要 / 角色卡。
2. **测试夹具**：`tests/contract/sampleNovel.test.js` 与 `tests/integration/context/builder.test.js` 在它上面跑**只读**断言（含摘要 `sourceHash` 与章节正文的一致性）——**不要随手改 `chapters/` 里的正文**，否则 hash 断言会挂；要改就把 `.novelforge/project.json` 里的 `contentHash`/`summaryHash` 与对应摘要的 `sourceHash` 一起更新。需要写盘的用例一律经 `tests/helpers/tmpProject.js` 的 `copyFixture()` 复制一份出去跑，不碰这里。

## 目录

```
chapters/                    发布章节，NNN-标题.md。**唯一真相**：摘要从这里生成，
                             上下文里的正文也从这里取
├── 001-楔子.md
├── 002-客栈里的女人.md
└── 003-夜访.md
.novelforge/
├── project.json             章节索引 + 摘要新鲜度（version: 1）
├── style.md                 文风指南（写正文时必注入）
├── outline.md               全书大纲（人工维护）
├── plots/                   每章的细纲，NNN-标题.md，序号即章号
│   ├── 001-楔子.md              四节：目标 / 剧情脉络 / 冲突与转折 / 伏笔与回收
│   ├── 002-客栈里的女人.md
│   └── 003-夜访.md
├── manuscripts/             **中转站**：模型写出来的正文暂存在这里，拆成章节后就删掉。
│                            示例工程三章都拆过了，所以这个目录是空的
├── characters/              角色卡（frontmatter + 固定小节）
├── lore/                    世界观设定（含 keywords，命中即注入）
└── summaries/               单章摘要（按**章节**名镜像，如 001-楔子.md）+ 全书滚动摘要 global.md
```

流水线的单位是**章**，中间多一道拆分：

```
outline.md → volumes/NN.md → plots/NNN.md → manuscripts/NNN.md →（拆分）→ chapters/NNN.md → summaries/NNN.md
```

生成时不按「一章一次」硬切——模型写多长由剧情决定，正文出来后作者在编辑器里插 `---`
标断点，点「拆成章节」切成发布章。中转站里那份随即删掉，此后一切按章管理。

格式细节（细纲的四个小节、角色卡固定小节、摘要的六个小节、frontmatter 字段）见根目录 [README.md](../README.md) 与 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目录被根目录 tsconfig 的 `exclude` 排除，不参与编译。
