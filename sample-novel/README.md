# sample-novel — 示例小说工程

一个真实格式的示例工程，有两个用途：

1. **开发调试**：按 `F5` 启动 Extension Development Host 时自动打开这里，直接可以试续写 / 摘要 / 角色卡。
2. **测试夹具**：`tests/contract/sampleNovel.test.js` 与 `tests/integration/context/builder.test.js` 在它上面跑**只读**断言（含摘要 `sourceHash` 与章节正文的一致性）——**不要随手改章节正文**，否则 hash 断言会挂；要改就把对应摘要里的 `sourceHash` 一起更新。需要写盘的用例一律经 `tests/helpers/tmpProject.js` 的 `copyFixture()` 复制一份出去跑，不碰这里。

## 目录

```
chapters/                    正文，NNN-标题.md，序号即顺序
├── 001-楔子.md
├── 002-客栈里的女人.md
└── 003-夜访.md
.novelforge/
├── project.json             章节索引 + 摘要新鲜度
├── style.md                 文风指南（每次续写必注入）
├── outline.md               全书大纲（人工维护）
├── characters/              角色卡（frontmatter + 固定小节）
├── lore/                    世界观设定（含 keywords，命中即注入）
└── summaries/               单章摘要（按章节文件名镜像，如 001-楔子.md）+ 全书滚动摘要 global.md
```

格式细节（角色卡固定小节、摘要的六个小节、frontmatter 字段）见根目录 [README.md](../README.md) 与 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目录被根目录 tsconfig 的 `exclude` 排除，不参与编译。
