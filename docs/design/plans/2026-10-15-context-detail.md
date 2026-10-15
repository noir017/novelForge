# 上下文详细度（四级开关）

> 2026-10-15。单独一件，**在 main 上直接开发**。起因：作者问「当前项目 LLM 调用情况，上下文一般多少」，查下来写正文第一次调用的上下文随书长一路涨——「更早章摘要」那一层（`context/layers/background.ts` 的 `plotSummary`）没有章数上限，填到预算满为止，128k 窗口大约第 80 章撞顶；其余约 45 个「带多少」的上限写死在各层的常量里，作者调不了。作者要一个开关：分四级，每升一级注入的上下文越多。

**Goal:** 设置页「上下文管理」里一个下拉框「上下文详细度」（1 精简 / 2 标准 / 3 详细 / 4 完整）。它决定每一次调用带多少前文与设定：写作装配（架构、大纲、细纲、正文、续写、审稿、修稿）与几项后台任务（提取文风、提取角色、参考书学文风、排叙事线、定稿判线、写前冲突检查）。任何一级都不改调用次数。

## 作者拍板的四件（2026-10-15）

| # | 问题 | 定案 |
|---|---|---|
| A | 开关放哪 | **全局设置**（`~/.novelforge/config.json` 的 `contextDetail`），设置页「上下文管理」。对话页、工程页批量、MCP 都按它装——它是成本偏好，批量写章正是最费上下文的地方 |
| B | 现在的装配对应第几级、默认哪级 | **现在 ≈ 第 3 级，默认 3**。第 3 级只多一条：更早章摘要封顶 60 章；第 4 级在现在基础上再多带；1、2 级逐级减 |
| C | 管哪些调用 | **连后台任务一起分级**（只要是「带多少材料」的上限；不分级的见下） |
| D | 「注入完整原文章数」「上一章结尾字数」两个旧设置 | **并入级别，去掉两个输入框**；config.json 里的旧值不再读 |

## 级别表

第 3 级逐项等于这个开关出现之前写死的常量（单测钉着）。

| 项 | 1 精简 | 2 标准 | **3 详细** | 4 完整 | 从前在哪 |
|---|---|---|---|---|---|
| 近章全文 | 0 | 1 | 2 | 3 | `config.recentChaptersFullText` |
| 上一章结尾 | 1000 | 1500 | 1500 | 2000 字 | `config.prevChapterTailChars` |
| 更早章摘要 | 5 | 20 | **60**（新） | 不限 | 无上限 |
| 定稿原文片段：全取 / 最多几章 / 字数 | 不带 | 3/6/3000 | 5/12/6000 | 8/20/10000 | `EVIDENCE_*` |
| 近章连续性事实（含写前冲突检查） | 6/1500 | 8/2000 | 12/3000 | 20/5000 | `RECENT_FACTS_*`、`PLOT_CHECK_*` |
| 叙事线 | 3/600 | 4/900 | 6/1200 | 8/1800 | `ACTIVE_THREAD_*` |
| 前序细纲一览 | 30 | 50 | 100 | 不限 | `PLOT_LIST_MAX` |
| 细纲单章前 / 后几章 | 1/1 | 2/1 | 3/1 | 5/2 | `PREV_PLOTS` / `NEXT_PLOTS` |
| 历史封顶 | 15% | 20% | 30% | 40% | `HISTORY_CAP` |
| 角色卡只带要点 | 是 | 否 | 否 | 否 | — |
| 挑出场角色看前几章摘要 | 1 | 2 | 2 | 3 | `render.ts` 写死 2 |
| 拆书补齐抽样 | 3 | 4 | 5 | 8 | `SAMPLE_COUNT` |
| 提取文风缺省勾前几章 | 1 | 2 | 2 | 3 | `style.ts` 写死 2 |
| 提取角色缺省勾最近几章 | 1 | 2 | 3 | 5 | `characters.ts` 写死 3 |
| 参考书文风抽几章 | 3 | 4 | 5 | 8 | `STYLE_SAMPLES` |
| 排叙事线：大纲字数 / 每行事件字数 | 4000/60 | 6000/90 | 8000/120 | 12000/200 | `OUTLINE_CHARS` / `PLOT_LINE_EVENTS` |
| 定稿判线最多几条 | 6 | 9 | 12 | 16 | `THREAD_JUDGE_LIMIT` |

**不分级**：后 5 章边界（`AHEAD_PLOTS`，生成层 `notYetOf` 用同一个窗口）、本章已写末尾 1600 字、@ 引用 35%、`settle` 历史 60%、单轮历史 12%、整份带的文档层；单章摘要、全书摘要、角色状态、建卡、设定扫描（输入就是那一章本身或按窗口分批）。

探查实测（`~/workspace/project-scripts/novelforge-context-detail/probe.js`：100 章假工程，每章约 3000 字、摘要约 700 字，没有设定与文风；改动前的装配器取 HEAD 导出的一份，同一个工程各装一次「写第 N 章」的第一次调用，估算 token / 预算 119296）：

| 写到 | 改动前 | 1 精简 | 2 标准 | 3 详细 | 4 完整 |
|---|---|---|---|---|---|
| 第 10 章 | 19986 | 8674 | 16011 | 19986 | 23013 |
| 第 30 章 | 38624 | 8685 | 26638 | 38624 | 44198 |
| 第 64 章 | 68646 | 8685 | 26640 | 67765 | 74220 |
| 第 100 章 | 99217 | 7468 | 25423 | 66564 | 104791 |

第 10、30 章第 3 级与改动前 messages **逐字一致**；第 64 章起差在摘要封顶 60 章。第 100 章各级少的那一截是后 5 章边界没了（假工程只排到第 100 章）。

## 落在哪

| 模块 | 做了什么 |
|---|---|
| `model/contextDetail.ts`（新） | 级别、说法、冻结的级别表、`normalizeContextDetail`、`contextLimitsOf`（唯一解析入口，叠上 `contextOverrides`）、`takeLast`、`describeContextDetail`。零 import，前端经 `media/src/protocol.ts` 打包 |
| `config.ts` / `model/types.ts` | `NovelConfig.contextDetail`（认不出回落 3，warn 一次）+ 只给代码与测试的 `contextOverrides`；`setContextLimitsOverride` 测试钩子；两个旧键进 `RETIRED_KEYS`，下次保存清掉 |
| `context/builder.ts` / `layers/*` | `Assembly.detail` / `limits`；各层从 `a.limits` 取；摘要封顶之外合成一条 `plotSummary:beyond`；「精简」一条 `evidence:off`；角色卡只带要点；`BuiltContext.detail` |
| `features/style.ts` `characters.ts` `reference.ts` `threads.ts` `plotCheck.ts` | 从 `contextLimitsOf(readConfig())` 取缺省取章、抽样、排线与判线、冲突检查的上限 |
| `model/threadsFile.ts` / `model/plotCheck.ts` | `threadsToJudge`、`selectCheckFacts` 收上限参数；原常量改成第 3 级的别名，给纯函数当默认值 |
| 设置页 / 协议 | `SettingsPayload.contextDetail`；`panes.ts` 换成下拉框 + 说明行；`settings/index.ts` 填选项、标脏、保存；删掉两个数字输入框 |
| 显示 | 装配清单标题行「· 详细度：详细」（`SerializedDigest.detail`，旧会话没有就不说）；「上下文已装配」日志；批量写章确认框 |
| 清理 | `package.json` 两条 `novel.*` 声明、`shells/vscode/migrate.ts` 两个键、`sample-novel/.vscode/settings.json` 两行 |

## 自定的取舍（⚑，收尾时报给作者）

1. ⚑ **封顶之外的摘要合成一条 dropped**（「第 1–N 章 · 摘要」），不一章一条：一百多章封在 5 章时，九十几行「不带」会把真正带了什么淹掉。
2. ⚑ **封顶按「最近几章」数**：作者手动取消勾选的那一章照样占一个名额（不往前补）。
3. ⚑ **「精简」不带定稿原文片段时出一条 `evidence:off` 说明**；随之，D23 那条「上一章还没定稿」的说明在「精简」下也不出（角色卡上的「状态截至第 K 章」还在）。
4. ⚑ **原有的上限说明措辞不改**（「叙事线一次只带 6 条」「定稿原文片段一共只带 6000 字」），数字跟着级别；只有新加的说明写出级别名。前序细纲一览那条「只带最近 N 章」后面加了「（上下文详细度「X」）」。
5. ⚑ 下拉框里第 3 级标「（默认）」；说明行写这一级具体带多少。
6. ⚑ 认不出的级别（手改 config.json 写成 5、"3"）回落第 3 级，日志 warn 一次。
7. ⚑ 批量写章的确认框写一行当前级别。
8. ⚑ **测试用单项覆盖**（`contextOverrides` / `setContextLimitsOverride`）而不是从 config.json 读一个隐藏键：作者能动的只有级别，旧的两个数字不该换个名字又回来。
9. ⚑ **批量跑到一半改级别只部分生效**：写章那条链开头读一次配置，写前冲突检查、定稿判线每次现读——与 `requestTimeoutMs` 一样。
10. ⚑ **摘要封顶对大纲、细纲阶段同样生效**（那两张配方也有 `plotSummary`）：第 151 章往后排细纲，「详细」只看最近 60 章的摘要 + 全书摘要。
11. ⚑ 窗口小的模型上「完整」不一定带得更多：历史 40% 与三章全文先占预算，更靠后的层更早被挤掉（明细看得到）。
12. ⚑ 不做从旧值到级别的迁移（作者定的 D）：设置页保存过的人旧值都在文件里，分不清是不是手改的。

## 验收

- typecheck 零错误；`test:node` 全过；e2e 全过。
- 新测试：`unit/model/contextDetail.test.js`（表、容错、config 读写与清旧键）、`integration/context/contextDetail.test.js`（四级各装一次）、`integration/features/contextDetailDefaults.test.js`（文风 / 角色缺省取章）、`dom/view/contextDigest.test.js`（装配清单写级别）；`threadsFile` / `plotCheck` / `reference` / 设置页 DOM 测试各补了按级别的用例。
- 没调真实模型。
