# sample-novel — 示例小说工程

一个真实格式的示例工程，有两个用途：

1. **开发调试**：按 `F5` 启动 Extension Development Host 时自动打开这里，直接可以试拆细纲 / 写正文 / 定稿 / 角色卡。它是一份「架构齐全、大纲排到第 10 章（第 5–10 章是只有梗概的细纲）、写到第 3 章、第 4 章细纲已经排好」的书，所以主按钮会是「写第 4 章」（落点 `.novelforge/summaries/004-空匣.md`）。
2. **测试夹具**：`tests/contract/sampleNovel.test.js` 与 `tests/integration/context/builder.test.js` 在它上面跑**只读**断言（含细纲的三个指纹：`upstreamHash`、`writtenFrom` 与对着章节正文的 `sourceHash`）——**不要随手改 `chapters/` 里的正文**，否则 hash 断言会挂；要改就把 `.novelforge/project.json` 里的 `contentHash` 与对应细纲的 `sourceHash` 一起更新。改了细纲，要把它 frontmatter 的 `upstreamHash`（梗概的指纹——梗概就是情节大纲里这一章那一条）与 `writtenFrom`（细纲七节的指纹）重算。需要写盘的用例一律经 `tests/helpers/tmpProject.js` 的 `copyFixture()` 复制一份出去跑，不碰这里。

## 目录

```
chapters/                    正文，NNN-标题.md。**唯一真相**：定稿照它更新细纲，
                             上下文里的正文也从这里取
├── 001-楔子.md
├── 002-客栈里的女人.md
└── 003-夜访.md
.novelforge/
├── project.json             章节索引（version: 1）+ 全文大纲汇总到第几章
├── config.md                小说配置：类型 / 结构 / 视角 / 总章数 / 每章字数 + 七节
├── premise.md               故事前提（一句话前提 / 核心冲突链 / 金手指定位 / 悬念骨架）
├── world.md                 世界观（规则与漏洞 / 阶层与资源 / 深层危机）
├── style.md                 文风指南（写正文时必注入）
├── characters/              角色卡（frontmatter + 固定小节）——也就是角色图谱
├── lore/                    世界观设定条目（含 keywords，命中即注入）
└── summaries/               细纲，一章一份，与 chapters/ 里的正文相对路径相同（扩展名 .md），细纲号 = 章号；外加全文大纲 global.md（原全书摘要，只有「主线进展」一节）
    ├── 001-楔子.md              001–003 定稿过（sourceHash 对得上正文）
    ├── 002-客栈里的女人.md
    ├── 003-夜访.md
    ├── 004-空匣.md              计划：排好了，还没有正文
    ├── 005-药渣.md … 010-七个人.md  只有梗概：情节大纲排到了，细纲还没拆
    └── global.md
```

链路是一条轴：

```
config / premise / characters / world → 情节大纲（没有文件：各章细纲「梗概」的汇总）→ summaries/…/NNN.md（细纲）→ chapters/…/NNN.md（与细纲相对路径相同）→ 定稿反向更新同一份细纲
```

格式细节（细纲的八个小节——示例里的「连续性事实」是占位、角色卡固定小节、frontmatter 字段）见根目录 [README.md](../README.md) 与 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目录被根目录 tsconfig 的 `exclude` 排除，不参与编译。
