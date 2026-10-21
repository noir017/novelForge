# AGENTS.md

Novel Forge 帮作者**把一个脑洞养成一本完整的书**：从一句念头开始，先展开成小说配置、故事前提、角色图谱与世界观，再排情节大纲、拆成一章一份的细纲，最后一章一章写成正文。三种壳（独立 Web 服务 / 桌面 App / VS Code 插件）共用同一套核心。

实现上分两条主线：**往下展开**——按**创作阶段**（架构 / 大纲 / 细纲 / 正文）分别装配上下文并透明展示，把上一层产物展开成下一层（流式预览、当场点头才落盘），正文按细纲的目标字数自动续写；**往回记住**——定稿（照正文反向更新这一章的细纲与连续性事实 + 本章出现了哪些设定 + 出场角色的「当前状态」 + 这一章在叙事线上发生了什么）、叙事线（一条剧情线一个文件，伏笔挂在线下，作者一眼看出各条线走到哪）、全文大纲、角色卡与设定名录（地点、势力、物品、概念……出现在哪几章、建条目、按水位增量整合），让「记忆」有限且可人工校正。审稿是正文层的可选动作：只出报告，作者在报告卡上勾选之后按勾选的条目修稿。作者还可以给每个阶段（规划 / 写正文 / 审稿 / 修稿）绑一份**写作技能**（一份纯提示词的 `SKILL.md`），这个阶段往后的每一次生成都把它放在提示词最前面。已经写了一部分的书走**拆书**：工程里的整本 txt 导入成章节，再「从已写正文补齐」——先照正文整理出没定稿那几章的细纲，再补角色卡、架构与大纲（只补空白）；别人的书只学写法（文风进 `style.md`，结构与节奏成一份规划技能），原文不进工程。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

**一条轴：细纲号 = 章号。** 往下展开的链是：一句话 ──▶ `config.md` ──▶ `premise.md` / `characters/` / `world.md` / `lore/`（设定清单）──▶ `outline.md`（按「第 a–b 章」分节，可以只覆盖到一部分章）──▶ `summaries/NNN-标题.md`（细纲，一章一份，每批 5 章）──▶ `chapters/NNN-标题.md`（正文）──▶ 定稿（照正文反向更新同一份细纲）。**细纲镜像正文在章节根下的相对路径**，扩展名换成 `.md`（`chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`，与草稿同一套镜像）：分卷的书细纲就在卷目录里，新的一章跟上一章放在同一个子目录。`summaries/global.md` 是全文大纲（已经写完的部分主线怎么走过来的，原「全书摘要」），不在这条轴上。**叙事线**在 `threads/`：一条剧情线一个文件 `threads/<线名>.md`（主线 / 支线 / 感情线 / 人物线，主线全书一条），伏笔挂在线下，挂不上的进 `threads/未归属的伏笔.md`；它跟着这条链走——排线在情节大纲之后（工程页「从大纲排出」，批量拆细纲时一条线都没有就先排），拆细纲时带上线与该收的伏笔、计划随细纲写进线里（细纲合同的 `threads` 字段，第 N 章的细纲写进去时整组换掉那一章的计划事件），定稿时记下实际发生的事件（带原文证据）与各条线的当前进度，写正文时带有关的几条（条数随上下文详细度，缺省 6 条），写前检查提醒逾期的伏笔、计划埋了却一直没埋的伏笔与断了的线（不拦）；不进主按钮，可选。设定条目在 `lore/<分类>/<名>.md`（分类就是目录，每本书自己的、可以嵌套）：每章出现了哪些设定记在那一章细纲的「设定」一节，名录（`views/lore.ts`）从定稿过的细纲里算出来，条目按水位增量整合；排细纲时也可以把一条设定往前想细（「展开」：单条设定 `{kind:'lore'}` 也是生成目标，名录的「待完善」列出接下来几章要用、却还只有一句话的，可以全部展开），讨论里定下的设定用 `/落定设定` 写成一批条目，条目可选的第四节「暗设」是读者还不知道的事，规划时带、写正文时不带（角色卡的「暗设」同一个口径）。写作技能也不在链上：本工程的放 `.novelforge/skills/<名字>/SKILL.md`，阶段绑定记在 `.novelforge/skills.json`，我的技能库在工程外的 `~/.novelforge/skills/`。

**细纲与正文之间没有中间层。** 从前这里有过「细节」（`scenes/`）、「卷」（`volumes/`）与「中转站」（`manuscripts/`，写完再按 `---` 拆成章）几层，都删了：「这一幕怎么发生」是写正文时才定的事；大纲按章号区间分节、细纲一章一份，已经解决了卷要解决的跨度问题；正文直接落进 `chapters/`，不必再拆。细纲从前另放在 `plots/`、定稿另写一份单章摘要，相似的东西留了两份，现在并成 `summaries/` 里的一份，`plots/` 也不再认。老工程磁盘上那几个目录（`scenes/`、`volumes/`、`manuscripts/`、`plots/`）**一个字节都不动**（那是作者的文件），但代码里彻底不认它们：`kindOfPath` 判成 `other`，工程页不显示、装配器不读，文件操作也删不掉它们。

- **`chapters/` 是唯一真相**：定稿照它改细纲、上下文从它取正文、工程页的字数也报它。正文的上游指纹记在这一章细纲 frontmatter 的 `writtenFrom` 上，定稿时正文的指纹记在同一份的 `sourceHash` 上——章节是作者的文件（可以是 `.txt`、没有 frontmatter），这条链只能从细纲指过去。
- **主按钮只推一个下一步**：全书那一档（架构五件 → 情节大纲 → 拆细纲）由 `deriveBookNextStep` 算，进入「在写」之后由单章的 `deriveNextStep` 算（写细纲 → 写正文 / 接着写 / 重写 → 定稿）。批量动作（补齐架构、批量拆细纲、批量写章）都在工程页，只补空白；排叙事线也在工程页，不进主按钮。
- **定稿是唯一的人工闸口**：单章写完不自动定稿；定稿过的章即使细纲后来改了也不被拉回「待写」，只挂 ⟳；正文后来改了才回到「待定稿」。

产品文档（面向作者的完整使用说明）见根目录 [README.md](README.md)。本文件面向代码代理：先读模块 README 再动手。

## 常用命令

shell 为 PowerShell（不支持 `&&`，用 `;` 分隔），均在仓库根目录执行：

```powershell
npm install              # 依赖
npm run compile          # esbuild 打包到 dist/extension.js + dist/media/ 的前端产物（F5 调试前必须有）
npm run watch            # 监听构建（两边都监听）
npm run media            # 只构建前端资源（media/src → dist/media/）
npm run typecheck        # tsc --noEmit，含 media/tsconfig.json，必须零错误
npm test                 # typecheck + 全部测试（node:test），不需要 API Key
npm run test:unit        # 只跑纯函数那档，毫秒级
npm run test:integration # 真临时工程 + 假模型
npm run test:dom         # jsdom 跑 dist/media 前端产物
npm run test:e2e         # 独立版服务（需 Bun）
```

改了 `src/core/**` 后必须跑 `npm test`；改了任何 TS（含 `media/src/**`）都要过 `npm run typecheck`。手动验证 UI 时按 `F5` 启动 Extension Development Host（自动打开 `sample-novel/`）；独立版与桌面壳也各有 F5 配置，见 [.vscode/README.md](.vscode/README.md)。

测试按类型分目录放在 [`tests/`](tests/README.md)（`unit` / `integration` / `dom` / `e2e` / `contract`），运行器是 Node 自带的 `node:test`，零新增依赖。单跑一条：`node --test --test-name-pattern="关键字" "tests/unit/**/*.test.js"`——**glob 要带引号**，`node --test <目录>` 会把目录当模块入口报错。

## 模块地图

改动前先读对应模块的 README：

| 模块 | 一句话职责 | README |
|---|---|---|
| `src/` | 两层架构总览与一条创作请求的完整链路 | [src/README.md](src/README.md) |
| `src/core/` | 核心逻辑层入口（含协议 `protocol/`、读写网关 `workspace/`、文件能力 `files/`、只读聚合与界面快照 `views/`、运行时设施 `runtime/`）。`views/pipeline.ts` 是磁盘 I/O 聚合器；`model/pipeline.ts` 仍是纯领域模型与状态机，绝不搬进 `views/`。 | [src/core/README.md](src/core/README.md) |
| `src/core/model/` | 数据层：NovelProject（**只剩领域查询**，写盘全在 workspace/）、Markdown 解析、章节文件名规则、**创作流水线领域模型 pipeline.ts**（全书与单章两级状态机、调用次数）、架构三件 settingFile.ts、情节大纲 outlineFile.ts、细纲 plotFile.ts（七节加「设定」一节，计划与定稿是同一份；叙事线二期删了「新增伏笔」）、设定的格式与认法 loreFile.ts（「设定」一节一行一条、条目一句话、分类就是目录、「暗设」一节与「还只有一句话」的认法）、连续性事实 continuity.ts、角色当前状态 characterState.ts、叙事线 threadFile.ts（一条线一个文件的格式、状态现算、外科式写入、排线与定稿的校验、写正文 / 审稿 / 拆细纲挑哪几条、细纲合同里计划的解码与落到哪条线、写前检查要的数）、写作技能 writingSkill.ts、拆书的切章与抽样 importText.ts、审稿报告 review.ts、一致性预检 preflight.ts、段级 diff paragraphDiff.ts、查找替换的匹配口径 textFind.ts（内置编辑器的查找条与全书查找替换同一份）与全书查找替换在一份文件上的口径 bookFind.ts、服务商配置、思考深度 thinking.ts、上下文详细度 contextDetail.ts、确认框上的两个下拉框 callChoice.ts、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/workspace/` | ★ **工程的唯一读写网关**：路径 → 种类（`kind.ts`）→ 八条守卫（`guard.ts`）→ 解析/渲染/记账/伴生（`handlers/`）。写盘从前散在六处、各带一部分保护，现在收成一处；`upstreamHash` 与 `writtenFrom` 的记账下沉到写入路径本身，谁写都记；定稿写回细纲（`finalizePlot`，旧版先复制进回收站）也在这里 | [src/core/workspace/README.md](src/core/workspace/README.md) |
| `src/core/context/` | ★ 分阶段装配（配方 × 层）+ 身份化提示词 + 可替换的 token 计数器。每张配方都带一层 `skill`（这个阶段绑的写作技能，P0 那一组的最后，整份带或整份不带）；架构、大纲两张另挂一层 `written`（已写正文，只在「从已写正文补齐」时有内容） | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/generation/` | ★ 创作的一次单步：**无状态**地装配 → 调模型 → 解析成 `Draft`（收 signal，并发控制在 controller），外加几条链：结构化产物的降级修复（`structured.ts`）、正文自动续写（`continuation.ts`，最后一步是只许删的删修饰 `trim.ts`）、审稿（`review.ts`）、按勾选修稿（`revision.ts`）；八条落盘分派、Draft store（随会话落盘，`write draftId=…` 认它） | [src/core/generation/README.md](src/core/generation/README.md) |
| `src/core/tools/` | ★ **工具层**：契约（`ToolDef` / `ToolIntent` / `ToolInvoker`）、schema 校验、注册表（执行 + 兜异常 + 记日志），以及 `novel/` 那十三个工具：读三件 + `generate` + `write` / `edit` + 七个按职责分的工程动作（`pipeline` 流水线批量 / `summary` 定稿与全文大纲 / `characters` 角色卡 / `lore` 设定名录 / `extract` 文风与叙事线 / `book` 拆书 / `skills` 写作技能，每个只带自己用得到的参数），**没有删除/改名/移动，也不做审稿修稿**。**不认识 `mcp/` 与 `controller/`**（形状照 MCP 的 `tools/list` + `tools/call` 摆） | [src/core/tools/README.md](src/core/tools/README.md) |
| `src/core/mcp/` | ★ **把工具端给外部 agent**（Claude Code、Codex……）：MCP 协议（`initialize` / `tools/list` / `tools/call` / 取消）与 Streamable HTTP 传输，独立版挂在 `/mcp`。只认 `tools/` 的契约；执行端在 `controller/mcp.ts`（生成锁、对话页上的 MCP 气泡、两问）。多步调度交给外部 agent，本项目没有自己的循环 | [src/core/mcp/README.md](src/core/mcp/README.md) |
| `src/core/features/` | 功能编排：批量流水线（补齐架构 / 批量拆细纲 / 批量写章）、定稿（照正文反向更新细纲与「设定」一节 + 角色当前状态 + 叙事线：认事件 / 归并 / 当前进度）、叙事线（从情节大纲排出；拆细纲的计划随细纲写进线里 `threadPlan.ts`）、一致性预检（含叙事线的三类提醒）、全文大纲、角色卡、设定名录（单独记设定 / 补记、建条目、整合、按目录整理、批量展开；展开一条设定的解码 `loreExpand.ts`、落定设定的解码 `loreSettle.ts`）、文风提取、拆书（导入原稿 / 从已写正文补齐 / 从参考书学写法）、全书替换（预览里勾着的那几处经网关逐份写，每份先存一版历史） | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/skills/` | 写作技能（移植自 AI-Novel-Writer 的阶段 Skill）：三个来源（内置 / 我的技能库 / 本工程）、从 GitHub **先检查再安装**、卸载进回收站、工程的阶段绑定。纯函数（`SKILL.md` 解析与兼容检查、绑定文件格式、`skillStageOf`）在 `model/writingSkill.ts`；注入在 `context/` 的 `skill` 层 | [src/core/skills/README.md](src/core/skills/README.md) |
| `src/core/llm/` | LlmProvider 接口、OpenAI / Anthropic 实现、注册表与 API Key | [src/core/llm/README.md](src/core/llm/README.md) |
| `src/shells/` | ★ 三个壳并排放这里，外加 `shared/panes.ts`（所有 pane 的 DOM 唯一来源）。**壳的契约在这份 README 里**：壳只做实现 Host、传输与生命周期、平台专属入口三件事 | [src/shells/README.md](src/shells/README.md) |
| `src/shells/vscode/` | VS Code 壳：extension 入口、命令、两个 webview 宿主、vscode-lm | [src/shells/vscode/README.md](src/shells/vscode/README.md) |
| `src/shells/standalone/` | 独立 Web 服务壳（Bun）：HTTP/WS、WorkspaceHub 热换工程、本机列目录、页面装配、CLI 的 TerminalHost | [src/shells/standalone/README.md](src/shells/standalone/README.md) |
| `src/shells/desktop/` | 桌面壳（Windows / Linux，Rust）。**一层纯壳**：sidecar 不传工程路径，闪屏只负责起服务；打开文件夹在页面里热换。这个目录本身就是 Tauri 工程根 | [src/shells/desktop/README.md](src/shells/desktop/README.md) |
| `media/` | 前端资源（原生 TS/CSS，无框架）。**仓库里只有源码 `media/src/` 与 `icon.svg`，构建产物在 `dist/media/`**；`standalone.css` / `editor.js` / `explorer.js` 只在独立版加载。内置编辑器的标签原本只认文件，唯一的例外是不对应文件的特殊标签（`editor/store.ts` 的 `SpecialTab`，眼下只有「叙事线总览」） | [media/README.md](media/README.md) |
| `tests/` | 自动化测试，按类型分目录（也是理解核心行为的最佳入口） | [tests/README.md](tests/README.md) |
| `scripts/` | 构建与诊断工具（build-media / embed-media / build-sidecar / verify-css / diag-stream） | [scripts/README.md](scripts/README.md) |
| `sample-novel/` | 示例工程 / 测试夹具，勿随手改正文（hash 断言会挂） | [sample-novel/README.md](sample-novel/README.md) |
| `src/core/runtime/` | 宿主无关的运行时设施：日志、SQLite 痕迹库、失败记录、长任务登记、有界并发、「这一次」（作者在确认框上挑的模型与详细度，`callScope.ts`） | [src/core/runtime/README.md](src/core/runtime/README.md) |
| `src/core/views/` | 只读聚合与界面快照：工程树、单章流水线、出场人物索引、设定名录、叙事线一览（工程页「叙事线」页签）与叙事线总览的矩阵（编辑区里的特殊标签，章 × 线，按需要）、全书查找 | [src/core/views/README.md](src/core/views/README.md) |

其他关键位置：

- [package.json](package.json) —— 命令 / 菜单 / 快捷键 / 全部 `novel.*` 配置项的声明。
- [esbuild.js](esbuild.js) —— 构建脚本，入口 `src/shells/vscode/extension.ts` → `dist/extension.js`；同时调 [scripts/build-media.js](scripts/build-media.js) 把前端资源打进 `dist/media/`。
- [.vscode/README.md](.vscode/README.md) —— 三个壳各自的 F5 启动配置与构建/测试任务。**只有插件壳能打断点**，独立版（Bun 没实现 `node:inspector`）与桌面壳（Rust 那半边要 CodeLLDB）都只是把命令跑在终端里，原因写在那份 README 里。
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）、agent 重构与「生成链路重构」（`blueprint-pipeline-*`：总计划与逐期实施计划）的设计文档，涉及分层调整或链路行为时先读。

## 架构要点

以下每条的完整理由与实现细节都在对应模块 README 里，这里只列断言：

- **两层、单向依赖**：`core/` → `shells/`，反向与壳间互相 import 都不允许，`core/` 零 vscode 依赖。测试见 [tests/contract/corePurity.test.js](tests/contract/corePurity.test.js) 与 [shellPurity.test.js](tests/contract/shellPurity.test.js)；细节见 [src/shells/README.md](src/shells/README.md)。
- **壳只做三件事**：实现 `Host`、传输与生命周期、平台专属入口。任何「我是哪个壳」的分支都不属于壳——差异表达成「宿主有没有这个能力」。详见 [src/shells/README.md](src/shells/README.md)。
- **工具层与 MCP 层互不缠绕**：能对工程做什么（[tools/](src/core/tools/README.md)）与怎么端给外部 agent（[mcp/](src/core/mcp/README.md)）是两层，由 [tests/contract/layerBoundary.test.js](tests/contract/layerBoundary.test.js) 守着。
- **消息协议是前后端唯一契约**：[src/core/protocol/](src/core/protocol/index.ts) 的 `InMessage` / `OutMessage`，前端 `import type` 同一份定义，改协议后前端对不上会编译不过。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。见 [src/core/README.md](src/core/README.md)。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，UI 状态留在前端。见 [media/README.md](media/README.md)。
- **两形态的前端隔离**：独立版专属样式/脚本只由 [src/shells/standalone/page.ts](src/shells/standalone/page.ts) 加载，区分形态用能力探测不判断环境字符串。见 [media/README.md](media/README.md)。
- **页面骨架只有一份**：全部页签的 DOM 都在 [src/shells/shared/panes.ts](src/shells/shared/panes.ts)，加按钮改这一处就够。见 [src/shells/README.md](src/shells/README.md)。
- **前端源码与产物分离**：`media/` 只有源码，产物构建到 `dist/media/`，不入库。加新产物先写源码入口，再改三处（`build-media.js` 的入口清单、`embed-media.js` 的 `built`、`page.ts` 的引用；插件也要加载时再改 `webviewHtml.ts`），细节见 [media/README.md](media/README.md)。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 [`tests/`](tests/README.md)）。**编号是固定锚点**——代码注释与模块 README 大量以「第 N 条」引用这些规则，改动时只精简文字、不重排不合并。每条只留断言本身，机制与理由见链接：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。见 [src/core/model/README.md](src/core/model/README.md)。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。见 [src/core/context/README.md](src/core/context/README.md)、[src/core/README.md](src/core/README.md)。
3. **不静默覆盖**：任何可能吞掉已有内容的动作，落盘前都要先给用户一个判断的机会——卡片 diff、覆盖前确认、同名报错退出、编辑器内容 hash 乐观锁，形式因场景而异，这条原则不变。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)、[media/README.md](media/README.md)。
4. **不偷偷烧 token**：没定稿、或定稿后正文又改过的章不自动补，只在工程页提示；单章写完不自动定稿，下一步按钮给「定稿第 N 章」，只有批量的「写完即定稿」模式里自动定稿。要调模型的动作一律在动手之前写明预计调用次数——主按钮、卡片、批量确认框都报，自动续写与修复重试算在上限里，并发不改变这个数。调模型之前的确认框一律经 `features/askCall.ts` 问：作者可以为这一次换模型与上下文详细度（不写回设置，见 [docs/design/plans/2026-10-20-call-choice.md](docs/design/plans/2026-10-20-call-choice.md)）。见 [src/core/features/README.md](src/core/features/README.md)。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。见 [src/core/model/README.md](src/core/model/README.md)。
6. **不真删**：工程页的删除、会话删除、类文件操作的删除，一律搬进 `.novelforge/.trash/` 并保留原相对路径。见 [src/core/workspace/README.md](src/core/workspace/README.md)。
7. **文件访问不越界**：所有写盘经 `core/workspace/` 这一个网关，工程页的类文件操作在此之上再锁章节/角色/设定三个区，细纲（`summaries/` 下）的改名、删除与定稿写回走专门方法（改名只改标题：还没有正文时文件名由章号与标题共同决定，有正文时文件名跟着正文不动）；章节改名、移动时草稿与细纲跟着搬（目标已有就不动、说出来）；独立版的读写另有工程根/大小/白名单一层。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/README.md](src/core/README.md)。
8. **细纲号 = 章号，细纲镜像正文的相对路径**：细纲文件名的号就是章号，界面上一律称「第 N 章」；章节顺序永远由文件名数字前缀决定，与所在目录层级无关。细纲**镜像正文在章节根下的相对路径**（`chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`），**不许平铺、不许只按章号配对**：有正文的章按路径认它的细纲（`NovelProject.plotPathForChapter` / `plotFor`），作者在外面给正文改了名就是一章新的，旧细纲不冒认；还没有正文的章按号认计划，正文照细纲的路径反推着落（`chapterPathForPlot`）；既没有正文也没有细纲的新一章跟上一章放在同一个子目录（`plotPathOfNo`）。定稿反向更新的是正文镜像的那一份。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)。
9. **章节不认扩展名**：章节根下「数字前缀 + 扩展名不在二进制黑名单里」的文件都是章节，规则只在 [src/core/model/chapterFile.ts](src/core/model/chapterFile.ts) 定义一次；角色/设定区仍只认 `.md`。见 [src/core/model/README.md](src/core/model/README.md)。
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 引用才进 prompt，装配器永不自动读它；按需创建，删章节不删草稿。见 [src/core/README.md](src/core/README.md)。
11. **不闷着干活**：任何要调模型或跑几十秒的动作都走 `runTask`（进度条 + 日志），日志里绝不出现 API Key 或 prompt/正文全文。见 [src/core/runtime/README.md](src/core/runtime/README.md)。
12. **模型引用只在工程页任务里 fallback，且换人只在档内**：串行恒用该档首选、失败随机换同档其余，绝不跨档换人；对话页创作页的单次生成严格用用户选定的模型，不走池；作者在调模型之前的确认框上为这一次指定了模型，这一次的每次调用都只用它、不换人。见 [src/core/llm/README.md](src/core/llm/README.md)。
13. **切批与截断用干活那个模型的窗口**：`config.contextWindow` 只代表对话页选定的模型，走池时用 `pool.primaryBudget`。见 [src/core/llm/README.md](src/core/llm/README.md)。
14. **定稿过的细纲是出场人物的唯一真相**：角色卡的 `appearsIn` / `updatedThrough` 只是缓存，要用就经 `buildCastIndex()` 从定稿过的细纲（有 `sourceHash`）重算；`cast` 的 aliases 只收专属称呼，判定同一个人只信同章共现。没定稿的细纲里「出场人物」是**计划**出场，只给装配器挑角色卡与写前的预检用，不进 `buildCastIndex`。设定出现在哪几章同理：只认定稿过的细纲「设定」一节，经 `buildLoreIndex()` 现算，没定稿的「设定」一节是计划、只给装配器挑条目用。见 [src/core/README.md](src/core/README.md)、[src/core/model/README.md](src/core/model/README.md)、[src/core/views/README.md](src/core/views/README.md)。
15. **角色卡不能无限膨胀**：更新角色卡的提示词给每一节都定了字数上限（「暗设」——读者还不知道的事，原「未收伏笔」——也是 120 字，更新时只做减法），加字段或改提示词时别把这条抹掉。见 [src/core/features/README.md](src/core/features/README.md)。
16. **失败要留在出错的东西身上**：失败经 [src/core/runtime/errorLog.ts](src/core/runtime/errorLog.ts) 挂在对应目标上（红=整体失败，黄=部分完成），成功路径必须 `clearFailures`。见 [src/core/README.md](src/core/README.md)。
17. **SQLite 只放可丢弃的痕迹**：内容的唯一真相永远是 Markdown，库打不开就静默降级。实现细节（两个驱动、动态 import 写法、finalize 时机）见 [src/core/runtime/README.md](src/core/runtime/README.md)。
18. **上下游新鲜度只靠 hash 传播，不调模型**：产物串成一条指纹链——情节大纲里覆盖这一章的那一节 →（细纲 frontmatter 的 `upstreamHash`）细纲 →（同一份 frontmatter 的 `writtenFrom`，正文落盘时记、定稿时刷新）正文 →（同一份 frontmatter 的 `sourceHash`，定稿时记）照正文反向更新过的同一份细纲。**手写的产物永不标脏**（没有记录过指纹就不算；代码注释里的「第 18a 条」指的就是这一句）。定稿过的章即使上游改了也不被拉回「待写」，只挂 ⟳（定稿之后再改细纲，正文挂 ⟳）；流水线状态一律从磁盘推导，绝不落盘。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/model/README.md](src/core/model/README.md)。
19. **产物落盘前必须过一遍人，而且是当场过**：`generate` 只把文本交回界面，作者在对话里那张权限卡片上点了「写入」才落盘；外部 agent 经 MCP 调 `generate` 也一样（等作者答了才返回），这一问不交给宿主的权限配置，也不做成一颗可以拖延的按钮。批量路径反过来——一律跳过已有产物的目标，不问、不覆盖（补齐架构只补空白的那几件；批量展开设定只写空的、占位的与机器写的薄条目，作者写过的跳过、说出来，建议拆出的子条目照建空条目、不在同一批里接着展开）。几处有意的例外：细纲带出的新角色随细纲一起建卡（写入卡片上列出会建哪几张），新设定同样随细纲一起建空条目（单章与批量都建），展开一条设定时建议拆出的子条目随卡片一起建空条目（卡片上列出；展开时「还没定的问题」只上卡片、不进任何文件）；定稿照正文改写细纲不弹审阅卡（定稿按钮与批量动作的确认框就是那一问），旧版先复制一份进 `.novelforge/.trash/`；单独「记设定」只换那一章细纲的「设定」一节，另外七节与指纹不动（右键菜单与确认框就是那一问）；定稿时角色卡的「当前状态」由机器维护，自上次机器写入之后没人改过才直接更新，作者改过就不写、挂黄 ❗；批量写章写出来但不能往下接的（重演、后面几章的人提前登场、没写够八成、结尾停在半句上）照样落盘，然后停下；批量写章「边写边拆」时没细纲的章先按大纲拆一批细纲、只补空白，写前冲突检查对不上就停在那一章前面；叙事线的计划事件随细纲一起写（第 N 章的细纲真写进去时整组换掉各条线里那一章的计划、拆细纲埋下的新伏笔加在线下，写入卡片上列出；审阅时放弃的、批量跳过的章不动）；定稿时新线、新伏笔、实际事件由机器只追加（证据逐字校验），当前进度由机器维护、作者改过就不写（挂黄 ❗）。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/features/README.md](src/core/features/README.md)、[src/core/mcp/README.md](src/core/mcp/README.md)。
20. **界面永远只推荐一个下一步，且由状态机算出来**：主按钮来自全书那一档的 `deriveBookNextStep`（架构五件 → 情节大纲 → 拆细纲）与单章的 `deriveNextStep`，后者与 `deriveStage` 共用同一套判据；工程页空状态说的「下一步」是同一步、同一句话；审稿是可选动作，不进主按钮。外部 agent 从同一个状态机拿到同一份结论（`views/stateBrief.ts`，贴在 MCP 工具结果末尾、变了才贴），没有 `status` 工具；`selectPlot` 收的是「哪一章」，细纲路径与章节路径都认到同一章（章节路径就是那一章，细纲按路径配对）。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/mcp/README.md](src/core/mcp/README.md)。
21. **细纲是这一章的计划，不是正文**：`summaries/NNN-标题.md` 七节——梗概、出场人物、时间地点、关键事件、看点、状态变更、连续性事实，外加「设定」一节（一行一个东西：`- 名〔分类〕：本章确立的定义或规则`；写之前是计划用到的，定稿后是正文里实际出现的；**不进内容指纹**，有没有记过看这一节的标题在不在）。写之前「出场人物」是计划出场，「看点」写爽点与章末吊着读者的那一下（不再单列章末钩子），连续性事实空着；关键事件一条一件事、按发生顺序（与定稿写出来的列表同一个样子），可以写到具体场面，但不写成段的描写与对白。细纲里没有关于叙事线的小节：这一章在线上的计划记在叙事线里（第 28 条），老细纲里的「新增伏笔」当认不出的小节、不读。定稿时整份照正文改成实际写成的样子。**「这一章正文写够了没有」看细纲的 `targetWords`**（到八成算写完，不到就自动续写），缺席取小说配置的每章字数，再缺席有字就算——不拿一个猜出来的阈值骗人。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/context/README.md](src/core/context/README.md)。
22. **细纲有两个入口，讨论那条不许被截断**：`generate` 按走向填（单章，或从情节大纲每批 5 章一起拆），`settle` 把讨论结论沉淀成细纲，几条路共用同一份蓝图合同、输出一字不差（字段就是细纲七节去掉连续性事实，外加 `threads`——这一章在叙事线上的计划，不进细纲——与可选的 `newCharacters`、`settings`，不强制每章一条钩子）；`settle` 的历史 cap 抬到 60%。落定不只属于细纲：任何一层都能 `/落定设定`，把讨论里定下来的设定写成一批条目（架构那一层设定目录上的 `settle`，落完回到原来的目标），历史同样抬到 60%。定稿照正文改写细纲不是排细纲的入口，走的是自己的提示词（第 23 条）。见 [src/core/context/README.md](src/core/context/README.md)。
23. **定稿是这条链上唯一的人工闸口**：定稿照正文反向更新这一章的细纲；一章只有细纲定稿过、且记下的 `sourceHash` 对得上正文（或作者在细纲上标了完成）才算写完，定稿之后正文又改了就回到「定稿第 N 章」；单章写完不自动定稿，下一步按钮给「定稿第 N 章」并写明调用次数，只有批量的「写完即定稿」模式里自动定稿。（这一条从前是「拆分是作者的活」，拆分随中转站一起删了，编号原位沿用。）见 [src/core/features/README.md](src/core/features/README.md)、[src/core/model/README.md](src/core/model/README.md)。
24. **外部 agent 是调度者，不是第二个作者**：多步的活交给经 MCP 接进来的通用 agent，本项目不自带循环；创作质量仍来自分阶段装配那一层，领域知识只在那里写一份（工具描述与 MCP 说明里不写）；`generate` 的产物不回灌（返回只有形状与 draftId）、`history` 传空。见 [src/core/mcp/README.md](src/core/mcp/README.md)、[src/core/tools/README.md](src/core/tools/README.md)。
25. **外部 agent 不越过既有的闸门**：它的写入走的是与落盘卡片同一条 `workspace.write`，MCP 这一层没有任何新的保护代码；下游没有 diff 的动作（工具自报 `always`：`edit`、装 / 绑技能）动手前在对话页问一句，覆盖已有内容走覆盖审阅，都不交给宿主的权限配置；明确不给删除/改名/移动/`bash`/工程根之外的路径/裸 `fs`（唯一写到工程外的是 `skills install`：固定落进我的技能库，路径不由 agent 给，先问）。见 [src/core/mcp/README.md](src/core/mcp/README.md)、[src/core/tools/README.md](src/core/tools/README.md)。
26. **思考深度是会话的属性，只作用于作者选定的那个模型**：落在 `ChatSession.thinking` 上跟着会话走，缺省是「不思考」；只有对话页的单次生成带它，MCP 的 `generate` 与工程页的后台批量任务一律不带。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/llm/README.md](src/core/llm/README.md)。
27. **设定条目不能无限膨胀，机器只并不删作者的字**：条目正文三节（概要 / 规则与边界 / 现状）与一句话都有字数上限（`LORE_ENTRY_LIMITS`，建条目、整合、展开的提示词按它做减法），可选的第四节「暗设」另有上限、不算进三节合计，加字段或改提示词时别把这条抹掉；暗设写正文（含续写、正文阶段的 @ 引用）时不带，整合时正文已经揭开的挪回明面，原来有暗设、整合完没了的机器写条目也先对比；展开、落定设定写下的内容记作机器写的（盖 `bodyHash`），展开的水位同整合，落定设定更新已有条目时一律先对比、水位不动（新建的从 0 起）；整合在作者现有内容上并进新事实，正文没有明确推翻的不删，关键词只增不减；条目正文是机器写的（`bodyHash` 对得上）才可以直接采纳，作者改过的一律先对比；整合的水位停在第一处没定稿的章之前。分类就是条目所在的目录，没有固定表；「按目录整理」只搬文件、不改内容，作者看过搬家清单才搬，不给外部 agent（第 25 条）。见 [src/core/features/README.md](src/core/features/README.md)、[src/core/model/README.md](src/core/model/README.md)。
28. **叙事线是剧情线，作者写的字机器不动**：`threads/` 下一条线一个文件，种类只有主线 / 支线 / 感情线 / 人物线四种（认不出当支线），主线全书只有一条；「玉佩的来历」这种要日后揭开的是伏笔，挂在线下，挂不上的进「未归属的伏笔」（作者剪贴到某条线的文件里就是挂上了）。状态（计划中 / 进行中 / 已收束 / 已放弃、断了几章、伏笔逾期、过了计划收束章）一律从事件现算、不落盘（第 18 条）。谁能写什么：新线、新伏笔由排线、拆细纲、定稿**只追加**（新文件 / 「伏笔」末尾加一行，同名跳过）；计划事件随细纲走（第 N 章的细纲写入时整组换掉那一章的计划事件、删掉时一起删，别的章一行不动）；实际事件由定稿只追加、证据逐字校验，重新定稿时只删那一章证据已经不在正文里的机器事件（旧版先存历史）；「当前进度」由定稿维护、指纹守着，作者改过就不写、挂黄 ❗；意图与作者手写的任何行机器一个字不动。写前检查给三类提醒（伏笔逾期；伏笔计划埋了却一直没埋；线断了，主线 5 章、其余 15 章），只提醒不拦。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/features/README.md](src/core/features/README.md)。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。

## 发版

版本号**只记在仓库根 `package.json`**：`src/shells/desktop/tauri.conf.json` 的 `version` 指向它，独立版与桌面 sidecar 编译时由 `scripts/embed-media.js` 写进程序（「关于」显示的就是这一份），`Cargo.toml` 的 `0.0.0` 是占位、不被读。别处不要再写第二份（`tests/contract/version.test.js` 守着）。

```powershell
npm version patch        # 或 minor / major：先跑 npm test，再改版本号、提交「chore(release): vX.Y.Z」、打 tag
git push --follow-tags   # 推 main 与 tag；tag 触发 .github/workflows/release.yml，出 GitHub Release 草稿
```

- `npm version` 要求工作区干净；测试不过就不改版本、不打 tag。只用 `patch` / `minor` / `major`——带字母的预发布号 Windows MSI 不认，release.yml 会直接拦下。
- release.yml 只核对 tag 与 `package.json` 对得上，**不改版本号、不往 main 写**；产物先出草稿，作者看过再在 GitHub 上公开。
- `app.yml` 是手动点的日常构建（只出 artifact），不认 tag，也不改版本号。
