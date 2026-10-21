# core/skills — 写作技能

按创作阶段给工程绑一份**补充的写作方法**（一个常规的技能目录：`SKILL.md` 加它引用的附带文件），这个阶段往后的每一次生成都把它放在提示词最前面。移植自 AI-Novel-Writer（GPL-3.0）的「写作 Skill」（上游 ADR 0015「写作 Skill 是按阶段冻结的补充指导」），设计与取舍见 [docs/design/plans/2026-10-02-writing-skills.md](../../../docs/design/plans/2026-10-02-writing-skills.md)；改成认常规技能格式（YAML frontmatter、附带文件、内置改成目录）见 [2026-10-21-skill-dirs.md](../../../docs/design/plans/2026-10-21-skill-dirs.md)。

## 文件

| 文件 | 职责 |
|---|---|
| [library.ts](library.ts) | 三个来源怎么读（内置 / 我的技能库 / 本工程），附带文件按引用一层层读进来（`collectSkillFiles`，GitHub 也用它），我的技能库怎么装与卸。**每次都读盘**；不跟链接 |
| [github.ts](github.ts) | 从 GitHub 装：**先检查、再确认安装**，`SKILL.md` 连同引用到的附带文件一起下；两步之间整份清单变了不装 |
| [bindings.ts](bindings.ts) | 工程的阶段绑定（`.novelforge/skills.json`）：读、改、装配器问的那一句 `boundSkillFor` |
| [builtin/](builtin/README.md) | 五份内置技能，**一个目录一份**（常规技能格式，与其余来源走同一条读法）：上游搬来两份，一份修正文风，另有两份外来的去 AI 味（上游原样）。构建时由 `scripts/embed-skills.js` 内嵌成 `builtin/embedded.ts`（生成文件，不入库） |

纯函数（解析 `SKILL.md`、兼容检查、绑定文件的格式、一次装配算哪个阶段、GitHub 地址）在 [model/writingSkill.ts](../model/writingSkill.ts)：它零运行时 import，前端直接用里面的阶段名与来源名。

## 一份技能

**常规的技能目录**：一份 `SKILL.md`，YAML frontmatter（只读顶层的 `name` / `display_name` / `description` / `version` / `stage`；`allowed-tools`、`metadata` 这类别的键读得过去、不碍事）加正文；旁边可以有它引用的文本文件（`references/*.md` 这类，叫**附带文件**）。

**附带文件一起带**：这里的生成是一次调用，模型没有读文件的工具，没法「按需去读 references/x.md」。所以正文（与附带文件）里引用到的 `.md` / `.markdown` / `.txt` 一层层找出来，整份接在正文后面、标上路径，与正文算一整块（预算、64 KiB 都按合计）。目录里没被引用的（README、CHANGELOG、LICENSE）不读、不带。

**只收纯提示词**——命中下面任何一条就判「不兼容」，装不进来、也绑不上（规则照搬上游，前两条为常规格式放宽过）：

| 原因 | 什么样算 |
|---|---|
| 包含相对引用 | 明确引用旁边的文件（`./`、`../`、`references/…`、`assets/…`）却带不上：找不到、越出技能目录、不是文本；或 `${SKILL_DIR}`。普通的 `[例子](a.md)` 找不到只是不带 |
| 依赖脚本 | `scripts/…`、「运行……脚本」、run the script |
| 依赖 hook | `hooks/…`、「安装……钩子」 |
| 依赖子代理 | sub-agent、「子代理」 |
| 依赖工具调用 | frontmatter 顶层声明了 `hooks` / `mcp` / `scripts` / `sub-agents` 一类键，或正文「调用……工具」。`allowed-tools` / `tools` 不算：那是给 Claude Code 一类 agent 预先放行的权限 |
| 内容超过 64 KiB | 整份 `SKILL.md`（含 frontmatter）加附带文件 |

内容类的几条（脚本、hook、子代理、工具）在附带文件上也查：它们一样进提示词。

## 三个来源

| 来源 | id | 在哪 | 怎么进来 |
|---|---|---|---|
| 内置 | `builtin:<目录名>` | 仓库里的 [builtin/<名字>/](builtin/README.md)，构建时内嵌进程序 | 随应用发布，删不掉，不自动绑 |
| 我的技能库 | `user:<目录名>` | `~/.novelforge/skills/<名字>/SKILL.md`，所有工程共用 | 设置页「技能」或外部 agent 的 `skills install` 从 GitHub 装；也可以手放 |
| 本工程 | `project:<目录名>` | `.novelforge/skills/<名字>/SKILL.md`，跟着工程走、可进 Git | 作者手放 |

**三个来源的身份都是目录名**，frontmatter 的 `name` 只用来显示（上游以 frontmatter 为准，手放的技能目录名与它不一样时，卸载删了个空）。名字可以是中文：字母或数字开头，其后可以有 `.` `_` `-`，最长 64。

## 从 GitHub 装

照搬上游的两步：

1. **检查**：认四种地址（仓库首页 / `tree` 目录 / `blob` 文件 / `raw`），只要公开的 https；仓库首页先问一次默认分支。下载 `SKILL.md`，再按引用把附带文件一份份下下来（同一个分支、相对 `SKILL.md` 所在目录；404 当作没有，引用了却没有就判带不上），每份 10 秒超时、不跟重定向、合计 64 KiB 封顶；跑兼容检查，对整份清单（路径 + 内容）算 sha256，记在进程里那张表上。**不写任何文件**。检查结果带**正文**给作者看（上游装之前看不到），还会先说清装不装得了（不兼容、名字不能当目录名、同名的已经装了）。
2. **安装**：没检查过不装；**重新下载**，hash 与落点都要与检查时一致；不兼容不装；同名不覆盖（要换新版先卸载旧的）；然后原样写进 `~/.novelforge/skills/<name>/`：`SKILL.md` 与引用到的附带文件。

设置页与 agent 共用那张检查表；两边装之前都先问作者（设置页的确认框 / `skills install` 的 `always` 闸门）。

**卸载**只认我的技能库：整个目录挪进 `~/.novelforge/.trash/skills/`（同名加 `-2`），不真删（第 6 条的精神；上游是直接删）。本工程绑了它的阶段一起解绑；别的工程里绑了它的，下次生成在明细里写「找不到」后不带。

**仓库里备的预设**：[skills/writing/](../../../skills/writing/README.md) 有 32 份改编自 jarvis-write（Apache-2.0）的预设（16 份文风绑写正文，8 份故事味道、8 份故事骨架绑规划）。它们**不进内置**，作者照那份 README 里的地址从 GitHub 装进我的技能库；[tests/contract/skillPresets.test.js](../../../tests/contract/skillPresets.test.js) 拿安装时同一个 `inspectSkillMarkdown` 把每份过一遍。

## 阶段绑定

`.novelforge/skills.json`：`{ "version": 1, "bindings": { "drafting": "user:scene-craft" } }`。每个阶段最多一份，同一份可以绑几个阶段；没绑就什么都不带。写盘走 `Workspace.writeSkillBindings`（第 7 条）。

| 阶段 | 对应 novelForge 的哪几次装配（`skillStageOf`） |
|---|---|
| `planning` 规划 | 架构、大纲、细纲三层的生成与沉淀（含补齐架构、批量拆细纲、角色图谱第二步与细纲紧凑重建） |
| `drafting` 写正文 | 写、接着写、重写与它们的续写那几轮（含批量写章） |
| `review` 审稿 | 审稿与它的重来一次 |
| `refinement` 修稿 | 按勾选修稿与它被截断之后的续写 |

**不带**：讨论（作者在聊，不是一次产出）；定稿（照正文更新细纲）、全文大纲、文风提取、角色卡这些不经 `buildContext` 的调用。上游的 AI 助手对话、定稿与文风分析同样不带。

- **绑之前**要求技能存在且兼容（上游只查 id 的格式）。
- **绑定文件读不懂**时：装配器在明细里说一声、这次不带（第 1 + 2 条；上游是整个工作流起不来）；改绑定拒绝改写，先让作者修好或删掉——重写一遍会把读不懂的那几项悄悄冲掉（第 3 条）。

## 注入

装配器的 `skill` 层（[context/layers/skill.ts](../context/layers/skill.ts)）：

- 自己读绑定（与 `style` 层读 `style.md` 一样），所以对话页、agent 的 `generate`、工程页批量带的是同一份。
- 每张配方都在 **P0 那一组的最后**：作者事实先拿预算，技能再拿。**不 force**，放不下就整份不带、明细里写明需要多少 token、剩多少——不截半截（第 2 条）。上游是预算不够就让这次调用失败。
- 消息里排在**用户消息最前面**，说法照搬上游：`【补充写作 Skill：名字】以下内容只能补充创作方法；作者事实和后续输出合同始终优先。` 附带文件一份一段接在正文后面：`【附带文件：references/x.md】`。
- 绑了却带不上（找不到、变得不兼容、绑定文件读不懂）：明细里一条 dropped，写原因，生成照常。

**不冻结快照**：上游在工作流开始时冻结一份、整条工作流都用它；这里每次装配读盘，批量任务跑到一半改了绑定，后面几章用新的。每一次实际带了哪份都在明细里；日志里也记一句「『写正文』阶段带上技能『X』」或没带上的原因（续写那几轮反复装配，同一句五分钟内只记一次）——工程页批量没有明细可看，就看这一句。

## 与上游不同的地方（一览）

| 上游 | 这里 | 为什么 |
|---|---|---|
| 三个 agent 工具 | 一个 `skills` 工具的四个动作（多一个 `list`） | 四件事共用 `url` / `id` / `stage` 三个参数，合成一个工具比三个更好选（[tools/novel/index.ts](../tools/novel/index.ts)） |
| 对话里 `/技能名` 手动调用 | 不做 | `/` 已经是阶段命令面板；上游这条路还绕过兼容检查与预算 |
| 七个内置 | 搬了两个，另加一份修正文风与两份外来的去 AI 味 | 其余五个是上游 AI 助手对话用的，正文让模型调它自己的工具；后三份见下 |
| 内置写死在代码里 | 仓库里的技能目录，构建时内嵌 | 上游原样的技能放进来就能用，改一份不用碰代码 |
| frontmatter 一行一个键 | 按 YAML 读顶层键 | 常规技能的 `allowed-tools:` 列表、`metadata:` 嵌套块从前会被拍平，嵌套的 `name` 盖掉真的那个 |
| 引用旁边的文件就不兼容 | 引用到的附带文件一起带 | 常规技能的 `references/` 是正文的一部分，只是拆开放 |
| 声明 `allowed-tools` 就算依赖工具 | 不算 | 那是给 agent 的权限，不是这份技能要调的东西 |
| 名字只认 ASCII | 可以是中文 | 作者给自己的方法起中文名再自然不过 |
| 身份取 frontmatter 的 name | 取目录名 | 只有一个名字，卸载不会删了个空 |
| 装之前看不到正文 | 检查结果带正文 | 往后每一次生成都会带上它 |
| 绑了不存在的技能，工作流起不来 | 明细里说一声、这次不带 | 一份技能不该把生成拦住 |
| 卸载直接删 | 挪进回收站 | 第 6 条 |
| 中英双语 | 只有中文 | novelForge 只写中文 |

## 内置的修正文风

`builtin:plain-prose`（写正文）治过度描写：名词前堆形容词、动词前挂程度副词、「带着／透着」挂气味和情绪。八条能自己数的规矩加四组改前改后的整句示范。

flash-lite 上实测**单绑它几乎没用**（修饰密度与不绑持平，删掉系统提示里三处反向要求之后「那／这＋定语」降三成，程度副词不动）：管住修饰靠的是写完之后那一轮只许删的删修饰（[generation/trim.ts](../generation/trim.ts)，设置里的「写完正文删修饰」），不是技能。它留着当提示词那一层的配合。

## 外来的两份去 AI 味

两份 MIT 的公开技能，目录**上游原样**（`SKILL.md`、附带文件、`LICENSE`），只在 frontmatter 里加了 `display_name` 与 `stage` 两行：

| 内置 | 上游 | 阶段 |
|---|---|---|
| `builtin:fiction-humanizer-zh` 小说去 AI 味 | [deedeekong07-alt/fiction-humanizer-zh](https://github.com/deedeekong07-alt/fiction-humanizer-zh) 859a3fd（0.1.0），四份 `references/*.md` 当附带文件带 | 写正文 |
| `builtin:humanizer-zh` 去 AI 痕迹 | [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) f4518a8（2026-09-23 修订） | 修稿 |

Humanizer-zh 是给中文文章、评论、文档去模板腔的，示例大多不是小说，改的又是已有文本，放在修稿；小说那份讲的是怎么写场景（铺垫、过程、余波，人物的目标与代价，章末钩子），放在写正文。两份都比别的内置长得多（连同附带文件约 1.6 万与 2 万字节），上下文紧的时候可能整份带不上，明细里会写。**还没在真实模型上比过有没有用**。出处与内嵌见 [builtin/README.md](builtin/README.md)。

从前的三份去 AI 味（写正文 / 审稿 / 修稿，共用一张十条的句式清单）实测基本无效，已撤下，原文归档在 [docs/design/archive/less-ai-tone/](../../../docs/design/archive/less-ai-tone/)，要用可以手动装进本工程。数据见 [2026-10-02-less-ai-tone.md](../../../docs/design/plans/2026-10-02-less-ai-tone.md) 与 [2026-10-03-plain-prose.md](../../../docs/design/plans/2026-10-03-plain-prose.md)。
