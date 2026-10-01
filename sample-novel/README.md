# sample-novel — 示例小说工程

一个真实格式的示例工程，有两个用途：

1. **开发调试**：按 `F5` 启动 Extension Development Host 时自动打开这里，直接可以试拆细纲 / 写正文 / 定稿 / 角色卡。它是一份「架构齐全、大纲排到第 30 章、写到第 3 章」的书，所以主按钮会是「拆细纲（第 4–8 章）」。
2. **测试夹具**：`tests/contract/sampleNovel.test.js` 与 `tests/integration/context/builder.test.js` 在它上面跑**只读**断言（含摘要 `sourceHash` 与章节正文的一致性、细纲的两个指纹）——**不要随手改 `chapters/` 里的正文**，否则 hash 断言会挂；要改就把 `.novelforge/project.json` 里的 `contentHash`/`summaryHash` 与对应摘要的 `sourceHash` 一起更新。改了大纲或细纲，要把细纲 frontmatter 的 `upstreamHash`（大纲里覆盖本章那一节的指纹）与 `writtenFrom`（细纲三节的指纹）重算。需要写盘的用例一律经 `tests/helpers/tmpProject.js` 的 `copyFixture()` 复制一份出去跑，不碰这里。

## 目录

```
chapters/                    正文，NNN-标题.md。**唯一真相**：摘要从这里生成，
                             上下文里的正文也从这里取
├── 001-楔子.md
├── 002-客栈里的女人.md
└── 003-夜访.md
.novelforge/
├── project.json             章节索引 + 摘要新鲜度（version: 1）
├── config.md                小说配置：类型 / 结构 / 视角 / 总章数 / 每章字数 + 七节
├── premise.md               故事前提（一句话前提 / 核心冲突链 / 金手指定位 / 悬念骨架）
├── world.md                 世界观（规则与漏洞 / 阶层与资源 / 深层危机）
├── outline.md               情节大纲，按章号区间分节（## 第1–10章：…）
├── style.md                 文风指南（写正文时必注入）
├── plots/                   细纲，一章一份，NNN-标题.md，细纲号 = 章号
│   ├── 001-楔子.md              三节：本章目的 / 关键事件 / 章末钩子
│   ├── 002-客栈里的女人.md
│   └── 003-夜访.md
├── characters/              角色卡（frontmatter + 固定小节）——也就是角色图谱
├── lore/                    世界观设定条目（含 keywords，命中即注入）
└── summaries/               单章摘要（按**章节**名镜像，如 001-楔子.md）+ 全书滚动摘要 global.md
```

链路是一条轴：

```
config / premise / characters / world → outline.md → plots/NNN.md → chapters/NNN.md → summaries/NNN.md
```

格式细节（细纲的三个小节、角色卡固定小节、摘要的七个小节——示例里的三份摘要早于「连续性事实」那一节、frontmatter 字段）见根目录 [README.md](../README.md) 与 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目录被根目录 tsconfig 的 `exclude` 排除，不参与编译。
