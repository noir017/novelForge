# sample-novel — 示例小说工程

一个真实格式的示例工程，有两个用途：

1. **开发调试**：按 `F5` 启动 Extension Development Host 时自动打开这里，直接可以试写剧情 / 拆场景 / 写正文 / 摘要 / 角色卡。
2. **测试夹具**：`tests/contract/sampleNovel.test.js` 与 `tests/integration/context/builder.test.js` 在它上面跑**只读**断言（含摘要 `sourceHash` 与段正文的一致性）——**不要随手改 `manuscripts/` 里的正文**，否则 hash 断言会挂；要改就把 `.novelforge/project.json` 里的 `contentHash`/`summaryHash` 与对应摘要的 `sourceHash` 一起更新。需要写盘的用例一律经 `tests/helpers/tmpProject.js` 的 `copyFixture()` 复制一份出去跑，不碰这里。

## 目录

```
chapters/                    发布区。作者从 manuscripts/ 自己切出来的章节，
                             工具不分析、不总结、不挂流水线状态。示例里是空的
                             （只有一份 README.md，没有数字前缀，不算章节）
.novelforge/
├── project.json             剧情段索引 + 摘要新鲜度（version: 2）
├── style.md                 文风指南（写正文时必注入）
├── outline.md               全书大纲（人工维护）
├── plots/                   剧情段细纲，NNN-标题.md，序号即写作顺序
│   ├── 001-楔子.md              四节：目标 / 剧情脉络 / 冲突与转折 / 伏笔与回收
│   ├── 002-客栈里的女人.md
│   └── 003-夜访.md
├── scenes/                  场景素材，按段名建目录（<段名>/NN-场景名.md）
├── manuscripts/             正文，按段名镜像（001-楔子.md）。**工具写出来的产物**
├── characters/              角色卡（frontmatter + 固定小节）
├── lore/                    世界观设定（含 keywords，命中即注入）
└── summaries/               单段摘要（按段名镜像，如 001-楔子.md）+ 全书滚动摘要 global.md
```

流水线的单位是**剧情段**，不是章节：

```
outline.md → plots/NNN.md → scenes/NNN/ → manuscripts/NNN.md → summaries/NNN.md
```

`chapters/` 在这条链之外——作者写完正文后自己切成发布章节，工具只提供文件操作。

格式细节（剧情段的四个小节、角色卡固定小节、摘要的六个小节、frontmatter 字段）见根目录 [README.md](../README.md) 与 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目录被根目录 tsconfig 的 `exclude` 排除，不参与编译。
