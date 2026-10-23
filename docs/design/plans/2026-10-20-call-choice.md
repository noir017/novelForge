# 调模型之前的确认框：这一次用哪个模型、带多少上下文

> 2026-10-20。作者问「能否在每个模型调用的确认弹窗中添加选项框：选择模型和上下文详细程度」。在 worktree `call-overrides` 里开发，不考虑向后兼容。

## 作者定的（2026-10-20）

| # | 问题 | 定案 |
|---|---|---|
| 1 | 模型下拉框列什么 | 「按分档」（缺省）+ 所有配好的模型。选了某个模型，这一次的每一次调用都用它，**失败不换人**（与对话页同一条规矩） |
| 2 | 换了模型，确认框里报的调用次数要不要重算 | **不重算**：次数本来就是估计，切批用的窗口也不跟着换 |
| 3 | 详细度对这一次不起作用的框 | **不显示**那个下拉框 |
| 4 | 范围 | 只改已有的确认框和工程页两张批量表单（批量拆细纲、批量写章）；本来没有确认框的动作（对话页发送、主按钮、单章定稿、提取角色……）不加弹窗；对话页不加详细度下拉框。**2026-10-23 作者追加**：工程页上点了会调模型、从前不问的几处都加（见下面「2026-10-23 追加」）；主按钮、工作台、对话页发送、MCP 照旧不问 |
| 5 | 独立版确认框只认第一个按钮（`FileHost.confirm`） | **修**，不调模型的多按钮确认框一起修 |

## 实施状态（2026-10-20）

做完了，在 worktree `call-overrides`（分支 `worktree-call-overrides`）。落在哪：

| 模块 | 做了什么 |
|---|---|
| `model/callChoice.ts`（新） | `CallChoice` / `CallPrompt` / `CallAnswer`、`TIERED_LABEL`、`describeCallChoice`、`normalizeCallChoice`。只 import 零 import 的 `contextDetail.ts`，前端经 `media/src/protocol.ts` 打包 |
| `runtime/callScope.ts`（新） | `withCallChoice` / `currentCallChoice`（`AsyncLocalStorage.run`） |
| `config.ts` / `model/types.ts` | `readConfig()` 读「这一次」：`contextDetail` 换掉、多 `pinnedModel`；`settingsContextDetail()` 不看「这一次」，给 `ViewState.contextDetail` 用（状态推送可能就在一次任务的调用链上） |
| `model/tiers.ts` / `llm/pool.ts` | `refsForTask` 认 `pinnedModel`（`pinned: true`，说「这一次指定」）；池、`budgetForTask` 不用改 |
| `features/askCall.ts`（新） | 唯一的问法；19 处确认框换成它，确认之后的活跑在 `withCallChoice` 里、重新 `readConfig()`；长的那几段拆成「问 / 跑」两个函数（`runPlotBatches`、`fillSettings`、`runWriteBatch`） |
| `host.ts` + 三个壳 | `Host.confirmCall`；独立版 `prompt` 多 `actions` / `call`、`promptResult` 多 `choice`、`PromptHub` 交回整份回答；VS Code 多一颗「换模型 / 详细度…」；命令行不问 |
| 协议 / controller | `projectAction.confirmed` → `call`；`ViewState.contextDetail` |
| 前端 | `view/callFields.ts`（新）、`form.ts` 的 `buildSelect`（认 `optgroup`）、`prompt.ts` 多按钮 + 下拉框、两张批量表单 |
| `skills/novelforge-autopilot` | 驱动脚本跟着协议改：确认框答第一颗按钮上的字，批量带 `call: {}` |

## 选择挂在哪：调用链上的一层「这一次」

确认框之后的活跑在 `withCallChoice(choice, fn)`（`runtime/callScope.ts`，`AsyncLocalStorage`）里。**`readConfig()` 是唯一读它的地方**：

- `contextDetail` 换成作者选的那一级，于是装配器、排叙事线、写前冲突检查、定稿判线……凡是经 `contextLimitsOf(readConfig())` 取上限的，一个不落都跟着变；
- 多一个 `pinnedModel`。`refsForTask` 看到它就只给这一个模型（`pinned: true`），模型池、`budgetForTask`、确认框与日志的说法都从这里取，不另开一条路。

不把选择一路当参数递下去：确认框之后要读配置的地方散在十几个函数里（`planThreads`、`recordThreadEvents`、`plotCheck`、`createModelPool`……），漏掉一处就是「弹窗上写着精简、实际按详细装」。`AsyncLocalStorage` 独立版的 `scopedHost.ts` 已经在用（Bun 认 `run`），同时跑的别的任务各在各的上下文里，互不串。

规矩：

- **确认框之前读的 `config` 不能带进确认框之后**——作者的选择在那之后才有。确认之后一律在 `withCallChoice` 里重新 `readConfig()`。
- 选择只管这一次，不写回设置。嵌套的那一问（批量拆细纲拆完再问展开、批量写章补建角色卡再问一次、重建全书摘要选「先同步细纲」）打开时缺省就是外面那一次的选择。
- 选了「按分档」= 不钉模型（外面钉了也解开）；没显示详细度下拉框 = 沿用外面那一次或设置页。
- 钉了模型也不带思考深度（第 26 条不变）。

## 宿主：`Host.confirmCall`

（类型在 `model/callChoice.ts`，与 `contextDetail`、`thinking` 同一个位置：协议只 `import type`。）

```ts
confirmCall(message, actions, opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined>
// CallPrompt = { models, model, tiers, contextDetail? }   CallAnswer = { action, choice: CallChoice }
```

`CallPrompt` 由 `features/askCall.ts` 的 `askCall()` 统一拼：模型清单（`listModelChoices`，与对话页下拉框同一份）、打开时选着哪个、「按分档」时每项活交给谁（`describeTaskModels`，从前各处手抄进 `detail` 的那几行收到这里）、详细度（`contextDetail: true` 的框才给）。

| 宿主 | 怎么问 |
|---|---|
| 独立版 / 桌面版 | 网页弹窗：说明、补充说明，然后两个下拉框（「按分档」时下面列出各项活交给谁），**每个动作一颗按钮** + 取消。`prompt` 消息多 `actions` 与 `call`，`promptResult` 多 `choice`；确认框回的是按钮上的字，取消回 `undefined`（不再是 `yes` / `no`） |
| VS Code | 原生模态框放不了下拉框：多一颗「换模型 / 详细度…」，点了依次弹 QuickPick，选完回到模态框，补充说明末尾写着「这一次：……」 |
| 命令行（只给 `novelforge init`） | 不问模型与详细度；多个动作时编号选 |

## 工程页两张表单

「批量拆细纲」「批量写章」加同样两个下拉框（选项来自 `ViewState.models` 与新加的 `ViewState.contextDetail`），提交时 `projectAction` 带 `call: CallChoice`——**它取代了 `confirmed: true`**：带了就是表单已经问过，后端不再弹第二个框。批量写章要补建角色卡时照旧再问一次，缺省是表单上的选择。

## 哪些框带下拉框

模型下拉框每个都有；详细度只在这一次的上下文看它时出现（✓）。

| 确认框 | 任务（档） | 详细度 |
|---|---|---|
| 批量拆细纲（MCP 那条路；工程页走表单） | plotOutline | ✓ |
| 补齐架构 | setting | ✓ |
| 批量写章 | manuscript、plotSummary，按需 review / plotOutline / characterCard | ✓ |
| 从细纲排出叙事线 | plotOutline | ✓ |
| 批量展开设定 | setting | ✓ |
| 从已写正文补齐 | setting、plotOutline、characterCard、loreSynthesis、plotSummary | ✓ |
| 立即同步 | plotSummary、characterCard | ✓（定稿判线的条数） |
| 章节右键「定稿」「重新定稿」（2026-10-23）：模型缺省是对话页那个，不是「按分档」 | plotSummary、characterCard | ✓（同上） |
| 重建全文大纲 · 都定稿过时（2026-10-23） | globalSummaryStage、globalSummaryMerge | |
| 提取文风 · 第一次（2026-10-23，按钮「开始提取」；已有内容时仍是「覆盖」） | extractStyle | |
| 提取角色卡（2026-10-23，挑完章之后） | extractCharacters | |
| 重写情节大纲（2026-10-23，问完要求之后） | plotOutline | ✓ |
| 重写架构其余几件、展开设定（2026-10-23，问完要求之后；走对话页，模型缺省对话页那个） | （无：对话页那一个模型） | ✓ |
| 从参考书学写法 | extractStyle | |
| 更新 / 重建所有角色卡、给全部人建卡、单卡更新 / 重建 / 创建 | characterCard | |
| 建设定条目、整合设定、按目录整理 | loreSynthesis | |
| 记设定 / 补记设定 | loreScan | |
| 从已写正文补齐 · 先整理细纲 | plotSummary | |
| 重建全书摘要（有没定稿的章时才问） | globalSummaryStage、globalSummaryMerge | |
| 提取文风 · 覆盖 style.md | extractStyle | |

不带下拉框、照旧是普通确认框的：确认框之前的那一问（缺章提醒「仍然继续」、批量写章的一致性预检、角色卡「只读新增 / 重读全部」、设定「整理范围」、导入原稿「接着补齐」）——后面紧跟着带下拉框的那一个；以及所有调完模型才问的（采纳、覆盖审阅……）。

## 自定的取舍（⚑，收尾时报给作者）

1. ⚑ 嵌套的那一问缺省取外面那一次的选择（见上）。
2. ⚑ 模型清单是所有服务商的所有模型（与对话页下拉框同一份），不只是分档里配的那几个。
3. ⚑ 「按分档」那几行只在选着「按分档」时显示；VS Code 模态框里两样都写在补充说明里。
4. ⚑ 钉了模型，这一次里新建的池用它的窗口切批、截断（已经算好的批数不重算，同 #2）。
5. ⚑ 独立版确认框的标题仍是第一颗按钮上的字。
6. ⚑ 模型下拉框按服务商分组，同对话页（表单引擎的下拉框原来不认 `optgroup`，这次补上）。
7. ⚑ 从参考书学写法、提取文风（覆盖 style.md 那一问）**不给详细度下拉框**：抽哪几章在确认框之前就定了、框里写着看第几章，换级别要么不起作用、要么让框里那句话对不上。
8. ⚑ 从已写正文补齐的两问（先整理细纲 → 其余几样）不是嵌套，但第二问缺省跟着第一问的选择（同一件事的两步）。
9. ⚑ 重建全书摘要只有在有没定稿的章时才问（「先同步细纲 / 仍然重建」）；没问时照设置跑，不为它新加一问（作者定案 #4）。选「先同步细纲」时同步那一问缺省跟着这里。
10. ⚑ 独立版确认框取消回 `undefined`（从前回 `no`）；没给 `actions` 的老消息画一颗「确定」。
11. ⚑ 命令行（`novelforge init`）的确认框：一个动作问 y/N，几个动作编号选。

## 2026-10-23 追加：工程页上从前不问的几处

作者要求工程页上点了会调模型、从前不弹确认框的都加上。落在哪：

| 入口 | 改法 |
|---|---|
| 章节右键「定稿」「重新定稿」 | 新动作 `askFinalizeChapter` → `features/finalize.ts` 的 `askFinalizeChapterTask`：问完在 `withCallChoice` 里建模型池（`plotSummary` / `characterCard`）再走 `finalizeChapterTask`。按钮字随菜单（定稿过、正文没再改的是「重新定稿」） |
| 重建全文大纲 | 都定稿过时也问（从前只有有没定稿的章时才问，⚑9 作废）；报批数与次数，一章定稿过的都没有时不问 |
| 提取文风 | 第一次也问，按钮「开始提取」；已有内容时仍是「覆盖」 |
| 提取角色卡 | 挑完章之后问 |
| 架构「重写…」 | 问完要求之后问；情节大纲按段重写走 `plotOutline` 档，其余几件在对话页生成 |
| 设定「展开…」 | 问完要求之后、建空条目之前问（取消不留空条目） |

对话页那条路（重写架构其余几件、展开设定）本来只认对话页的模型：`generate()` 没传 `provider` 时认 `pinnedModel`（`withPinnedModel`，窗口也换成它的），于是确认框上换的模型只管这一轮。

自定的（⚑，待作者看）：

12. ⚑ 本来就用对话页那个模型的几处（章节右键定稿、重写架构其余几件、展开设定），模型下拉框缺省选着对话页那个，不是「按分档」——直接点与从前一样。
13. ⚑ 对话页那条路上选「按分档」等于用对话页那个模型（那条路没有档位），下拉框下面也不列分档。
14. ⚑ 要先填东西的（提取文风、提取角色卡挑章号，重写、展开写要求）先填、后弹确认框，两问各取消都什么都不做。
