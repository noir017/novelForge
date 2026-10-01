# 六期：收尾 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)：本期要改写其中第 4、7、8、14、18、19、20、21、22、23 条（编号不动），其余各条照常守着。
> 2. [总计划](2026-09-30-blueprint-pipeline-roadmap.md) 的 §2（目标态）、§3.3 的 W12 / W13、§4（D13–D24）、§5 六期、§6（受影响的承诺）。
> 3. 一到五期计划与[五期补遗](2026-10-01-blueprint-pipeline-phase5b.md)：README 要写的就是它们落下来的行为。
>
> 每个 Task 做完立刻 commit，commit 之间 `npm run typecheck` 必须零错误。

**Goal:** 把新链路收干净，让文档、工具说明、界面文案与代码说同一件事。agent 的工具说明与动作跟上新链路（不再提卷、中转站、拆分，补上「补齐故事架构」与批量写章的区间和模式）；清掉旧链路留下的死代码；工程页与几处空页面写出「下一步：……」并给一颗能点的按钮；README、AGENTS.md 与各模块 README 按新链路重写。

**Architecture:** 先动代码（工具 → 死代码与旧文案 → W12），每一步都有测试钉住；再写文档（AGENTS.md → 根 README → 模块 README），文档只描述代码此刻的样子。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依赖。

## Global Constraints

- `src/core/` 零 `vscode` import；分层契约测试全程要绿。
- **文档以代码为准**。总计划里有三处与代码不一致，照代码写：
  - 摘要文件按**章节文件名**镜像（`chapters/001-楔子.md` → `summaries/001-楔子.md`），不是 `summaries/NNN.md`；
  - 正文的上游指纹记在**细纲 frontmatter 的 `writtenFrom`**，不在 `project.json` 的 manifest；
  - 设定四件与情节大纲之间**还没有**指纹：链是「大纲那一节 → 细纲 → 正文 → 摘要」。
- **不改产品行为**，除了下面「本期定下的东西」写明的几处。
- 本期结束时 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全绿。

---

## 本期定下的东西

标 ⚑ 的是本期自定的取舍，收尾时报给作者。

### 1. agent 工具

**`generate`**
- `TIER_TASK` 加 `setting: 'setting'`：agent 生成架构四件走「故事架构」档，与工程页「补齐设定」同一个模型（与细纲走 `plotOutline` 档同一个道理）。大纲、正文仍严格用对话页选定的模型。
- ⚑ **仍不开放审稿**，`TIER_TASK` 不加 `review`。五期把这件事留到这一期定：报告要作者在报告卡上勾选之后才修稿，agent 拿到一份「2 严重 · 1 建议」做不了什么，也不该替作者决定哪几条算数；作者要审稿，对话页 `/审稿` 或章节条上一颗按钮就到。`review` 档只给批量写章的「写完即审稿」用。
- 文件头那张「哪一层用哪个模型」的表按上面改。

**`run`**
- 新增 `completeSettings`：补齐故事架构（只补空白，确认框写明缺哪几件、调用几次）。转发 `features/pipelineBatch.ts` 的 `completeSettings`，一字不改。
- ⚑ `batchPlots` / `batchManuscripts` 收可选的 `from` / `to`（章号区间），`batchManuscripts` 另收 `mode`（`draft` 只写正文 / `finalize` 写完即定稿）与 `review`（写完即审稿）。工程页的两个弹窗都能选区间和模式，agent 这条路只能「从下一可写章起、只写正文」，作者说「把第 5–8 章写完并定稿」它就做不到。确认框照弹（不带 `confirmed`），区间与模式写在框里，次数按 `planWriteBatch` 的上限报（第 4 条）。
- 去掉 `REFUSED` 里的 `split`：新链路没有拆分这件事，留着它等于告诉模型「有这个动作，只是不给你」。模型真填了 `split`，走「认不出动作」那条报错，同样列出可用动作。
- 描述里的标签按新链路改（「定稿」「补齐故事架构」「批量拆细纲」「批量写章」）。

**`list` / `search` / `schema.ts` / `index.ts` 的说明与注释**
- `list` 的固定位置换成：`.novelforge/config.md`、`premise.md`、`world.md`（架构）、`outline.md`（情节大纲）、`plots/<章号>-<标题>.md`（细纲，一章一份、不分子目录）、章节根（默认 `chapters/`）、`summaries/`、`characters/`、`lore/`。
- `search` 的 `kinds` 说明按 `KINDS` 实际的值写（`setting` 是配置 / 前提 / 世界观三件），删掉 `manuscript`、`volume`——现在模型填 `volume` 会被静默丢掉、变成不限种类的搜索。
- `schema.ts` 与 `agent/loop.ts` 里「剧情不写画面、天气、台词」那句与现在的细纲提示词相反（关键事件可以写具体场面），改掉。

**契约测试**（新增 `tests/contract/toolText.test.js`）：注册表里每个工具的 `description` 与参数说明、`run` 的动作标签里，不许出现「卷」「中转站」「剧情段」「拆分」「拆成章节」「volumes/」「manuscripts/」。这是模型每一轮都读的文字，旧说法会让它去找不存在的东西；其余注释与历史说明不在这条测试里（那里大量合法地写着「从前……」）。

### 2. 清死代码

旧链路的关键词在代码里已经没有死分支：卷、中转站、`split` 还剩的引用都是有意保留的（D11 的「老工程目录不读不删」、旧会话归一、守卫），并且有测试钉着。真正的死代码是下面几处，名字里不带关键词：

| 位置 | 是什么 | 怎么处理 |
|---|---|---|
| `workspace/handlers/types.ts` 的 `appendHead?()` / `appendSeparator?`，`workspace/index.ts` 的 `appendText` 里对应的两处判断 | 唯一的实现者是删掉的中转站 handler（拆章用的 `---` 分隔符） | 删钩子，`appendText` 直接走缺省 |
| `media/src/css/view/pipeline.css` 的 `.crumb-sep` | 生产它的「› 场景 N」面包屑早没了 | 删 |
| 会话级 `targetWords`：`model/session.ts`、`controller/serialize.ts`、`protocol/views.ts` 的 `SerializedSession.targetWords` | 一期删了输入框（W1）之后只剩「从旧 JSON 读出来再原样写回」，前端不读 | 删字段；旧会话里的这个键读的时候忽略，下次保存时自然消失 |
| `model/plotFile.ts` 的 `describePlot` | 没有生产调用方，只有一条单测 | 删函数与那条断言 |
| `tests/integration/features/selectPlot.test.js` 调 `bundle.project.emptyPlotSections?.()`、写 `arc` 与老四节 | 那个导出不存在，`renderPlotFile` 也只写三节，这些输入不起作用 | 换成现行的三节 |

`LEGACY_CAPABILITY` / `LEGACY_STAGE`（总计划点名的「LEGACY 兼容表」）**保留**：旧会话里存着 `volume`、`split`，打开时要归一，`session.test.js` 钉着。`guard.ts` 保护 `volumes/`、`manuscripts/`、`scenes/` 不被删（D11）也保留，顺手给 `guard.test.js` 补上 `volumes/` 那一条（现在漏测）。

### 3. 旧链路的文案与注释

**作者看得见的**（这几处是 bug，不只是措辞）：
- `package.json` 的 `novel.newPlot` 标题「Novel: 新建剧情段」→「Novel: 新建细纲」。
- `shells/vscode/extension.ts` 与 `features/lore.ts` 的提示「写完正文先拆成章节，才能总结 / 生成设定」→ 按现在的判据说（「这一章还没有正文」「还没有写过正文」）。

**注释**：约 35 处还在讲场景目录、中转站、拆分、剧情段、「写剧情 / 落定剧情」「剧情 · 4/4 节」的注释，按新链路改，逐处见调研清单（Task 3）。讲「从前……、为什么删掉」的历史说明保留——那是有意的。测试文件头与夹具里同样的旧说法一并改；夹具里写老四节细纲、但测的不是「老格式容错」的那几份换成三节。

### 4. W12 空状态写出下一步（⚑ 按钮做什么）

- **下一步从状态机来**（第 20 条）：`ProjectTree` 加 `next?: NextStepView`，就是对话页主按钮在「全书」那一档会给的那一步。`controller/chat.ts` 的 `bookNextStep(c)` 只用到 `c.project`，搬到 `views/pipeline.ts` 改成 `bookNextStep(project)`（连同 `targetOf`，`controller/serialize.ts` 留转发），`buildProjectTree` 与 `pushPipeline` 共用。前端不自己判断「下一步是什么」，文案用 `next.label`。
- ⚑ **空状态的按钮不直接花钱**：与「去生成」「去写这一章」同一个口径——点了是**进入那一层**（对话页的主按钮就是它）、**打开弹窗**（一句话、拆细纲，弹窗上写着调用次数）或**走自带确认框的工程动作**；真正花钱的那一下仍在主按钮或确认框上。全书只推一个下一步，所以空状态说的就是主按钮那一步，不另起一个。
- 落点：

| 位置 | 现在 | 改成 |
|---|---|---|
| 工程页「章节」组为空 | 「还没有章节。先把故事架构与情节大纲写好，再拆出细纲。」，没有按钮 | 「下一步：{next.label}」+ 按钮：设定那几件 → 「去生成」（小说配置开一句话弹窗，其余进入那一层）；情节大纲 → 「去生成」（进入大纲层）；拆细纲 → 「拆细纲…」（开拆细纲弹窗） |
| 工程页「章节」组不空、但下一可写章还没有细纲那一行 | 没有任何提示（「去写这一章」挂不上） | 组末一行同样的「下一步：拆细纲（第 a–b 章）」+「拆细纲…」 |
| 工程页「角色」组为空 | 「还没有角色卡。可运行「提取/更新角色卡」从正文抽取。」 | 还没有正文：「下一步：在故事架构里生成角色图谱，主角、盟友与对手各建一张卡」+「去生成」（进入角色图谱那一层）；已有正文（老工程）：「下一步：从已写的正文提取角色卡」+「提取角色卡…」（`extractCharacters`，自带确认框） |
| 工程页「设定」组为空 | 「还没有设定条目。keywords 命中纲要时会自动注入上下文。」 | 设定条目是可选的，不写「下一步」：说清它是什么、什么时候用得上，按钮「＋ 设定」（新建一条，不调模型）；已有正文时再给「从正文生成…」（`generateLore`，自带确认框） |
| 对话页、工作区还不是小说工程 | 页脚一句「先运行「Novel: 初始化小说工程」」——那是 VS Code 的命令名，独立版里找不到 | 空白提示换成「下一步：把这个文件夹初始化成小说工程」+「初始化小说工程」（`projectAction('initProject')`） |
| 历史页没有会话 | 「还没有保存的对话。发出第一条消息后会自动保存。」 | 加「去对话页」按钮（切页签） |
| 独立版空窗口，侧边几页的遮罩 | 「打开文件夹后即可使用」 | 加「打开文件夹…」按钮，与欢迎页那颗同一个动作 |

- **不改的**：对话页空会话的提示（主按钮就在它下面）、主按钮条「全书都写完了」（没有下一步可说）、工作区卡与摘要浮窗的空说明、编辑区「还没有打开文件」（已经写清去哪点）、文风与摘要组（固定行，不会空）。

### 5. 文档

**AGENTS.md**
- 删掉顶上「重构中」的横幅；开头四段（两条轴、四环、卷、剧情段、中转站）按新链路重写：一句话 → 架构四件 → 情节大纲（按「第 a–b 章」分节）→ 细纲（一章一份，细纲号 = 章号）→ 正文直接落 `chapters/` → 定稿（摘要 + 连续性事实 + 角色当前状态）；审稿是可选动作。
- 模块地图、架构要点里的旧说法（`volumeFile.ts`、`beatsHash`、「创作（四层产物）」），以及「加新产物要同改几处」统一成一种说法：写源码入口，再改三处（`build-media.js` 的 `JS_ENTRIES` / `CSS_ENTRIES`、`embed-media.js` 的 `built`、`page.ts` 的引用；插件也要加载时再改 `webviewHtml.ts`）。`media/README.md`、`standalone/README.md` 同一句话。
- 规则逐条（**编号不动、不合并**）：
  - 第 4 条：调用次数写在动手之前——主按钮、卡片与确认框都报，自动续写算上限；单章写完不自动定稿（D17）。
  - 第 7 条：删「`plots/`/`volumes/` 的改名删除走专门方法以带走中转站正文」。
  - 第 8 条：**整条改写**为「细纲号 = 章号，只有一条轴」：细纲与正文按章号配对，界面一律称「第 N 章」；章节顺序仍由文件名数字前缀决定，与目录层级无关。
  - 第 14 条：补 D13（细纲的 `characters[]` 是计划出场，只给装配器挑角色卡，不进 `buildCastIndex`）。
  - 第 18 条：链换成「大纲那一节 →（`upstreamHash`）细纲 →（细纲上的 `writtenFrom`）正文 →（`sourceHash`）摘要」；删「拆分是唯一人工闸口」；定稿过的章只挂 ⟳、不被拉回。
  - 第 19 条：补上现行的几种例外——补齐设定只补空白；细纲带出的新角色直接建卡（D19）；定稿时机器维护的「当前状态」直接更新、作者改过的不写挂黄 ❗（D15）；批量写章遇到重演、提前登场、没写够也落盘但停。
  - 第 20 条：主按钮来自 `deriveBookNextStep` 与 `deriveNextStep` 两级；审稿不进主按钮；`selectPlot` 现在按章号认（「绝不在两条轴之间按号互认」那半句作废）。
  - 第 21 条：细纲三节（本章目的 / 关键事件 / 章末钩子），关键事件可以写具体场面、不写成正文，章末钩子必填；写够没有看 `targetWords`，缺席取小说配置的每章字数，再缺席有字就算。
  - 第 22 条：`generate` 有单章与每批 5 章两种用法，与 `settle` 共用同一份细纲合同。
  - 第 23 条：**原位替换**为「定稿是这条链上唯一的人工闸口」：一章只有摘要新鲜才算完成；单章写完不自动定稿，下一步按钮给「定稿第 N 章」并写明调用次数，只有批量的「写完即定稿」模式里自动定稿。
- 第 26 条等其余各条不动。

**根 README**：开头三段与「从脑洞到成书」、界面总表、工程页（含长任务进度、文件夹与文件操作）、对话怎么用（流水线条、工作区卡、下一步、`/` 命令、直接打字就是 agent、落盘卡片，**补上**写章进度与自动续写、重演确认、一致性预检、审稿报告卡与按勾选修稿、合并视图、定稿）、目录结构、角色卡格式（`stateThrough` / `stateHash`、「当前状态」归机器维护）、上下文是怎么装配的（四层 + 审稿 + 修稿）、命令表、摘要格式（七节，含连续性事实）与过期机制、模型分档表（补「故事架构」「批量审稿」「Agent 调度」）、代码结构。「独立版的角色卡更新只有确认框、没有 diff」那句一并改掉（五期有了合并视图）。

**模块 README**：`src/README.md`、`src/core/README.md`、`agent/README.md`（状态简报示例整段换成现在 `buildStateBrief` 的真实输出）、`context/README.md`、`features/README.md`、`llm/README.md`（走池的不只工程页任务）、`shells/vscode/README.md`、`shells/standalone/README.md`、`media/README.md`（卷组、`.row-volume`、几处数字）、`tests/README.md`（`manuscripts/` 那句、任务表行数、漏列的测试文件）、`workspace/README.md`、`sample-novel/README.md` 与 `sample-novel/chapters/README.md`（整段在讲中转站与拆章）、`docs/design/README.md`（承诺条数、索引补上这条重构的 spec 与各期计划）。

### 6. 本期不做

- **W13 点击数验收、独立版从一句话手动走到第 3 章（单步、批量各一遍）、桌面壳能起来**：作者 2026-10-01 说本机做不到的暂时不管。前两项要真实模型调用（约 40–45 次）；桌面壳要 Rust 工具链与图形界面，本机都没有。
- 五期补遗试跑剩下的三个质量问题（第 3 章钩子后多余的过场、段尾总结句、修稿删多与错别字）：作者说后面再说。
- 设定四件 → 大纲的指纹（让改了世界观的大纲挂 ⟳）：是新功能，不是收尾。

---

## 提交节奏（8 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `docs` | 本计划 |
| 2 | `refactor(tools)` | agent 工具跟上新链路：架构走故事架构档、`run` 补齐架构与批量的区间和模式、说明不再提卷与中转站 |
| 3 | `chore` | 清掉旧链路的死代码，作者看得见的旧提示与注释按新链路改 |
| 4 | `feat(media)` | W12 空状态写出下一步 |
| 5 | `docs` | AGENTS.md 按新链路改写 |
| 6 | `docs` | 根 README 按新链路改写 |
| 7 | `docs` | 模块 README、示例工程说明同步 |
| 8 | `test` | 六期验收：全量 typecheck / node / e2e（只在有修补时才有这个 commit） |

---

### Task 2：agent 工具（commit 2）

- `tools/novel/generate.ts`：`TIER_TASK.setting = 'setting'`；文件头的表；`review` 那条报错与说明保留，注释改成「六期定了不开放」并写理由。
- `tools/novel/run.ts`：`completeSettings`；参数 `from`、`to`（`int`）、`mode`（`str`，枚举 `draft` / `finalize`）、`review`（`bool`）；`batchPlots` 把区间传给 `generatePlots({ range })`，`batchManuscripts` 传 `writeManuscripts({ range, mode, review })`；只给了 `from` 时 `to` 按各自缺省补（拆细纲 5 章、写章 3 章）；`from > to` 当场报错。删 `REFUSED.split`。描述里写清「区间与模式只对 batchPlots / batchManuscripts 有意义」。
- `tools/novel/list.ts`、`search.ts`、`schema.ts`、`index.ts`、`agent/loop.ts`：说明与注释。
- 测试：
  - `tests/integration/tools/generateTiers.test.js`：架构层走 `setting` 档的池、档位没配时退回对话页的模型；大纲、正文仍不走池。
  - `tests/integration/tools/runTool.test.js`：`completeSettings` 转发且次数记账；`batchManuscripts` 带 `from/to/mode/review` 时确认框里写着区间与模式、次数按上限；`from > to` 报错不调模型；`split` 现在走「认不出」。
  - `tests/contract/toolText.test.js`（新增）：§1 那条。

### Task 3：死代码与旧文案（commit 3）

- §2 表里五处。
- §3 作者看得见的三处，以及调研清单里的注释（`shells/vscode/extension.ts`、`controller/files.ts`、`controller/index.ts`、`controller/chat.ts`、`controller/agent.ts`、`features/characters.ts`、`features/summarize.ts`、`files/fileOps.ts`、`model/session.ts`、`model/tiers.ts`、`generation/generate.ts`、`workspace/index.ts`、`workspace/guard.ts`、`workspace/handlers/{types,chapter,doc}.ts`、`media/src/view/{commands,messages}.ts`、`media/src/view/project/{groups,summaryTip}.ts`、`media/src/css/view/{summary-tip,pipeline,messages}.css`）。`handlers/chapter.ts` 文件头「所以这里没有 `onRemove`」与下面的实现矛盾，一并改。
- 测试文件头与夹具：`tokenizer`、`selectPlot`、`characterCard`、`lore`、`drafts`、`chapters`、`listCache`、`choices`、`cast`、`readTools`、`unit/generation/drafts`、`e2e/standalone/server`。
- `tests/integration/workspace/guard.test.js` 补 `volumes/` 的保护。
- 跑 `npm run test:node`。

### Task 4：W12（commit 4）

- `views/pipeline.ts`：`bookNextStep(project)`、`targetOf`；`controller/chat.ts`、`controller/serialize.ts` 改调用 / 留转发。
- `protocol/views.ts`：`ProjectTree.next?: NextStepView`；`views/projectView.ts` 填上。
- `media/src/view/project/rows.ts`：`nextRow(step, tree)`——「下一步：……」+ 一颗 `chip-btn`，按 §4 的规则决定按钮做什么；`emptyRow` 照旧给不带按钮的说明用。`index.ts` 的章节、角色、设定三组按 §4 接上。
- `media/src/view/state.ts` / `messages.ts`：未初始化时的空白提示与按钮。`media/src/view/history.ts`：「去对话页」。`media/src/view/welcome.ts`：遮罩上的「打开文件夹…」。
- CSS 同步；`node scripts/verify-css.js`。
- 测试：
  - `tests/integration/views/projectTreeReads.test.js`：空工程的 `next` 是「生成小说配置」（带一句话弹窗的默认值）；架构齐了、没大纲是「生成情节大纲」；有大纲没细纲是「拆细纲（第 1–5 章）」；与 `pushPipeline` 推给对话页的全书下一步逐字一致。
  - `tests/dom/view/projectTree.test.js`：章节组为空时三种 `next` 各自的文案与按钮（配置开一句话弹窗、其余发 `setTarget`、拆细纲开弹窗），**都不发 `send`**；章节不空但缺下一章细纲时组末那一行；角色组两种空法；设定组的「＋ 设定」发 `newLore`。原来「前三组的行里只有『去生成』『去写这一章』两种按钮」那条断言照旧成立（下一步那一行不是 `.row`）。
  - `tests/dom/view/creation.test.js`：未初始化时的提示与「初始化小说工程」发 `projectAction`。
  - `tests/dom/view/history.test.js`（没有就新建）：空列表的按钮切到对话页。
  - `tests/dom/standalone/welcome.test.js`：遮罩上的按钮与欢迎页那颗发同一条消息。
- 跑 `npm run test:node`。

### Task 5：AGENTS.md（commit 5）

按 §5 改。改完 grep 一遍全仓库「第 N 条」的引用（`grep -rn "第 8 条\|第 23 条" src media tests`），引用处说的意思与新条文对不上的，改引用处的措辞。

### Task 6：根 README（commit 6）

按 §5 改。每一段写之前先去代码里核对，不照总计划抄（Global Constraints 那三处）。按钮、命令、徽章的文字逐字取自代码（`model/pipeline.ts` 的标签、`shells/shared/panes.ts`、`media/src/view/project/`）。

### Task 7：模块 README（commit 7）

按 §5 的清单改，只改现在说错了的段落。

### Task 8：验收

`npm run typecheck`、`npm run test:node`、`npm run test:e2e`。有修补才 commit。

---

## 验收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全绿。
- `grep -rn "中转站\|剧情段\|拆成章节\|卷纲" README.md AGENTS.md` 只剩讲历史的句子（「从前……已经删掉」）。
- 独立版打开一个空工程：工程页「章节」组写着「下一步：生成小说配置」，点「去生成」开一句话弹窗；打开 sample-novel：章节组末尾是「下一步：拆细纲（第 4–8 章）」一类的提示。

## 给接手 agent 的提示词

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「六期：收尾」。先读 `docs/design/plans/2026-10-01-blueprint-pipeline-phase6.md` 全文、根目录 AGENTS.md、总计划的 §2、§3.3（W12）、§4、§5 六期与 §6。按 Task 2→8 顺序做，每个 Task 一个 commit（中文正文，结尾带 Co-Authored-By 行），不要推送。每个 commit 前跑 `npm run typecheck`；Task 3、Task 4 结束时跑 `npm run test:node`，Task 8 再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。写文档时以代码为准，不照总计划抄。这一期不调真实模型。遇到计划里没写到、又会改变产品行为的决定，停下来问。
