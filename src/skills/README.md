# src/skills — 内置技能

**给产品内的 agent 用的工作流说明**，不是 TypeScript 模块。里面一个 `.ts` 都没有。

一个技能是一份「这类事该怎么做」的说明：按什么步骤做、判断标准是什么、产出落到哪个文件。它与 `src/core/context/prompts.ts` 里的提示词是两种东西：

| | 提示词（`core/context/prompts.ts`） | 技能（这里） |
|---|---|---|
| 谁读 | 被调用的模型，每次生成都注入 | agent，需要时才读 |
| 内容 | 「你是谁、这一次产出什么、什么形状」 | 「怎么判断好坏、怎么修、改哪个文件」 |
| 长度 | 必须短，占的是作者的 token 预算 | 可以长，不进生成上下文 |

**方法论放技能，结论放提示词。** 这也是技能不进 `AGENT_SYSTEM` 的理由：那一份每回合都要重发，而十次里有九次用不上。

机制（两个来源、索引怎么拼、`skill` 工具）在 [src/core/skills/](../core/skills/index.ts)。

## 目录

| 技能 | 一句话 |
|---|---|
| [foreshadowing-audit/](foreshadowing-audit/SKILL.md) | 跨章对账：哪些坑没填、哪些事实前后打架、时间线有没有倒错 |
| [character-voice/](character-voice/SKILL.md) | 一个角色散在几十章里的言行集中起来看，先建口吻基线再判偏离 |

## 读者是产品内的 agent，不是写代码的人

这一条决定了技能里能写什么。

产品内的 agent 手上只有八个工具，够得着的只有 `.novelforge/` 那棵树。所以**技能里不能出现源码路径**——「改 `prompts.ts` 的 `manuscript` 分支」对它是一句无法执行的话，它只会把这句话原样转述给作者。

**药方必须落在作者的工程文件上**（`style.md`、角色卡、某一份细纲），那些它有 `write` / `edit` 够得着。落点写清楚，别写「改一下提示词」。

给开发代理（Claude Code）用的技能在 `.claude/skills/`，本机私有、不入库，与这里无关。

## 写一个新技能

一个子目录，入口必须叫 `SKILL.md`。**目录名就是技能名**，与「路径即产物身份」同一套口径。

三条硬约束：

1. **不写 frontmatter。** 索引只列名字，`description:` 那一行没有消费者——留着解析代码就是留着一个没人读的字段慢慢跑偏。
2. **名字必须自带触发力。** 模型在索引里只看得到名字，看不到「什么时候该用」。`chapter-review` 好过 `reviewer`，`审章找AI味` 好过 `流程1`。这是这一版的赌注。
3. **不许有 `references/`。** 附件靠 `read` 取，而 `read` 只认工程根之内的路径——内置技能不在工程里（是烘进产物的常量），链接会断。长内容压进正文，或者拆成两个技能。**工程内的技能不受这条限制**（它们在工程里，`read` 够得着）。

三条都由 [tests/contract/skills.test.js](../../tests/contract/skills.test.js) 守着。

**改完要重新生成**：`npm run skills`。正常路径上不必手动跑——`compile` / `typecheck` / `test` 的前置里都带着它。
