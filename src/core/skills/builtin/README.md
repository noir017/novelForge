# 内置写作技能

这里一个目录就是一份内置技能，用的是常规的技能格式：一份 `SKILL.md`（YAML frontmatter + 正文），旁边可以带它引用的文件（`references/*.md` 这类）。目录名就是 id 里的名字（`builtin:<目录名>`），设置页按目录名排。

随应用发布，删不掉，**不自动绑定**（与上游一样，绑不绑由作者定）。

## 怎么进程序

三个壳的产物都是单文件，运行时旁边没有这个目录。构建时 [scripts/embed-skills.js](../../../../scripts/embed-skills.js) 把这里每个目录的全部文件写进 `embedded.ts`（生成文件，不入库），core 从那里读。改了这里的文件，下一次 typecheck、测试、编译都会自动重新生成，不用手跑。

读的时候与「我的技能库」「本工程」走同一条路：读 `SKILL.md`，按引用把附带文件带上，过同一套兼容检查（见 [model/writingSkill.ts](../../model/writingSkill.ts)）。没被引用的文件（`LICENSE` 这类）不进提示词。

## 出处

| 目录 | 阶段 | 出处 |
|---|---|---|
| `long-form-continuity` 长篇连续性与场景推进 | 规划 | AI-Novel-Writer（GPL-3.0）`skill-registry.ts:398-432`，中文正文照抄 `localizedContent['zh-CN']` |
| `natural-prose-refinement` 自然语言润色 | 修稿 | 同上 |
| `plain-prose` 修正文风 | 写正文 | 这边自己的，数据与取舍见 [2026-10-03-plain-prose.md](../../../../docs/design/plans/2026-10-03-plain-prose.md) |
| `fiction-humanizer-zh` 小说去 AI 味 | 写正文 | [deedeekong07-alt/fiction-humanizer-zh](https://github.com/deedeekong07-alt/fiction-humanizer-zh) 859a3fd（0.1.0），MIT |
| `humanizer-zh` 去 AI 痕迹 | 修稿 | [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) f4518a8（2026-09-23 修订），MIT |

- **上游七个内置只搬了两个**：其余五个（章节审阅、脑暴、角色分析、连续性检查、写作教练）是给上游 AI 助手对话用的，正文让模型去调它自己的 `read_drafts` 一类工具、按星级表格作答。放进这里的生成链，只会让模型以为自己能调一个不存在的工具。
- **修正文风**：上一版去 AI 味按固定短语列禁令，flash-lite 基本不听。这一份不列短语，只给几条能自己数的规矩和改前改后的整句示范。更早的三份去 AI 味（写正文 / 审稿 / 修稿）实测基本无效，已归档到 [docs/design/archive/less-ai-tone/](../../../../docs/design/archive/less-ai-tone/)。
- **两份外来的去 AI 味**：正文、附带文件、`LICENSE` 都照抄上游，只在 frontmatter 里加了两行（`display_name` 与 `stage`，前面有一行注释说明）。还没在真实模型上比过有没有用。
  - Humanizer-zh 是给中文文章、评论、文档去模板腔的，示例大多不是小说，改的是已有文本，所以挂在修稿。
  - fiction-humanizer-zh 讲的是怎么写场景（铺垫、过程、余波，人物的目标与代价，章末钩子），挂在写正文。
  - 篇幅都比别的内置长得多（约 1.6 万与 2 万字节），上下文紧的时候可能整份带不上，明细里会写明。

`stage` 决定设置页里它出现在哪个阶段的下拉框里：内置技能只在自己的阶段列出。
