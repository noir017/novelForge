# 内置写作技能

这里一个目录就是一份内置技能，用的是常规的技能格式：一份 `SKILL.md`（YAML frontmatter + 正文），旁边可以带它引用的文件（`references/*.md` 这类）。目录名就是 id 里的名字（`builtin:<目录名>`），设置页按目录名排。

随应用发布，删不掉，**不自动绑定**（与上游一样，绑不绑由作者定）。

## 怎么进程序

三个壳的产物都是单文件，运行时旁边没有这个目录。构建时 [scripts/embed-skills.js](../../../../scripts/embed-skills.js) 把这里每个目录的全部文件写进 `embedded.ts`（生成文件，不入库），core 从那里读。改了这里的文件，下一次 typecheck、测试、编译都会自动重新生成，不用手跑。

读的时候与「我的技能库」「本工程」走同一条路：读 `SKILL.md`，按引用把附带文件带上，过同一套兼容检查（见 [model/writingSkill.ts](../../model/writingSkill.ts)）。没被引用的文件（`LICENSE` 这类）不进提示词。

## 出处

| 目录 | 阶段 | 出处 |
|---|---|---|
| `plain-prose` 去 AI 味 | 写正文 | 这边自己的；修饰那几条的数据见 [2026-10-03-plain-prose.md](../../../../docs/design/plans/2026-10-03-plain-prose.md)，句式与场面那几条改写自 [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) f4518a8 与 [deedeekong07-alt/fiction-humanizer-zh](https://github.com/deedeekong07-alt/fiction-humanizer-zh) 859a3fd（都是 MIT，`LICENSE-*` 两份留在目录里） |

- **只有这一份**：2026-10-23 删了从 AI-Novel-Writer 搬来的两份（长篇连续性与场景推进、自然语言润色，各一句话，没什么用），两份外来的去 AI 味（合计约 3.8 万字节）挑出对小说有用的几条并进这一份，目录删掉。取舍见那份设计稿末尾。
- **效果没测过**：修饰那几条在 flash-lite 上单绑几乎没用（管住修饰靠写完之后的删修饰），并进来的那几条还没在真实模型上比过。
- 更早的三份去 AI 味（写正文 / 审稿 / 修稿）实测基本无效，已归档到 [docs/design/archive/less-ai-tone/](../../../../docs/design/archive/less-ai-tone/)。

`stage` 决定设置页里它出现在哪个阶段的下拉框里：内置技能只在自己的阶段列出。
